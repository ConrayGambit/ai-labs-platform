import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface Migration {
  /** Ordered, stable identifier. Never renamed after it has been applied anywhere. */
  id: string;
  /**
   * The statements this migration applies. This string IS the migration's
   * identity: it is what gets checksummed.
   */
  sql: string;
}

// A migration is SQL and nothing else. An escape hatch for arbitrary code was
// tried and removed: it could not be checksummed without reintroducing the
// build-dependence this design exists to avoid, and every backfill it carried was
// already redundant with the CREATE TABLE statements above it.

/**
 * Detects a migration edited after it was applied, which silently diverges
 * databases.
 *
 * Hashes the SQL text, never the function source. `Function.prototype.toString`
 * returns the text as written, and the TypeScript compiler both re-indents it and
 * strips type annotations — so a checksum over a function body differs between the
 * built server (`npm start`) and the source build (`npm run dev`, vitest), and a
 * database created by one refuses to open under the other. A template literal is
 * preserved verbatim through compilation; a function body is not.
 *
 * Whitespace is normalised so reformatting is not mistaken for a change of meaning.
 *
 * Guarded by tests/server/migration-checksum.test.ts.
 */
function checksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql.replace(/\s+/g, ' ').trim()).digest('hex');
}

/**
 * Applies pending migrations in list order, each in its own transaction.
 * Returns the ids applied by this call. Forward-only by design: a mistake is
 * corrected by a new migration, never by editing an applied one.
 */
export function applyMigrations(
  connection: Database.Database,
  migrations: Migration[] = MIGRATIONS,
): string[] {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const read = connection.prepare('SELECT checksum FROM schema_migrations WHERE id = ?');
  const record = connection.prepare(
    'INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)',
  );

  const applied: string[] = [];
  for (const migration of migrations) {
    const digest = checksum(migration);
    const existing = read.get(migration.id) as { checksum: string } | undefined;
    if (existing) {
      if (existing.checksum !== digest) {
        throw new Error(
          `Migration ${migration.id} has a different checksum than the one applied to this ` +
            'database. Migrations are forward-only; add a new migration instead of editing one.',
        );
      }
      continue;
    }
    connection.transaction(() => {
      connection.exec(migration.sql);
      record.run(migration.id, digest, new Date().toISOString());
    })();
    applied.push(migration.id);
  }
  return applied;
}

