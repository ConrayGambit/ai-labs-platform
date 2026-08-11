import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useRunStream } from '../../src/web/realtime/useRunStream.js';

class MockSocket {
  static last: MockSocket;
  sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) { MockSocket.last = this; }
  send(data: string) { this.sent.push(data); }
  close() {}
  emit(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  emitError() { this.onerror?.(); }
  emitClose() { this.onclose?.(); }
}

beforeEach(() => { vi.stubGlobal('WebSocket', MockSocket); });

/** A real `run_permission_requests` row shape, as the socket actually sends it. */
function permissionRecord(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    runId: 'run-1',
    toolCallId: 'tool-1',
    title: 'Write a file',
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
    status: 'pending',
    selectedOptionId: null,
    answeredByUserId: null,
    createdAt: '2026-08-11T00:00:00.000Z',
    answeredAt: null,
    ...overrides,
  };
}

/** A real `AgentRun` shape, as a `finished` event carries it. */
function runSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    cardId: 'card-1',
    orgAgentId: 'agent-1',
    roomId: 'room-1',
    acpSessionId: 'session-1',
    parentRunId: null,
    status: 'completed',
    stopReason: 'end_turn',
    stoppedReason: null,
    inputTokens: 10,
    outputTokens: 20,
    costCeilingTokens: null,
    startedAt: '2026-08-11T00:00:00.000Z',
    finishedAt: '2026-08-11T00:01:00.000Z',
    ...overrides,
  };
}

/** Opens and negotiates a socket that grants every capability the hook asks for. */
function connectAndGreet(capabilities: string[] = ['run.stream', 'run.permission', 'run.cancel']) {
  act(() => { MockSocket.last.onopen?.(); });
  act(() => {
    MockSocket.last.emit({ type: 'hello', coreVersion: 1, capabilities, unsupported: [] });
  });
}

