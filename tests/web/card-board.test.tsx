import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CardBoardView } from '../../src/web/views/CardBoardView.js';

const board = {
  ladder: { id: 'product', gates: [{ id: 'G1' }, { id: 'G2' }, { id: 'G3' }, { id: 'G4' }] },
  columns: [
    { key: 'backlog', label: 'Backlog' }, { key: 'ready', label: 'Ready' },
    { key: 'in_progress', label: 'In progress' }, { key: 'G1', label: 'G1 design' },
    { key: 'G2', label: 'G2 slice' }, { key: 'G3', label: 'G3 pre-merge' },
    { key: 'G4', label: 'G4 pre-deploy' }, { key: 'blocked', label: 'Blocked' },
    { key: 'done', label: 'Done' },
  ],
  cards: [{ id: 'card-1', title: 'Wire the approval queue', status: 'in_progress', priority: 'high' }],
};

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

describe('the card board', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(
      new Response(JSON.stringify(board), { status: 200, headers: { 'content-type': 'application/json' } }),
    )));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders one column per ladder column, gates included', async () => {
    render(<CardBoardView projectId="project-1" onOpenCard={() => {}} />);
    await waitFor(() => expect(screen.getByText('G1 design')).toBeInTheDocument());
    // Nine columns, not the fixed six the legacy board renders.
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(9);
  });

  it('places a card in the column the server put it in', async () => {
    render(<CardBoardView projectId="project-1" onOpenCard={() => {}} />);
    await waitFor(() => expect(screen.getByText('Wire the approval queue')).toBeInTheDocument());
  });

  it('fetches from the board route the server actually exposes', async () => {
    render(<CardBoardView projectId="project-1" onOpenCard={() => {}} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/projects/project-1/cards'));
  });

  it('calls onOpenCard with the card id when a card is activated', async () => {
    const onOpenCard = vi.fn();
    render(<CardBoardView projectId="project-1" onOpenCard={onOpenCard} />);
    fireEvent.click(await screen.findByText('Wire the approval queue'));
    expect(onOpenCard).toHaveBeenCalledWith('card-1');
  });

  it('shows a card in a gate column by its gate, not by its status', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
      ...board,
      cards: [{ id: 'card-2', title: 'Draft the interface contract', status: 'review', priority: 'medium', gateId: 'G2' }],
    })));
    render(<CardBoardView projectId="project-1" onOpenCard={() => {}} />);
    const title = await screen.findByText('Draft the interface contract');
    const column = title.closest('[data-column-key]');
    expect(column?.getAttribute('data-column-key')).toBe('G2');
  });

  it('renders every card exactly once even when several share a column', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
      ...board,
      cards: [
        { id: 'card-a', title: 'First in progress card', status: 'in_progress', priority: 'low' },
        { id: 'card-b', title: 'Second in progress card', status: 'in_progress', priority: 'low' },
      ],
    })));
    render(<CardBoardView projectId="project-1" onOpenCard={() => {}} />);
    expect(await screen.findByText('First in progress card')).toBeInTheDocument();
    expect(screen.getByText('Second in progress card')).toBeInTheDocument();
  });

  it('renders the server refusal verbatim when the board cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ error: 'Access denied: project project-1' }, 403)));
    render(<CardBoardView projectId="project-1" onOpenCard={() => {}} />);
    expect(await screen.findByText('Access denied: project project-1')).toBeInTheDocument();
  });

  it('refetches when refreshToken changes, rather than trusting a fetch made before a move landed', async () => {
    const fetchMock = vi.fn()
      .mockReturnValueOnce(jsonResponse(board))
      .mockReturnValueOnce(jsonResponse({
        ...board,
        cards: [{ id: 'card-1', title: 'Wire the approval queue', status: 'ready', priority: 'high' }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
      <CardBoardView projectId="project-1" onOpenCard={() => {}} refreshToken={0} />,
    );
    await screen.findByText('Wire the approval queue');
    expect(
      screen.getByText('Wire the approval queue').closest('[data-column-key]')?.getAttribute('data-column-key'),
    ).toBe('in_progress');

    rerender(<CardBoardView projectId="project-1" onOpenCard={() => {}} refreshToken={1} />);

    await waitFor(() => expect(
      screen.getByText('Wire the approval queue').closest('[data-column-key]')?.getAttribute('data-column-key'),
    ).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("places a review card with no recorded gate at the ladder's first gate, not the fixed backlog column", async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
      ...board,
      cards: [{
        id: 'card-nogate', title: 'Needs review, gate not yet recorded',
        status: 'review', priority: 'medium', gateId: null,
      }],
    })));
    render(<CardBoardView projectId="project-1" onOpenCard={() => {}} />);
    const title = await screen.findByText('Needs review, gate not yet recorded');
    expect(title.closest('[data-column-key]')?.getAttribute('data-column-key')).toBe('G1');
  });

  it('shows a card whose key matches no column on the board, rather than dropping it silently', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
      ...board,
      cards: [{
        id: 'card-stray', title: 'Carries a gate this ladder does not have',
        status: 'review', priority: 'low', gateId: 'G9',
      }],
    })));
    render(<CardBoardView projectId="project-1" onOpenCard={() => {}} />);
    expect(await screen.findByText('Carries a gate this ladder does not have')).toBeInTheDocument();
    expect(screen.getByText(/match no column/i)).toBeInTheDocument();
    // Not counted into any real column either.
    const inProgressColumn = screen.getByText('In progress').closest('.card-board-column');
    expect(inProgressColumn?.querySelector('.count-badge')).toHaveTextContent('0');
  });

  it('gives each board card a clean accessible name, not priority, title and description run together', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
      ...board,
      cards: [{
        id: 'card-1', title: 'Wire the approval queue', description: 'Replace the legacy table.',
        status: 'in_progress', priority: 'urgent',
      }],
    })));
    render(<CardBoardView projectId="project-1" onOpenCard={() => {}} />);
    await screen.findByText('Replace the legacy table.');
    // If the button's name were computed from its content (priority + title +
    // description all folded together), this exact-match query would fail.
    expect(screen.getByRole('button', { name: 'Wire the approval queue' })).toBeInTheDocument();
  });
});
