import {
  readUsage,
  type PermissionRequest,
  type PermissionResponse,
  type SessionUpdate,
  type StopReason,
} from '../shared/acp.js';
import type { OrgAgent, Skill } from '../shared/domain.js';
import { createAcpClient, type AcpClient, type AcpClientOptions, type PermissionHandler } from './acp/client.js';
import type { OrchestratorDatabase } from './database.js';
import { getLadder } from './gate-policy.js';
import { buildPrompt } from './run-prompt.js';
import type { AgentRun, PermissionRecord, RunStatus } from './run-repository.js';

export type { AgentRun, PermissionRecord, RunStatus } from './run-repository.js';

export interface StartRunInput {
  cardId: string;
  orgAgentId: string;
  message: string;
  costCeilingTokens?: number | null;
  parentRunId?: string | null;
}

/**
 * What a watcher of a run sees.
 *
 * Wider than an ACP update because a client needs to know more than what the
 * agent said: that the run is blocked on a person, that somebody answered, and
 * how the run ended. The ACP stream stays pure — `update` carries it verbatim.
 */
export type RunEvent =
  | { type: 'update'; update: SessionUpdate }
  | { type: 'permission_request'; request: PermissionRecord }
  | { type: 'permission_answered'; request: PermissionRecord }
  | { type: 'finished'; run: AgentRun };

export type RunEventListener = (event: RunEvent) => void;

export interface Subscription {
  runId: string;
  listener: RunEventListener;
}

export interface AnswerPermissionInput {
  requestId: string;
  optionId: string;
  userId: string;
}

export interface RunSupervisorDependencies {
  database: OrchestratorDatabase;
  /** How to launch this agent's provider. Injected so tests need no provider. */
  spawnFor: (agent: OrgAgent) => AcpClientOptions;
  /** Answers `session/request_permission`. Absent means deny, per the client. */
  permissionHandler?: PermissionHandler;
}

export interface RunSupervisor {
  startRun(input: StartRunInput): Promise<AgentRun>;
  getRun(runId: string): AgentRun | null;
  listActiveRuns(): AgentRun[];
  listUpdates(runId: string): SessionUpdate[];
  /**
   * Replays everything already recorded, in order, then streams live. A client
   * that arrives late or reconnects misses nothing.
   */
  subscribe(runId: string, listener: RunEventListener): Subscription;
  unsubscribe(subscription: Subscription): void;
  /** The request the agent is blocked on, if it is blocked on one. */
  getPendingPermission(runId: string): PermissionRecord | null;
  listPermissions(runId: string): PermissionRecord[];
  isAwaitingPermission(runId: string): boolean;
  /**
   * Answers on behalf of a person, who must have access to the card's venture.
   * A refused answer leaves the request pending for someone who may answer.
   */
  answerPermission(input: AnswerPermissionInput): Promise<PermissionRecord>;
  cancelRun(runId: string): Promise<void>;
  /** Resolves once the turn has finished and the run row is final. */
  waitForRun(runId: string): Promise<AgentRun>;
  shutdown(): Promise<void>;
}

/** How a stop reason maps onto the run's final status. */
function statusForStopReason(stopReason: StopReason): RunStatus {
  if (stopReason === 'end_turn') return 'completed';
  if (stopReason === 'cancelled') return 'cancelled';
  // refusal, max_tokens and max_turn_requests all mean the turn did not finish
  // its work. Recording them as completed would let a card advance on nothing.
  return 'failed';
}

interface ActiveRun {
  client: AcpClient;
  sessionId: string | null;
  listeners: Set<RunEventListener>;
  finished: Promise<AgentRun>;
  /** Set when the platform itself decides to end the run, so the reason survives. */
  stoppedReason: string | null;
  /**
   * A cancel asked for before the session existed. Spawning a provider takes
   * long enough that a user can press cancel first, and a cancel that silently
   * does nothing is worse than one that is slow.
   */
  cancelRequested: boolean;
  /**
   * Resolvers for permission requests the agent is blocked on, keyed by our own
   * request id. The agent's JSON-RPC request stays open until one is called.
   */
  awaiting: Map<string, (response: PermissionResponse) => void>;
}