describe('useRunStream', () => {
  it('says hello, subscribes, and keeps replayed updates in arrival order, without deduping', async () => {
    const { result } = renderHook(() => useRunStream('run-1'));
    act(() => { MockSocket.last.onopen?.(); });
    expect(JSON.parse(MockSocket.last.sent[0]).type).toBe('hello');

    act(() => {
      MockSocket.last.emit({ type: 'hello', coreVersion: 1, capabilities: ['run.stream'], unsupported: [] });
    });
    await waitFor(() => expect(MockSocket.last.sent.some((m) => JSON.parse(m).type === 'subscribe')).toBe(true));

    // Emitted out of seq order, with a duplicate: a sorting or deduping
    // implementation would pass the original, weaker version of this test
    // (ascending seq, no repeats) and fail this one. Arrival order is the
    // property under test, not the seq field's own order.
    act(() => {
      MockSocket.last.emit({ type: 'event', runId: 'run-1', event: { seq: 2, text: 'second' } });
      MockSocket.last.emit({ type: 'event', runId: 'run-1', event: { seq: 1, text: 'first' } });
      MockSocket.last.emit({ type: 'event', runId: 'run-1', event: { seq: 1, text: 'first' } });
    });
    await waitFor(() => expect(result.current.updates).toHaveLength(3));
    expect(result.current.updates[0]).toMatchObject({ seq: 2 });
    expect(result.current.updates[1]).toMatchObject({ seq: 1 });
    expect(result.current.updates[2]).toMatchObject({ seq: 1 });
  });

  it("reports a capability the core refused, with the core's reason", async () => {
    const { result } = renderHook(() => useRunStream('run-1'));
    act(() => { MockSocket.last.onopen?.(); });
    act(() => {
      MockSocket.last.emit({
        type: 'hello', coreVersion: 1, capabilities: ['run.stream'],
        unsupported: [{ capability: 'run.cancel', reason: 'This core does not implement run.cancel.' }],
      });
    });
    await waitFor(() => expect(result.current.unsupported).toHaveLength(1));
    // The client degrades and states why; it does not fail the connection.
    expect(result.current.unsupported[0].reason).toContain('does not implement');
  });

  it('treats a capability granted in neither capabilities nor unsupported as unavailable', async () => {
    const { result } = renderHook(() => useRunStream('run-1'));
    act(() => { MockSocket.last.onopen?.(); });
    act(() => {
      // run.cancel appears in neither list here — an incomplete hello this
      // repo's own negotiate() never actually sends (it is always
      // complementary), but the client must not read "not refused" as
      // "granted". can() has to be defined from the allowlist it already
      // receives (capabilities), not from the absence of a denial.
      MockSocket.last.emit({ type: 'hello', coreVersion: 1, capabilities: ['run.stream'], unsupported: [] });
    });
    await waitFor(() => expect(MockSocket.last.sent.some((m) => JSON.parse(m).type === 'subscribe')).toBe(true));

    act(() => { result.current.cancel(); });

    expect(MockSocket.last.sent.some((m) => JSON.parse(m).type === 'cancel_run')).toBe(false);
  });

  it('sets pending from a real permission_request event, and answer() sends the recorded id', async () => {
    const { result } = renderHook(() => useRunStream('run-1'));
    connectAndGreet();

    const request = permissionRecord('perm-7');
    act(() => {
      MockSocket.last.emit({ type: 'event', runId: 'run-1', event: { type: 'permission_request', request } });
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.pending).toMatchObject({ id: 'perm-7', toolCallId: 'tool-1', status: 'pending' });

    act(() => { result.current.answer('allow'); });

    const sent = MockSocket.last.sent.map((message) => JSON.parse(message));
    expect(sent).toContainEqual({ type: 'answer_permission', requestId: 'perm-7', optionId: 'allow' });
    expect(result.current.pending).toBeNull();
  });

  it('clears pending when the request is answered elsewhere, and when the run finishes', async () => {
    const { result } = renderHook(() => useRunStream('run-1'));
    connectAndGreet();

    act(() => {
      MockSocket.last.emit({
        type: 'event', runId: 'run-1',
        event: { type: 'permission_request', request: permissionRecord('perm-1') },
      });
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());

    // Answered from elsewhere — another window on the same run, or this
    // client's own optimistic answer echoed back — either way, nothing
    // remains pending to answer here.
    act(() => {
      MockSocket.last.emit({
        type: 'event', runId: 'run-1',
        event: {
          type: 'permission_answered',
          request: permissionRecord('perm-1', { status: 'answered', selectedOptionId: 'allow' }),
        },
      });
    });
    await waitFor(() => expect(result.current.pending).toBeNull());

    act(() => {
      MockSocket.last.emit({
        type: 'event', runId: 'run-1',
        event: { type: 'permission_request', request: permissionRecord('perm-2') },
      });
    });
    await waitFor(() => expect(result.current.pending).not.toBeNull());

    // The run ending clears it too — there is nothing left to answer.
    act(() => {
      MockSocket.last.emit({ type: 'event', runId: 'run-1', event: { type: 'finished', run: runSummary() } });
    });
    await waitFor(() => expect(result.current.pending).toBeNull());
  });

  it('appends a real agent update event to the transcript', async () => {
    const { result } = renderHook(() => useRunStream('run-1'));
    connectAndGreet();

    act(() => {
      MockSocket.last.emit({
        type: 'event', runId: 'run-1',
        event: {
          type: 'update',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello.' } },
        },
      });
    });

    await waitFor(() => expect(result.current.updates).toHaveLength(1));
    expect(result.current.updates[0]).toMatchObject({
      type: 'update', update: { sessionUpdate: 'agent_message_chunk' },
    });
  });

  it('clears the transcript, pending permission, and unsupported list when runId changes', async () => {
    const { result, rerender } = renderHook(({ runId }) => useRunStream(runId), {
      initialProps: { runId: 'run-1' as string | null },
    });
    act(() => { MockSocket.last.onopen?.(); });
    act(() => {
      MockSocket.last.emit({
        type: 'hello', coreVersion: 1, capabilities: ['run.stream'],
        unsupported: [{ capability: 'run.cancel', reason: 'not granted' }],
      });
    });
    act(() => {
      MockSocket.last.emit({ type: 'event', runId: 'run-1', event: { seq: 1, text: 'first' } });
      MockSocket.last.emit({
        type: 'event', runId: 'run-1',
        event: { type: 'permission_request', request: permissionRecord('perm-1') },
      });
    });
    await waitFor(() => expect(result.current.updates).toHaveLength(2));
    expect(result.current.pending).not.toBeNull();
    expect(result.current.unsupported).toHaveLength(1);

    // A new run is a new transcript: none of the above belongs to run-2.
    rerender({ runId: 'run-2' });

    expect(result.current.updates).toEqual([]);
    expect(result.current.pending).toBeNull();
    expect(result.current.unsupported).toEqual([]);
  });

  it('ignores a late event and a late close from an abandoned socket after the run changes', async () => {
    const { result, rerender } = renderHook(({ runId }) => useRunStream(runId), {
      initialProps: { runId: 'run-1' as string | null },
    });
    act(() => { MockSocket.last.onopen?.(); });
    const firstSocket = MockSocket.last;
    act(() => {
      firstSocket.emit({ type: 'hello', coreVersion: 1, capabilities: ['run.stream'], unsupported: [] });
    });

    rerender({ runId: 'run-2' });
    const secondSocket = MockSocket.last;
    expect(secondSocket).not.toBe(firstSocket);

    // The abandoned socket is still holding its handlers and fires late,
    // after this hook has already moved on to run-2's socket.
    act(() => {
      firstSocket.emit({ type: 'event', runId: 'run-1', event: { seq: 99, text: 'late' } });
      firstSocket.emitClose();
    });

    expect(result.current.updates).toEqual([]);
    expect(result.current.connection).not.toBe('closed');
  });

  it('reports the connection opening', () => {
    const { result } = renderHook(() => useRunStream('run-1'));
    expect(result.current.connection).toBe('connecting');

    act(() => { MockSocket.last.onopen?.(); });
    expect(result.current.connection).toBe('open');
  });

  it('surfaces a socket error rather than looking like a quiet run', async () => {
    const { result } = renderHook(() => useRunStream('run-1'));
    act(() => { MockSocket.last.onopen?.(); });

    act(() => { MockSocket.last.emitError(); });

    await waitFor(() => expect(result.current.connection).toBe('error'));
    // The whole point: an empty transcript here must not be the only signal.
    expect(result.current.updates).toEqual([]);
  });

  it('surfaces an unexpected close rather than looking like a quiet run', async () => {
    const { result } = renderHook(() => useRunStream('run-1'));
    act(() => { MockSocket.last.onopen?.(); });

    act(() => { MockSocket.last.emitClose(); });

    await waitFor(() => expect(result.current.connection).toBe('closed'));
    expect(result.current.updates).toEqual([]);
  });
});
