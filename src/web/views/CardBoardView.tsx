import { useEffect, useState } from 'react';
import { getBoard, type BoardData } from '../api/client.js';
import type { BoardColumn, BoardColumnKey, Card, GateLadder } from '../../shared/work.js';

export interface CardBoardViewProps {
  projectId: string;
  onOpenCard: (cardId: string) => void;
}

/**
 * Whether a column is one of the ladder's gates, rather than one of the six
 * fixed lifecycle columns.
 *
 * Reads `ladder.gates` rather than trusting `column.gateId` alone: the ladder
 * is server data this component already has, so cross-checking against it
 * costs nothing, and it keeps this working even where a caller's column
 * carries no `gateId` at all. Never a hardcoded 'G1'..'G4' set — a business
 * ladder has two gates, a product ladder four, and this reads whichever the
 * server actually sent.
 */
function isGateColumn(column: BoardColumn, ladder: GateLadder): boolean {
  return column.gateId != null || ladder.gates.some((gate) => gate.id === column.key);
}

/**
 * Which column a card renders in.
 *
 * Mirrors `columnKeyFor` in `src/server/gate-policy.ts` — server code, so it
 * cannot be imported here (client code may import from `src/shared` only).
 * A card in review always carries the gate it is at; falling back to
 * 'backlog' rather than throwing on the rare data that does not is the same
 * don't-vanish choice the server makes, adapted for a render path where
 * throwing would blank the whole board over one card.
 */
function columnKeyForCard(card: Pick<Card, 'status' | 'gateId'>): BoardColumnKey {
  if (card.status !== 'review') return card.status;
  return card.gateId ?? 'backlog';
}

export function CardBoardView({ projectId, onOpenCard }: CardBoardViewProps) {
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getBoard(projectId).then((data) => {
      if (cancelled) return;
      setBoard(data);
      setLoading(false);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : 'Unable to load the board');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [projectId]);

  return (
    <>
      {loading && <div className="loading-state">Loading board…</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {!loading && !error && board && (
        <section aria-label="Card board" className="card-board">
          {board.columns.map((column) => {
            const cardsInColumn = board.cards.filter(
              (card) => columnKeyForCard(card) === column.key,
            );
            const dotModifier = isGateColumn(column, board.ladder) ? 'review' : column.key;
            return (
              <div className="card-board-column" data-column-key={column.key} key={column.key}>
                <div className="column-heading">
                  <span className={`status-dot status-${dotModifier}`} />
                  <h2>{column.label}</h2>
                  <span className="count-badge">{cardsInColumn.length}</span>
                </div>
                <div className="board-card-stack">
                  {cardsInColumn.map((card) => (
                    <button
                      className="board-card"
                      key={card.id}
                      onClick={() => onOpenCard(card.id)}
                      type="button"
                    >
                      <span className={`priority priority-${card.priority}`}>{card.priority}</span>
                      <h3>{card.title}</h3>
                      {card.description && <p>{card.description}</p>}
                    </button>
                  ))}
                  {cardsInColumn.length === 0 && <div className="column-empty">No cards</div>}
                </div>
              </div>
            );
          })}
        </section>
      )}
    </>
  );
}
