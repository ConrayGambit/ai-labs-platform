import { randomUUID } from 'node:crypto';
import {
  DEFAULT_STOPPING_LIMITS,
  isAlternatingPair,
  type MayActVerdict,
  type StoppingLimits,
  type StoppingVerdict,
  type TerminalAction,
} from '../shared/conversation.js';
import type { OrchestratorDatabase } from './database.js';

export interface ThreadState {
  threadId: string;
  cardId: string;
  closedAt: string | null;
  terminatedLimit: string | null;
  terminatedReason: string | null;
  terminalAction: TerminalAction | null;
  /** Set when the exchange ended in none of the three permitted actions. */
  failure: string | null;
}

export interface ConversationGuard {
  /**
   * Whether this agent may act on this card at all.
   *
   * Three triggers, and nothing else. Being a member of the room is not one of
   * them: presence is not a request.
   */
  mayAgentAct(input: {
    cardId: string; orgAgentId: string; scheduled?: boolean;
  }): MayActVerdict;
  /** Records one agent-originated turn, and refuses one on a closed thread. */
  recordTurn(input: {
    threadId: string; cardId: string; orgAgentId: string;
  }): { allowed: boolean; reason?: string };
  /** The first limit that terminates this exchange, if any has. */
  checkStoppingLimits(input: { threadId: string; cardId: string }): StoppingVerdict;
  closeThread(input: {
    threadId: string; cardId: string; terminalAction: TerminalAction | null;
  }): ThreadState;
  getThreadState(threadId: string): ThreadState | null;
}

interface StateRow {
  thread_id: string;
  card_id: string;
  closed_at: string | null;
  terminated_limit: string | null;
  terminated_reason: string | null;
  terminal_action_json: string | null;
  failure: string | null;
}

const mapState = (row: StateRow): ThreadState => ({
  threadId: row.thread_id,
  cardId: row.card_id,
  closedAt: row.closed_at,
  terminatedLimit: row.terminated_limit,
  terminatedReason: row.terminated_reason,
  terminalAction: row.terminal_action_json
    ? JSON.parse(row.terminal_action_json) as TerminalAction
    : null,
  failure: row.failure,
});

