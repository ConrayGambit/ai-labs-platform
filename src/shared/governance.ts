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
  /** When this reviewer stops being able to hold the gate shut, or null. */
  reviewDeadlineAt: string | null;
}

export interface AssignRoleInput {
  cardId: string;
  gateId: GateId;
  role: GovernanceRole;
  orgAgentId: string;
}

/** Who is looking. The owner is not a gate participant and sees everything. */
export type ReviewViewerRole = GovernanceRole | 'owner';

export interface ReviewVisibilityInput {
  /** The effective reviewer count for this gate, most-specific override applied. */
  requiredReviewers: number;
  /** Distinct reviewers whose review currently stands. Superseded ones do not count. */
  filedReviewerIds: readonly string[];
  reviewAuthorId: string;
  viewerId: string;
  viewerRole: ReviewViewerRole;
  now: string;
  /** The earliest outstanding reviewer's deadline, or null if none is set. */
  deadlineAt: string | null;
}

/**
 * Whether a filed review may be read yet.
 *
 * Two reviewers who read each other converge, and manufactured convergence is
 * worth nothing — it looks like corroboration and is actually one opinion
 * counted twice. So a review stays sealed until every required review is in, or
 * the outstanding reviewer's deadline passes.
 *
 * The builder is sealed out too, because 20.4.1 requires it to read *both*
 * reviews before ruling on either; seeing one early is how a builder starts
 * adjudicating against a case it has not finished hearing.
 *
 * At one reviewer this does not engage: there is nobody to be blind from, and
 * the platform does not pretend otherwise (spec 20.3).
 */
export function reviewIsVisibleTo(input: ReviewVisibilityInput): boolean {
  if (input.viewerRole === 'owner') return true;
  if (input.requiredReviewers < 2) return true;
  if (input.viewerId === input.reviewAuthorId) return true;
  if (input.filedReviewerIds.length >= input.requiredReviewers) return true;
  // No deadline is not an expired deadline. Treating a missing one as passed
  // would quietly disable blindness on every gate nobody scheduled.
  if (input.deadlineAt !== null && input.now > input.deadlineAt) return true;
  return false;
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

export type RulingOutcome = 'adopted' | 'deferred' | 'overridden';

export interface Ruling {
  id: string;
  findingId: string;
  ruledByOrgAgentId: string | null;
  ruledByUserId: string | null;
  outcome: RulingOutcome;
  reason: string;
  /** Required on a deferral: a deferral with no next step is a finding dropped. */
  nextStep: string | null;
  residualRisk: string | null;
  /** True once this ruling followed a contest. There is no third round. */
  isFinal: boolean;
  ruledAt: string;
}

export interface OverrideEntry {
  id: string;
  /** `OV-0001`. Zero-padded to four digits so entries sort as they read. */
  reference: string;
  sequence: number;
  findingId: string | null;
  cardId: string | null;
  reviewerOrgAgentId: string | null;
  priority: FindingPriority;
  reason: string;
  residualRisk: string;
  /** Set when this entry records a deferral rather than a plain override. */
  deferredUntil: string | null;
  /** The entry this one corrects, if it corrects one. */
  supersedesId: string | null;
  /** Set once, when a later entry corrects this one. Never cleared. */
  supersededById: string | null;
  createdByOrgAgentId: string | null;
  createdAt: string;
}

/** `OV-0001`. Four digits, so the register reads in order at a glance. */
export function overrideReference(sequence: number): string {
  return `OV-${String(sequence).padStart(4, '0')}`;
}

export const ADJUDICATION_SECTIONS = [
  'p0_escalations',
  'overrides',
  'deferrals',
  'contested_rulings',
  'gates_passed',
  'cards_blocked',
  'cost',
  'next_work_item',
] as const;

export type AdjudicationSection = (typeof ADJUDICATION_SECTIONS)[number];

export interface AdjudicationReport {
  /** A UTC day, `YYYY-MM-DD`. Every stored timestamp is an ISO string. */
  date: string;
  sections: Record<AdjudicationSection, string[]>;
  builtAt: string;
}

export interface Contest {
  id: string;
  findingId: string;
  contestedByOrgAgentId: string;
  newEvidence: string;
  contestedAt: string;
}

export interface P0Escalation {
  id: string;
  findingId: string;
  cardId: string;
  status: 'open' | 'resolved';
  resolution: string | null;
  resolvedByUserId: string | null;
  raisedAt: string;
  resolvedAt: string | null;
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
