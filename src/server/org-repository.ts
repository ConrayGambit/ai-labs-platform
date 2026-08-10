import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CreateDepartmentInput, Department, Tenure } from '../shared/org.js';

interface DepartmentRow {
  id: string;
  venture_id: string;
  name: string;
  created_at: string;
}

const mapDepartment = (row: DepartmentRow): Department => ({
  id: row.id,
  ventureId: row.venture_id,
  name: row.name,
  createdAt: row.created_at,
});

export interface OrgRepository {
  createDepartment(input: CreateDepartmentInput): Department;
  listDepartments(ventureId: string): Department[];
  assignAgentToVenture(orgAgentId: string, ventureId: string, departmentId: string | null): void;
  /** Places an organizational agent under a human. The owner sits at the root. */
  setReportsToUser(orgAgentId: string, userId: string | null): void;
  /**
   * Ends a temporary or hired agent's tenure. Deactivates rather than deletes:
   * work products, transcripts and findings stay attributed to it permanently.
   */
  expireAgent(orgAgentId: string): void;
  /**
   * Removes a non-permanent agent, re-parenting its direct reports to its own
   * manager. Never nulls a reporting line — a silently flattened org chart is a
   * defect, not a recovery.
   */
  deleteOrgAgent(orgAgentId: string): void;
  listExpiredAgents(now: string): string[];
  /**
   * Edits doctrine text and marks it owner-edited, after which seeding leaves it
   * alone. Seed corrections still reach agents whose doctrine is untouched.
   */
  setDoctrine(
    orgAgentId: string,
    fields: {
      jobFunction?: string;
      responsibilities?: string;
      instructions?: string;
      department?: string;
    },
  ): void;
  /**
   * Edits runtime and model selection. These belong to the owner and are never
   * written by seeding after first insert.
   */
  setTuning(
    orgAgentId: string,
    fields: { runtimeId?: string; model?: string | null; speed?: string | null; effort?: string | null },
  ): void;
}

