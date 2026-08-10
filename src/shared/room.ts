export type RoomStatus = 'open' | 'archived';

export interface Room {
  id: string;
  /** The card this room belongs to. One card, one room. */
  cardId: string;
  title: string;
  status: RoomStatus;
  createdAt: string;
  archivedAt: string | null;
}

export type MemberKind = 'user' | 'org_agent';

export interface RoomMember {
  roomId: string;
  memberKind: MemberKind;
  memberId: string;
  addedAt: string;
}

/**
 * Who wrote a message.
 *
 * `system` is the platform itself — run lifecycle notices and the like. It is
 * never a member of anything, so membership is not checked for it.
 */
export type AuthorKind = 'user' | 'org_agent' | 'system';

export interface RoomMessage {
  id: string;
  roomId: string;
  /** The top-level message this replies to, or null for a top-level message. */
  threadId: string | null;
  authorKind: AuthorKind;
  authorId: string | null;
  /** The run that produced this message, when one did. */
  runId: string | null;
  body: string;
  createdAt: string;
}

/** A top-level message with its replies, which is how a room is read. */
export interface RoomThread {
  message: RoomMessage;
  replies: RoomMessage[];
}

export interface RoomCanvas {
  roomId: string;
  /** 0 before anything is written, then one higher on every write. */
  revision: number;
  content: string;
  updatedAt: string | null;
}

/**
 * Whether an author has to be a member to post.
 *
 * People and agents speak as participants; the platform speaks as the platform.
 */
export function requiresMembership(authorKind: AuthorKind): boolean {
  return authorKind !== 'system';
}
