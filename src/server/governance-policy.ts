import {
  HANDOVER_POINTS,
  SPECIFICATION_SECTIONS,
  type FindingPriority,
  type HandoverPoint,
  type HandoverPoints,
  type SpecificationSection,
  type SpecificationSections,
} from '../shared/governance.js';

/** Hardest first. The index in this array is the ranking. */
export const FINDING_PRIORITIES: readonly FindingPriority[] = ['P0', 'P1', 'P2', 'P3', 'P4'];

/**
 * P0 stops the affected work. Nothing else does.
 *
 * The ladder is deliberately short and its top rung deliberately narrow: a
 * category that stops work only means something if it is rare.
 */
export function isBlocking(priority: FindingPriority): boolean {
  return priority === 'P0';
}

/**
 * The builder has final say on P1–P4, and every such ruling is logged as an
 * override. A P0 may never be overridden by the builder — it goes to the owner
 * (spec 20.4 rules 4 and 5).
 */
export function canOverride(priority: FindingPriority): boolean {
  return priority !== 'P0';
}

/**
 * Whether a ruling goes against the reviewer, and so is an override.
 *
 * "A deferral is an override with a date attached" (spec 20.5) — so a deferral
 * is one, and only adopting is not. This exists as one predicate because the
 * P0 guard and the register-entry decision are the same question, and while
 * they were two separate expressions they disagreed: the guard refused
 * `overridden` on a P0 while the register happily wrote a P0 deferral. Found
 * in review, and the shape of the bug is why this function exists rather than
 * two comparisons that have to be kept in step by hand.
 */
export function isOverride(outcome: 'adopted' | 'deferred' | 'overridden'): boolean {
  return outcome !== 'adopted';
}

/**
 * The worst priority in a set, which is what decides whether work stops.
 *
 * An empty set returns null rather than the softest priority: "nothing serious
 * was found" and "nothing was found" are different states, and collapsing them
 * would let a card with no reviews at all look reassuring.
 */
export function worstPriority(priorities: readonly FindingPriority[]): FindingPriority | null {
  let worst: FindingPriority | null = null;
  for (const priority of priorities) {
    if (!worst || FINDING_PRIORITIES.indexOf(priority) < FINDING_PRIORITIES.indexOf(worst)) {
      worst = priority;
    }
  }
  return worst;
}

/** Declared in `src/shared/governance.ts`; re-exported because this module is where existing callers import it from. */
export { SPECIFICATION_SECTIONS, type SpecificationSection, type SpecificationSections };

export function isSpecificationSection(key: string): key is SpecificationSection {
  return (SPECIFICATION_SECTIONS as readonly string[]).includes(key);
}

/**
 * Which sections are still unwritten.
 *
 * Every missing section is named, never just the first: a writer fixing them
 * one round-trip at a time is a writer who gives up. Whitespace counts as
 * missing, because an empty heading is not an answer.
 */
export function specificationIsComplete(
  sections: SpecificationSections,
): { complete: boolean; missing: SpecificationSection[] } {
  const missing = SPECIFICATION_SECTIONS.filter((key) => !sections[key]?.trim());
  return { complete: missing.length === 0, missing: [...missing] };
}

/** Declared in `src/shared/governance.ts`; re-exported because this module is where existing callers import it from. */
export { HANDOVER_POINTS, type HandoverPoint, type HandoverPoints };

export function isHandoverPoint(key: string): key is HandoverPoint {
  return (HANDOVER_POINTS as readonly string[]).includes(key);
}

/**
 * Whether a section shows what the machine said rather than what the writer
 * remembers it saying.
 *
 * "Commands run and test results (actual output, not claims)" is a literal
 * requirement, so it is checked literally. A fenced block or a prompt line is
 * pasted output; a sentence is not.
 *
 * Two things are deliberately NOT accepted, though each would catch some real
 * output.
 *
 * A leading digit — "326 tests passed and the build was green" is still a
 * claim, and admitting it would readmit exactly what this rule refuses one
 * character of effort later.
 *
 * A bare `>` — in Markdown that is a blockquote, so "> All tests passed" sailed
 * straight through until a review probe fed it exactly that. npm echoes its
 * scripts with `>` as well, so the cost here is real; it is still the right
 * trade, because a rule a quotation mark defeats is not a rule. A PowerShell
 * prompt is still accepted, being unambiguous.
 *
 * The cost of being strict is a writer wrapping their paste in backticks.
 */
export function containsActualOutput(section: string): boolean {
  return section.split('\n').some((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) return true;
    if (trimmed.startsWith('$')) return true;
    return /^PS\b.*>/.test(trimmed);
  });
}

/**
 * Which points are still unwritten.
 *
 * `commands_and_actual_output` counts as unwritten while it holds only a claim,
 * because a section that says "all tests passed" has not been written — it has
 * been asserted.
 */
export function handoverIsComplete(
  points: HandoverPoints,
): { complete: boolean; missing: HandoverPoint[] } {
  const missing = HANDOVER_POINTS.filter((key) => {
    const value = points[key]?.trim();
    if (!value) return true;
    return key === 'commands_and_actual_output' && !containsActualOutput(value);
  });
  return { complete: missing.length === 0, missing: [...missing] };
}
