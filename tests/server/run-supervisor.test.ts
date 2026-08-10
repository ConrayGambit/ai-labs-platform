import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { createRunSupervisor, type RunSupervisor } from '../../src/server/run-supervisor.js';
import { buildPrompt, OWNER_NOTES_HEADING } from '../../src/server/run-prompt.js';
import type { SessionUpdate } from '../../src/shared/acp.js';
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

interface Script {
  sessionId?: string;
  stopReason?: string;
  updates?: Array<Record<string, unknown>>;
  requestPermission?: boolean;
  echoPrompt?: boolean;
}

const chunk = (text: string, delayMs?: number) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
  ...(delayMs ? { delayMs } : {}),
});

describe('the run supervisor', () => {
  let database: OrchestratorDatabase | undefined;
  let supervisor: RunSupervisor | undefined;

  afterEach(async () => {
    await supervisor?.shutdown();
    supervisor = undefined;
    database?.close();
    database = undefined;
  });

  function seed(): { card: Card; agent: OrgAgent; roomId: string } {
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
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });
    // Executives are not seeded into an in-memory database, so the test builds
    // the one agent it needs rather than depending on seed data.
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
    return { card, agent, roomId: room.id };
  }

  const startSupervisor = (script: Script = {}): RunSupervisor =>
    createRunSupervisor({
      database: database!,
      spawnFor: () => ({
        command: process.execPath,
        args: [FAKE_AGENT],
        cwd: process.cwd(),
        env: { FAKE_ACP_SCRIPT: JSON.stringify(script) },
      }),
    });

  it('returns as soon as the run is recorded, without waiting for the turn', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor({ updates: [chunk('slow', 300)] });

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });

    // The turn is still going. A start that awaited the turn would hold an HTTP
    // request open for the length of an agent's work.
    expect(run.status).toBe('running');
    expect(supervisor.getRun(run.id)?.status).toBe('running');
    expect(supervisor.listActiveRuns().map((active) => active.id)).toContain(run.id);
  });

  it('records every chunk on the run and posts it into the card room', async () => {
    const { card, agent, roomId } = seed();
    supervisor = startSupervisor({ updates: [chunk('one '), chunk('two')] });

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });
    await supervisor.waitForRun(run.id);

    const updates = supervisor.listUpdates(run.id);
    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      'agent_message_chunk', 'agent_message_chunk',
    ]);

    const posted = database!.rooms.listMessages(roomId);
    expect(posted.map((entry) => entry.message.body)).toEqual(['one ', 'two']);
    // Every message carries the run that produced it, so the transcript and the
    // room can always be reconciled.
    expect(posted.every((entry) => entry.message.runId === run.id)).toBe(true);
    expect(posted.every((entry) => entry.message.authorKind === 'org_agent')).toBe(true);
  });

  it('accumulates reported tokens onto the run', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor({
      updates: [
        { sessionUpdate: 'usage_update', usage: { inputTokens: 100, outputTokens: 20 } },
        { sessionUpdate: 'usage_update', usage: { inputTokens: 50, outputTokens: 10 } },
      ],
    });

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });
    const finished = await supervisor.waitForRun(run.id);

    expect(finished).toMatchObject({ inputTokens: 150, outputTokens: 30, status: 'completed' });
  });

  it('STOPS a run that crosses its cost ceiling, and says why', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor({
      updates: [
        { sessionUpdate: 'usage_update', usage: { inputTokens: 400, outputTokens: 100 } },
        chunk('should never arrive', 300),
      ],
    });

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.', costCeilingTokens: 300,
    });
    const finished = await supervisor.waitForRun(run.id);

    expect(finished).toMatchObject({ status: 'stopped', stoppedReason: 'cost_ceiling' });
    expect(finished.finishedAt).not.toBeNull();
  });

  it('completes on end_turn and moves the card to the first gate', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor({ updates: [chunk('done')], stopReason: 'end_turn' });

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });
    const finished = await supervisor.waitForRun(run.id);

    expect(finished).toMatchObject({ status: 'completed', stopReason: 'end_turn' });
    expect(database!.work.getCard(card.id)).toMatchObject({ status: 'review', gateId: 'G1' });
  });

  it('FAILS on a refusal and records the reason', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor({ stopReason: 'refusal' });

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });
    const finished = await supervisor.waitForRun(run.id);

    expect(finished).toMatchObject({ status: 'failed', stopReason: 'refusal' });
    // A refused turn is not a passed gate.
    expect(database!.work.getCard(card.id)?.status).toBe('backlog');
  });

  it('cancels a running turn on request', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor({ updates: [chunk('a', 20), chunk('b', 400)] });

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });
    // Wait for the turn to be genuinely under way rather than for a fixed
    // delay: spawning a provider takes long enough on some machines that a
    // timed wait makes this test pass or fail on scheduling luck.
    await new Promise<void>((seen) => supervisor!.subscribe(run.id, (event) => {
      if (event.type === 'update') seen();
    }));
    await supervisor.cancelRun(run.id);
    const finished = await supervisor.waitForRun(run.id);

    expect(finished.status).toBe('cancelled');
  });

  it('honours a cancel pressed before the provider has even started', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor({ updates: [chunk('a', 300)] });

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });
    // No wait at all: the session does not exist yet. A cancel dropped here
    // would make the button a lie, and the user would press it again.
    await supervisor.cancelRun(run.id);
    const finished = await supervisor.waitForRun(run.id);

    expect(finished.status).toBe('cancelled');
  });

  it('REPLAYS from the beginning for a subscriber that arrives late', async () => {
    const { card, agent } = seed();
    supervisor = startSupervisor({ updates: [chunk('one '), chunk('two ', 120), chunk('three', 40)] });

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });
    await new Promise((done) => setTimeout(done, 60));

    const seen: SessionUpdate[] = [];
    supervisor.subscribe(run.id, (event) => {
      if (event.type === 'update') seen.push(event.update);
    });
    await supervisor.waitForRun(run.id);

    // A client that connects late, or reconnects, misses nothing. That is what
    // makes the run the core's and not the window's.
    const text = seen
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => (update as { content: { text: string } }).content.text)
      .join('');
    expect(text).toBe('one two three');
  });

  it('KEEPS RUNNING after every subscriber has gone', async () => {
    const { card, agent, roomId } = seed();
    supervisor = startSupervisor({ updates: [chunk('one '), chunk('two', 150)] });

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });
    const subscription = supervisor.subscribe(run.id, () => {});
    supervisor.unsubscribe(subscription);

    const finished = await supervisor.waitForRun(run.id);

    // The run belongs to the core. Closing the last window does not stop work.
    expect(finished.status).toBe('completed');
    expect(supervisor.listUpdates(run.id)).toHaveLength(2);
    expect(database!.rooms.listMessages(roomId)).toHaveLength(2);
  });

  it('sends the prompt as three ordered tiers, with the owner notes read-only', async () => {
    const { card, agent } = seed();
    database!.work.setOwnerNotes({
      cardId: card.id, notes: 'Prefer sources that publish their method.', userId: 'owner',
    });
    supervisor = startSupervisor({ echoPrompt: true });

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });
    await supervisor.waitForRun(run.id);

    const echoed = supervisor.listUpdates(run.id)[0] as { content: { text: string } };
    const blocks = JSON.parse(echoed.content.text.replace(/^prompt:/, '')) as Array<{ text: string }>;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]!.text).toContain(agent.jobTitle);
    expect(blocks[1]!.text).toContain('Survey the field');
    expect(blocks[1]!.text).toContain(OWNER_NOTES_HEADING);
    expect(blocks[2]!.text).toBe('Begin.');
  });

  it('builds the same three tiers when called directly', () => {
    const { card, agent } = seed();
    const blocks = buildPrompt({
      agent, skills: [], card, ownerNotes: 'Read me.', message: 'Do the thing.',
    });

    expect(blocks.map((block) => block.type)).toEqual(['text', 'text', 'text']);
    expect(blocks[1]!.text).toContain(OWNER_NOTES_HEADING);
    expect(blocks[2]!.text).toBe('Do the thing.');
  });

  it('survives an agent that dies mid-turn, failing the run rather than hanging', async () => {
    const { card, agent } = seed();
    supervisor = createRunSupervisor({
      database: database!,
      spawnFor: () => ({
        command: process.execPath,
        // Exits immediately without speaking ACP at all.
        args: ['-e', 'process.exit(1)'],
        cwd: process.cwd(),
      }),
    });

    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });
    const finished = await supervisor.waitForRun(run.id);

    expect(finished.status).toBe('failed');
    expect(finished.stoppedReason).toMatch(/closed|exited/i);
  });
});
