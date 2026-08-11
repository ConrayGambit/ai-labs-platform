import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import {
  HANDOVER_POINTS,
  containsActualOutput,
  handoverIsComplete,
} from '../../src/server/governance-policy.js';
import { PRODUCT_LADDER, canAdvance } from '../../src/server/gate-policy.js';
import { denial } from '../helpers/verdict.js';

const REAL_OUTPUT = '```\n Test Files  40 passed (40)\n      Tests  326 passed (326)\n```';

const COMPLETE = Object.fromEntries(
  HANDOVER_POINTS.map((point) => [
    point,
    point === 'commands_and_actual_output' ? REAL_OUTPUT : `Something about ${point}.`,
  ]),
);

describe('the handover report', () => {
  it('has exactly nine points, including the two the spec names', () => {
    expect(HANDOVER_POINTS).toHaveLength(9);
    expect(HANDOVER_POINTS).toContain('commands_and_actual_output');
    expect(HANDOVER_POINTS).toContain('exact_next_work_item');
  });

  it('reports a complete handover as complete', () => {
    expect(handoverIsComplete(COMPLETE)).toEqual({ complete: true, missing: [] });
  });

  it('names EVERY missing point, not just the first', () => {
    const partial = { ...COMPLETE };
    delete (partial as Record<string, string>).why;
    delete (partial as Record<string, string>).follow_up_items;

    expect(handoverIsComplete(partial)).toEqual({
      complete: false, missing: ['why', 'follow_up_items'],
    });
  });

  it('counts a whitespace point as missing', () => {
    expect(handoverIsComplete({ ...COMPLETE, known_limitations: '  \n ' }).missing)
      .toEqual(['known_limitations']);
  });
});

describe('actual output, not claims', () => {
  it('REJECTS a handover claiming success instead of showing it', () => {
    const claimed = { ...COMPLETE, commands_and_actual_output: 'All tests passed.' };

    const result = handoverIsComplete(claimed);

    // The whole point of the section is that a reader sees what the machine
    // said, rather than what the writer remembers it saying.
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['commands_and_actual_output']);
  });

  it('accepts a fenced block of pasted output', () => {
    expect(containsActualOutput(REAL_OUTPUT)).toBe(true);
  });

  it('accepts a shell prompt line', () => {
    expect(containsActualOutput('$ npm run verify\nexit=0')).toBe(true);
    // Driveless on purpose: the publishable-data guard rejects a drive path,
    // and it caught this fixture when it was written with one.
    expect(containsActualOutput('PS /workspace> npm run verify')).toBe(true);
  });

  // Found in review: a bare '>' is a Markdown blockquote at least as often as
  // it is a prompt, so prose could wear one and pass.
  it('REJECTS a blockquote dressed as a prompt line', () => {
    expect(containsActualOutput('> All tests passed and the build was green.')).toBe(false);
    expect(containsActualOutput('> ai-labs-platform@0.1.0 verify')).toBe(false);
  });

  it('REJECTS prose that merely begins with a number', () => {
    // "326 tests passed" as a sentence is still a claim. Accepting a leading
    // digit would readmit exactly what this rule refuses, one character of
    // effort later.
    expect(containsActualOutput('326 tests passed and the build was green.')).toBe(false);
    expect(containsActualOutput('3 commands were run.')).toBe(false);
  });

  it('REJECTS an empty section', () => {
    expect(containsActualOutput('')).toBe(false);
    expect(containsActualOutput('   \n  ')).toBe(false);
  });
});

