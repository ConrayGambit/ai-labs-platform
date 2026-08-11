import { useEffect, useState } from 'react';
import { getReviewState } from '../api/client.js';
import type { Finding, FindingPriority, OverrideEntry, Ruling, RulingOutcome } from '../../shared/governance.js';
import type { GateId } from '../../shared/work.js';

export interface FindingsPanelProps {
  cardId: string;
  gateId: GateId;
  /**
   * `Card.assigneeOrgAgentId` — the same field RunPanel takes under the same
   * name for "who a run started from here runs as". Here it seeds
   * `ruledByOrgAgentId` on an adjudication. The server is the only authority
   * on whether this identity actually holds the builder assignment at this
   * gate — it refuses otherwise ("Only the builder at G1 may adjudicate: ...
   * is not it"), rendered verbatim below. This prop is a convenience default,
   * never a rule.
   */
  assigneeOrgAgentId: string | null;
}

/**
 * Mirrors `AdjudicationResult` (src/server/governance-service.ts) field for
 * field. That type lives in server code and client code may only import from
 * src/shared/, so it is redeclared here from the shared `Ruling` and
 * `OverrideEntry` types the server shape is actually built from — the same
 * technique `RunSummary` uses in src/web/api/client.ts.
 */
interface AdjudicateResult {
  ruling: Ruling;
  registerEntry: OverrideEntry | null;
}

/** Hardest first. Presentation order only — the ladder's own meaning lives entirely server-side. */
const PRIORITY_ORDER: readonly FindingPriority[] = ['P0', 'P1', 'P2', 'P3', 'P4'];

/**
 * Mirrors `request()` in `src/web/api/client.ts` field for field, without
 * adding to that file's route table: this task's brief lists
 * `POST /api/findings/:findingId/adjudicate` as a bare route, the same way
 * Task 7's brief left the run-start route for RunPanel to wrap locally.
 */
async function postAdjudicate(findingId: string, input: {
  gateId: GateId;
  outcome: RulingOutcome;
  reason: string;
  nextStep: string;
  deferredUntil: string;
  residualRisk: string;
  ruledByOrgAgentId: string;
}): Promise<AdjudicateResult> {
  let response: Response;
  try {
    response = await fetch(`/api/findings/${findingId}/adjudicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gateId: input.gateId,
        outcome: input.outcome,
        reason: input.reason,
        // Sent only once actually written: the schema (adjudicateSchema,
        // src/server/governance-api.ts) treats these as optional, and an
        // absent field is what "not filled in" should mean on the wire —
        // not an empty string masquerading as one.
        ...(input.nextStep.trim() ? { nextStep: input.nextStep.trim() } : {}),
        ...(input.deferredUntil.trim() ? { deferredUntil: input.deferredUntil.trim() } : {}),
        ...(input.residualRisk.trim() ? { residualRisk: input.residualRisk.trim() } : {}),
        ruledByOrgAgentId: input.ruledByOrgAgentId,
      }),
    });
  } catch (cause) {
    throw new Error('Could not reach the server', { cause });
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as AdjudicateResult;
}

interface FindingRowProps {
  finding: Finding;
  gateId: GateId;
  ruledByOrgAgentId: string | null;
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
 * outcome.
 */
function FindingRow({ finding, gateId, ruledByOrgAgentId }: FindingRowProps) {
  const [reason, setReason] = useState('');
  const [nextStep, setNextStep] = useState('');
  const [deferredUntil, setDeferredUntil] = useState('');
  const [residualRisk, setResidualRisk] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AdjudicateResult | null>(null);

  async function submit(outcome: RulingOutcome): Promise<void> {
    if (!ruledByOrgAgentId) return;
    setSubmitting(true);
    setError(null);
    try {
      const adjudicated = await postAdjudicate(finding.id, {
        gateId, outcome, reason, nextStep, deferredUntil, residualRisk,
        ruledByOrgAgentId,
      });
      setResult(adjudicated);
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
  // regardless of outcome (z.string().trim().min(1)); identity is required
  // to attribute the call to anyone at all. Neither is a rule about whether
  // THIS finding may be adjudicated this way — only the server decides that.
  const canSubmit = Boolean(ruledByOrgAgentId) && reason.trim().length > 0 && !submitting;

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
      {!ruledByOrgAgentId && (
        <p className="run-note">Assign an agent to this card before findings can be adjudicated.</p>
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
export function FindingsPanel({ cardId, gateId, assigneeOrgAgentId }: FindingsPanelProps) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    getReviewState(cardId, gateId).then((state) => {
      if (cancelled) return;
      const visible = state.visibleReviews
        .flatMap((review) => review.findings)
        .slice()
        .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));
      setFindings(visible);
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
              <FindingRow finding={finding} gateId={gateId} key={finding.id} ruledByOrgAgentId={assigneeOrgAgentId} />
            ))}
          </ul>
        )
      )}
    </div>
  );
}
