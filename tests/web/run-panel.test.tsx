import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunSummary } from '../../src/web/api/client.js';
import { RunPanel } from '../../src/web/views/RunPanel.js';

/**
 * `useRunStream` is mocked rather than driven through a real socket: this
 * file's job is the panel's own rendering and wiring (does it show what the
 * hook reports, does it call `answer`/`cancel` correctly), which the hook's
 * own suite (tests/web/use-run-stream.test.ts) already covers at the socket
 * level. `vi.hoisted` is required here, not stylistic: `vi.mock` factories
 * are hoisted above every import in this file, so a factory that closed over
 * a plain `const` declared below it would see that binding before
 * initialization.
 */
const { mockUseRunStream } = vi.hoisted(() => ({ mockUseRunStream: vi.fn() }));
vi.mock('../../src/web/realtime/useRunStream.js', () => ({
  useRunStream: (runId: string | null) => mockUseRunStream(runId),
}));

type StreamState = ReturnType<typeof baseStream>;

function baseStream() {
  return {
    updates: [] as unknown[],
    pending: null as unknown,
    unsupported: [] as { capability: string; reason: string }[],
    connection: 'closed' as 'connecting' | 'open' | 'closed' | 'error',
    answer: vi.fn(),
    cancel: vi.fn(),
  };
}

function stream(overrides: Partial<StreamState> = {}): StreamState {
  return { ...baseStream(), ...overrides };
}

/** A real `PermissionOption` (src/shared/acp.ts): `{ optionId, name, kind }`, never `{ id, label }`. */
function permissionOption(optionId: string, name: string, kind = 'allow_once') {
  return { optionId, name, kind };
}

/** A real `PendingPermission` (src/web/realtime/useRunStream.ts), mirroring the server's `PermissionRecord`. */
function pendingPermission(overrides: Record<string, unknown> = {}) {
  return {
    id: 'req-1',
    runId: 'run-1',
    toolCallId: 'tool-1',
    title: 'Write a file',
    options: [permissionOption('allow', 'Allow'), permissionOption('reject', 'Reject')],
    status: 'pending',
    selectedOptionId: null,
    answeredByUserId: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    answeredAt: null,
    ...overrides,
  };
}

/** A real `RunSummary` (src/web/api/client.ts), mirroring the server's `AgentRun`. */
function runSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'run-1',
    cardId: 'card-1',
    orgAgentId: 'agent-1',
    roomId: 'room-1',
    acpSessionId: 'session-1',
    parentRunId: null,
    status: 'running',
    stopReason: null,
    stoppedReason: null,
    inputTokens: 0,
    outputTokens: 0,
    costCeilingTokens: null,
    startedAt: '2026-08-11T00:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

function agentMessage(text: string) {
  return { type: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } };
}

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

