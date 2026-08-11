import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useRunStream } from '../../src/web/realtime/useRunStream.js';

class MockSocket {
  static last: MockSocket;
  sent: string[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(public url: string) { MockSocket.last = this; }
  send(data: string) { this.sent.push(data); }
  close() {}
  emit(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

beforeEach(() => { vi.stubGlobal('WebSocket', MockSocket); });

describe('useRunStream', () => {
  it('says hello, subscribes, and keeps replayed updates in order', async () => {
    const { result } = renderHook(() => useRunStream('run-1'));
    act(() => { MockSocket.last.onopen?.(); });
    expect(JSON.parse(MockSocket.last.sent[0]).type).toBe('hello');

    act(() => {
      MockSocket.last.emit({ type: 'hello', coreVersion: 1, capabilities: ['run.stream'], unsupported: [] });
    });
    await waitFor(() => expect(MockSocket.last.sent.some((m) => JSON.parse(m).type === 'subscribe')).toBe(true));

    act(() => {
      MockSocket.last.emit({ type: 'event', runId: 'run-1', event: { seq: 1, text: 'first' } });
      MockSocket.last.emit({ type: 'event', runId: 'run-1', event: { seq: 2, text: 'second' } });
    });
    await waitFor(() => expect(result.current.updates).toHaveLength(2));
    expect(result.current.updates[0]).toMatchObject({ seq: 1 });
  });

  // The brief's own copy of this title used a single-quoted string containing an
  // unescaped apostrophe ("...the core's reason"), which is not valid JS — fixed
  // here with double quotes around the string; the wording is unchanged.
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
});
