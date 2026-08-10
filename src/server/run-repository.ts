import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { SessionUpdate, StopReason } from '../shared/acp.js';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'stopped';

export interface AgentRun {
  id: string;
  cardId: string;
  orgAgentId: string;
  roomId: string | null;
  acpSessionId: string | null;
  parentRunId: string | null;
  status: RunStatus;
  stopReason: StopReason | null;
  /** Why the platform ended it, when the platform ended it. */
  stoppedReason: string | null;
  inputTokens: number;
  outputTokens: number;
  costCeilingTokens: number | null;
  startedAt: string;
  finishedAt: string | null;
}

interface RunRow {
  id: string;
  card_id: string;
  org_agent_id: string;
  room_id: string | null;
  acp_session_id: string | null;
  parent_run_id: string | null;
  status: RunStatus;
  stop_reason: StopReason | null;
  stopped_reason: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_ceiling_tokens: number | null;
  started_at: string;
  finished_at: string | null;
}

const mapRun = (row: RunRow): AgentRun => ({
  id: row.id,
  cardId: row.card_id,
  orgAgentId: row.org_agent_id,
  roomId: row.room_id,
  acpSessionId: row.acp_session_id,
  parentRunId: row.parent_run_id,
  status: row.status,
  stopReason: row.stop_reason,
  stoppedReason: row.stopped_reason,
  inputTokens: row.input_tokens,
  outputTokens: row.output_tokens,
  costCeilingTokens: row.cost_ceiling_tokens,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

export interface CreateRunInput {
  cardId: string;
  orgAgentId: string;
  roomId: string | null;
  parentRunId: string | null;
  costCeilingTokens: number | null;
}

export interface FinishRunInput {
  runId: string;
  status: RunStatus;
  stopReason?: StopReason | null;
  stoppedReason?: string | null;
}

export interface RunRepository {
  createRun(input: CreateRunInput): AgentRun;
  getRun(runId: string): AgentRun | null;
  listActiveRuns(): AgentRun[];
  listRunsForCard(cardId: string): AgentRun[];
  setSessionId(runId: string, sessionId: string): void;
  /** Adds reported tokens and returns the run as it now stands. */
  addUsage(runId: string, input: number, output: number): AgentRun;
  finishRun(input: FinishRunInput): AgentRun;
  /** Appends one update at the next per-run sequence. */
  appendUpdate(runId: string, update: SessionUpdate): void;
  listUpdates(runId: string): SessionUpdate[];
}

export function createRunRepository(connection: Database.Database): RunRepository {
  const selectRun = connection.prepare('SELECT * FROM agent_runs WHERE id = ?');

  const requireRun = (runId: string): AgentRun => {
    const row = selectRun.get(runId) as RunRow | undefined;
    if (!row) throw new Error(`Run not found: ${runId}`);
    return mapRun(row);
  };

  const nextSequence = connection.prepare(
    'SELECT COALESCE(MAX(sequence) + 1, 0) AS next FROM agent_run_updates WHERE run_id = ?',
  );

  return {
    createRun(input) {
      const id = randomUUID();
      connection.prepare(`
        INSERT INTO agent_runs (
          id, card_id, org_agent_id, room_id, acp_session_id, parent_run_id,
          status, input_tokens, output_tokens, cost_ceiling_tokens, started_at
        ) VALUES (
          @id, @cardId, @orgAgentId, @roomId, NULL, @parentRunId,
          'running', 0, 0, @costCeilingTokens, @startedAt
        )
      `).run({ ...input, id, startedAt: new Date().toISOString() });
      return requireRun(id);
    },

    getRun(runId) {
      const row = selectRun.get(runId) as RunRow | undefined;
      return row ? mapRun(row) : null;
    },

    listActiveRuns() {
      const rows = connection
        .prepare("SELECT * FROM agent_runs WHERE status = 'running' ORDER BY started_at")
        .all() as RunRow[];
      return rows.map(mapRun);
    },

    listRunsForCard(cardId) {
      const rows = connection
        .prepare('SELECT * FROM agent_runs WHERE card_id = ? ORDER BY started_at')
        .all(cardId) as RunRow[];
      return rows.map(mapRun);
    },

    setSessionId(runId, sessionId) {
      connection.prepare('UPDATE agent_runs SET acp_session_id = ? WHERE id = ?').run(sessionId, runId);
    },

    addUsage(runId, input, output) {
      connection
        .prepare(
          'UPDATE agent_runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ? WHERE id = ?',
        )
        .run(input, output, runId);
      return requireRun(runId);
    },

    finishRun(input) {
      // COALESCE, so finishing twice cannot erase a reason recorded the first
      // time — the platform's reason for stopping a run outlives the protocol's.
      connection.prepare(`
        UPDATE agent_runs SET
          status = @status,
          stop_reason = COALESCE(@stopReason, stop_reason),
          stopped_reason = COALESCE(@stoppedReason, stopped_reason),
          finished_at = @finishedAt
        WHERE id = @runId
      `).run({
        runId: input.runId,
        status: input.status,
        stopReason: input.stopReason ?? null,
        stoppedReason: input.stoppedReason ?? null,
        finishedAt: new Date().toISOString(),
      });
      return requireRun(input.runId);
    },

    appendUpdate(runId, update) {
      connection.prepare(`
        INSERT INTO agent_run_updates (id, run_id, sequence, payload_json, created_at)
        VALUES (@id, @runId, @sequence, @payload, @createdAt)
      `).run({
        id: randomUUID(),
        runId,
        sequence: (nextSequence.get(runId) as { next: number }).next,
        payload: JSON.stringify(update),
        createdAt: new Date().toISOString(),
      });
    },

    listUpdates(runId) {
      const rows = connection
        .prepare('SELECT payload_json FROM agent_run_updates WHERE run_id = ? ORDER BY sequence')
        .all(runId) as Array<{ payload_json: string }>;
      return rows.map((row) => JSON.parse(row.payload_json) as SessionUpdate);
    },
  };
}