beforeEach(() => {
  mockUseRunStream.mockReset();
  mockUseRunStream.mockReturnValue(stream());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the run panel', () => {
  it('shows the transcript in order and a pending permission request, answered by optionId not name', async () => {
    const answer = vi.fn();
    mockUseRunStream.mockReturnValue(stream({
      updates: [agentMessage('Reading the card'), agentMessage('Proposing a change')],
      pending: pendingPermission(),
      connection: 'open',
      answer,
    }));

    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    await waitFor(() => expect(screen.getByText('Reading the card')).toBeInTheDocument());
    // A permission request that cannot be answered is a run that hangs.
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    // The option's id travels to answer(), never its display name.
    expect(answer).toHaveBeenCalledWith('allow');
  });

  it('renders the transcript in the exact order it arrived, never sorting or reordering it', async () => {
    // Deliberately not chronological-sounding: a sort or a reorder would pass
    // this only by accident. This is the one property the acceptance walk
    // exists to verify — see useRunStream's own doc comment.
    mockUseRunStream.mockReturnValue(stream({
      updates: [agentMessage('Second thing said'), agentMessage('First thing said')],
      connection: 'open',
    }));

    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    const rows = await screen.findAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Second thing said'),
      expect.stringContaining('First thing said'),
    ]);
  });

  it('makes the transcript keyboard-focusable, so a keyboard-only user can scroll back through a long replay', () => {
    mockUseRunStream.mockReturnValue(stream({
      updates: [agentMessage('Reading the card')],
      connection: 'open',
    }));
    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    expect(screen.getByRole('list', { name: /run transcript/i })).toHaveAttribute('tabindex', '0');
  });

  it('renders a tool call and a usage update without assuming fields a provider did not send', async () => {
    mockUseRunStream.mockReturnValue(stream({
      updates: [
        { type: 'update', update: { sessionUpdate: 'tool_call', toolCall: { toolCallId: 'tc-1' } } },
        { type: 'update', update: { sessionUpdate: 'usage_update', usage: { inputTokens: 12, outputTokens: 34 } } },
      ],
      connection: 'open',
    }));

    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    expect(await screen.findByText('Tool tc-1')).toBeInTheDocument();
    expect(screen.getByText('12 in / 34 out')).toBeInTheDocument();
  });

  it('shows the connection state, so a dead socket is never mistaken for a quiet run', () => {
    mockUseRunStream.mockReturnValue(stream({ connection: 'error' }));
    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    // Scoped to the connection line itself: an 'error' connection now also
    // disables Cancel with its own "Connection error." reason (see the
    // it.each below), so the phrase legitimately appears twice.
    expect(screen.getByText(/connection error/i, { selector: '.run-connection' })).toBeInTheDocument();
  });

  it('disables the cancel control with the core\'s stated reason when run.cancel is unsupported', () => {
    mockUseRunStream.mockReturnValue(stream({
      connection: 'open',
      unsupported: [{ capability: 'run.cancel', reason: 'This core does not implement run.cancel.' }],
    }));
    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    expect(screen.getByRole('button', { name: /cancel run/i })).toBeDisabled();
    expect(screen.getByText('This core does not implement run.cancel.')).toBeInTheDocument();
  });

  it('disables the permission options with the reason, rather than a button that answers nothing', () => {
    mockUseRunStream.mockReturnValue(stream({
      pending: pendingPermission(),
      unsupported: [{ capability: 'run.permission', reason: 'This core does not implement run.permission.' }],
    }));
    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(screen.getByText('This core does not implement run.permission.')).toBeInTheDocument();
  });

  it('renders the pending permission as a labelled group, not an alert that steals focus from a decision the user must make', () => {
    mockUseRunStream.mockReturnValue(stream({ pending: pendingPermission(), connection: 'open' }));
    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    expect(screen.getByRole('group', { name: 'Needs your decision' })).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: 'Needs your decision' })).not.toBeInTheDocument();
  });

  it('surfaces a refused request rather than dropping it — the two-window race: this window answers after another window already did', async () => {
    // useRunStream clears `pending` optimistically before the server confirms
    // the answer (see useRunStream.ts), so a refused answer_permission leaves
    // nothing pending and, without this, nothing on screen saying why.
    mockUseRunStream.mockReturnValue(stream({
      pending: null,
      updates: [agentMessage('Reading the card')],
      unsupported: [{ capability: 'answer_permission', reason: 'Permission request has already been answered' }],
      connection: 'open',
    }));
    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    expect(screen.getByText(
      'Answering was refused: Permission request has already been answered',
    )).toBeInTheDocument();
  });

  it('surfaces a refused cancel_run or subscribe the same way, each named to its own action', () => {
    mockUseRunStream.mockReturnValue(stream({
      connection: 'open',
      unsupported: [
        { capability: 'cancel_run', reason: 'Run not found: run-1' },
        { capability: 'subscribe', reason: 'Access denied: run run-1' },
      ],
    }));
    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    expect(screen.getByText('Cancelling was refused: Run not found: run-1')).toBeInTheDocument();
    expect(screen.getByText('Connecting to this run was refused: Access denied: run run-1')).toBeInTheDocument();
  });

  it('does not mistake a capability-negotiation entry (run.stream) for a request refusal', () => {
    mockUseRunStream.mockReturnValue(stream({
      connection: 'open',
      unsupported: [{ capability: 'run.stream', reason: 'This core does not implement run.stream.' }],
    }));
    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    expect(screen.queryByText(/This core does not implement run\.stream\./)).not.toBeInTheDocument();
  });

  it('calls cancel() through the hook when the control is enabled', () => {
    const cancel = vi.fn();
    mockUseRunStream.mockReturnValue(stream({ connection: 'open', cancel }));
    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    fireEvent.click(screen.getByRole('button', { name: /cancel run/i }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['connecting' as const, 'Still connecting.'],
    ['closed' as const, 'Disconnected.'],
    ['error' as const, 'Connection error.'],
  ])('disables cancel and the permission options when the connection is %s, not just when unsupported names them', (connection, reason) => {
    // The bug this defends against: before the core's hello arrives (or after
    // a drop), `unsupported` is still `[]`, so a check that only reads
    // `unsupported` sees nothing wrong and renders both controls as live —
    // cancel()/answer() would then no-op inside the hook, silently, because
    // they gate on a negotiated capability this panel cannot see at all.
    mockUseRunStream.mockReturnValue(stream({ pending: pendingPermission(), connection, unsupported: [] }));
    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    expect(screen.getByRole('button', { name: /cancel run/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    // Two separate reasons render (cancel's own, and the permission block's
    // own) — assert the count rather than a single getByText, which would
    // throw on more than one match.
    expect(screen.getAllByText(reason)).toHaveLength(2);
  });

  it('disables cancel once the run has finished, even when run.cancel is supported', () => {
    mockUseRunStream.mockReturnValue(stream({
      updates: [{ type: 'finished', run: runSummary({ status: 'completed' }) }],
      connection: 'open',
    }));
    render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" runId="run-1" />);
    expect(screen.getByRole('button', { name: /cancel run/i })).toBeDisabled();
    expect(screen.getByText('This run has already finished.')).toBeInTheDocument();
  });

  it('shows the seed run record\'s cost and status before anything has streamed', () => {
    render(
      <RunPanel
        assigneeOrgAgentId="agent-1"
        cardId="card-1"
        run={runSummary({ inputTokens: 42, outputTokens: 7, costCeilingTokens: 1000 })}
        runId="run-1"
      />,
    );
    expect(screen.getByText(/42 in \/ 7 out/)).toBeInTheDocument();
    expect(screen.getByText(/ceiling 1,000/)).toBeInTheDocument();
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  it('refines cost and status from a finished event over the seed record once one streams', () => {
    mockUseRunStream.mockReturnValue(stream({
      updates: [{ type: 'finished', run: runSummary({
        status: 'completed', inputTokens: 1234, outputTokens: 5678, costCeilingTokens: 50000,
      }) }],
    }));
    render(
      <RunPanel
        assigneeOrgAgentId="agent-1"
        cardId="card-1"
        run={runSummary({ inputTokens: 10, outputTokens: 20 })}
        runId="run-1"
      />,
    );
    expect(screen.getByText(/1,234 in \/ 5,678 out/)).toBeInTheDocument();
    // 'completed' legitimately appears twice — the status pill and the
    // transcript's own 'Finished' row for the same event — so this scopes to
    // the pill specifically rather than asserting the text exists anywhere.
    expect(screen.getByText('completed', { selector: '.run-status' })).toBeInTheDocument();
    expect(screen.queryByText(/10 in \/ 20 out/)).not.toBeInTheDocument();
  });

  it('marks a live run with the running status and no other', () => {
    mockUseRunStream.mockReturnValue(stream({ connection: 'open' }));
    render(
      <RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" run={runSummary({ status: 'running' })} runId="run-1" />,
    );
    expect(screen.getByText('running')).toBeInTheDocument();
  });

  describe('starting a run', () => {
    it('renders no transcript or run status when the card has none yet', () => {
      render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" run={null} runId={null} />);
      expect(screen.queryByRole('list', { name: /run transcript/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /cancel run/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^start run$/i })).toBeInTheDocument();
    });

    it('is disabled without an assigned agent, and states why', () => {
      render(<RunPanel assigneeOrgAgentId={null} cardId="card-1" run={null} runId={null} />);
      expect(screen.getByRole('button', { name: /^start run$/i })).toBeDisabled();
      expect(screen.getByText(/assign an agent to this card/i)).toBeInTheDocument();
    });

    it('posts directly to POST /api/cards/:cardId/runs with the card\'s assignee and the typed message', async () => {
      const fetchMock = vi.fn(() => jsonResponse(runSummary({ id: 'run-9' }), 202));
      vi.stubGlobal('fetch', fetchMock);

      render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" run={null} runId={null} />);
      fireEvent.change(screen.getByLabelText(/message to the agent/i), {
        target: { value: 'Read the card and propose a change.' },
      });
      fireEvent.click(screen.getByRole('button', { name: /^start run$/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        '/api/cards/card-1/runs',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            orgAgentId: 'agent-1',
            message: 'Read the card and propose a change.',
            costCeilingTokens: null,
          }),
        }),
      ));
    });

    it('sends a typed cost ceiling as a number', async () => {
      const fetchMock = vi.fn(() => jsonResponse(runSummary({ id: 'run-9' }), 202));
      vi.stubGlobal('fetch', fetchMock);

      render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" run={null} runId={null} />);
      fireEvent.change(screen.getByLabelText(/message to the agent/i), { target: { value: 'Go.' } });
      fireEvent.change(screen.getByLabelText(/token cost ceiling/i), { target: { value: '5000' } });
      fireEvent.click(screen.getByRole('button', { name: /^start run$/i }));

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        '/api/cards/card-1/runs',
        expect.objectContaining({
          body: JSON.stringify({ orgAgentId: 'agent-1', message: 'Go.', costCeilingTokens: 5000 }),
        }),
      ));
    });

    it('switches to watching the run it just started', async () => {
      vi.stubGlobal('fetch', vi.fn(() => jsonResponse(runSummary({ id: 'run-9' }), 202)));

      render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" run={null} runId={null} />);
      fireEvent.change(screen.getByLabelText(/message to the agent/i), { target: { value: 'Go.' } });
      fireEvent.click(screen.getByRole('button', { name: /^start run$/i }));

      await waitFor(() => expect(mockUseRunStream).toHaveBeenCalledWith('run-9'));
    });

    it('renders the server refusal verbatim when starting a run is refused', async () => {
      vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ error: 'Access denied: card card-1' }, 403)));

      render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" run={null} runId={null} />);
      fireEvent.change(screen.getByLabelText(/message to the agent/i), { target: { value: 'Go.' } });
      fireEvent.click(screen.getByRole('button', { name: /^start run$/i }));

      expect(await screen.findByText('Access denied: card card-1')).toBeInTheDocument();
    });

    it('is disabled until a message is typed', () => {
      render(<RunPanel assigneeOrgAgentId="agent-1" cardId="card-1" run={null} runId={null} />);
      expect(screen.getByRole('button', { name: /^start run$/i })).toBeDisabled();
      fireEvent.change(screen.getByLabelText(/message to the agent/i), { target: { value: '  ' } });
      expect(screen.getByRole('button', { name: /^start run$/i })).toBeDisabled();
      fireEvent.change(screen.getByLabelText(/message to the agent/i), { target: { value: 'Go.' } });
      expect(screen.getByRole('button', { name: /^start run$/i })).not.toBeDisabled();
    });
  });
});
