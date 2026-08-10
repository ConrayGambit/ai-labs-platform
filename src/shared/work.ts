export const CARD_STATUSES = [
  'backlog', 'ready', 'in_progress', 'review', 'blocked', 'done',
] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const CARD_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const;
export type CardPriority = (typeof CARD_PRIORITIES)[number];

export interface Card {
  id: string;
  projectId: string;
  parentCardId: string | null;
  title: string;
  description: string;
  status: CardStatus;
  priority: CardPriority;
  /** Exactly one accountable agent. Everyone else participates through the room. */
  assigneeOrgAgentId: string | null;
  /** The owner's notes. Agents read these; agents never write them. */
  ownerNotes: string;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCardInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: CardPriority;
  parentCardId?: string | null;
  /** Defaults to the owner. Card creation is always attributed to somebody. */
  userId?: string;
}

/**
 * Every field a card update may touch.
 *
 * `ownerNotes` is deliberately absent. It is not an oversight and it is not
 * enforced by types alone — the repository rejects the key at runtime too,
 * because a cast is all it takes to defeat a type.
 */
export interface UpdateCardInput {
  title?: string;
  description?: string;
  priority?: CardPriority;
  assigneeOrgAgentId?: string | null;
}

export type ActivityActorType = 'user' | 'org_agent' | 'system';

export const ACTIVITY_KINDS = [
  'created', 'moved', 'assigned', 'notes_changed', 'artifact_attached', 'commented',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface CardActivity {
  id: string;
  cardId: string;
  actorType: ActivityActorType;
  actorId: string | null;
  kind: ActivityKind;
  detail: string;
  createdAt: string;
}

export interface CardActivityInput {
  cardId: string;
  actorType: ActivityActorType;
  actorId: string | null;
  kind: ActivityKind;
  detail?: string;
}

export const ARTIFACT_KINDS = ['file', 'diff', 'link', 'report'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface CardArtifact {
  id: string;
  cardId: string;
  runId: string | null;
  kind: ArtifactKind;
  label: string;
  location: string;
  createdAt: string;
}

export interface AttachArtifactInput {
  cardId: string;
  runId: string | null;
  kind: ArtifactKind;
  label: string;
  location: string;
}

/** Output-first: a card may not reach done without an inspectable artifact. */
export function canCloseCard(artifactCount: number): boolean {
  return artifactCount > 0;
}

/**
 * Whether an actor may write the owner's notes.
 *
 * The rule reads as one line so it cannot drift between the places that need
 * it: only a human writes the owner's notes. An agent that could edit the
 * instructions it is judged against has no instructions.
 */
export function canWriteOwnerNotes(actorType: ActivityActorType): boolean {
  return actorType === 'user';
}
