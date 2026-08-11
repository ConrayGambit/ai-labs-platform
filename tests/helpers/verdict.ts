import type { AdvanceVerdict } from '../../src/server/gate-policy.js';
import type { MayActVerdict, StoppingVerdict } from '../../src/shared/conversation.js';

/**
 * Narrows a verdict to its denial branch so a test can read `reason`.
 *
 * `AdvanceVerdict` is a discriminated union with no `reason` on the allowed
 * branch — deliberately, so a caller cannot render a denial message on a
 * successful move. An `expect(...).toBe(false)` does not narrow the type for
 * the compiler, so tests reach for this instead of the union being loosened.
 */
export function denial(verdict: AdvanceVerdict): { allowed: false; reason: string } {
  if (verdict.allowed) throw new Error('Expected the gate to refuse, but it allowed the move');
  return verdict;
}

/**
 * Narrows a trigger verdict to its refusal branch so a test can read `reason`.
 * Same reason as `denial` above: the allowed branch deliberately has no reason.
 */
export function refusal(verdict: MayActVerdict): { allowed: false; reason: string } {
  if (verdict.allowed) throw new Error('Expected the guard to refuse, but it allowed the act');
  return verdict;
}

/** Narrows a stopping verdict to its terminated branch. */
export function terminated(
  verdict: StoppingVerdict,
): Extract<StoppingVerdict, { terminated: true }> {
  if (!verdict.terminated) throw new Error('Expected the exchange to be terminated; it was not');
  return verdict;
}
