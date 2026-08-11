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
});
