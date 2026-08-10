import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  requiresMembership,
  type AuthorKind,
  type MemberKind,
  type Room,
  type RoomCanvas,
  type RoomMember,
  type RoomMessage,
  type RoomStatus,
  type RoomThread,
} from '../shared/room.js';

interface RoomRow {
  id: string;
  card_id: string;
  title: string;
  status: RoomStatus;
  created_at: string;
  archived_at: string | null;
}

interface MemberRow {
  room_id: string;
  member_kind: MemberKind;
  member_id: string;
  added_at: string;
}

interface MessageRow {
  id: string;
  room_id: string;
  thread_id: string | null;
  author_kind: AuthorKind;
  author_id: string | null;
  run_id: string | null;
  body: string;
  created_at: string;
}

interface CanvasRow {
  room_id: string;
  revision: number;
  content: string;
  updated_at: string | null;
}

const mapRoom = (row: RoomRow): Room => ({
  id: row.id,
  cardId: row.card_id,
  title: row.title,
  status: row.status,
  createdAt: row.created_at,
  archivedAt: row.archived_at,
});

const mapMember = (row: MemberRow): RoomMember => ({
  roomId: row.room_id,
  memberKind: row.member_kind,
  memberId: row.member_id,
  addedAt: row.added_at,
});

const mapMessage = (row: MessageRow): RoomMessage => ({
  id: row.id,
  roomId: row.room_id,
  threadId: row.thread_id,
  authorKind: row.author_kind,
  authorId: row.author_id,
  runId: row.run_id,
  body: row.body,
  createdAt: row.created_at,
});

const mapCanvas = (row: CanvasRow): RoomCanvas => ({
  roomId: row.room_id,
  revision: row.revision,
  content: row.content,
  updatedAt: row.updated_at,
});

export interface CreateRoomInput {
  cardId: string;
  title: string;
}

export interface MemberInput {
  roomId: string;
  memberKind: MemberKind;
  memberId: string;
}

export interface PostMessageInput {
  roomId: string;
  threadId: string | null;
  authorKind: AuthorKind;
  authorId: string | null;
  runId: string | null;
  body: string;
}

export interface SetCanvasInput {
  roomId: string;
  content: string;
}

export interface RoomRepository {
  createRoomForCard(input: CreateRoomInput): Room;
  getRoom(roomId: string): Room | null;
  getRoomForCard(cardId: string): Room | null;
  /** Closes a room to new messages. What was said stays readable. */
  archiveRoom(roomId: string): Room;
  addMember(input: MemberInput): RoomMember;
  removeMember(input: MemberInput): void;
  listMembers(roomId: string): RoomMember[];
  postMessage(input: PostMessageInput): RoomMessage;
  /** Top-level messages, oldest first, each with its replies. */
  listMessages(roomId: string): RoomThread[];
  getCanvas(roomId: string): RoomCanvas;
  setCanvas(input: SetCanvasInput): RoomCanvas;
}

