import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  canWriteOwnerNotes,
  type AttachArtifactInput,
  type Card,
  type CardActivity,
  type CardActivityInput,
  type CardArtifact,
  type BoardColumnKey,
  type ActivityActorType,
  type CardStatus,
  type CreateCardInput,
  type GateId,
  type UpdateCardInput,
} from '../shared/work.js';
import { OWNER_USER_ID } from '../shared/identity.js';
import { getLadder } from './gate-policy.js';

interface CardRow {
  id: string;
  project_id: string;
  parent_card_id: string | null;
  title: string;
  description: string;
  status: CardStatus;
  priority: Card['priority'];
  assignee_org_agent_id: string | null;
  owner_notes: string;
  gate_id: Card['gateId'];
  reviewer_count_override: number | null;
  reviewer_raise_reason: string | null;
  reviewer_raised_by_user_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

interface ActivityRow {
  id: string;
  card_id: string;
  actor_type: CardActivity['actorType'];
  actor_id: string | null;
  kind: CardActivity['kind'];
  detail: string;
  created_at: string;
}

interface ArtifactRow {
  id: string;
  card_id: string;
  run_id: string | null;
  kind: CardArtifact['kind'];
  label: string;
  location: string;
  created_at: string;
}

const mapCard = (row: CardRow): Card => ({
  id: row.id,
  projectId: row.project_id,
  parentCardId: row.parent_card_id,
  title: row.title,
  description: row.description,
  status: row.status,
  priority: row.priority,
  assigneeOrgAgentId: row.assignee_org_agent_id,
  ownerNotes: row.owner_notes,
  gateId: row.gate_id,
  reviewerCountOverride: row.reviewer_count_override,
  reviewerRaiseReason: row.reviewer_raise_reason,
  reviewerRaisedByUserId: row.reviewer_raised_by_user_id,
  position: row.position,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapActivity = (row: ActivityRow): CardActivity => ({
  id: row.id,
  cardId: row.card_id,
  actorType: row.actor_type,
  actorId: row.actor_id,
  kind: row.kind,
  detail: row.detail,
  createdAt: row.created_at,
});

const mapArtifact = (row: ArtifactRow): CardArtifact => ({
  id: row.id,
  cardId: row.card_id,
  runId: row.run_id,
  kind: row.kind,
  label: row.label,
  location: row.location,
  createdAt: row.created_at,
});

export interface MoveCardInput {
  cardId: string;
  /**
   * A board column, not a status. Gate columns are not card statuses — moving
   * to `G2` puts the card in review at G2, and the repository does that
   * translation once so no caller has to remember it.
   */
  to: BoardColumnKey;
  position: number;
  userId: string;
  /**
   * Who the board should say moved it. Defaults to a person; an escalation or
   * an automation rule passes 'system', because recording the platform's own
   * action as a user's is a small lie that an audit trail cannot afford.
   */
  actorType?: ActivityActorType;
}

export interface RaiseReviewerCountInput {
  cardId: string;
  count: number;
  reason: string;
  userId: string;
}

export interface SetOwnerNotesInput {
  cardId: string;
  notes: string;
  userId: string;
}

export interface WorkRepository {
  createCard(input: CreateCardInput): Card;
  getCard(cardId: string): Card | null;
  /** The whole board for a project, column by column, in position order. */
  listCards(projectId: string): Card[];
  updateCard(cardId: string, input: UpdateCardInput): Card;
  /**
   * The only way the owner's notes are written, and it takes a user id.
   * There is no agent-facing path to this method.
   */
  setOwnerNotes(input: SetOwnerNotesInput): Card;
  moveCard(input: MoveCardInput): Card;
  /**
   * Raises the reviewer count for one card, recording who raised it and why.
   * Lowering is not this method's business: the gate policy rejects an override
   * below the ladder default, so there is no way in here to weaken a gate.
   */
  raiseReviewerCount(input: RaiseReviewerCountInput): Card;
  appendActivity(input: CardActivityInput): CardActivity;
  listActivity(cardId: string): CardActivity[];
  attachArtifact(input: AttachArtifactInput): CardArtifact;
  listArtifacts(cardId: string): CardArtifact[];
}

export function createWorkRepository(connection: Database.Database): WorkRepository {
  const selectCard = connection.prepare('SELECT * FROM cards WHERE id = ?');

  const requireCardRow = (cardId: string): CardRow => {
    const row = selectCard.get(cardId) as CardRow | undefined;
    if (!row) throw new Error(`Card not found: ${cardId}`);
    return row;
  };

  /**
   * Activity is ordered by an explicit sequence, not by `created_at`.
   *
   * Two entries written inside one transaction share a millisecond, and an
   * ISO timestamp cannot separate them — so a log ordered by time alone
   * reorders itself between reads. An audit trail that does not hold its order
   * is not an audit trail.
   */
  const nextSequence = connection.prepare(
    'SELECT COALESCE(MAX(sequence) + 1, 0) AS next FROM card_activity WHERE card_id = ?',
  );

  const insertActivity = connection.prepare(`
    INSERT INTO card_activity (id, card_id, actor_type, actor_id, kind, detail, created_at, sequence)
    VALUES (@id, @cardId, @actorType, @actorId, @kind, @detail, @createdAt, @sequence)
  `);

  const recordActivity = (input: CardActivityInput): CardActivity => {
    if (input.kind === 'notes_changed' && !canWriteOwnerNotes(input.actorType)) {
      throw new Error("Only the owner may change a card's owner notes");
    }
    const row = {
      id: randomUUID(),
      cardId: input.cardId,
      actorType: input.actorType,
      actorId: input.actorId,
      kind: input.kind,
      detail: input.detail ?? '',
      createdAt: new Date().toISOString(),
      sequence: (nextSequence.get(input.cardId) as { next: number }).next,
    };
    insertActivity.run(row);
    return {
      id: row.id,
      cardId: row.cardId,
      actorType: row.actorType,
      actorId: row.actorId,
      kind: row.kind,
      detail: row.detail,
      createdAt: row.createdAt,
    };
  };

  return {
    createCard(input) {
      return connection.transaction(() => {
        if (input.parentCardId) {
          const parent = requireCardRow(input.parentCardId);
          if (parent.project_id !== input.projectId) {
            // A card whose parent lives elsewhere belongs to two boards at once,
            // and neither board can show a true picture of its own work.
            throw new Error('A parent card must belong to the same project');
          }
        }
        const { position } = connection
          .prepare(
            "SELECT COALESCE(MAX(position) + 1, 0) AS position FROM cards WHERE project_id = ? AND status = 'backlog'",
          )
          .get(input.projectId) as { position: number };
        const now = new Date().toISOString();
        const id = randomUUID();
        connection.prepare(`
          INSERT INTO cards (
            id, project_id, parent_card_id, title, description, status, priority,
            assignee_org_agent_id, owner_notes, position, created_at, updated_at
          ) VALUES (
            @id, @projectId, @parentCardId, @title, @description, 'backlog', @priority,
            NULL, '', @position, @createdAt, @createdAt
          )
        `).run({
          id,
          projectId: input.projectId,
          parentCardId: input.parentCardId ?? null,
          title: input.title,
          description: input.description ?? '',
          priority: input.priority ?? 'medium',
          position,
          createdAt: now,
        });
        recordActivity({
          cardId: id,
          actorType: 'user',
          actorId: input.userId ?? OWNER_USER_ID,
          kind: 'created',
          detail: input.title,
        });
        return mapCard(requireCardRow(id));
      })();
    },

    getCard(cardId) {
      const row = selectCard.get(cardId) as CardRow | undefined;
      return row ? mapCard(row) : null;
    },

    listCards(projectId) {
      const rows = connection
        .prepare('SELECT * FROM cards WHERE project_id = ? ORDER BY status, position, created_at')
        .all(projectId) as CardRow[];
      return rows.map(mapCard);
    },

    updateCard(cardId, input) {
      // A cast defeats the type, so the key is refused at runtime as well. This
      // method is reachable from a request body; the type is not.
      if ('ownerNotes' in input) {
        throw new Error('Owner notes are set through setOwnerNotes, by a user actor only');
      }
      return connection.transaction(() => {
        const existing = requireCardRow(cardId);
        const next = {
          title: input.title ?? existing.title,
          description: input.description ?? existing.description,
          priority: input.priority ?? existing.priority,
          assigneeOrgAgentId:
            input.assigneeOrgAgentId === undefined
              ? existing.assignee_org_agent_id
              : input.assigneeOrgAgentId,
          updatedAt: new Date().toISOString(),
          id: cardId,
        };
        connection.prepare(`
          UPDATE cards SET
            title = @title, description = @description, priority = @priority,
            assignee_org_agent_id = @assigneeOrgAgentId, updated_at = @updatedAt
          WHERE id = @id
        `).run(next);
        if (next.assigneeOrgAgentId !== existing.assignee_org_agent_id) {
          recordActivity({
            cardId,
            actorType: 'user',
            actorId: OWNER_USER_ID,
            kind: 'assigned',
            detail: next.assigneeOrgAgentId ?? 'unassigned',
          });
        }
        return mapCard(requireCardRow(cardId));
      })();
    },

    setOwnerNotes(input) {
      return connection.transaction(() => {
        requireCardRow(input.cardId);
        connection
          .prepare('UPDATE cards SET owner_notes = ?, updated_at = ? WHERE id = ?')
          .run(input.notes, new Date().toISOString(), input.cardId);
        recordActivity({
          cardId: input.cardId,
          actorType: 'user',
          actorId: input.userId,
          kind: 'notes_changed',
          detail: '',
        });
        return mapCard(requireCardRow(input.cardId));
      })();
    },

    moveCard(input) {
      return connection.transaction(() => {
        const source = requireCardRow(input.cardId);
        // A gate column is not a status. Translate here, once, so no caller has
        // to remember that G2 means "in review, at G2".
        const isGate = /^G[1-4]$/.test(input.to);
        const status: CardStatus = isGate ? 'review' : (input.to as CardStatus);
        const gateId: GateId | null = isGate ? (input.to as GateId) : null;
        // Close the gap the card leaves behind, open one where it lands, then
        // write it. Doing this in any other order leaves two cards sharing a
        // position, and the board renders them in an arbitrary order.
        connection
          .prepare(
            'UPDATE cards SET position = position - 1 WHERE project_id = ? AND status = ? AND position > ?',
          )
          .run(source.project_id, source.status, source.position);
        connection
          .prepare(
            'UPDATE cards SET position = position + 1 WHERE project_id = ? AND status = ? AND position >= ? AND id <> ?',
          )
          .run(source.project_id, status, input.position, input.cardId);
        connection
          .prepare(
            'UPDATE cards SET status = ?, gate_id = ?, position = ?, updated_at = ? WHERE id = ?',
          )
          .run(status, gateId, input.position, new Date().toISOString(), input.cardId);
        recordActivity({
          cardId: input.cardId,
          actorType: input.actorType ?? 'user',
          actorId: input.userId,
          kind: 'moved',
          detail: `${source.gate_id ?? source.status} -> ${input.to}`,
        });
        return mapCard(requireCardRow(input.cardId));
      })();
    },

    raiseReviewerCount(input) {
      return connection.transaction(() => {
        const card = requireCardRow(input.cardId);
        /*
         * A raise may never lower. The policy already refuses a low value when
         * the count is READ, but that is too late: the bad number is already
         * stored, and every board read then throws instead of rendering. An
         * override is checked against the strictest gate on the project's
         * ladder, so no gate on it can be weakened.
         */
        const project = connection
          .prepare('SELECT gate_ladder_id FROM platform_projects WHERE id = ?')
          .get(card.project_id) as { gate_ladder_id: string | null } | undefined;
        const strictest = getLadder(project?.gate_ladder_id ?? 'product').gates
          .reduce((most, gate) => Math.max(most, gate.reviewerCount), 0);
        if (input.count < strictest) {
          throw new Error(
            `Reviewer count may be raised but not lowered: this ladder requires at least ` +
              `${strictest}, got ${input.count}`,
          );
        }
        if (!input.reason.trim()) {
          // The reason is the point. A raise with no reason cannot be looked
          // back on, which is the whole justification for recording it.
          throw new Error('A reviewer raise must record why');
        }
        connection.prepare(`
          UPDATE cards SET
            reviewer_count_override = @count,
            reviewer_raise_reason = @reason,
            reviewer_raised_by_user_id = @userId,
            updated_at = @updatedAt
          WHERE id = @cardId
        `).run({ ...input, updatedAt: new Date().toISOString() });
        return mapCard(requireCardRow(input.cardId));
      })();
    },

    appendActivity: (input) => recordActivity(input),

    listActivity(cardId) {
      const rows = connection
        .prepare('SELECT * FROM card_activity WHERE card_id = ? ORDER BY sequence')
        .all(cardId) as ActivityRow[];
      return rows.map(mapActivity);
    },

    attachArtifact(input) {
      return connection.transaction(() => {
        requireCardRow(input.cardId);
        const id = randomUUID();
        connection.prepare(`
          INSERT INTO card_artifacts (id, card_id, run_id, kind, label, location, created_at)
          VALUES (@id, @cardId, @runId, @kind, @label, @location, @createdAt)
        `).run({ ...input, id, createdAt: new Date().toISOString() });
        recordActivity({
          cardId: input.cardId,
          actorType: input.runId ? 'system' : 'user',
          actorId: input.runId,
          kind: 'artifact_attached',
          detail: input.label,
        });
        return mapArtifact(
          connection.prepare('SELECT * FROM card_artifacts WHERE id = ?').get(id) as ArtifactRow,
        );
      })();
    },

    listArtifacts(cardId) {
      const rows = connection
        .prepare('SELECT * FROM card_artifacts WHERE card_id = ? ORDER BY created_at, id')
        .all(cardId) as ArtifactRow[];
      return rows.map(mapArtifact);
    },
  };
}
