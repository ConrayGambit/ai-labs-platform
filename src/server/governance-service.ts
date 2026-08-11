import { randomUUID } from 'node:crypto';
import {
  type Contest,
  type FileReviewInput,
  type Finding,
  type P0Escalation,
  type Review,
  type OverrideEntry,
  type Ruling,
  type RulingOutcome,
} from '../shared/governance.js';
import type { GateId } from '../shared/work.js';
import type { OrchestratorDatabase } from './database.js';
import { canOverride, isBlocking, isOverride } from './governance-policy.js';

export interface FileReviewResult {
  review: Review;
  /** One per P0 in this review. Empty is the ordinary case. */
  escalations: P0Escalation[];
}

export interface AdjudicateInput {
  cardId: string;
  gateId: GateId;
  findingId: string;
  outcome: RulingOutcome;
  reason: string;
  /** Required on a deferral. */
  nextStep?: string;
  residualRisk?: string;
  /** Records a deferral's date in the register. A deferral is a dated override. */
  deferredUntil?: string;
  ruledByOrgAgentId: string;
}

export interface AdjudicationResult {
  ruling: Ruling;
  /**
   * The register entry this ruling produced, or null for an adopted finding.
   *
   * Adopting is not an override: the builder agreed with the reviewer and fixed
   * it, and a register full of agreements is a register nobody reads.
   */
  registerEntry: OverrideEntry | null;
}

export interface GovernanceService {
  /**
   * The one way to file a review. Stops the card immediately on any P0.
   *
   * Escalation lives here rather than in the repository because stopping a card
   * spans two repositories, and a P0 that recorded a finding without stopping
   * the work would be a finding nobody had to act on. The repository's
   * `insertReviewRecord` writes the record and nothing else; it is deliberately
   * not named `fileReview`, because it was, and reviews filed through it left
   * P0s unescalated.
   */
  fileReview(input: FileReviewInput): FileReviewResult;
  adjudicate(input: AdjudicateInput): AdjudicationResult;
  contestRuling(input: {
    findingId: string; contestedByOrgAgentId: string; newEvidence: string;
  }): Contest;
  listRulings(findingId: string): Ruling[];
  isFindingOpen(findingId: string): boolean;
  listOpenEscalations(cardId?: string): P0Escalation[];
  resolveEscalation(input: {
    escalationId: string; resolution: string; resolvedByUserId: string;
  }): P0Escalation;
}

interface RulingRow {
  id: string;
  finding_id: string;
  ruled_by_org_agent_id: string | null;
  ruled_by_user_id: string | null;
  outcome: RulingOutcome;
  reason: string;
  next_step: string | null;
  residual_risk: string | null;
  is_final: number;
  ruled_at: string;
}

interface EscalationRow {
  id: string;
  finding_id: string;
  card_id: string;
  status: P0Escalation['status'];
  resolution: string | null;
  resolved_by_user_id: string | null;
  raised_at: string;
  resolved_at: string | null;
}

const mapRuling = (row: RulingRow): Ruling => ({
  id: row.id,
  findingId: row.finding_id,
  ruledByOrgAgentId: row.ruled_by_org_agent_id,
  ruledByUserId: row.ruled_by_user_id,
  outcome: row.outcome,
  reason: row.reason,
  nextStep: row.next_step,
  residualRisk: row.residual_risk,
  isFinal: row.is_final === 1,
  ruledAt: row.ruled_at,
});

const mapEscalation = (row: EscalationRow): P0Escalation => ({
  id: row.id,
  findingId: row.finding_id,
  cardId: row.card_id,
  status: row.status,
  resolution: row.resolution,
  resolvedByUserId: row.resolved_by_user_id,
  raisedAt: row.raised_at,
  resolvedAt: row.resolved_at,
});

