import { useEffect, useState } from 'react';
import { adjudicateFinding, getAssignments, getReviewState, type AdjudicateResult } from '../api/client.js';
import type { Finding, FindingPriority, RulingOutcome } from '../../shared/governance.js';
import type { GateId } from '../../shared/work.js';

export interface FindingsPanelProps {
  cardId: string;
  gateId: GateId;
  /**
   * Called after any adjudicate call this panel makes succeeds, whatever the
   * outcome. `CardDetailView` uses this to force a fresh fetch of related
   * governance state elsewhere on the card (ReviewPanel included) rather than
   * leaving it to read as of when the dialog first opened.
   */
  onAdjudicated?: () => void;
}

/** Hardest first. Presentation order only — the ladder's own meaning lives entirely server-side. */
const PRIORITY_ORDER: readonly FindingPriority[] = ['P0', 'P1', 'P2', 'P3', 'P4'];

interface FindingRowProps {
  finding: Finding;
  gateId: GateId;
  /**
   * The org agent actually holding the `builder` role at this gate
   * (`GET /api/cards/:cardId/gates/:gateId/assignments`), or `null` when
   * none is registered yet. Never `Card.assigneeOrgAgentId` — that field is
   * independent of `review_assignments` and nothing syncs the two, so using
   * it here would be a guess presented as the answer to "who may rule",
   * which only the server actually knows.
   */
  builderOrgAgentId: string | null;
  onAdjudicated?: () => void;
}

/**
 * One finding on the ladder, with adopt / defer / override controls.
 *
 * All three actions are always offered, and all four fields are always
 * shown — deferral's extra requirements (a named next step, a date to
 * revisit it) are a service-level rule (governance-service.ts's
 * `adjudicate`), not a schema shape, and this panel never predicts it. A
 * defer attempt missing either one is sent anyway, and the server's own
 * refusal ("a finding dropped") renders verbatim below, same as any other
 * outcome. The only thing gated client-side is whether there is an identity
 * to submit at all — not whether the outcome itself would be accepted.
 */
