import { useEffect, useId, useState } from 'react';
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
 * Mirrors `request()` in `src/web/api/client.ts` field for field, without
 * adding to that file's route table. `GET /api/adjudication-reports/:date`
 * is not named in this task's own "Consumes" list at all — an omission this
 * view could not have worked around, since it is the one route that makes it
 * possible to render a report in the first place.
 */
async function fetchAdjudicationReport(date: string): Promise<AdjudicationReport | null> {
  let response: Response;
  try {
    response = await fetch(`/api/adjudication-reports/${date}`);
  } catch (cause) {
    throw new Error('Could not reach the server', { cause });
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as AdjudicationReport | null;
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
 */
export function AdjudicationReportView({ date: initialDate }: AdjudicationReportViewProps) {
  const [date, setDate] = useState(initialDate ?? todayUtc());
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [report, setReport] = useState<AdjudicationReport | null>(null);
  const dateFieldId = useId();

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    fetchAdjudicationReport(date).then((result) => {
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
    <div className="adjudication-report">
      <div className="detail-field report-controls">
        <label className="field-label" htmlFor={dateFieldId}>Date</label>
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
    </div>
  );
}
