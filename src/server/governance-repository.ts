import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  canReview,
  type AssignRoleInput,
  type ChecklistAnswer,
  type FileReviewInput,
  type Finding,
  type FindingInput,
  type Review,
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
  /**
   * Files a review with its findings, in one transaction.
   *
   * The reviewer must hold a reviewer assignment on this card at this gate.
   * Holding a *builder* assignment is not a licence to review — that is the
   * one thing the role split exists to prevent.
   */
  fileReview(input: FileReviewInput): Review;
  getReview(reviewId: string): Review | null;
  /**
   * Every review ever filed at this gate, superseded ones included. The record
   * of what was believed at the time is itself evidence (spec 20.5).
   */
  listReviews(cardId: string, gateId: GateId): Review[];
  /**
   * The reviews that currently stand — one per reviewer, superseded excluded.
   *
   * This is what counting must use. Counting every row would let one reviewer
   * satisfy a two-reviewer gate by filing twice, which is the blind-review
   * discipline defeated by a refresh button.
   */
  listCurrentReviews(cardId: string, gateId: GateId): Review[];
}

interface ReviewRow {
  id: string;
  card_id: string;
  gate_id: GateId;
  reviewer_org_agent_id: string;
  verdict: Review['verdict'];
  checklist_json: string;
  what_to_preserve: string;
  questions_for_builder: string;
  superseded_by_review_id: string | null;
  filed_at: string;
}

interface FindingRow {
  id: string;
  review_id: string;
  priority: Finding['priority'];
  area: string;
  finding: string;
  predicted_failure: string;
  evidence: string;
  proposed_fix: string;
  created_at: string;
}

const mapFinding = (row: FindingRow): Finding => ({
  id: row.id,
  reviewId: row.review_id,
  priority: row.priority,
  area: row.area,
  finding: row.finding,
  predictedFailure: row.predicted_failure,
  evidence: row.evidence,
  proposedFix: row.proposed_fix,
  createdAt: row.created_at,
});

const mapReview = (row: ReviewRow, findings: Finding[]): Review => ({
  id: row.id,
  cardId: row.card_id,
  gateId: row.gate_id,
  reviewerOrgAgentId: row.reviewer_org_agent_id,
  verdict: row.verdict,
  checklist: JSON.parse(row.checklist_json) as ChecklistAnswer[],
  whatToPreserve: row.what_to_preserve,
  questionsForBuilder: row.questions_for_builder,
  findings,
  supersededByReviewId: row.superseded_by_review_id,
  filedAt: row.filed_at,
});

/**
 * Every reviewer answers the full checklist for the gate. "Not applicable" is
 * an acceptable answer; silence is not (spec 20.3).
 *
 * A blank answer is checked as well as a missing one, because an empty string
 * is silence that has learned to look like an answer.
 */
function assertChecklistAnswered(checklist: readonly ChecklistAnswer[]): void {
  if (checklist.length === 0) {
    throw new Error('A review must answer the gate checklist; an empty checklist is not a review');
  }
  const unanswered = checklist.filter((entry) => !entry.answer.trim()).map((entry) => entry.item);
  if (unanswered.length > 0) {
    throw new Error(
      `"Not applicable" is an answer; silence is not. Unanswered: ${unanswered.join(', ')}`,
    );
  }
}

/**
 * A finding a builder can act on.
 *
 * Evidence at `file:line` is what lets a reader go and check rather than take
 * the finding on trust, and a predicted failure is what separates a finding
 * from a worry. Without both, a review becomes a list of impressions that
 * cannot be adjudicated.
 */
