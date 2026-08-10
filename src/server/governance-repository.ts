import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  canReview,
  overrideReference,
  reviewIsVisibleTo,
  type AssignRoleInput,
  type ChecklistAnswer,
  type FileReviewInput,
  type Finding,
  type FindingInput,
  type AdjudicationReport,
  type OverrideEntry,
  type Review,
  type ReviewAssignment,
  type ReviewerIdentity,
  type ReviewViewerRole,
} from '../shared/governance.js';
import { effectiveReviewerCount, type GateId } from '../shared/work.js';
import { getLadder } from './gate-policy.js';
import {
  handoverIsComplete,
  isHandoverPoint,
  isSpecificationSection,
  specificationIsComplete,
  type HandoverPoint,
  type HandoverPoints,
  type SpecificationSection,
  type SpecificationSections,
} from './governance-policy.js';

interface AssignmentRow {
  id: string;
  card_id: string;
  gate_id: GateId;
  role: ReviewAssignment['role'];
  org_agent_id: string;
  assigned_at: string;
  review_deadline_at: string | null;
}

const mapAssignment = (row: AssignmentRow): ReviewAssignment => ({
  id: row.id,
  cardId: row.card_id,
  gateId: row.gate_id,
  role: row.role,
  orgAgentId: row.org_agent_id,
  assignedAt: row.assigned_at,
  reviewDeadlineAt: row.review_deadline_at ?? null,
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
  /**
   * The reviews this viewer is allowed to read right now.
   *
   * Filters rather than throws: a viewer asking to see reviews should get the
   * ones they may see, not an error telling them others exist.
   */
  listVisibleReviews(
    cardId: string,
    gateId: GateId,
    viewer: { id: string; role: ReviewViewerRole },
  ): Review[];
  /**
   * The effective reviewer count for a gate: card override, then project
   * override, then the ladder default (spec 20.2.1). Exposed so the visibility
   * rule, the adjudication gate and the advancement rule all read one answer.
   */
  requiredReviewers(cardId: string, gateId: GateId): number;
  /**
   * Adds an entry to the override register. The ONLY writer.
   *
   * There is deliberately no update and no delete: a correction is a new entry
   * through supersedeOverride, and the database refuses anything else.
   */
  appendOverride(input: AppendOverrideInput): OverrideEntry;
  /** Corrects an entry by adding a new one and marking the original superseded. */
  supersedeOverride(input: SupersedeOverrideInput): OverrideEntry;
  listOverrides(filter: { cardId?: string }): OverrideEntry[];
  /** Merges sections into the card's specification. Never replaces it wholesale. */
  saveSpecification(input: { cardId: string; sections: SpecificationSections }): CardSpecification;
  getSpecification(cardId: string): CardSpecification | null;
  /** Sections still unwritten. A card with no specification is missing all of them. */
  missingSpecificationSections(cardId: string): SpecificationSection[];
  /** Merges points into the card's handover report. Never replaces it wholesale. */
  saveHandover(input: { cardId: string; points: HandoverPoints }): CardHandover;
  getHandover(cardId: string): CardHandover | null;
  /** Points still unwritten, counting a claimed-output section as unwritten. */
  missingHandoverPoints(cardId: string): HandoverPoint[];
  /** Stores a day's report, replacing any earlier build of the same day. */
  saveAdjudicationReport(report: AdjudicationReport): void;
  getAdjudicationReport(date: string): AdjudicationReport | null;
  listAdjudicationReports(): AdjudicationReport[];
  /** Sets when an outstanding reviewer stops being able to seal the gate. */
  setReviewDeadline(input: {
    cardId: string; gateId: GateId; orgAgentId: string; deadlineAt: string | null;
  }): void;
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

export interface CardSpecification {
  cardId: string;
  sections: SpecificationSections;
  updatedAt: string;
}

interface ReportRow {
  report_date: string;
  sections_json: string;
  built_at: string;
}

const mapReport = (row: ReportRow): AdjudicationReport => ({
  date: row.report_date,
  sections: JSON.parse(row.sections_json) as AdjudicationReport['sections'],
  builtAt: row.built_at,
});

export interface CardHandover {
  cardId: string;
  points: HandoverPoints;
  updatedAt: string;
}

export interface AppendOverrideInput {
  findingId: string | null;
  cardId: string | null;
  reviewerOrgAgentId: string | null;
  priority: OverrideEntry['priority'];
  reason: string;
  residualRisk: string;
  deferredUntil?: string | null;
  supersedesId?: string | null;
  createdByOrgAgentId: string | null;
}

export interface SupersedeOverrideInput {
  supersedesId: string;
  reason: string;
  residualRisk: string;
  createdByOrgAgentId: string | null;
}

interface OverrideRow {
  id: string;
  reference: string;
  sequence: number;
  finding_id: string | null;
  card_id: string | null;
  reviewer_org_agent_id: string | null;
  priority: OverrideEntry['priority'];
  reason: string;
  residual_risk: string;
  deferred_until: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  created_by_org_agent_id: string | null;
  created_at: string;
}

const mapOverride = (row: OverrideRow): OverrideEntry => ({
  id: row.id,
  reference: row.reference,
  sequence: row.sequence,
  findingId: row.finding_id,
  cardId: row.card_id,
  reviewerOrgAgentId: row.reviewer_org_agent_id,
  priority: row.priority,
  reason: row.reason,
  residualRisk: row.residual_risk,
  deferredUntil: row.deferred_until,
  supersedesId: row.supersedes_id,
  supersededById: row.superseded_by_id,
  createdByOrgAgentId: row.created_by_org_agent_id,
  createdAt: row.created_at,
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

  const listCurrentReviews = (cardId: string, gateId: GateId): Review[] =>
    (connection
      .prepare(
        `SELECT * FROM reviews
          WHERE card_id = ? AND gate_id = ? AND superseded_by_review_id IS NULL
          ORDER BY filed_at, id`,
      )
      .all(cardId, gateId) as ReviewRow[])
      .map((row) => mapReview(row, findingsFor(row.id)));

  /**
   * The effective reviewer count for a gate: card override, then project
   * override, then the ladder's default (spec 20.2.1). Resolved here so the
   * visibility rule and the advancement rule can never disagree about how many
   * reviews this gate wants.
   */
  const requiredReviewersFor = (cardId: string, gateId: GateId): number => {
    const card = connection
      .prepare('SELECT project_id, reviewer_count_override FROM cards WHERE id = ?')
      .get(cardId) as { project_id: string; reviewer_count_override: number | null } | undefined;
    if (!card) throw new Error(`Card not found: ${cardId}`);
    const project = connection
      .prepare('SELECT gate_ladder_id, reviewer_count_override FROM platform_projects WHERE id = ?')
      .get(card.project_id) as
        { gate_ladder_id: string | null; reviewer_count_override: number | null } | undefined;
    const gate = getLadder(project?.gate_ladder_id ?? 'product').gates
      .find((candidate) => candidate.id === gateId);
    if (!gate) throw new Error(`Gate ${gateId} is not on this project's ladder`);
    return effectiveReviewerCount(gate, {
      card: card.reviewer_count_override,
      project: project?.reviewer_count_override ?? null,
    });
  };

  /**
   * Allocates the next reference and writes the entry, in one transaction.
   *
   * The sequence is read and used inside that transaction, and the column is
   * UNIQUE, so two concurrent overrides cannot share a reference: the loser
   * fails rather than quietly reusing OV-0007.
   */
  const appendOverride = (input: AppendOverrideInput): OverrideEntry =>
    connection.transaction((): OverrideEntry => {
      const { next } = connection
        .prepare('SELECT COALESCE(MAX(sequence) + 1, 1) AS next FROM override_register')
        .get() as { next: number };
      const id = randomUUID();
      connection.prepare(`
        INSERT INTO override_register (
          id, reference, sequence, finding_id, card_id, reviewer_org_agent_id,
          priority, reason, residual_risk, deferred_until, supersedes_id,
          created_by_org_agent_id, created_at
        ) VALUES (
          @id, @reference, @sequence, @findingId, @cardId, @reviewerOrgAgentId,
          @priority, @reason, @residualRisk, @deferredUntil, @supersedesId,
          @createdByOrgAgentId, @createdAt
        )
      `).run({
        id,
        reference: overrideReference(next),
        sequence: next,
        findingId: input.findingId,
        cardId: input.cardId,
        reviewerOrgAgentId: input.reviewerOrgAgentId,
        priority: input.priority,
        reason: input.reason,
        residualRisk: input.residualRisk,
        deferredUntil: input.deferredUntil ?? null,
        supersedesId: input.supersedesId ?? null,
        createdByOrgAgentId: input.createdByOrgAgentId,
        createdAt: new Date().toISOString(),
      });
      return mapOverride(
        connection.prepare('SELECT * FROM override_register WHERE id = ?').get(id) as OverrideRow,
      );
    })();

  const getSpecification = (cardId: string): CardSpecification | null => {
    const row = connection
      .prepare('SELECT * FROM card_specifications WHERE card_id = ?')
      .get(cardId) as { card_id: string; sections_json: string; updated_at: string } | undefined;
    return row
      ? {
        cardId: row.card_id,
        sections: JSON.parse(row.sections_json) as SpecificationSections,
        updatedAt: row.updated_at,
      }
      : null;
  };

  const getHandover = (cardId: string): CardHandover | null => {
    const row = connection
      .prepare('SELECT * FROM card_handovers WHERE card_id = ?')
      .get(cardId) as { card_id: string; points_json: string; updated_at: string } | undefined;
    return row
      ? {
        cardId: row.card_id,
        points: JSON.parse(row.points_json) as HandoverPoints,
        updatedAt: row.updated_at,
      }
      : null;
  };

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

        /*
         * The gate has to be one this project's ladder actually has. Accepting
         * any of G1-G4 because the CHECK constraint allows them let a role be
         * assigned at, say, G2 on the business ladder — a state nothing could
         * later read, because every count and visibility query resolves the
         * gate through the ladder and threw. Refused at the write, where it can
         * still be reported, rather than at the read, where it is too late.
         */
        const ladderId = connection
          .prepare(
            `SELECT p.gate_ladder_id AS ladder FROM cards c
               JOIN platform_projects p ON p.id = c.project_id
              WHERE c.id = ?`,
          )
          .get(input.cardId) as { ladder: string | null } | undefined;
        if (!ladderId) throw new Error(`Card not found: ${input.cardId}`);
        const ladder = getLadder(ladderId.ladder ?? 'product');
        if (!ladder.gates.some((gate) => gate.id === input.gateId)) {
          throw new Error(
            `The ${ladder.label} ladder has no ${input.gateId} gate, so nobody can hold a role at it`,
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

    listVisibleReviews(cardId, gateId, viewer) {
      const current = listCurrentReviews(cardId, gateId);
      const required = requiredReviewersFor(cardId, gateId);
      // Distinct reviewers whose review currently stands. Counting rows instead
      // would let one reviewer unseal the gate by filing twice.
      const filedReviewerIds = [...new Set(current.map((review) => review.reviewerOrgAgentId))];
      const filedIds = new Set(filedReviewerIds);
      /*
       * The deadline that can unseal the gate belongs to a reviewer who has NOT
       * filed. Taking the minimum across every assignment let a stale deadline
       * on somebody who had already filed open the seal while another reviewer
       * was still working — the deadline unsealing the gate it exists to keep
       * shut, which is the opposite of the rule.
       */
      const stillOut = listReviewers(cardId, gateId)
        .filter((assignment) => !filedIds.has(assignment.orgAgentId));
      const outstandingDeadlines = stillOut
        .map((assignment) => assignment.reviewDeadlineAt)
        .filter((deadline): deadline is string => deadline !== null);
      // Every outstanding reviewer must be out of time, not merely one of them.
      const deadlineAt = stillOut.length > 0 && outstandingDeadlines.length === stillOut.length
        ? outstandingDeadlines.reduce((latest, deadline) => (deadline > latest ? deadline : latest))
        : null;
      const now = new Date().toISOString();

      return current.filter((review) => reviewIsVisibleTo({
        requiredReviewers: required,
        filedReviewerIds,
        reviewAuthorId: review.reviewerOrgAgentId,
        viewerId: viewer.id,
        viewerRole: viewer.role,
        now,
        deadlineAt,
      }));
    },

    setReviewDeadline(input) {
      connection
        .prepare(
          `UPDATE review_assignments SET review_deadline_at = ?
            WHERE card_id = ? AND gate_id = ? AND org_agent_id = ?`,
        )
        .run(input.deadlineAt, input.cardId, input.gateId, input.orgAgentId);
    },

    listCurrentReviews,
    requiredReviewers: requiredReviewersFor,

    appendOverride: (input) => appendOverride(input),

    supersedeOverride(input) {
      return connection.transaction((): OverrideEntry => {
        const original = connection
          .prepare('SELECT * FROM override_register WHERE id = ?')
          .get(input.supersedesId) as OverrideRow | undefined;
        if (!original) throw new Error(`Override not found: ${input.supersedesId}`);
        if (original.superseded_by_id) {
          throw new Error(
            `${original.reference} was already superseded by an entry; correct that one instead`,
          );
        }
        // The correction carries the original's subject forward: it is about
        // the same finding, so it must be findable from the same card.
        const correction = appendOverride({
          findingId: original.finding_id,
          cardId: original.card_id,
          reviewerOrgAgentId: original.reviewer_org_agent_id,
          priority: original.priority,
          reason: input.reason,
          residualRisk: input.residualRisk,
          supersedesId: original.id,
          createdByOrgAgentId: input.createdByOrgAgentId,
        });
        // The one permitted transition on an existing row: null to a value.
        connection
          .prepare('UPDATE override_register SET superseded_by_id = ? WHERE id = ?')
          .run(correction.id, original.id);
        return correction;
      })();
    },

    saveSpecification(input) {
      return connection.transaction((): CardSpecification => {
        for (const key of Object.keys(input.sections)) {
          if (!isSpecificationSection(key)) {
            // A typo that silently created a fourteenth section would leave the
            // real one blank while the card looked answered.
            throw new Error(`"${key}" is not a specification section`);
          }
        }
        const existing = getSpecification(input.cardId);
        // Merge, never replace: writing one section must not wipe the twelve
        // already written.
        const sections = { ...existing?.sections, ...input.sections };
        connection.prepare(`
          INSERT INTO card_specifications (card_id, sections_json, updated_at)
          VALUES (@cardId, @sectionsJson, @updatedAt)
          ON CONFLICT(card_id) DO UPDATE SET
            sections_json = excluded.sections_json, updated_at = excluded.updated_at
        `).run({
          cardId: input.cardId,
          sectionsJson: JSON.stringify(sections),
          updatedAt: new Date().toISOString(),
        });
        return getSpecification(input.cardId)!;
      })();
    },

    getSpecification,

    missingSpecificationSections: (cardId) =>
      specificationIsComplete(getSpecification(cardId)?.sections ?? {}).missing,

    saveHandover(input) {
      return connection.transaction((): CardHandover => {
        for (const key of Object.keys(input.points)) {
          if (!isHandoverPoint(key)) throw new Error(`"${key}" is not a handover point`);
        }
        const existing = getHandover(input.cardId);
        // Merge, never replace, for the same reason the specification does.
        const points = { ...existing?.points, ...input.points };
        connection.prepare(`
          INSERT INTO card_handovers (card_id, points_json, updated_at)
          VALUES (@cardId, @pointsJson, @updatedAt)
          ON CONFLICT(card_id) DO UPDATE SET
            points_json = excluded.points_json, updated_at = excluded.updated_at
        `).run({
          cardId: input.cardId,
          pointsJson: JSON.stringify(points),
          updatedAt: new Date().toISOString(),
        });
        return getHandover(input.cardId)!;
      })();
    },

    getHandover,

    missingHandoverPoints: (cardId) =>
      handoverIsComplete(getHandover(cardId)?.points ?? {}).missing,

    saveAdjudicationReport(report) {
      // Keyed by date, so rebuilding a day updates it rather than leaving two
      // contradictory versions of the same day in the record.
      connection.prepare(`
        INSERT INTO adjudication_reports (report_date, sections_json, built_at)
        VALUES (@date, @sectionsJson, @builtAt)
        ON CONFLICT(report_date) DO UPDATE SET
          sections_json = excluded.sections_json, built_at = excluded.built_at
      `).run({
        date: report.date,
        sectionsJson: JSON.stringify(report.sections),
        builtAt: report.builtAt,
      });
    },

    getAdjudicationReport(date) {
      const row = connection
        .prepare('SELECT * FROM adjudication_reports WHERE report_date = ?')
        .get(date) as ReportRow | undefined;
      return row ? mapReport(row) : null;
    },

    listAdjudicationReports: () =>
      (connection
        .prepare('SELECT * FROM adjudication_reports ORDER BY report_date')
        .all() as ReportRow[]).map(mapReport),

    listOverrides(filter) {
      const rows = filter.cardId
        ? connection
          .prepare('SELECT * FROM override_register WHERE card_id = ? ORDER BY sequence')
          .all(filter.cardId)
        : connection.prepare('SELECT * FROM override_register ORDER BY sequence').all();
      return (rows as OverrideRow[]).map(mapOverride);
    },
  };
}
