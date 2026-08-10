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
    seed();

    const response = await app!.inject({ method: 'GET', url: '/api/cards/no-such-card' });

    expect(response.json()).toMatchObject({ error: expect.stringMatching(/access denied/i) });
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
