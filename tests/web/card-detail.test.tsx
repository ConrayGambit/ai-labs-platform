import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CardDetailView } from '../../src/web/views/CardDetailView.js';

const card = {
  id: 'card-1',
  projectId: 'project-1',
  parentCardId: null,
  title: 'Wire the approval queue',
  description: 'Replace the legacy table with the governed board.',
  status: 'in_progress',
  priority: 'high',
  assigneeOrgAgentId: 'agent-1',
  ownerNotes: 'Keep the diff small.',
  gateId: null,
  reviewerCountOverride: null,
  reviewerRaiseReason: null,
  reviewerRaisedByUserId: null,
  costCeilingTokens: null,
  position: 0,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const activity = [
  {
    id: 'activity-1', cardId: 'card-1', actorType: 'user', actorId: 'user-1',
    kind: 'created', detail: 'Wire the approval queue', createdAt: '2026-08-01T00:00:00.000Z',
  },
];

const artifacts = [
  {
    id: 'artifact-1', cardId: 'card-1', runId: null, kind: 'diff',
    label: 'Board diff', location: 'src/web/views/CardBoardView.tsx', createdAt: '2026-08-01T00:00:00.000Z',
  },
];

const specification = {
  cardId: 'card-1',
  sections: { problem: 'The board renders from a legacy table, not the real one.' },
  updatedAt: '2026-08-01T00:00:00.000Z',
};

const board = {
  ladder: { id: 'product', label: 'Product and code', gates: [{ id: 'G1' }, { id: 'G2' }, { id: 'G3' }, { id: 'G4' }] },
  columns: [
    { key: 'backlog', label: 'Backlog', gateId: null },
    { key: 'ready', label: 'Ready', gateId: null },
    { key: 'in_progress', label: 'In progress', gateId: null },
    { key: 'G1', label: 'G1 design', gateId: 'G1' },
    { key: 'blocked', label: 'Blocked', gateId: null },
    { key: 'done', label: 'Done', gateId: null },
  ],
  cards: [],
};

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

function stubRoutes(overrides: Record<string, () => Promise<Response>> = {}) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const key = `${method} ${url}`;
    if (overrides[key]) return overrides[key]();
    if (url === '/api/cards/card-1') return jsonResponse({ card, room: null, activity, artifacts, runs: [] });
    if (url === '/api/cards/card-1/specification') return jsonResponse(specification);
    if (url === '/api/projects/project-1/cards') return jsonResponse(board);
    // EscalationBanner is mounted unconditionally (Task 8) — it checks every
    // card, gate or no gate, since a card an open P0 already blocked has no
    // gate left to check instead (src/server/work-repository.ts's moveCard
    // clears gateId on a move to 'blocked'). None of this file's fixtures
    // carry an open escalation, so the quiet, no-render answer throughout.
    if (url === '/api/escalations?cardId=card-1') return jsonResponse({ escalations: [] });
    if (key === 'PUT /api/cards/card-1/notes') {
      const { notes } = JSON.parse(String(init?.body)) as { notes: string };
      return jsonResponse({ ...card, ownerNotes: notes });
    }
    if (key === 'POST /api/cards/card-1/move') {
      const { to } = JSON.parse(String(init?.body)) as { to: string; position: number };
      return jsonResponse({ ...card, status: to === 'ready' ? 'ready' : card.status, gateId: null });
    }
    throw new Error(`Unexpected request: ${key}`);
  }));
}

