import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, type Migration } from '../../src/server/migrations.js';

describe('migration ledger', () => {
  let connection: Database.Database | undefined;
  afterEach(() => {
    connection?.close();
    connection = undefined;
  });

  const widget: Migration = {
    id: '9001-widget',
    up: (db) => db.exec('CREATE TABLE widget (id TEXT PRIMARY KEY)'),
  };

  it('applies a migration once and records it', () => {
    connection = new Database(':memory:');
    expect(applyMigrations(connection, [widget])).toEqual(['9001-widget']);
    expect(applyMigrations(connection, [widget])).toEqual([]);
    const rows = connection.prepare('SELECT id FROM schema_migrations').all();
    expect(rows).toEqual([{ id: '9001-widget' }]);
  });

  it('applies migrations in list order', () => {
    connection = new Database(':memory:');
    const second: Migration = {
      id: '9002-widget-name',
      up: (db) => db.exec('ALTER TABLE widget ADD COLUMN name TEXT'),
    };
    expect(applyMigrations(connection, [widget, second])).toEqual([
      '9001-widget',
      '9002-widget-name',
    ]);
  });

  it('rejects a migration whose body changed after it was applied', () => {
    connection = new Database(':memory:');
    applyMigrations(connection, [widget]);
    const edited: Migration = {
      id: '9001-widget',
      up: (db) => db.exec('CREATE TABLE widget (id TEXT PRIMARY KEY, extra TEXT)'),
    };
    expect(() => applyMigrations(connection!, [edited])).toThrow(/checksum/i);
  });

  it('rolls back a failing migration and leaves the ledger untouched', () => {
    connection = new Database(':memory:');
    const broken: Migration = {
      id: '9003-broken',
      up: (db) => {
        db.exec('CREATE TABLE ok_so_far (id TEXT)');
        db.exec('THIS IS NOT SQL');
      },
    };
    expect(() => applyMigrations(connection!, [broken])).toThrow();
    const applied = connection.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as {
      n: number;
    };
    expect(applied.n).toBe(0);
    const table = connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ok_so_far'")
      .get();
    expect(table).toBeUndefined();
  });
});
