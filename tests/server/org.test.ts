import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { assertTenureOrdering, tenureRank } from '../../src/shared/org.js';

describe('tenure ordering', () => {
  it('ranks permanent above hired above temporary', () => {
    expect(tenureRank('permanent')).toBeGreaterThan(tenureRank('hired'));
    expect(tenureRank('hired')).toBeGreaterThan(tenureRank('temporary'));
  });

  it('allows a temporary agent to report to a permanent manager', () => {
    expect(() => assertTenureOrdering('temporary', 'permanent')).not.toThrow();
  });

  it('REJECTS a permanent agent reporting to a temporary manager', () => {
    expect(() => assertTenureOrdering('permanent', 'temporary')).toThrow(/shorter tenure/i);
  });
});

describe('organization repository', () => {
  let database: OrchestratorDatabase | undefined;
  const directories: string[] = [];

  afterEach(() => {
    database?.close();
    database = undefined;
    for (const directory of directories.splice(0)) {
      // Windows can hold a brief lock on the WAL files after close.
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Temp directory cleanup is not part of what these tests assert.
      }
    }
  });

  // Executives seed only into file-backed databases.
  const openWithExecutives = (): OrchestratorDatabase => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-labs-org-'));
    directories.push(directory);
    return (database = createDatabase(join(directory, 'orchestrator.db')));
  };

  const hire = (db: OrchestratorDatabase, name: string, managerId: string | null) =>
    db.createOrgAgent({
      name,
      jobTitle: name,
      department: 'Delivery',
      jobFunction: 'Does work',
      responsibilities: 'Does work',
      runtimeId: 'claude',
      managerId,
      canDelegate: true,
      tenure: 'hired',
    });

  it('seeds the six executives as permanent staff', () => {
    const db = openWithExecutives();
    const agents = db.listOrgAgents();
    expect(agents).toHaveLength(6);
    for (const agent of agents) expect(agent.tenure).toBe('permanent');
  });

  it('REFUSES to delete a permanent agent', () => {
    const db = openWithExecutives();
    expect(() => db.org.deleteOrgAgent('exec-cdo')).toThrow(/permanent/i);
    expect(db.getOrgAgent('exec-cdo')).not.toBeNull();
  });

  it('re-parents reports instead of orphaning them when an agent is removed', () => {
    const db = openWithExecutives();
    const lead = hire(db, 'Lead', 'exec-ceo');
    const report = hire(db, 'Report', lead.id);
    db.org.deleteOrgAgent(lead.id);
    expect(db.getOrgAgent(report.id)?.managerId).toBe('exec-ceo');
    expect(db.getOrgAgent(lead.id)).toBeNull();
  });

  it('REFUSES to create a temporary agent without an expiry condition', () => {
    const db = openWithExecutives();
    expect(() =>
      db.createOrgAgent({
        name: 'Temp',
        jobTitle: 'Temp',
        department: 'Delivery',
        jobFunction: 'Helps',
        responsibilities: 'Helps',
        runtimeId: 'claude',
        managerId: 'exec-ceo',
        tenure: 'temporary',
      }),
    ).toThrow(/expiry condition/i);
  });

  it('REJECTS a hired agent reporting to a temporary manager', () => {
    const db = openWithExecutives();
    const temp = db.createOrgAgent({
      name: 'Temp',
      jobTitle: 'Temp',
      department: 'Delivery',
      jobFunction: 'Helps',
      responsibilities: 'Helps',
      runtimeId: 'claude',
      managerId: 'exec-ceo',
      canDelegate: true,
      tenure: 'temporary',
      expiryKind: 'manual',
    });
    expect(() => hire(db, 'Permanent staffer', temp.id)).toThrow(/shorter tenure/i);
  });

  it('deactivates an expired temporary agent without deleting its history', () => {
    const db = openWithExecutives();
    const temp = db.createOrgAgent({
      name: 'Temp',
      jobTitle: 'Temp',
      department: 'Delivery',
      jobFunction: 'Helps',
      responsibilities: 'Helps',
      runtimeId: 'claude',
      managerId: 'exec-ceo',
      tenure: 'temporary',
      expiryKind: 'manual',
    });
    db.org.expireAgent(temp.id);
    const expired = db.getOrgAgent(temp.id);
    expect(expired).not.toBeNull();
    expect(expired?.enabled).toBe(false);
  });

  it('scopes departments to a venture', () => {
    const db = openWithExecutives();
    const engineering = db.org.createDepartment({ ventureId: 'venture-a', name: 'Engineering' });
    db.org.createDepartment({ ventureId: 'venture-b', name: 'Compliance' });
    expect(db.org.listDepartments('venture-a')).toEqual([engineering]);
  });

  it('rejects a duplicate department name within one venture', () => {
    const db = openWithExecutives();
    db.org.createDepartment({ ventureId: 'venture-a', name: 'Engineering' });
    expect(() => db.org.createDepartment({ ventureId: 'venture-a', name: 'Engineering' })).toThrow();
  });
});