export function createRoomRepository(connection: Database.Database): RoomRepository {
  const selectRoom = connection.prepare('SELECT * FROM rooms WHERE id = ?');

  const requireRoomRow = (roomId: string): RoomRow => {
    const row = selectRoom.get(roomId) as RoomRow | undefined;
    if (!row) throw new Error(`Room not found: ${roomId}`);
    return row;
  };

  /**
   * Messages carry an explicit per-room sequence, for the same reason card
   * activity does: entries written in the same millisecond cannot be separated
   * by an ISO timestamp, and a conversation that reorders itself between reads
   * is not a conversation.
   */
  const nextSequence = connection.prepare(
    'SELECT COALESCE(MAX(sequence) + 1, 0) AS next FROM room_messages WHERE room_id = ?',
  );

  const isMember = connection.prepare(
    'SELECT 1 FROM room_members WHERE room_id = ? AND member_kind = ? AND member_id = ?',
  );

  return {
    createRoomForCard(input) {
      return connection.transaction(() => {
        const card = connection.prepare('SELECT id FROM cards WHERE id = ?').get(input.cardId);
        if (!card) throw new Error(`Card not found: ${input.cardId}`);
        const existing = connection.prepare('SELECT id FROM rooms WHERE card_id = ?').get(input.cardId);
        if (existing) {
          // Two rooms for one card means two places to look for the same
          // conversation, and half of it lost in whichever nobody opens.
          throw new Error(`Card already has a room: ${input.cardId}`);
        }
        const id = randomUUID();
        connection.prepare(`
          INSERT INTO rooms (id, card_id, title, status, created_at, archived_at)
          VALUES (@id, @cardId, @title, 'open', @createdAt, NULL)
        `).run({ id, cardId: input.cardId, title: input.title, createdAt: new Date().toISOString() });
        connection
          .prepare('INSERT INTO room_canvas (room_id, revision, content, updated_at) VALUES (?, 0, \'\', NULL)')
          .run(id);
        return mapRoom(requireRoomRow(id));
      })();
    },

    getRoom(roomId) {
      const row = selectRoom.get(roomId) as RoomRow | undefined;
      return row ? mapRoom(row) : null;
    },

    getRoomForCard(cardId) {
      const row = connection.prepare('SELECT * FROM rooms WHERE card_id = ?').get(cardId) as
        | RoomRow
        | undefined;
      return row ? mapRoom(row) : null;
    },

    archiveRoom(roomId) {
      requireRoomRow(roomId);
      connection
        .prepare("UPDATE rooms SET status = 'archived', archived_at = ? WHERE id = ?")
        .run(new Date().toISOString(), roomId);
      return mapRoom(requireRoomRow(roomId));
    },

    addMember(input) {
      requireRoomRow(input.roomId);
      const addedAt = new Date().toISOString();
      // Adding someone already present is what a user expects to be harmless.
      connection.prepare(`
        INSERT INTO room_members (room_id, member_kind, member_id, added_at)
        VALUES (@roomId, @memberKind, @memberId, @addedAt)
        ON CONFLICT(room_id, member_kind, member_id) DO NOTHING
      `).run({ ...input, addedAt });
      const row = connection
        .prepare('SELECT * FROM room_members WHERE room_id = ? AND member_kind = ? AND member_id = ?')
        .get(input.roomId, input.memberKind, input.memberId) as MemberRow;
      return mapMember(row);
    },

    removeMember(input) {
      connection
        .prepare('DELETE FROM room_members WHERE room_id = ? AND member_kind = ? AND member_id = ?')
        .run(input.roomId, input.memberKind, input.memberId);
    },

    listMembers(roomId) {
      const rows = connection
        .prepare('SELECT * FROM room_members WHERE room_id = ? ORDER BY member_kind, member_id')
        .all(roomId) as MemberRow[];
      return rows.map(mapMember);
    },

    postMessage(input) {
      return connection.transaction(() => {
        const room = requireRoomRow(input.roomId);
        if (room.status === 'archived') {
          throw new Error(`Room is archived and takes no new messages: ${input.roomId}`);
        }
        if (requiresMembership(input.authorKind)) {
          const present = isMember.get(input.roomId, input.authorKind, input.authorId ?? '');
          if (!present) {
            throw new Error(
              `${input.authorId ?? 'Anonymous'} is not a member of room ${input.roomId}`,
            );
          }
        }
        if (input.threadId) {
          const parent = connection.prepare('SELECT * FROM room_messages WHERE id = ?')
            .get(input.threadId) as MessageRow | undefined;
          if (!parent) throw new Error(`Message not found: ${input.threadId}`);
          if (parent.room_id !== input.roomId) {
            throw new Error('A reply must be in the same room as the message it replies to');
          }
          if (parent.thread_id) {
            // One level, like a chat thread. Arbitrary nesting produces
            // conversations nobody can follow and a renderer nobody can write.
            throw new Error('Threads are one level deep: reply to the top-level message');
          }
        }
        const id = randomUUID();
        connection.prepare(`
          INSERT INTO room_messages
            (id, room_id, thread_id, author_kind, author_id, run_id, body, created_at, sequence)
          VALUES
            (@id, @roomId, @threadId, @authorKind, @authorId, @runId, @body, @createdAt, @sequence)
        `).run({
          ...input,
          id,
          createdAt: new Date().toISOString(),
          sequence: (nextSequence.get(input.roomId) as { next: number }).next,
        });
        return mapMessage(
          connection.prepare('SELECT * FROM room_messages WHERE id = ?').get(id) as MessageRow,
        );
      })();
    },

    listMessages(roomId) {
      const rows = connection
        .prepare('SELECT * FROM room_messages WHERE room_id = ? ORDER BY sequence')
        .all(roomId) as MessageRow[];
      const threads = new Map<string, RoomThread>();
      const ordered: RoomThread[] = [];
      for (const row of rows) {
        if (!row.thread_id) {
          const thread: RoomThread = { message: mapMessage(row), replies: [] };
          threads.set(row.id, thread);
          ordered.push(thread);
        }
      }
      for (const row of rows) {
        if (!row.thread_id) continue;
        // A reply whose parent is missing would otherwise vanish from the room.
        const thread = threads.get(row.thread_id);
        if (thread) thread.replies.push(mapMessage(row));
      }
      return ordered;
    },

    getCanvas(roomId) {
      requireRoomRow(roomId);
      const row = connection.prepare('SELECT * FROM room_canvas WHERE room_id = ?').get(roomId) as
        | CanvasRow
        | undefined;
      return row
        ? mapCanvas(row)
        : { roomId, revision: 0, content: '', updatedAt: null };
    },

    setCanvas(input) {
      return connection.transaction(() => {
        requireRoomRow(input.roomId);
        // The revision is the room's own counter, incremented in the same
        // statement that writes the content, so two concurrent writes cannot
        // land on the same number.
        connection.prepare(`
          INSERT INTO room_canvas (room_id, revision, content, updated_at)
          VALUES (@roomId, 1, @content, @updatedAt)
          ON CONFLICT(room_id) DO UPDATE SET
            revision = revision + 1,
            content = excluded.content,
            updated_at = excluded.updated_at
        `).run({ ...input, updatedAt: new Date().toISOString() });
        return mapCanvas(
          connection.prepare('SELECT * FROM room_canvas WHERE room_id = ?').get(input.roomId) as CanvasRow,
        );
      })();
    },
  };
}
