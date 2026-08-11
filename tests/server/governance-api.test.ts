import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { createGovernanceService } from '../../src/server/governance-service.js';
import type { FastifyInstance } from 'fastify';

describe('the governance API', () => {
  let database: OrchestratorDatabase | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close(); app = undefined;
    database?.close(); database = undefined;
  });

  const checklist = [{ item: 'Does it meet the acceptance criteria?', answer: 'Yes.' }];

  /** A portfolio, venture and project, following the seed() shape in work-api.test.ts. */
  function seedProject(reviewerCountOverride?: number) {
    const portfolio = database!.platform.createPortfolio({ name: 'Sample Portfolio', ownerUserId: 'owner' });
    const venture = database!.platform.createVenture({
      portfolioId: portfolio.id, name: 'Sample Venture', kind: 'research', mission: 'Evaluate tools.',
    });
    return database!.platform.createProject({
      ventureId: venture.id, name: 'Sample Project', objective: 'Compare services.',
      successCriteria: ['A sourced comparison is approved'], reviewerCountOverride,
    });
  }

  const makeAgent = (name: string, model: string) => database!.createOrgAgent({
    name, jobTitle: 'Specialist', department: 'Research',
    jobFunction: 'Does the work.', responsibilities: 'Work.',
    runtimeId: database!.createAgent({
      name: `Runtime ${model}`, command: `runtime-${model}`, argsTemplate: ['{prompt}'],
      promptTransport: 'argument', outputFormat: 'text',
      versionArgs: ['--version'], timeoutMs: 120_000,
    }).id,
    model,
  });

  /** A card at G1 needing two reviewers, with one of the two filed. */
  function seedHalfFiledGate() {
    database = createDatabase(':memory:');
    const project = seedProject(2);
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
    const reviewerA = makeAgent('Reviewer A', 'model-two');
    const reviewerB = makeAgent('Reviewer B', 'model-three');
    database.governance.assignRole({ cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: reviewerA.id });
    database.governance.assignRole({ cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: reviewerB.id });
    database.governance.insertReviewRecord({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewerA.id,
      verdict: 'approve', checklist, whatToPreserve: '', questionsForBuilder: '', findings: [],
    });
    app = buildApp({ database, invoke: async () => 'unused', currentUserId: 'owner' });
    return { cardId: card.id };
  }

  /** A card with a P0 finding filed, so it carries one open escalation. */
  function seedOpenEscalation() {
    database = createDatabase(':memory:');
    const service = createGovernanceService(database);
    const project = seedProject();
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
    const builder = makeAgent('Builder', 'model-one');
    const reviewer = makeAgent('Reviewer', 'model-two');
    database.governance.assignRole({ cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id });
    database.governance.assignRole({ cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: reviewer.id });
    const filed = service.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewer.id,
      verdict: 'reject', checklist, whatToPreserve: '', questionsForBuilder: '',
      findings: [{
        priority: 'P0', area: 'access',
        finding: 'The route does not check venture access.',
        predictedFailure: 'A staff user reads another venture cards.',
        evidence: 'src/server/example-module.ts:1', proposedFix: 'Call assertVentureAccess first.',
      }],
    });
    app = buildApp({ database, invoke: async () => 'unused', currentUserId: 'owner' });
    return { escalationId: filed.escalations[0]!.id };
  }

  /** A card with one override entry, corrected by a second that supersedes it. */
  function seedSupersededOverride() {
    database = createDatabase(':memory:');
    const service = createGovernanceService(database);
    const project = seedProject();
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
    const builder = makeAgent('Builder', 'model-one');
    const reviewer = makeAgent('Reviewer', 'model-two');
    database.governance.assignRole({ cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id });
    database.governance.assignRole({ cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: reviewer.id });
    const filed = service.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewer.id,
      verdict: 'approve_with_findings', checklist, whatToPreserve: '', questionsForBuilder: '',
      findings: [{
        priority: 'P2', area: 'run-supervisor',
        finding: 'The cost ceiling is evaluated after the usage row is written.',
        predictedFailure: 'A run at 99% of ceiling writes one more update.',
        evidence: 'src/server/example-module.ts:112', proposedFix: 'Evaluate the ceiling before persisting.',
      }],
    });
    const ruled = service.adjudicate({
      cardId: card.id, gateId: 'G1', findingId: filed.review.findings[0]!.id,
      outcome: 'overridden', reason: 'The write is idempotent.', residualRisk: 'One redundant row.',
      ruledByOrgAgentId: builder.id,
    });
    database.governance.supersedeOverride({
      supersedesId: ruled.registerEntry!.id, reason: 'The write is not idempotent after all.',
      residualRisk: 'A duplicate row on every stopped run.', createdByOrgAgentId: builder.id,
    });
    app = buildApp({ database, invoke: async () => 'unused', currentUserId: 'owner' });
    return { cardId: card.id };
  }

  /**
   * A card with a filed, unruled P2 finding, reachable through the app only
   * by an outsider actor with no grant on its venture — everything the
   * adjudicate/contest access tests need, including a real findingId that
   * the service could otherwise act on.
   */
  function seedFindingInInaccessibleVenture() {
    database = createDatabase(':memory:');
    const service = createGovernanceService(database);
    const project = seedProject();
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
    const builder = makeAgent('Builder', 'model-one');
    const reviewer = makeAgent('Reviewer', 'model-two');
    database.governance.assignRole({ cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id });
    database.governance.assignRole({ cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: reviewer.id });
    const filed = service.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewer.id,
      verdict: 'approve_with_findings', checklist, whatToPreserve: '', questionsForBuilder: '',
      findings: [{
        priority: 'P2', area: 'run-supervisor',
        finding: 'The cost ceiling is evaluated after the usage row is written.',
        predictedFailure: 'A run at 99% of ceiling writes one more update.',
        evidence: 'src/server/example-module.ts:112', proposedFix: 'Evaluate the ceiling before persisting.',
      }],
    });
    // A real user of this platform, with no grant on this project's venture —
    // the same fixture shape work-api.test.ts uses for its access-denial test.
    const outsider = database.identity.createUser({ displayName: 'Outsider', role: 'staff' });
    app = buildApp({ database, invoke: async () => 'unused', currentUserId: outsider.id });
    return {
      gateId: 'G1' as const,
      findingId: filed.review.findings[0]!.id,
      builderId: builder.id,
      reviewerId: reviewer.id,
    };
  }

  it('returns the seal state, with its reason, for a half-filed gate', async () => {
    const { cardId } = seedHalfFiledGate();
    const response = await app!.inject({
      method: 'GET', url: `/api/cards/${cardId}/gates/G1/review-state`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.sealed).toBe(true);
    expect(body.sealReason).toBe('1 of 2 reviewers have filed.');
    // The owner reads every review; the seal is a fact about the gate.
    expect(body.visibleReviews).toHaveLength(1);
  });

  it('gives an unknown card the same answer as an inaccessible one', async () => {
    seedHalfFiledGate();
    const unknown = await app!.inject({
      method: 'GET', url: '/api/cards/card-does-not-exist/gates/G1/review-state',
    });
    // The app's error handler maps any message starting "Access denied:" to 403
    // with the body { error }. Throwing `Access denied: card <id>` for a card
    // that does not exist is what makes the two indistinguishable.
    expect(unknown.statusCode).toBe(403);
    expect(unknown.json().error).toContain('Access denied');
  });

  it('ignores an actor id supplied in the body and uses the resolved actor', async () => {
    const { escalationId } = seedOpenEscalation();
    const response = await app!.inject({
      method: 'POST',
      url: `/api/escalations/${escalationId}/resolve`,
      payload: { resolution: 'Fixed at source.', resolvedByUserId: 'somebody-else' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().resolvedByUserId).toBe('owner');
  });

  it('lists the override register with superseded entries marked', async () => {
    const { cardId } = seedSupersededOverride();
    const response = await app!.inject({
      method: 'GET', url: `/api/override-register?cardId=${cardId}`,
    });
    const entries = response.json().entries as Array<{ supersededById: string | null }>;
    expect(entries.some((entry) => entry.supersededById !== null)).toBe(true);
  });

  it('REFUSES to adjudicate a finding on a card in a venture the actor cannot reach', async () => {
    const { gateId, findingId, builderId } = seedFindingInInaccessibleVenture();

    const response = await app!.inject({
      method: 'POST',
      url: `/api/findings/${findingId}/adjudicate`,
      payload: { gateId, outcome: 'adopted', reason: 'Fine.', ruledByOrgAgentId: builderId },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain('Access denied');
  });

  it('REFUSES to contest a finding on a card in a venture the actor cannot reach', async () => {
    const { findingId, reviewerId } = seedFindingInInaccessibleVenture();

    const response = await app!.inject({
      method: 'POST',
      url: `/api/findings/${findingId}/contest`,
      payload: { contestedByOrgAgentId: reviewerId, newEvidence: 'It is not harmless.' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain('Access denied');
  });

  it('gives an unknown finding id the same response as an inaccessible one', async () => {
    const { gateId, findingId, builderId } = seedFindingInInaccessibleVenture();
    const payload = { gateId, outcome: 'adopted', reason: 'Fine.', ruledByOrgAgentId: builderId };

    const inaccessible = await app!.inject({
      method: 'POST', url: `/api/findings/${findingId}/adjudicate`, payload,
    });
    const unknown = await app!.inject({
      method: 'POST', url: '/api/findings/finding-does-not-exist/adjudicate', payload,
    });

    // Both refuse with the same shape: 403, "Access denied: finding <id>".
    // Neither response says "card" — that wording is exactly what would let
    // a caller tell "no such finding" apart from "finding exists, wrong
    // venture", which is what would let the API be used to discover which
    // findings exist.
    expect(unknown.statusCode).toBe(403);
    expect(inaccessible.statusCode).toBe(403);
    expect(unknown.json().error).toMatch(/^Access denied: finding /);
    expect(inaccessible.json().error).toMatch(/^Access denied: finding /);
  });
});
