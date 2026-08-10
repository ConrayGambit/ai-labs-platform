import { describe, expect, it } from 'vitest';
import { canTransitionProject } from '../../src/shared/platform.js';

describe('governed project lifecycle', () => {
  it('requires approval between scoping and activation', () => {
    expect(canTransitionProject('draft', 'scoping')).toBe(true);
    expect(canTransitionProject('scoping', 'pending_approval')).toBe(true);
    expect(canTransitionProject('pending_approval', 'approved')).toBe(true);
    expect(canTransitionProject('approved', 'active')).toBe(true);
    expect(canTransitionProject('scoping', 'active')).toBe(false);
  });

  it('permits operational pause and resumption without reopening scoping', () => {
    expect(canTransitionProject('active', 'paused')).toBe(true);
    expect(canTransitionProject('paused', 'active')).toBe(true);
    expect(canTransitionProject('completed', 'active')).toBe(false);
  });
});
