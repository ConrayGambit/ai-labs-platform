/**
 * The realtime wire contract between the core service and a thin client.
 *
 * A client and the core are versioned independently — a desktop window can be
 * older or newer than the service it connects to. So the first thing a client
 * does is say what it can do, and the core answers with what it supports. A
 * capability the core lacks comes back in `unsupported` **with a reason** and
 * the socket stays open: the client turns that feature off and carries on.
 * Refusing the connection outright would make every core upgrade a client
 * upgrade too.
 */
export const CORE_WIRE_VERSION = 1;

export const CORE_CAPABILITIES = [
  /** Streamed run updates, replayed from the beginning on subscribe. */
  'run.stream',
  /** Answering an agent's permission request over the socket. */
  'run.permission',
  /** Cancelling a run over the socket. */
  'run.cancel',
] as const;

export type CoreCapability = (typeof CORE_CAPABILITIES)[number];

export interface ClientHello {
  type: 'hello';
  clientVersion: string;
  capabilities: string[];
}

export interface UnsupportedCapability {
  capability: string;
  reason: string;
}

export interface ServerHello {
  type: 'hello';
  coreVersion: number;
  /** What both sides can do: the intersection, and the contract for this socket. */
  capabilities: CoreCapability[];
  unsupported: UnsupportedCapability[];
}

export type ClientMessage =
  | ClientHello
  | { type: 'subscribe'; runId: string }
  | { type: 'unsubscribe'; runId: string }
  | { type: 'answer_permission'; requestId: string; optionId: string }
  | { type: 'cancel_run'; runId: string };

export type ServerMessage =
  | ServerHello
  | { type: 'subscribed'; runId: string }
  | { type: 'unsubscribed'; runId: string }
  | { type: 'event'; runId: string; event: unknown }
  | { type: 'error'; message: string; requestType?: string };

export function negotiate(hello: ClientHello): ServerHello {
  const supported = CORE_CAPABILITIES.filter((capability) =>
    hello.capabilities.includes(capability));
  const unsupported = hello.capabilities
    .filter((capability) => !CORE_CAPABILITIES.includes(capability as CoreCapability))
    .map((capability) => ({
      capability,
      reason: `This core (wire version ${CORE_WIRE_VERSION}) does not implement ${capability}.`,
    }));
  return {
    type: 'hello',
    coreVersion: CORE_WIRE_VERSION,
    capabilities: [...supported],
    unsupported,
  };
}