function assertFindingIsActionable(finding: FindingInput): void {
  if (!finding.evidence.trim()) {
    throw new Error(`A finding needs evidence at file:line: "${finding.finding}"`);
  }
  if (!finding.predictedFailure.trim()) {
    throw new Error(
      `A finding needs a predicted failure, or it is a worry: "${finding.finding}"`,
    );
  }
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

  const listReviewers = (cardId: string, gateId: GateId): ReviewAssignment[] =>
    (connection
      .prepare(
        "SELECT * FROM review_assignments WHERE card_id = ? AND gate_id = ? AND role = 'reviewer' ORDER BY assigned_at",
      )
      .all(cardId, gateId) as AssignmentRow[]).map(mapAssignment);

  const selectReview = connection.prepare('SELECT * FROM reviews WHERE id = ?');

  const findingsFor = (reviewId: string): Finding[] =>
    (connection
      .prepare('SELECT * FROM review_findings WHERE review_id = ? ORDER BY priority, created_at')
      .all(reviewId) as FindingRow[]).map(mapFinding);

  const requireReview = (reviewId: string): Review => {
    const row = selectReview.get(reviewId) as ReviewRow | undefined;
    if (!row) throw new Error(`Review not found: ${reviewId}`);
    return mapReview(row, findingsFor(row.id));
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
        if (existing) {
          // Swapping role would make one agent both author and judge. Refused
          // with a sentence: the bare UNIQUE constraint underneath names a
          // schema index and tells an operator nothing they can act on.
          //
          // The builder-becoming-reviewer direction keeps the spec's own words,
          // because "may not review its own work" says why, and "may not hold
          // both roles" only says what.
          throw new Error(
            existing.role === 'builder'
              ? `A builder may not review its own work: ${input.orgAgentId}`
              : `${input.orgAgentId} is already the ${existing.role} on ${input.cardId} at ` +
                `${input.gateId}; an agent may not hold both roles on one gate`,
          );
        }

        const builder = getBuilder(input.cardId, input.gateId);
        if (input.role === 'builder') {
          if (builder) {
            throw new Error(
              `Card already has a builder at ${input.gateId}: ${builder.orgAgentId}`,
            );
          }
          /*
           * A builder assigned AFTER its reviewers must face the same test they
           * did. Checking only on the reviewer path left the rule defeatable by
           * ordering: assign the reviewer first, then a builder on that
           * reviewer's model, and a same-model pair sails through — which is
           * exactly the arrangement spec 20.3 exists to prevent.
           */
          const incoming = identityOf(input.orgAgentId);
          for (const reviewer of listReviewers(input.cardId, input.gateId)) {
            const eligibility = canReview(identityOf(reviewer.orgAgentId), incoming);
            if (!eligibility.allowed) {
              throw new Error(
                `${eligibility.reason}: reviewer ${reviewer.orgAgentId} is already assigned`,
              );
            }
          }
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

    listReviewers,

    fileReview(input) {
      return connection.transaction(() => {
        const isReviewer = listReviewers(input.cardId, input.gateId)
          .some((assignment) => assignment.orgAgentId === input.reviewerOrgAgentId);
        if (!isReviewer) {
          // Deliberately the same message whether the agent holds no assignment
          // or holds the builder assignment. Being the builder is not a partial
          // qualification to review; it is a disqualification.
          throw new Error(
            `${input.reviewerOrgAgentId} is not a reviewer on ${input.cardId} at ${input.gateId}`,
          );
        }
        assertChecklistAnswered(input.checklist);
        for (const finding of input.findings) assertFindingIsActionable(finding);

        const now = new Date().toISOString();
        const reviewId = randomUUID();
        connection.prepare(`
          INSERT INTO reviews (
            id, card_id, gate_id, reviewer_org_agent_id, verdict, checklist_json,
            what_to_preserve, questions_for_builder, filed_at
          ) VALUES (
            @id, @cardId, @gateId, @reviewerOrgAgentId, @verdict, @checklistJson,
            @whatToPreserve, @questionsForBuilder, @filedAt
          )
        `).run({
          id: reviewId,
          cardId: input.cardId,
          gateId: input.gateId,
          reviewerOrgAgentId: input.reviewerOrgAgentId,
          verdict: input.verdict,
          checklistJson: JSON.stringify(input.checklist),
          whatToPreserve: input.whatToPreserve,
          questionsForBuilder: input.questionsForBuilder,
          filedAt: now,
        });

        /*
         * A reviewer filing again is correcting themselves, and a correction is
         * a new entry marking the original superseded — never an edit. Leaving
         * both standing would also let one reviewer count twice toward a
         * two-reviewer gate.
         */
        const previous = connection
          .prepare(
            `SELECT id FROM reviews
              WHERE card_id = ? AND gate_id = ? AND reviewer_org_agent_id = ?
                AND superseded_by_review_id IS NULL AND id <> ?`,
          )
          .all(input.cardId, input.gateId, input.reviewerOrgAgentId, reviewId) as Array<{ id: string }>;
        for (const row of previous) {
          connection
            .prepare('UPDATE reviews SET superseded_by_review_id = ? WHERE id = ?')
            .run(reviewId, row.id);
        }

        const insertFinding = connection.prepare(`
          INSERT INTO review_findings (
            id, review_id, priority, area, finding, predicted_failure,
            evidence, proposed_fix, created_at
          ) VALUES (
            @id, @reviewId, @priority, @area, @finding, @predictedFailure,
            @evidence, @proposedFix, @createdAt
          )
        `);
        for (const finding of input.findings) {
          insertFinding.run({ ...finding, id: randomUUID(), reviewId, createdAt: now });
        }
        return requireReview(reviewId);
      })();
    },

    getReview(reviewId) {
      const row = selectReview.get(reviewId) as ReviewRow | undefined;
      return row ? mapReview(row, findingsFor(row.id)) : null;
    },

    listReviews: (cardId, gateId) =>
      (connection
        .prepare('SELECT * FROM reviews WHERE card_id = ? AND gate_id = ? ORDER BY filed_at, id')
        .all(cardId, gateId) as ReviewRow[])
        .map((row) => mapReview(row, findingsFor(row.id))),

    listCurrentReviews: (cardId, gateId) =>
      (connection
        .prepare(
          `SELECT * FROM reviews
            WHERE card_id = ? AND gate_id = ? AND superseded_by_review_id IS NULL
            ORDER BY filed_at, id`,
        )
        .all(cardId, gateId) as ReviewRow[])
        .map((row) => mapReview(row, findingsFor(row.id))),
  };
}
