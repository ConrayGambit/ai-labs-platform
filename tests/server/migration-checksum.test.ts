import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

  it('checksums every statement, so nothing in a migration escapes the check', () => {
    connection = new Database(':memory:');
    const first: Migration = {
      id: '9103-all',
      sql: 'CREATE TABLE pst (id TEXT); CREATE INDEX pst_id ON pst(id);',
    };
    const second: Migration = {
      id: '9103-all',
      sql: 'CREATE TABLE pst (id TEXT); CREATE INDEX pst_id2 ON pst(id);',
    };
    applyMigrations(connection, [first]);
    // A migration is SQL and nothing else, so a change anywhere in it is caught.
    // There is no unhashed escape hatch to slip a change through.
    expect(() => applyMigrations(connection!, [second])).toThrow(/checksum/i);
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

  /**
   * CI builds before it tests, so there the artifact is always present. Anywhere
   * else somebody may reasonably run vitest without having built first.
   */
  const inCI = process.env.CI === 'true' || process.env.CI === '1';

  /*
   * The check below is gated on a build artifact, which is how it came to run
   * nowhere at all: `npm test` ran BEFORE `npm run build` in both the verify
   * script and the workflow, `dist/` is not committed, and a clean checkout
   * therefore skipped it on every push and every pull request while the run
   * stayed green. A check that silently does not run is the same failure this
   * file exists to catch, wearing the colour of a pass.
   *
   * These two guard the guard. One asserts the artifact is genuinely there when
   * CI claims to have checked parity; the other asserts the verify script still
   * builds before it tests, since CI runs its steps individually and would stay
   * green while the local contract rotted.
   */
  it.runIf(inCI)('has the built server present, so the parity check really ran', () => {
    expect(existsSync(builtDatabase)).toBe(true);
  });

  it('verifies in an order that leaves the built server available', () => {
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const steps = manifest.scripts.verify.split('&&').map((step) => step.trim());
    const build = steps.indexOf('npm run build');
    const test = steps.indexOf('npm test');
    expect(build).toBeGreaterThanOrEqual(0);
    expect(test).toBeGreaterThanOrEqual(0);
    expect(build).toBeLessThan(test);
  });

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
      const before = built.prepare('SELECT id, checksum FROM schema_migrations').all() as Array<{
        id: string;
        checksum: string;
      }>;
      built.close();
      expect(before.length).toBeGreaterThan(0);

      // Must not throw: this is the failure the SQL-based checksum exists to
      // prevent — a database created by `npm start` refusing to open under the
      // source build.
      createDatabase(file).close();

      const after = new Database(file);
      const afterRows = after.prepare('SELECT id, checksum FROM schema_migrations').all() as Array<{
        id: string;
        checksum: string;
      }>;
      after.close();

      // Compare only the migrations both builds know about. `dist` may lag source
      // by a migration or more, and applying a genuinely new one is correct
      // forward behaviour — the property under test is that the two agree on the
      // checksum of the SAME migration, not that source adds nothing.
      const afterById = new Map(afterRows.map((row) => [row.id, row.checksum]));
      for (const row of before) {
        expect(afterById.get(row.id)).toBe(row.checksum);
      }
      expect(afterRows.length).toBeGreaterThanOrEqual(before.length);
    },
  );
});
