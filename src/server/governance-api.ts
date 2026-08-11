import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { OrchestratorDatabase } from './database.js';
import { createGovernanceService } from './governance-service.js';
import { hasVentureAccess } from '../shared/identity.js';
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
    /*
     * assertVentureAccess's own message names the actor and the venture —
     * `Access denied: u-7 may not reach venture v-3` — and left unwrapped it
     * reads differently from the unknown-card branch above. Same 403 either
     * way, but different bodies, and a caller comparing them can tell "no
     * such card" from "that card exists, and here is its venture id", which
     * is exactly the oracle deny-by-default exists to close.
     */
    try {
      database.identity.assertVentureAccess(currentUserId, project.ventureId);
    } catch {
      throw new Error(`Access denied: card ${cardId}`);
    }
    return card;
  };

  /**
   * The same check as requireCard, one entity up the chain, for a route
   * keyed by a finding id rather than a card id. An unknown finding and a
   * real one whose card this actor cannot reach must read identically — not
   * just the same status, the same message — or the wording of the refusal
   * becomes a way to tell "no such finding" from "finding exists, wrong
   * venture", which is exactly what discovers which findings exist.
   */
  const requireFindingCard = (findingId: string): string => {
    const cardId = database.governance.getFindingCardId(findingId);
    if (!cardId) throw new Error(`Access denied: finding ${findingId}`);
    try {
      requireCard(cardId);
    } catch {
      throw new Error(`Access denied: finding ${findingId}`);
    }
    return cardId;
  };

  /** The same shape as requireFindingCard, for a route keyed by an escalation id. */
  const requireEscalationCard = (escalationId: string): string => {
    const cardId = governanceService.getEscalationCardId(escalationId);
    if (!cardId) throw new Error(`Access denied: escalation ${escalationId}`);
    try {
      requireCard(cardId);
    } catch {
      throw new Error(`Access denied: escalation ${escalationId}`);
    }
    return cardId;
  };

  /**
   * The daily adjudication report is an owner-facing document, not a
   * per-venture one — it aggregates P0s, overrides and cost across every
   * venture by design (spec 20.4.5's "goes to the owner", generalized to the
   * whole ledger). Gated on role alone, the same check resolveEscalation
   * already relies on. Unlike a venture check, there is nothing case-by-case
   * to distinguish here — "you are not the owner" is the same answer for
   * every non-owner — so the message does not name the actor.
   */
  const requireOwner = (): void => {
    if (database.identity.getUser(currentUserId)?.role !== 'owner') {
      throw new Error('Access denied: this report is available to the owner only');
    }
  };

  /** The venture a card belongs to, or null if the card or its project is gone. */
  const ventureIdForCard = (cardId: string): string | null => {
    const card = database.work.getCard(cardId);
    if (!card) return null;
    return database.platform.getProject(card.projectId)?.ventureId ?? null;
  };

  /**
   * Scopes a list of card-linked records to what this actor may reach.
   * listAccessibleVentureIds alone is not enough: it holds only explicit
   * grants, and the owner reaches every venture without one
   * (hasVentureAccess's own rule) — filtering by grants alone would show the
   * owner nothing. Reusing hasVentureAccess rather than re-deriving its
   * owner/enabled branches here is the same reason getFindingCardId exists:
   * one place decides the rule, everywhere else reads the answer. An entry
   * with no resolvable card (a null cardId, or one pointing at nothing) is
   * denied by default rather than shown to a non-owner with no venture to
   * check it against.
   */
  const scopeToAccessibleVentures = <T extends { cardId: string | null }>(entries: T[]): T[] => {
    const user = database.identity.getUser(currentUserId);
    if (!user) return [];
    const granted = database.identity.listAccessibleVentureIds(currentUserId);
    return entries.filter((entry) => {
      if (!entry.cardId) return false;
      const ventureId = ventureIdForCard(entry.cardId);
      return ventureId !== null && hasVentureAccess(user, ventureId, granted);
    });
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
    // Naming a card scopes to it and is checked the ordinary way. Omitting
    // one asks for everything, so it is scoped to every venture this actor
    // can reach instead — the platform-wide list is for the owner alone.
    if (cardId) requireCard(cardId);
    const escalations = governanceService.listOpenEscalations(cardId);
    return { escalations: cardId ? escalations : scopeToAccessibleVentures(escalations) };
  });

  app.get<{ Querystring: { cardId?: string } }>('/api/override-register', async (request) => {
    const { cardId } = request.query;
    if (cardId) requireCard(cardId);
    const entries = database.governance.listOverrides({ cardId });
    return { entries: cardId ? entries : scopeToAccessibleVentures(entries) };
  });

  app.get<{ Params: { date: string } }>(
    '/api/adjudication-reports/:date',
    async (request) => {
      requireOwner();
      return database.governance.getAdjudicationReport(request.params.date);
    },
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
      /*
       * cardId is resolved from the finding, not read from the body: the
       * body no longer carries one at all. Accepting a client-supplied
       * cardId here would let it diverge from the finding actually being
       * ruled on — the access check would verify one card while adjudicate
       * looked up the builder on whatever card the client named instead.
       */
      const cardId = requireFindingCard(request.params.findingId);
      const input = adjudicateSchema.parse(request.body);
      // ruledByOrgAgentId is the builder org agent ruling on the finding, not
      // the connected actor — the same reasoning as reviewerOrgAgentId above.
      return governanceService.adjudicate({
        ...input,
        gateId: input.gateId as GateId,
        cardId,
        findingId: request.params.findingId,
      });
    },
  );

  app.post<{ Params: { findingId: string } }>(
    '/api/findings/:findingId/contest',
    async (request) => {
      requireFindingCard(request.params.findingId);
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
      requireEscalationCard(request.params.escalationId);
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