export function createConversationGuard(
  database: OrchestratorDatabase,
  limits: StoppingLimits = DEFAULT_STOPPING_LIMITS,
): ConversationGuard {
  const connection = database.connection;

  const getThreadState = (threadId: string): ThreadState | null => {
    const row = connection
      .prepare('SELECT * FROM thread_state WHERE thread_id = ?')
      .get(threadId) as StateRow | undefined;
    return row ? mapState(row) : null;
  };

  const upsertState = (input: {
    threadId: string; cardId: string;
    closedAt?: string | null; terminatedLimit?: string | null;
    terminatedReason?: string | null; terminalAction?: TerminalAction | null;
    failure?: string | null;
  }): ThreadState => {
    connection.prepare(`
      INSERT INTO thread_state (
        thread_id, card_id, closed_at, terminated_limit, terminated_reason,
        terminal_action_json, failure
      ) VALUES (@threadId, @cardId, @closedAt, @terminatedLimit, @terminatedReason,
        @terminalActionJson, @failure)
      ON CONFLICT(thread_id) DO UPDATE SET
        closed_at = COALESCE(excluded.closed_at, closed_at),
        terminated_limit = COALESCE(excluded.terminated_limit, terminated_limit),
        terminated_reason = COALESCE(excluded.terminated_reason, terminated_reason),
        terminal_action_json = COALESCE(excluded.terminal_action_json, terminal_action_json),
        failure = COALESCE(excluded.failure, failure)
    `).run({
      threadId: input.threadId,
      cardId: input.cardId,
      closedAt: input.closedAt ?? null,
      terminatedLimit: input.terminatedLimit ?? null,
      terminatedReason: input.terminatedReason ?? null,
      terminalActionJson: input.terminalAction ? JSON.stringify(input.terminalAction) : null,
      failure: input.failure ?? null,
    });
    return getThreadState(input.threadId)!;
  };

  const turnAgentIds = (threadId: string): string[] =>
    (connection
      .prepare('SELECT org_agent_id FROM thread_turns WHERE thread_id = ? ORDER BY sequence')
      .all(threadId) as Array<{ org_agent_id: string }>)
      .map((row) => row.org_agent_id);

  return {
    mayAgentAct(input) {
      // An assignment is standing permission: the card is this agent's work.
      const card = database.work.getCard(input.cardId);
      if (!card) return { allowed: false, reason: `Card not found: ${input.cardId}` };
      if (card.assigneeOrgAgentId === input.orgAgentId) {
        return { allowed: true, trigger: 'assignment' };
      }
      // A schedule is the platform asking, which is still somebody asking.
      if (input.scheduled) return { allowed: true, trigger: 'schedule' };

      // An @-mention in this card's room, naming this agent specifically.
      const room = database.rooms.getRoomForCard(input.cardId);
      if (room) {
        const mentioned = connection
          .prepare(
            `SELECT 1 FROM room_messages
              WHERE room_id = ? AND body LIKE '%@' || ? || '%' LIMIT 1`,
          )
          .get(room.id, input.orgAgentId);
        if (mentioned) return { allowed: true, trigger: 'mention' };
      }

      return {
        allowed: false,
        reason:
          `${input.orgAgentId} has not been mentioned, assigned or scheduled on this card; ` +
          'an agent in a room does nothing until it is addressed',
      };
    },

    recordTurn(input) {
      const state = getThreadState(input.threadId);
      if (state?.closedAt) {
        throw new Error(`This thread is closed and takes no further turns: ${input.threadId}`);
      }
      const taken = turnAgentIds(input.threadId).length;
      connection.prepare(`
        INSERT INTO thread_turns (id, thread_id, card_id, org_agent_id, sequence, created_at)
        VALUES (@id, @threadId, @cardId, @orgAgentId, @sequence, @createdAt)
      `).run({
        id: randomUUID(),
        threadId: input.threadId,
        cardId: input.cardId,
        orgAgentId: input.orgAgentId,
        sequence: taken,
        createdAt: new Date().toISOString(),
      });
      return { allowed: true };
    },

    /**
     * The four limits, each of which terminates the exchange on its own.
     *
     * The FIRST that fires is reported rather than all of them: a person being
     * told why an exchange stopped needs one answer, and a list of four reads
     * as a system arguing with itself.
     */
    checkStoppingLimits(input) {
      const agentIds = turnAgentIds(input.threadId);

      // 1. Turn budget.
      if (agentIds.length >= limits.turnBudget) {
        return {
          terminated: true,
          limit: 'turn_budget',
          reason:
            `This exchange has taken ${agentIds.length} agent turns; a human is required to ` +
            'continue it',
        };
      }

      // 2. Cost ceiling on the card, independent of the turn budget.
      const card = database.work.getCard(input.cardId);
      const ceiling = card?.costCeilingTokens ?? null;
      if (ceiling !== null) {
        const spent = connection
          .prepare(
            `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS spent
               FROM agent_runs WHERE card_id = ?`,
          )
          .get(input.cardId) as { spent: number };
        if (spent.spent >= ceiling) {
          return {
            terminated: true,
            limit: 'cost_ceiling',
            reason: `This card has spent ${spent.spent} of its ${ceiling} token ceiling`,
          };
        }
      }

      // 3. Loop: two agents alternating with nothing produced.
      if (isAlternatingPair(agentIds, limits.loopWindow)) {
        const producedSince = connection
          .prepare(
            `SELECT COUNT(*) AS n FROM card_artifacts
              WHERE card_id = ? AND created_at >= (
                SELECT MIN(created_at) FROM (
                  SELECT created_at FROM thread_turns WHERE thread_id = ?
                   ORDER BY sequence DESC LIMIT ?
                )
              )`,
          )
          .get(input.cardId, input.threadId, limits.loopWindow) as { n: number };
        if (producedSince.n === 0) {
          return {
            terminated: true,
            limit: 'loop',
            reason:
              `The last ${limits.loopWindow} turns alternated between two agents with no new ` +
              'artifact and no state change',
          };
        }
      }

      return { terminated: false };
    },

    closeThread(input) {
      const action = input.terminalAction;
      /*
       * An exchange that ends in none of the three is a failure and is reported
       * as one (spec 5.4.3), so the failure is recorded OUTSIDE the transaction
       * below and before the throw.
       *
       * It was inside it, with a comment claiming the record survived the
       * refusal. It did not: the throw rolled the transaction back and took the
       * record with it, so the one case the spec insists must be reported was
       * the one case that vanished. Caught by the test that asserts it.
       */
      if (!action) {
        const failure =
          'The exchange ended with no terminal action: no artifact, no handoff to a named ' +
          'human, and no explicit decision to take no further action';
        upsertState({ threadId: input.threadId, cardId: input.cardId, failure });
        throw new Error(failure);
      }

      return connection.transaction((): ThreadState => {
        if (action.kind === 'no_further_action' && !action.reason.trim()) {
          // "No further action" without a reason is walking away with paperwork.
          throw new Error('An explicit no-further-action must carry a reason');
        }
        if (action.kind === 'artifact') {
          const onThisCard = database.work.listArtifacts(input.cardId)
            .some((artifact) => artifact.id === action.artifactId);
          if (!onThisCard) {
            throw new Error('The terminal artifact must be attached to this card');
          }
        }
        return upsertState({
          threadId: input.threadId,
          cardId: input.cardId,
          closedAt: new Date().toISOString(),
          terminalAction: action,
        });
      })();
    },

    getThreadState,
  };
}
