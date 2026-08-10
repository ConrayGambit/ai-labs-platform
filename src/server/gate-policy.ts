import {
  effectiveReviewerCount,
  type AdvanceEvidence,
  type BoardColumn,
  type BoardColumnKey,
  type CardStatus,
  type Gate,
  type GateId,
  type GateLadder,
} from '../shared/work.js';

/**
 * One reviewer everywhere by default (spec 20.2.1).
 *
 * `independentReview` stays true throughout because it describes *how* reviews
 * are filed once a project or card raises the count to two. It simply does not
 * engage at one — there is nobody to be blind from.
 */
export const PRODUCT_LADDER: GateLadder = {
  id: 'product',
  label: 'Product and code',
  gates: [
    { id: 'G1', label: 'Design', reviewerCount: 1, independentReview: true, ownerSignature: false, requiresSpecification: true },
    { id: 'G2', label: 'Slice', reviewerCount: 1, independentReview: true, ownerSignature: false, requiresSpecification: false },
    { id: 'G3', label: 'Pre-merge', reviewerCount: 1, independentReview: true, ownerSignature: true, requiresSpecification: false },
    { id: 'G4', label: 'Pre-deploy', reviewerCount: 1, independentReview: true, ownerSignature: true, requiresSpecification: false },
  ],
};

export const BUSINESS_LADDER: GateLadder = {
  id: 'business',
  label: 'Business and operations',
  gates: [
    { id: 'G1', label: 'Draft review', reviewerCount: 1, independentReview: false, ownerSignature: false, requiresSpecification: false },
    { id: 'G4', label: 'Pre-send', reviewerCount: 0, independentReview: false, ownerSignature: true, requiresSpecification: false },
  ],
};

export const LADDERS: readonly GateLadder[] = [PRODUCT_LADDER, BUSINESS_LADDER];

export function getLadder(ladderId: string): GateLadder {
  const ladder = LADDERS.find((candidate) => candidate.id === ladderId);
  if (!ladder) throw new Error(`Unknown gate ladder: ${ladderId}`);
  return ladder;
}

const FIXED_LABELS: Record<Exclude<CardStatus, 'review'>, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
};

/**
 * The board for a ladder.
 *
 * Work is picked up before it is reviewed, so `in_progress` precedes the gates
 * rather than following them. `ready` gets a column of its own: it is a real
 * card status, and a status with no column is a card that renders nowhere.
 */
export function deriveColumns(ladder: GateLadder): BoardColumn[] {
  return [
    { key: 'backlog', label: FIXED_LABELS.backlog, gateId: null },
    { key: 'ready', label: FIXED_LABELS.ready, gateId: null },
    { key: 'in_progress', label: FIXED_LABELS.in_progress, gateId: null },
    ...ladder.gates.map((gate) => ({
      key: gate.id as BoardColumnKey,
      label: `${gate.id} ${gate.label}`,
      gateId: gate.id,
    })),
    { key: 'blocked', label: FIXED_LABELS.blocked, gateId: null },
    { key: 'done', label: FIXED_LABELS.done, gateId: null },
  ];
}

export interface CardPosition {
  status: CardStatus;
  gateId: GateId | null;
}

/**
 * Which column a card renders in.
 *
 * A card in review without a recorded gate falls to the ladder's first gate
 * rather than disappearing. That state should not arise, but a board that hides
 * a card is worse than a board that shows it in the wrong place.
 */
export function columnKeyFor(card: CardPosition, ladder?: GateLadder): BoardColumnKey {
  if (card.status !== 'review') return card.status;
  if (card.gateId) return card.gateId;
  const first = ladder?.gates[0];
  if (!first) throw new Error('A card in review needs a gate, or a ladder to fall back to');
  return first.id;
}

export interface AdvanceRequest {
  card: CardPosition & { reviewerCountOverride?: number | null };
  ladder: GateLadder;
  to: BoardColumnKey;
  evidence: AdvanceEvidence;
  projectReviewerCountOverride?: number | null;
}

export type AdvanceVerdict = { allowed: true } | { allowed: false; reason: string };

const gateOf = (ladder: GateLadder, gateId: GateId | null): Gate | null =>
  gateId ? ladder.gates.find((gate) => gate.id === gateId) ?? null : null;

/**
 * Whether a card may move to a column, and if not, why not in words a person
 * can act on.
 *
 * An allowed verdict carries no reason. A caller that renders `reason` whenever
 * it is present would otherwise show a denial message on a successful move.
 */
export function canAdvance(request: AdvanceRequest): AdvanceVerdict {
  const { card, ladder, to, evidence } = request;

  // Becoming blocked, and returning from blocked, are not advances. Requiring
  // evidence to resume work would strand the card in the one column nobody
  // wants it to sit in.
  if (to === 'blocked' || card.status === 'blocked') return { allowed: true };

  const destinationGate = gateOf(ladder, to as GateId);
  const isGateDestination = deriveColumns(ladder).some((column) => column.key === to);
  if (!isGateDestination) {
    return {
      allowed: false,
      reason: `The ${ladder.label} ladder has no ${to} column.`,
    };
  }

  const currentGate = gateOf(ladder, card.gateId);
  if (card.status === 'review' && currentGate) {
    let required: number;
    try {
      required = effectiveReviewerCount(currentGate, {
        card: card.reviewerCountOverride,
        project: request.projectReviewerCountOverride,
      });
    } catch (reason) {
      return { allowed: false, reason: reason instanceof Error ? reason.message : String(reason) };
    }
    if (evidence.reviewsFiled < required) {
      return {
        allowed: false,
        reason:
          `Gate ${currentGate.id} ${currentGate.label} needs ${required} review(s); ` +
          `${evidence.reviewsFiled} of ${required} filed.`,
      };
    }
    if (currentGate.requiresSpecification && evidence.missingSpecificationSections.length > 0) {
      // If the card cannot be completed, the feature is not understood well
      // enough to build (spec 20.5). Every gap is named at once.
      return {
        allowed: false,
        reason:
          `Gate ${currentGate.id} needs a complete feature specification; still missing: ` +
          `${evidence.missingSpecificationSections.join(', ')}.`,
      };
    }
    if (currentGate.ownerSignature && !evidence.ownerDecision) {
      return {
        allowed: false,
        reason: `Gate ${currentGate.id} ${currentGate.label} needs the owner's signature.`,
      };
    }
  }

  // Output-first: a card closes on something inspectable, or it does not close.
  if (to === 'done' && evidence.artifactCount === 0) {
    return {
      allowed: false,
      reason: 'A card closes on an inspectable artifact; this one has none attached.',
    };
  }
  if (to === 'done' && evidence.missingHandoverPoints.length > 0) {
    // "Done" is not "it runs" (spec 20.6). Work handed back without a handover
    // is work the next person has to reconstruct.
    return {
      allowed: false,
      reason:
        `A card closes on a complete handover report; still missing: ` +
        `${evidence.missingHandoverPoints.join(', ')}.`,
    };
  }

  // Entering a gate is free; leaving it is what costs evidence.
  void destinationGate;
  return { allowed: true };
}