describe('the gate that requires it', () => {
  const atG4 = { status: 'review' as const, gateId: 'G4' as const, reviewerCountOverride: null };
  const evidence = (missingHandoverPoints: string[]) => ({
    reviewsFiled: 1,
    ownerDecision: true,
    artifactCount: 1,
    missingSpecificationSections: [],
    missingHandoverPoints,
    hasOpenP0: false,
  });

  it('DENIES closing a card while the handover is incomplete, naming what is missing', () => {
    const verdict = canAdvance({
      card: atG4, ladder: PRODUCT_LADDER, to: 'done',
      evidence: evidence(['commands_and_actual_output', 'exact_next_work_item']),
    });

    const refused = denial(verdict);
    expect(refused.reason).toMatch(/handover/i);
    expect(refused.reason).toMatch(/commands_and_actual_output/);
    expect(refused.reason).toMatch(/exact_next_work_item/);
  });

  it('allows the close once the handover is complete', () => {
    expect(canAdvance({
      card: atG4, ladder: PRODUCT_LADDER, to: 'done', evidence: evidence([]),
    })).toEqual({ allowed: true });
  });

  // Found in review: canAdvance exempted every move from a blocked card, so the
  // policy said a blocked card with no artifact and no handover could be
  // closed, while moveCard refused the very same move.
  it('DENIES closing a BLOCKED card that has met none of the requirements', () => {
    const verdict = canAdvance({
      card: { status: 'blocked', gateId: 'G2', reviewerCountOverride: null },
      ladder: PRODUCT_LADDER, to: 'done',
      evidence: {
        reviewsFiled: 0, ownerDecision: false, artifactCount: 0,
        missingSpecificationSections: [], missingHandoverPoints: [...HANDOVER_POINTS],
        hasOpenP0: false,
      },
    });

    expect(denial(verdict).reason).toMatch(/artifact|handover/i);
  });

  it('still lets a blocked card go anywhere that is not done', () => {
    expect(canAdvance({
      card: { status: 'blocked', gateId: 'G2', reviewerCountOverride: null },
      ladder: PRODUCT_LADDER, to: 'in_progress',
      evidence: {
        reviewsFiled: 0, ownerDecision: false, artifactCount: 0,
        missingSpecificationSections: [], missingHandoverPoints: [...HANDOVER_POINTS],
        hasOpenP0: false,
      },
    })).toEqual({ allowed: true });
  });

  it('does not demand a handover to move between gates', () => {
    // The handover is written to hand the work back, not to progress it.
    expect(canAdvance({
      card: { status: 'review', gateId: 'G2', reviewerCountOverride: null },
      ladder: PRODUCT_LADDER, to: 'G3', evidence: evidence([...HANDOVER_POINTS]),
    })).toEqual({ allowed: true });
  });
});

describe('storing the handover, and the last line of defence', () => {
  let database: OrchestratorDatabase | undefined;
  afterEach(() => database?.close());

  function seed() {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Evaluate tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.',
      successCriteria: ['Approved'],
    });
    return database.work.createCard({ projectId: project.id, title: 'Survey the field' });
  }

  it('starts with nothing, which is all nine missing', () => {
    const card = seed();

    expect(database!.governance.getHandover(card.id)).toBeNull();
    expect(database!.governance.missingHandoverPoints(card.id)).toEqual([...HANDOVER_POINTS]);
  });

  it('MERGES a later save rather than replacing the report', () => {
    const card = seed();
    database!.governance.saveHandover({ cardId: card.id, points: { why: 'Because.' } });

    database!.governance.saveHandover({ cardId: card.id, points: { what_changed: 'This.' } });

    const stored = database!.governance.getHandover(card.id)!;
    expect(stored.points.why).toBe('Because.');
    expect(stored.points.what_changed).toBe('This.');
  });

  it('REFUSES a point the report does not have', () => {
    const card = seed();

    expect(() => database!.governance.saveHandover({
      cardId: card.id, points: { exact_next_item: 'Typo.' } as Record<string, string>,
    })).toThrow(/not a handover point/i);
  });

  it('reports the claimed-output section as still missing until it shows output', () => {
    const card = seed();
    database!.governance.saveHandover({
      cardId: card.id,
      points: { ...COMPLETE, commands_and_actual_output: 'Everything is green.' },
    });

    expect(database!.governance.missingHandoverPoints(card.id))
      .toEqual(['commands_and_actual_output']);
  });

  // moveCard is the ONLY write to a card's status. Putting the last check there
  // means a future caller that forgets the policy cannot close a card anyway.
  it('REFUSES a move to done through the repository itself', () => {
    const card = seed();

    expect(() => database!.work.moveCard({
      cardId: card.id, to: 'done', position: 0, userId: 'owner',
    })).toThrow(/handover/i);
    expect(database!.work.getCard(card.id)?.status).toBe('backlog');
  });

  it('allows the move to done once the handover is complete', () => {
    const card = seed();
    database!.governance.saveHandover({ cardId: card.id, points: COMPLETE });

    expect(() => database!.work.moveCard({
      cardId: card.id, to: 'done', position: 0, userId: 'owner',
    })).not.toThrow();
    expect(database!.work.getCard(card.id)?.status).toBe('done');
  });

  it('does not stand in the way of any other move', () => {
    const card = seed();

    expect(() => database!.work.moveCard({
      cardId: card.id, to: 'in_progress', position: 0, userId: 'owner',
    })).not.toThrow();
  });
});