describe('the card detail view', () => {
  beforeEach(() => {
    stubRoutes();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the title, description, activity, and artifacts', async () => {
    render(<CardDetailView cardId="card-1" onClose={() => {}} />);

    // The title renders as the dialog heading; the same text also appears in
    // the activity row below (a 'created' entry's detail is the card title),
    // so this targets the heading specifically rather than the text anywhere.
    expect(await screen.findByRole('heading', { level: 2, name: 'Wire the approval queue' })).toBeInTheDocument();
    expect(screen.getByText('Replace the legacy table with the governed board.')).toBeInTheDocument();
    expect(screen.getByText('Created')).toBeInTheDocument();
    expect(screen.getByText('Board diff')).toBeInTheDocument();
    expect(screen.getByText('src/web/views/CardBoardView.tsx')).toBeInTheDocument();
  });

  it('names every specification section, marking the unwritten ones missing rather than omitting them', async () => {
    render(<CardDetailView cardId="card-1" onClose={() => {}} />);
    await screen.findByRole('heading', { level: 2, name: 'Wire the approval queue' });

    // Written section: its content shows.
    expect(screen.getByText('The board renders from a legacy table, not the real one.')).toBeInTheDocument();
    // Unwritten sections: named, and marked missing — never silently absent.
    expect(screen.getByText('Verification')).toBeInTheDocument();
    expect(screen.getByText('Open questions')).toBeInTheDocument();
    expect(screen.getAllByText('Missing')).toHaveLength(12); // 13 sections, 1 written
  });

  it('loads the owner notes into an editable field and saves them through putNotes', async () => {
    render(<CardDetailView cardId="card-1" onClose={() => {}} />);
    const notes = await screen.findByLabelText(/owner notes/i) as HTMLTextAreaElement;
    expect(notes.value).toBe('Keep the diff small.');

    fireEvent.change(notes, { target: { value: 'Keep the diff small. Ship behind the flag.' } });
    fireEvent.click(screen.getByRole('button', { name: /save notes/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/cards/card-1/notes',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ notes: 'Keep the diff small. Ship behind the flag.' }),
      }),
    ));
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
  });

  it('moves the card through an explicit control, never by predicting the gate itself', async () => {
    render(<CardDetailView cardId="card-1" onClose={() => {}} />);
    const select = await screen.findByLabelText(/move to/i);
    fireEvent.change(select, { target: { value: 'ready' } });
    fireEvent.click(screen.getByRole('button', { name: /^move$/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/cards/card-1/move',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ to: 'ready', position: 0 }) }),
    ));
  });

  it('renders the server refusal verbatim when a move is refused, never a predicted reason', async () => {
    stubRoutes({
      'POST /api/cards/card-1/move': () =>
        jsonResponse({ error: 'Gate refused the move: needs 1 review(s); 0 of 1 filed.' }, 400),
    });
    render(<CardDetailView cardId="card-1" onClose={() => {}} />);
    const select = await screen.findByLabelText(/move to/i);
    fireEvent.change(select, { target: { value: 'ready' } });
    fireEvent.click(screen.getByRole('button', { name: /^move$/i }));

    expect(await screen.findByText('Gate refused the move: needs 1 review(s); 0 of 1 filed.')).toBeInTheDocument();
  });

  it('offers every column as a move destination, including the one the card is already in', async () => {
    render(<CardDetailView cardId="card-1" onClose={() => {}} />);
    const select = await screen.findByLabelText(/move to/i) as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((option) => option.textContent);
    // card-1 is 'in_progress'. Withholding that option would be the client
    // deciding a destination is invalid on its own reasoning rather than
    // letting the server be the only place that ever refuses a move.
    expect(optionLabels).toEqual([
      'Choose a column…', 'Backlog', 'Ready', 'In progress', 'G1 design', 'Blocked', 'Done',
    ]);
  });

  it('reports a successful move to its caller, so a board rendered elsewhere can refetch', async () => {
    const onMoved = vi.fn();
    render(<CardDetailView cardId="card-1" onClose={() => {}} onMoved={onMoved} />);
    const select = await screen.findByLabelText(/move to/i);
    fireEvent.change(select, { target: { value: 'ready' } });
    fireEvent.click(screen.getByRole('button', { name: /^move$/i }));

    await waitFor(() => expect(onMoved).toHaveBeenCalledTimes(1));
  });

  it('does not report a move as moved when the server refused it', async () => {
    const onMoved = vi.fn();
    stubRoutes({
      'POST /api/cards/card-1/move': () =>
        jsonResponse({ error: 'Gate refused the move: needs 1 review(s); 0 of 1 filed.' }, 400),
    });
    render(<CardDetailView cardId="card-1" onClose={() => {}} onMoved={onMoved} />);
    const select = await screen.findByLabelText(/move to/i);
    fireEvent.change(select, { target: { value: 'ready' } });
    fireEvent.click(screen.getByRole('button', { name: /^move$/i }));

    await screen.findByText('Gate refused the move: needs 1 review(s); 0 of 1 filed.');
    expect(onMoved).not.toHaveBeenCalled();
  });

  it('calls onClose when the close control is activated', async () => {
    const onClose = vi.fn();
    render(<CardDetailView cardId="card-1" onClose={onClose} />);
    await screen.findByRole('heading', { level: 2, name: 'Wire the approval queue' });
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('renders the server refusal verbatim when the card cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ error: 'Access denied: card card-1' }, 403)));
    render(<CardDetailView cardId="card-1" onClose={() => {}} />);
    expect(await screen.findByText('Access denied: card card-1')).toBeInTheDocument();
  });

  it('clears the pending "Saved ✓" reset timer on unmount, rather than leaking it', async () => {
    // Wraps the real setTimeout so every timer in the app and in React/RTL's
    // own internals still runs; only the id(s) this view's 2000ms resets
    // schedule are captured, so this cannot pass on an unrelated timer.
    const realSetTimeout = globalThis.setTimeout;
    const scheduledIds: ReturnType<typeof setTimeout>[] = [];
    const setSpy = vi.spyOn(globalThis, 'setTimeout')
      .mockImplementation((...args: Parameters<typeof setTimeout>) => {
        const id = realSetTimeout(...args);
        if (args[1] === 2000) scheduledIds.push(id);
        return id;
      });
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const { unmount } = render(<CardDetailView cardId="card-1" onClose={() => {}} />);
    const notes = await screen.findByLabelText(/owner notes/i);
    fireEvent.change(notes, { target: { value: 'Edited just before closing the dialog.' } });
    fireEvent.click(screen.getByRole('button', { name: /save notes/i }));
    await waitFor(() => expect(scheduledIds).toHaveLength(1));

    unmount();

    expect(clearSpy).toHaveBeenCalledWith(scheduledIds[0]);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });
});
