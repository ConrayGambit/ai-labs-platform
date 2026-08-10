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
  /** Which gate the card sits at. Meaningful only while `status` is 'review'. */
  gateId: GateId | null;
  /** A deliberate raise in scrutiny for this card, or null for the default. */
  reviewerCountOverride: number | null;
  reviewerRaiseReason: string | null;
  reviewerRaisedByUserId: string | null;
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

export type GateId = 'G1' | 'G2' | 'G3' | 'G4';

export interface Gate {
  id: GateId;
  label: string;
  /**
   * Reviews required before a card may leave this gate, by default. One
   * everywhere; a project or a card may raise it, never lower it (spec 20.2.1).
   */
  reviewerCount: number;
  /**
   * When true, no reviewer may read another's review before filing. Enforced in
   * S2, and only meaningful once the effective count is two or more — at one
   * reviewer there is nobody to be blind from.
   */
  independentReview: boolean;
  /** When true, the owner must personally record a decision. */
  ownerSignature: boolean;
  /**
   * When true, a card may not LEAVE this gate until its feature specification
   * card is complete. Per-gate rather than global: G1 on the business ladder is
   * a draft review, and demanding thirteen engineering sections of a letter is
   * how a gate gets worked around rather than followed.
   */
  requiresSpecification: boolean;
}

export interface GateLadder {
  id: string;
  label: string;
  gates: Gate[];
}

/**
 * A board column key: one of the fixed lifecycle columns, or a gate.
 *
 * Gate columns are not card statuses. A card at a gate has `status = 'review'`
 * and carries the gate it sits at, which keeps the lifecycle a closed set while
 * letting each ladder show a different board.
 */
export type BoardColumnKey = Exclude<CardStatus, 'review'> | GateId;

export interface BoardColumn {
  key: BoardColumnKey;
  label: string;
  gateId: GateId | null;
}

export interface AdvanceEvidence {
  reviewsFiled: number;
  ownerDecision: boolean;
  artifactCount: number;
  /**
   * Specification sections still unwritten. Empty means complete.
   *
   * Required rather than optional on purpose: every route that advances a card
   * has to account for it, and the compiler says so. An optional field is a
   * field a new call site forgets, which is precisely how a rule ends up
   * enforced on one path and not another.
   */
  missingSpecificationSections: readonly string[];
  /** Handover points still unwritten. Empty means complete. Required, as above. */
  missingHandoverPoints: readonly string[];
}

/**
 * Most specific wins: the card, then the project, then the ladder's default.
 *
 * A value below the ladder's default is rejected rather than silently clamped.
 * Clamping would let a weakening override look accepted, and the whole point of
 * recording a raise is that somebody decided this work earned more scrutiny.
 */
export function effectiveReviewerCount(
  gate: Gate,
  overrides: { project?: number | null; card?: number | null },
): number {
  const chosen = overrides.card ?? overrides.project;
  // A null override means "not set", which is not the same as zero reviewers.
  if (chosen === undefined || chosen === null) return gate.reviewerCount;
  if (chosen < gate.reviewerCount) {
    throw new Error(
      `Reviewer count may be raised but not lowered: gate ${gate.id} requires at least ` +
        `${gate.reviewerCount}, got ${chosen}`,
    );
  }
  return chosen;
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
