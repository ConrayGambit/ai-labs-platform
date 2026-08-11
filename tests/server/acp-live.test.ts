import { describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { createRunSupervisor } from '../../src/server/run-supervisor.js';
import { acpSpawnOptions } from '../../src/server/acp/launch.js';
import type { SessionUpdate } from '../../src/shared/acp.js';

/**
 * The one test that spawns a real provider and makes a real, billed model
 * call. Skipped unless AI_LABS_ACP_LIVE=1, so `npm test` stays offline and
 * deterministic — tests/fixtures/fake-acp-agent.mjs covers the protocol paths
 * for everyone else.
 *
 * It exists because a fake agent cannot demonstrate the thing that was broken:
 * that no seeded runtime could complete a real run at all.
 */
describe.skipIf(process.env.AI_LABS_ACP_LIVE !== '1')('a real ACP provider', () => {
  it('completes a run through the supervisor and advances the card', async () => {
    const database: OrchestratorDatabase = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Live Check', kind: 'research', mission: 'Prove the wiring.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id,
      name: 'ACP Acceptance',
      objective: 'Complete one real ACP run.',
      successCriteria: ['A real provider answers'],
    });
    const card = database.work.createCard({ projectId: project.id, title: 'Say hello' });
    database.rooms.createRoomForCard({ cardId: card.id, title: card.title });

    const claude = database.getAgent('claude');
    expect(claude, 'the claude runtime should be seeded').toBeTruthy();
    // CreateOrgAgentInput requires all five descriptive fields; only
    // organizationId, managerId and the tuning keys are optional.
    const orgAgent = database.createOrgAgent({
      name: 'Live Runner',
      jobTitle: 'Engineer',
      department: 'Engineering',
      jobFunction: 'Answer one prompt so the ACP path can be observed working.',
      responsibilities: 'Reply to the acceptance prompt and stop.',
      runtimeId: 'claude',
    });

    const supervisor = createRunSupervisor({
      database,
      spawnFor: () => acpSpawnOptions(claude!, process.cwd()),
      // Answer any permission request by taking the first option, so a tool
      // call cannot stall the acceptance run waiting for a person.
      permissionHandler: (request) => ({
        outcome: { outcome: 'selected', optionId: request.options[0].optionId },
      }),
    });

    const updates: SessionUpdate[] = [];
    const run = await supervisor.startRun({
      cardId: card.id,
      orgAgentId: orgAgent.id,
      message: 'Reply with exactly the word: acknowledged. Do not use any tools.',
    });
    supervisor.subscribe(run.id, (event) => {
      if (event.type === 'update') updates.push(event.update);
    });

    const finished = await supervisor.waitForRun(run.id);
    await supervisor.shutdown();

    expect(finished.status, `run failed: ${finished.stoppedReason ?? ''}`).toBe('completed');
    expect(finished.stopReason).toBe('end_turn');
    expect(updates.length).toBeGreaterThan(0);
    // A card is created in 'backlog'. A completed turn moves it to the first
    // gate of the project's ladder, which is a 'review' status with a gateId.
    const moved = database.work.getCard(card.id);
    expect(moved?.status).toBe('review');
    expect(moved?.gateId).toBeTruthy();

    database.close();
  }, 180_000);
});