/**
 * The ordered migration list. Append only.
 *
 * `0001-baseline` adopts the schema that createDatabase() previously created
 * inline. Every statement keeps IF NOT EXISTS, so an existing database is a
 * no-op and is simply recorded as migrated rather than rebuilt.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: '0001-baseline',
    sql: `
        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL,
          command TEXT NOT NULL,
          args_json TEXT NOT NULL,
          prompt_transport TEXT NOT NULL DEFAULT 'argument',
          output_format TEXT NOT NULL DEFAULT 'text',
          result_field TEXT,
          version_args_json TEXT NOT NULL DEFAULT '["--version"]',
          option_templates_json TEXT NOT NULL DEFAULT '{}',
          option_values_json TEXT NOT NULL DEFAULT '{}',
          env_json TEXT NOT NULL DEFAULT '{}',
          enabled INTEGER NOT NULL DEFAULT 1,
          is_coordinator INTEGER NOT NULL DEFAULT 0,
          timeout_ms INTEGER NOT NULL DEFAULT 600000,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '#7170ff',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS skills (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT 'custom',
          source_url TEXT NOT NULL DEFAULT '',
          install_command TEXT NOT NULL DEFAULT '',
          instructions TEXT NOT NULL DEFAULT '',
          builtin INTEGER NOT NULL DEFAULT 0,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS org_agent_skills (
          org_agent_id TEXT NOT NULL REFERENCES org_agents(id) ON DELETE CASCADE,
          skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY(org_agent_id, skill_id)
        );

        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL DEFAULT 'default-org',
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '#7170ff',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS org_agents (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL DEFAULT 'default-org',
          name TEXT NOT NULL,
          job_title TEXT NOT NULL,
          department TEXT NOT NULL,
          job_function TEXT NOT NULL,
          responsibilities TEXT NOT NULL,
          instructions TEXT NOT NULL DEFAULT '',
          runtime_id TEXT NOT NULL REFERENCES agents(id),
          manager_id TEXT REFERENCES org_agents(id) ON DELETE SET NULL,
          authority_level INTEGER NOT NULL DEFAULT 50 CHECK(authority_level BETWEEN 0 AND 100),
          can_delegate INTEGER NOT NULL DEFAULT 0,
          model TEXT,
          speed TEXT,
          effort TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK(manager_id IS NULL OR manager_id <> id)
        );

        CREATE INDEX IF NOT EXISTS org_agents_manager ON org_agents(manager_id);

        CREATE TABLE IF NOT EXISTS project_agent_assignments (
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          org_agent_id TEXT NOT NULL REFERENCES org_agents(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          PRIMARY KEY(project_id, org_agent_id)
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'backlog',
          priority TEXT NOT NULL DEFAULT 'medium',
          assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS tasks_board_order ON tasks(project_id, status, position);

        CREATE TABLE IF NOT EXISTS runs (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          mode TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          coordinator_agent_id TEXT NOT NULL REFERENCES agents(id),
          root_org_agent_id TEXT REFERENCES org_agents(id) ON DELETE SET NULL,
          error TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
          org_agent_id TEXT REFERENCES org_agents(id) ON DELETE SET NULL,
          phase TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS messages_run_timeline ON messages(run_id, created_at);
      `,
  },
  {
    id: '0002-identity',
    sql: `
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('owner', 'staff', 'observer')),
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- Exactly one owner, enforced by the database rather than by convention.
        CREATE UNIQUE INDEX IF NOT EXISTS users_single_owner
          ON users(role) WHERE role = 'owner';

        CREATE TABLE IF NOT EXISTS user_venture_grants (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          venture_id TEXT NOT NULL,
          granted_at TEXT NOT NULL,
          PRIMARY KEY (user_id, venture_id)
        );

        CREATE INDEX IF NOT EXISTS user_venture_grants_venture
          ON user_venture_grants(venture_id);
      `,
  },
  {
    id: '0003-org-tenure',
    sql: `
        CREATE TABLE IF NOT EXISTS departments (
          id TEXT PRIMARY KEY,
          venture_id TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (venture_id, name)
        );

        ALTER TABLE org_agents ADD COLUMN venture_id TEXT;
        ALTER TABLE org_agents ADD COLUMN department_id TEXT REFERENCES departments(id);
        ALTER TABLE org_agents ADD COLUMN tenure TEXT NOT NULL DEFAULT 'hired'
          CHECK(tenure IN ('permanent', 'hired', 'temporary'));
        ALTER TABLE org_agents ADD COLUMN expiry_kind TEXT;
        ALTER TABLE org_agents ADD COLUMN expiry_at TEXT;
        ALTER TABLE org_agents ADD COLUMN dedication TEXT NOT NULL DEFAULT 'shared'
          CHECK(dedication IN ('shared', 'dedicated'));
        ALTER TABLE org_agents ADD COLUMN dedication_reason TEXT;

        CREATE INDEX IF NOT EXISTS org_agents_venture ON org_agents(venture_id);
        CREATE INDEX IF NOT EXISTS departments_venture ON departments(venture_id);

        -- The seeded executive team is permanent staff, in existing databases too.
        UPDATE org_agents SET tenure = 'permanent' WHERE id LIKE 'exec-%';
      `,
  },
  {
    id: '0003b-reseed-markers',
    sql: `
        -- Seeding updates doctrine text only where the owner has not edited it,
        -- and never touches model, speed, effort or runtime after first insert.
        ALTER TABLE org_agents ADD COLUMN doctrine_edited_at TEXT;
        ALTER TABLE org_agents ADD COLUMN tuning_edited_at TEXT;
      `,
  },
  {
    id: '0003c-org-graph',
    sql: `
        ALTER TABLE org_agents ADD COLUMN reports_to_user_id TEXT REFERENCES users(id);

        -- The Chief of Staff becomes a coordinating layer rather than a peer.
        UPDATE org_agents
           SET manager_id = 'exec-chief-of-staff'
         WHERE id IN ('exec-cto', 'exec-cmo', 'exec-cdo')
           AND manager_id = 'exec-ceo';
      `,
  },
  {
    id: '0004-platform-foundation',
    sql: `
        CREATE TABLE IF NOT EXISTS platform_portfolios (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_user_id TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS platform_ventures (
          id TEXT PRIMARY KEY,
          portfolio_id TEXT NOT NULL REFERENCES platform_portfolios(id) ON DELETE CASCADE,
          name TEXT NOT NULL, kind TEXT NOT NULL, mission TEXT NOT NULL,
          status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS platform_projects (
          id TEXT PRIMARY KEY,
          venture_id TEXT NOT NULL REFERENCES platform_ventures(id) ON DELETE CASCADE,
          name TEXT NOT NULL, objective TEXT NOT NULL,
          success_criteria_json TEXT NOT NULL, constraints_json TEXT NOT NULL,
          zero_first INTEGER NOT NULL, lifecycle TEXT NOT NULL,
          supervision_policy TEXT NOT NULL, workspace_mode TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS platform_approvals (
          id TEXT PRIMARY KEY,
          portfolio_id TEXT NOT NULL REFERENCES platform_portfolios(id) ON DELETE CASCADE,
          venture_id TEXT NOT NULL REFERENCES platform_ventures(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL,
          requested_by_org_agent_id TEXT, decided_by_user_id TEXT, decision_note TEXT,
          created_at TEXT NOT NULL, decided_at TEXT
        );
        CREATE TABLE IF NOT EXISTS platform_events (
          id TEXT PRIMARY KEY,
          portfolio_id TEXT NOT NULL REFERENCES platform_portfolios(id) ON DELETE CASCADE,
          venture_id TEXT, project_id TEXT, type TEXT NOT NULL,
          actor_type TEXT NOT NULL, actor_id TEXT, payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS platform_idempotency_keys (
          operation TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
          approval_id TEXT NOT NULL REFERENCES platform_approvals(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL, PRIMARY KEY (operation, key)
        );
        CREATE INDEX IF NOT EXISTS platform_events_portfolio_time
          ON platform_events(portfolio_id, created_at);

        -- The outbox row is written in the same transaction as its event, so an
        -- event can never exist unmirrored.
        CREATE TABLE IF NOT EXISTS platform_export_outbox (
          event_id TEXT PRIMARY KEY REFERENCES platform_events(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
          available_at TEXT NOT NULL, last_error_code TEXT, completed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS platform_export_outbox_ready
          ON platform_export_outbox(status, available_at);
        INSERT OR IGNORE INTO platform_export_outbox (event_id, status, attempts, available_at)
          SELECT id, 'pending', 0, created_at FROM platform_events;

        CREATE TABLE IF NOT EXISTS platform_owner_defaults (
          owner_user_id TEXT PRIMARY KEY,
          portfolio_id TEXT NOT NULL UNIQUE REFERENCES platform_portfolios(id) ON DELETE CASCADE
        );
      `,
  },
  {
    id: '0005-owner-user',
    // The platform layer identified its owner by an opaque string while the users
    // table held generated ids, so the two identity concepts could never match and
    // "who approved this" named nothing. Seeding the owner with the well-known id
    // the platform layer already uses reconciles them without touching any row.
    //
    // A database-level foreign key from platform_portfolios.owner_user_id is
    // deliberately NOT added here: SQLite cannot add a constraint to an existing
    // table, the rebuild would have to drop a table that platform_ventures and
    // platform_approvals reference, and the required PRAGMA foreign_keys=off
    // cannot run inside the transaction each migration is wrapped in. Ownership
    // is enforced in the repository layer instead, which is the only writer.
    sql: `
        INSERT OR IGNORE INTO users (id, display_name, role, enabled, created_at, updated_at)
        SELECT 'owner', 'Owner', 'owner', 1,
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
               strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner');
      `,
  },
  {
    id: '0006-project-merge',
    // One project concept. The legacy `projects` table is left in place and
    // unused rather than dropped: deleting rows a user may still need is not a
    // migration's decision. A later migration removes it once the desk modules
    // land and anything worth keeping has been carried across.
    sql: `
        ALTER TABLE platform_projects ADD COLUMN repository_path TEXT;
        CREATE INDEX IF NOT EXISTS platform_projects_venture ON platform_projects(venture_id);
      `,
  },
  {
    id: '0007-idempotency-owner',
    // An idempotency key is a claim on a prior result, so it belongs to whoever
    // made that request. Without an owner recorded, replaying a known key was
    // enough to be handed another owner's project and approval.
    sql: `
        ALTER TABLE platform_idempotency_keys ADD COLUMN owner_user_id TEXT;
      `,
  },
  {
    id: '0008-cards',
    // The board agents actually work off. Cards hang off the merged project, not
    // the legacy `projects` table.
    //
    // `owner_notes` lives on the card rather than in a general text field so the
    // one column agents must never write is a column, not a convention.
    sql: `
        CREATE TABLE IF NOT EXISTS cards (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES platform_projects(id) ON DELETE CASCADE,
          parent_card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'backlog'
            CHECK(status IN ('backlog','ready','in_progress','review','blocked','done')),
          priority TEXT NOT NULL DEFAULT 'medium'
            CHECK(priority IN ('urgent','high','medium','low')),
          assignee_org_agent_id TEXT REFERENCES org_agents(id) ON DELETE SET NULL,
          owner_notes TEXT NOT NULL DEFAULT '',
          position INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK(parent_card_id IS NULL OR parent_card_id <> id)
        );
        CREATE INDEX IF NOT EXISTS cards_board ON cards(project_id, status, position);

        CREATE TABLE IF NOT EXISTS card_activity (
          id TEXT PRIMARY KEY,
          card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          actor_type TEXT NOT NULL CHECK(actor_type IN ('user','org_agent','system')),
          actor_id TEXT,
          kind TEXT NOT NULL
            CHECK(kind IN ('created','moved','assigned','notes_changed','artifact_attached','commented')),
          detail TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          CHECK(NOT (actor_type = 'org_agent' AND kind = 'notes_changed'))
        );
        CREATE INDEX IF NOT EXISTS card_activity_card ON card_activity(card_id, sequence);

        CREATE TABLE IF NOT EXISTS card_artifacts (
          id TEXT PRIMARY KEY,
          card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
          run_id TEXT,
          kind TEXT NOT NULL CHECK(kind IN ('file','diff','link','report')),
          label TEXT NOT NULL,
          location TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS card_artifacts_card ON card_artifacts(card_id, created_at);
      `,
  },
];
