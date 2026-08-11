import { useEffect, useState } from 'react';
import { getBoard, type BoardData } from '../api/client.js';
import { columnKeyForCard, type BoardColumn, type GateLadder } from '../../shared/work.js';

export interface CardBoardViewProps {
  projectId: string;
  onOpenCard: (cardId: string) => void;
  /**
   * Bumped by a caller (e.g. after `CardDetailView` reports a successful
   * move) to force a refetch. The board never patches a moved card into a
   * new column locally — that would be the client asserting a position it
   * did not get from the server — it only ever re-asks `getBoard` and
   * renders what comes back.
   */
  refreshToken?: number;
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

export function CardBoardView({ projectId, onOpenCard, refreshToken }: CardBoardViewProps) {
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
    // refreshToken is intentionally in the dependency list with no other use:
    // its only job is to make this effect re-run on demand.
  }, [projectId, refreshToken]);

  // Every card the server sent whose computed column key matches none of the
  // columns the server also sent. Not reachable through today's API — every
  // gate a card can carry is one `deriveColumns` also puts on the board — but
  // a card that fails this check must still be shown, not dropped silently
  // from the board and its counts.
  const unplacedCards = board
    ? board.cards.filter(
      (card) => !board.columns.some((column) => column.key === columnKeyForCard(card, board.ladder)),
    )
    : [];

  return (
    <>
      {loading && <div className="loading-state">Loading board…</div>}
      {error && <div className="error-banner" role="alert">{error}</div>}
      {!loading && !error && board && (
        <>
          {unplacedCards.length > 0 && (
            <div className="error-banner board-unplaced" role="alert">
              <strong>
                {unplacedCards.length} card{unplacedCards.length === 1 ? '' : 's'} match no column
                on this board:
              </strong>
              <ul>
                {unplacedCards.map((card) => (
                  <li key={card.id}>
                    <button onClick={() => onOpenCard(card.id)} type="button">{card.title}</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <section aria-label="Card board" className="card-board">
            {board.columns.map((column) => {
              const cardsInColumn = board.cards.filter(
                (card) => columnKeyForCard(card, board.ladder) === column.key,
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
                        aria-label={card.title}
                        className="board-card"
                        key={card.id}
                        onClick={() => onOpenCard(card.id)}
                        type="button"
                      >
                        <span className={`priority priority-${card.priority}`}>{card.priority}</span>
                        <span className="board-card-title">{card.title}</span>
                        {card.description && (
                          <span className="board-card-description">{card.description}</span>
                        )}
                      </button>
                    ))}
                    {cardsInColumn.length === 0 && <div className="column-empty">No cards</div>}
                  </div>
                </div>
              );
            })}
          </section>
        </>
      )}
    </>
  );
}
