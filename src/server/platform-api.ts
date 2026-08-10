import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PlatformEvent } from '../shared/platform.js';
import { createPlatformExportWorker } from './platform-export-worker.js';
import type { IdentityRepository } from './identity-repository.js';
import type { PlatformRepository } from './platform-repository.js';
import {
  createPortfolioSchema,
  createVentureSchema,
  decideApprovalSchema,
  idempotencyKeySchema,
  projectIntakeSchema,
} from './platform-schemas.js';
import { createPlatformService } from './platform-service.js';

export type ExportEvent = (event: PlatformEvent) => Promise<unknown>;
export type ExportFailureLogger = (failure: {
  eventId: string; eventType: string; attempts: number;
}) => void;

interface PlatformApiOptions {
  currentUserId: string;
  /**
   * Access is decided here, not by comparing strings. Without it the users table
   * and its venture grants are inert and §19's venture-scoped access is unenforced.
   */
  identity: IdentityRepository;
  exportEvent?: ExportEvent;
  logExportFailure?: ExportFailureLogger;
  exportDrainTimeoutMs?: number;
}

function requireVenture(repository: PlatformRepository, ventureId: string) {
  const venture = repository.getVenture(ventureId);
  if (!venture) throw new Error(`Venture not found: ${ventureId}`);
  return venture;
}

/**
 * A portfolio is the owner's own operating environment, so reaching it requires
 * being the owner — checked against the users table, so a disabled or unknown
 * actor is refused even if the stored owner string happens to match.
 */
function requireOwnedPortfolio(
  repository: PlatformRepository,
  identity: IdentityRepository,
  portfolioId: string,
  currentUserId: string,
) {
  const portfolio = repository.getPortfolio(portfolioId);
  if (!portfolio) throw new Error(`Portfolio not found: ${portfolioId}`);
  identity.assertRole(currentUserId, ['owner']);
  if (portfolio.ownerUserId !== currentUserId) {
    throw new Error('Trusted user does not own this portfolio');
  }
  return portfolio;
}

/** Venture reach: the owner sees every venture, everyone else only granted ones. */
function requireVentureAccess(
  repository: PlatformRepository,
  identity: IdentityRepository,
  ventureId: string,
  currentUserId: string,
) {
  const venture = requireVenture(repository, ventureId);
  identity.assertVentureAccess(currentUserId, venture.id);
  return venture;
}

export function registerPlatformApi(
  app: FastifyInstance,
  repository: PlatformRepository,
  options: PlatformApiOptions,
): void {
  const service = createPlatformService(repository, { currentUserId: options.currentUserId });
  const worker = options.exportEvent ? createPlatformExportWorker({
    repository,
    exportEvent: options.exportEvent,
    logFailure: options.logExportFailure,
    drainTimeoutMs: options.exportDrainTimeoutMs,
  }) : null;
  worker?.start({ includeDeferredFailures: true });
  app.addHook('onClose', async () => worker?.stop());

  app.put('/api/platform/portfolios/default', async (request) => {
    const input = request.body === undefined || request.body === null
      ? { name: 'AI Labs' }
      : createPortfolioSchema.parse(request.body);
    const portfolio = service.getOrCreateDefaultPortfolio(input.name);
    worker?.notify();
    return portfolio;
  });

  app.post('/api/platform/ventures', async (request, reply) => {
    const venture = service.createVenture(createVentureSchema.parse(request.body));
    worker?.notify();
    return await reply.code(201).send(venture);
  });

  app.get<{ Params: { portfolioId: string } }>(
    '/api/platform/portfolios/:portfolioId/ventures',
    async (request) => {
      requireOwnedPortfolio(repository, options.identity, request.params.portfolioId, options.currentUserId);
      return { ventures: repository.listVentures(request.params.portfolioId) };
    },
  );

  app.post('/api/platform/project-intakes', async (request, reply) => {
    const input = projectIntakeSchema.parse(request.body);
    const header = request.headers['idempotency-key'];
    const idempotencyKey = idempotencyKeySchema.parse(typeof header === 'string' ? header : undefined) ?? null;
    const result = service.createAndSubmitProject({ ...input, idempotencyKey });
    worker?.notify();
    return await reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.get<{ Params: { ventureId: string } }>(
    '/api/platform/ventures/:ventureId/projects',
    async (request) => {
      requireVentureAccess(repository, options.identity, request.params.ventureId, options.currentUserId);
      return { projects: repository.listProjects(request.params.ventureId) };
    },
  );

  app.post<{ Params: { approvalId: string } }>(
    '/api/platform/approvals/:approvalId/decision',
    async (request) => {
      const result = service.decideProjectApproval({
        approvalId: request.params.approvalId,
        ...decideApprovalSchema.parse(request.body),
      });
      worker?.notify();
      return result;
    },
  );

  app.get<{ Params: { portfolioId: string } }>(
    '/api/platform/portfolios/:portfolioId/executive-snapshot',
    async (request) => service.getExecutiveSnapshot(request.params.portfolioId),
  );

  app.get<{ Params: { portfolioId: string } }>(
    '/api/platform/portfolios/:portfolioId/export-status',
    async (request) => {
      requireOwnedPortfolio(repository, options.identity, request.params.portfolioId, options.currentUserId);
      return repository.getExportStatus(request.params.portfolioId);
    },
  );

  app.get<{ Params: { portfolioId: string }; Querystring: { limit?: string } }>(
    '/api/platform/portfolios/:portfolioId/events',
    async (request) => {
      requireOwnedPortfolio(repository, options.identity, request.params.portfolioId, options.currentUserId);
      return { events: repository.listEvents(
        request.params.portfolioId,
        z.coerce.number().int().min(1).max(200).default(30).parse(request.query.limit),
      ) };
    },
  );
}