describe('seeded executive graph', () => {
  let database: OrchestratorDatabase | undefined;
  const directories: string[] = [];

  afterEach(() => {
    database?.close();
    database = undefined;
    for (const directory of directories.splice(0)) {
      // Windows can hold a brief lock on the WAL files after close.
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Temp directory cleanup is not part of what these tests assert.
      }
    }
  });

  const open = (): OrchestratorDatabase => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-labs-graph-'));
    directories.push(directory);
    return (database = createDatabase(join(directory, 'orchestrator.db')));
  };

  it('places the Chief of Staff as a coordinating layer rather than a peer', () => {
    const db = open();
    expect(db.getOrgAgent('exec-ceo')?.managerId).toBeNull();
    expect(db.getOrgAgent('exec-chief-of-staff')?.managerId).toBe('exec-ceo');
    // The Chief Innovation Officer reports to the CEO: her promotion boundary is
    // the owner's alone, so routing her via the Chief of Staff would imply an
    // approval path that does not exist.
    expect(db.getOrgAgent('exec-cino')?.managerId).toBe('exec-ceo');
    for (const id of ['exec-cto', 'exec-cmo', 'exec-cdo']) {
      expect(db.getOrgAgent(id)?.managerId).toBe('exec-chief-of-staff');
    }
  });

  it('can place the owner at the root of the reporting graph', () => {
    const db = open();
    const owner = db.identity.createUser({ displayName: 'Owner', role: 'owner' });
    db.org.setReportsToUser('exec-ceo', owner.id);
    expect(db.getOrgAgent('exec-ceo')?.reportsToUserId).toBe(owner.id);
  });

  it('rejects placing an agent under an unknown user', () => {
    const db = open();
    expect(() => db.org.setReportsToUser('exec-ceo', 'no-such-user')).toThrow(/user not found/i);
  });
});

describe('reseed policy', () => {
  let database: OrchestratorDatabase | undefined;
  const directories: string[] = [];

  afterEach(() => {
    database?.close();
    database = undefined;
    for (const directory of directories.splice(0)) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Temp directory cleanup is not part of what these tests assert.
      }
    }
  });

  const newFile = (): string => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-labs-reseed-'));
    directories.push(directory);
    return join(directory, 'orchestrator.db');
  };

  it('REFRESHES stale doctrine text on reopen when the owner has not edited it', () => {
    const file = newFile();
    const first = createDatabase(file);
    const seeded = first.getOrgAgent('exec-cdo')!.instructions;
    first.close();

    // Simulate an older database holding stale doctrine, with no owner edit
    // marker — exactly the drift the previous INSERT OR IGNORE seeding caused.
    const raw = new Database(file);
    raw.prepare('UPDATE org_agents SET instructions = ? WHERE id = ?').run('stale text', 'exec-cdo');
    expect(
      (raw.prepare('SELECT doctrine_edited_at AS d FROM org_agents WHERE id = ?').get('exec-cdo') as {
        d: string | null;
      }).d,
    ).toBeNull();
    raw.close();

    database = createDatabase(file);
    expect(database.getOrgAgent('exec-cdo')?.instructions).toBe(seeded);
  });

  it('PRESERVES doctrine text the owner has edited', () => {
    const file = newFile();
    const first = createDatabase(file);
    first.org.setDoctrine('exec-cdo', { instructions: 'owner wording' });
    first.close();

    database = createDatabase(file);
    expect(database.getOrgAgent('exec-cdo')?.instructions).toBe('owner wording');
  });

  it('NEVER overwrites the model the owner chose', () => {
    const file = newFile();
    const first = createDatabase(file);
    first.org.setTuning('exec-cdo', { model: 'claude-haiku-4-5' });
    first.close();

    database = createDatabase(file);
    expect(database.getOrgAgent('exec-cdo')?.model).toBe('claude-haiku-4-5');
  });
});
