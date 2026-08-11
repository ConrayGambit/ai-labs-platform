import { useEffect, useState } from 'react';
import { getOverrides } from '../api/client.js';
import type { OverrideEntry } from '../../shared/governance.js';

export interface OverrideRegisterViewProps {
  /** Scopes the register to one card, mirroring `getOverrides`'s own signature. Omitted shows every venture this actor can reach. */
  cardId?: string;
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * One entry in the register.
 *
 * Read-only, deliberately: the register is append-only
 * (src/server/governance-repository.ts — "there is deliberately no update and
 * no delete") and a correction is a new entry that supersedes the old one, not
 * an edit to it. There is no edit affordance anywhere in this row, on
 * purpose — one would misrepresent a record that the platform itself refuses
 * to let anyone rewrite. A superseded entry stays exactly as filed, and is
 * only ever marked, never altered.
 */
function OverrideRow({ entry }: { entry: OverrideEntry }) {
  return (
    <li className="override-row">
      <div className="override-row-head">
        <span className="card-pill">{entry.reference}</span>
        <span className={entry.priority === 'P0' ? 'card-pill finding-priority-p0' : 'card-pill'}>
          {entry.priority}
        </span>
        {entry.supersededById !== null && <span className="card-pill">Superseded</span>}
        <span className="activity-meta">{formatTimestamp(entry.createdAt)}</span>
      </div>
      <p className="detail-prose">{entry.reason}</p>
      {entry.residualRisk && <p className="detail-prose">Residual risk: {entry.residualRisk}</p>}
      {entry.deferredUntil && <p className="detail-prose">Deferred until: {entry.deferredUntil}</p>}
      {entry.supersedesId && <p className="detail-prose">Supersedes a prior entry.</p>}
    </li>
  );
}

/**
 * The override register: every ruling that went against a reviewer, in
 * sequence, read-only.
 *
 * "Read-only" is not merely "no save button" — it is the absence of any
 * control that could be mistaken for one. A superseded entry renders exactly
 * as it was filed, with only a marker added, because that marker is a fact
 * the platform recorded (`supersededById`), not an edit this view is making.
 */
export function OverrideRegisterView({ cardId }: OverrideRegisterViewProps) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [entries, setEntries] = useState<OverrideEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    getOverrides(cardId).then((result) => {
      if (cancelled) return;
      setEntries(result);
      setLoadState('ready');
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setLoadError(reason instanceof Error ? reason.message : 'Unable to load the override register');
      setLoadState('error');
    });
    return () => { cancelled = true; };
  }, [cardId]);

  return (
    <div className="override-register">
      {loadState === 'loading' && <p className="detail-empty">Loading the override register…</p>}
      {loadState === 'error' && <p className="form-error" role="alert">{loadError}</p>}
      {loadState === 'ready' && (
        entries.length === 0 ? (
          <p className="detail-empty">The register is empty.</p>
        ) : (
          <ul className="override-list">
            {entries.map((entry) => <OverrideRow entry={entry} key={entry.id} />)}
          </ul>
        )
      )}
    </div>
  );
}
