import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { reviewIsVisibleTo } from '../../src/shared/governance.js';

const base = {
  requiredReviewers: 2,
  filedReviewerIds: ['reviewer-a'],
  now: '2026-08-10T12:00:00.000Z',
  deadlineAt: '2026-08-10T18:00:00.000Z',
};

describe('blind review, as a rule', () => {
  it('HIDES one reviewer filed review from the other reviewer', () => {
    // Two reviewers who read each other converge, and manufactured convergence
    // is one opinion counted twice.
    expect(reviewIsVisibleTo({
      ...base, reviewAuthorId: 'reviewer-a', viewerId: 'reviewer-b', viewerRole: 'reviewer',
    })).toBe(false);
  });

  it('shows a reviewer their own review', () => {
    expect(reviewIsVisibleTo({
      ...base, reviewAuthorId: 'reviewer-a', viewerId: 'reviewer-a', viewerRole: 'reviewer',
    })).toBe(true);
  });

  it('shows everything once every required review is filed', () => {
    expect(reviewIsVisibleTo({
      ...base, filedReviewerIds: ['reviewer-a', 'reviewer-b'],
      reviewAuthorId: 'reviewer-a', viewerId: 'reviewer-b', viewerRole: 'reviewer',
    })).toBe(true);
  });

  it('shows everything once the outstanding reviewer deadline has passed', () => {
    // A deadline is what stops one silent reviewer sealing a gate forever.
    expect(reviewIsVisibleTo({
      ...base, now: '2026-08-10T18:00:01.000Z',
      reviewAuthorId: 'reviewer-a', viewerId: 'reviewer-b', viewerRole: 'reviewer',
    })).toBe(true);
  });

  it('keeps the seal while the deadline is still ahead', () => {
    expect(reviewIsVisibleTo({
      ...base, now: '2026-08-10T17:59:59.000Z',
      reviewAuthorId: 'reviewer-a', viewerId: 'reviewer-b', viewerRole: 'reviewer',
    })).toBe(false);
  });

  it('keeps the seal indefinitely when no deadline was set', () => {
    // No deadline is not an expired deadline. Treating a missing one as passed
    // would quietly disable blindness for every gate nobody scheduled.
    expect(reviewIsVisibleTo({
      ...base, deadlineAt: null,
      reviewAuthorId: 'reviewer-a', viewerId: 'reviewer-b', viewerRole: 'reviewer',
    })).toBe(false);
  });

  it('DOES NOT ENGAGE at one reviewer, because there is nobody to be blind from', () => {
    expect(reviewIsVisibleTo({
      ...base, requiredReviewers: 1, reviewAuthorId: 'reviewer-a',
      viewerId: 'reviewer-b', viewerRole: 'reviewer',
    })).toBe(true);
  });

  it('HIDES a filed review from the builder until all are in', () => {
    // The builder reads BOTH reviews in full before ruling on either (20.4.1).
    // Seeing one early is how a builder starts adjudicating before it has read
    // the second, which is the thing that rule exists to prevent.
    expect(reviewIsVisibleTo({
      ...base, reviewAuthorId: 'reviewer-a', viewerId: 'builder', viewerRole: 'builder',
    })).toBe(false);
  });

  it('shows the builder everything once both are filed', () => {
    expect(reviewIsVisibleTo({
      ...base, filedReviewerIds: ['reviewer-a', 'reviewer-b'],
      reviewAuthorId: 'reviewer-a', viewerId: 'builder', viewerRole: 'builder',
    })).toBe(true);
  });

  it('always shows everything to the owner', () => {
    // The owner outranks everything (20.1) and is not a participant in the
    // convergence the blindness protects.
    expect(reviewIsVisibleTo({
      ...base, reviewAuthorId: 'reviewer-a', viewerId: 'owner', viewerRole: 'owner',
    })).toBe(true);
  });
});

