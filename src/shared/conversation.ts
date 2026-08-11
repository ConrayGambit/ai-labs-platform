/**
 * Agents act on exactly three triggers: an @-mention, an assignment, or a
 * schedule (spec 5.4.3). There is no ambient listening — an agent sitting in a
 * room does nothing until it is addressed.
 *
 * This is a whitelist and not a blacklist deliberately. A new way for an agent
 * to be nudged into acting has to be added here on purpose, which is the point:
 * ambient activation is not a feature somebody adds, it is a feature that
 * arrives when nobody is looking.
 */
export const CONVERSATION_TRIGGERS = ['mention', 'assignment', 'schedule'] as const;
export type ConversationTrigger = (typeof CONVERSATION_TRIGGERS)[number];

export type MayActVerdict =
  | { allowed: true; trigger: ConversationTrigger }
  | { allowed: false; reason: string };

/**
 * Every agent-to-agent exchange ends in exactly one of these.
 *
 * An exchange that ends in none of them is a failure and is reported as one
 * (spec 5.4.3) — the failure mode being two agents who talk until somebody
 * notices, having produced nothing anybody can point at.
 */
export type TerminalAction =
  | { kind: 'artifact'; artifactId: string }
  | { kind: 'handoff'; toUserId: string }
  | { kind: 'no_further_action'; reason: string };

export const STOPPING_LIMITS = ['turn_budget', 'loop', 'cost_ceiling', 'terminal_action'] as const;
export type StoppingLimit = (typeof STOPPING_LIMITS)[number];

export interface StoppingLimits {
  /** Agent-originated turns in a thread before a human is required to continue. */
  turnBudget: number;
  /** Alternating turns between two agents, with nothing produced, before it is a loop. */
  loopWindow: number;
}

export const DEFAULT_STOPPING_LIMITS: StoppingLimits = {
  // Enough to hand something over, not enough to argue.
  turnBudget: 8,
  loopWindow: 4,
};

export type StoppingVerdict =
  | { terminated: false }
  | { terminated: true; limit: StoppingLimit; reason: string };

/**
 * Whether the last turns are two agents going back and forth.
 *
 * A→B→A→B is the pattern the spec names. Three or more voices is a discussion,
 * and a window that flagged it would terminate the very exchanges that are
 * working — so the check is strictly alternating between exactly two.
 */
export function isAlternatingPair(recentAgentIds: readonly string[], window: number): boolean {
  if (recentAgentIds.length < window) return false;
  const tail = recentAgentIds.slice(-window);
  if (new Set(tail).size !== 2) return false;
  return tail.every((id, index) => index === 0 || id !== tail[index - 1]);
}