export function createRunSupervisor(dependencies: RunSupervisorDependencies): RunSupervisor {
  const { database, spawnFor, permissionHandler } = dependencies;
  const runs = database.runs;
  const active = new Map<string, ActiveRun>();

  const agentSkills = (agent: OrgAgent): Skill[] =>
    agent.skillIds
      .map((skillId) => database.getSkill(skillId))
      .filter((skill): skill is Skill => Boolean(skill));

  /**
   * Handles one update: store it, fan it out, mirror agent speech into the
   * room, meter usage, and stop the run if the ceiling is crossed.
   *
   * Storing before fanning out is what makes replay exact — a subscriber can
   * never see an update that is not yet in the record it would replay from.
   */
  const emit = (entry: ActiveRun, event: RunEvent): void => {
    for (const listener of entry.listeners) listener(event);
  };

  const handleUpdate = (run: AgentRun, entry: ActiveRun, update: SessionUpdate): void => {
    runs.appendUpdate(run.id, update);
    emit(entry, { type: 'update', update });

    if (update.sessionUpdate === 'agent_message_chunk' && run.roomId) {
      database.rooms.postMessage({
        roomId: run.roomId,
        threadId: null,
        authorKind: 'org_agent',
        authorId: run.orgAgentId,
        runId: run.id,
        body: update.content.text,
      });
    }

    const usage = readUsage(update);
    if (!usage) return;
    const metered = runs.addUsage(run.id, usage.input, usage.output);

    if (!metered.costCeilingTokens || entry.stoppedReason) return;
    if (metered.inputTokens + metered.outputTokens < metered.costCeilingTokens) return;

    // The ceiling is a stop, not a suggestion. Cancel at the protocol level so
    // the provider stops working, and record why the platform ended the run.
    entry.stoppedReason = 'cost_ceiling';
    if (entry.sessionId) void entry.client.cancel({ sessionId: entry.sessionId });
  };

  return {
    async startRun(input) {
      const card = database.work.getCard(input.cardId);
      if (!card) throw new Error(`Card not found: ${input.cardId}`);
      const agent = database.getOrgAgent(input.orgAgentId);
      if (!agent) throw new Error(`Organizational agent not found: ${input.orgAgentId}`);
      const room = database.rooms.getRoomForCard(card.id);
      if (room) {
        // The agent speaks in the room as itself, so it has to be in the room.
        database.rooms.addMember({
          roomId: room.id, memberKind: 'org_agent', memberId: agent.id,
        });
      }

      const run = runs.createRun({
        cardId: card.id,
        orgAgentId: agent.id,
        roomId: room?.id ?? null,
        parentRunId: input.parentRunId ?? null,
        costCeilingTokens: input.costCeilingTokens ?? null,
      });

      const client = createAcpClient(spawnFor(agent));
      const entry: ActiveRun = {
        client,
        sessionId: null,
        listeners: new Set(),
        finished: Promise.resolve(run),
        stoppedReason: null,
        cancelRequested: false,
        awaiting: new Map(),
      };
      active.set(run.id, entry);

      /**
       * The agent's request is persisted and then held open. Nothing here has a
       * default answer: an unanswered request blocks the tool call rather than
       * letting it run because nobody was watching.
       */
      client.onPermissionRequest(async (request: PermissionRequest) => {
        if (permissionHandler) return await permissionHandler(request);
        const record = runs.recordPermission({
          runId: run.id,
          toolCallId: request.toolCall.toolCallId,
          title: request.toolCall.title ?? '',
          options: request.options,
        });
        emit(entry, { type: 'permission_request', request: record });
        return await new Promise<PermissionResponse>((answer) => {
          entry.awaiting.set(record.id, answer);
        });
      });
      client.onSessionUpdate((notification) => {
        try {
          handleUpdate(run, entry, notification.update);
        } catch {
          // One bad update must not take the turn down with it. The update is
          // lost; the run is not.
        }
      });

      // The turn runs on a detached promise. `startRun` returns as soon as the
      // run is recorded — a start that awaited the turn would hold a request
      // open for as long as the agent works.
      entry.finished = (async (): Promise<AgentRun> => {
        try {
          await client.initialize();
          const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
          entry.sessionId = session.sessionId;
          runs.setSessionId(run.id, session.sessionId);
          // Honour a cancel that arrived while the provider was still starting.
          if (entry.cancelRequested) await client.cancel({ sessionId: session.sessionId });

          const result = await client.prompt({
            sessionId: session.sessionId,
            prompt: buildPrompt({
              agent,
              skills: agentSkills(agent),
              card,
              ownerNotes: card.ownerNotes,
              message: input.message,
            }),
          });

          if (entry.stoppedReason) {
            runs.finishRun({
              runId: run.id,
              status: 'stopped',
              stopReason: result.stopReason,
              stoppedReason: entry.stoppedReason,
            });
          } else {
            const status = statusForStopReason(result.stopReason);
            runs.finishRun({ runId: run.id, status, stopReason: result.stopReason });
            if (status === 'completed') {
              // A finished turn puts the work up for review at the first gate.
              const project = database.platform.getProject(card.projectId);
              const firstGate = getLadder(project?.gateLadderId ?? 'product').gates[0];
              if (firstGate) {
                database.work.moveCard({
                  cardId: card.id, to: firstGate.id, position: 0, userId: 'system',
                });
              }
            }
          }
        } catch (reason) {
          runs.finishRun({
            runId: run.id,
            status: entry.stoppedReason ? 'stopped' : 'failed',
            stoppedReason:
              entry.stoppedReason ?? (reason instanceof Error ? reason.message : String(reason)),
          });
        } finally {
          await client.close();
          // Tell watchers how it ended before the entry goes, or a client that
          // was streaming sees the stream simply stop.
          emit(entry, { type: 'finished', run: runs.getRun(run.id) ?? run });
          active.delete(run.id);
        }
        return runs.getRun(run.id) ?? run;
      })();

      return run;
    },

    getRun: (runId) => runs.getRun(runId),
    listActiveRuns: () => runs.listActiveRuns(),
    listUpdates: (runId) => runs.listUpdates(runId),

    subscribe(runId, listener) {
      // Replay first, then attach. Attaching first would deliver a live update
      // ahead of its predecessors, which is worse than delivering it late.
      for (const update of runs.listUpdates(runId)) listener({ type: 'update', update });
      const pending = runs.getPendingPermission(runId);
      // A client that connects while the agent is blocked has to be told, or
      // the run looks stalled and the person who could unblock it never knows.
      if (pending) listener({ type: 'permission_request', request: pending });
      active.get(runId)?.listeners.add(listener);
      return { runId, listener };
    },

    getPendingPermission: (runId) => runs.getPendingPermission(runId),
    listPermissions: (runId) => runs.listPermissions(runId),
    isAwaitingPermission: (runId) => runs.getPendingPermission(runId) !== null,

    async answerPermission(input) {
      const record = runs.getPermission(input.requestId);
      if (!record) throw new Error(`Permission request not found: ${input.requestId}`);
      const run = runs.getRun(record.runId);
      if (!run) throw new Error(`Run not found: ${record.runId}`);
      const card = database.work.getCard(run.cardId);
      if (!card) throw new Error(`Card not found: ${run.cardId}`);
      const project = database.platform.getProject(card.projectId);
      if (!project) throw new Error(`Project not found: ${card.projectId}`);

      // Access is checked BEFORE the request is marked answered, so a refused
      // answer leaves it pending for somebody who may actually answer it.
      database.identity.assertVentureAccess(input.userId, project.ventureId);

      const answered = runs.answerPermission(input);
      const entry = active.get(record.runId);
      const resolve = entry?.awaiting.get(record.id);
      if (entry && resolve) {
        entry.awaiting.delete(record.id);
        resolve({ outcome: { outcome: 'selected', optionId: input.optionId } });
        emit(entry, { type: 'permission_answered', request: answered });
      }
      return answered;
    },

    unsubscribe(subscription) {
      // Deliberately does not stop the run. The run belongs to the core, not to
      // whichever window happened to be watching it.
      active.get(subscription.runId)?.listeners.delete(subscription.listener);
    },

    async cancelRun(runId) {
      const entry = active.get(runId);
      if (!entry) return;
      entry.cancelRequested = true;
      // If the session is not open yet the request is held, and applied the
      // moment it is. Dropping it here would make the button a lie.
      if (entry.sessionId) await entry.client.cancel({ sessionId: entry.sessionId });
    },

    async waitForRun(runId) {
      const entry = active.get(runId);
      if (!entry) {
        const finished = runs.getRun(runId);
        if (!finished) throw new Error(`Run not found: ${runId}`);
        return finished;
      }
      return await entry.finished;
    },

    async shutdown() {
      const entries = [...active.values()];
      active.clear();
      await Promise.all(entries.map((entry) => entry.client.close()));
      // Wait for the detached turns to unwind so nothing writes to a closed
      // database after shutdown returns.
      await Promise.allSettled(entries.map((entry) => entry.finished));
    },
  };
}
