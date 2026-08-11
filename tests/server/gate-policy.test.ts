import { describe, expect, it } from 'vitest';
import {
  BUSINESS_LADDER,
  PRODUCT_LADDER,
  canAdvance,
  columnKeyFor,
  deriveColumns,
} from '../../src/server/gate-policy.js';
import { effectiveReviewerCount, type AdvanceEvidence } from '../../src/shared/work.js';
import { denial } from '../helpers/verdict.js';

// No reviews, no signature, no artifact — but a complete specification, so
// every test below is about the rule it names rather than tripping on this one.
// The specification rule has its own suite.
const NO_EVIDENCE: AdvanceEvidence = {
  reviewsFiled: 0, ownerDecision: false, artifactCount: 0,
  missingSpecificationSections: [], missingHandoverPoints: [], hasOpenP0: false,
};

describe('gate ladders as policy data', () => {
  it('ships a product ladder of four gates, each at one reviewer', () => {
    expect(PRODUCT_LADDER.gates.map((gate) => gate.id)).toEqual(['G1', 'G2', 'G3', 'G4']);
    // One reviewer is the default everywhere (spec 20.2.1). A ladder that
    // shipped at two would be worked around, and a gate worked around is worse
    // than no gate.
    expect(PRODUCT_LADDER.gates.every((gate) => gate.reviewerCount === 1)).toBe(true);
  });

  it('ships a business ladder that ends with the owner signing', () => {
    expect(BUSINESS_LADDER.gates.map((gate) => gate.id)).toEqual(['G1', 'G4']);
    expect(BUSINESS_LADDER.gates[0]).toMatchObject({ reviewerCount: 1 });
    expect(BUSINESS_LADDER.gates[1]).toMatchObject({ ownerSignature: true });
  });
});

describe('the effective reviewer count', () => {
  const gate = PRODUCT_LADDER.gates[0]!;

  it('falls back to the ladder default when nothing overrides it', () => {
    expect(effectiveReviewerCount(gate, {})).toBe(1);
  });

  it('resolves most specific first: card, then project, then ladder', () => {
    expect(effectiveReviewerCount(gate, { project: 2 })).toBe(2);
    expect(effectiveReviewerCount(gate, { card: 3, project: 2 })).toBe(3);
    // A card raised to 2 wins over a project sitting at the default.
    expect(effectiveReviewerCount(gate, { card: 2, project: 1 })).toBe(2);
  });

  it('REFUSES an override below the ladder default rather than clamping it', () => {
    const signed = { ...gate, reviewerCount: 2 };
    // Silently clamping would let an override look accepted while weakening
    // nothing — or weakening everything, depending on which way it clamped.
    expect(() => effectiveReviewerCount(signed, { card: 1 })).toThrow(/raised but not lowered/i);
    expect(() => effectiveReviewerCount(signed, { project: 0 })).toThrow(/at least 2/i);
  });

  it('treats a null override as absent, not as zero', () => {
    expect(effectiveReviewerCount(gate, { card: null, project: null })).toBe(1);
    expect(effectiveReviewerCount(gate, { card: null, project: 2 })).toBe(2);
  });
});

describe('columns derived from a ladder', () => {
  it('yields the fixed columns with the ladder gates in the middle', () => {
    expect(deriveColumns(PRODUCT_LADDER).map((column) => column.key)).toEqual([
      'backlog', 'ready', 'in_progress', 'G1', 'G2', 'G3', 'G4', 'blocked', 'done',
    ]);
    expect(deriveColumns(BUSINESS_LADDER).map((column) => column.key)).toEqual([
      'backlog', 'ready', 'in_progress', 'G1', 'G4', 'blocked', 'done',
    ]);
  });

  it('marks exactly the gate columns with their gate', () => {
    const columns = deriveColumns(PRODUCT_LADDER);
    expect(columns.filter((column) => column.gateId !== null).map((c) => c.gateId))
      .toEqual(['G1', 'G2', 'G3', 'G4']);
    expect(columns.find((column) => column.key === 'backlog')?.gateId).toBeNull();
  });

  it('places a card in review into its gate column, and every other card by status', () => {
    expect(columnKeyFor({ status: 'review', gateId: 'G2' })).toBe('G2');
    expect(columnKeyFor({ status: 'in_progress', gateId: null })).toBe('in_progress');
    // A card in review with no gate recorded still has to render somewhere.
    expect(columnKeyFor({ status: 'review', gateId: null }, PRODUCT_LADDER)).toBe('G1');
  });
});

