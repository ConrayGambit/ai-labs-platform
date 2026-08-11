import { useEffect, useId, useRef, useState } from 'react';
import { ModalDialog } from '../components/ModalDialog.js';
import {
  getBoard,
  getCard,
  getSpecification,
  moveCard,
  putNotes,
  type CardDetail,
} from '../api/client.js';
import { SPECIFICATION_SECTIONS, type CardSpecification } from '../../shared/governance.js';
import type { BoardColumn, BoardColumnKey } from '../../shared/work.js';
import { EscalationBanner } from './EscalationBanner.js';
import { FindingsPanel } from './FindingsPanel.js';
import { ReviewPanel } from './ReviewPanel.js';
import { RunPanel } from './RunPanel.js';

export interface CardDetailViewProps {
  cardId: string;
  onClose: () => void;
  /**
   * Called after a move this dialog made actually lands on the server. The
   * board this card came from has no way to know its own data is stale
   * otherwise — it fetched once, on mount, and a move happening inside this
   * dialog is invisible to it. This view does not refetch the board itself;
   * it only reports that a move succeeded and lets the caller decide what,
   * if anything, needs a fresh fetch.
   */
  onMoved?: () => void;
}

/** `acceptance_criteria` -> `Acceptance criteria`. Used for section keys, activity kinds, and artifact kinds alike — all snake_case identifiers naming what follows. */
function humanize(key: string): string {
  const spaced = key.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function CardDetailView({ cardId, onClose, onMoved }: CardDetailViewProps) {
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<CardDetail | null>(null);
  const [specification, setSpecification] = useState<CardSpecification | null>(null);
  const [columns, setColumns] = useState<BoardColumn[]>([]);

  const [notesDraft, setNotesDraft] = useState('');
  const [notesState, setNotesState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [notesError, setNotesError] = useState<string | null>(null);

  const [moveTarget, setMoveTarget] = useState('');
  const [moveState, setMoveState] = useState<'idle' | 'moving' | 'moved' | 'error'>('idle');
  const [moveError, setMoveError] = useState<string | null>(null);

  const titleId = useId();
  const notesFieldId = useId();
  const moveFieldId = useId();

  // The "Saved ✓" / "Moved ✓" labels reset themselves after a couple of
  // seconds; tracked in refs so a save or move triggered right before the
  // dialog closes doesn't fire a setState after this component has unmounted.
  const notesResetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const moveResetTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadState('loading');
    setLoadError(null);
    getCard(cardId).then(async (cardDetail) => {
      // The specification and the board are two more routes, fetched only
      // once the card itself names the project they belong to.
      const [spec, board] = await Promise.all([
        getSpecification(cardId),
        getBoard(cardDetail.card.projectId),
      ]);
      if (cancelled) return;
      setDetail(cardDetail);
      setSpecification(spec);
      setColumns(board.columns);
      setNotesDraft(cardDetail.card.ownerNotes);
      setLoadState('ready');
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setLoadError(reason instanceof Error ? reason.message : 'Unable to load the card');
      setLoadState('error');
    });
    return () => { cancelled = true; };
  }, [cardId]);

  useEffect(() => {
    return () => {
      if (notesResetTimeout.current) clearTimeout(notesResetTimeout.current);
      if (moveResetTimeout.current) clearTimeout(moveResetTimeout.current);
    };
  }, []);

  async function saveNotes(): Promise<void> {
    setNotesState('saving');
    setNotesError(null);
    try {
      const updated = await putNotes(cardId, notesDraft);
      setDetail((current) => (current ? { ...current, card: updated } : current));
      setNotesState('saved');
      if (notesResetTimeout.current) clearTimeout(notesResetTimeout.current);
      notesResetTimeout.current = setTimeout(() => setNotesState('idle'), 2000);
    } catch (reason) {
      setNotesError(reason instanceof Error ? reason.message : 'Unable to save notes');
      setNotesState('error');
    }
  }

  // The gate is enforced by the server, never predicted here: this always
  // attempts the move and renders whatever POST /api/cards/:cardId/move
  // answers, refusal included, in the server's own words.
  async function moveToColumn(): Promise<void> {
    if (!moveTarget) return;
    setMoveState('moving');
    setMoveError(null);
    try {
      // 0 rather than an end-of-column count: this is a manual move, not a
      // drop at a measured index, and landing at the top makes the result of
      // the action immediately visible without scrolling the destination.
      const updated = await moveCard(cardId, moveTarget as BoardColumnKey, 0);
      setDetail((current) => (current ? { ...current, card: updated } : current));
      setMoveTarget('');
      setMoveState('moved');
      if (moveResetTimeout.current) clearTimeout(moveResetTimeout.current);
      moveResetTimeout.current = setTimeout(() => setMoveState('idle'), 2000);
      // The board this card came from fetched once, on mount, and has no
      // other way to learn its data is now stale.
      onMoved?.();
    } catch (reason) {
      setMoveError(reason instanceof Error ? reason.message : 'Unable to move the card');
      setMoveState('error');
    }
  }

  // The run this dialog opens showing: whichever is still running, else the
  // one most recently started (`listRunsForCard` orders by `started_at`, so
  // the last element is the newest — src/server/run-repository.ts), else
  // none. A card runs at most one agent turn at a time in practice, but this
  // does not assume that — it is a preference order over whatever the server
  // actually sent, not a count.
  const currentRun = detail
    ? detail.runs.find((candidate) => candidate.status === 'running')
      ?? detail.runs[detail.runs.length - 1]
      ?? null
    : null;

  return (
    <ModalDialog labelledBy={titleId} onClose={onClose}>
      <div className="dialog-heading">
        <div>
          <p className="eyebrow">Card</p>
          <h2 id={titleId}>{detail?.card.title ?? 'Card'}</h2>
        </div>
        <button aria-label="Close" className="icon-button" onClick={onClose} type="button">×</button>
      </div>
      <div className="card-detail-body">
        {loadState === 'loading' && <div className="loading-state">Loading card…</div>}
        {loadState === 'error' && <div className="error-banner" role="alert">{loadError}</div>}
        {loadState === 'ready' && detail && (
          <>
            {/*
              Unconditional, and first: a card carrying an open P0 has already
              been moved to 'blocked', which clears gateId to null
              (src/server/work-repository.ts's moveCard) — gating this on the
              gate the way Review/Findings below are gated would hide it on
              exactly the card it exists to speak for. It renders nothing of
              its own when there is nothing to say.
            */}
            <EscalationBanner cardId={cardId} />

            <div className="detail-meta">
              <span className={`status-dot status-${detail.card.status}`} />
              <span className="detail-status-label">{humanize(detail.card.status)}</span>
              <span className={`priority priority-${detail.card.priority}`}>{detail.card.priority}</span>
              {detail.card.status === 'review' && detail.card.gateId && (
                <span className="card-pill">{detail.card.gateId}</span>
              )}
            </div>

            <section className="detail-section">
              <h3 className="detail-heading">Description</h3>
              {detail.card.description
                ? <p className="detail-prose">{detail.card.description}</p>
                : <p className="detail-empty">No description provided.</p>}
            </section>

            <section className="detail-section">
              <h3 className="detail-heading">Owner notes</h3>
              <div className="detail-field">
                <label className="field-label" htmlFor={notesFieldId}>Owner notes</label>
                <textarea
                  id={notesFieldId}
                  onChange={(event) => setNotesDraft(event.target.value)}
                  rows={4}
                  value={notesDraft}
                />
              </div>
              {notesError && <p className="form-error" role="alert">{notesError}</p>}
              <div className="dialog-actions">
                <button
                  className="ghost-button"
                  disabled={notesState === 'saving'}
                  onClick={() => { void saveNotes(); }}
                  type="button"
                >
                  {notesState === 'saving' ? 'Saving…' : notesState === 'saved' ? 'Saved ✓' : 'Save notes'}
                </button>
              </div>
            </section>

            <section className="detail-section">
              <h3 className="detail-heading">Move</h3>
              <div className="detail-field">
                <label className="field-label" htmlFor={moveFieldId}>Move to</label>
                <select
                  id={moveFieldId}
                  onChange={(event) => setMoveTarget(event.target.value)}
                  value={moveTarget}
                >
                  {/* Every column the server sent, including the card's current one:
                      this view does not decide which destinations make sense, the
                      server does, on submit. Withholding an option here would be
                      exactly the client-side gate judgement this surface exists
                      to avoid. */}
                  <option value="">Choose a column…</option>
                  {columns.map((column) => (
                    <option key={column.key} value={column.key}>{column.label}</option>
                  ))}
                </select>
              </div>
              {moveError && <p className="form-error" role="alert">{moveError}</p>}
              <div className="dialog-actions">
                <button
                  className="primary-button"
                  disabled={!moveTarget || moveState === 'moving'}
                  onClick={() => { void moveToColumn(); }}
                  type="button"
                >
                  {moveState === 'moving' ? 'Moving…' : moveState === 'moved' ? 'Moved ✓' : 'Move'}
                </button>
              </div>
            </section>

            {/*
              Meaningful only while the card sits at a gate (Card.gateId is
              null otherwise — src/shared/work.ts). Unlike EscalationBanner
              above, there is no route that takes just a cardId here: both
              endpoints these panels call are keyed by cardId AND gateId, so
              there is nothing to fetch without one.
            */}
            {detail.card.gateId && (
              <>
                <section className="detail-section">
                  <h3 className="detail-heading">Review</h3>
                  <ReviewPanel cardId={cardId} gateId={detail.card.gateId} />
                </section>

                <section className="detail-section">
                  <h3 className="detail-heading">Findings</h3>
                  <FindingsPanel
                    assigneeOrgAgentId={detail.card.assigneeOrgAgentId}
                    cardId={cardId}
                    gateId={detail.card.gateId}
                  />
                </section>
              </>
            )}

            <section className="detail-section">
              <h3 className="detail-heading">Run</h3>
              <RunPanel
                assigneeOrgAgentId={detail.card.assigneeOrgAgentId}
                cardId={cardId}
                run={currentRun}
                runId={currentRun?.id ?? null}
              />
            </section>

            <section className="detail-section">
              <h3 className="detail-heading">Specification</h3>
              <dl className="spec-list">
                {SPECIFICATION_SECTIONS.map((key) => {
                  const value = specification?.sections[key]?.trim();
                  return (
                    <div className="spec-row" key={key}>
                      <dt className="field-label">{humanize(key)}</dt>
                      <dd>{value ? value : <span className="card-pill">Missing</span>}</dd>
                    </div>
                  );
                })}
              </dl>
            </section>

            <section className="detail-section">
              <h3 className="detail-heading">Activity</h3>
              {detail.activity.length === 0 ? (
                <p className="detail-empty">No activity recorded.</p>
              ) : (
                <ul className="activity-list">
                  {detail.activity.map((entry) => (
                    <li className="activity-row" key={entry.id}>
                      <span className="card-pill">{humanize(entry.kind)}</span>
                      <span className="activity-detail">{entry.detail || '—'}</span>
                      <span className="activity-meta">
                        {humanize(entry.actorType)}{entry.actorId ? ` · ${entry.actorId}` : ''} · {formatTimestamp(entry.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="detail-section">
              <h3 className="detail-heading">Artifacts</h3>
              {detail.artifacts.length === 0 ? (
                <p className="detail-empty">No artifacts attached.</p>
              ) : (
                <ul className="artifact-list">
                  {detail.artifacts.map((artifact) => (
                    <li className="artifact-row" key={artifact.id}>
                      <span className="card-pill">{humanize(artifact.kind)}</span>
                      <span className="artifact-label">{artifact.label}</span>
                      <span className="artifact-location">{artifact.location}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </ModalDialog>
  );
}
