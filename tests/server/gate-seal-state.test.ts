import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { reviewIsVisibleTo, type FileReviewInput } from '../../src/shared/governance.js';

const checklist = [{ item: 'Does it meet the acceptance criteria?', answer: 'Yes.' }];

/**
 * Creates a portfolio, venture, project, card, and two reviewer assignments on
 * G1, with the project's reviewer count raised to two. Copies the fixture
 * shape from tests/server/blind-review.test.ts so the two suites seed
 * identically.
 */
function seedTwoReviewerGate(database: OrchestratorDatabase) {
  const portfolio = database.platform.createPortfolio({
    name: 'Sample Portfolio', ownerUserId: 'owner',
  });
  const venture = database.platform.createVenture({
    portfolioId: portfolio.id, name: 'Sample Venture', kind: 'research', mission: 'Evaluate tools.',
  });
  const project = database.platform.createProject({
    ventureId: venture.id, name: 'Sample Project', objective: 'Compare services.',
    successCriteria: ['A sourced comparison is approved'],
    reviewerCountOverride: 2,
  });
  const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
  const make = (name: string, model: string) => database.createOrgAgent({
    name, jobTitle: 'Specialist', department: 'Research',
    jobFunction: 'Does the work.', responsibilities: 'Work.',
    runtimeId: database.createAgent({
      name: `Runtime ${model}`, command: `runtime-${model}`, argsTemplate: ['{prompt}'],
      promptTransport: 'argument', outputFormat: 'text',
      versionArgs: ['--version'], timeoutMs: 120_000,
    }).id,
    model,
  });
  const reviewerA = make('Reviewer A', 'model-two');
  const reviewerB = make('Reviewer B', 'model-three');
  database.governance.assignRole({
    cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: reviewerA.id,
  });
  database.governance.assignRole({
    cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: reviewerB.id,
  });
  return { cardId: card.id, reviewerA: reviewerA.id, reviewerB: reviewerB.id };
}

/** A minimal, valid review filing from one reviewer, with no findings. */
function filedReviewBy(reviewerOrgAgentId: string, cardId: string): FileReviewInput {
  return {
    cardId,
    gateId: 'G1',
    reviewerOrgAgentId,
    verdict: 'approve',
    checklist,
    whatToPreserve: '',
    questionsForBuilder: '',
    findings: [],
  };
}

describe('the gate seal state', () => {
  let database: OrchestratorDatabase | undefined;
  afterEach(() => { database?.close(); database = undefined; });

  function seedGate() {
    database = createDatabase(':memory:');
    // Reuse the fixture helper the blind-review suite already uses; it creates a
    // portfolio, venture, project, card, and two reviewer assignments on G1.
    return seedTwoReviewerGate(database);
  }

  it('reports a gate as sealed while one of two reviewers has filed', () => {
    const { cardId, reviewerA } = seedGate();
    database!.governance.insertReviewRecord(filedReviewBy(reviewerA, cardId));

    const state = database!.governance.getGateSealState(cardId, 'G1');

    expect(state.requiredReviewers).toBe(2);
    expect(state.filedReviewerIds).toEqual([reviewerA]);
    expect(state.sealed).toBe(true);
    expect(state.sealReason).toBe('1 of 2 reviewers have filed.');
  });

  it('reports a gate as unsealed once both have filed', () => {
    const { cardId, reviewerA, reviewerB } = seedGate();
    database!.governance.insertReviewRecord(filedReviewBy(reviewerA, cardId));
    database!.governance.insertReviewRecord(filedReviewBy(reviewerB, cardId));

    const state = database!.governance.getGateSealState(cardId, 'G1');
    expect(state.sealed).toBe(false);
    expect(state.sealReason).toBeNull();
  });

  it('agrees with reviewIsVisibleTo for a reviewer who has not filed', () => {
    const { cardId, reviewerA, reviewerB } = seedGate();
    database!.governance.insertReviewRecord(filedReviewBy(reviewerA, cardId));

    const state = database!.governance.getGateSealState(cardId, 'G1');
    const visibleToB = reviewIsVisibleTo({
      viewerId: reviewerB,
      viewerRole: 'reviewer',
      reviewAuthorId: reviewerA,
      requiredReviewers: state.requiredReviewers,
      filedReviewerIds: state.filedReviewerIds,
      deadlineAt: state.deadlineAt,
      now: new Date().toISOString(),
    });
    // The seal state is the same fact the visibility rule uses. If these ever
    // disagree, one of them is a second copy of the rule.
    expect(state.sealed).toBe(!visibleToB);
  });

  it('unseals once every outstanding reviewer is out of time', () => {
    const { cardId, reviewerA, reviewerB } = seedGate();
    const expired = '2000-01-01T00:00:00.000Z';
    database!.governance.setReviewDeadline({
      cardId, gateId: 'G1', orgAgentId: reviewerA, deadlineAt: expired,
    });
    database!.governance.setReviewDeadline({
      cardId, gateId: 'G1', orgAgentId: reviewerB, deadlineAt: expired,
    });

    const state = database!.governance.getGateSealState(cardId, 'G1');
    expect(state.sealed).toBe(false);
    expect(state.sealReason).toBeNull();
  });

  it('stays sealed when only one of two outstanding reviewers is out of time', () => {
    // The rule is EVERY outstanding reviewer out of time, not merely one
    // (tests/server/blind-review.test.ts:235 covers this shape for
    // listVisibleReviews). A future change from "every" to "any" would flip
    // this expectation, and nothing else in this file would catch it.
    const { cardId, reviewerA } = seedGate();
    database!.governance.setReviewDeadline({
      cardId, gateId: 'G1', orgAgentId: reviewerA, deadlineAt: '2000-01-01T00:00:00.000Z',
    });
    // reviewerB is left with no deadline at all.

    const state = database!.governance.getGateSealState(cardId, 'G1');
    expect(state.sealed).toBe(true);
  });
});
