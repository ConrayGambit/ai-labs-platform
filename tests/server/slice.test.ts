import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { canAdvance, PRODUCT_LADDER, columnKeyFor, deriveColumns } from '../../src/server/gate-policy.js';
import { SPECIFICATION_SECTIONS } from '../../src/server/governance-policy.js';
import { createRunSupervisor, type RunSupervisor } from '../../src/server/run-supervisor.js';
import type { SessionUpdate } from '../../src/shared/acp.js';
import { denial } from '../helpers/verdict.js';


const FAKE_AGENT = resolve('tests/fixtures/fake-acp-agent.mjs');

/**
 * The S1 acceptance test: an agent claims a card, works it live, and hands it
 * back at a gate it may not pass on its own.
 *
 * Everything below is one continuous story, deliberately, because the point of
 * a vertical slice is that the pieces meet.
 */
describe('the vertical slice', () => {
  let database: OrchestratorDatabase | undefined;
  let supervisor: RunSupervisor | undefined;

  afterEach(async () => {
    await supervisor?.shutdown();
    supervisor = undefined;
    database?.close();
    database = undefined;
  });

  it('carries one card from the backlog to a gate it cannot pass alone', async () => {
    database = createDatabase(':memory:');

    // 1. An owner, a portfolio, a venture, a department and a governed project.
    const owner = database.identity.getOwner();
    expect(owner).toMatchObject({ id: 'owner', role: 'owner' });

    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research',
      mission: 'Evaluate tools that are worth the time.',
    });
    const department = database.org.createDepartment({ ventureId: venture.id, name: 'Research' });
    const project = database.platform.createProject({
      ventureId: venture.id,
      name: 'Tool Survey',
      objective: 'Compare free research services.',
      successCriteria: ['A sourced comparison is approved'],
      gateLadderId: 'product',
    });
    expect(project.gateLadderId).toBe('product');

    // The board a client would render comes from the ladder, not from a
    // hardcoded list of columns.
    expect(deriveColumns(PRODUCT_LADDER).map((column) => column.key)).toEqual([
      'backlog', 'ready', 'in_progress', 'G1', 'G2', 'G3', 'G4', 'blocked', 'done',
    ]);

    // 2. A card in the backlog, with a room of its own and no owner notes.
    const card = database.work.createCard({
      projectId: project.id, title: 'Survey the field', description: 'Six services, one table.',
    });
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });
    expect(card).toMatchObject({ status: 'backlog', ownerNotes: '', assigneeOrgAgentId: null });
    expect(database.rooms.getRoomForCard(card.id)?.id).toBe(room.id);

    // 3. The owner writes notes, and the activity says who wrote them.
    database.work.setOwnerNotes({
      cardId: card.id, notes: 'Prefer sources that publish their method.', userId: 'owner',
    });
    expect(database.work.listActivity(card.id)).toEqual([
      expect.objectContaining({ kind: 'created' }),
      expect.objectContaining({ kind: 'notes_changed', actorType: 'user', actorId: 'owner' }),
    ]);

    // 4. One accountable agent on the card. Everyone else joins through the room.
    const runtime = database.createAgent({
      name: 'Test ACP Runtime', command: 'node', argsTemplate: ['{prompt}'],
      promptTransport: 'argument', outputFormat: 'text',
      versionArgs: ['--version'], timeoutMs: 120_000,
    });
    const agent = database.createOrgAgent({
      name: 'Research Specialist', jobTitle: 'Research Specialist', department: 'Research',
      jobFunction: 'Compares services and reports what it finds.',
      responsibilities: 'Survey, compare, cite.', runtimeId: runtime.id,
    });
    database.org.assignAgentToVenture(agent.id, venture.id, department.id);
    const assigned = database.work.updateCard(card.id, { assigneeOrgAgentId: agent.id });
    expect(assigned.assigneeOrgAgentId).toBe(agent.id);
    expect(database.work.listActivity(card.id).filter((entry) => entry.kind === 'assigned'))
      .toHaveLength(1);

    // 5. The agent works the card.
    supervisor = createRunSupervisor({
      database,
      spawnFor: () => ({
        command: process.execPath,
        args: [FAKE_AGENT],
        cwd: process.cwd(),
        env: {
          FAKE_ACP_SCRIPT: JSON.stringify({
            updates: [
              { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Six services, ' } },
              { sessionUpdate: 'usage_update', usage: { inputTokens: 900, outputTokens: 120 } },
              { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'three publish a method.' }, delayMs: 80 },
            ],
            stopReason: 'end_turn',
          }),
        },
      }),
    });
    const run = await supervisor.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Survey the field and report.',
    });
    expect(run.status).toBe('running');

    // 6. A client that arrives after the run started still sees all of it.
    const seen: SessionUpdate[] = [];
    await new Promise((settled) => setTimeout(settled, 30));
    supervisor.subscribe(run.id, (event) => {
      if (event.type === 'update') seen.push(event.update);
    });
    const finished = await supervisor.waitForRun(run.id);

    const spoken = seen
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => (update as { content: { text: string } }).content.text);
    expect(spoken.join('')).toBe('Six services, three publish a method.');

    // 7. Everything the agent said is in the card's room, tied to the run.
    const posted = database.rooms.listMessages(room.id);
    expect(posted.map((entry) => entry.message.body)).toEqual(spoken);
    expect(posted.every((entry) => entry.message.runId === run.id)).toBe(true);

    // 8. The turn ended, it was metered, and the card is at the first gate.
    expect(finished).toMatchObject({
      status: 'completed', stopReason: 'end_turn', inputTokens: 900, outputTokens: 120,
    });
    const atGate = database.work.getCard(card.id)!;
    expect(atGate).toMatchObject({ status: 'review', gateId: 'G1' });
    expect(columnKeyFor(atGate)).toBe('G1');

    // 9. The agent may not close its own work. No artifact, no review, no pass.
    const missing = database.governance.missingSpecificationSections(card.id);
    const denied = canAdvance({
      requiredReviewers: 1,
      card: atGate,
      ladder: PRODUCT_LADDER,
      to: 'done',
      evidence: {
        reviewsFiled: 0, ownerDecision: false, artifactCount: 0,
        missingSpecificationSections: missing,
        missingHandoverPoints: database.governance.missingHandoverPoints(card.id),
        hasOpenP0: database.governance.hasOpenP0(card.id),
      },
    });
    expect(denial(denied).reason).toMatch(/G1/);

    // 9b. Nor may it leave G1 on a specification nobody wrote.
    expect(missing).toHaveLength(13);
    const withReview = canAdvance({
      requiredReviewers: 1,
      card: atGate, ladder: PRODUCT_LADDER, to: 'G2',
      evidence: {
        reviewsFiled: 1, ownerDecision: false, artifactCount: 1,
        missingSpecificationSections: missing,
        missingHandoverPoints: database.governance.missingHandoverPoints(card.id),
        hasOpenP0: database.governance.hasOpenP0(card.id),
      },
    });
    expect(denial(withReview).reason).toMatch(/specification/i);
    database.governance.saveSpecification({
      cardId: card.id,
      sections: Object.fromEntries(
        SPECIFICATION_SECTIONS.map((section) => [section, `Written: ${section}.`]),
      ),
    });

    // 10. With something to inspect and a review filed, the gate opens.
    database.work.attachArtifact({
      cardId: card.id, runId: run.id, kind: 'report',
      label: 'Comparison table', location: 'artifacts/comparison.md',
    });
    expect(database.work.listArtifacts(card.id)).toHaveLength(1);
    const allowed = canAdvance({
      requiredReviewers: 1,
      card: atGate,
      ladder: PRODUCT_LADDER,
      to: 'G2',
      evidence: {
        reviewsFiled: 1, ownerDecision: false, artifactCount: 1,
        missingSpecificationSections: database.governance.missingSpecificationSections(card.id),
        missingHandoverPoints: database.governance.missingHandoverPoints(card.id),
        hasOpenP0: database.governance.hasOpenP0(card.id),
      },
    });
    expect(allowed).toEqual({ allowed: true });

    // 11. Nothing the agent did could touch the owner's notes.
    expect(() =>
      database!.work.appendActivity({
        cardId: card.id, actorType: 'org_agent', actorId: agent.id,
        kind: 'notes_changed', detail: 'Rewrote the brief.',
      }),
    ).toThrow(/owner/i);
    expect(database.work.getCard(card.id)?.ownerNotes)
      .toBe('Prefer sources that publish their method.');
  });
});
