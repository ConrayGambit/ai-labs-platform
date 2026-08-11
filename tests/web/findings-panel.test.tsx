import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EscalationBanner } from '../../src/web/views/EscalationBanner.js';
import { FindingsPanel } from '../../src/web/views/FindingsPanel.js';

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

function findingRow(
  id: string,
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4',
  finding: string,
) {
  return {
    id, reviewId: 'review-1', priority, area: 'access', finding,
    predictedFailure: 'A staff user reads another venture cards.',
    evidence: 'src/server/example-module.ts:1', proposedFix: 'Call assertVentureAccess first.',
    createdAt: '2026-08-10T00:00:00.000Z',
  };
}

function reviewStateWith(findings: ReturnType<typeof findingRow>[]) {
  return {
    cardId: 'card-1', gateId: 'G1', requiredReviewers: 1, filedReviewerIds: ['reviewer-1'],
    deadlineAt: null, sealed: false, sealReason: null,
    visibleReviews: [{
      id: 'review-1', cardId: 'card-1', gateId: 'G1', reviewerOrgAgentId: 'reviewer-1',
      verdict: 'approve_with_findings', checklist: [], whatToPreserve: '', questionsForBuilder: '',
      findings, supersededByReviewId: null, filedAt: '2026-08-10T00:00:00.000Z',
    }],
  };
}

function assignment(role: 'builder' | 'reviewer', orgAgentId: string) {
  return {
    id: `assignment-${orgAgentId}`, cardId: 'card-1', gateId: 'G1', role, orgAgentId,
    assignedAt: '2026-08-10T00:00:00.000Z', reviewDeadlineAt: null,
  };
}

/**
 * Routes a mocked `fetch` for FindingsPanel's two GETs plus whatever
 * `extra` handlers a test supplies (typically the adjudicate POST).
 */