export function createGovernanceService(database: OrchestratorDatabase): GovernanceService {
  const connection = database.connection;

  const findingRow = (findingId: string) => {
    const row = connection
      .prepare(
        `SELECT f.*, r.card_id, r.gate_id, r.reviewer_org_agent_id
           FROM review_findings f JOIN reviews r ON r.id = f.review_id
          WHERE f.id = ?`,
      )
      .get(findingId) as {
        id: string; priority: Finding['priority']; card_id: string;
        gate_id: GateId; reviewer_org_agent_id: string;
      } | undefined;
    if (!row) throw new Error(`Finding not found: ${findingId}`);
    return row;
  };

  const listRulings = (findingId: string): Ruling[] =>
    (connection
      .prepare('SELECT * FROM finding_rulings WHERE finding_id = ? ORDER BY sequence')
      .all(findingId) as RulingRow[]).map(mapRuling);

  const escalate = (finding: { id: string; card_id: string }): P0Escalation => {
    const id = randomUUID();
    connection.prepare(`
      INSERT INTO p0_escalations (id, finding_id, card_id, status, raised_at)
      VALUES (@id, @findingId, @cardId, 'open', @raisedAt)
    `).run({ id, findingId: finding.id, cardId: finding.card_id, raisedAt: new Date().toISOString() });

    // A P0 stops the affected work and goes to the owner (20.4.5). The move is
    // attributed to the platform, because no person chose it.
    database.work.moveCard({
      cardId: finding.card_id, to: 'blocked', position: 0,
      userId: 'system', actorType: 'system',
    });
    return mapEscalation(
      connection.prepare('SELECT * FROM p0_escalations WHERE id = ?').get(id) as EscalationRow,
    );
  };

  return {
    fileReview(input) {
      return connection.transaction((): FileReviewResult => {
        const review = database.governance.insertReviewRecord(input);
        const escalations = review.findings
          .filter((finding) => isBlocking(finding.priority))
          .map((finding) => escalate({ id: finding.id, card_id: review.cardId }));
        return { review, escalations };
      })();
    },

    adjudicate(input) {
      return connection.transaction((): AdjudicationResult => {
        const builder = database.governance.getBuilder(input.cardId, input.gateId);
        if (!builder || builder.orgAgentId !== input.ruledByOrgAgentId) {
          // The builder adjudicates. A reviewer ruling on its own finding is the
          // reviewer marking its own homework from the other direction.
          throw new Error(
            `Only the builder at ${input.gateId} may adjudicate: ${input.ruledByOrgAgentId} is not it`,
          );
        }

        const required = database.governance.requiredReviewers(input.cardId, input.gateId);
        const assigned = database.governance.listReviewers(input.cardId, input.gateId).length;
        const filed = database.governance.listCurrentReviews(input.cardId, input.gateId).length;
        if (assigned < required) {
          /*
           * A gate wanting more reviewers than it has can never be satisfied,
           * and reporting only "1 of 2 filed" points at the reviewer who did
           * their job instead of the staffing that makes it impossible.
           */
          throw new Error(
            `Gate ${input.gateId} needs ${required} reviewers and has ${assigned} assigned; ` +
            'assign another before adjudicating',
          );
        }
        if (filed < required) {
          throw new Error(
            `All reviews must be filed before adjudication: ${filed} of ${required} at ${input.gateId}`,
          );
        }

        const finding = findingRow(input.findingId);
        const rulings = listRulings(input.findingId);
        if (rulings.some((ruling) => ruling.isFinal)) {
          throw new Error(`This finding has a final ruling and cannot be reopened: ${input.findingId}`);
        }
        const wasContested = connection
          .prepare('SELECT 1 FROM finding_contests WHERE finding_id = ?')
          .get(input.findingId) !== undefined;
        if (rulings.length > 0 && !wasContested) {
          /*
           * Spec 20.4.3 contemplates A ruling, with 20.4.7's re-ruling being
           * the exception a contest earns. Blocking only on isFinal let the
           * builder revise indefinitely — adopted, then overridden, then
           * deferred, each appending a register entry — so "the builder rules"
           * quietly became "the builder keeps ruling".
           */
          throw new Error(
            `This finding has already been ruled on; only a contest reopens it: ${input.findingId}`,
          );
        }
        if (isOverride(input.outcome) && !canOverride(finding.priority)) {
          // Not a policy the builder may argue with. It is why the ladder has a
          // top rung at all. A deferral counts: it is an override with a date.
          throw new Error(
            `A P0 may not be ${input.outcome} by the builder; it goes to the owner`,
          );
        }
        if (input.outcome === 'deferred') {
          // "A deferral is an override with a date attached" (spec 20.5). Both
          // gaps are named at once rather than one per attempt.
          const missing = [
            ...(input.nextStep?.trim() ? [] : ['a named next step']),
            ...(input.deferredUntil?.trim() ? [] : ['a date to revisit it']),
          ];
          if (missing.length > 0) {
            throw new Error(
              `A deferral needs ${missing.join(' and ')}; without them it is a finding dropped`,
            );
          }
        }

        // A re-ruling only happens after a contest, and a contested finding is
        // ruled once more and no further. Same question as above, one answer.

        const id = randomUUID();
        connection.prepare(`
          INSERT INTO finding_rulings (
            id, finding_id, ruled_by_org_agent_id, outcome, reason,
            next_step, residual_risk, is_final, ruled_at, sequence
          ) VALUES (
            @id, @findingId, @ruledByOrgAgentId, @outcome, @reason,
            @nextStep, @residualRisk, @isFinal, @ruledAt, @sequence
          )
        `).run({
          id,
          findingId: input.findingId,
          ruledByOrgAgentId: input.ruledByOrgAgentId,
          outcome: input.outcome,
          reason: input.reason,
          nextStep: input.nextStep ?? null,
          residualRisk: input.residualRisk ?? null,
          isFinal: wasContested ? 1 : 0,
          ruledAt: new Date().toISOString(),
          sequence: rulings.length,
        });

        const ruling = mapRuling(
          connection.prepare('SELECT * FROM finding_rulings WHERE id = ?').get(id) as RulingRow,
        );

        // Every ruling against a reviewer is logged, and a deferral is an
        // override with a date attached (spec 20.4 rule 4, spec 20.5).
        const registerEntry = !isOverride(input.outcome) ? null : database.governance.appendOverride({
          findingId: input.findingId,
          cardId: finding.card_id,
          reviewerOrgAgentId: finding.reviewer_org_agent_id,
          priority: finding.priority,
          reason: input.reason,
          residualRisk: input.residualRisk ?? '',
          deferredUntil: input.outcome === 'deferred' ? input.deferredUntil ?? null : null,
          createdByOrgAgentId: input.ruledByOrgAgentId,
        });
        return { ruling, registerEntry };
      })();
    },

    contestRuling(input) {
      if (!input.newEvidence.trim()) {
        // A contest without new evidence is the same opinion said louder.
        throw new Error('A contest must carry new evidence');
      }
      const finding = findingRow(input.findingId);
      /*
       * A contest answers a ruling, so there has to be one. Without this the
       * right could be spent before it existed: contesting first made the
       * builder's FIRST ruling final, and the reviewer lost the appeal by
       * exercising it early.
       */
      if (listRulings(input.findingId).length === 0) {
        throw new Error('There is no ruling to contest on this finding yet');
      }
      /*
       * And the contest belongs to the reviewer who raised the finding (spec
       * 20.4.7). Without this the BUILDER could contest its own finding, make
       * its own re-ruling final, and shut the real reviewer out with "this
       * finding has a final ruling" — turning the reviewer's one appeal into
       * the builder's lock.
       */
      if (input.contestedByOrgAgentId !== finding.reviewer_org_agent_id) {
        throw new Error(
          'Only the reviewer who raised the finding may contest the ruling on it',
        );
      }
      const already = connection
        .prepare('SELECT 1 FROM finding_contests WHERE finding_id = ? AND contested_by_org_agent_id = ?')
        .get(input.findingId, input.contestedByOrgAgentId);
      if (already) {
        throw new Error(
          `${input.contestedByOrgAgentId} has already contested this ruling; a reviewer may contest once`,
        );
      }
      const id = randomUUID();
      connection.prepare(`
        INSERT INTO finding_contests (id, finding_id, contested_by_org_agent_id, new_evidence, contested_at)
        VALUES (@id, @findingId, @contestedByOrgAgentId, @newEvidence, @contestedAt)
      `).run({ ...input, id, contestedAt: new Date().toISOString() });
      const row = connection
        .prepare('SELECT * FROM finding_contests WHERE id = ?')
        .get(id) as {
          id: string; finding_id: string; contested_by_org_agent_id: string;
          new_evidence: string; contested_at: string;
        };
      return {
        id: row.id,
        findingId: row.finding_id,
        contestedByOrgAgentId: row.contested_by_org_agent_id,
        newEvidence: row.new_evidence,
        contestedAt: row.contested_at,
      };
    },

    listRulings,

    /** Open means nothing has been decided about it yet. */
    isFindingOpen: (findingId) => listRulings(findingId).length === 0,

    listOpenEscalations(cardId) {
      const rows = cardId
        ? connection
          .prepare("SELECT * FROM p0_escalations WHERE status = 'open' AND card_id = ? ORDER BY raised_at")
          .all(cardId)
        : connection
          .prepare("SELECT * FROM p0_escalations WHERE status = 'open' ORDER BY raised_at")
          .all();
      return (rows as EscalationRow[]).map(mapEscalation);
    },

    resolveEscalation(input) {
      return connection.transaction((): P0Escalation => {
        const existing = connection
          .prepare('SELECT * FROM p0_escalations WHERE id = ?')
          .get(input.escalationId) as EscalationRow | undefined;
        if (!existing) throw new Error(`Escalation not found: ${input.escalationId}`);
        if (existing.status === 'resolved') {
          throw new Error(`This escalation is already resolved: ${input.escalationId}`);
        }
        /*
         * A P0 goes to the owner and the owner resolves it (spec 20.1). The
         * service trusted whoever it was handed, and the plan put this check on
         * a route that does not exist yet — so anything calling the service
         * directly could clear a P0 on the owner's behalf.
         */
        const resolver = database.identity.getUser(input.resolvedByUserId);
        if (!resolver || resolver.role !== 'owner') {
          throw new Error(
            `Only the owner may resolve a P0 escalation: ${input.resolvedByUserId} may not`,
          );
        }
        connection.prepare(`
          UPDATE p0_escalations SET
            status = 'resolved', resolution = @resolution,
            resolved_by_user_id = @resolvedByUserId, resolved_at = @resolvedAt
          WHERE id = @escalationId
        `).run({ ...input, resolvedAt: new Date().toISOString() });

        // Only the last open escalation on a card returns it to work; a card
        // with two P0s is still stopped by the second.
        const stillOpen = connection
          .prepare("SELECT COUNT(*) AS n FROM p0_escalations WHERE card_id = ? AND status = 'open'")
          .get(existing.card_id) as { n: number };
        if (stillOpen.n === 0) {
          database.work.moveCard({
            cardId: existing.card_id, to: 'in_progress', position: 0,
            userId: input.resolvedByUserId,
          });
        }
        return mapEscalation(
          connection.prepare('SELECT * FROM p0_escalations WHERE id = ?')
            .get(input.escalationId) as EscalationRow,
        );
      })();
    },
  };
}
