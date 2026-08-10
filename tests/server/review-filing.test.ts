import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';

describe('filing a review', () => {
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
    const agent = (name: string, runtimeId: string, model: string) =>
      database!.createOrgAgent({
        name, jobTitle: 'Specialist', department: 'Research',
        jobFunction: 'Does the work.', responsibilities: 'Work.', runtimeId, model,
      });
    const builder = agent('Builder', runtime('Runtime A', 'runtime-a').id, 'model-one');
    const reviewer = agent('Reviewer', runtime('Runtime B', 'runtime-b').id, 'model-two');
    const stranger = agent('Stranger', runtime('Runtime C', 'runtime-c').id, 'model-three');

    database.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    });
    database.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: reviewer.id,
    });
    return { card, builder, reviewer, stranger };
  }

  const checklist = [
    { item: 'Does it meet the acceptance criteria?', answer: 'Yes, on the synthetic fixture.' },
    { item: 'Are negative-access tests present?', answer: 'Not applicable at this gate.' },
  ];

  it('records a review with its findings', () => {
    const { card, reviewer } = seed();

    const review = database!.governance.fileReview({
      cardId: card.id,
      gateId: 'G1',
      reviewerOrgAgentId: reviewer.id,
      verdict: 'approve_with_findings',
      checklist,
      whatToPreserve: 'The deny-by-default posture on the access check.',
      questionsForBuilder: 'Why is the ceiling checked after the write rather than before?',
      findings: [{
        priority: 'P2',
        area: 'run-supervisor',
        finding: 'The cost ceiling is evaluated after the usage row is written.',
        predictedFailure: 'A run at 99% of ceiling writes one more update before stopping.',
        evidence: 'src/server/run-supervisor.ts:112',
        proposedFix: 'Evaluate the ceiling against the pending total before persisting.',
      }],
    });

    expect(review).toMatchObject({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewer.id,
      verdict: 'approve_with_findings',
    });
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({
      priority: 'P2', area: 'run-supervisor', evidence: 'src/server/run-supervisor.ts:112',
    });
    expect(database!.governance.listReviews(card.id, 'G1')).toHaveLength(1);
    expect(database!.governance.getReview(review.id)?.findings).toHaveLength(1);
  });

  it('accepts a clean review with no findings at all', () => {
    const { card, reviewer } = seed();

    const review = database!.governance.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewer.id,
      verdict: 'approve', checklist, whatToPreserve: '', questionsForBuilder: '', findings: [],
    });

    expect(review.verdict).toBe('approve');
    expect(review.findings).toEqual([]);
  });

  it('REFUSES a review from an agent that is not a reviewer on this gate', () => {
    const { card, stranger } = seed();

    expect(() => database!.governance.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: stranger.id,
      verdict: 'approve', checklist, whatToPreserve: '', questionsForBuilder: '', findings: [],
    })).toThrow(/not a reviewer/i);
    expect(database!.governance.listReviews(card.id, 'G1')).toEqual([]);
  });

  it('REFUSES a review from the builder, even at a gate it is assigned to', () => {
    const { card, builder } = seed();

    // The builder holds an assignment on this gate — as builder. That is not
    // a licence to file a review on its own work.
    expect(() => database!.governance.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: builder.id,
      verdict: 'approve', checklist, whatToPreserve: '', questionsForBuilder: '', findings: [],
    })).toThrow(/not a reviewer/i);
  });

  it('REFUSES a review with an empty checklist', () => {
    const { card, reviewer } = seed();

    // Every reviewer answers the full checklist. "Not applicable" is an
    // acceptable answer; silence is not (spec 20.3).
    expect(() => database!.governance.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewer.id,
      verdict: 'approve', checklist: [], whatToPreserve: '', questionsForBuilder: '', findings: [],
    })).toThrow(/checklist/i);
  });

  it('REFUSES a checklist item left blank, which is silence wearing an answer', () => {
    const { card, reviewer } = seed();

    expect(() => database!.governance.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewer.id,
      verdict: 'approve',
      checklist: [{ item: 'Are negative-access tests present?', answer: '   ' }],
      whatToPreserve: '', questionsForBuilder: '', findings: [],
    })).toThrow(/silence/i);
  });

  it('REFUSES a finding with no evidence to look at', () => {
    const { card, reviewer } = seed();

    // Evidence at file:line is what lets a reader go and check rather than
    // take the finding on trust.
    expect(() => database!.governance.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewer.id,
      verdict: 'approve_with_findings', checklist,
      whatToPreserve: '', questionsForBuilder: '',
      findings: [{
        priority: 'P2', area: 'somewhere', finding: 'Something feels wrong.',
        predictedFailure: 'It might break.', evidence: '', proposedFix: 'Look into it.',
      }],
    })).toThrow(/evidence/i);
  });

  it('REFUSES a finding with no predicted failure, which is a worry and not a finding', () => {
    const { card, reviewer } = seed();

    expect(() => database!.governance.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewer.id,
      verdict: 'approve_with_findings', checklist,
      whatToPreserve: '', questionsForBuilder: '',
      findings: [{
        priority: 'P1', area: 'run-supervisor', finding: 'This looks risky.',
        predictedFailure: '', evidence: 'src/server/run-supervisor.ts:112',
        proposedFix: 'Rewrite it.',
      }],
    })).toThrow(/predicted failure/i);
  });

  it('keeps each reviewer findings with their own review', () => {
    const { card, reviewer } = seed();
    const second = database!.createOrgAgent({
      name: 'Second reviewer', jobTitle: 'Specialist', department: 'Research',
      jobFunction: 'Reviews.', responsibilities: 'Review.',
      runtimeId: database!.createAgent({
        name: 'Runtime D', command: 'runtime-d', argsTemplate: ['{prompt}'],
        promptTransport: 'argument', outputFormat: 'text',
        versionArgs: ['--version'], timeoutMs: 120_000,
      }).id,
      model: 'model-four',
    });
    database!.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: second.id,
    });

    const first = database!.governance.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewer.id,
      verdict: 'approve', checklist, whatToPreserve: '', questionsForBuilder: '', findings: [],
    });
    const other = database!.governance.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: second.id,
      verdict: 'reject', checklist, whatToPreserve: '', questionsForBuilder: '',
      findings: [{
        priority: 'P0', area: 'access', finding: 'The route does not check venture access.',
        predictedFailure: 'A staff user reads another venture cards.',
        evidence: 'src/server/work-api.ts:88', proposedFix: 'Call assertVentureAccess first.',
      }],
    });

    expect(first.findings).toEqual([]);
    expect(other.findings).toHaveLength(1);
    expect(database!.governance.listReviews(card.id, 'G1')).toHaveLength(2);
  });

  it('does not mix a G1 review into G2', () => {
    const { card, reviewer } = seed();
    database!.governance.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewer.id,
      verdict: 'approve', checklist, whatToPreserve: '', questionsForBuilder: '', findings: [],
    });

    // A card does not pass G2 on G1's reviews.
    expect(database!.governance.listReviews(card.id, 'G2')).toEqual([]);
  });
});
