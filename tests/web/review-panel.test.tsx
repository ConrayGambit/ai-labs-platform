import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewPanel } from '../../src/web/views/ReviewPanel.js';

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

const sealed = {
  cardId: 'card-1', gateId: 'G1', requiredReviewers: 2,
  filedReviewerIds: ['agent-a'], deadlineAt: null,
  sealed: true, sealReason: '1 of 2 reviewers have filed.',
  visibleReviews: [{ id: 'review-1', reviewerOrgAgentId: 'agent-a', verdict: 'approve_with_findings', findings: [] }],
};

const unsealed = {
  cardId: 'card-1', gateId: 'G1', requiredReviewers: 1,
  filedReviewerIds: ['agent-a', 'agent-b'], deadlineAt: null,
  sealed: false, sealReason: null,
  visibleReviews: [
    {
      id: 'review-1', cardId: 'card-1', gateId: 'G1', reviewerOrgAgentId: 'agent-a',
      verdict: 'approve', checklist: [{ item: 'Meets the acceptance criteria?', answer: 'Yes.' }],
      whatToPreserve: 'The existing error handling.', questionsForBuilder: '',
      findings: [], supersededByReviewId: null, filedAt: '2026-08-10T00:00:00.000Z',
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the review panel', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(sealed)));
  });

  it('renders a sealed gate as a state, with its reason', async () => {
    render(<ReviewPanel cardId="card-1" gateId="G1" />);
    // Blindness must read as "sealed until both are filed", never as nothing.
    await waitFor(() => expect(screen.getByText(/sealed/i)).toBeInTheDocument());
    expect(screen.getByText('1 of 2 reviewers have filed.')).toBeInTheDocument();
  });

  it('does not present a sealed gate as an empty review list', async () => {
    render(<ReviewPanel cardId="card-1" gateId="G1" />);
    await waitFor(() => expect(screen.getByText(/sealed/i)).toBeInTheDocument());
    expect(screen.queryByText(/no reviews/i)).not.toBeInTheDocument();
    // The one review this viewer may already see (its own) still renders
    // alongside the seal, not in place of it.
    expect(screen.getByText('agent-a')).toBeInTheDocument();
  });

  it('fetches the exact gate this panel was given', async () => {
    render(<ReviewPanel cardId="card-1" gateId="G1" />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/cards/card-1/gates/G1/review-state'));
  });
});

describe('an unsealed gate', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(unsealed)));
  });

  it('renders no seal state, and shows the filed review in full', async () => {
    render(<ReviewPanel cardId="card-1" gateId="G1" />);
    await waitFor(() => expect(screen.getByText('agent-a')).toBeInTheDocument());
    expect(screen.queryByText(/^sealed$/i)).not.toBeInTheDocument();
    expect(screen.getByText('approve')).toBeInTheDocument();
    expect(screen.getByText('Meets the acceptance criteria?')).toBeInTheDocument();
    expect(screen.getByText(/the existing error handling/i)).toBeInTheDocument();
  });

  it('shows the reviewer progress the server reported', async () => {
    render(<ReviewPanel cardId="card-1" gateId="G1" />);
    await waitFor(() => expect(screen.getByText('Filed 2 of 1')).toBeInTheDocument());
  });
});

describe('a genuinely empty gate', () => {
  it('names the empty state, never confusing it with a sealed one', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
      cardId: 'card-1', gateId: 'G1', requiredReviewers: 1, filedReviewerIds: [],
      deadlineAt: null, sealed: false, sealReason: null, visibleReviews: [],
    })));
    render(<ReviewPanel cardId="card-1" gateId="G1" />);
    await waitFor(() => expect(screen.getByText(/no reviews are visible yet/i)).toBeInTheDocument());
    expect(screen.queryByText(/^sealed$/i)).not.toBeInTheDocument();
  });
});

describe('a refused review-state request', () => {
  it('renders the server refusal verbatim, never a predicted reason', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ error: 'Access denied: card card-1' }, 403)));
    render(<ReviewPanel cardId="card-1" gateId="G1" />);
    expect(await screen.findByText('Access denied: card card-1')).toBeInTheDocument();
  });
});
