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
