import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import {
  negotiate,
  type ClientMessage,
  type CoreCapability,
  type ServerMessage,
} from '../shared/wire.js';
import type { OrchestratorDatabase } from './database.js';
import type { RunSupervisor, Subscription } from './run-supervisor.js';

export interface RealtimeDependencies {
  database: OrchestratorDatabase;
  supervisor: RunSupervisor;
  /** Resolved server-side. A socket never accepts an actor id from a client. */
  currentUserId: string;
}

/** One connected client, and everything it is watching. */
interface Connection {
  socket: WebSocket;
  capabilities: Set<CoreCapability>;
  subscriptions: Map<string, Subscription>;
  greeted: boolean;
}

export function registerRealtime(app: FastifyInstance, dependencies: RealtimeDependencies): void {
  const { database, supervisor, currentUserId } = dependencies;

  const send = (connection: Connection, message: ServerMessage): void => {
    if (connection.socket.readyState !== connection.socket.OPEN) return;
    connection.socket.send(JSON.stringify(message));
  };

  /**
   * A run is reachable only through the venture its card's project belongs to.
   * Deny by default: an unknown run and an inaccessible one are the same answer.
   */
  const assertRunAccess = (runId: string): void => {
    const run = database.runs.getRun(runId);
    if (!run) throw new Error(`Access denied: run ${runId}`);
    const card = database.work.getCard(run.cardId);
    if (!card) throw new Error(`Access denied: run ${runId}`);
    const project = database.platform.getProject(card.projectId);
    if (!project) throw new Error(`Access denied: run ${runId}`);
    database.identity.assertVentureAccess(currentUserId, project.ventureId);
  };

  const handle = (connection: Connection, message: ClientMessage): void => {
    switch (message.type) {
      case 'hello': {
        const hello = negotiate(message);
        connection.capabilities = new Set(hello.capabilities);
        connection.greeted = true;
        send(connection, hello);
        return;
      }

      case 'subscribe': {
        assertRunAccess(message.runId);
        if (connection.subscriptions.has(message.runId)) return;
        // Subscribing replays from the beginning before streaming live, so a
        // client that reconnects after a dropped socket misses nothing.
        const subscription = supervisor.subscribe(message.runId, (event) => {
          send(connection, { type: 'event', runId: message.runId, event });
        });
        connection.subscriptions.set(message.runId, subscription);
        send(connection, { type: 'subscribed', runId: message.runId });
        return;
      }

      case 'unsubscribe': {
        const subscription = connection.subscriptions.get(message.runId);
        if (subscription) {
          supervisor.unsubscribe(subscription);
          connection.subscriptions.delete(message.runId);
        }
        send(connection, { type: 'unsubscribed', runId: message.runId });
        return;
      }

      case 'answer_permission': {
        const record = database.runs.getPermission(message.requestId);
        if (!record) throw new Error(`Permission request not found: ${message.requestId}`);
        assertRunAccess(record.runId);
        void supervisor
          .answerPermission({
            requestId: message.requestId,
            optionId: message.optionId,
            userId: currentUserId,
          })
          .catch((reason: unknown) => {
            send(connection, {
              type: 'error',
              requestType: 'answer_permission',
              message: reason instanceof Error ? reason.message : String(reason),
            });
          });
        return;
      }

      case 'cancel_run': {
        assertRunAccess(message.runId);
        void supervisor.cancelRun(message.runId).catch((reason: unknown) => {
          send(connection, {
            type: 'error',
            requestType: 'cancel_run',
            message: reason instanceof Error ? reason.message : String(reason),
          });
        });
        return;
      }

      default: {
        const unknown = message as { type?: string };
        throw new Error(`Unknown message type: ${unknown.type ?? '(none)'}`);
      }
    }
  };

  app.get('/api/realtime', { websocket: true }, (socket: WebSocket) => {
    const connection: Connection = {
      socket,
      capabilities: new Set(),
      subscriptions: new Map(),
      greeted: false,
    };

    socket.on('message', (raw: Buffer | string) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send(connection, { type: 'error', message: 'Message was not valid JSON' });
        return;
      }
      try {
        handle(connection, message);
      } catch (reason) {
        // An error answers the message; it does not close the socket. A client
        // that asked for one thing it may not have can still do the rest.
        send(connection, {
          type: 'error',
          requestType: message.type,
          message: reason instanceof Error ? reason.message : String(reason),
        });
      }
    });

    socket.on('close', () => {
      // Detach the listeners, and nothing else. A dropped socket must not stop
      // a run: the run belongs to the core, not to the window watching it.
      for (const subscription of connection.subscriptions.values()) {
        supervisor.unsubscribe(subscription);
      }
      connection.subscriptions.clear();
    });
  });
}
