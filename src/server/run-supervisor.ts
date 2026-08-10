import { readUsage, type SessionUpdate, type StopReason } from '../shared/acp.js';
import type { OrgAgent, Skill } from '../shared/domain.js';
import { createAcpClient, type AcpClient, type AcpClientOptions, type PermissionHandler } from './acp/client.js';
import type { OrchestratorDatabase } from './database.js';
import { getLadder } from './gate-policy.js';
import { buildPrompt } from './run-prompt.js';
import type { AgentRun, RunStatus } from './run-repository.js';

export type { AgentRun, RunStatus } from './run-repository.js';

export interface StartRunInput {
  cardId: string;
  orgAgentId: string;
  message: string;
  costCeilingTokens?: number | null;
  parentRunId?: string | null;
}

export type UpdateListener = (update: SessionUpdate) => void;

export interface Subscription {
  runId: string;
  listener: UpdateListener;
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
  subscribe(runId: string, listener: UpdateListener): Subscription;
  unsubscribe(subscription: Subscription): void;
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
  listeners: Set<UpdateListener>;
  finished: Promise<AgentRun>;
  /** Set when the platform itself decides to end the run, so the reason survives. */
  stoppedReason: string | null;
  /**
   * A cancel asked for before the session existed. Spawning a provider takes
   * long enough that a user can press cancel first, and a cancel that silently
   * does nothing is worse than one that is slow.
   */
  cancelRequested: boolean;
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
  const handleUpdate = (run: AgentRun, entry: ActiveRun, update: SessionUpdate): void => {
    runs.appendUpdate(run.id, update);
    for (const listener of entry.listeners) listener(update);

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
      };
      active.set(run.id, entry);

      if (permissionHandler) client.onPermissionRequest(permissionHandler);
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
      for (const update of runs.listUpdates(runId)) listener(update);
      active.get(runId)?.listeners.add(listener);
      return { runId, listener };
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
