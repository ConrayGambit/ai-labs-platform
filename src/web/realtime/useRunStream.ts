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
  type CoreCapability,
  type ServerMessage,
  type UnsupportedCapability,
} from '../../shared/wire.js';
import type { RunSummary } from '../api/client.js';

/**
 * What `run_permission_requests` returns over the socket — the `request`
 * field of a `permission_request` / `permission_answered` event.
 *
 * `src/shared/acp.ts` already exports a type named `PermissionRequest`, but it
 * is the ACP protocol's own shape (`{ sessionId, toolCall, options }`) and
 * carries no `id`. What the core actually records and sends is its
 * `PermissionRecord` (`src/server/run-repository.ts`), which does have one —
 * `answer()` below needs `pending.id` to address `answer_permission` at the
 * right request. This type is named `PendingPermission`, not
 * `PermissionRequest`, on purpose: an editor's auto-import resolves either
 * name to whichever module it saw last, and a future edit that imports the
 * acp.ts type here by mistake would still compile — both are objects with an
 * `options` array — while silently sending `requestId: undefined` on every
 * answer. A distinct name removes the trap rather than documenting around it.
 * `PermissionRecord` is server-only and a client module may import from
 * `src/shared` only, so this is a hand-kept mirror of it, not an import — the
 * fallback the task brief itself named for the case where the two shapes
 * differ. `tests/server/client-type-mirrors.test.ts` asserts the two stay
 * identical at the type level, so drift becomes a compile error rather than
 * a silent `undefined` at runtime.
 */
export interface PendingPermission {
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
 * reason `PendingPermission` above cannot: it closes over server-only record
 * types (`AgentRun`, `PermissionRecord`), and this is client code. Also
 * covered by `tests/server/client-type-mirrors.test.ts`.
 */
export type RunUpdate =
  | { type: 'update'; update: SessionUpdate }
  | { type: 'permission_request'; request: PendingPermission }
  | { type: 'permission_answered'; request: PendingPermission }
  | { type: 'finished'; run: RunSummary };

/** The socket's own lifecycle, surfaced so a dead connection is visible as itself. */
export type ConnectionState = 'connecting' | 'open' | 'closed' | 'error';

export interface RunStreamState {
  updates: RunUpdate[];
  pending: PendingPermission | null;
  unsupported: UnsupportedCapability[];
  /**
   * The socket's own state, independent of what has streamed over it. An
   * empty `updates` array means one of two very different things — "this run
   * genuinely has nothing yet" or "the connection never came up, or dropped,
   * and nothing will arrive until it does" — and nothing else in this
   * returned state can tell them apart. The acceptance walk for this whole
   * feature is "close the tab mid-run, reopen, watch it replay"; if the
   * reconnect silently fails, a caller that only watches `updates` cannot
   * distinguish that from a quiet run, which defeats the point of building
   * this at all.
   */
  connection: ConnectionState;
  answer(optionId: string): void;
  cancel(): void;
}

/**
 * `location` is a browser global. This file is also type-checked under
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
  const [pending, setPending] = useState<PendingPermission | null>(null);
  const [unsupported, setUnsupported] = useState<UnsupportedCapability[]>([]);
  // What the core actually granted for this socket — the allowlist, not the
  // absence of a denial. `wire.ts` calls this "the contract for this socket"
  // (ServerHello.capabilities' own doc comment); `can()` below reads it as
  // exactly that, a contract to check membership in, not a blocklist to
  // check absence from.
  const [capabilities, setCapabilities] = useState<CoreCapability[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('closed');
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!runId) return;
    // A new run is a new transcript. Keeping the previous socket's state
    // would splice two runs into one history — updates and pending exactly
    // as before, and unsupported/capabilities for the same reason: they
    // describe what THIS socket negotiated, and a new socket negotiates
    // fresh. Leaving a stale entry would display it as if it belonged to the
    // run that just started watching.
    setUpdates([]);
    setPending(null);
    setUnsupported([]);
    setCapabilities([]);
    setConnection('connecting');

    const ws = new WebSocket(socketUrl());
    socket.current = ws;
    // A handler closes over `ws`, the socket it was attached to — not
    // whatever `socket.current` happens to hold when it fires. Closing this
    // socket is asynchronous in a real browser: cleanup can run (switching
    // runs, or unmounting) before this socket's own close/error/message
    // actually arrives, and a stale handler firing after that must not act
    // on state that now belongs to a different run's socket.
    const isCurrent = () => socket.current === ws;

    ws.onopen = () => {
      if (!isCurrent()) return;
      setConnection('open');
      const hello: ClientMessage = {
        type: 'hello',
        clientVersion: String(CORE_WIRE_VERSION),
        capabilities: [...CORE_CAPABILITIES],
      };
      ws.send(JSON.stringify(hello));
    };

    ws.onerror = () => {
      if (!isCurrent()) return;
      setConnection('error');
    };

    ws.onclose = () => {
      if (!isCurrent()) return;
      setConnection('closed');
    };

    ws.onmessage = (event) => {
      if (!isCurrent()) return;
      const message = JSON.parse(String(event.data)) as ServerMessage;

      if (message.type === 'hello') {
        // What both sides can do, replacing whatever this socket last knew —
        // hello is sent once, right after open, so there is nothing to merge.
        setCapabilities(message.capabilities);
        setUnsupported(message.unsupported);
        // Streaming is what this hook exists for. If the core did not grant
        // it, there is nothing recorded to replay, and subscribing would
        // just wait on a reply that never comes; the refusal is already
        // visible above, in `unsupported`.
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

  const can = (capability: CoreCapability): boolean => capabilities.includes(capability);

  return {
    updates,
    pending,
    unsupported,
    connection,
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
