import { useEffect, useState } from 'react';
import type { P0Escalation } from '../../shared/governance.js';

export interface EscalationBannerProps {
  cardId: string;
}

/**
 * Mirrors `request()` in `src/web/api/client.ts` field for field (verbatim
 * server refusal text, a distinct message when the request never arrived),
 * without adding to that file's route table: this task's own brief lists
 * `GET /api/escalations` as a bare route rather than a named wrapper, the
 * same way Task 7's brief left `POST /api/cards/:cardId/runs` for RunPanel to
 * wrap locally rather than extending client.ts.
 */
async function fetchOpenEscalations(cardId: string): Promise<P0Escalation[]> {
  let response: Response;
  try {
    response = await fetch(`/api/escalations?cardId=${cardId}`);
  } catch (cause) {
    throw new Error('Could not reach the server', { cause });
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  const { escalations } = (await response.json()) as { escalations: P0Escalation[] };
  return escalations;
}

/** Same shape as `fetchOpenEscalations` above, for the one route that clears an escalation. */
async function postResolveEscalation(escalationId: string, resolution: string): Promise<P0Escalation> {
  let response: Response;
  try {
    response = await fetch(`/api/escalations/${escalationId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolution }),
    });
  } catch (cause) {
    throw new Error('Could not reach the server', { cause });
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as P0Escalation;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

interface EscalationRowProps {
  escalation: P0Escalation;
  onResolved: (resolved: P0Escalation) => void;
}

/**
 * One open escalation and its resolve form.
 *
 * The form is never hidden or disabled on a guess about who is asking:
 * `resolveEscalation` (src/server/governance-service.ts) is the one and only
 * place that decides whether this actor is the owner, and it decides by
 * refusing — "Only the owner may resolve a P0 escalation: ... may not" —
 * which this row renders exactly as sent. Predicting that answer here would
 * be the one governance rule this whole task exists not to move into the
 * browser.
 */
function EscalationRow({ escalation, onResolved }: EscalationRowProps) {
  const [resolution, setResolution] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      const resolved = await postResolveEscalation(escalation.id, resolution);
      onResolved(resolved);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to resolve this escalation');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <li className="escalation-row">
      <p className="escalation-meta">
        Raised {formatTimestamp(escalation.raisedAt)} · finding {escalation.findingId}
      </p>
      <div className="escalation-resolve">
        <div className="detail-field">
          <label className="field-label" htmlFor={`resolution-${escalation.id}`}>Resolution</label>
          <textarea
            id={`resolution-${escalation.id}`}
            onChange={(event) => setResolution(event.target.value)}
            rows={2}
            value={resolution}
          />
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button
            className="ghost-button"
            disabled={submitting || resolution.trim().length === 0}
            onClick={() => { void resolve(); }}
            type="button"
          >
            {submitting ? 'Resolving…' : 'Resolve escalation'}
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * The one place Breach Red is allowed to interrupt (DESIGN.md: "the only
 * colour permitted to interrupt").
 *
 * Mounted unconditionally by CardDetailView, independent of the card's
 * current gate: a card carrying an open P0 has already been moved to
 * `blocked` (`escalate`, src/server/governance-service.ts), which clears
 * `gateId` to null (src/server/work-repository.ts's `moveCard`) — so a
 * version of this banner gated on a gate id would go dark on exactly the
 * card it exists to speak for. `cardId` alone is enough.
 *
 * Renders nothing while loading or once confirmed clear: nothing here is
 * "impossible to miss" until there is something to miss. A failed check is
 * still shown — silence on an error would read as "no problem" when the
 * honest answer is "could not tell".
 */
export function EscalationBanner({ cardId }: EscalationBannerProps) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [escalations, setEscalations] = useState<P0Escalation[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    fetchOpenEscalations(cardId).then((result) => {
      if (cancelled) return;
      setEscalations(result);
      setLoadState('ready');
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setLoadError(reason instanceof Error ? reason.message : 'Unable to check for an open P0 escalation');
      setLoadState('error');
    });
    return () => { cancelled = true; };
  }, [cardId]);

  function handleResolved(resolved: P0Escalation): void {
    setEscalations((current) => current.filter((entry) => entry.id !== resolved.id));
  }

  if (loadState === 'error') return <p className="form-error" role="alert">{loadError}</p>;
  if (loadState === 'loading' || escalations.length === 0) return null;

  return (
    <div className="error-banner escalation-banner" role="alert">
      <p className="field-label">P0 escalation</p>
      <p className="escalation-text">This card is stopped. Only the owner can clear it.</p>
      <ul className="escalation-list">
        {escalations.map((escalation) => (
          <EscalationRow escalation={escalation} key={escalation.id} onResolved={handleResolved} />
        ))}
      </ul>
    </div>
  );
}
