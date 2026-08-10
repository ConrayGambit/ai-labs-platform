import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';

describe('roles on a card at a gate', () => {
  let database: OrchestratorDatabase | undefined;
  afterEach(() => database?.close());

  function seed() {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Evaluate tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.',
      successCriteria: ['A sourced comparison is approved'],
    });
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
    const runtime = (name: string, command: string) => database!.createAgent({
      name, command, argsTemplate: ['{prompt}'], promptTransport: 'argument',
      outputFormat: 'text', versionArgs: ['--version'], timeoutMs: 120_000,
    });
    const runtimeA = runtime('Runtime A', 'runtime-a');
    const runtimeB = runtime('Runtime B', 'runtime-b');
    const agent = (name: string, runtimeId: string, model: string | null) =>
      database!.createOrgAgent({
        name, jobTitle: 'Specialist', department: 'Research',
        jobFunction: 'Does the work.', responsibilities: 'Work.', runtimeId, model,
      });
    return {
      card,
      builder: agent('Builder', runtimeA.id, 'model-one'),
      sameModel: agent('Same model', runtimeA.id, 'model-one'),
      otherModel: agent('Other model', runtimeB.id, 'model-two'),
      defaultA: agent('Default on A', runtimeA.id, null),
      defaultAToo: agent('Also default on A', runtimeA.id, null),
    };
  }

  it('records one builder and one reviewer for a gate', () => {
    const { card, builder, otherModel } = seed();
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    });
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: otherModel.id,
    });

    expect(database!.governance.getBuilder(card.id, 'G1')?.orgAgentId).toBe(builder.id);
    expect(database!.governance.listReviewers(card.id, 'G1').map((a) => a.orgAgentId))
      .toEqual([otherModel.id]);
    expect(database!.governance.listAssignments(card.id, 'G1')).toHaveLength(2);
  });

  it('REFUSES to make the builder its own reviewer', () => {
    const { card, builder } = seed();
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    });

    // A builder cannot approve its own work (spec 20.1).
    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: builder.id,
    })).toThrow(/own work/i);
    expect(database!.governance.listReviewers(card.id, 'G1')).toEqual([]);
  });

  it('REFUSES a reviewer that shares the builder model', () => {
    const { card, builder, sameModel } = seed();
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    });

    // A same-model reviewer is the builder marking its own work (spec 20.3).
    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: sameModel.id,
    })).toThrow(/same model/i);
  });

  it('REFUSES two agents whose model is the runtime default on one runtime', () => {
    const { card, defaultA, defaultAToo } = seed();
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: defaultA.id,
    });

    // A null model means "the runtime's default", so two agents on one runtime
    // with no explicit model are the same model in practice. Comparing the
    // nulls as different values would wave this straight through.
    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: defaultAToo.id,
    })).toThrow(/same model/i);
  });

  it('REFUSES a second builder on the same gate', () => {
    const { card, builder, otherModel } = seed();
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    });

    // Sole write authority means one holder of it.
    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: otherModel.id,
    })).toThrow(/already has a builder/i);
    expect(database!.governance.getBuilder(card.id, 'G1')?.orgAgentId).toBe(builder.id);
  });

  it('allows a different builder at a different gate on the same card', () => {
    const { card, builder, otherModel } = seed();
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    });

    // Authority is per gate. The agent that designed it need not be the one
    // that ships it.
    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G2', role: 'builder', orgAgentId: otherModel.id,
    })).not.toThrow();
    expect(database!.governance.getBuilder(card.id, 'G2')?.orgAgentId).toBe(otherModel.id);
  });

  it('lets the same agent build one card and review another', () => {
    const { card, builder, otherModel } = seed();
    const second = database!.work.createCard({
      projectId: card.projectId, title: 'A different card',
    });
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    });
    database!.governance.assignRole({
      cardId: second.id, gateId: 'G1', role: 'builder', orgAgentId: otherModel.id,
    });

    // Roles are authority over one card at one gate, not job titles.
    expect(() => database!.governance.assignRole({
      cardId: second.id, gateId: 'G1', role: 'reviewer', orgAgentId: builder.id,
    })).not.toThrow();
  });

  // Found in review: every eligibility check lived on the reviewer path, so
  // assigning the builder LAST skipped all of them. The rule was defeatable by
  // doing the same two things in the other order.
  it('REFUSES a builder assigned after a reviewer already on that model', () => {
    const { card, builder, sameModel } = seed();
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: sameModel.id,
    });

    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    })).toThrow(/same model/i);
    expect(database!.governance.getBuilder(card.id, 'G1')).toBeNull();
  });

  it('REFUSES a builder assigned after it is already a reviewer on that gate', () => {
    const { card, builder } = seed();
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: builder.id,
    });

    // Previously this surfaced a bare UNIQUE constraint message, which names a
    // schema index and tells an operator nothing they can act on.
    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    })).toThrow(/may not hold both roles/i);
  });

  it('allows a builder assigned last when the reviewers run other models', () => {
    const { card, builder, otherModel } = seed();
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: otherModel.id,
    });

    // The check has to refuse the bad ordering without refusing the good one.
    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    })).not.toThrow();
  });

  it('assigning the same reviewer twice is not an error and does not duplicate them', () => {
    const { card, builder, otherModel } = seed();
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    });
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: otherModel.id,
    });
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: otherModel.id,
    });

    expect(database!.governance.listReviewers(card.id, 'G1')).toHaveLength(1);
  });
});
