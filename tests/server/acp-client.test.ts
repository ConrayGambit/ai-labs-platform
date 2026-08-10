import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAcpClient, type AcpClient } from '../../src/server/acp/client.js';
import type { SessionUpdate } from '../../src/shared/acp.js';

/**
 * These tests spawn a real subprocess per run. Under the full suite's
 * parallelism, process spawn alone can exceed the 5s default on a loaded
 * machine, which showed up as two suites timing out together while both passed
 * in isolation. The work is not slow; starting a process under contention is.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FAKE_AGENT = resolve('tests/fixtures/fake-acp-agent.mjs');

interface Script {
  sessionId?: string;
  stopReason?: string;
  updates?: Array<Record<string, unknown>>;
  requestPermission?: boolean;
  emitGarbage?: boolean;
  echoPrompt?: boolean;
}

describe('the ACP client, against a real subprocess', () => {
  let client: AcpClient | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  const start = (script: Script = {}): AcpClient =>
    createAcpClient({
      command: process.execPath,
      args: [FAKE_AGENT],
      env: { FAKE_ACP_SCRIPT: JSON.stringify(script) },
      cwd: process.cwd(),
    });

  it('initializes and learns who it is talking to', async () => {
    client = start();
    const result = await client.initialize();

    expect(result.protocolVersion).toBe(1);
    expect(result.agentInfo?.name).toBe('fake-acp-agent');
    // The negotiated version is held, not re-derived at each call site.
    expect(client.protocolVersion).toBe(1);
  });

  it('opens a session', async () => {
    client = start({ sessionId: 'sess_abc' });
    await client.initialize();

    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });

    expect(session.sessionId).toBe('sess_abc');
  });

  it('runs a turn to end_turn', async () => {
    client = start();
    await client.initialize();
    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] });

    const result = await client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Summarise the card.' }],
    });

    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('delivers every update in order, discriminator intact', async () => {
    const updates: SessionUpdate[] = [];
    client = start({
      updates: [
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one ' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'two' } },
        { sessionUpdate: 'usage_update', usage: { inputTokens: 10, outputTokens: 4 } },
      ],
    });
    client.onSessionUpdate((notification) => updates.push(notification.update));
    await client.initialize();
    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] });

    await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });

    expect(updates.map((update) => update.sessionUpdate)).toEqual([
      'agent_thought_chunk', 'agent_message_chunk', 'agent_message_chunk', 'usage_update',
    ]);
    // Order is the point: a transcript assembled out of order is a wrong answer
    // rendered convincingly.
    const text = updates
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => (update as { content: { text: string } }).content.text)
      .join('');
    expect(text).toBe('one two');
  });

  it('carries the prompt through as content blocks', async () => {
    const updates: SessionUpdate[] = [];
    client = start({ echoPrompt: true });
    client.onSessionUpdate((notification) => updates.push(notification.update));
    await client.initialize();
    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] });

    await client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
    });

    const echoed = (updates[0] as { content: { text: string } }).content.text;
    expect(echoed).toContain('"first"');
    expect(echoed).toContain('"second"');
  });

  it('cancels an in-flight turn', async () => {
    client = start({
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' }, delayMs: 5 },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'more' }, delayMs: 200 },
      ],
    });
    await client.initialize();
    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] });

    const turn = client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });
    await new Promise((done) => setTimeout(done, 40));
    await client.cancel({ sessionId });

    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('answers an agent-to-client permission request', async () => {
    const updates: SessionUpdate[] = [];
    client = start({ requestPermission: true });
    client.onSessionUpdate((notification) => updates.push(notification.update));
    client.onPermissionRequest(async (request) => {
      expect(request.options.map((option) => option.optionId)).toEqual(['allow', 'reject']);
      return { outcome: { outcome: 'selected', optionId: 'allow' } };
    });
    await client.initialize();
    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] });

    const result = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'write' }] });

    expect(result.stopReason).toBe('end_turn');
    const answered = updates.find((update) =>
      update.sessionUpdate === 'agent_message_chunk' &&
      (update as { content: { text: string } }).content.text.startsWith('permission:'));
    expect(answered).toBeDefined();
  });

  it('survives a malformed line and reports it instead of dying', async () => {
    const parseErrors: string[] = [];
    client = start({ emitGarbage: true });
    client.onParseError((line) => parseErrors.push(line));
    await client.initialize();
    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] });

    // Provokes the garbage line, then a normal turn over the same connection.
    await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });
    client.notifyRaw('debug/provoke', {});
    await new Promise((done) => setTimeout(done, 50));
    const second = await client.prompt({ sessionId, prompt: [{ type: 'text', text: 'again' }] });

    expect(parseErrors).toContain('this is not json');
    // A malformed line must not take the connection with it.
    expect(second.stopReason).toBe('end_turn');
  });

  it('rejects pending and subsequent work once closed', async () => {
    client = start();
    await client.initialize();
    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] });

    await client.close();

    await expect(
      client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }),
    ).rejects.toThrow(/closed/i);
  });

  it('rejects an in-flight request when the connection closes under it', async () => {
    client = start({
      updates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'slow' }, delayMs: 500 },
      ],
    });
    await client.initialize();
    const { sessionId } = await client.newSession({ cwd: process.cwd(), mcpServers: [] });

    const turn = client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] });
    // The expectation is attached before the close that causes the rejection.
    // Attaching it afterwards leaves the rejection unhandled for a tick, which
    // Node reports as an unhandled rejection even though the test passes.
    const settled = expect(turn).rejects.toThrow(/closed/i);
    await new Promise((done) => setTimeout(done, 20));
    await client.close();

    // A promise that never settles is a leak the caller cannot see. Closing
    // settles everything it was waiting on.
    await settled;
  });
});
