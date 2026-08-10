import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { OrchestratorDatabase } from './database.js';
import { canAdvance, deriveColumns, getLadder } from './gate-policy.js';
import type { RunSupervisor } from './run-supervisor.js';
import { CARD_PRIORITIES, CARD_STATUSES, type BoardColumnKey } from '../shared/work.js';

const columnKeySchema = z.union([
  z.enum(CARD_STATUSES.filter((status) => status !== 'review') as unknown as [string, ...string[]]),
  z.enum(['G1', 'G2', 'G3', 'G4']),
]);

const createCardSchema = z.object({
  projectId: z.string().trim().min(1),
  title: z.string().trim().min(1).max(300),
  description: z.string().trim().max(20_000).optional(),
  priority: z.enum(CARD_PRIORITIES).optional(),
  parentCardId: z.string().trim().min(1).nullable().optional(),
});

const updateCardSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().trim().max(20_000).optional(),
  priority: z.enum(CARD_PRIORITIES).optional(),
});

const notesSchema = z.object({ notes: z.string().max(50_000) });
const assignSchema = z.object({ orgAgentId: z.string().trim().min(1).nullable() });
const moveSchema = z.object({ to: columnKeySchema, position: z.number().int().min(0) });
const startRunSchema = z.object({
  orgAgentId: z.string().trim().min(1),
  message: z.string().trim().min(1).max(50_000),
  costCeilingTokens: z.number().int().positive().nullable().optional(),
});
const answerSchema = z.object({ optionId: z.string().trim().min(1).max(200) });
const canvasSchema = z.object({ content: z.string().max(500_000) });
const artifactSchema = z.object({
  runId: z.string().trim().min(1).nullable(),
  kind: z.enum(['file', 'diff', 'link', 'report']),
  label: z.string().trim().min(1).max(300),
  location: z.string().trim().min(1).max(2000),
});

export interface WorkApiOptions {
  /**
   * The trusted actor, resolved server-side. No request body may supply it —
   * that is what stops an actor being spoofed, and it is why every handler
   * below reads this rather than anything from the request.
   */
  currentUserId: string;
  supervisor?: RunSupervisor;
}

