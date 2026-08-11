/**
 * Subscribes to one run's live stream over `/api/realtime`.
 *
 * The core replays every recorded update before it tails live ones (see
 * `RunSupervisor.subscribe` in `src/server/run-supervisor.ts`), so a client
 * that connects late — or reconnects after a dropped socket — sees the whole
 * transcript, not just what happens to arrive from here on. This hook's one
 * job is to not get in the way of that: append what arrives, in the order it
 * arrives, and never sort, dedupe, or reorder it. A sequence number to sort by
 * would silently undo the one guarantee the core already provides.
 */
import { useEffect, useRef, useState } from 'react';
import type { SessionUpdate } from '../../shared/acp.js';
import type { PermissionOption } from '../../shared/acp.js';
import {
  CORE_CAPABILITIES,
  CORE_WIRE_VERSION,
  type ClientMessage,
  type ServerMessage,
  type UnsupportedCapability,
} from '../../shared/wire.js';
import type { RunSummary } from '../api/client.js';

/**
 * What `run_permission_requests` returns over the socket — the `request` field
 * of a `permission_request` / `permission_answered` event.
 *
 * `src/shared/acp.ts` already exports a type named `PermissionRequest`, but it
 * is the ACP protocol's own shape (`{ sessionId, toolCall, options }`) and
 * carries no `id`. What the core actually records and sends is its
 * `PermissionRecord` (`src/server/run-repository.ts`), which does have one —
 * `answer()` below needs `pending.id` to address `answer_permission` at the
 * right request. Importing the acp.ts shape would still compile (both are
 * named the same thing) but `pending.id` would be `undefined` and every
 * answer would go nowhere. `PermissionRecord` is server-only and a client
 * module may import from `src/shared` only, so this is a hand-kept mirror of
 * it, not an import — exactly the fallback the task brief names for the case
 * where the two shapes turn out to differ.
 */
export interface PermissionRequest {
  id: string;
  runId: string;
  toolCallId: string;
  title: string;
  options: PermissionOption[];
  status: 'pending' | 'answered' | 'cancelled';
  selectedOptionId: string | null;
  answeredByUserId: string | null;
  createdAt: string;
  answeredAt: string | null;
}

/**
 * The payload of a `{ type: 'event' }` server message.
 *
 * `src/shared/wire.ts` deliberately types `event` as `unknown`: the transport
 * only promises to deliver the payload in order, not to know its shape. What
 * the core actually sends is its own `RunEvent` (`src/server/run-supervisor.ts`),
 * which this mirrors field for field — it cannot be imported for the same
 * reason `PermissionRequest` above cannot: it closes over server-only record
 * types (`AgentRun`, `PermissionRecord`), and this is client code.
 */
export type RunUpdate =
  | { type: 'update'; update: SessionUpdate }
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'permission_answered'; request: PermissionRequest }
  | { type: 'finished'; run: RunSummary };

export interface RunStreamState {
  updates: RunUpdate[];
  pending: PermissionRequest | null;
  unsupported: UnsupportedCapability[];
  answer(optionId: string): void;
  cancel(): void;
}

/**
 * `location` is a browser global. This file also type-checks under
 * `tsconfig.test.json`, which carries no DOM lib — unlike `fetch` and
 * `WebSocket` (which Node implements natively, so `@types/node` declares them
 * globally too), Node has no `location` at runtime, so nothing declares it for
 * that pass either. Read through a narrow cast rather than the bare
 * identifier so both type-check passes compile; jsdom (tests) and a real
 * browser (actual use) both supply the value at runtime regardless.
 */
function socketUrl(): string {
  const { protocol, host } = (
    globalThis as unknown as { location: { protocol: string; host: string } }
  ).location;
  const scheme = protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${host}/api/realtime`;
}

export function useRunStream(runId: string | null): RunStreamState {
  const [updates, setUpdates] = useState<RunUpdate[]>([]);
  const [pending, setPending] = useState<PermissionRequest | null>(null);
  const [unsupported, setUnsupported] = useState<UnsupportedCapability[]>([]);
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!runId) return;
    // A new run is a new transcript. Keeping the previous one would splice two
    // runs into one history, which is worse than showing nothing.
    setUpdates([]);
    setPending(null);

    const ws = new WebSocket(socketUrl());
    socket.current = ws;

    ws.onopen = () => {
      const hello: ClientMessage = {
        type: 'hello',
        clientVersion: String(CORE_WIRE_VERSION),
        capabilities: [...CORE_CAPABILITIES],
      };
      ws.send(JSON.stringify(hello));
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;

      if (message.type === 'hello') {
        // What both sides can do, replacing whatever this socket last knew —
        // hello is sent once, right after open, so there is nothing to merge.
        setUnsupported(message.unsupported);
        // Streaming is what this hook exists for. If the core does not have
        // it, there is nothing recorded to replay, and subscribing would just
        // wait on a reply that never comes; the refusal is already visible
        // above, in `unsupported`.
        if (message.capabilities.includes('run.stream')) {
          const subscribe: ClientMessage = { type: 'subscribe', runId };
          ws.send(JSON.stringify(subscribe));
        }
        return;
      }

      if (message.type === 'event' && message.runId === runId) {
        // Arrival order IS transcript order: the core replays every recorded
        // update before the live tail, so this must never sort or dedupe.
        const runEvent = message.event as RunUpdate;
        setUpdates((previous) => [...previous, runEvent]);
        if (runEvent.type === 'permission_request') setPending(runEvent.request);
        // Answered — by this client or another window on the same run — or
        // the run is over: either way, nothing is left pending to answer here.
        if (runEvent.type === 'permission_answered' || runEvent.type === 'finished') {
          setPending(null);
        }
        return;
      }

      if (message.type === 'error') {
        // Not capability negotiation — a request this client just made was
        // refused (an inaccessible run, an already-answered permission, and so
        // on). Recorded under the same `{ capability, reason }` shape because
        // that is what the state returned below has room for; `requestType`
        // here is the message type that failed ('subscribe', 'cancel_run', …),
        // never one of the dotted capability ids, so `can()` below can never
        // mistake it for a real negotiated capability going unsupported.
        setUnsupported((previous) => [
          ...previous,
          { capability: message.requestType ?? 'unknown', reason: message.message },
        ]);
      }
    };

    return () => {
      ws.close();
      socket.current = null;
    };
  }, [runId]);

  const can = (capability: string): boolean =>
    !unsupported.some((entry) => entry.capability === capability);

  return {
    updates,
    pending,
    unsupported,
    answer(optionId: string) {
      if (!pending || !can('run.permission')) return;
      const message: ClientMessage = {
        type: 'answer_permission',
        requestId: pending.id,
        optionId,
      };
      socket.current?.send(JSON.stringify(message));
      setPending(null);
    },
    cancel() {
      if (!runId || !can('run.cancel')) return;
      const message: ClientMessage = { type: 'cancel_run', runId };
      socket.current?.send(JSON.stringify(message));
    },
  };
}
