import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, MIGRATIONS, type Migration } from '../../src/server/migrations.js';

describe('migration ledger', () => {
  let connection: Database.Database | undefined;
  afterEach(() => {
    connection?.close();
    connection = undefined;
  });

  const widget: Migration = {
    id: '9001-widget',
    sql: 'CREATE TABLE widget (id TEXT PRIMARY KEY)',
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
      sql: 'ALTER TABLE widget ADD COLUMN name TEXT',
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
      sql: 'CREATE TABLE widget (id TEXT PRIMARY KEY, extra TEXT)',
    };
    expect(() => applyMigrations(connection!, [edited])).toThrow(/checksum/i);
  });

  it('rolls back a failing migration and leaves the ledger untouched', () => {
    connection = new Database(':memory:');
    const broken: Migration = {
      id: '9003-broken',
      sql: 'CREATE TABLE ok_so_far (id TEXT); THIS IS NOT SQL;',
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

  it('adds the ACP invocation columns to agents', () => {
    connection = new Database(':memory:');
    applyMigrations(connection);
    const columns = connection
      .prepare("SELECT name FROM pragma_table_info('agents')")
      .all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    expect(names).toContain('acp_command');
    expect(names).toContain('acp_args_json');
  });

  /**
   * `org_agents.runtime_id` loses its NOT NULL so an organizational agent can
   * exist without a provider assigned (spec: PRODUCT.md's "the model powers an
   * employee; it does not define that employee's identity"). SQLite has no
   * `ALTER TABLE ... DROP NOT NULL`, so this rebuilds the table — and org_agents
   * is referenced by foreign key from several other tables, some NOT NULL with
   * no ON DELETE clause. Foreign keys are ON for the whole suite (the same
   * connection setup `createDatabase` uses), so this also proves the rebuild
   * survives with real referencing rows present, not just on an empty table.
   */
  it('makes org_agents.runtime_id nullable, preserving rows that reference it', () => {
    connection = new Database(':memory:');
    connection.pragma('foreign_keys = ON');
    applyMigrations(connection);

    const now = new Date().toISOString();
    connection.prepare(`
      INSERT INTO agents (id, name, kind, command, args_json, prompt_transport, output_format,
        version_args_json, option_templates_json, option_values_json, env_json, enabled,
        is_coordinator, timeout_ms, created_at, updated_at)
      VALUES ('rt-test', 'Runtime', 'custom', 'rt', '[]', 'argument', 'text', '[]', '{}', '{}', '{}', 1, 0, 60000, ?, ?)
    `).run(now, now);
    connection.prepare(`
      INSERT INTO org_agents (id, organization_id, name, job_title, department, job_function,
        responsibilities, instructions, runtime_id, manager_id, authority_level, can_delegate,
        enabled, tenure, created_at, updated_at)
      VALUES ('mgr-test', 'default-org', 'Manager', 'T', 'D', 'F', 'R', '', 'rt-test', NULL, 50, 0, 1, 'hired', ?, ?)
    `).run(now, now);
    connection.prepare(`
      INSERT INTO org_agents (id, organization_id, name, job_title, department, job_function,
        responsibilities, instructions, runtime_id, manager_id, authority_level, can_delegate,
        enabled, tenure, created_at, updated_at)
      VALUES ('rep-test', 'default-org', 'Report', 'T', 'D', 'F', 'R', '', 'rt-test', 'mgr-test', 50, 0, 1, 'hired', ?, ?)
    `).run(now, now);
    // A NOT NULL, no-ON-DELETE reference to org_agents from another table —
    // the shape that fails a naive DROP TABLE under foreign key enforcement.
    connection.prepare(`
      INSERT INTO platform_portfolios (id, name, owner_user_id, created_at, updated_at)
      VALUES ('pf-test', 'Portfolio', 'owner', ?, ?)
    `).run(now, now);
    connection.prepare(`
      INSERT INTO platform_ventures (id, portfolio_id, name, kind, mission, status, created_at, updated_at)
      VALUES ('v-test', 'pf-test', 'Venture', 'research', 'M', 'active', ?, ?)
    `).run(now, now);
    connection.prepare(`
      INSERT INTO platform_projects (id, venture_id, name, objective, success_criteria_json,
        constraints_json, zero_first, lifecycle, supervision_policy, workspace_mode, created_at, updated_at)
      VALUES ('proj-test', 'v-test', 'Project', 'Objective', '[]', '[]', 0, 'active', 'auto', 'local', ?, ?)
    `).run(now, now);
    connection.prepare(`
      INSERT INTO cards (id, project_id, title, created_at, updated_at)
      VALUES ('card-test', 'proj-test', 'Card', ?, ?)
    `).run(now, now);
    connection.prepare(`
      INSERT INTO agent_runs (id, card_id, org_agent_id, status, started_at)
      VALUES ('run-test', 'card-test', 'rep-test', 'running', ?)
    `).run(now);

    const columns = connection
      .prepare("SELECT name, \"notnull\" FROM pragma_table_info('org_agents')")
      .all() as Array<{ name: string; notnull: number }>;
    const runtimeColumn = columns.find((column) => column.name === 'runtime_id');
    expect(runtimeColumn?.notnull).toBe(0);

    // The rebuild must not have dropped or reordered any column.
    expect(columns.map((column) => column.name)).toEqual([
      'id', 'organization_id', 'name', 'job_title', 'department', 'job_function',
      'responsibilities', 'instructions', 'runtime_id', 'manager_id', 'authority_level',
      'can_delegate', 'model', 'speed', 'effort', 'enabled', 'created_at', 'updated_at',
      'venture_id', 'department_id', 'tenure', 'expiry_kind', 'expiry_at', 'dedication',
      'dedication_reason', 'doctrine_edited_at', 'tuning_edited_at', 'reports_to_user_id',
    ]);

    // A rebuilt table's indexes are not implicit; dropping the trailing CREATE
    // INDEX statements from the migration would lose these silently, and the
    // column and data assertions above would not notice.
    const indexNames = (connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'org_agents'")
      .all() as Array<{ name: string }>).map((row) => row.name);
    expect(indexNames).toContain('org_agents_manager');
    expect(indexNames).toContain('org_agents_venture');

    // Rows written before the rebuild survive it, including the self-referencing
    // manager_id chain and the row a different table points at by foreign key.
    expect(connection.prepare('SELECT manager_id FROM org_agents WHERE id = ?').get('rep-test'))
      .toEqual({ manager_id: 'mgr-test' });
    expect(connection.prepare('SELECT org_agent_id FROM agent_runs WHERE id = ?').get('run-test'))
      .toEqual({ org_agent_id: 'rep-test' });

    // The column now genuinely accepts NULL...
    expect(() =>
      connection!.prepare('UPDATE org_agents SET runtime_id = NULL WHERE id = ?').run('rep-test'),
    ).not.toThrow();
    expect(connection.prepare('SELECT runtime_id FROM org_agents WHERE id = ?').get('rep-test'))
      .toEqual({ runtime_id: null });

    // ...and foreign key enforcement, including the self-referencing ON DELETE
    // SET NULL on manager_id, is genuinely back on afterward.
    expect(() =>
      connection!.prepare(`
        INSERT INTO org_agents (id, organization_id, name, job_title, department, job_function,
          responsibilities, instructions, runtime_id, manager_id, authority_level, can_delegate,
          enabled, tenure, created_at, updated_at)
        VALUES ('bad-test', 'default-org', 'Bad', 'T', 'D', 'F', 'R', '', 'rt-test', 'no-such-agent', 50, 0, 1, 'hired', ?, ?)
      `).run(now, now),
    ).toThrow(/FOREIGN KEY/i);
    connection.prepare('DELETE FROM org_agents WHERE id = ?').run('mgr-test');
    expect(connection.prepare('SELECT manager_id FROM org_agents WHERE id = ?').get('rep-test'))
      .toEqual({ manager_id: null });
  });

  /**
   * `foreign_key_check` with no table argument checks the whole database, not
   * just the table being rebuilt. A pre-existing dangling reference anywhere —
   * a hand-edited record, a restore from a partial backup — must not abort
   * this migration and blame it for damage it never touched: on upgrade,
   * `createDatabase` would throw at startup, the server would not boot, and
   * migrations are forward-only, so there would be no in-product way forward.
   */
  it('does not abort on a pre-existing dangling reference the migration never touches', () => {
    connection = new Database(':memory:');
    connection.pragma('foreign_keys = ON');
    applyMigrations(connection, MIGRATIONS.filter((migration) => migration.id !== '0023-optional-runtime'));

    const now = new Date().toISOString();
    // A dangling reference with no relationship to org_agents at all. Built
    // with foreign_keys off, the only way to create it: enforcement does not
    // retroactively validate rows already on disk, only new writes, so this
    // is exactly how such a row would already exist by the time a real
    // database opens with enforcement on, as `createDatabase` always does.
    connection.pragma('foreign_keys = OFF');
    connection.prepare(`
      INSERT INTO platform_ventures (id, portfolio_id, name, kind, mission, status, created_at, updated_at)
      VALUES ('dangling-venture', 'no-such-portfolio', 'V', 'research', 'M', 'active', ?, ?)
    `).run(now, now);
    connection.pragma('foreign_keys = ON');

    expect(() => applyMigrations(connection!)).not.toThrow();

    const runtimeColumn = connection
      .prepare("SELECT \"notnull\" FROM pragma_table_info('org_agents') WHERE name = 'runtime_id'")
      .get() as { notnull: number };
    expect(runtimeColumn.notnull).toBe(0);

    // Ignored, not silently repaired: the migration did not touch it either way.
    expect(
      connection.prepare('SELECT portfolio_id FROM platform_ventures WHERE id = ?').get('dangling-venture'),
    ).toEqual({ portfolio_id: 'no-such-portfolio' });
  });

  /**
   * The fix for the false positive above must not weaken the guard it
   * exists in: a violation the rebuild's own copy step introduces has to
   * still abort it. Exercised through a synthetic migration (rather than
   * 0023 itself) so this proves the framework mechanism, decoupled from
   * whether 0023's own SQL happens to be correct.
   */
  it('still aborts when the rebuild itself introduces a new dangling reference', () => {
    connection = new Database(':memory:');
    connection.pragma('foreign_keys = ON');
    applyMigrations(connection);

    const now = new Date().toISOString();
    connection.prepare(`
      INSERT INTO agents (id, name, kind, command, args_json, prompt_transport, output_format,
        version_args_json, option_templates_json, option_values_json, env_json, enabled,
        is_coordinator, timeout_ms, created_at, updated_at)
      VALUES ('rt-loss', 'Runtime', 'custom', 'rt', '[]', 'argument', 'text', '[]', '{}', '{}', '{}', 1, 0, 60000, ?, ?)
    `).run(now, now);
    connection.prepare(`
      INSERT INTO org_agents (id, organization_id, name, job_title, department, job_function,
        responsibilities, instructions, runtime_id, manager_id, authority_level, can_delegate,
        enabled, tenure, created_at, updated_at)
      VALUES ('will-be-lost', 'default-org', 'Lost', 'T', 'D', 'F', 'R', '', 'rt-loss', NULL, 50, 0, 1, 'hired', ?, ?)
    `).run(now, now);
    connection.prepare(`
      INSERT INTO platform_portfolios (id, name, owner_user_id, created_at, updated_at)
      VALUES ('pf-loss', 'Portfolio', 'owner', ?, ?)
    `).run(now, now);
    connection.prepare(`
      INSERT INTO platform_ventures (id, portfolio_id, name, kind, mission, status, created_at, updated_at)
      VALUES ('v-loss', 'pf-loss', 'Venture', 'research', 'M', 'active', ?, ?)
    `).run(now, now);
    connection.prepare(`
      INSERT INTO platform_projects (id, venture_id, name, objective, success_criteria_json,
        constraints_json, zero_first, lifecycle, supervision_policy, workspace_mode, created_at, updated_at)
      VALUES ('proj-loss', 'v-loss', 'Project', 'Objective', '[]', '[]', 0, 'active', 'auto', 'local', ?, ?)
    `).run(now, now);
    connection.prepare(`
      INSERT INTO cards (id, project_id, title, created_at, updated_at)
      VALUES ('card-loss', 'proj-loss', 'Card', ?, ?)
    `).run(now, now);
    // A NOT NULL, no-ON-DELETE reference into org_agents — row loss here is
    // exactly the case the guard exists for.
    connection.prepare(`
      INSERT INTO agent_runs (id, card_id, org_agent_id, status, started_at)
      VALUES ('run-loss', 'card-loss', 'will-be-lost', 'running', ?)
    `).run(now);

    const buggyRebuild: Migration = {
      id: '9010-buggy-rebuild',
      rebuildsReferencedTable: true,
      sql: `
        CREATE TABLE org_agents_new (
          id TEXT PRIMARY KEY, organization_id TEXT NOT NULL DEFAULT 'default-org',
          name TEXT NOT NULL, job_title TEXT NOT NULL, department TEXT NOT NULL,
          job_function TEXT NOT NULL, responsibilities TEXT NOT NULL,
          instructions TEXT NOT NULL DEFAULT '', runtime_id TEXT REFERENCES agents(id),
          manager_id TEXT REFERENCES org_agents(id) ON DELETE SET NULL,
          authority_level INTEGER NOT NULL DEFAULT 50, can_delegate INTEGER NOT NULL DEFAULT 0,
          model TEXT, speed TEXT, effort TEXT, enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, venture_id TEXT,
          department_id TEXT, tenure TEXT NOT NULL DEFAULT 'hired', expiry_kind TEXT,
          expiry_at TEXT, dedication TEXT NOT NULL DEFAULT 'shared', dedication_reason TEXT,
          doctrine_edited_at TEXT, tuning_edited_at TEXT, reports_to_user_id TEXT
        );
        -- The bug: silently excludes the row agent_runs still points at.
        INSERT INTO org_agents_new (
          id, organization_id, name, job_title, department, job_function, responsibilities,
          instructions, runtime_id, manager_id, authority_level, can_delegate, model, speed,
          effort, enabled, created_at, updated_at, venture_id, department_id, tenure,
          expiry_kind, expiry_at, dedication, dedication_reason, doctrine_edited_at,
          tuning_edited_at, reports_to_user_id
        )
        SELECT
          id, organization_id, name, job_title, department, job_function, responsibilities,
          instructions, runtime_id, manager_id, authority_level, can_delegate, model, speed,
          effort, enabled, created_at, updated_at, venture_id, department_id, tenure,
          expiry_kind, expiry_at, dedication, dedication_reason, doctrine_edited_at,
          tuning_edited_at, reports_to_user_id
        FROM org_agents WHERE id <> 'will-be-lost';
        DROP TABLE org_agents;
        ALTER TABLE org_agents_new RENAME TO org_agents;
      `,
    };

    expect(() => applyMigrations(connection!, [buggyRebuild])).toThrow(/dangling foreign keys/i);

    // Rolled back, not half-applied: the row the buggy copy dropped is still there.
    expect(connection.prepare('SELECT id FROM org_agents WHERE id = ?').get('will-be-lost'))
      .toEqual({ id: 'will-be-lost' });
    // Forward-only, and a failed migration leaves the ledger untouched.
    expect(
      connection.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get('9010-buggy-rebuild'),
    ).toBeUndefined();
  });
});
