import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import {
  SPECIFICATION_SECTIONS,
  specificationIsComplete,
} from '../../src/server/governance-policy.js';
import { BUSINESS_LADDER, PRODUCT_LADDER, canAdvance } from '../../src/server/gate-policy.js';
import { denial } from '../helpers/verdict.js';

const COMPLETE = Object.fromEntries(
  SPECIFICATION_SECTIONS.map((section) => [section, `Something about ${section}.`]),
);

describe('the feature specification card', () => {
  it('has exactly thirteen sections, in a fixed order', () => {
    expect(SPECIFICATION_SECTIONS).toEqual([
      'problem', 'outcome', 'acceptance_criteria', 'scope', 'out_of_scope',
      'constraints', 'interfaces', 'data_and_migrations', 'permissions_and_audit',
      'failure_modes', 'verification', 'rollout_and_rollback', 'open_questions',
    ]);
    expect(SPECIFICATION_SECTIONS).toHaveLength(13);
  });

  it('reports a complete card as complete', () => {
    expect(specificationIsComplete(COMPLETE)).toEqual({ complete: true, missing: [] });
  });

  it('names EVERY missing section, not just the first', () => {
    const partial = { ...COMPLETE };
    delete (partial as Record<string, string>).verification;
    delete (partial as Record<string, string>).failure_modes;
    delete (partial as Record<string, string>).open_questions;

    const result = specificationIsComplete(partial);

    // A list delivered one item per attempt trains people to stop reading it.
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(['failure_modes', 'verification', 'open_questions']);
  });

  it('counts a whitespace section as missing, because an empty heading is not an answer', () => {
    expect(specificationIsComplete({ ...COMPLETE, scope: '   \n  ' }))
      .toEqual({ complete: false, missing: ['scope'] });
  });

  it('reports every section missing when nothing has been written', () => {
    expect(specificationIsComplete({}).missing).toEqual([...SPECIFICATION_SECTIONS]);
  });
});

describe('the gate that requires it', () => {
  const atG1 = { status: 'review' as const, gateId: 'G1' as const, reviewerCountOverride: null };
  const evidence = (missing: string[]) => ({
    reviewsFiled: 1,
    ownerDecision: true,
    artifactCount: 1,
    missingSpecificationSections: missing,
    missingHandoverPoints: [],
  });

  it('DENIES leaving G1 while the specification is incomplete, naming what is missing', () => {
    const verdict = canAdvance({
      card: atG1, ladder: PRODUCT_LADDER, to: 'G2',
      evidence: evidence(['verification', 'failure_modes']),
    });

    // If the card cannot be completed, the feature is not understood well
    // enough to build (spec 20.5).
    const refused = denial(verdict);
    expect(refused.reason).toMatch(/specification/i);
    expect(refused.reason).toMatch(/verification/);
    expect(refused.reason).toMatch(/failure_modes/);
  });

  it('allows the G1 advance once the specification is complete', () => {
    expect(canAdvance({
      card: atG1, ladder: PRODUCT_LADDER, to: 'G2', evidence: evidence([]),
    })).toEqual({ allowed: true });
  });

  it('does NOT require a feature specification on the business ladder', () => {
    // G1 there is a draft review, not a feature design. Demanding thirteen
    // engineering sections of a letter is how a gate gets worked around.
    expect(canAdvance({
      card: atG1, ladder: BUSINESS_LADDER, to: 'G4', evidence: evidence(['verification']),
    })).toEqual({ allowed: true });
  });

  it('does not demand a specification to move a card into G1', () => {
    // The card is written at G1. Requiring it to get there would be a gate
    // nothing could ever enter.
    expect(canAdvance({
      card: { status: 'in_progress', gateId: null, reviewerCountOverride: null },
      ladder: PRODUCT_LADDER, to: 'G1', evidence: evidence([...SPECIFICATION_SECTIONS]),
    })).toEqual({ allowed: true });
  });

  it('still lets a blocked card return to work with no specification', () => {
    expect(canAdvance({
      card: { status: 'blocked', gateId: 'G1', reviewerCountOverride: null },
      ladder: PRODUCT_LADDER, to: 'in_progress',
      evidence: evidence([...SPECIFICATION_SECTIONS]),
    })).toEqual({ allowed: true });
  });
});

describe('storing the specification', () => {
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

  it('starts with no specification at all', () => {
    const card = seed();

    expect(database!.governance.getSpecification(card.id)).toBeNull();
    // A card with no specification is missing all thirteen, not none.
    expect(database!.governance.missingSpecificationSections(card.id))
      .toEqual([...SPECIFICATION_SECTIONS]);
  });

  it('saves sections and reports what is still missing', () => {
    const card = seed();

    database!.governance.saveSpecification({
      cardId: card.id, sections: { problem: 'Nobody can tell which service to use.' },
    });

    expect(database!.governance.getSpecification(card.id)?.sections.problem)
      .toBe('Nobody can tell which service to use.');
    expect(database!.governance.missingSpecificationSections(card.id)).toHaveLength(12);
  });

  it('MERGES a later save rather than replacing the card', () => {
    const card = seed();
    database!.governance.saveSpecification({
      cardId: card.id, sections: { problem: 'The problem.' },
    });

    database!.governance.saveSpecification({
      cardId: card.id, sections: { outcome: 'The outcome.' },
    });

    // Writing one section must not silently wipe the twelve already written.
    const stored = database!.governance.getSpecification(card.id)!;
    expect(stored.sections.problem).toBe('The problem.');
    expect(stored.sections.outcome).toBe('The outcome.');
  });

  it('REFUSES a section the card does not have', () => {
    const card = seed();

    // A typo that silently created a fourteenth section would leave the real
    // one blank and the card looking answered.
    expect(() => database!.governance.saveSpecification({
      cardId: card.id, sections: { verificaton: 'Typo.' } as Record<string, string>,
    })).toThrow(/not a specification section/i);
  });

  it('reports nothing missing once every section is written', () => {
    const card = seed();
    database!.governance.saveSpecification({ cardId: card.id, sections: COMPLETE });

    expect(database!.governance.missingSpecificationSections(card.id)).toEqual([]);
  });
});