function stubFindingsRoutes(
  state: ReturnType<typeof reviewStateWith>,
  assignments: ReturnType<typeof assignment>[],
  extra: Record<string, () => Promise<Response>> = {},
) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const key = `${method} ${url}`;
    if (url === '/api/cards/card-1/gates/G1/review-state') return jsonResponse(state);
    if (url === '/api/cards/card-1/gates/G1/assignments') return jsonResponse({ assignments });
    if (extra[key]) return extra[key]();
    throw new Error(`Unexpected request: ${key}`);
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the findings panel', () => {
  it('renders findings on the P0-P4 ladder, worst first, regardless of arrival order', async () => {
    // Deliberately arrives P2-before-P0 — a sort that only passes by
    // accident would still pass against an already-sorted fixture.
    const state = reviewStateWith([
      findingRow('finding-p2', 'P2', 'The cost ceiling is evaluated late.'),
      findingRow('finding-p0', 'P0', 'The route does not check venture access.'),
    ]);
    stubFindingsRoutes(state, []);

    render(<FindingsPanel cardId="card-1" gateId="G1" />);
    await waitFor(() => expect(screen.getByText('The route does not check venture access.')).toBeInTheDocument());

    const priorityPills = screen.getAllByText(/^P[0-4]$/);
    expect(priorityPills.map((pill) => pill.textContent)).toEqual(['P0', 'P2']);
  });

  it("fetches the gate's real assignments and seeds ruledByOrgAgentId from the registered builder, never a guess", async () => {
    const state = reviewStateWith([findingRow('finding-p2', 'P2', 'The cost ceiling is evaluated late.')]);
    stubFindingsRoutes(state, [assignment('reviewer', 'reviewer-1'), assignment('builder', 'builder-real')], {
      'POST /api/findings/finding-p2/adjudicate': () => {
        return jsonResponse({
          ruling: {
            id: 'ruling-1', findingId: 'finding-p2', ruledByOrgAgentId: 'builder-real', ruledByUserId: null,
            outcome: 'adopted', reason: 'Fair.', nextStep: null, residualRisk: null,
            isFinal: false, ruledAt: '2026-08-10T00:00:00.000Z',
          },
          registerEntry: null,
        }, 201);
      },
    });
    const fetchMock = vi.mocked(fetch);

    render(<FindingsPanel cardId="card-1" gateId="G1" />);
    await waitFor(() => expect(screen.getByText('The cost ceiling is evaluated late.')).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/api/cards/card-1/gates/G1/assignments');

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Fair.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adopt' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/findings/finding-p2/adjudicate',
      expect.objectContaining({
        body: JSON.stringify({ gateId: 'G1', outcome: 'adopted', reason: 'Fair.', ruledByOrgAgentId: 'builder-real' }),
      }),
    ));
    expect(await screen.findByText(/ruled adopted — fair\./i)).toBeInTheDocument();
  });

  it('calls onAdjudicated once an adjudication succeeds', async () => {
    const state = reviewStateWith([findingRow('finding-p2', 'P2', 'The cost ceiling is evaluated late.')]);
    stubFindingsRoutes(state, [assignment('builder', 'builder-1')], {
      'POST /api/findings/finding-p2/adjudicate': () => jsonResponse({
        ruling: {
          id: 'ruling-1', findingId: 'finding-p2', ruledByOrgAgentId: 'builder-1', ruledByUserId: null,
          outcome: 'adopted', reason: 'Fair.', nextStep: null, residualRisk: null,
          isFinal: false, ruledAt: '2026-08-10T00:00:00.000Z',
        },
        registerEntry: null,
      }, 201),
    });
    const onAdjudicated = vi.fn();

    render(<FindingsPanel cardId="card-1" gateId="G1" onAdjudicated={onAdjudicated} />);
    await waitFor(() => expect(screen.getByText('The cost ceiling is evaluated late.')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Fair.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adopt' }));

    await waitFor(() => expect(onAdjudicated).toHaveBeenCalledTimes(1));
  });

  it('renders the server refusal verbatim when adjudication is refused, never a predicted reason', async () => {
    const state = reviewStateWith([findingRow('finding-p2', 'P2', 'The cost ceiling is evaluated late.')]);
    stubFindingsRoutes(state, [assignment('builder', 'builder-1')], {
      'POST /api/findings/finding-p2/adjudicate': () => jsonResponse(
        { error: 'A deferral needs a named next step and a date to revisit it; without them it is a finding dropped' },
        409,
      ),
    });

    render(<FindingsPanel cardId="card-1" gateId="G1" />);
    await waitFor(() => expect(screen.getByText('The cost ceiling is evaluated late.')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Revisit later.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Defer' }));

    expect(await screen.findByText(
      'A deferral needs a named next step and a date to revisit it; without them it is a finding dropped',
    )).toBeInTheDocument();
  });

  it('never disables the three outcomes on its own guess about which is allowed', async () => {
    const state = reviewStateWith([findingRow('finding-p0', 'P0', 'The route does not check venture access.')]);
    stubFindingsRoutes(state, [assignment('builder', 'builder-1')]);

    render(<FindingsPanel cardId="card-1" gateId="G1" />);
    await waitFor(() => expect(screen.getByText('The route does not check venture access.')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'It goes to the owner.' } });
    // A P0 may never be overridden by the builder — but that is the server's
    // rule to enforce (governance-policy.ts's canOverride), not this panel's
    // to pre-empt by disabling the button.
    expect(screen.getByRole('button', { name: 'Override' })).toBeEnabled();
  });

  it('names the true reason adjudication is unavailable when no builder is registered at the gate, never an invented one', async () => {
    const state = reviewStateWith([findingRow('finding-p2', 'P2', 'The cost ceiling is evaluated late.')]);
    // Nobody holds the builder role yet — only a reviewer is assigned.
    stubFindingsRoutes(state, [assignment('reviewer', 'reviewer-1')]);

    render(<FindingsPanel cardId="card-1" gateId="G1" />);
    await waitFor(() => expect(screen.getByText('The cost ceiling is evaluated late.')).toBeInTheDocument());

    expect(screen.getByText('No builder is registered at this gate yet.')).toBeInTheDocument();
    expect(screen.queryByText(/assign an agent to this card/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Fine.' } });
    expect(screen.getByRole('button', { name: 'Adopt' })).toBeDisabled();
  });
});

describe('the escalation banner', () => {
  it('renders an open P0 as the banner, and states plainly that the card is stopped', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({
      escalations: [{
        id: 'escalation-1', findingId: 'finding-p0', cardId: 'card-1', status: 'open',
        resolution: null, resolvedByUserId: null, raisedAt: '2026-08-10T00:00:00.000Z', resolvedAt: null,
      }],
    })));

    render(<EscalationBanner cardId="card-1" />);

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/this card is stopped/i)).toBeInTheDocument();
  });

  it('renders nothing when there is no open escalation', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ escalations: [] })));
    const { container } = render(<EscalationBanner cardId="card-1" />);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a refused resolve call verbatim, in the server\'s own words', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url === '/api/escalations?cardId=card-1') {
        return jsonResponse({
          escalations: [{
            id: 'escalation-1', findingId: 'finding-p0', cardId: 'card-1', status: 'open',
            resolution: null, resolvedByUserId: null, raisedAt: '2026-08-10T00:00:00.000Z', resolvedAt: null,
          }],
        });
      }
      if (method === 'POST' && url === '/api/escalations/escalation-1/resolve') {
        return jsonResponse({ error: 'Only the owner may resolve a P0 escalation: agent-x may not' }, 403);
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<EscalationBanner cardId="card-1" />);
    const resolution = await screen.findByLabelText('Resolution');
    fireEvent.change(resolution, { target: { value: 'Access check added.' } });
    fireEvent.click(screen.getByRole('button', { name: /resolve escalation/i }));

    expect(await screen.findByText('Only the owner may resolve a P0 escalation: agent-x may not')).toBeInTheDocument();
    // The banner itself does not vanish on a refused resolve — the card is
    // still stopped, and rendering nothing here would say otherwise.
    expect(screen.getByText(/this card is stopped/i)).toBeInTheDocument();
  });

  it('removes a resolved escalation from the banner, and clears the banner once none remain', async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url === '/api/escalations?cardId=card-1') {
        return jsonResponse({
          escalations: [{
            id: 'escalation-1', findingId: 'finding-p0', cardId: 'card-1', status: 'open',
            resolution: null, resolvedByUserId: null, raisedAt: '2026-08-10T00:00:00.000Z', resolvedAt: null,
          }],
        });
      }
      if (method === 'POST' && url === '/api/escalations/escalation-1/resolve') {
        return jsonResponse({
          id: 'escalation-1', findingId: 'finding-p0', cardId: 'card-1', status: 'resolved',
          resolution: 'Access check added.', resolvedByUserId: 'owner',
          raisedAt: '2026-08-10T00:00:00.000Z', resolvedAt: '2026-08-10T01:00:00.000Z',
        });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<EscalationBanner cardId="card-1" />);
    const resolution = await screen.findByLabelText('Resolution');
    fireEvent.change(resolution, { target: { value: 'Access check added.' } });
    fireEvent.click(screen.getByRole('button', { name: /resolve escalation/i }));

    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
