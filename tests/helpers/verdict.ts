import type { AdvanceVerdict } from '../../src/server/gate-policy.js';

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
