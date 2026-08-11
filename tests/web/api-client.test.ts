import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBoard,
  getCard,
  getOverrides,
  getReviewState,
  moveCard,
  putNotes,
  ServerRefusal,
} from '../../src/web/api/client.js';

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

function errorResponse(status: number, error: string): Promise<Response> {
  return jsonResponse({ error }, status);
}

const card = {
  id: 'card-1',
  projectId: 'project-1',
  parentCardId: null,
  title: 'Survey the field',
  description: '',
  status: 'backlog',
  priority: 'medium',
  assigneeOrgAgentId: null,
  ownerNotes: '',
  gateId: null,
  reviewerCountOverride: null,
  reviewerRaiseReason: null,
  reviewerRaisedByUserId: null,
  costCeilingTokens: null,
  position: 0,
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
};

describe('the API client', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches the board for a project, from /api/projects/:projectId/cards', async () => {
    const ladder = { id: 'product', label: 'Product and code', gates: [] };
    const columns = [{ key: 'backlog', label: 'Backlog', gateId: null }];
    fetchMock.mockReturnValueOnce(jsonResponse({ ladder, columns, cards: [card] }));

    const board = await getBoard('project-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/projects/project-1/cards');
    expect(board).toEqual({ ladder, columns, cards: [card] });
  });

  it('fetches a card with its room, activity, artifacts, and runs, from /api/cards/:cardId', async () => {
    const detail = {
      card,
      room: {
        id: 'room-1', cardId: 'card-1', title: 'Survey the field',
        status: 'open', createdAt: card.createdAt, archivedAt: null,
      },
      activity: [],
      artifacts: [],
      runs: [],
    };
    fetchMock.mockReturnValueOnce(jsonResponse(detail));

    const result = await getCard('card-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/cards/card-1');
    expect(result).toEqual(detail);
  });

  it('writes the owner notes via PUT /api/cards/:cardId/notes', async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ ...card, ownerNotes: 'Prefer published methods.' }));

    const updated = await putNotes('card-1', 'Prefer published methods.');

    expect(fetchMock).toHaveBeenCalledWith('/api/cards/card-1/notes', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ notes: 'Prefer published methods.' }),
    }));
    expect(updated.ownerNotes).toBe('Prefer published methods.');
  });

  // The brief's documented signature is moveCard(cardId, to). The route's own
  // schema (work-api.ts, moveSchema) requires `position` too, with no default —
  // omitting it would 400 on every call. Added rather than guessed at.
  it('moves a card to a column and position via POST /api/cards/:cardId/move', async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ ...card, status: 'ready', position: 2 }));

    const moved = await moveCard('card-1', 'ready', 2);

    expect(fetchMock).toHaveBeenCalledWith('/api/cards/card-1/move', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ to: 'ready', position: 2 }),
    }));
    expect(moved).toMatchObject({ status: 'ready', position: 2 });
  });

  it('fetches the gate review state from /api/cards/:cardId/gates/:gateId/review-state', async () => {
    const state = {
      cardId: 'card-1', gateId: 'G1', requiredReviewers: 1, filedReviewerIds: [],
      deadlineAt: null, sealed: false, sealReason: null, visibleReviews: [],
    };
    fetchMock.mockReturnValueOnce(jsonResponse(state));

    const result = await getReviewState('card-1', 'G1');

    expect(fetchMock).toHaveBeenCalledWith('/api/cards/card-1/gates/G1/review-state');
    expect(result).toEqual(state);
  });

  it('lists overrides platform-wide when no card is named', async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ entries: [] }));

    const entries = await getOverrides();

    expect(fetchMock).toHaveBeenCalledWith('/api/override-register');
    expect(entries).toEqual([]);
  });

  it('scopes overrides to one card when named', async () => {
    fetchMock.mockReturnValueOnce(jsonResponse({ entries: [] }));

    await getOverrides('card-1');

    expect(fetchMock).toHaveBeenCalledWith('/api/override-register?cardId=card-1');
  });

  it('throws the server refusal verbatim, as a ServerRefusal, not a generic failure message', async () => {
    fetchMock.mockReturnValueOnce(errorResponse(403, 'Access denied: card card-1'));

    const failure: unknown = await getCard('card-1').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServerRefusal);
    expect((failure as Error).message).toBe('Access denied: card card-1');
  });

  it('carries the refusal verbatim from a different route too, not just one', async () => {
    fetchMock.mockReturnValueOnce(
      errorResponse(400, 'Gate refused the move: needs 1 review(s); 0 of 1 filed.'),
    );

    const failure: unknown = await moveCard('card-1', 'G2', 0).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ServerRefusal);
    expect((failure as Error).message).toBe('Gate refused the move: needs 1 review(s); 0 of 1 filed.');
  });

  // The server was never reached, so there are no "server's own words" to
  // carry — a caller rendering ServerRefusal.message verbatim as the
  // platform's refusal must not be handed a browser's own network-error text
  // instead and mistake it for one.
  it('distinguishes a transport failure from a server refusal', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const failure: unknown = await getCard('card-1').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ServerRefusal);
    expect((failure as Error).message).not.toMatch(/failed to fetch/i);
    expect((failure as Error).cause).toBeInstanceOf(TypeError);
  });
});
