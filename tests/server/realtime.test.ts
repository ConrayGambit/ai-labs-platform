import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { registerRealtime } from '../../src/server/realtime.js';
import { createRunSupervisor, type RunSupervisor } from '../../src/server/run-supervisor.js';
import { CORE_CAPABILITIES, negotiate, type ServerMessage } from '../../src/shared/wire.js';

/**
 * These tests spawn a real subprocess per run, and open real sockets. Under the
 * full suite's parallelism that is slower than the 5s default allows.
 */
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const FAKE_AGENT = resolve('tests/fixtures/fake-acp-agent.mjs');

const chunk = (text: string, delayMs?: number) => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
  ...(delayMs ? { delayMs } : {}),
});

describe('capability negotiation', () => {
  it('answers with the intersection of what both sides can do', () => {
    const hello = negotiate({
      type: 'hello', clientVersion: '0.1.0', capabilities: ['run.stream', 'run.cancel'],
    });

    expect(hello.capabilities).toEqual(['run.stream', 'run.cancel']);
    expect(hello.unsupported).toEqual([]);
    expect(hello.coreVersion).toBe(1);
  });

  it('reports a capability the core lacks WITH A REASON, rather than failing', () => {
    const hello = negotiate({
      type: 'hello', clientVersion: '9.0.0', capabilities: ['run.stream', 'run.telepathy'],
    });

    expect(hello.capabilities).toEqual(['run.stream']);
    expect(hello.unsupported).toEqual([
      { capability: 'run.telepathy', reason: expect.stringContaining('does not implement') },
    ]);
  });

  it('offers nothing when the client asks for nothing', () => {
    expect(negotiate({ type: 'hello', clientVersion: '0.1.0', capabilities: [] }).capabilities)
      .toEqual([]);
  });
});

