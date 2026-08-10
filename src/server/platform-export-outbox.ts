import type Database from 'better-sqlite3';
import type { PlatformEvent, PlatformExportStatus } from '../shared/platform.js';

type EventRow = {
  id: string; portfolio_id: string; venture_id: string | null; project_id: string | null; type: string;
  actor_type: PlatformEvent['actorType']; actor_id: string | null; payload_json: string; created_at: string;
};

type JobRow = EventRow & { attempts: number };

export interface PlatformExportJob {
  event: PlatformEvent;
  attempts: number;
}

export interface PlatformExportOutbox {
  enqueue(eventId: string, createdAt: string): void;
  listReady(now: string, limit: number, includeDeferred: boolean): PlatformExportJob[];
  markCompleted(eventId: string): void;
  markFailed(eventId: string, attempts: number, nextRetryAt: string): void;
  getNextAttemptAt(): string | null;
  getStatus(portfolioId: string): PlatformExportStatus;
}

const mapEvent = (row: EventRow): PlatformEvent => ({
  id: row.id,
  portfolioId: row.portfolio_id,
  ventureId: row.venture_id,
  projectId: row.project_id,
  type: row.type,
  actorType: row.actor_type,
  actorId: row.actor_id,
  payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  createdAt: row.created_at,
});

export function createPlatformExportOutbox(connection: Database.Database): PlatformExportOutbox {
  // Schema and backfill are owned by the migration ledger (0004-platform-foundation).
  return {
    enqueue: (eventId, createdAt) => {
      connection.prepare(`
        INSERT INTO platform_export_outbox (event_id, status, attempts, available_at)
        VALUES (?, 'pending', 0, ?)
      `).run(eventId, createdAt);
    },
    listReady: (now, limit, includeDeferred) => connection.prepare(`
      SELECT e.*, o.attempts FROM platform_export_outbox o
      JOIN platform_events e ON e.id = o.event_id
      WHERE o.status != 'completed' AND (? = 1 OR o.available_at <= ?)
      ORDER BY o.available_at, e.created_at, e.rowid LIMIT ?
    `).all(includeDeferred ? 1 : 0, now, limit).map((value) => {
      const row = value as JobRow;
      return { event: mapEvent(row), attempts: row.attempts };
    }),
    markCompleted: (eventId) => {
      connection.prepare(`
        UPDATE platform_export_outbox
        SET status = 'completed', completed_at = ?, last_error_code = NULL
        WHERE event_id = ?
      `).run(new Date().toISOString(), eventId);
    },
    markFailed: (eventId, attempts, nextRetryAt) => {
      connection.prepare(`
        UPDATE platform_export_outbox
        SET status = 'failed', attempts = ?, available_at = ?, last_error_code = 'export_failed'
        WHERE event_id = ?
      `).run(attempts, nextRetryAt, eventId);
    },
    getNextAttemptAt: () => {
      const row = connection.prepare(`
        SELECT MIN(available_at) AS available_at FROM platform_export_outbox WHERE status != 'completed'
      `).get() as { available_at: string | null };
      return row.available_at;
    },
    getStatus: (portfolioId) => {
      const counts = connection.prepare(`
        SELECT COUNT(*) AS pending,
          SUM(CASE WHEN o.status = 'failed' THEN 1 ELSE 0 END) AS failed
        FROM platform_export_outbox o JOIN platform_events e ON e.id = o.event_id
        WHERE e.portfolio_id = ? AND o.status != 'completed'
      `).get(portfolioId) as { pending: number; failed: number | null };
      const failure = connection.prepare(`
        SELECT e.id, e.type, o.attempts, o.last_error_code, o.available_at
        FROM platform_export_outbox o JOIN platform_events e ON e.id = o.event_id
        WHERE e.portfolio_id = ? AND o.status = 'failed'
        ORDER BY o.available_at DESC, e.rowid DESC LIMIT 1
      `).get(portfolioId) as {
        id: string; type: string; attempts: number; last_error_code: 'export_failed'; available_at: string;
      } | undefined;
      return {
        pending: counts.pending,
        failed: counts.failed ?? 0,
        lastFailure: failure ? {
          eventId: failure.id,
          eventType: failure.type,
          attempts: failure.attempts,
          errorCode: failure.last_error_code,
          nextRetryAt: failure.available_at,
        } : null,
      };
    },
  };
}
