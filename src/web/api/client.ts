/**
 * Plain `fetch` wrappers over the card-board HTTP routes, one per route.
 *
 * Every route in this platform refuses through one error handler
 * (`src/server/app.ts`, `setErrorHandler`) that always sends
 * `{ error: string }` — confirmed there directly, and empirically in
 * `tests/server/work-api.test.ts` (`toMatchObject({ error: expect.stringMatching(...) })`).
 * Each wrapper below throws that string verbatim as an `Error`, because a
 * later task's job is to render the server's own refusal, not a generic
 * "request failed" message — losing the text here would make that impossible.
 */
import type { StopReason } from '../../shared/acp.js';
import type { CardSpecification, GateReviewState, OverrideEntry } from '../../shared/governance.js';
import type { Room } from '../../shared/room.js';
import type {
  BoardColumn,
  BoardColumnKey,
  Card,
  CardActivity,
  CardArtifact,
  GateId,
  GateLadder,
} from '../../shared/work.js';

/**
 * `AgentRun`'s shape, as `GET /api/cards/:cardId` actually returns it in its
 * `runs` field (`src/server/work-api.ts`). `AgentRun` itself is declared in
 * `src/server/run-repository.ts` — server-only, and client code may import
 * from `src/shared` only — so this mirrors it field for field rather than
 * importing it.
 */
export interface RunSummary {
  id: string;
  cardId: string;
  orgAgentId: string;
  roomId: string | null;
  acpSessionId: string | null;
  parentRunId: string | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'stopped';
  stopReason: StopReason | null;
  stoppedReason: string | null;
  inputTokens: number;
  outputTokens: number;
  costCeilingTokens: number | null;
  startedAt: string;
  finishedAt: string | null;
}

/** What `GET /api/cards/:cardId` returns (`src/server/work-api.ts`). */
export interface CardDetail {
  card: Card;
  room: Room | null;
  activity: CardActivity[];
  artifacts: CardArtifact[];
  runs: RunSummary[];
}

/** What `GET /api/projects/:projectId/cards` returns (`src/server/work-api.ts`). */
export interface BoardData {
  ladder: GateLadder;
  columns: BoardColumn[];
  cards: Card[];
}

/** The shape of every error body this API sends (`src/server/app.ts`). */
interface ErrorBody {
  error?: string;
}

/**
 * The platform reached the server and it refused, deliberately, in words a
 * person can read — a response with a body of `{ error: string }`.
 *
 * Distinct from a plain `Error`, which from this module always means the
 * request never reached the server at all (offline, DNS failure, the dev
 * proxy not running, CORS). A caller rendering "the server's own refusal"
 * needs to tell those apart: a browser's own `TypeError: Failed to fetch` is
 * not a refusal, and rendering it as one would tell a person the platform
 * said something it never had the chance to say.
 */
export class ServerRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerRefusal';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    // Called as fetch(path) rather than fetch(path, undefined) when there is
    // no init: behaviorally identical, but it keeps every GET a plain
    // one-argument call rather than one with a silent extra `undefined`.
    response = await (init ? fetch(path, init) : fetch(path));
  } catch (cause) {
    // fetch() itself rejected: the request never reached the server, so
    // there is no server refusal to carry. A plain Error, not a
    // ServerRefusal — the original failure is kept as `cause` for
    // diagnostics rather than folded into the message text a UI might show
    // verbatim.
    throw new Error('Could not reach the server', { cause });
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ErrorBody | null;
    // The server's own words, verbatim. Falling back to a generic message only
    // when the body genuinely carried none — a malformed or empty error body,
    // not the ordinary case.
    throw new ServerRefusal(body?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function getJson<T>(path: string): Promise<T> {
  return request<T>(path);
}

function sendJson<T>(path: string, method: string, payload: unknown): Promise<T> {
  return request<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function getBoard(projectId: string): Promise<BoardData> {
  return getJson(`/api/projects/${projectId}/cards`);
}

export function getCard(cardId: string): Promise<CardDetail> {
  return getJson(`/api/cards/${cardId}`);
}

export function putNotes(cardId: string, notes: string): Promise<Card> {
  return sendJson(`/api/cards/${cardId}/notes`, 'PUT', { notes });
}

/**
 * The task brief's documented signature is `moveCard(cardId, to)`. The route's
 * own schema (`src/server/work-api.ts`, `moveSchema`) requires `position` too,
 * with no default — there is no "correct" place to guess a card into within
 * its destination column. Added rather than assumed, per this task's
 * instruction to read the handler where the brief and the source disagree.
 */
export function moveCard(cardId: string, to: BoardColumnKey, position: number): Promise<Card> {
  return sendJson(`/api/cards/${cardId}/move`, 'POST', { to, position });
}

export function getReviewState(cardId: string, gateId: GateId): Promise<GateReviewState> {
  return getJson(`/api/cards/${cardId}/gates/${gateId}/review-state`);
}

/**
 * Not in Task 5's set — added here. The card detail surface has to show the
 * specification card's sections with any missing one named (this task's own
 * brief), which is not part of `CardDetail` (`GET /api/cards/:cardId`); it is
 * its own route, `GET /api/cards/:cardId/specification`
 * (`src/server/governance-api.ts`), returning `CardSpecification | null`
 * directly (null before any section has ever been written). Same one-route,
 * one-wrapper shape as every function above.
 */
export function getSpecification(cardId: string): Promise<CardSpecification | null> {
  return getJson(`/api/cards/${cardId}/specification`);
}

export async function getOverrides(cardId?: string): Promise<OverrideEntry[]> {
  const query = cardId ? `?cardId=${cardId}` : '';
  const { entries } = await getJson<{ entries: OverrideEntry[] }>(`/api/override-register${query}`);
  return entries;
}
