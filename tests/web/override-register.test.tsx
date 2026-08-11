import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverrideRegisterView } from '../../src/web/views/OverrideRegisterView.js';

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

const original = {
  id: 'override-1', reference: 'OV-0001', sequence: 1, findingId: 'finding-1', cardId: 'card-1',
  reviewerOrgAgentId: 'reviewer-1', priority: 'P2', reason: 'The write is idempotent.',
  residualRisk: 'One redundant row.', deferredUntil: null, supersedesId: null,
  supersededById: 'override-2', createdByOrgAgentId: 'builder-1', createdAt: '2026-08-10T00:00:00.000Z',
};

const correction = {
  id: 'override-2', reference: 'OV-0002', sequence: 2, findingId: 'finding-1', cardId: 'card-1',
  reviewerOrgAgentId: 'reviewer-1', priority: 'P2', reason: 'The write is not idempotent after all.',
  residualRisk: 'A duplicate row on every stopped run.', deferredUntil: null, supersedesId: 'override-1',
  supersededById: null, createdByOrgAgentId: 'builder-1', createdAt: '2026-08-10T01:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the override register', () => {
  it('renders a superseded entry as superseded', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ entries: [original, correction] })));
    render(<OverrideRegisterView />);

    await waitFor(() => expect(screen.getByText('OV-0001')).toBeInTheDocument());
    expect(screen.getByText('Superseded')).toBeInTheDocument();
    // The correcting entry is current, so it carries no such marker.
    expect(screen.getAllByText('Superseded')).toHaveLength(1);
  });

  it('renders every entry exactly as filed — no edit control exists anywhere in the output', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ entries: [original, correction] })));
    const { container } = render(<OverrideRegisterView />);
    await waitFor(() => expect(screen.getByText('OV-0001')).toBeInTheDocument());

    // The register is read-only: no button, no input, no textarea, no
    // contenteditable region, anywhere in what this view renders.
    expect(container.querySelectorAll('button, input, textarea, select, [contenteditable]')).toHaveLength(0);
    expect(screen.queryByText(/edit/i)).not.toBeInTheDocument();
  });

  it('scopes the register to one card when given', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ entries: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<OverrideRegisterView cardId="card-1" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/override-register?cardId=card-1'));
  });

  it('names an empty register rather than showing nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ entries: [] })));
    render(<OverrideRegisterView />);
    expect(await screen.findByText(/the register is empty/i)).toBeInTheDocument();
  });

  it('renders the server refusal verbatim when the register cannot be loaded', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ error: 'Access denied: card card-1' }, 403)));
    render(<OverrideRegisterView cardId="card-1" />);
    expect(await screen.findByText('Access denied: card card-1')).toBeInTheDocument();
  });
});
