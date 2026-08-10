import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  canReview,
  type AssignRoleInput,
  type ReviewAssignment,
  type ReviewerIdentity,
} from '../shared/governance.js';
import type { GateId } from '../shared/work.js';

interface AssignmentRow {
  id: string;
  card_id: string;
  gate_id: GateId;
  role: ReviewAssignment['role'];
  org_agent_id: string;
  assigned_at: string;
}

const mapAssignment = (row: AssignmentRow): ReviewAssignment => ({
  id: row.id,
  cardId: row.card_id,
  gateId: row.gate_id,
  role: row.role,
  orgAgentId: row.org_agent_id,
  assignedAt: row.assigned_at,
});

export interface GovernanceRepository {
  /**
   * Puts an agent in a role on one card at one gate.
   *
   * Refuses a builder reviewing its own work, a reviewer running the builder's
   * model, and a second builder. Assigning somebody already in that role is
   * harmless — that is what a user expects.
   */
  assignRole(input: AssignRoleInput): ReviewAssignment;
  listAssignments(cardId: string, gateId: GateId): ReviewAssignment[];
  getBuilder(cardId: string, gateId: GateId): ReviewAssignment | null;
  listReviewers(cardId: string, gateId: GateId): ReviewAssignment[];
}

export function createGovernanceRepository(connection: Database.Database): GovernanceRepository {
  const selectAssignments = connection.prepare(
    'SELECT * FROM review_assignments WHERE card_id = ? AND gate_id = ? ORDER BY role, assigned_at',
  );

  const selectBuilder = connection.prepare(
    "SELECT * FROM review_assignments WHERE card_id = ? AND gate_id = ? AND role = 'builder'",
  );

  /** The identity fields that decide review eligibility, and nothing more. */
  const identityOf = (orgAgentId: string): ReviewerIdentity => {
    const row = connection
      .prepare('SELECT id, model, runtime_id FROM org_agents WHERE id = ?')
      .get(orgAgentId) as { id: string; model: string | null; runtime_id: string } | undefined;
    if (!row) throw new Error(`Organizational agent not found: ${orgAgentId}`);
    return { id: row.id, model: row.model, runtimeId: row.runtime_id };
  };

  const getBuilder = (cardId: string, gateId: GateId): ReviewAssignment | null => {
    const row = selectBuilder.get(cardId, gateId) as AssignmentRow | undefined;
    return row ? mapAssignment(row) : null;
  };

  return {
    assignRole(input) {
      return connection.transaction(() => {
        const existing = connection
          .prepare(
            'SELECT * FROM review_assignments WHERE card_id = ? AND gate_id = ? AND org_agent_id = ?',
          )
          .get(input.cardId, input.gateId, input.orgAgentId) as AssignmentRow | undefined;
        // Already in this role: harmless, and the same answer as the first time.
        if (existing && existing.role === input.role) return mapAssignment(existing);

        const builder = getBuilder(input.cardId, input.gateId);
        if (input.role === 'builder' && builder) {
          throw new Error(
            `Card already has a builder at ${input.gateId}: ${builder.orgAgentId}`,
          );
        }
        if (input.role === 'reviewer') {
          const eligibility = canReview(
            identityOf(input.orgAgentId),
            builder ? identityOf(builder.orgAgentId) : null,
          );
          if (!eligibility.allowed) throw new Error(eligibility.reason);
        }

        const id = randomUUID();
        connection.prepare(`
          INSERT INTO review_assignments (id, card_id, gate_id, role, org_agent_id, assigned_at)
          VALUES (@id, @cardId, @gateId, @role, @orgAgentId, @assignedAt)
        `).run({ ...input, id, assignedAt: new Date().toISOString() });
        return mapAssignment(
          connection.prepare('SELECT * FROM review_assignments WHERE id = ?').get(id) as AssignmentRow,
        );
      })();
    },

    listAssignments: (cardId, gateId) =>
      (selectAssignments.all(cardId, gateId) as AssignmentRow[]).map(mapAssignment),

    getBuilder,

    listReviewers: (cardId, gateId) =>
      (connection
        .prepare(
          "SELECT * FROM review_assignments WHERE card_id = ? AND gate_id = ? AND role = 'reviewer' ORDER BY assigned_at",
        )
        .all(cardId, gateId) as AssignmentRow[]).map(mapAssignment),
  };
}
