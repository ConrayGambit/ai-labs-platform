import { useEffect, useState } from 'react';
import { getReviewState } from '../api/client.js';
import type { GateReviewState, Review } from '../../shared/governance.js';
import type { GateId } from '../../shared/work.js';

export interface ReviewPanelProps {
  cardId: string;
  gateId: GateId;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * One filed, visible review: the reviewer's verdict, checklist and prose.
 *
 * Never the review's findings — those are the P0-P4 ladder, and rendering
 * them here too would duplicate FindingsPanel's own job with no adjudication
 * controls attached, which is worse than not showing them at all.
 *
 * Every optional-looking access below is defensive on purpose: this row
 * renders whatever the server actually sent, and a `Review` fetched over the
 * wire is only as complete as the row that produced it.
 */
function ReviewRow({ review }: { review: Review }) {
  const checklist = review.checklist ?? [];
  return (
    <li className="review-row">
      <div className="review-row-head">
        <span className="card-pill">{review.reviewerOrgAgentId}</span>
        <span className="card-pill">{review.verdict.replace(/_/g, ' ')}</span>
        <span className="activity-meta">{formatTimestamp(review.filedAt)}</span>
      </div>
      {checklist.length > 0 && (
        <ul className="review-checklist">
          {checklist.map((entry, index) => (
            <li key={index}>
              <span className="field-label">{entry.item}</span> {entry.answer}
            </li>
          ))}
        </ul>
      )}
      {review.whatToPreserve?.trim() && (
        <p className="detail-prose">Preserve: {review.whatToPreserve}</p>
      )}
      {review.questionsForBuilder?.trim() && (
        <p className="detail-prose">Questions for the builder: {review.questionsForBuilder}</p>
      )}
    </li>
  );
}

/**
 * The blind-review ladder for one card at one gate.
 *
 * Blindness is a state the server computes (`GateSealState`, spec 20.3) and
 * this panel's one job is to make it visible as one: rendered first, with the
 * server's own reason, and never inferred from what happens to be in
 * `visibleReviews` — a gate can be sealed AND have a non-empty visible list at
 * once (a reviewer always sees its own filed review, even before the gate
 * unseals), so "no reviews shown" is never read as "sealed" or vice versa.
 * Constraint: an empty review list where a gate is sealed is the exact
 * failure this panel exists to avoid, so the seal block and the review list
 * are rendered independently of one another, both always from server data.
 */
export function ReviewPanel({ cardId, gateId }: ReviewPanelProps) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gateReview, setGateReview] = useState<GateReviewState | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    getReviewState(cardId, gateId).then((result) => {
      if (cancelled) return;
      setGateReview(result);
      setLoadState('ready');
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setLoadError(reason instanceof Error ? reason.message : 'Unable to load the review state');
      setLoadState('error');
    });
    return () => { cancelled = true; };
  }, [cardId, gateId]);

  return (
    <div className="review-panel">
      {loadState === 'loading' && <p className="detail-empty">Loading reviews…</p>}
      {loadState === 'error' && <p className="form-error" role="alert">{loadError}</p>}
      {loadState === 'ready' && gateReview && (
        <>
          {/*
            10px mono only survives framed in a container (DESIGN.md's Small
            Type Is Earned Rule) — reusing .card-pill rather than a bare,
            unframed <p> at the same size, the same object every other short
            machine-generated token on this page already is.
          */}
          <span className="card-pill">
            Filed {gateReview.filedReviewerIds.length} of {gateReview.requiredReviewers}
          </span>
          {gateReview.sealed && (
            <div className="review-seal" role="status">
              <p className="field-label">Sealed</p>
              <p className="detail-prose">{gateReview.sealReason}</p>
            </div>
          )}
          <ul className="review-list">
            {gateReview.visibleReviews.map((review) => <ReviewRow key={review.id} review={review} />)}
          </ul>
          {gateReview.visibleReviews.length === 0 && (
            <p className="detail-empty">No reviews are visible yet.</p>
          )}
        </>
      )}
    </div>
  );
}
