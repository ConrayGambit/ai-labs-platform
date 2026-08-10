import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/server/database.js';
import { applyMigrations, type Migration } from '../../src/server/migrations.js';

describe('migration checksums ignore formatting', () => {
  let connection: Database.Database | undefined;
  afterEach(() => {
    connection?.close();
    connection = undefined;
  });

  it('accepts the same statements reformatted', () => {
    connection = new Database(':memory:');
    const compact: Migration = { id: '9101-format', sql: 'CREATE TABLE fmt (id TEXT)' };
    const reindented: Migration = {
      id: '9101-format',
      sql: `
        CREATE TABLE fmt (id TEXT)
      `,
    };
    expect(applyMigrations(connection, [compact])).toEqual(['9101-format']);
    // Same statements, different layout: this must NOT be treated as an edit.
    expect(() => applyMigrations(connection!, [reindented])).not.toThrow();
  });

  it('still rejects a migration whose statements changed', () => {
    connection = new Database(':memory:');
    const original: Migration = { id: '9102-change', sql: 'CREATE TABLE chg (id TEXT)' };
    const altered: Migration = {
      id: '9102-change',
      sql: 'CREATE TABLE chg (id TEXT, extra TEXT)',
    };
    applyMigrations(connection, [original]);
    expect(() => applyMigrations(connection!, [altered])).toThrow(/checksum/i);
  });

  it('does not let post-hook edits change a checksum, so post must stay idempotent', () => {
    connection = new Database(':memory:');
    const first: Migration = {
      id: '9103-post',
      sql: 'CREATE TABLE pst (id TEXT)',
      post: (db) => db.exec('CREATE INDEX IF NOT EXISTS pst_id ON pst(id)'),
    };
    const secondPost: Migration = {
      id: '9103-post',
      sql: 'CREATE TABLE pst (id TEXT)',
      post: (db) => db.exec('CREATE INDEX IF NOT EXISTS pst_id2 ON pst(id)'),
    };
    applyMigrations(connection, [first]);
    // Documented consequence of not hashing `post`: this is accepted silently.
    // It is why `post` is restricted to idempotent, meaning-preserving backfills.
    expect(() => applyMigrations(connection!, [secondPost])).not.toThrow();
  });
});

/**
 * Regression guard for a defect found in review: the checksum was taken over
 * `Function.prototype.toString()`, so a database created by the built server
 * could not be reopened by the source build. Skipped when dist is absent.
 */
describe('built and source builds agree on checksums', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Windows can hold a brief lock on the WAL files after close.
      }
    }
  });

  const builtDatabase = resolve('dist/server/server/database.js');

  it.runIf(existsSync(builtDatabase))(
    'opens a database created by the built server under the source build',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'ai-labs-parity-'));
      directories.push(directory);
      const file = join(directory, 'orchestrator.db');

      execFileSync(
        process.execPath,
        [
          '-e',
          `import('./dist/server/server/database.js').then(m => { m.createDatabase(${JSON.stringify(file)}).close(); });`,
        ],
        { cwd: process.cwd(), stdio: 'ignore' },
      );

      const built = new Database(file);
      const before = built.prepare('SELECT id, checksum FROM schema_migrations').all();
      built.close();
      expect(before.length).toBeGreaterThan(0);

      // Must not throw: this is the failure the normalisation exists to prevent.
      createDatabase(file).close();

      const after = new Database(file);
      const afterChecksums = after.prepare('SELECT id, checksum FROM schema_migrations').all();
      after.close();
      expect(afterChecksums).toEqual(before);
    },
  );
});
