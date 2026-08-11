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

  // Found in review: any of G1-G4 was accepted because the CHECK constraint
  // allows them, producing a role at a gate the ladder does not have — a state
  // nothing could later read, since every count resolves the gate through the
  // ladder and threw.
  it('REFUSES a role at a gate the project ladder does not have', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Ops', kind: 'research', mission: 'Run things.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Letters', objective: 'Send them.',
      successCriteria: ['Sent'], gateLadderId: 'business',
    });
    const card = database.work.createCard({ projectId: project.id, title: 'A letter' });
    const agent = database.createOrgAgent({
      name: 'Drafter', jobTitle: 'S', department: 'D', jobFunction: 'F', responsibilities: 'R',
      runtimeId: database.createAgent({
        name: 'rt', command: 'rt', argsTemplate: ['{prompt}'], promptTransport: 'argument',
        outputFormat: 'text', versionArgs: ['--version'], timeoutMs: 120_000,
      }).id,
      model: 'model-one',
    });

    // The business ladder is G1 and G4.
    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G2', role: 'builder', orgAgentId: agent.id,
    })).toThrow(/no G2 gate/i);
    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G4', role: 'builder', orgAgentId: agent.id,
    })).not.toThrow();
  });

  // Finding 11: assignment read only id, model and runtime, so a retired agent
  // could be given sole write authority over a card and an agent from an
  // unrelated venture could be made its reviewer.
  it('REFUSES a disabled agent, and one from another venture', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const ours = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Ours', kind: 'research', mission: 'M.',
    });
    const theirs = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Theirs', kind: 'research', mission: 'M.',
    });
    const project = database.platform.createProject({
      ventureId: ours.id, name: 'P', objective: 'O.', successCriteria: ['C'],
    });
    const card = database.work.createCard({ projectId: project.id, title: 'A card' });
    const make = (name: string, model: string) => database!.createOrgAgent({
      name, jobTitle: 'S', department: 'D', jobFunction: 'F', responsibilities: 'R',
      runtimeId: database!.createAgent({
        name: `rt-${model}`, command: `rt-${model}`, argsTemplate: ['{prompt}'],
        promptTransport: 'argument', outputFormat: 'text',
        versionArgs: ['--version'], timeoutMs: 120_000,
      }).id,
      model,
    });
    const retired = make('Retired', 'm1');
    const outsider = make('Outsider', 'm2');
    const ourAgent = make('Ours', 'm3');
    database.org.assignAgentToVenture(outsider.id, theirs.id, null);
    database.org.assignAgentToVenture(ourAgent.id, ours.id, null);
    // A retired agent, as expireAgent leaves one: recorded, not deleted.
    database.connection.prepare('UPDATE org_agents SET enabled = 0 WHERE id = ?').run(retired.id);

    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: retired.id,
    })).toThrow(/disabled/i);
    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: outsider.id,
    })).toThrow(/another venture/i);
    // An agent of this venture is fine, as is a portfolio-wide one with none.
    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: ourAgent.id,
    })).not.toThrow();
  });

  /**
   * Reviewer independence is decided by comparing effective models
   * (`canReview` in shared/governance.ts), and a null runtime has no defined
   * answer to that comparison. The ruling: refuse the assignment outright
   * rather than let a null runtime reach that comparison at all — an
   * unassigned agent could never have run to file a review anyway, so refusing
   * here turns a confusing downstream failure into an answerable one. Covers
   * both roles: a runtime-less agent must be refused as builder AND as
   * reviewer, since either path constructs a `ReviewerIdentity` for it.
   */
  it('REFUSES an agent with no runtime assigned, as builder and as reviewer, naming the reason', () => {
    const { card, builder } = seed();
    const unassigned = database!.createOrgAgent({
      name: 'Unassigned', jobTitle: 'S', department: 'D', jobFunction: 'F', responsibilities: 'R',
      runtimeId: database!.createAgent({
        name: 'rt-temp', command: 'rt-temp', argsTemplate: ['{prompt}'],
        promptTransport: 'argument', outputFormat: 'text',
        versionArgs: ['--version'], timeoutMs: 120_000,
      }).id,
      model: 'model-temp',
    });
    // Nothing in the domain layer produces this state yet (creation still
    // requires a runtime); simulated directly, the same way the test above
    // simulates a retired agent.
    database!.connection.prepare('UPDATE org_agents SET runtime_id = NULL WHERE id = ?').run(unassigned.id);

    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: unassigned.id,
    })).toThrow(/no runtime/i);
    expect(database!.governance.getBuilder(card.id, 'G1')).toBeNull();

    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    });
    expect(() => database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: unassigned.id,
    })).toThrow(/no runtime/i);
    expect(database!.governance.listReviewers(card.id, 'G1')).toEqual([]);
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
