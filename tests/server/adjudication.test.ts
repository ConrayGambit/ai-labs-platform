import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { createGovernanceService, type GovernanceService } from '../../src/server/governance-service.js';
import type { FindingInput } from '../../src/shared/governance.js';

describe('adjudication', () => {
  let database: OrchestratorDatabase | undefined;
  let service: GovernanceService | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
    service = undefined;
  });

  const checklist = [{ item: 'Does it meet the acceptance criteria?', answer: 'Yes.' }];

  const finding = (overrides: Partial<FindingInput> = {}): FindingInput => ({
    priority: 'P2',
    area: 'run-supervisor',
    finding: 'The cost ceiling is evaluated after the usage row is written.',
    predictedFailure: 'A run at 99% of ceiling writes one more update before stopping.',
    evidence: 'src/server/run-supervisor.ts:112',
    proposedFix: 'Evaluate the ceiling before persisting.',
    ...overrides,
  });

  /** A card with a builder and two reviewers, on a project raised to two. */
  function seed(reviewerCountOverride = 2) {
    database = createDatabase(':memory:');
    service = createGovernanceService(database);
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Evaluate tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.',
      successCriteria: ['A sourced comparison is approved'], reviewerCountOverride,
    });
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
    const other = database.work.createCard({ projectId: project.id, title: 'A different card' });
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
    for (const [role, agent] of [
      ['builder', builder], ['reviewer', reviewerA], ['reviewer', reviewerB],
    ] as const) {
      database.governance.assignRole({
        cardId: card.id, gateId: 'G1', role, orgAgentId: agent.id,
      });
    }
    return { project, card, other, builder, reviewerA, reviewerB };
  }

  const file = (cardId: string, reviewerOrgAgentId: string, findings: FindingInput[] = []) =>
    service!.fileReview({
      cardId, gateId: 'G1', reviewerOrgAgentId,
      verdict: findings.length ? 'approve_with_findings' : 'approve',
      checklist, whatToPreserve: '', questionsForBuilder: '', findings,
    });

  it('REFUSES to adjudicate before every required review is filed', () => {
    const { card, builder, reviewerA } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);

    // The builder reads BOTH reviews in full before ruling on either (20.4.1),
    // so there is nothing to rule on until every required review is in.
    expect(() => service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId: filed.review.findings[0]!.id,
      outcome: 'adopted', reason: 'Fair.', ruledByOrgAgentId: builder.id,
    })).toThrow(/all reviews/i);
  });

  it('adopts a finding once both reviews are in, and closes it', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);
    const findingId = filed.review.findings[0]!.id;

    const result = service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId,
      outcome: 'adopted', reason: 'Correct; fixed in this change.',
      ruledByOrgAgentId: builder.id,
    });

    expect(result.ruling).toMatchObject({ outcome: 'adopted', isFinal: false });
    expect(service!.isFindingOpen(findingId)).toBe(false);
  });

  it('REFUSES a deferral with no named next step', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);

    // A deferral is an override with a date attached. Without a next step it is
    // just a finding quietly dropped.
    expect(() => service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId: filed.review.findings[0]!.id,
      outcome: 'deferred', reason: 'Not now.', ruledByOrgAgentId: builder.id,
    })).toThrow(/next step/i);
  });

  // Found in review: a deferral with a next step but no date was accepted, so
  // "revisit this later" carried no later.
  it('REFUSES a deferral with no date to revisit it', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);

    expect(() => service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId: filed.review.findings[0]!.id,
      outcome: 'deferred', reason: 'Not now.', nextStep: 'Fix in the next slice.',
      ruledByOrgAgentId: builder.id,
    })).toThrow(/date to revisit/i);
  });

  it('accepts a deferral carrying both a next step and a date', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);

    const result = service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId: filed.review.findings[0]!.id,
      outcome: 'deferred', reason: 'Not now.', nextStep: 'Fix in the next slice.',
      deferredUntil: '2026-09-01', ruledByOrgAgentId: builder.id,
    });

    expect(result.registerEntry).toMatchObject({ deferredUntil: '2026-09-01' });
  });

  it('records an override with the reviewer, priority, reason and residual risk', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding({ priority: 'P2' })]);
    file(card.id, reviewerB.id);

    const result = service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId: filed.review.findings[0]!.id,
      outcome: 'overridden', reason: 'The write is idempotent, so the extra update is harmless.',
      residualRisk: 'One redundant row per stopped run.',
      ruledByOrgAgentId: builder.id,
    });

    expect(result.ruling).toMatchObject({
      outcome: 'overridden',
      reason: 'The write is idempotent, so the extra update is harmless.',
      residualRisk: 'One redundant row per stopped run.',
      ruledByOrgAgentId: builder.id,
    });
    // The ruling produces the register entry itself, not a description of one.
    expect(result.registerEntry).toMatchObject({
      priority: 'P2', reviewerOrgAgentId: reviewerA.id, reference: 'OV-0001',
    });
  });

  it('REFUSES an override of a P0, and leaves the finding open', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding({
      priority: 'P0', area: 'access',
      finding: 'The route does not check venture access.',
      predictedFailure: 'A staff user reads another venture cards.',
      evidence: 'src/server/work-api.ts:88',
    })]);
    file(card.id, reviewerB.id);
    const findingId = filed.review.findings[0]!.id;

    expect(() => service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId,
      outcome: 'overridden', reason: 'I disagree.', residualRisk: 'None.',
      ruledByOrgAgentId: builder.id,
    })).toThrow(/P0 may not be overridden/i);
    expect(service!.isFindingOpen(findingId)).toBe(true);
  });

  // Found by an external code review. The guard checked only the literal
  // string 'overridden', while the register-entry decision twelve lines later
  // correctly treated a deferral as an override. Two expressions, one question,
  // and they disagreed: a builder could defer a P0 and the register recorded it.
  it('REFUSES to DEFER a P0, because a deferral is an override with a date', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding({
      priority: 'P0', area: 'access', finding: 'No venture check.',
      predictedFailure: 'Cross-venture read.', evidence: 'src/server/work-api.ts:88',
    })]);
    file(card.id, reviewerB.id);
    const findingId = filed.review.findings[0]!.id;

    expect(() => service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'deferred',
      reason: 'Later.', nextStep: 'Next slice.', deferredUntil: '2026-09-01',
      ruledByOrgAgentId: builder.id,
    })).toThrow(/P0 may not be deferred/i);
    expect(service!.isFindingOpen(findingId)).toBe(true);
    expect(database!.governance.listOverrides({})).toEqual([]);
  });

  it('REFUSES a contest before there is any ruling to contest', () => {
    const { card, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);

    // Contesting early used to spend the right: it made the builder's FIRST
    // ruling final, so the reviewer lost the appeal by exercising it.
    expect(() => service!.contestRuling({
      findingId: filed.review.findings[0]!.id,
      contestedByOrgAgentId: reviewerA.id, newEvidence: 'Early.',
    })).toThrow(/no ruling to contest/i);
  });

  it('REFUSES a contest from the BUILDER on its own finding', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);
    const findingId = filed.review.findings[0]!.id;
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'overridden',
      reason: 'Harmless.', residualRisk: 'None.', ruledByOrgAgentId: builder.id,
    });

    // The builder could contest its own finding, make its own re-ruling final,
    // and then shut the real reviewer out with "this has a final ruling" —
    // turning the reviewer's one appeal into the builder's lock.
    expect(() => service!.contestRuling({
      findingId, contestedByOrgAgentId: builder.id, newEvidence: 'I disagree with myself.',
    })).toThrow(/only the reviewer who raised the finding/i);

    // And the real reviewer's appeal still works afterwards.
    expect(() => service!.contestRuling({
      findingId, contestedByOrgAgentId: reviewerA.id, newEvidence: 'It is not harmless.',
    })).not.toThrow();
  });

  it('REFUSES a contest from a reviewer who did not raise the finding', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);
    const findingId = filed.review.findings[0]!.id;
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'overridden',
      reason: 'Harmless.', residualRisk: 'None.', ruledByOrgAgentId: builder.id,
    });

    expect(() => service!.contestRuling({
      findingId, contestedByOrgAgentId: reviewerB.id, newEvidence: 'Not mine to contest.',
    })).toThrow(/only the reviewer who raised the finding/i);
  });

  it('STOPS the card on a P0 filed through the ONLY filing path', () => {
    const { card, reviewerA } = seed();

    // The repository can still write a review record, but it is named
    // insertReviewRecord and is not the way a review is filed. Filing goes
    // through the service, which is what escalates.
    const filed = service!.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewerA.id,
      verdict: 'reject', checklist,
      whatToPreserve: '', questionsForBuilder: '',
      findings: [finding({
        priority: 'P0', area: 'access', finding: 'No venture check.',
        predictedFailure: 'Cross-venture read.', evidence: 'src/server/work-api.ts:88',
      })],
    });

    expect(filed.escalations).toHaveLength(1);
    expect(database!.work.getCard(card.id)?.status).toBe('blocked');
  });

  it('STOPS the card the moment a P0 is filed, and raises it to the owner', () => {
    const { card, reviewerA } = seed();

    const filed = file(card.id, reviewerA.id, [finding({
      priority: 'P0', area: 'access', finding: 'No venture check.',
      predictedFailure: 'Cross-venture read.', evidence: 'src/server/work-api.ts:88',
    })]);

    expect(filed.escalations).toHaveLength(1);
    expect(database!.work.getCard(card.id)?.status).toBe('blocked');
    expect(service!.listOpenEscalations().map((e) => e.cardId)).toEqual([card.id]);
    // The move is recorded as the platform's doing, not a person's.
    expect(database!.work.listActivity(card.id).at(-1)).toMatchObject({ actorType: 'system' });
  });

  it('leaves unblocked work running while one card is stopped', () => {
    const { card, other, reviewerA } = seed();
    file(card.id, reviewerA.id, [finding({
      priority: 'P0', area: 'access', finding: 'No venture check.',
      predictedFailure: 'Cross-venture read.', evidence: 'src/server/work-api.ts:88',
    })]);

    // A P0 stops the affected work. Unblocked work continues in parallel.
    expect(database!.work.getCard(other.id)?.status).toBe('backlog');
  });

  it('unblocks the card when the owner resolves the escalation', () => {
    const { card, reviewerA } = seed();
    const filed = file(card.id, reviewerA.id, [finding({
      priority: 'P0', area: 'access', finding: 'No venture check.',
      predictedFailure: 'Cross-venture read.', evidence: 'src/server/work-api.ts:88',
    })]);

    const resolved = service!.resolveEscalation({
      escalationId: filed.escalations[0]!.id,
      resolution: 'Access check added and covered by a negative test.',
      resolvedByUserId: 'owner',
    });

    expect(resolved).toMatchObject({ status: 'resolved', resolvedByUserId: 'owner' });
    expect(database!.work.getCard(card.id)?.status).toBe('in_progress');
    expect(service!.listOpenEscalations()).toEqual([]);
  });

  it('REFUSES to resolve an escalation twice', () => {
    const { card, reviewerA } = seed();
    const filed = file(card.id, reviewerA.id, [finding({
      priority: 'P0', area: 'access', finding: 'No venture check.',
      predictedFailure: 'Cross-venture read.', evidence: 'src/server/work-api.ts:88',
    })]);
    service!.resolveEscalation({
      escalationId: filed.escalations[0]!.id, resolution: 'Fixed.', resolvedByUserId: 'owner',
    });

    expect(() => service!.resolveEscalation({
      escalationId: filed.escalations[0]!.id, resolution: 'Again.', resolvedByUserId: 'owner',
    })).toThrow(/already resolved/i);
  });

  it('lets a reviewer contest ONCE, and the re-ruling is final', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);
    const findingId = filed.review.findings[0]!.id;
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'overridden',
      reason: 'Harmless.', residualRisk: 'None.', ruledByOrgAgentId: builder.id,
    });

    service!.contestRuling({
      findingId, contestedByOrgAgentId: reviewerA.id,
      newEvidence: 'The write is not idempotent: src/server/run-repository.ts:204.',
    });
    const reRuled = service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'adopted',
      reason: 'The new evidence is right.', ruledByOrgAgentId: builder.id,
    });

    expect(reRuled.ruling.isFinal).toBe(true);
  });

  it('REFUSES a second contest from the same reviewer', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);
    const findingId = filed.review.findings[0]!.id;
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'overridden',
      reason: 'Harmless.', residualRisk: 'None.', ruledByOrgAgentId: builder.id,
    });
    service!.contestRuling({
      findingId, contestedByOrgAgentId: reviewerA.id, newEvidence: 'Evidence.',
    });

    // A reviewer may contest once, in writing, with new evidence. Once.
    expect(() => service!.contestRuling({
      findingId, contestedByOrgAgentId: reviewerA.id, newEvidence: 'More evidence.',
    })).toThrow(/already contested/i);
  });

  it('REFUSES a contest carrying no new evidence', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);
    const findingId = filed.review.findings[0]!.id;
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'overridden',
      reason: 'Harmless.', residualRisk: 'None.', ruledByOrgAgentId: builder.id,
    });

    expect(() => service!.contestRuling({
      findingId, contestedByOrgAgentId: reviewerA.id, newEvidence: '   ',
    })).toThrow(/new evidence/i);
  });

  it('REFUSES to reopen a finding once its ruling is final', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);
    const findingId = filed.review.findings[0]!.id;
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'overridden',
      reason: 'Harmless.', residualRisk: 'None.', ruledByOrgAgentId: builder.id,
    });
    service!.contestRuling({
      findingId, contestedByOrgAgentId: reviewerA.id, newEvidence: 'Evidence.',
    });
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'adopted',
      reason: 'Agreed.', ruledByOrgAgentId: builder.id,
    });

    // That ruling is final and is reported. There is no third round.
    expect(() => service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'overridden',
      reason: 'Changed my mind.', residualRisk: 'None.', ruledByOrgAgentId: builder.id,
    })).toThrow(/final/i);
  });

  it('REFUSES a ruling from anyone but the gate builder', () => {
    const { card, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);

    // The builder adjudicates. A reviewer ruling on its own finding would be
    // the reviewer marking its own homework, from the other direction.
    expect(() => service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId: filed.review.findings[0]!.id,
      outcome: 'adopted', reason: 'Naturally.', ruledByOrgAgentId: reviewerA.id,
    })).toThrow(/builder/i);
  });

  it('keeps every ruling, so a re-ruling does not erase the first', () => {
    const { card, builder, reviewerA, reviewerB } = seed();
    const filed = file(card.id, reviewerA.id, [finding()]);
    file(card.id, reviewerB.id);
    const findingId = filed.review.findings[0]!.id;
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'overridden',
      reason: 'Harmless.', residualRisk: 'None.', ruledByOrgAgentId: builder.id,
    });
    service!.contestRuling({
      findingId, contestedByOrgAgentId: reviewerA.id, newEvidence: 'Evidence.',
    });
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'adopted',
      reason: 'Agreed.', ruledByOrgAgentId: builder.id,
    });

    // A correction is a new entry, never an edit: what was ruled first is part
    // of the record of how the decision was reached.
    expect(service!.listRulings(findingId).map((r) => r.outcome))
      .toEqual(['overridden', 'adopted']);
  });
});
