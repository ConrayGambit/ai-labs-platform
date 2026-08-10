import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveRuntimeEnv } from '../agent-process.js';

/**
 * Newline-delimited JSON-RPC 2.0 over a child process's stdio.
 *
 * This file knows nothing about ACP. It correlates ids to pending promises,
 * routes inbound requests and notifications to handlers, and settles everything
 * on close. Keeping the protocol out of the transport is what makes the
 * transport testable without an agent and the client testable without a socket.
 */

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type Inbound = Partial<JsonRpcRequest & JsonRpcResponse>;

export interface SpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  /**
   * Extra environment for the child. `${VAR}` references are resolved from the
   * server's own environment by `resolveRuntimeEnv` — the same posture as every
   * other runtime launch. No token value is ever copied into stored config.
   */
  env?: Record<string, string>;
}

export type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
export type NotificationHandler = (params: unknown) => void;

export interface AcpConnection {
  request<T>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
  onRequest(method: string, handler: RequestHandler): void;
  onNotification(method: string, handler: NotificationHandler): void;
  onParseError(handler: (line: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
  close(): Promise<void>;
  readonly closed: boolean;
}

const CLOSED_MESSAGE = 'ACP connection is closed';

export function createAcpConnection(options: SpawnOptions): AcpConnection {
  const child: ChildProcessWithoutNullStreams = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: { ...process.env, ...resolveRuntimeEnv(options.env ?? {}) },
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map<number, { resolve: (value: never) => void; reject: (reason: Error) => void }>();
  const requestHandlers = new Map<string, RequestHandler>();
  const notificationHandlers = new Map<string, NotificationHandler>();
  const parseErrorHandlers: Array<(line: string) => void> = [];
  const exitHandlers: Array<(code: number | null) => void> = [];

  let nextId = 1;
  let closed = false;
  let buffer = '';

  const write = (message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void => {
    if (closed || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const settleAll = (reason: Error): void => {
    for (const [, entry] of pending) entry.reject(reason);
    pending.clear();
  };

  const handleInbound = (message: Inbound): void => {
    // A response: it has an id we issued and no method.
    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(Number(message.id));
      if (!entry) return; // a late answer to something already settled
      pending.delete(Number(message.id));
      if (message.error) {
        entry.reject(new Error(`${message.error.message} (code ${message.error.code})`));
        return;
      }
      entry.resolve(message.result as never);
      return;
    }

    if (message.method === undefined) return;

    // A request from the agent: it carries an id and expects an answer.
    if (message.id !== undefined) {
      const handler = requestHandlers.get(message.method);
      const id = message.id;
      if (!handler) {
        write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } });
        return;
      }
      void (async () => {
        try {
          write({ jsonrpc: '2.0', id, result: await handler(message.params) });
        } catch (reason) {
          write({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: reason instanceof Error ? reason.message : String(reason) },
          });
        }
      })();
      return;
    }

    notificationHandlers.get(message.method)?.(message.params);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    // Split on newlines and keep the trailing partial line: a chunk boundary
    // lands mid-message often enough that parsing per chunk would be flaky in
    // exactly the way that is hardest to reproduce.
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          handleInbound(JSON.parse(line) as Inbound);
        } catch {
          // One bad line is one bad line. Killing the connection over it would
          // discard a live turn because an agent logged to the wrong stream.
          for (const handler of parseErrorHandlers) handler(line);
        }
      }
      index = buffer.indexOf('\n');
    }
  });

  child.on('exit', (code) => {
    closed = true;
    settleAll(new Error(`${CLOSED_MESSAGE}: agent exited with code ${code}`));
    for (const handler of exitHandlers) handler(code);
  });

  child.on('error', (error) => {
    closed = true;
    settleAll(new Error(`${CLOSED_MESSAGE}: ${error.message}`));
  });

  return {
    get closed() {
      return closed;
    },

    request<T>(method: string, params?: unknown): Promise<T> {
      if (closed) return Promise.reject(new Error(CLOSED_MESSAGE));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: never) => void, reject });
        write({ jsonrpc: '2.0', id, method, params });
      });
    },

    notify(method, params) {
      write({ jsonrpc: '2.0', method, params });
    },

    onRequest(method, handler) {
      requestHandlers.set(method, handler);
    },

    onNotification(method, handler) {
      notificationHandlers.set(method, handler);
    },

    onParseError(handler) {
      parseErrorHandlers.push(handler);
    },

    onExit(handler) {
      exitHandlers.push(handler);
    },

    async close() {
      if (closed) return;
      closed = true;
      // Settle before killing: a promise that never settles is a leak the
      // caller cannot see, and the exit event may not arrive on every platform.
      settleAll(new Error(CLOSED_MESSAGE));
      child.stdin.end();
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 2000).unref?.();
      });
      child.kill();
      await exited;
    },
  };
}
