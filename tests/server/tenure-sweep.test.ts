import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { runTenureSweep, startTenureSweep } from '../../src/server/tenure-sweep.js';

describe('tenure sweep', () => {
  let database: OrchestratorDatabase | undefined;
  const directories: string[] = [];

  afterEach(() => {
    database?.close();
    database = undefined;
    for (const directory of directories.splice(0)) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Windows can hold a brief lock on the WAL files after close.
      }
    }
  });

  // Executives seed only into file-backed databases, and the sweep needs a
  // permanent manager to re-parent to.
  const open = (): OrchestratorDatabase => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-labs-sweep-'));
    directories.push(directory);
    return (database = createDatabase(join(directory, 'orchestrator.db')));
  };

  const temporaryAgent = (
    db: OrchestratorDatabase,
    name: string,
    expiryAt: string,
    managerId: string | null = 'exec-ceo',
  ) =>
    db.createOrgAgent({
      name,
      jobTitle: name,
      department: 'Delivery',
      jobFunction: 'Helps',
      responsibilities: 'Helps',
      runtimeId: 'claude',
      managerId,
      canDelegate: true,
      tenure: 'temporary',
      expiryKind: 'date',
      expiryAt,
    });

  it('expires an agent whose recorded end has passed', () => {
    const db = open();
    const agent = temporaryAgent(db, 'Past', '2020-01-01T00:00:00.000Z');

    const result = runTenureSweep(db, '2026-01-01T00:00:00.000Z');

    expect(result.expired).toEqual([agent.id]);
    expect(db.getOrgAgent(agent.id)?.enabled).toBe(false);
  });

  it('leaves an agent whose end has not arrived', () => {
    const db = open();
    const agent = temporaryAgent(db, 'Future', '2099-01-01T00:00:00.000Z');

    const result = runTenureSweep(db, '2026-01-01T00:00:00.000Z');

    expect(result.expired).toEqual([]);
    expect(db.getOrgAgent(agent.id)?.enabled).toBe(true);
  });

  it('does not expire the same agent twice', () => {
    const db = open();
    temporaryAgent(db, 'Past', '2020-01-01T00:00:00.000Z');

    expect(runTenureSweep(db, '2026-01-01T00:00:00.000Z').expired).toHaveLength(1);
    expect(runTenureSweep(db, '2026-01-01T00:00:00.000Z').expired).toHaveLength(0);
  });

  it('never expires permanent staff', () => {
    const db = open();
    runTenureSweep(db, '2099-01-01T00:00:00.000Z');
    for (const agent of db.listOrgAgents()) {
      if (agent.tenure === 'permanent') expect(agent.enabled).toBe(true);
    }
  });

  it('reports a blocked expiry instead of throwing, and keeps sweeping', () => {
    const db = open();
    // A root temporary agent holding a report cannot be expired: there is no
    // manager to re-parent to. It must not stop the rest of the sweep.
    const rootless = temporaryAgent(db, 'Rootless', '2020-01-01T00:00:00.000Z', null);
    db.createOrgAgent({
      name: 'Report',
      jobTitle: 'Report',
      department: 'Delivery',
      jobFunction: 'Builds',
      responsibilities: 'Builds',
      runtimeId: 'claude',
      managerId: rootless.id,
      tenure: 'temporary',
      expiryKind: 'manual',
    });
    const other = temporaryAgent(db, 'Other', '2020-01-01T00:00:00.000Z');

    const result = runTenureSweep(db, '2026-01-01T00:00:00.000Z');

    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.orgAgentId).toBe(rootless.id);
    expect(result.blocked[0]?.reason).toMatch(/no manager to re-parent/i);
    // The unrelated agent still expired.
    expect(result.expired).toContain(other.id);
    expect(db.getOrgAgent(rootless.id)?.enabled).toBe(true);
  });

  it('sweeps immediately on start and stops cleanly', () => {
    const db = open();
    const agent = temporaryAgent(db, 'Past', '2020-01-01T00:00:00.000Z');

    const handle = startTenureSweep(db, { intervalMs: 60_000 });
    try {
      expect(db.getOrgAgent(agent.id)?.enabled).toBe(false);
    } finally {
      handle.stop();
    }
  });
});
