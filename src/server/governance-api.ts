import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { OrchestratorDatabase } from './database.js';
import { createGovernanceService } from './governance-service.js';
import type { GateId } from '../shared/work.js';

const gateIdSchema = z.enum(['G1', 'G2', 'G3', 'G4']);

const checklistAnswerSchema = z.object({
  item: z.string().trim().min(1).max(500),
  answer: z.string().max(5_000),
});

const findingInputSchema = z.object({
  priority: z.enum(['P0', 'P1', 'P2', 'P3', 'P4']),
  area: z.string().trim().min(1).max(200),
  finding: z.string().trim().min(1).max(5_000),
  predictedFailure: z.string().max(5_000),
  evidence: z.string().max(2_000),
  proposedFix: z.string().max(5_000),
});

const fileReviewSchema = z.object({
  reviewerOrgAgentId: z.string().trim().min(1),
  verdict: z.enum(['approve', 'approve_with_findings', 'reject']),
  checklist: z.array(checklistAnswerSchema).max(100),
  whatToPreserve: z.string().max(20_000),
  questionsForBuilder: z.string().max(20_000),
  findings: z.array(findingInputSchema).max(50),
});

const adjudicateSchema = z.object({
  cardId: z.string().trim().min(1),
  gateId: gateIdSchema,
  outcome: z.enum(['adopted', 'deferred', 'overridden']),
  reason: z.string().trim().min(1).max(5_000),
  nextStep: z.string().trim().max(2_000).optional(),
  residualRisk: z.string().trim().max(2_000).optional(),
  deferredUntil: z.string().trim().max(40).optional(),
  ruledByOrgAgentId: z.string().trim().min(1),
});

const contestSchema = z.object({
  contestedByOrgAgentId: z.string().trim().min(1),
  newEvidence: z.string().trim().min(1).max(5_000),
});

const resolveSchema = z.object({ resolution: z.string().trim().min(1).max(2_000) });

export interface GovernanceApiOptions {
  /** The trusted actor, resolved server-side. No request body may supply it. */
  currentUserId: string;
}

export function registerGovernanceApi(
  app: FastifyInstance,
  database: OrchestratorDatabase,
  options: GovernanceApiOptions,
): void {
  const { currentUserId } = options;
  const governanceService = createGovernanceService(database);

  /**
   * Every route that names a card passes through here first.
   *
   * `getGateSealState` reaches `requiredReviewersFor`, which throws
   * `Card not found: ${cardId}` for an unknown card — a message the error
   * handler does not map to 403, so it would 500 instead of matching the
   * answer an inaccessible card gives. Running this first, and throwing
   * `Access denied` for both an unknown card and one this actor cannot reach,
   * is what keeps the two indistinguishable: the API is not a way to
   * discover which cards exist.
   */
  const requireCard = (cardId: string) => {
    const card = database.work.getCard(cardId);
    if (!card) throw new Error(`Access denied: card ${cardId}`);
    const project = database.platform.getProject(card.projectId);
    if (!project) throw new Error(`Access denied: card ${cardId}`);
    database.identity.assertVentureAccess(currentUserId, project.ventureId);
    return card;
  };

  app.get<{ Params: { cardId: string; gateId: string } }>(
    '/api/cards/:cardId/gates/:gateId/review-state',
    async (request) => {
      const card = requireCard(request.params.cardId);
      const gateId = gateIdSchema.parse(request.params.gateId) as GateId;
      const seal = database.governance.getGateSealState(card.id, gateId);
      /*
       * The viewer role (owner / builder / reviewer) is derived inside
       * listVisibleReviews from the viewer id alone, never accepted as a
       * parameter here — a route that let a caller assert its own role would
       * let a reviewer read a sealed review by claiming to be the owner.
       */
      const visibleReviews = database.governance.listVisibleReviews(card.id, gateId, currentUserId);
      return { ...seal, visibleReviews };
    },
  );

  app.get<{ Params: { cardId: string; gateId: string } }>(
    '/api/cards/:cardId/gates/:gateId/assignments',
    async (request) => {
      const card = requireCard(request.params.cardId);
      const gateId = gateIdSchema.parse(request.params.gateId) as GateId;
      return { assignments: database.governance.listAssignments(card.id, gateId) };
    },
  );

  app.get<{ Params: { cardId: string } }>('/api/cards/:cardId/specification', async (request) => {
    const card = requireCard(request.params.cardId);
    return database.governance.getSpecification(card.id);
  });

  app.get<{ Params: { cardId: string } }>('/api/cards/:cardId/handover', async (request) => {
    const card = requireCard(request.params.cardId);
    return database.governance.getHandover(card.id);
  });

  app.get<{ Querystring: { cardId?: string } }>('/api/escalations', async (request) => {
    const { cardId } = request.query;
    if (cardId) requireCard(cardId);
    return { escalations: governanceService.listOpenEscalations(cardId) };
  });

  app.get<{ Querystring: { cardId?: string } }>('/api/override-register', async (request) => {
    const { cardId } = request.query;
    if (cardId) requireCard(cardId);
    return { entries: database.governance.listOverrides({ cardId }) };
  });

  app.get<{ Params: { date: string } }>(
    '/api/adjudication-reports/:date',
    async (request) => database.governance.getAdjudicationReport(request.params.date),
  );

  app.post<{ Params: { cardId: string; gateId: string } }>(
    '/api/cards/:cardId/gates/:gateId/reviews',
    async (request, reply) => {
      const card = requireCard(request.params.cardId);
      const gateId = gateIdSchema.parse(request.params.gateId) as GateId;
      const input = fileReviewSchema.parse(request.body);
      /*
       * reviewerOrgAgentId names which org agent is filing the review; it is
       * not the connected actor. There is no "current org agent" resolved
       * server-side the way currentUserId resolves the human actor, so this
       * has to come from the body — the service refuses it outright unless
       * it genuinely holds a reviewer assignment on this card at this gate.
       */
      const result = governanceService.fileReview({ cardId: card.id, gateId, ...input });
      return await reply.code(201).send(result);
    },
  );

  app.post<{ Params: { findingId: string } }>(
    '/api/findings/:findingId/adjudicate',
    async (request) => {
      const input = adjudicateSchema.parse(request.body);
      // ruledByOrgAgentId is the builder org agent ruling on the finding, not
      // the connected actor — the same reasoning as reviewerOrgAgentId above.
      return governanceService.adjudicate({
        ...input,
        gateId: input.gateId as GateId,
        findingId: request.params.findingId,
      });
    },
  );

  app.post<{ Params: { findingId: string } }>(
    '/api/findings/:findingId/contest',
    async (request) => {
      const input = contestSchema.parse(request.body);
      // contestedByOrgAgentId is the reviewer contesting the ruling, not the
      // connected actor — the same reasoning as reviewerOrgAgentId above.
      return governanceService.contestRuling({
        ...input,
        findingId: request.params.findingId,
      });
    },
  );

  app.post<{ Params: { escalationId: string } }>(
    '/api/escalations/:escalationId/resolve',
    async (request) => {
      const input = resolveSchema.parse(request.body);
      /*
       * resolvedByUserId comes from the resolved actor, never from the body.
       * A body that carries one is not rejected — it is ignored, because the
       * schema above does not read it, which is the same outcome with one
       * fewer branch to get wrong.
       */
      return governanceService.resolveEscalation({
        escalationId: request.params.escalationId,
        resolution: input.resolution,
        resolvedByUserId: currentUserId,
      });
    },
  );
}
