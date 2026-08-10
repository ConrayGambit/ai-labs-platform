import type {
  AdjudicationReport as Report,
  AdjudicationSection as Section,
} from '../shared/governance.js';
import type { OrchestratorDatabase } from './database.js';

/**
 * The eight sections live in shared/governance beside the other governance
 * types: this module reads the database, and the repository that stores its
 * output must name the type without importing the reader back.
 *
 * P0 escalations come first, always. A report that buried them under the day's
 * cost would be a report whose most urgent line is the one nobody scrolls to.
 */
export {
  ADJUDICATION_SECTIONS,
  type AdjudicationReport,
  type AdjudicationSection,
} from '../shared/governance.js';

export interface BuildReportInput {
  database: OrchestratorDatabase;
  /** A UTC day, `YYYY-MM-DD`. Every stored timestamp is an ISO string. */
  date: string;
}

/**
 * A section with nothing to say gets an explicit sentence, never an empty list.
 *
 * "Silence must be informative" (spec 20.5): "no overrides were recorded" and a
 * section that simply is not there are different facts, and only one of them is
 * reassuring.
 */
const orElse = (lines: string[], nothingHappened: string): string[] =>
  lines.length > 0 ? lines : [nothingHappened];

export function buildAdjudicationReport(input: BuildReportInput): Report | null {
  const { database, date } = input;
  const connection = database.connection;
  const onDate = `${date}%`;

  const rows = <T>(sql: string, ...parameters: unknown[]): T[] =>
    connection.prepare(sql).all(...parameters) as T[];

  /**
   * Whether this was a working day at all.
   *
   * The report is written "every working day work occurs". A day with no
   * governance activity and no board movement is not a working day, and a
   * report invented for it would be noise that trains people to skim.
   */
  const worked = [
    'SELECT 1 FROM reviews WHERE filed_at LIKE ? LIMIT 1',
    'SELECT 1 FROM finding_rulings WHERE ruled_at LIKE ? LIMIT 1',
    'SELECT 1 FROM override_register WHERE created_at LIKE ? LIMIT 1',
    'SELECT 1 FROM finding_contests WHERE contested_at LIKE ? LIMIT 1',
    'SELECT 1 FROM p0_escalations WHERE raised_at LIKE ? OR resolved_at LIKE ? LIMIT 1',
    'SELECT 1 FROM card_activity WHERE created_at LIKE ? LIMIT 1',
    'SELECT 1 FROM agent_runs WHERE started_at LIKE ? LIMIT 1',
  ].some((sql) => {
    const wanted = (sql.match(/\?/g) ?? []).length;
    return connection.prepare(sql).get(...Array.from({ length: wanted }, () => onDate)) !== undefined;
  });
  if (!worked) return null;

  // Every open escalation, whatever day it was raised: an unresolved P0 is
  // today's problem too, and a report that only listed today's would go quiet
  // on the one that has been blocking work all week.
  const openP0s = rows<{ finding: string; card: string; raised_at: string }>(
    `SELECT f.finding AS finding, c.title AS card, e.raised_at AS raised_at
       FROM p0_escalations e
       JOIN review_findings f ON f.id = e.finding_id
       JOIN cards c ON c.id = e.card_id
      WHERE e.status = 'open'
      ORDER BY e.raised_at`,
  ).map((row) => `STILL OPEN since ${row.raised_at.slice(0, 10)} — ${row.card}: ${row.finding}`);

  const resolvedP0s = rows<{ card: string; resolution: string | null }>(
    `SELECT c.title AS card, e.resolution AS resolution
       FROM p0_escalations e JOIN cards c ON c.id = e.card_id
      WHERE e.status = 'resolved' AND e.resolved_at LIKE ?
      ORDER BY e.resolved_at`,
    onDate,
  ).map((row) => `Resolved — ${row.card}: ${row.resolution ?? 'no resolution recorded'}`);

  const register = rows<{
    reference: string; priority: string; reason: string;
    residual_risk: string; deferred_until: string | null; card: string | null;
  }>(
    `SELECT o.reference, o.priority, o.reason, o.residual_risk, o.deferred_until,
            c.title AS card
       FROM override_register o LEFT JOIN cards c ON c.id = o.card_id
      WHERE o.created_at LIKE ? ORDER BY o.sequence`,
    onDate,
  );
  const describe = (entry: typeof register[number]): string =>
    `${entry.reference} [${entry.priority}] ${entry.card ?? 'unattached'}: ${entry.reason}` +
    (entry.residual_risk ? ` (residual risk: ${entry.residual_risk})` : '');

  const contests = rows<{ evidence: string; finding: string }>(
    `SELECT t.new_evidence AS evidence, f.finding AS finding
       FROM finding_contests t JOIN review_findings f ON f.id = t.finding_id
      WHERE t.contested_at LIKE ? ORDER BY t.contested_at`,
    onDate,
  ).map((row) => `Contested "${row.finding}" with new evidence: ${row.evidence}`);

  const moves = rows<{ detail: string; title: string; actor_type: string }>(
    `SELECT a.detail, c.title, a.actor_type
       FROM card_activity a JOIN cards c ON c.id = a.card_id
      WHERE a.kind = 'moved' AND a.created_at LIKE ? ORDER BY a.sequence`,
    onDate,
  );
  const gatesPassed = moves
    .filter((move) => /^G[1-4] ->/.test(move.detail))
    .map((move) => `${move.title}: ${move.detail}${move.actor_type === 'system' ? ' (automatic)' : ''}`);
  const cardsBlocked = moves
    .filter((move) => move.detail.endsWith('-> blocked'))
    .map((move) => `${move.title} was blocked (${move.detail})`);

  const cost = connection
    .prepare(
      `SELECT COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
              COUNT(*) AS runs
         FROM agent_runs WHERE started_at LIKE ?`,
    )
    .get(onDate) as { input: number; output: number; runs: number };

  const nextItems = rows<{ points_json: string; title: string }>(
    `SELECT h.points_json, c.title FROM card_handovers h JOIN cards c ON c.id = h.card_id
      WHERE h.updated_at LIKE ? ORDER BY h.updated_at`,
    onDate,
  ).flatMap((row) => {
    const next = (JSON.parse(row.points_json) as { exact_next_work_item?: string })
      .exact_next_work_item?.trim();
    return next ? [`${row.title}: ${next}`] : [];
  });

  const sections: Record<Section, string[]> = {
    p0_escalations: orElse(
      [...openP0s, ...resolvedP0s],
      'No P0 escalations are open, and none were raised on this date.',
    ),
    overrides: orElse(
      register.filter((entry) => !entry.deferred_until).map(describe),
      'No overrides were recorded on this date.',
    ),
    deferrals: orElse(
      register
        .filter((entry) => entry.deferred_until)
        .map((entry) => `${describe(entry)} — deferred until ${entry.deferred_until}`),
      'No findings were deferred on this date.',
    ),
    contested_rulings: orElse(contests, 'No rulings were contested on this date.'),
    gates_passed: orElse(gatesPassed, 'No card left a gate on this date.'),
    cards_blocked: orElse(cardsBlocked, 'No card was blocked on this date.'),
    cost: [
      `${cost.runs} run(s) started, ${cost.input} input and ${cost.output} output tokens ` +
      `(${cost.input + cost.output} total).`,
    ],
    next_work_item: orElse(
      nextItems,
      'No handover named a next work item on this date.',
    ),
  };

  const report: Report = { date, sections, builtAt: new Date().toISOString() };
  database.governance.saveAdjudicationReport(report);
  return report;
}
