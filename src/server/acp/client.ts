import {
  ACP_PROTOCOL_VERSION,
  type InitializeResponse,
  type PermissionRequest,
  type PermissionResponse,
  type SessionNewRequest,
  type SessionNewResponse,
  type SessionPromptRequest,
  type SessionPromptResponse,
  type SessionUpdateNotification,
} from '../../shared/acp.js';
import { createAcpConnection, type AcpConnection, type SpawnOptions } from './connection.js';

export type SessionUpdateHandler = (notification: SessionUpdateNotification) => void;
export type PermissionHandler = (
  request: PermissionRequest,
) => Promise<PermissionResponse> | PermissionResponse;

export interface AcpClient {
  initialize(): Promise<InitializeResponse>;
  newSession(input: SessionNewRequest): Promise<SessionNewResponse>;
  prompt(input: SessionPromptRequest): Promise<SessionPromptResponse>;
  /** A notification, not a request: the agent answers by ending the turn. */
  cancel(input: { sessionId: string }): Promise<void>;
  onSessionUpdate(handler: SessionUpdateHandler): void;
  /**
   * Answers `session/request_permission`. Without a handler the client rejects
   * every request — a tool that runs because nobody was listening is worse than
   * a tool that does not run.
   */
  onPermissionRequest(handler: PermissionHandler): void;
  onParseError(handler: (line: string) => void): void;
  /** Escape hatch for tests and diagnostics; not part of the protocol. */
  notifyRaw(method: string, params: unknown): void;
  close(): Promise<void>;
  readonly protocolVersion: number | null;
}

export interface AcpClientOptions extends SpawnOptions {
  clientName?: string;
  clientVersion?: string;
}

export function createAcpClient(options: AcpClientOptions): AcpClient {
  const connection: AcpConnection = createAcpConnection(options);
  const updateHandlers: SessionUpdateHandler[] = [];
  let permissionHandler: PermissionHandler | null = null;
  let protocolVersion: number | null = null;

  connection.onNotification('session/update', (params) => {
    const notification = params as SessionUpdateNotification;
    for (const handler of updateHandlers) handler(notification);
  });

  connection.onRequest('session/request_permission', async (params) => {
    if (!permissionHandler) {
      // Deny by default. An unanswered permission request would hang the turn;
      // an auto-allowed one would run a tool nobody approved.
      return { outcome: { outcome: 'cancelled' } } satisfies PermissionResponse;
    }
    return await permissionHandler(params as PermissionRequest);
  });

  return {
    get protocolVersion() {
      return protocolVersion;
    },

    async initialize() {
      const response = await connection.request<InitializeResponse>('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: {
          name: options.clientName ?? 'ai-labs',
          version: options.clientVersion ?? '0.1.0',
        },
      });
      protocolVersion = response.protocolVersion;
      return response;
    },

    newSession: (input) => connection.request<SessionNewResponse>('session/new', input),

    prompt: (input) => connection.request<SessionPromptResponse>('session/prompt', input),

    async cancel(input) {
      connection.notify('session/cancel', input);
    },

    onSessionUpdate(handler) {
      updateHandlers.push(handler);
    },

    onPermissionRequest(handler) {
      permissionHandler = handler;
    },

    onParseError(handler) {
      connection.onParseError(handler);
    },

    notifyRaw(method, params) {
      connection.notify(method, params);
    },

    close: () => connection.close(),
  };
}
