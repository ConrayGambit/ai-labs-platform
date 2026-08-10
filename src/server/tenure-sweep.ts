import type { OrchestratorDatabase } from './database.js';

export interface TenureSweepResult {
  /** Agents whose recorded end has arrived and who were deactivated. */
  expired: string[];
  /**
   * Agents whose expiry could not complete — currently only when they hold direct
   * reports and have no manager to re-parent them to. Surfaced rather than thrown,
   * so one stuck agent cannot stop the rest of the sweep.
   */
  blocked: Array<{ orgAgentId: string; reason: string }>;
}

/**
 * Applies date-based tenure expiry.
 *
 * Without something driving it, `expiryKind: 'date'` is a promise the platform
 * never keeps: the record says the agent ends on a date and it never does.
 */
export function runTenureSweep(
  database: OrchestratorDatabase,
  now: string = new Date().toISOString(),
): TenureSweepResult {
  const result: TenureSweepResult = { expired: [], blocked: [] };
  for (const orgAgentId of database.org.listExpiredAgents(now)) {
    try {
      database.org.expireAgent(orgAgentId);
      result.expired.push(orgAgentId);
    } catch (error) {
      result.blocked.push({
        orgAgentId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}

export interface TenureSweepHandle {
  stop(): void;
}

/**
 * Runs the sweep once immediately, then on an interval. The timer is unref'd so
 * it never holds the process open on shutdown.
 */
export function startTenureSweep(
  database: OrchestratorDatabase,
  options: { intervalMs?: number; onResult?: (result: TenureSweepResult) => void } = {},
): TenureSweepHandle {
  const intervalMs = options.intervalMs ?? 60_000;
  const sweep = (): void => {
    const result = runTenureSweep(database);
    if (result.expired.length > 0 || result.blocked.length > 0) {
      options.onResult?.(result);
    }
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
