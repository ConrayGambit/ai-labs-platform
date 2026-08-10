import type Database from 'better-sqlite3';
import type { Portfolio } from '../shared/platform.js';

type PortfolioRow = {
  id: string; name: string; owner_user_id: string; created_at: string; updated_at: string;
};

const mapPortfolio = (row: PortfolioRow): Portfolio => ({
  id: row.id,
  name: row.name,
  ownerUserId: row.owner_user_id,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function createDefaultPortfolioRepository(
  connection: Database.Database,
  createPortfolio: (input: { name: string; ownerUserId: string }) => Portfolio,
) {
  // Schema is owned by the migration ledger (0004-platform-foundation).
  const get = (ownerUserId: string): Portfolio | null => {
    const row = connection.prepare(`
      SELECT p.* FROM platform_owner_defaults d
      JOIN platform_portfolios p ON p.id = d.portfolio_id WHERE d.owner_user_id = ?
    `).get(ownerUserId) as PortfolioRow | undefined;
    return row ? mapPortfolio(row) : null;
  };
  const create = connection.transaction((input: { name: string; ownerUserId: string }) => {
    const mapped = get(input.ownerUserId);
    if (mapped) return mapped;
    const row = connection.prepare(`
      SELECT * FROM platform_portfolios WHERE owner_user_id = ? ORDER BY created_at, rowid LIMIT 1
    `).get(input.ownerUserId) as PortfolioRow | undefined;
    const portfolio = row ? mapPortfolio(row) : createPortfolio(input);
    connection.prepare(`
      INSERT INTO platform_owner_defaults (owner_user_id, portfolio_id) VALUES (?, ?)
    `).run(input.ownerUserId, portfolio.id);
    return portfolio;
  });
  return {
    get,
    getOrCreate(input: { name: string; ownerUserId: string }): Portfolio {
      try {
        return create(input);
      } catch (reason) {
        const existing = get(input.ownerUserId);
        if (existing) return existing;
        throw reason;
      }
    },
  };
}
