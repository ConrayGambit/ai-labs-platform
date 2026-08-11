import { useEffect, useId, useState } from 'react';
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
import type { BoardColumn, BoardColumnKey, Card } from '../../shared/work.js';

export interface CardDetailViewProps {
  cardId: string;
  onClose: () => void;
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

/**
 * Which column a card currently sits in, so the move control can offer every
 * *other* column. The same status/gateId mapping as CardBoardView's
 * `columnKeyForCard` — kept local rather than imported across the two view
 * files, since it is three lines and the two files are independently tested.
 */
function currentColumnKey(card: Pick<Card, 'status' | 'gateId'>): BoardColumnKey {
  if (card.status !== 'review') return card.status;
  return card.gateId ?? 'backlog';
}

export function CardDetailView({ cardId, onClose }: CardDetailViewProps) {
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

  async function saveNotes(): Promise<void> {
    setNotesState('saving');
    setNotesError(null);
    try {
      const updated = await putNotes(cardId, notesDraft);
      setDetail((current) => (current ? { ...current, card: updated } : current));
      setNotesState('saved');
      setTimeout(() => setNotesState('idle'), 2000);
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
      setTimeout(() => setMoveState('idle'), 2000);
    } catch (reason) {
      setMoveError(reason instanceof Error ? reason.message : 'Unable to move the card');
      setMoveState('error');
    }
  }

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
                  <option value="">Choose a column…</option>
                  {columns
                    .filter((column) => column.key !== currentColumnKey(detail.card))
                    .map((column) => (
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
