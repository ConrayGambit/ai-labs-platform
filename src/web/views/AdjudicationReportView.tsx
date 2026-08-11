import { useEffect, useId, useState } from 'react';
import { getAdjudicationReport } from '../api/client.js';
import { ADJUDICATION_SECTIONS, type AdjudicationReport, type AdjudicationSection } from '../../shared/governance.js';

export interface AdjudicationReportViewProps {
  /** A UTC calendar day, `YYYY-MM-DD`. Defaults to today (UTC) when omitted. */
  date?: string;
}

/** `p0_escalations` -> `P0 escalations`. Same technique as CardDetailView's own local `humanize`. */
function humanize(key: string): string {
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A day nothing happened on at all is never saved
 * (`buildAdjudicationReport`, src/server/adjudication-report.ts, returns
 * `null` without writing a row when not even a working day occurred), so
 * `GET /api/adjudication-reports/:date` answers `null` for such a day, same
 * as one nobody has built yet — this view cannot tell the two apart, and
 * does not pretend to. Either way it is still eight sections, not an error
 * and not a blank screen; this is the shared, honest placeholder for all
 * eight when there is no report row to read from.
 */
const NO_REPORT_TEXT = 'No report is recorded for this date.';

interface ReportSectionProps {
  section: AdjudicationSection;
  lines: string[] | null;
}

/**
 * One of the eight fixed sections. Always renders its own heading, and
 * always renders at least one line — real content when there is any, the
 * shared placeholder otherwise. Never `return null` for an empty or missing
 * `lines`: that is exactly the failure that would make "eight sections on a
 * silent day" quietly stop being true, with no test failing to say so unless
 * one exercises this branch directly (tests/web/adjudication-report.test.tsx
 * does, deliberately, with a genuinely empty array rather than only ever the
 * server's own non-empty "nothing happened" sentences).
 */
function ReportSection({ section, lines }: ReportSectionProps) {
  return (
    <section className="detail-section">
      <h3 className="detail-heading">{humanize(section)}</h3>
      <ul className="report-lines">
        {(lines && lines.length > 0 ? lines : [NO_REPORT_TEXT]).map((line, index) => (
          <li className="report-line" key={index}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The daily adjudication report: eight fixed sections, for a chosen date.
 *
 * Every section renders even on a silent day — a section the server actually
 * built always carries at least one line (`orElse`, adjudication-report.ts,
 * writes an explicit "nothing happened" sentence rather than an empty list),
 * and a date with no report row at all still renders the same eight
 * headings with a shared placeholder. Silence is informative either way, and
 * is never rendered as an error or a blank screen.
 *
 * Self-contained, including its own page heading (`.workspace-panel` +
 * `.section-heading`, the same shell `SkillsView`/`RuntimesView` use in
 * `App.tsx`) so a caller can mount it directly as a navigation destination
 * with no wrapping of its own — this is that destination; nothing else in
 * this increment reaches the daily report otherwise.
 */
export function AdjudicationReportView({ date: initialDate }: AdjudicationReportViewProps) {
  const [date, setDate] = useState(initialDate ?? todayUtc());
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [report, setReport] = useState<AdjudicationReport | null>(null);
  const dateFieldId = useId();
  const titleId = useId();

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    getAdjudicationReport(date).then((result) => {
      if (cancelled) return;
      setReport(result);
      setLoadState('ready');
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setLoadError(reason instanceof Error ? reason.message : 'Unable to load the adjudication report');
      setLoadState('error');
    });
    return () => { cancelled = true; };
  }, [date]);

  return (
    <section aria-labelledby={titleId} className="workspace-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Owner-only</p>
          <h2 id={titleId}>Daily report</h2>
          <p>Eight fixed sections for one calendar day, written even on a day with nothing in them.</p>
        </div>
      </div>

      <div className="detail-field report-controls">
        {/* Named explicitly: the field opens on today in UTC, which after
            midnight local time is a date a local picker would otherwise show
            with nothing explaining why it is not "today" on this machine. */}
        <label className="field-label" htmlFor={dateFieldId}>Date (UTC)</label>
        <input id={dateFieldId} onChange={(event) => setDate(event.target.value)} type="date" value={date} />
      </div>

      {loadState === 'loading' && <p className="detail-empty">Loading the report…</p>}
      {loadState === 'error' && <p className="form-error" role="alert">{loadError}</p>}
      {loadState === 'ready' && (
        <div className="report-sections">
          {ADJUDICATION_SECTIONS.map((section) => (
            <ReportSection key={section} lines={report?.sections[section] ?? null} section={section} />
          ))}
        </div>
      )}
    </section>
  );
}