describe('blind review, through the repository', () => {
  let database: OrchestratorDatabase | undefined;
  afterEach(() => database?.close());

  const checklist = [{ item: 'Does it meet the acceptance criteria?', answer: 'Yes.' }];

  function seed(reviewerCountOverride?: number) {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Evaluate tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.',
      successCriteria: ['A sourced comparison is approved'],
      ...(reviewerCountOverride === undefined ? {} : { reviewerCountOverride }),
    });
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
    const make = (name: string, model: string) => database!.createOrgAgent({
      name, jobTitle: 'Specialist', department: 'Research',
      jobFunction: 'Does the work.', responsibilities: 'Work.',
      runtimeId: database!.createAgent({
        name: `Runtime ${model}`, command: `runtime-${model}`, argsTemplate: ['{prompt}'],
        promptTransport: 'argument', outputFormat: 'text',
        versionArgs: ['--version'], timeoutMs: 120_000,
      }).id,
      model,
    });
    const builder = make('Builder', 'model-one');
    const reviewerA = make('Reviewer A', 'model-two');
    const reviewerB = make('Reviewer B', 'model-three');
    database.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    });
    database.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: reviewerA.id,
    });
    database.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: reviewerB.id,
    });
    return { project, card, builder, reviewerA, reviewerB };
  }

  const file = (cardId: string, reviewerOrgAgentId: string) =>
    database!.governance.fileReview({
      cardId, gateId: 'G1', reviewerOrgAgentId, verdict: 'approve',
      checklist, whatToPreserve: '', questionsForBuilder: '', findings: [],
    });

  it('resolves the required count from the project override', () => {
    const { project } = seed(2);

    // The column existed but was never mapped, so a project raised to two
    // reviewers behaved as though it were set to one.
    expect(database!.platform.getProject(project.id)?.reviewerCountOverride).toBe(2);
  });

  it('SEALS a filed review from the other reviewer and from the builder', () => {
    const { card, builder, reviewerA, reviewerB } = seed(2);
    const filed = file(card.id, reviewerA.id);

    expect(database!.governance
      .listVisibleReviews(card.id, 'G1', { id: reviewerA.id, role: 'reviewer' })
      .map((review) => review.id)).toEqual([filed.id]);
    expect(database!.governance
      .listVisibleReviews(card.id, 'G1', { id: reviewerB.id, role: 'reviewer' })).toEqual([]);
    expect(database!.governance
      .listVisibleReviews(card.id, 'G1', { id: builder.id, role: 'builder' })).toEqual([]);
  });

  it('shows the owner a sealed review anyway', () => {
    const { card, reviewerA } = seed(2);
    file(card.id, reviewerA.id);

    expect(database!.governance
      .listVisibleReviews(card.id, 'G1', { id: 'owner', role: 'owner' })).toHaveLength(1);
  });

  it('UNSEALS everything once both reviewers have filed', () => {
    const { card, builder, reviewerA, reviewerB } = seed(2);
    file(card.id, reviewerA.id);
    file(card.id, reviewerB.id);

    expect(database!.governance
      .listVisibleReviews(card.id, 'G1', { id: builder.id, role: 'builder' })).toHaveLength(2);
    expect(database!.governance
      .listVisibleReviews(card.id, 'G1', { id: reviewerA.id, role: 'reviewer' })).toHaveLength(2);
  });

  it('does not engage at all when the project runs on one reviewer', () => {
    const { card, builder, reviewerA } = seed();
    file(card.id, reviewerA.id);

    // One reviewer is the default. There is nobody to be blind from, and the
    // platform does not pretend otherwise.
    expect(database!.governance
      .listVisibleReviews(card.id, 'G1', { id: builder.id, role: 'builder' })).toHaveLength(1);
  });

  it('counts a superseded review as not filed, so a reviewer cannot unseal alone', () => {
    const { card, builder, reviewerA } = seed(2);
    file(card.id, reviewerA.id);
    file(card.id, reviewerA.id);

    // Two rows, one current reviewer. Counting rows here would let one reviewer
    // unseal the gate by filing twice.
    expect(database!.governance.listReviews(card.id, 'G1')).toHaveLength(2);
    expect(database!.governance
      .listVisibleReviews(card.id, 'G1', { id: builder.id, role: 'builder' })).toEqual([]);
  });

  // Found in review: the deadline was the minimum across EVERY assignment, so a
  // stale deadline on a reviewer who had already filed unsealed the gate while
  // another reviewer was still working.
  it('IGNORES an expired deadline belonging to a reviewer who already filed', () => {
    const { card, builder, reviewerA } = seed(2);
    file(card.id, reviewerA.id);
    database!.governance.setReviewDeadline({
      cardId: card.id, gateId: 'G1', orgAgentId: reviewerA.id,
      deadlineAt: '2000-01-01T00:00:00.000Z',
    });

    // Reviewer B is still out and has no deadline. Nothing unseals.
    expect(database!.governance
      .listVisibleReviews(card.id, 'G1', { id: builder.id, role: 'builder' })).toEqual([]);
  });

  it('requires EVERY outstanding reviewer to be out of time, not merely one', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'V', kind: 'research', mission: 'M.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'P', objective: 'O.', successCriteria: ['C'],
      reviewerCountOverride: 3,
    });
    const card = database.work.createCard({ projectId: project.id, title: 'T' });
    const make = (name: string, model: string) => database!.createOrgAgent({
      name, jobTitle: 'S', department: 'D', jobFunction: 'F', responsibilities: 'R',
      runtimeId: database!.createAgent({
        name: `rt-${model}`, command: `rt-${model}`, argsTemplate: ['{prompt}'],
        promptTransport: 'argument', outputFormat: 'text',
        versionArgs: ['--version'], timeoutMs: 120_000,
      }).id,
      model,
    });
    const builder = make('Builder', 'm1');
    const first = make('A', 'm2');
    const second = make('B', 'm3');
    const third = make('C', 'm4');
    for (const [role, agent] of [
      ['builder', builder], ['reviewer', first], ['reviewer', second], ['reviewer', third],
    ] as const) {
      database.governance.assignRole({ cardId: card.id, gateId: 'G1', role, orgAgentId: agent.id });
    }
    file(card.id, first.id);
    // Two still out; only one of them is out of time.
    database.governance.setReviewDeadline({
      cardId: card.id, gateId: 'G1', orgAgentId: second.id,
      deadlineAt: '2000-01-01T00:00:00.000Z',
    });

    expect(database.governance
      .listVisibleReviews(card.id, 'G1', { id: builder.id, role: 'builder' })).toEqual([]);
  });

  it('unseals once an outstanding reviewer deadline has passed', () => {
    const { card, builder, reviewerA, reviewerB } = seed(2);
    file(card.id, reviewerA.id);
    database!.governance.setReviewDeadline({
      cardId: card.id, gateId: 'G1', orgAgentId: reviewerB.id,
      deadlineAt: '2000-01-01T00:00:00.000Z',
    });

    expect(database!.governance
      .listVisibleReviews(card.id, 'G1', { id: builder.id, role: 'builder' })).toHaveLength(1);
  });
});
