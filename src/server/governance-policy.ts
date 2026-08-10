import type { FindingPriority } from '../shared/governance.js';

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