export function registerWorkApi(
  app: FastifyInstance,
  database: OrchestratorDatabase,
  options: WorkApiOptions,
): void {
  const { currentUserId } = options;

  /** Every route passes through here before it touches a card. */
  const assertProjectAccess = (projectId: string): void => {
    const project = database.platform.getProject(projectId);
    if (!project) throw new Error(`Access denied: project ${projectId}`);
    database.identity.assertVentureAccess(currentUserId, project.ventureId);
  };

  const requireCard = (cardId: string) => {
    const card = database.work.getCard(cardId);
    // An unknown card and an inaccessible one give the same answer, so the API
    // cannot be used to discover which cards exist.
    if (!card) throw new Error(`Access denied: card ${cardId}`);
    assertProjectAccess(card.projectId);
    return card;
  };

  const ladderFor = (projectId: string) =>
    getLadder(database.platform.getProject(projectId)?.gateLadderId ?? 'product');

  app.post('/api/cards', async (request, reply) => {
    const input = createCardSchema.parse(request.body);
    assertProjectAccess(input.projectId);
    const card = database.work.createCard({ ...input, userId: currentUserId });
    // A card always has somewhere to talk about it. Creating the room later,
    // by hand, is how cards end up with conversations that live nowhere.
    const room = database.rooms.createRoomForCard({ cardId: card.id, title: card.title });
    return await reply.code(201).send({ card, room });
  });

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/cards',
    async (request) => {
      assertProjectAccess(request.params.projectId);
      const ladder = ladderFor(request.params.projectId);
      return {
        ladder,
        columns: deriveColumns(ladder),
        cards: database.work.listCards(request.params.projectId),
      };
    },
  );

  app.get<{ Params: { cardId: string } }>('/api/cards/:cardId', async (request) => {
    const card = requireCard(request.params.cardId);
    return {
      card,
      room: database.rooms.getRoomForCard(card.id),
      activity: database.work.listActivity(card.id),
      artifacts: database.work.listArtifacts(card.id),
      runs: database.runs.listRunsForCard(card.id),
    };
  });

  app.patch<{ Params: { cardId: string } }>('/api/cards/:cardId', async (request) => {
    requireCard(request.params.cardId);
    return database.work.updateCard(request.params.cardId, updateCardSchema.parse(request.body));
  });

  app.put<{ Params: { cardId: string } }>('/api/cards/:cardId/notes', async (request) => {
    requireCard(request.params.cardId);
    const { notes } = notesSchema.parse(request.body);
    // The actor is this connection's user, never a body field: the owner's
    // notes are the one place an agent must not be able to write as a person.
    return database.work.setOwnerNotes({
      cardId: request.params.cardId, notes, userId: currentUserId,
    });
  });

  app.post<{ Params: { cardId: string } }>('/api/cards/:cardId/assign', async (request) => {
    requireCard(request.params.cardId);
    const { orgAgentId } = assignSchema.parse(request.body);
    return database.work.updateCard(request.params.cardId, { assigneeOrgAgentId: orgAgentId });
  });

  app.post<{ Params: { cardId: string } }>('/api/cards/:cardId/move', async (request) => {
    const card = requireCard(request.params.cardId);
    const { to, position } = moveSchema.parse(request.body);
    const verdict = canAdvance({
      card,
      ladder: ladderFor(card.projectId),
      to: to as BoardColumnKey,
      evidence: {
        reviewsFiled: 0,
        ownerDecision: false,
        artifactCount: database.work.listArtifacts(card.id).length,
        missingSpecificationSections: database.governance.missingSpecificationSections(card.id),
        missingHandoverPoints: database.governance.missingHandoverPoints(card.id),
      },
    });
    // The gate is enforced here, not in the client. A board that only checks in
    // the browser is a board with no gates.
    if (!verdict.allowed) throw new Error(`Gate refused the move: ${verdict.reason}`);
    return database.work.moveCard({
      cardId: card.id, to: to as BoardColumnKey, position, userId: currentUserId,
    });
  });

  app.post<{ Params: { cardId: string } }>('/api/cards/:cardId/artifacts', async (request, reply) => {
    const card = requireCard(request.params.cardId);
    const input = artifactSchema.parse(request.body);
    return await reply.code(201).send(database.work.attachArtifact({ ...input, cardId: card.id }));
  });

  app.post<{ Params: { cardId: string } }>('/api/cards/:cardId/runs', async (request, reply) => {
    const card = requireCard(request.params.cardId);
    if (!options.supervisor) throw new Error('Runs are not available: no supervisor is configured');
    const input = startRunSchema.parse(request.body);
    const run = await options.supervisor.startRun({ cardId: card.id, ...input });
    // Returns as soon as the run is recorded. The turn continues without it.
    return await reply.code(202).send(run);
  });

  app.get<{ Params: { runId: string } }>('/api/runs/:runId', async (request) => {
    const run = database.runs.getRun(request.params.runId);
    if (!run) throw new Error(`Access denied: run ${request.params.runId}`);
    requireCard(run.cardId);
    return {
      run,
      updates: database.runs.listUpdates(run.id),
      permissions: database.runs.listPermissions(run.id),
    };
  });

  app.post<{ Params: { runId: string } }>('/api/runs/:runId/cancel', async (request, reply) => {
    const run = database.runs.getRun(request.params.runId);
    if (!run) throw new Error(`Access denied: run ${request.params.runId}`);
    requireCard(run.cardId);
    if (!options.supervisor) throw new Error('Runs are not available: no supervisor is configured');
    await options.supervisor.cancelRun(run.id);
    return await reply.code(202).send({ runId: run.id });
  });

  app.post<{ Params: { requestId: string } }>(
    '/api/permissions/:requestId/answer',
    async (request) => {
      const record = database.runs.getPermission(request.params.requestId);
      if (!record) throw new Error(`Access denied: permission ${request.params.requestId}`);
      const run = database.runs.getRun(record.runId);
      if (!run) throw new Error(`Access denied: permission ${request.params.requestId}`);
      requireCard(run.cardId);
      if (!options.supervisor) throw new Error('Runs are not available: no supervisor is configured');
      const { optionId } = answerSchema.parse(request.body);
      return await options.supervisor.answerPermission({
        requestId: record.id, optionId, userId: currentUserId,
      });
    },
  );

  app.get<{ Params: { roomId: string } }>('/api/rooms/:roomId/messages', async (request) => {
    const room = database.rooms.getRoom(request.params.roomId);
    if (!room) throw new Error(`Access denied: room ${request.params.roomId}`);
    requireCard(room.cardId);
    return { room, threads: database.rooms.listMessages(room.id), members: database.rooms.listMembers(room.id) };
  });

  app.put<{ Params: { roomId: string } }>('/api/rooms/:roomId/canvas', async (request) => {
    const room = database.rooms.getRoom(request.params.roomId);
    if (!room) throw new Error(`Access denied: room ${request.params.roomId}`);
    requireCard(room.cardId);
    const { content } = canvasSchema.parse(request.body);
    return database.rooms.setCanvas({ roomId: room.id, content });
  });
}
