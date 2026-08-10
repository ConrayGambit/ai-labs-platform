import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { createRunSupervisor, type RunEvent, type RunSupervisor } from '../../src/server/run-supervisor.js';
import type { Card } from '../../src/shared/work.js';
import type { OrgAgent } from '../../src/shared/domain.js';

/**
 * These tests spawn a real subprocess per run. Under the full suite's
 * parallelism, process spawn alone can exceed the 5s default on a loaded
 * machine, which showed up as two suites timing out together while both passed
 * in isolation. The work is not slow; starting a process under contention is.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FAKE_AGENT = resolve('tests/fixtures/fake-acp-agent.mjs');

describe('agent permission requests', () => {
  let database: OrchestratorDatabase | undefined;
  let supervisor: RunSupervisor | undefined;

  afterEach(async () => {
    await supervisor?.shutdown();
    supervisor = undefined;
    database?.close();
    database = undefined;
  });

  function seed(): { card: Card; agent: OrgAgent; ventureId: string } {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Evaluate tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id,
      name: 'Tool Survey',
      objective: 'Compare free research services.',
      successCriteria: ['A sourced comparison is approved'],
    });
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
    database.rooms.createRoomForCard({ cardId: card.id, title: card.title });
    const runtime = database.createAgent({
      name: 'Test ACP Runtime',
      command: 'node',
      argsTemplate: ['{prompt}'],
      promptTransport: 'argument',
      outputFormat: 'text',
      versionArgs: ['--version'],
      timeoutMs: 120_000,
    });
    const agent = database.createOrgAgent({
      name: 'Test Specialist',
      jobTitle: 'Research Specialist',
      department: 'Research',
      jobFunction: 'Compares services and reports what it finds.',
      responsibilities: 'Survey, compare, cite.',
      runtimeId: runtime.id,
    });
    return { card, agent, ventureId: venture.id };
  }

  const startSupervisor = (): RunSupervisor =>
    createRunSupervisor({
      database: database!,
      spawnFor: () => ({
        command: process.execPath,
        args: [FAKE_AGENT],
        cwd: process.cwd(),
        env: { FAKE_ACP_SCRIPT: JSON.stringify({ requestPermission: true }) },
      }),
    });

  /**
   * Resolves once the agent has asked, so no test waits on a fixed delay.
   *
   * The budget is deliberately close to the suite timeout. A poll budget
   * shorter than the timeout becomes the binding constraint under parallel
   * load, and the test then fails for a reason unrelated to what it tests —
   * which is exactly how this first went red.
   */
  const awaitPending = async (runId: string): Promise<string> => {
    for (let attempt = 0; attempt < 2_500; attempt += 1) {
      const pending = supervisor!.getPendingPermission(runId);
      if (pending) return pending.id;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('No permission request arrived');
  };

  it('records a pending request and does NOT answer it', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor();

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Write a file.',
    });
    const requestId = await awaitPending(run.id);

    const pending = supervisor.getPendingPermission(run.id)!;
    expect(pending).toMatchObject({
      id: requestId,
      runId: run.id,
      toolCallId: 'call_1',
      title: 'Write a file',
      status: 'pending',
      selectedOptionId: null,
      answeredByUserId: null,
    });
    expect(pending.options.map((option) => option.optionId)).toEqual(['allow', 'reject']);
    // The turn has not moved on: nothing was auto-allowed.
    expect(supervisor.getRun(run.id)).toMatchObject({ status: 'running' });
    expect(supervisor.isAwaitingPermission(run.id)).toBe(true);
  });

  it('tells a subscriber that the agent is waiting on a person', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor();
    const events: RunEvent[] = [];

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Write a file.',
    });
    supervisor.subscribe(run.id, (event) => events.push(event));
    const requestId = await awaitPending(run.id);

    const asked = events.find((event) => event.type === 'permission_request');
    expect(asked).toBeDefined();
    expect(asked?.type === 'permission_request' && asked.request.id).toBe(requestId);
  });

  it('lets the owner answer, and the turn continues', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor();

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Write a file.',
    });
    const requestId = await awaitPending(run.id);

    await supervisor.answerPermission({ requestId, optionId: 'allow', userId: 'owner' });
    const finished = await supervisor.waitForRun(run.id);

    expect(finished.status).toBe('completed');
    expect(supervisor.getPendingPermission(run.id)).toBeNull();
    const answered = supervisor.listPermissions(run.id)[0]!;
    expect(answered).toMatchObject({
      status: 'answered', selectedOptionId: 'allow', answeredByUserId: 'owner',
    });
    // The agent was told what was chosen, and said so.
    const spoken = supervisor.listUpdates(run.id)
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => (update as { content: { text: string } }).content.text);
    expect(spoken.some((text) => text.includes('"optionId":"allow"'))).toBe(true);
  });

  it('DENIES an answer from a user with no access to the card venture', async () => {
    const { card, agent } = seed();
    // A real user of the platform, with no grant on this card's venture.
    const outsider = database!.identity.createUser({ displayName: 'Outsider', role: 'staff' });
    supervisor = startSupervisor();

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Write a file.',
    });
    const requestId = await awaitPending(run.id);

    await expect(
      supervisor.answerPermission({ requestId, optionId: 'allow', userId: outsider.id }),
    ).rejects.toThrow(/access denied/i);

    // Refused, and still waiting for someone who may actually answer.
    expect(supervisor.getPendingPermission(run.id)?.status).toBe('pending');
    expect(supervisor.getRun(run.id)?.status).toBe('running');
  });

  it('REFUSES an option the agent did not offer', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor();

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Write a file.',
    });
    const requestId = await awaitPending(run.id);

    await expect(
      supervisor.answerPermission({ requestId, optionId: 'allow_always', userId: 'owner' }),
    ).rejects.toThrow(/not offered/i);
    expect(supervisor.getPendingPermission(run.id)?.status).toBe('pending');
  });

  it('REFUSES to answer the same request twice', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor();

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Write a file.',
    });
    const requestId = await awaitPending(run.id);
    await supervisor.answerPermission({ requestId, optionId: 'reject', userId: 'owner' });

    await expect(
      supervisor.answerPermission({ requestId, optionId: 'allow', userId: 'owner' }),
    ).rejects.toThrow(/already/i);
  });

  it('LEAVES an unanswered request pending at shutdown, never allowed', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor();

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Write a file.',
    });
    await awaitPending(run.id);

    await supervisor.shutdown();

    // An agent must never proceed because the client went away. The request
    // survives in the database, still pending, for a person to answer.
    const surviving = database!.runs.listPermissions(run.id);
    expect(surviving).toHaveLength(1);
    expect(surviving[0]).toMatchObject({ status: 'pending', selectedOptionId: null });
  });
});