function FindingRow({ finding, gateId, builderOrgAgentId, onAdjudicated }: FindingRowProps) {
  const [reason, setReason] = useState('');
  const [nextStep, setNextStep] = useState('');
  const [deferredUntil, setDeferredUntil] = useState('');
  const [residualRisk, setResidualRisk] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdjudicateResult | null>(null);

  async function submit(outcome: RulingOutcome): Promise<void> {
    if (!builderOrgAgentId) return;
    setSubmitting(true);
    setError(null);
    try {
      const adjudicated = await adjudicateFinding(finding.id, {
        gateId,
        outcome,
        reason,
        ruledByOrgAgentId: builderOrgAgentId,
        // Sent only once actually written: the schema (adjudicateSchema,
        // src/server/governance-api.ts) treats these as optional, and an
        // absent field is what "not filled in" should mean on the wire —
        // not an empty string masquerading as one.
        ...(nextStep.trim() ? { nextStep: nextStep.trim() } : {}),
        ...(deferredUntil.trim() ? { deferredUntil: deferredUntil.trim() } : {}),
        ...(residualRisk.trim() ? { residualRisk: residualRisk.trim() } : {}),
      });
      setResult(adjudicated);
      onAdjudicated?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to adjudicate this finding');
    } finally {
      setSubmitting(false);
    }
  }

  const priorityClass = finding.priority === 'P0' ? 'card-pill finding-priority-p0' : 'card-pill';
  // Basic form hygiene — the same class of guard RunPanel applies to its own
  // message field (canStart) — not a governance judgement about whether an
  // outcome is allowed. Reason is required by the API's own schema
  // regardless of outcome (z.string().trim().min(1)); an identity is
  // required to attribute the call to anyone at all, and `builderOrgAgentId`
  // is an observed fact (fetched from the gate's real assignments), never a
  // guess about whether THIS finding may be adjudicated this way — only the
  // server decides that.
  const canSubmit = Boolean(builderOrgAgentId) && reason.trim().length > 0 && !submitting;

  return (
    <li className="finding-row">
      <div className="finding-row-head">
        <span className={priorityClass}>{finding.priority}</span>
        <span className="card-pill">{finding.area}</span>
        <span className="activity-meta">{finding.evidence}</span>
      </div>
      <p className="detail-prose">{finding.finding}</p>
      {finding.predictedFailure && (
        <p className="detail-prose">Predicted failure: {finding.predictedFailure}</p>
      )}
      {finding.proposedFix && <p className="detail-prose">Proposed fix: {finding.proposedFix}</p>}

      <div className="detail-field">
        <label className="field-label" htmlFor={`reason-${finding.id}`}>Reason</label>
        <textarea
          id={`reason-${finding.id}`}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          value={reason}
        />
      </div>
      <div className="detail-field">
        <label className="field-label" htmlFor={`next-step-${finding.id}`}>Next step (required to defer)</label>
        <input id={`next-step-${finding.id}`} onChange={(event) => setNextStep(event.target.value)} value={nextStep} />
      </div>
      <div className="detail-field">
        <label className="field-label" htmlFor={`deferred-until-${finding.id}`}>Revisit by (required to defer)</label>
        <input
          id={`deferred-until-${finding.id}`}
          onChange={(event) => setDeferredUntil(event.target.value)}
          type="date"
          value={deferredUntil}
        />
      </div>
      <div className="detail-field">
        <label className="field-label" htmlFor={`residual-risk-${finding.id}`}>Residual risk</label>
        <input
          id={`residual-risk-${finding.id}`}
          onChange={(event) => setResidualRisk(event.target.value)}
          value={residualRisk}
        />
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {result && (
        <p className="detail-prose">
          Ruled {result.ruling.outcome} — {result.ruling.reason}
          {result.registerEntry && ` (recorded as ${result.registerEntry.reference} in the override register)`}
        </p>
      )}

      <div className="dialog-actions">
        <button className="ghost-button" disabled={!canSubmit} onClick={() => { void submit('adopted'); }} type="button">
          Adopt
        </button>
        <button className="ghost-button" disabled={!canSubmit} onClick={() => { void submit('deferred'); }} type="button">
          Defer
        </button>
        <button className="ghost-button" disabled={!canSubmit} onClick={() => { void submit('overridden'); }} type="button">
          Override
        </button>
      </div>
      {!builderOrgAgentId && (
        <p className="run-note">No builder is registered at this gate yet.</p>
      )}
    </li>
  );
}

/**
 * Every visible finding on the P0-P4 ladder, across every review this viewer
 * may currently see at this gate.
 *
 * Findings live only inside a `Review` (`GateReviewState.visibleReviews`,
 * the same endpoint ReviewPanel calls); a sealed review is not in that list at
 * all, so a finding that belongs to one is never shown here either — blindness
 * covers findings the same way it covers the review that carries them,
 * without this panel having to know anything about sealing itself.
 */
export function FindingsPanel({ cardId, gateId, onAdjudicated }: FindingsPanelProps) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [builderOrgAgentId, setBuilderOrgAgentId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    Promise.all([getReviewState(cardId, gateId), getAssignments(cardId, gateId)]).then(([state, assignments]) => {
      if (cancelled) return;
      const visible = state.visibleReviews
        .flatMap((review) => review.findings)
        .slice()
        .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));
      setFindings(visible);
      setBuilderOrgAgentId(assignments.find((assignment) => assignment.role === 'builder')?.orgAgentId ?? null);
      setLoadState('ready');
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setLoadError(reason instanceof Error ? reason.message : 'Unable to load findings');
      setLoadState('error');
    });
    return () => { cancelled = true; };
  }, [cardId, gateId]);

  return (
    <div className="findings-panel">
      {loadState === 'loading' && <p className="detail-empty">Loading findings…</p>}
      {loadState === 'error' && <p className="form-error" role="alert">{loadError}</p>}
      {loadState === 'ready' && (
        findings.length === 0 ? (
          <p className="detail-empty">No findings are visible yet.</p>
        ) : (
          <ul className="finding-list">
            {findings.map((finding) => (
              <FindingRow
                builderOrgAgentId={builderOrgAgentId}
                finding={finding}
                gateId={gateId}
                key={finding.id}
                onAdjudicated={onAdjudicated}
              />
            ))}
          </ul>
        )
      )}
    </div>
  );
}
