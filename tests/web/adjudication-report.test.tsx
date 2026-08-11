import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdjudicationReportView } from '../../src/web/views/AdjudicationReportView.js';

const SECTION_HEADINGS = [
  'P0 escalations', 'Overrides', 'Deferrals', 'Contested rulings',
  'Gates passed', 'Cards blocked', 'Cost', 'Next work item',
];

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

function expectAllEightHeadings(): void {
  for (const heading of SECTION_HEADINGS) {
    expect(screen.getByText(heading)).toBeInTheDocument();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the adjudication report view', () => {
  it('renders all eight sections with real content', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
      date: '2026-08-10',
      sections: {
        p0_escalations: ['STILL OPEN since 2026-08-09 — Wire the queue: access check missing'],
        overrides: ['OV-0001 [P2] Wire the queue: The write is idempotent.'],
        deferrals: ['No findings were deferred on this date.'],
        contested_rulings: ['No rulings were contested on this date.'],
        gates_passed: ['Wire the queue: G1 -> G2'],
        cards_blocked: ['No card was blocked on this date.'],
        cost: ['3 run(s) started, 500 input and 900 output tokens (1400 total).'],
        next_work_item: ['Wire the queue: add the missing venture check.'],
      },
      builtAt: '2026-08-11T00:00:00.000Z',
    })));
    render(<AdjudicationReportView date="2026-08-10" />);
    await waitFor(() => expect(screen.getByText('P0 escalations')).toBeInTheDocument());
    expectAllEightHeadings();
    expect(screen.getByText(/still open since 2026-08-09/i)).toBeInTheDocument();
    expect(screen.getByText(/3 run\(s\) started/i)).toBeInTheDocument();
  });

  it('renders all eight sections, populated, on a day with real activity but nothing in a given section', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
      date: '2026-08-10',
      sections: {
        p0_escalations: ['No P0 escalations are open, and none were raised on this date.'],
        overrides: ['No overrides were recorded on this date.'],
        deferrals: ['No findings were deferred on this date.'],
        contested_rulings: ['No rulings were contested on this date.'],
        gates_passed: ['No card left a gate on this date.'],
        cards_blocked: ['No card was blocked on this date.'],
        cost: ['0 run(s) started, 0 input and 0 output tokens (0 total).'],
        next_work_item: ['No handover named a next work item on this date.'],
      },
      builtAt: '2026-08-11T00:00:00.000Z',
    })));
    render(<AdjudicationReportView date="2026-08-10" />);
    await waitFor(() => expect(screen.getByText(/no overrides were recorded/i)).toBeInTheDocument());
    expectAllEightHeadings();
    expect(screen.getByText(/no p0 escalations are open/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  /**
   * The regression this file exists to catch. The server's own `orElse`
   * (adjudication-report.ts) never actually produces an empty array for a
   * built report — every section carries at least one line, real or a
   * "nothing happened" sentence — so a fixture built only from realistic
   * server payloads (the two tests above) would never exercise
   * ReportSection's empty-array branch at all. Sending one here directly,
   * against an otherwise non-null report, proves the branch: if
   * `ReportSection` were ever changed to skip a section (return null)
   * instead of rendering its heading with the shared placeholder, this is
   * the one test that would catch it — the section count assertion fails
   * even if every text query above it happens to still pass.
   */
  it('still renders the section heading and the shared placeholder for a section whose own line list is empty', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
      date: '2026-08-10',
      sections: {
        p0_escalations: [],
        overrides: ['OV-0001 [P2] Wire the queue: The write is idempotent.'],
        deferrals: ['No findings were deferred on this date.'],
        contested_rulings: ['No rulings were contested on this date.'],
        gates_passed: ['No card left a gate on this date.'],
        cards_blocked: ['No card was blocked on this date.'],
        cost: ['0 run(s) started, 0 input and 0 output tokens (0 total).'],
        next_work_item: ['No handover named a next work item on this date.'],
      },
      builtAt: '2026-08-11T00:00:00.000Z',
    })));
    const { container } = render(<AdjudicationReportView date="2026-08-10" />);
    await waitFor(() => expect(screen.getByText('P0 escalations')).toBeInTheDocument());
    expectAllEightHeadings();
    expect(screen.getAllByText('No report is recorded for this date.')).toHaveLength(1);
    expect(container.querySelectorAll('.detail-section')).toHaveLength(8);
  });

  it('renders all eight sections, as an empty report, when no report row exists at all — never an error, never blank', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(null)));
    const { container } = render(<AdjudicationReportView date="2026-08-09" />);
    await waitFor(() => expect(screen.getByText('P0 escalations')).toBeInTheDocument());
    expectAllEightHeadings();
    expect(screen.getAllByText(/no report is recorded for this date/i)).toHaveLength(8);
    expect(container.querySelectorAll('.detail-section')).toHaveLength(8);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('defaults to today (UTC) when no date is given', async () => {
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
    const fetchMock = vi.fn(() => jsonResponse(null));
    vi.stubGlobal('fetch', fetchMock);
    render(<AdjudicationReportView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/adjudication-reports/2026-08-11'));
    vi.useRealTimers();
  });

  it('labels the date field as UTC, since it opens on a UTC day a local picker would not otherwise explain', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(null)));
    render(<AdjudicationReportView date="2026-08-10" />);
    expect(await screen.findByLabelText('Date (UTC)')).toBeInTheDocument();
  });

  it('refetches when the date field changes', async () => {
    const fetchMock = vi.fn(() => jsonResponse(null));
    vi.stubGlobal('fetch', fetchMock);
    render(<AdjudicationReportView date="2026-08-10" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/adjudication-reports/2026-08-10'));

    fireEvent.change(screen.getByLabelText('Date (UTC)'), { target: { value: '2026-08-09' } });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/adjudication-reports/2026-08-09'));
  });

  it('renders the server refusal verbatim (a non-owner is refused the whole report)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(
      { error: 'Access denied: this report is available to the owner only' }, 403,
    )));
    render(<AdjudicationReportView date="2026-08-10" />);
    expect(await screen.findByText('Access denied: this report is available to the owner only')).toBeInTheDocument();
  });
});
