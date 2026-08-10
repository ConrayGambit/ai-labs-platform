import type { GateId } from './work.js';

/**
 * A role is authority over one card at one gate, not a job title.
 *
 * The same agent is a builder on its own card and a reviewer on somebody
 * else's. The owner is not in this list — the owner outranks every gate and is
 * never assigned to one (spec 20.1).
 */
export const GOVERNANCE_ROLES = ['builder', 'reviewer'] as const;
export type GovernanceRole = (typeof GOVERNANCE_ROLES)[number];

export interface ReviewAssignment {
  id: string;
  cardId: string;
  gateId: GateId;
  role: GovernanceRole;
  orgAgentId: string;
  assignedAt: string;
}

export interface AssignRoleInput {
  cardId: string;
  gateId: GateId;
  role: GovernanceRole;
  orgAgentId: string;
}

export type FindingPriority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

export interface Finding {
  id: string;
  reviewId: string;
  priority: FindingPriority;
  /** What part of the system this is about. */
  area: string;
  finding: string;
  /**
   * Concrete inputs or state leading to a wrong result. Not a worry — a case.
   * A finding that cannot name how it fails is an opinion.
   */
  predictedFailure: string;
  /** `file:line`, so a reader can go and look rather than take it on trust. */
  evidence: string;
  proposedFix: string;
  createdAt: string;
}

export interface FindingInput {
  priority: FindingPriority;
  area: string;
  finding: string;
  predictedFailure: string;
  evidence: string;
  proposedFix: string;
}

export type ReviewVerdict = 'approve' | 'approve_with_findings' | 'reject';

export interface ChecklistAnswer {
  item: string;
  answer: string;
}

export interface Review {
  id: string;
  cardId: string;
  gateId: GateId;
  reviewerOrgAgentId: string;
  verdict: ReviewVerdict;
  /**
   * Every reviewer answers the full checklist for the gate. "Not applicable" is
   * an acceptable answer; silence is not (spec 20.3).
   */
  checklist: ChecklistAnswer[];
  whatToPreserve: string;
  questionsForBuilder: string;
  findings: Finding[];
  /** Set when a later review corrects this one. A review is never edited. */
  supersededByReviewId: string | null;
  filedAt: string;
}

export interface FileReviewInput {
  cardId: string;
  gateId: GateId;
  reviewerOrgAgentId: string;
  verdict: ReviewVerdict;
  checklist: ChecklistAnswer[];
  whatToPreserve: string;
  questionsForBuilder: string;
  findings: FindingInput[];
}

/** The parts of an agent that decide whether it may review another's work. */
export interface ReviewerIdentity {
  id: string;
  model: string | null;
  runtimeId: string;
}

export type ReviewEligibility = { allowed: true } | { allowed: false; reason: string };

/**
 * The model an agent actually runs on.
 *
 * A null model means "whatever this runtime defaults to", so two agents on one
 * runtime with no explicit model are the same model in practice. Comparing the
 * nulls as distinct values would wave a same-model reviewer straight through,
 * which is the one thing the rule exists to catch.
 */
export function effectiveModel(agent: ReviewerIdentity): string {
  return agent.model ?? `default:${agent.runtimeId}`;
}

/**
 * Whether an agent may review work built by another.
 *
 * Two rules, from spec 20.1 and 20.3, and both about the same thing: a review
 * is only worth having if it comes from somewhere the build did not.
 */
export function canReview(
  reviewer: ReviewerIdentity,
  builder: ReviewerIdentity | null,
): ReviewEligibility {
  if (!builder) return { allowed: true };
  if (reviewer.id === builder.id) {
    return { allowed: false, reason: 'A builder may not review its own work' };
  }
  if (effectiveModel(reviewer) === effectiveModel(builder)) {
    return {
      allowed: false,
      reason: 'A reviewer may not run the same model as the builder',
    };
  }
  return { allowed: true };
}
