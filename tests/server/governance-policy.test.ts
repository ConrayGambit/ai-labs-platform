import { describe, expect, it } from 'vitest';
import {
  FINDING_PRIORITIES,
  canOverride,
  isBlocking,
  worstPriority,
} from '../../src/server/governance-policy.js';

describe('the findings ladder', () => {
  it('ranks P0 hardest and P4 softest', () => {
    expect(FINDING_PRIORITIES).toEqual(['P0', 'P1', 'P2', 'P3', 'P4']);
  });

  it('makes P0 the only priority that BLOCKS and the only one that CANNOT be overridden', () => {
    expect(isBlocking('P0')).toBe(true);
    expect(canOverride('P0')).toBe(false);

    for (const priority of ['P1', 'P2', 'P3', 'P4'] as const) {
      expect(isBlocking(priority)).toBe(false);
      // The builder has final say on P1-P4. Every such ruling is an override
      // and is logged, but it is permitted (spec 20.4 rule 4).
      expect(canOverride(priority)).toBe(true);
    }
  });

  it('reports the worst priority in a set, which is what decides whether work stops', () => {
    expect(worstPriority(['P3', 'P1', 'P4'])).toBe('P1');
    expect(worstPriority(['P2', 'P0'])).toBe('P0');
    expect(worstPriority(['P4'])).toBe('P4');
  });

  it('reports no worst priority for an empty set, rather than a safe-looking default', () => {
    // Returning 'P4' here would read as "nothing serious found" when in fact
    // nothing was found at all, and those are different states.
    expect(worstPriority([])).toBeNull();
  });
});
