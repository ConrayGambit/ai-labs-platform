import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { createGovernanceService, type GovernanceService } from '../../src/server/governance-service.js';
import type { FindingInput } from '../../src/shared/governance.js';

describe('the override register', () => {
  let database: OrchestratorDatabase | undefined;
  let service: GovernanceService | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
    service = undefined;
  });

  const checklist = [{ item: 'Does it meet the acceptance criteria?', answer: 'Yes.' }];

  const finding = (overrides: Partial<FindingInput> = {}): FindingInput => ({
    priority: 'P2',
    area: 'run-supervisor',
    finding: 'The cost ceiling is evaluated after the usage row is written.',
    predictedFailure: 'A run at 99% of ceiling writes one more update.',
    evidence: 'src/server/run-supervisor.ts:112',
    proposedFix: 'Evaluate the ceiling before persisting.',
    ...overrides,
  });

  function seed() {
    database = createDatabase(':memory:');
    service = createGovernanceService(database);
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Evaluate tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.',
      successCriteria: ['Approved'],
    });
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
    const make = (name: string, model: string) => database!.createOrgAgent({
      name, jobTitle: 'Specialist', department: 'Research',
      jobFunction: 'Does the work.', responsibilities: 'Work.',
      runtimeId: database!.createAgent({
        name: `Runtime ${model}`, command: `runtime-${model}`, argsTemplate: ['{prompt}'],
        promptTransport: 'argument', outputFormat: 'text',
        versionArgs: ['--version'], timeoutMs: 120_000,
      }).id,
      model,
    });
    const builder = make('Builder', 'model-one');
    const reviewer = make('Reviewer', 'model-two');
    database.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    });
    database.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: reviewer.id,
    });
    return { card, builder, reviewer };
  }

  /** Files one finding and rules on it, returning the register entry. */
  const overrideOne = (
    cardId: string, builderId: string, reviewerId: string,
    outcome: 'overridden' | 'deferred' = 'overridden',
    extra: Record<string, unknown> = {},
  ) => {
    const filed = service!.fileReview({
      cardId, gateId: 'G1', reviewerOrgAgentId: reviewerId,
      verdict: 'approve_with_findings', checklist,
      whatToPreserve: '', questionsForBuilder: '', findings: [finding()],
    });
    return service!.adjudicate({
      cardId, gateId: 'G1', findingId: filed.review.findings[0]!.id,
      outcome, reason: 'The write is idempotent.', residualRisk: 'One redundant row.',
      ...(outcome === 'deferred' ? { nextStep: 'Fix in the next slice.' } : {}),
      ruledByOrgAgentId: builderId,
      ...extra,
    });
  };

  it('numbers entries OV-0001, OV-0002, zero-padded to four digits', () => {
    const { card, builder, reviewer } = seed();

    const first = overrideOne(card.id, builder.id, reviewer.id);
    const second = overrideOne(card.id, builder.id, reviewer.id);

    expect(first.registerEntry?.reference).toBe('OV-0001');
    expect(second.registerEntry?.reference).toBe('OV-0002');
  });

  it('carries the finding, the reviewer, the priority, the reason and the residual risk', () => {
    const { card, builder, reviewer } = seed();

    const entry = overrideOne(card.id, builder.id, reviewer.id).registerEntry!;

    expect(entry).toMatchObject({
      cardId: card.id,
      reviewerOrgAgentId: reviewer.id,
      priority: 'P2',
      reason: 'The write is idempotent.',
      residualRisk: 'One redundant row.',
      createdByOrgAgentId: builder.id,
      supersededById: null,
    });
    expect(entry.findingId).toBeTruthy();
  });

  it('records a DEFERRAL too, with the date it was deferred until', () => {
    const { card, builder, reviewer } = seed();

    const entry = overrideOne(
      card.id, builder.id, reviewer.id, 'deferred',
      { deferredUntil: '2026-09-01' },
    ).registerEntry!;

    // A deferral is an override with a date attached (spec 20.5).
    expect(entry).toMatchObject({ deferredUntil: '2026-09-01' });
    expect(database!.governance.listOverrides({ cardId: card.id })).toHaveLength(1);
  });

  it('does NOT record an adopted finding, which is not an override at all', () => {
    const { card, builder, reviewer } = seed();
    const filed = service!.fileReview({
      cardId: card.id, gateId: 'G1', reviewerOrgAgentId: reviewer.id,
      verdict: 'approve_with_findings', checklist,
      whatToPreserve: '', questionsForBuilder: '', findings: [finding()],
    });

    const result = service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId: filed.review.findings[0]!.id,
      outcome: 'adopted', reason: 'Correct.', ruledByOrgAgentId: builder.id,
    });

    expect(result.registerEntry).toBeNull();
    expect(database!.governance.listOverrides({})).toEqual([]);
  });

  it('exposes no way to update or delete an entry', () => {
    seed();

    const repository = database!.governance as unknown as Record<string, unknown>;
    // The register is written by exactly one method. A second writer is how an
    // append-only record stops being one.
    expect(repository.updateOverride).toBeUndefined();
    expect(repository.deleteOverride).toBeUndefined();
    expect(repository.removeOverride).toBeUndefined();
  });

  it('REFUSES a delete straight through SQL', () => {
    const { card, builder, reviewer } = seed();
    const entry = overrideOne(card.id, builder.id, reviewer.id).registerEntry!;

    // The rule lives in the database. A rule that lives only in a repository
    // method is a rule until somebody writes a second repository method.
    expect(() => database!.connection
      .prepare('DELETE FROM override_register WHERE id = ?').run(entry.id))
      .toThrow(/append-only/i);
    expect(database!.governance.listOverrides({})).toHaveLength(1);
  });

  it('REFUSES an edit straight through SQL', () => {
    const { card, builder, reviewer } = seed();
    const entry = overrideOne(card.id, builder.id, reviewer.id).registerEntry!;

    expect(() => database!.connection
      .prepare('UPDATE override_register SET reason = ? WHERE id = ?')
      .run('Something more flattering.', entry.id)).toThrow(/append-only/i);
    expect(() => database!.connection
      .prepare('UPDATE override_register SET priority = ? WHERE id = ?').run('P4', entry.id))
      .toThrow(/append-only/i);
    expect(database!.governance.listOverrides({})[0]?.reason).toBe('The write is idempotent.');
  });

  it('supersedes an entry with a NEW entry, never an edit', () => {
    const { card, builder, reviewer } = seed();
    const original = overrideOne(card.id, builder.id, reviewer.id).registerEntry!;

    const correction = database!.governance.supersedeOverride({
      supersedesId: original.id,
      reason: 'The write is not idempotent after all.',
      residualRisk: 'A duplicate row on every stopped run.',
      createdByOrgAgentId: builder.id,
    });

    expect(correction.reference).toBe('OV-0002');
    expect(correction.supersedesId).toBe(original.id);
    const all = database!.governance.listOverrides({});
    // Both stand. The record of what was believed at the time is evidence.
    expect(all).toHaveLength(2);
    expect(all.find((e) => e.id === original.id)?.supersededById).toBe(correction.id);
  });

  it('REFUSES to supersede the same entry twice', () => {
    const { card, builder, reviewer } = seed();
    const original = overrideOne(card.id, builder.id, reviewer.id).registerEntry!;
    database!.governance.supersedeOverride({
      supersedesId: original.id, reason: 'First correction.',
      residualRisk: '', createdByOrgAgentId: builder.id,
    });

    expect(() => database!.governance.supersedeOverride({
      supersedesId: original.id, reason: 'Second correction.',
      residualRisk: '', createdByOrgAgentId: builder.id,
    })).toThrow(/already superseded/i);
  });

  it('REFUSES to clear a supersede marker through SQL', () => {
    const { card, builder, reviewer } = seed();
    const original = overrideOne(card.id, builder.id, reviewer.id).registerEntry!;
    database!.governance.supersedeOverride({
      supersedesId: original.id, reason: 'Correction.',
      residualRisk: '', createdByOrgAgentId: builder.id,
    });

    // Three-valued logic makes this easy to get wrong: a naive OLD <> NEW test
    // is NULL rather than true when NEW is null, and the edit slips past.
    expect(() => database!.connection
      .prepare('UPDATE override_register SET superseded_by_id = NULL WHERE id = ?')
      .run(original.id)).toThrow(/append-only/i);
  });

  it('lists superseded entries too, marked as such', () => {
    const { card, builder, reviewer } = seed();
    const original = overrideOne(card.id, builder.id, reviewer.id).registerEntry!;
    database!.governance.supersedeOverride({
      supersedesId: original.id, reason: 'Correction.',
      residualRisk: '', createdByOrgAgentId: builder.id,
    });

    const all = database!.governance.listOverrides({});
    expect(all.map((entry) => entry.reference)).toEqual(['OV-0001', 'OV-0002']);
    expect(all[0]?.supersededById).not.toBeNull();
  });

  it('filters by card without hiding anything within it', () => {
    const { card, builder, reviewer } = seed();
    overrideOne(card.id, builder.id, reviewer.id);
    const otherCard = database!.work.createCard({
      projectId: database!.work.getCard(card.id)!.projectId, title: 'Elsewhere',
    });

    expect(database!.governance.listOverrides({ cardId: card.id })).toHaveLength(1);
    expect(database!.governance.listOverrides({ cardId: otherCard.id })).toEqual([]);
  });
});
