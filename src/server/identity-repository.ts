import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  hasVentureAccess,
  type CreateUserInput,
  type User,
  type UserRole,
} from '../shared/identity.js';

interface UserRow {
  id: string;
  display_name: string;
  role: UserRole;
  enabled: number;
  created_at: string;
  updated_at: string;
}

const mapUser = (row: UserRow): User => ({
  id: row.id,
  displayName: row.display_name,
  role: row.role,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface IdentityRepository {
  createUser(input: CreateUserInput): User;
  getUser(userId: string): User | null;
  getOwner(): User | null;
  listUsers(): User[];
  setUserEnabled(userId: string, enabled: boolean): User;
  grantVentureAccess(userId: string, ventureId: string): void;
  revokeVentureAccess(userId: string, ventureId: string): void;
  listAccessibleVentureIds(userId: string): string[];
  /** Throws unless the user may reach this venture. Deny by default. */
  assertVentureAccess(userId: string, ventureId: string): User;
  /** Throws unless the user holds one of the given roles. */
  assertRole(userId: string, roles: readonly UserRole[]): User;
}

export function createIdentityRepository(connection: Database.Database): IdentityRepository {
  const getUser = (userId: string): User | null => {
    const row = connection.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
      | UserRow
      | undefined;
    return row ? mapUser(row) : null;
  };

  const requireUser = (userId: string): User => {
    const user = getUser(userId);
    if (!user) throw new Error(`User not found: ${userId}`);
    return user;
  };

  const listAccessibleVentureIds = (userId: string): string[] =>
    connection
      .prepare('SELECT venture_id FROM user_venture_grants WHERE user_id = ? ORDER BY granted_at')
      .all(userId)
      .map((row) => (row as { venture_id: string }).venture_id);

  return {
    createUser(input) {
      const existingOwner = connection.prepare("SELECT id FROM users WHERE role = 'owner'").get();
      if (input.role === 'owner' && existingOwner) {
        throw new Error('An owner already exists; a portfolio has exactly one owner');
      }
      const now = new Date().toISOString();
      const user: User = {
        id: randomUUID(),
        displayName: input.displayName,
        role: input.role,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      connection
        .prepare(`
          INSERT INTO users (id, display_name, role, enabled, created_at, updated_at)
          VALUES (@id, @displayName, @role, 1, @createdAt, @updatedAt)
        `)
        .run(user);
      return user;
    },

    getUser,

    getOwner() {
      const row = connection.prepare("SELECT * FROM users WHERE role = 'owner'").get() as
        | UserRow
        | undefined;
      return row ? mapUser(row) : null;
    },

    listUsers() {
      return connection
        .prepare('SELECT * FROM users ORDER BY created_at, rowid')
        .all()
        .map((row) => mapUser(row as UserRow));
    },

    setUserEnabled(userId, enabled) {
      requireUser(userId);
      connection
        .prepare('UPDATE users SET enabled = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, new Date().toISOString(), userId);
      return requireUser(userId);
    },

    grantVentureAccess(userId, ventureId) {
      requireUser(userId);
      connection
        .prepare(`
          INSERT OR IGNORE INTO user_venture_grants (user_id, venture_id, granted_at)
          VALUES (?, ?, ?)
        `)
        .run(userId, ventureId, new Date().toISOString());
    },

    revokeVentureAccess(userId, ventureId) {
      connection
        .prepare('DELETE FROM user_venture_grants WHERE user_id = ? AND venture_id = ?')
        .run(userId, ventureId);
    },

    listAccessibleVentureIds,

    assertVentureAccess(userId, ventureId) {
      const user = requireUser(userId);
      if (!user.enabled) throw new Error(`Access denied: user is disabled: ${userId}`);
      if (!hasVentureAccess(user, ventureId, listAccessibleVentureIds(userId))) {
        throw new Error(`Access denied: ${userId} may not reach venture ${ventureId}`);
      }
      return user;
    },

    assertRole(userId, roles) {
      const user = requireUser(userId);
      if (!user.enabled) throw new Error(`Access denied: user is disabled: ${userId}`);
      if (!roles.includes(user.role)) {
        throw new Error(`Action not permitted for role ${user.role}: ${userId}`);
      }
      return user;
    },
  };
}
