import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { createGovernanceService, type GovernanceService } from '../../src/server/governance-service.js';
import {
  ADJUDICATION_SECTIONS,
  buildAdjudicationReport,
} from '../../src/server/adjudication-report.js';
import type { FindingInput } from '../../src/shared/governance.js';

/** Every timestamp the platform writes is toISOString(), so a date is a UTC day. */
const today = () => new Date().toISOString().slice(0, 10);

describe('the daily adjudication report', () => {
  let database: OrchestratorDatabase | undefined;
  let service: GovernanceService | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
    service = undefined;
  });

  const checklist = [{ item: 'Q', answer: 'A.' }];

  const finding = (overrides: Partial<FindingInput> = {}): FindingInput => ({
    priority: 'P2', area: 'run-supervisor', finding: 'The ceiling is checked late.',
    predictedFailure: 'One extra update at 99% of ceiling.',
    evidence: 'src/server/run-supervisor.ts:112', proposedFix: 'Check it first.',
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
      name, jobTitle: 'S', department: 'D', jobFunction: 'F', responsibilities: 'R',
      runtimeId: database!.createAgent({
        name: `rt-${model}`, command: `rt-${model}`, argsTemplate: ['{prompt}'],
        promptTransport: 'argument', outputFormat: 'text',
        versionArgs: ['--version'], timeoutMs: 120_000,
      }).id,
      model,
    });
    const builder = make('Builder', 'm1');
    const reviewer = make('Reviewer', 'm2');
    database.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'builder', orgAgentId: builder.id,
    });
    database.governance.assignRole({
      cardId: card.id, gateId: 'G1', role: 'reviewer', orgAgentId: reviewer.id,
    });
    return { card, builder, reviewer };
  }

  const fileWith = (cardId: string, reviewerId: string, findings: FindingInput[] = []) =>
    service!.fileReview({
      cardId, gateId: 'G1', reviewerOrgAgentId: reviewerId,
      verdict: findings.length ? 'approve_with_findings' : 'approve',
      checklist, whatToPreserve: '', questionsForBuilder: '', findings,
    });

  it('has exactly eight sections, with P0 escalations FIRST', () => {
    expect(ADJUDICATION_SECTIONS).toHaveLength(8);
    expect(ADJUDICATION_SECTIONS[0]).toBe('p0_escalations');
    expect(ADJUDICATION_SECTIONS).toEqual([
      'p0_escalations', 'overrides', 'deferrals', 'contested_rulings',
      'gates_passed', 'cards_blocked', 'cost', 'next_work_item',
    ]);
  });

  it('writes NO report for a date on which nothing happened', () => {
    seed();

    // "Written every working day work occurs." A day with no work is not a
    // working day, and inventing a report for it would be noise.
    expect(buildAdjudicationReport({ database: database!, date: '2000-01-01' })).toBeNull();
    expect(database!.governance.getAdjudicationReport('2000-01-01')).toBeNull();
  });

  it('writes a report on a quiet day, saying plainly that it was quiet', () => {
    const { card, reviewer } = seed();
    fileWith(card.id, reviewer.id); // work happened; nothing was overridden

    const report = buildAdjudicationReport({ database: database!, date: today() })!;

    // Silence must be informative. A missing report and a day with nothing to
    // report are different facts, and only one of them is reassuring.
    expect(report.sections.overrides).toEqual(['No overrides were recorded on this date.']);
    expect(report.sections.p0_escalations)
      .toEqual(['No P0 escalations are open, and none were raised on this date.']);
    // Every section is present and none is blank.
    for (const section of ADJUDICATION_SECTIONS) {
      expect(report.sections[section].length).toBeGreaterThan(0);
      expect(report.sections[section].every((line) => line.trim() !== '')).toBe(true);
    }
  });

  it('lists the day overrides by reference', () => {
    const { card, builder, reviewer } = seed();
    const filed = fileWith(card.id, reviewer.id, [finding()]);
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId: filed.review.findings[0]!.id,
      outcome: 'overridden', reason: 'Idempotent write.', residualRisk: 'One extra row.',
      ruledByOrgAgentId: builder.id,
    });

    const report = buildAdjudicationReport({ database: database!, date: today() })!;

    expect(report.sections.overrides.join(' ')).toMatch(/OV-0001/);
    expect(report.sections.overrides.join(' ')).toMatch(/P2/);
  });

  it('separates deferrals from plain overrides, with their dates', () => {
    const { card, builder, reviewer } = seed();
    const filed = fileWith(card.id, reviewer.id, [finding()]);
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId: filed.review.findings[0]!.id,
      outcome: 'deferred', reason: 'Next slice.', nextStep: 'Fix the ordering.',
      deferredUntil: '2026-09-01', ruledByOrgAgentId: builder.id,
    });

    const report = buildAdjudicationReport({ database: database!, date: today() })!;

    expect(report.sections.deferrals.join(' ')).toMatch(/2026-09-01/);
    expect(report.sections.overrides).toEqual(['No overrides were recorded on this date.']);
  });

  it('reports a contested ruling', () => {
    const { card, builder, reviewer } = seed();
    const filed = fileWith(card.id, reviewer.id, [finding()]);
    const findingId = filed.review.findings[0]!.id;
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId, outcome: 'overridden',
      reason: 'Harmless.', residualRisk: 'None.', ruledByOrgAgentId: builder.id,
    });
    service!.contestRuling({
      findingId, contestedByOrgAgentId: reviewer.id, newEvidence: 'It is not harmless.',
    });

    const report = buildAdjudicationReport({ database: database!, date: today() })!;

    expect(report.sections.contested_rulings.join(' ')).toMatch(/not harmless/i);
  });

  it('puts an OPEN P0 first even when it was raised on an earlier day', () => {
    const { card, reviewer } = seed();
    fileWith(card.id, reviewer.id, [finding({
      priority: 'P0', area: 'access', finding: 'No venture check.',
      predictedFailure: 'Cross-venture read.', evidence: 'src/server/work-api.ts:88',
    })]);
    // Backdate the escalation: it was raised before today and is still open.
    database!.connection
      .prepare("UPDATE p0_escalations SET raised_at = '2020-01-01T00:00:00.000Z'")
      .run();

    const report = buildAdjudicationReport({ database: database!, date: today() })!;

    // An unresolved P0 is today's problem too, however old it is.
    expect(report.sections.p0_escalations.join(' ')).toMatch(/No venture check|still open/i);
    expect(report.sections.p0_escalations[0]).not.toMatch(/^No P0/);
  });

  it('records a card blocked on the day it was blocked', () => {
    const { card, reviewer } = seed();
    fileWith(card.id, reviewer.id, [finding({
      priority: 'P0', area: 'access', finding: 'No venture check.',
      predictedFailure: 'Cross-venture read.', evidence: 'src/server/work-api.ts:88',
    })]);

    const report = buildAdjudicationReport({ database: database!, date: today() })!;

    expect(report.sections.cards_blocked.join(' ')).toMatch(/Survey the field/);
  });

  it('REPLACES the report for a date rather than appending a second', () => {
    const { card, builder, reviewer } = seed();
    const filed = fileWith(card.id, reviewer.id, [finding()]);
    buildAdjudicationReport({ database: database!, date: today() });
    service!.adjudicate({
      cardId: card.id, gateId: 'G1', findingId: filed.review.findings[0]!.id,
      outcome: 'overridden', reason: 'Idempotent.', residualRisk: 'None.',
      ruledByOrgAgentId: builder.id,
    });

    const rebuilt = buildAdjudicationReport({ database: database!, date: today() })!;

    // A day has one report. Rebuilding it after more happened must update the
    // record, not leave two contradictory versions of the same day.
    expect(rebuilt.sections.overrides.join(' ')).toMatch(/OV-0001/);
    expect(database!.governance.getAdjudicationReport(today())?.sections.overrides.join(' '))
      .toMatch(/OV-0001/);
    expect(database!.governance.listAdjudicationReports()).toHaveLength(1);
  });

  it('reports the day cost from the runs that started on it', () => {
    const { card, reviewer } = seed();
    fileWith(card.id, reviewer.id);
    const run = database!.runs.createRun({
      cardId: card.id, orgAgentId: database!.listOrgAgents()[0]!.id,
      roomId: null, parentRunId: null, costCeilingTokens: null,
    });
    database!.runs.addUsage(run.id, 900, 120);

    const report = buildAdjudicationReport({ database: database!, date: today() })!;

    expect(report.sections.cost.join(' ')).toMatch(/1020|900|120/);
  });
});