describe('what a card may do next', () => {
  const atGate = (gateId: 'G1' | 'G2' | 'G3' | 'G4') =>
    ({ status: 'review' as const, gateId, reviewerCountOverride: null });

  it('DENIES leaving a gate with fewer reviews than required, and names the gate', () => {
    const verdict = canAdvance({
      card: atGate('G1'), ladder: PRODUCT_LADDER, to: 'G2', evidence: NO_EVIDENCE,
    });
    expect(denial(verdict).reason).toMatch(/G1/);
    expect(denial(verdict).reason).toMatch(/0 of 1/);
  });

  it('allows leaving a gate once the required reviews are filed', () => {
    const verdict = canAdvance({
      card: atGate('G1'),
      ladder: PRODUCT_LADDER,
      to: 'G2',
      evidence: { ...NO_EVIDENCE, reviewsFiled: 1, artifactCount: 1 },
    });
    expect(verdict).toEqual({ allowed: true });
  });

  it('counts a raised reviewer count, not the ladder default', () => {
    const verdict = canAdvance({
      card: { ...atGate('G1'), reviewerCountOverride: 2 },
      ladder: PRODUCT_LADDER,
      to: 'G2',
      evidence: { ...NO_EVIDENCE, reviewsFiled: 1, artifactCount: 1 },
    });
    expect(denial(verdict).reason).toMatch(/1 of 2/);
  });

  it('DENIES closing a card with nothing to inspect', () => {
    const verdict = canAdvance({
      card: atGate('G4'),
      ladder: PRODUCT_LADDER,
      to: 'done',
      evidence: { ...NO_EVIDENCE, reviewsFiled: 9, ownerDecision: true, artifactCount: 0 },
    });
    expect(denial(verdict).reason).toMatch(/artifact/i);
  });

  it('DENIES passing a gate the owner must sign without the owner having signed', () => {
    const verdict = canAdvance({
      card: atGate('G3'),
      ladder: PRODUCT_LADDER,
      to: 'G4',
      evidence: { ...NO_EVIDENCE, reviewsFiled: 1, ownerDecision: false, artifactCount: 1 },
    });
    expect(denial(verdict).reason).toMatch(/owner/i);
  });

  it('lets a blocked card return to work at any time', () => {
    const verdict = canAdvance({
      card: { status: 'blocked', gateId: 'G2', reviewerCountOverride: null },
      ladder: PRODUCT_LADDER,
      to: 'in_progress',
      evidence: NO_EVIDENCE,
    });
    // Unblocking is not an advance. Requiring evidence to resume work would
    // strand the card in the one column nobody wants it to sit in.
    expect(verdict).toEqual({ allowed: true });
  });

  it('lets a card become blocked from anywhere, with no evidence at all', () => {
    expect(canAdvance({
      card: atGate('G3'), ladder: PRODUCT_LADDER, to: 'blocked', evidence: NO_EVIDENCE,
    })).toEqual({ allowed: true });
  });

  it('never returns a reason alongside an allowed verdict', () => {
    const allowed = canAdvance({
      card: { status: 'backlog', gateId: null, reviewerCountOverride: null },
      ladder: PRODUCT_LADDER,
      to: 'ready',
      evidence: NO_EVIDENCE,
    });
    expect(allowed).toEqual({ allowed: true });
    expect('reason' in allowed).toBe(false);
  });

  it('DENIES a destination the ladder does not have', () => {
    const verdict = canAdvance({
      card: { status: 'in_progress', gateId: null, reviewerCountOverride: null },
      ladder: BUSINESS_LADDER,
      to: 'G2',
      evidence: NO_EVIDENCE,
    });
    expect(denial(verdict).reason).toMatch(/business/i);
  });
});