describe('the realtime socket', () => {
  let database: OrchestratorDatabase | undefined;
  let supervisor: RunSupervisor | undefined;
  let app: FastifyInstance | undefined;
  let address: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    address = undefined;
    await supervisor?.shutdown();
    supervisor = undefined;
    database?.close();
    database = undefined;
  });

  /**
   * `actor` picks the connecting user from the seeded database, so an
   * access test uses a user that genuinely exists and genuinely lacks the
   * grant. Creating one in a throwaway database would fail as "user not
   * found" and pass the test for the wrong reason.
   */
  async function seed(
    script: Record<string, unknown> = {},
    actor: (database: OrchestratorDatabase) => string = () => 'owner',
  ) {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Evaluate tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id,
      name: 'Tool Survey',
      objective: 'Compare free research services.',
      successCriteria: ['A sourced comparison is approved'],
    });
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
    database.rooms.createRoomForCard({ cardId: card.id, title: card.title });
    const runtime = database.createAgent({
      name: 'Test ACP Runtime',
      command: 'node',
      argsTemplate: ['{prompt}'],
      promptTransport: 'argument',
      outputFormat: 'text',
      versionArgs: ['--version'],
      timeoutMs: 120_000,
    });
    const agent = database.createOrgAgent({
      name: 'Test Specialist',
      jobTitle: 'Research Specialist',
      department: 'Research',
      jobFunction: 'Compares services and reports what it finds.',
      responsibilities: 'Survey, compare, cite.',
      runtimeId: runtime.id,
    });

    supervisor = createRunSupervisor({
      database,
      spawnFor: () => ({
        command: process.execPath,
        args: [FAKE_AGENT],
        cwd: process.cwd(),
        env: { FAKE_ACP_SCRIPT: JSON.stringify(script) },
      }),
    });

    app = Fastify({ logger: false });
    await app.register(websocket);
    registerRealtime(app, { database, supervisor, currentUserId: actor(database) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    address = `ws://127.0.0.1:${port}/api/realtime`;

    return { card, agent, venture };
  }

  /** A socket that collects everything the server says. */
  function connect(): Promise<{ socket: WebSocket; received: ServerMessage[] }> {
    const socket = new WebSocket(address!);
    const received: ServerMessage[] = [];
    socket.on('message', (raw: Buffer) => received.push(JSON.parse(raw.toString()) as ServerMessage));
    return new Promise((open) => socket.on('open', () => open({ socket, received })));
  }

  const waitFor = async <T>(check: () => T | undefined, what: string): Promise<T> => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const found = check();
      if (found !== undefined) return found;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  it('greets a client and states the contract for this socket', async () => {
    await seed();
    const { socket, received } = await connect();

    socket.send(JSON.stringify({
      type: 'hello', clientVersion: '0.1.0', capabilities: [...CORE_CAPABILITIES, 'run.telepathy'],
    }));
    const hello = await waitFor(
      () => received.find((message) => message.type === 'hello'), 'the server hello');

    expect(hello).toMatchObject({
      coreVersion: 1,
      capabilities: [...CORE_CAPABILITIES],
      unsupported: [{ capability: 'run.telepathy' }],
    });
    // Graceful degradation, not failure: the client turns that feature off.
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('replays from the beginning, then streams live', async () => {
    const { card, agent } = await seed({ updates: [chunk('one '), chunk('two ', 150), chunk('three', 40)] });
    const run = await supervisor!.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });
    // Let the first chunk land before anyone is listening.
    await waitFor(
      () => (supervisor!.listUpdates(run.id).length > 0 ? true : undefined), 'the first chunk');

    const { socket, received } = await connect();
    socket.send(JSON.stringify({ type: 'subscribe', runId: run.id }));
    await supervisor!.waitForRun(run.id);

    const text = await waitFor(() => {
      const joined = received
        .filter((message): message is Extract<ServerMessage, { type: 'event' }> =>
          message.type === 'event')
        .map((message) => message.event as { type: string; update?: { content?: { text: string } } })
        .filter((event) => event.type === 'update' && event.update?.content)
        .map((event) => event.update!.content!.text)
        .join('');
      return joined === 'one two three' ? joined : undefined;
    }, 'the whole transcript');

    expect(text).toBe('one two three');
    expect(received.some((message) => message.type === 'subscribed')).toBe(true);
    socket.close();
  });

  it('DOES NOT cancel the run when the socket drops, and replays on reconnect', async () => {
    const { card, agent } = await seed({ updates: [chunk('one '), chunk('two', 200)] });
    const run = await supervisor!.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });

    const first = await connect();
    first.socket.send(JSON.stringify({ type: 'subscribe', runId: run.id }));
    await waitFor(
      () => first.received.find((message) => message.type === 'subscribed'), 'the subscription');
    first.socket.terminate();

    const finished = await supervisor!.waitForRun(run.id);
    // The window closed. The work did not stop.
    expect(finished.status).toBe('completed');

    const second = await connect();
    second.socket.send(JSON.stringify({ type: 'subscribe', runId: run.id }));
    const replayed = await waitFor(() => {
      const events = second.received.filter((message) => message.type === 'event');
      return events.length >= 2 ? events : undefined;
    }, 'the replay');

    expect(replayed).toHaveLength(2);
    second.socket.close();
  });

  it('REFUSES a subscription from a user with no access to the run venture', async () => {
    const { card, agent } = await seed(
      { updates: [chunk('one ')] },
      // A real user of this platform, with no grant on this card's venture.
      (seeded) => seeded.identity.createUser({ displayName: 'Outsider', role: 'staff' }).id,
    );
    const run = await supervisor!.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Begin.',
    });

    const { socket, received } = await connect();
    socket.send(JSON.stringify({ type: 'subscribe', runId: run.id }));
    const refusal = await waitFor(
      () => received.find((message) => message.type === 'error'), 'the refusal');

    expect(refusal).toMatchObject({
      requestType: 'subscribe',
      message: expect.stringMatching(/access denied/i),
    });
    expect(received.some((message) => message.type === 'subscribed')).toBe(false);
    // Refusing one message does not end the conversation.
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });

  it('REFUSES a subscription to a run that does not exist, saying no more than that', async () => {
    await seed();
    const { socket, received } = await connect();

    socket.send(JSON.stringify({ type: 'subscribe', runId: 'no-such-run' }));
    const refusal = await waitFor(
      () => received.find((message) => message.type === 'error'), 'the refusal');

    // An unknown run and an inaccessible one give the same answer, so the
    // socket cannot be used to discover which runs exist.
    expect(refusal).toMatchObject({ message: expect.stringMatching(/access denied/i) });
    socket.close();
  });

  it('answers a permission request over the socket', async () => {
    const { card, agent } = await seed({ requestPermission: true });
    const run = await supervisor!.startRun({
      cardId: card.id, orgAgentId: agent.id, message: 'Write a file.',
    });
    const { socket, received } = await connect();
    socket.send(JSON.stringify({ type: 'subscribe', runId: run.id }));

    const requestId = await waitFor(
      () => supervisor!.getPendingPermission(run.id)?.id, 'the permission request');
    socket.send(JSON.stringify({ type: 'answer_permission', requestId, optionId: 'allow' }));

    const finished = await supervisor!.waitForRun(run.id);
    expect(finished.status).toBe('completed');
    expect(supervisor!.listPermissions(run.id)[0]).toMatchObject({
      status: 'answered', selectedOptionId: 'allow', answeredByUserId: 'owner',
    });
    expect(received.some((message) => message.type === 'error')).toBe(false);
    socket.close();
  });

  it('answers a malformed message without dropping the socket', async () => {
    await seed();
    const { socket, received } = await connect();

    socket.send('{ not json');
    const complaint = await waitFor(
      () => received.find((message) => message.type === 'error'), 'the complaint');

    expect(complaint).toMatchObject({ message: expect.stringMatching(/valid json/i) });
    expect(socket.readyState).toBe(WebSocket.OPEN);
    socket.close();
  });
});
