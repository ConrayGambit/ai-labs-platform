#!/usr/bin/env node
// A deterministic ACP agent for tests. Reads newline-delimited JSON-RPC on stdin
// and writes newline-delimited JSON-RPC on stdout. Behaviour is scripted through
// the FAKE_ACP_SCRIPT environment variable, so every test is offline and does
// not depend on a real provider being installed, reachable, or in any mood.
import { createInterface } from 'node:readline';

const script = JSON.parse(process.env.FAKE_ACP_SCRIPT ?? '{}');
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

let cancelled = false;
/** The prompt request we are mid-turn on, so a permission answer can finish it. */
let pendingPromptId = null;
let pendingSessionId = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamUpdates(sessionId) {
  for (const update of script.updates ?? []) {
    if (cancelled) break;
    if (update.delayMs) await sleep(update.delayMs);
    const { delayMs, ...payload } = update;
    void delayMs;
    notify('session/update', { sessionId, update: payload });
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    // A client that writes garbage is the client's problem; this agent stays up.
    return;
  }

  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      agentCapabilities: script.agentCapabilities ?? {},
      agentInfo: { name: 'fake-acp-agent', version: '1.0.0' },
      authMethods: [],
    });
    return;
  }

  if (message.method === 'session/new') {
    reply(message.id, { sessionId: script.sessionId ?? 'sess_test_1' });
    return;
  }

  if (message.method === 'session/cancel') {
    // A notification: no reply. The in-flight turn ends with 'cancelled'.
    cancelled = true;
    if (pendingPromptId !== null) {
      const id = pendingPromptId;
      pendingPromptId = null;
      reply(id, { stopReason: 'cancelled' });
    }
    return;
  }

  if (message.method === 'session/prompt') {
    const { sessionId } = message.params;
    pendingPromptId = message.id;
    pendingSessionId = sessionId;
    if (script.echoPrompt) {
      notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `prompt:${JSON.stringify(message.params.prompt)}` },
        },
      });
    }
    await streamUpdates(sessionId);

    if (script.requestPermission && !cancelled) {
      // Agent -> client request. The client must answer before the turn ends,
      // so the reply to `session/prompt` waits in the response handler below.
      send({
        jsonrpc: '2.0',
        id: 9001,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'call_1', title: 'Write a file' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });
      return;
    }

    if (pendingPromptId === null) return; // cancel already answered it
    pendingPromptId = null;
    reply(message.id, { stopReason: cancelled ? 'cancelled' : (script.stopReason ?? 'end_turn') });
    return;
  }

  // Response to our own agent -> client request.
  if (message.id === 9001 && message.result) {
    notify('session/update', {
      sessionId: pendingSessionId ?? script.sessionId ?? 'sess_test_1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `permission:${JSON.stringify(message.result.outcome)}` },
      },
    });
    if (pendingPromptId !== null) {
      const id = pendingPromptId;
      pendingPromptId = null;
      reply(id, { stopReason: 'end_turn' });
    }
    return;
  }

  if (script.emitGarbage) process.stdout.write('this is not json\n');
});