export function createOrgRepository(connection: Database.Database): OrgRepository {
  const readAgent = (orgAgentId: string) =>
    connection
      .prepare('SELECT id, manager_id, tenure, enabled FROM org_agents WHERE id = ?')
      .get(orgAgentId) as
      | { id: string; manager_id: string | null; tenure: Tenure; enabled: number }
      | undefined;

  const requireAgent = (orgAgentId: string) => {
    const agent = readAgent(orgAgentId);
    if (!agent) throw new Error(`Organizational agent not found: ${orgAgentId}`);
    return agent;
  };

  const directReportsOf = (orgAgentId: string) =>
    connection.prepare('SELECT id FROM org_agents WHERE manager_id = ?').all(orgAgentId) as Array<{
      id: string;
    }>;

  return {
    createDepartment(input) {
      const department: Department = {
        id: randomUUID(),
        ventureId: input.ventureId,
        name: input.name,
        createdAt: new Date().toISOString(),
      };
      connection
        .prepare(`
          INSERT INTO departments (id, venture_id, name, created_at)
          VALUES (@id, @ventureId, @name, @createdAt)
        `)
        .run(department);
      return department;
    },

    listDepartments(ventureId) {
      return connection
        .prepare('SELECT * FROM departments WHERE venture_id = ? ORDER BY created_at, rowid')
        .all(ventureId)
        .map((row) => mapDepartment(row as DepartmentRow));
    },

    assignAgentToVenture(orgAgentId, ventureId, departmentId) {
      requireAgent(orgAgentId);
      if (departmentId !== null) {
        const department = connection
          .prepare('SELECT venture_id FROM departments WHERE id = ?')
          .get(departmentId) as { venture_id: string } | undefined;
        if (!department) throw new Error(`Department not found: ${departmentId}`);
        if (department.venture_id !== ventureId) {
          throw new Error(`Department ${departmentId} does not belong to venture ${ventureId}`);
        }
      }
      connection
        .prepare(
          'UPDATE org_agents SET venture_id = ?, department_id = ?, updated_at = ? WHERE id = ?',
        )
        .run(ventureId, departmentId, new Date().toISOString(), orgAgentId);
    },

    setReportsToUser(orgAgentId, userId) {
      requireAgent(orgAgentId);
      if (userId !== null) {
        const user = connection.prepare('SELECT id FROM users WHERE id = ?').get(userId);
        if (!user) throw new Error(`User not found: ${userId}`);
      }
      connection
        .prepare('UPDATE org_agents SET reports_to_user_id = ?, updated_at = ? WHERE id = ?')
        .run(userId, new Date().toISOString(), orgAgentId);
    },

    expireAgent(orgAgentId) {
      const agent = requireAgent(orgAgentId);
      if (agent.tenure === 'permanent') {
        throw new Error(`Permanent staff cannot be expired: ${orgAgentId}`);
      }
      // Expiry must not orphan reports any more than deletion may. Re-parenting to
      // the departing agent's own manager always preserves tenure ordering, since
      // that manager's rank is already at least the departing agent's, which is
      // already at least any report's.
      const reports = directReportsOf(orgAgentId);
      if (reports.length > 0 && agent.manager_id === null) {
        throw new Error(
          `Cannot expire ${orgAgentId}: it has direct reports and no manager to re-parent them to.`,
        );
      }
      connection.transaction(() => {
        const now = new Date().toISOString();
        for (const report of reports) {
          connection
            .prepare('UPDATE org_agents SET manager_id = ?, updated_at = ? WHERE id = ?')
            .run(agent.manager_id, now, report.id);
        }
        // Release assignments so the work surfaces to a lead rather than vanishing.
        connection
          .prepare('DELETE FROM project_agent_assignments WHERE org_agent_id = ?')
          .run(orgAgentId);
        connection
          .prepare('UPDATE org_agents SET enabled = 0, updated_at = ? WHERE id = ?')
          .run(now, orgAgentId);
      })();
    },

    deleteOrgAgent(orgAgentId) {
      const agent = requireAgent(orgAgentId);
      if (agent.tenure === 'permanent') {
        throw new Error(
          `Permanent staff cannot be deleted: ${orgAgentId}. Deactivate instead — and that is a ` +
            'protected action.',
        );
      }
      const reports = directReportsOf(orgAgentId);
      if (reports.length > 0 && agent.manager_id === null) {
        throw new Error(
          `Cannot remove ${orgAgentId}: it has direct reports and no manager to re-parent them to.`,
        );
      }
      connection.transaction(() => {
        const now = new Date().toISOString();
        for (const report of reports) {
          connection
            .prepare('UPDATE org_agents SET manager_id = ?, updated_at = ? WHERE id = ?')
            .run(agent.manager_id, now, report.id);
        }
        connection.prepare('DELETE FROM org_agents WHERE id = ?').run(orgAgentId);
      })();
    },

    setDoctrine(orgAgentId, fields) {
      requireAgent(orgAgentId);
      const now = new Date().toISOString();
      const sets: string[] = [];
      const values: unknown[] = [];
      const column: Record<string, string> = {
        jobFunction: 'job_function',
        responsibilities: 'responsibilities',
        instructions: 'instructions',
        department: 'department',
      };
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        sets.push(`${column[key]} = ?`);
        values.push(value);
      }
      if (sets.length === 0) return;
      connection
        .prepare(
          `UPDATE org_agents SET ${sets.join(', ')}, doctrine_edited_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(...values, now, now, orgAgentId);
    },

    setTuning(orgAgentId, fields) {
      requireAgent(orgAgentId);
      const now = new Date().toISOString();
      const sets: string[] = [];
      const values: unknown[] = [];
      const column: Record<string, string> = {
        runtimeId: 'runtime_id',
        model: 'model',
        speed: 'speed',
        effort: 'effort',
      };
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        sets.push(`${column[key]} = ?`);
        values.push(value);
      }
      if (sets.length === 0) return;
      connection
        .prepare(
          `UPDATE org_agents SET ${sets.join(', ')}, tuning_edited_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(...values, now, now, orgAgentId);
    },

    listExpiredAgents(now) {
      return connection
        .prepare(`
          SELECT id FROM org_agents
          WHERE enabled = 1 AND expiry_kind = 'date' AND expiry_at IS NOT NULL AND expiry_at <= ?
        `)
        .all(now)
        .map((row) => (row as { id: string }).id);
    },
  };
}
