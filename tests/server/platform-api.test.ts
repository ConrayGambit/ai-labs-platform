import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { createPlatformService } from '../../src/server/platform-service.js';

describe('governed platform API', () => {
  let database: OrchestratorDatabase | undefined;
  const additionalDatabases: OrchestratorDatabase[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    database?.close();
    database = undefined;
    additionalDatabases.splice(0).forEach((item) => item.close());
    temporaryDirectories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
  });

  it('enforces the project approval lifecycle and exports its resulting audit events', async () => {
    database = createDatabase(':memory:');
    const exportedTypes: string[] = [];
    const app = buildApp({
      database,
      invoke: async ({ runtime }) => `response from ${runtime.id}`,
      exportEvent: async (event) => {
        exportedTypes.push(event.type);
      },
    });

    const portfolioResponse = await app.inject({
      method: 'PUT',
      url: '/api/platform/portfolios/default',
    });
    expect(portfolioResponse.statusCode).toBe(200);
    const portfolio = portfolioResponse.json<{ id: string }>();

    const ventureResponse = await app.inject({
      method: 'POST',
      url: '/api/platform/ventures',
      payload: {
        portfolioId: portfolio.id,
        name: 'Platform SaaS',
        kind: 'saas',
        mission: 'Build a governed platform.',
      },
    });
    expect(ventureResponse.statusCode).toBe(201);
    const venture = ventureResponse.json<{ id: string }>();

    const submissionResponse = await app.inject({
      method: 'POST',
      url: '/api/platform/project-intakes',
      headers: { 'idempotency-key': 'foundation-api' },
      payload: {
        ventureId: venture.id,
        name: 'Foundation API',
        objective: 'Expose governed platform operations.',
        successCriteria: ['Lifecycle remains approval controlled.'],
        constraints: ['SQLite stays authoritative.'],
        summary: 'Approve the foundation API plan.',
      },
    });
    expect(submissionResponse.statusCode).toBe(201);
    const submission = submissionResponse.json<{
      project: { lifecycle: string };
      approval: { id: string; status: string };
    }>();
    expect(submission.project.lifecycle).toBe('pending_approval');
    expect(submission.approval.status).toBe('pending');

    const decisionResponse = await app.inject({
      method: 'POST',
      url: `/api/platform/approvals/${submission.approval.id}/decision`,
      payload: { status: 'approved', decisionNote: 'Proceed' },
    });
    expect(decisionResponse.statusCode).toBe(200);
    expect(decisionResponse.json<{ project: { lifecycle: string } }>().project.lifecycle).toBe('active');

    const snapshotResponse = await app.inject({
      method: 'GET',
      url: `/api/platform/portfolios/${portfolio.id}/executive-snapshot`,
    });
    expect(snapshotResponse.statusCode).toBe(200);
    expect(snapshotResponse.json<{
      projectsByLifecycle: { active: number };
      pendingApprovals: unknown[];
    }>()).toMatchObject({ projectsByLifecycle: { active: 1 }, pendingApprovals: [] });

    await vi.waitFor(() => {
      expect(exportedTypes).toEqual(expect.arrayContaining([
        'PortfolioCreated',
        'VentureCreated',
        'ProjectCreated',
        'ProjectPlanSubmitted',
        'ProjectActivated',
      ]));
    });
    await app.close();
  });

  it('keeps a successful SQLite mutation when the Markdown mirror rejects', async () => {
    database = createDatabase(':memory:');
    const app = buildApp({
      database,
      invoke: async ({ runtime }) => `response from ${runtime.id}`,
      exportEvent: async () => Promise.reject(new Error('vault unavailable')),
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/platform/portfolios/default',
      payload: { name: 'Durable AI Labs' },
    });

    expect(response.statusCode).toBe(200);
    expect(database.platform.getPortfolio(response.json<{ id: string }>().id)).toMatchObject({
      name: 'Durable AI Labs',
    });
    await app.close();
  });

  it('rejects missing scoped portfolio and venture resources with mapped 404 responses', async () => {
    database = createDatabase(':memory:');
    const app = buildApp({
      database,
      invoke: async ({ runtime }) => `response from ${runtime.id}`,
    });
    const missingId = '11111111-1111-4111-8111-111111111111';

    const ventureResponse = await app.inject({
      method: 'POST',
      url: '/api/platform/ventures',
      payload: {
        portfolioId: missingId,
        name: 'Missing Parent Venture',
        kind: 'saas',
        mission: 'This must not reach SQLite.',
      },
    });
    expect(ventureResponse.statusCode).toBe(404);
    expect(ventureResponse.json()).toEqual({ error: `Portfolio not found: ${missingId}` });

    const portfolioVentures = await app.inject({
      method: 'GET',
      url: `/api/platform/portfolios/${missingId}/ventures`,
    });
    expect(portfolioVentures.statusCode).toBe(404);
    expect(portfolioVentures.json()).toEqual({ error: `Portfolio not found: ${missingId}` });

    const ventureProjects = await app.inject({
      method: 'GET',
      url: `/api/platform/ventures/${missingId}/projects`,
    });
    expect(ventureProjects.statusCode).toBe(404);
    expect(ventureProjects.json()).toEqual({ error: `Venture not found: ${missingId}` });

    const portfolioEvents = await app.inject({
      method: 'GET',
      url: `/api/platform/portfolios/${missingId}/events`,
    });
    expect(portfolioEvents.statusCode).toBe(404);
    expect(portfolioEvents.json()).toEqual({ error: `Portfolio not found: ${missingId}` });
    await app.close();
  });

  it('responds before a pending export and drains it during application close', async () => {
    database = createDatabase(':memory:');
    let resolveExport: (() => void) | undefined;
    let exportStarted = false;
    const app = buildApp({
      database,
      invoke: async ({ runtime }) => `response from ${runtime.id}`,
      exportEvent: () => new Promise<void>((resolve) => {
        exportStarted = true;
        resolveExport = resolve;
      }),
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/platform/portfolios/default',
      payload: { name: 'Pending Export' },
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(exportStarted).toBe(true));

    let closeCompleted = false;
    const closing = app.close().then(() => {
      closeCompleted = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeCompleted).toBe(false);

    resolveExport?.();
    await closing;
    expect(closeCompleted).toBe(true);
  });

  it('reports export failures through the injected logger without sensitive payload data', async () => {
    database = createDatabase(':memory:');
    const failures: Array<{ eventId: string; eventType: string; attempts: number }> = [];
    const secret = 'vault-password-should-never-be-logged';
    const app = buildApp({
      database,
      invoke: async ({ runtime }) => `response from ${runtime.id}`,
      exportEvent: async () => Promise.reject(new Error(secret)),
      logExportFailure: (failure) => failures.push(failure),
    });

    const response = await app.inject({
      method: 'PUT',
      url: '/api/platform/portfolios/default',
      payload: { name: 'Safe Logging' },
    });

    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(failures).toEqual([
      { eventId: expect.any(String), eventType: 'PortfolioCreated', attempts: 1 },
    ]));
    expect(JSON.stringify(failures)).not.toContain(secret);
    await app.close();
  });

  it('gets or creates the trusted owner default portfolio atomically for concurrent clients', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-labs-default-'));
    temporaryDirectories.push(directory);
    const filename = join(directory, 'orchestrator.db');
    database = createDatabase(filename);
    const secondDatabase = createDatabase(filename);
    additionalDatabases.push(secondDatabase);
    const firstApp = buildApp({
      database,
      currentUserId: 'owner',
      invoke: async ({ runtime }) => `response from ${runtime.id}`,
    });
    const secondApp = buildApp({
      database: secondDatabase,
      currentUserId: 'owner',
      invoke: async ({ runtime }) => `response from ${runtime.id}`,
    });

    const [first, second] = await Promise.all([
      firstApp.inject({ method: 'PUT', url: '/api/platform/portfolios/default' }),
      secondApp.inject({ method: 'PUT', url: '/api/platform/portfolios/default' }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ id: string }>().id).toBe(second.json<{ id: string }>().id);
    const portfolioId = first.json<{ id: string }>().id;
    expect(database.platform.listEvents(portfolioId, 20).filter(({ type }) => type === 'PortfolioCreated')).toHaveLength(1);
    const exportStatus = await firstApp.inject({
      method: 'GET', url: `/api/platform/portfolios/${portfolioId}/export-status`,
    });
    expect(exportStatus.json()).toMatchObject({ pending: 1, failed: 0, lastFailure: null });
    await Promise.all([firstApp.close(), secondApp.close()]);
  });

  it('rejects a spoofed approval actor in the public decision body', async () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.', successCriteria: ['Comparison'],
    });
    const service = createPlatformService(database.platform, { currentUserId: 'owner' });
    const submitted = service.submitProjectPlan({
      projectId: project.id, summary: 'Zero-first comparison.', requestedByOrgAgentId: null,
    });
    const app = buildApp({ database, currentUserId: 'owner', invoke: async () => 'unused' });

    const response = await app.inject({
      method: 'POST',
      url: `/api/platform/approvals/${submitted.approval.id}/decision`,
      payload: { status: 'approved', decidedByUserId: 'attacker', decisionNote: null },
    });

    expect(response.statusCode).toBe(400);
    expect(database.platform.getApproval(submitted.approval.id)).toMatchObject({ status: 'pending' });
    await app.close();
  });

  it('forbids the trusted owner from deciding another owner portfolio approval', async () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'Other Labs', ownerUserId: 'other-owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.', successCriteria: ['Comparison'],
    });
    const submitted = createPlatformService(database.platform, { currentUserId: 'other-owner' }).submitProjectPlan({
      projectId: project.id, summary: 'Zero-first comparison.', requestedByOrgAgentId: null,
    });
    const app = buildApp({ database, currentUserId: 'owner', invoke: async () => 'unused' });

    const response = await app.inject({
      method: 'POST',
      url: `/api/platform/approvals/${submitted.approval.id}/decision`,
      payload: { status: 'approved', decisionNote: null },
    });

    expect(response.statusCode).toBe(403);
    expect(database.platform.getApproval(submitted.approval.id)).toMatchObject({ status: 'pending' });
    await app.close();
  });

  it('creates and submits a project once for a repeated intake idempotency key', async () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const app = buildApp({ database, currentUserId: 'owner', invoke: async () => 'unused' });
    const request = {
      method: 'POST' as const,
      url: '/api/platform/project-intakes',
      headers: { 'idempotency-key': 'intake-123' },
      payload: {
        ventureId: venture.id,
        name: 'Tool Survey',
        objective: 'Compare services.',
        successCriteria: ['A sourced comparison'],
        constraints: [],
        summary: 'Zero-first comparison.',
      },
    };

    const first = await app.inject(request);
    const replay = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(200);
    expect(replay.json<{ project: { id: string } }>().project.id).toBe(first.json<{ project: { id: string } }>().project.id);
    expect(database.platform.listProjects(venture.id)).toHaveLength(1);
    await app.close();
  });

  it('rejects credential-shaped free text before persistence', async () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const app = buildApp({ database, currentUserId: 'owner', invoke: async () => 'unused' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/platform/ventures',
      payload: {
        portfolioId: portfolio.id,
        name: 'Unsafe venture',
        kind: 'research',
        mission: 'Use Authorization: Bearer sk-live-secret-value for discovery.',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(database.platform.listVentures(portfolio.id)).toEqual([]);
    await app.close();
  });
});
