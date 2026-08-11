import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import type { FastifyInstance } from 'fastify';

describe('the card API', () => {
  let database: OrchestratorDatabase | undefined;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    database?.close();
    database = undefined;
  });

  /**
   * `actor` picks the connecting user from the seeded database, so an access
   * test uses a user that genuinely exists and genuinely lacks the grant.
   * Creating one in a throwaway database would fail as "user not found" and
   * pass the test for the wrong reason.
   */
  function seed(actor: (database: OrchestratorDatabase) => string = () => 'owner') {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Evaluate tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id,
      name: 'Tool Survey',
      objective: 'Compare free research services.',
      successCriteria: ['A sourced comparison is approved'],
    });
    app = buildApp({
      database,
      invoke: async () => 'unused',
      currentUserId: actor(database),
    });
    return { project, venture };
  }

  it('creates a card with a room, in one call', async () => {
    const { project } = seed();

    const response = await app!.inject({
      method: 'POST',
      url: '/api/cards',
      payload: { projectId: project.id, title: 'Survey the field' },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { card: { id: string }; room: { cardId: string } };
    // A card always has somewhere to talk about it, from the moment it exists.
    expect(body.room.cardId).toBe(body.card.id);
    expect(database!.rooms.getRoomForCard(body.card.id)).not.toBeNull();
  });

  it('returns the board columns from the project ladder', async () => {
    const { project } = seed();
    await app!.inject({
      method: 'POST', url: '/api/cards',
      payload: { projectId: project.id, title: 'Survey the field' },
    });

    const response = await app!.inject({ method: 'GET', url: `/api/projects/${project.id}/cards` });

    const body = response.json() as { columns: Array<{ key: string }>; cards: unknown[] };
    expect(body.columns.map((column) => column.key)).toEqual([
      'backlog', 'ready', 'in_progress', 'G1', 'G2', 'G3', 'G4', 'blocked', 'done',
    ]);
    expect(body.cards).toHaveLength(1);
  });

  it('ENFORCES the gate server-side, not just in the client', async () => {
    const { project } = seed();
    const created = await app!.inject({
      method: 'POST', url: '/api/cards',
      payload: { projectId: project.id, title: 'Survey the field' },
    });
    const cardId = (created.json() as { card: { id: string } }).card.id;

    const response = await app!.inject({
      method: 'POST', url: `/api/cards/${cardId}/move`, payload: { to: 'done', position: 0 },
    });

    // A board that only checks in the browser is a board with no gates.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json()).toMatchObject({ error: expect.stringMatching(/artifact/i) });
    expect(database!.work.getCard(cardId)?.status).toBe('backlog');
  });

  it('moves a card out of a gate once its one required review is filed', async () => {
    const { project } = seed();
    const created = await app!.inject({
      method: 'POST', url: '/api/cards',
      payload: { projectId: project.id, title: 'Survey the field' },
    });
    const cardId = (created.json() as { card: { id: string } }).card.id;

    // Entering a gate is free: no review, artifact or specification needed.
    const entered = await app!.inject({
      method: 'POST', url: `/api/cards/${cardId}/move`, payload: { to: 'G2', position: 0 },
    });
    expect(entered.statusCode).toBe(200);

    // G2 asks for exactly one review (the product ladder default) and needs
    // neither a specification nor the owner's signature, so filing that one
    // review is the only thing standing between this card and leaving G2.
    const runtime = database!.createAgent({
      name: 'Runtime reviewer', command: 'runtime-reviewer', argsTemplate: ['{prompt}'],
      promptTransport: 'argument', outputFormat: 'text',
      versionArgs: ['--version'], timeoutMs: 120_000,
    });
    const reviewer = database!.createOrgAgent({
      name: 'Reviewer', jobTitle: 'Specialist', department: 'Research',
      jobFunction: 'Reviews the work.', responsibilities: 'Review.',
      runtimeId: runtime.id, model: 'model-reviewer',
    });
    database!.governance.assignRole({ cardId, gateId: 'G2', role: 'reviewer', orgAgentId: reviewer.id });
    database!.governance.insertReviewRecord({
      cardId, gateId: 'G2', reviewerOrgAgentId: reviewer.id, verdict: 'approve',
      checklist: [{ item: 'Does it meet the acceptance criteria?', answer: 'Yes.' }],
      whatToPreserve: '', questionsForBuilder: '', findings: [],
    });

    const response = await app!.inject({
      method: 'POST', url: `/api/cards/${cardId}/move`, payload: { to: 'G3', position: 0 },
    });

    // The one review G2 requires is filed. A refusal here would mean the
    // route resolved reviewsFiled from something other than the record just
    // written — the same "Gate refused the move" a hardcoded 0 always gives.
    expect(response.statusCode).toBe(200);
    expect(database!.work.getCard(cardId)?.gateId).toBe('G3');
  });

  it('REFUSES every card route to a user with no access to the venture', async () => {
    const { project } = seed(
      // A real user of this platform, with no grant on this project's venture.
      (seeded) => seeded.identity.createUser({ displayName: 'Outsider', role: 'staff' }).id,
    );

    const create = await app!.inject({
      method: 'POST', url: '/api/cards',
      payload: { projectId: project.id, title: 'Should not exist' },
    });
    const board = await app!.inject({ method: 'GET', url: `/api/projects/${project.id}/cards` });

    expect(create.statusCode).toBe(403);
    expect(board.statusCode).toBe(403);
    expect(database!.work.listCards(project.id)).toEqual([]);
  });

  it('gives the same answer for a card that does not exist as for one you may not see', async () => {
    const { project } = seed();
    const cardId = database!.work.createCard({ projectId: project.id, title: 'Survey the field' }).id;
    // Reconnect as a real user of the platform with no grant on this
    // project's venture, so the card genuinely exists but sits outside what
    // this actor may reach.
    await app!.close();
    const outsider = database!.identity.createUser({ displayName: 'Outsider', role: 'staff' });
    app = buildApp({ database: database!, invoke: async () => 'unused', currentUserId: outsider.id });

    const unknown = await app!.inject({ method: 'GET', url: '/api/cards/no-such-card' });
    const inaccessible = await app!.inject({ method: 'GET', url: `/api/cards/${cardId}` });

    // The error handler maps any "Access denied:" message to 403 with
    // { error }. assertProjectAccess must not let assertVentureAccess's own
    // message — which names the actor and the venture — escape uncaught:
    // both branches need the identical "Access denied: card <id>" shape, not
    // just the same status code, or a caller comparing the two bodies learns
    // which cards exist and which venture owns them.
    expect(unknown.statusCode).toBe(403);
    expect(inaccessible.statusCode).toBe(403);
    expect(unknown.json().error).toMatch(/^Access denied: card /);
    expect(inaccessible.json().error).toMatch(/^Access denied: card /);
  });

  it('gives the same answer for a project that does not exist as for one you may not see', async () => {
    const { project } = seed(
      // A real user of this platform, with no grant on this project's venture.
      (seeded) => seeded.identity.createUser({ displayName: 'Outsider', role: 'staff' }).id,
    );

    // assertProjectAccess always throws using the exact projectId it was
    // called with, so probing the SAME id string is what makes the two
    // bodies genuinely comparable byte for byte: a second, unrelated
    // database that has never heard of this id stands in for "unknown",
    // while the first database (seeded above, reachable only as an
    // outsider) stands in for "real but inaccessible".
    const otherDatabase = createDatabase(':memory:');
    const otherApp = buildApp({ database: otherDatabase, invoke: async () => 'unused' });

    const unknown = await otherApp.inject({ method: 'GET', url: `/api/projects/${project.id}/cards` });
    const inaccessible = await app!.inject({ method: 'GET', url: `/api/projects/${project.id}/cards` });

    await otherApp.close();
    otherDatabase.close();

    // The error handler maps any "Access denied:" message to 403 with
    // { error }. assertProjectAccess must not let assertVentureAccess's own
    // message — which names the actor and the venture — escape uncaught:
    // both branches need byte-identical "Access denied: project <id>"
    // bodies, not just the same status code, or a caller comparing the two
    // responses learns which projects exist and which venture owns them.
    expect(unknown.statusCode).toBe(403);
    expect(inaccessible.statusCode).toBe(403);
    expect(unknown.json().error).toMatch(/^Access denied: project /);
    expect(unknown.body).toBe(inaccessible.body);
  });

  it('REFUSES to start a run when no supervisor is configured', async () => {
    const { project } = seed();
    const created = await app!.inject({
      method: 'POST', url: '/api/cards',
      payload: { projectId: project.id, title: 'Survey the field' },
    });
    const cardId = (created.json() as { card: { id: string } }).card.id;

    const response = await app!.inject({
      method: 'POST', url: `/api/cards/${cardId}/runs`,
      payload: { orgAgentId: 'nobody', message: 'Begin.' },
    });

    // Better a clear refusal than a route that looks like it started something.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.json()).toMatchObject({ error: expect.stringMatching(/not available/i) });
  });

  it('writes the owner notes as the connection user, never as a body field', async () => {
    const { project } = seed();
    const created = await app!.inject({
      method: 'POST', url: '/api/cards',
      payload: { projectId: project.id, title: 'Survey the field' },
    });
    const cardId = (created.json() as { card: { id: string } }).card.id;

    await app!.inject({
      method: 'PUT',
      url: `/api/cards/${cardId}/notes`,
      // The impostor field is ignored: the actor comes from the connection.
      payload: { notes: 'Prefer published methods.', userId: 'somebody-else' },
    });

    const activity = database!.work.listActivity(cardId).find((entry) => entry.kind === 'notes_changed');
    expect(activity).toMatchObject({ actorType: 'user', actorId: 'owner' });
  });
});
