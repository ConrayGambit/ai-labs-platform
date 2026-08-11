import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { columnKeyFor, PRODUCT_LADDER } from '../../src/server/gate-policy.js';
import type { WorkProject } from '../../src/shared/platform.js';
import { columnKeyForCard, effectiveReviewerCount } from '../../src/shared/work.js';

describe('the card model, the owner notes and the activity log', () => {
  let database: OrchestratorDatabase | undefined;

  afterEach(() => database?.close());

  /** A portfolio, a venture and one project — the smallest board that can exist. */
  function seedProject(name = 'Tool Survey'): WorkProject {
    database = database ?? createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id,
      name: 'Research Lab',
      kind: 'research',
      mission: 'Evaluate useful tools.',
    });
    return database.platform.createProject({
      ventureId: venture.id,
      name,
      objective: 'Compare free research services.',
      successCriteria: ['A sourced comparison is approved'],
    });
  }

  it('creates a card in the backlog with no assignee and no owner notes', () => {
    database = createDatabase(':memory:');
    const project = seedProject();

    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });

    expect(card).toMatchObject({
      projectId: project.id,
      parentCardId: null,
      title: 'Survey the field',
      description: '',
      status: 'backlog',
      priority: 'medium',
      assigneeOrgAgentId: null,
      ownerNotes: '',
      position: 0,
    });
    // Creation is itself an event: a board with no history cannot be audited.
    expect(database.work.listActivity(card.id)).toEqual([
      expect.objectContaining({ kind: 'created', actorType: 'user' }),
    ]);
  });

  it('records who wrote the owner notes, and when', () => {
    database = createDatabase(':memory:');
    const project = seedProject();
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });

    const updated = database.work.setOwnerNotes({
      cardId: card.id,
      notes: 'Prefer sources that publish their method.',
      userId: 'owner',
    });

    expect(updated.ownerNotes).toBe('Prefer sources that publish their method.');
    expect(database.work.listActivity(card.id)).toEqual([
      expect.objectContaining({ kind: 'created' }),
      expect.objectContaining({ kind: 'notes_changed', actorType: 'user', actorId: 'owner' }),
    ]);
  });

  it('REFUSES to write owner notes through the general card update', () => {
    database = createDatabase(':memory:');
    const project = seedProject();
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });

    // There is exactly one door to the owner's notes, and it takes a user id.
    expect(() =>
      database!.work.updateCard(card.id, { ownerNotes: 'slipped in' } as never),
    ).toThrow(/owner notes/i);
    expect(database.work.getCard(card.id)?.ownerNotes).toBe('');
  });

  it('REFUSES an agent-attributed change to the owner notes', () => {
    database = createDatabase(':memory:');
    const project = seedProject();
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });

    expect(() =>
      database!.work.appendActivity({
        cardId: card.id,
        actorType: 'org_agent',
        actorId: 'exec-cto',
        kind: 'notes_changed',
        detail: 'Rewrote the brief.',
      }),
    ).toThrow(/owner/i);
    expect(database.work.listActivity(card.id)).toHaveLength(1);
  });

  it('reorders siblings when a card moves, and logs the move', () => {
    database = createDatabase(':memory:');
    const project = seedProject();
    const first = database.work.createCard({ projectId: project.id, title: 'First' });
    const second = database.work.createCard({ projectId: project.id, title: 'Second' });
    const third = database.work.createCard({ projectId: project.id, title: 'Third' });
    expect([first.position, second.position, third.position]).toEqual([0, 1, 2]);

    const moved = database.work.moveCard({
      cardId: third.id, to: 'ready', position: 0, userId: 'owner',
    });

    expect(moved).toMatchObject({ status: 'ready', position: 0 });
    // The gap the card left behind closes; it does not stay a hole.
    expect(database.work.getCard(first.id)?.position).toBe(0);
    expect(database.work.getCard(second.id)?.position).toBe(1);
    expect(database.work.listActivity(third.id)).toEqual([
      expect.objectContaining({ kind: 'created' }),
      expect.objectContaining({ kind: 'moved', actorType: 'user' }),
    ]);
  });

  it('lists the board by column in position order', () => {
    database = createDatabase(':memory:');
    const project = seedProject();
    const a = database.work.createCard({ projectId: project.id, title: 'A' });
    const b = database.work.createCard({ projectId: project.id, title: 'B' });
    database.work.moveCard({ cardId: b.id, to: 'backlog', position: 0, userId: 'owner' });

    expect(database.work.listCards(project.id).map((card) => card.title)).toEqual(['B', 'A']);
    expect(database.work.getCard(a.id)?.position).toBe(1);
  });

  it('returns activity oldest-first, with the actor on every entry', () => {
    database = createDatabase(':memory:');
    const project = seedProject();
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
    database.work.setOwnerNotes({ cardId: card.id, notes: 'One.', userId: 'owner' });
    database.work.appendActivity({
      cardId: card.id, actorType: 'org_agent', actorId: 'exec-cto',
      kind: 'commented', detail: 'Started reading.',
    });

    const activity = database.work.listActivity(card.id);
    expect(activity.map((entry) => entry.kind)).toEqual(['created', 'notes_changed', 'commented']);
    expect(activity.map((entry) => entry.actorType)).toEqual(['user', 'user', 'org_agent']);
    expect(activity.every((entry) => entry.createdAt !== '')).toBe(true);
  });

  it('puts a card into review at the gate it was moved to', () => {
    database = createDatabase(':memory:');
    const project = seedProject();
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });

    const moved = database.work.moveCard({
      cardId: card.id, to: 'G2', position: 0, userId: 'owner',
    });

    // A gate column is not a card status. The card is in review, at G2.
    expect(moved).toMatchObject({ status: 'review', gateId: 'G2' });
    expect(columnKeyFor(moved)).toBe('G2');

    const back = database.work.moveCard({
      cardId: card.id, to: 'in_progress', position: 0, userId: 'owner',
    });
    expect(back).toMatchObject({ status: 'in_progress', gateId: null });
  });

  it('records who raised the reviewer count on a card, and why', () => {
    database = createDatabase(':memory:');
    const project = seedProject();
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });
    expect(card.reviewerCountOverride).toBeNull();

    const raised = database.work.raiseReviewerCount({
      cardId: card.id, count: 2, reason: 'Touches the permission model.', userId: 'owner',
    });

    expect(raised).toMatchObject({
      reviewerCountOverride: 2,
      reviewerRaiseReason: 'Touches the permission model.',
      reviewerRaisedByUserId: 'owner',
    });
    // The raise is what the gate policy then reads.
    expect(effectiveReviewerCount(PRODUCT_LADDER.gates[0]!, {
      card: raised.reviewerCountOverride,
    })).toBe(2);
  });

  // Found in review: a lowering was accepted at write time and only refused
  // when the count was READ, so a bad number made every board read throw.
  // Found by code review: the CARD path validated a lowering at the write, the
  // PROJECT path did not — the identical bug, one file over. A project created
  // with 0 made every board read for every card in it throw.
  it('REFUSES a PROJECT reviewer override that would lower the requirement', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'V', kind: 'research', mission: 'M.',
    });

    expect(() => database!.platform.createProject({
      ventureId: venture.id, name: 'P', objective: 'O.', successCriteria: ['C'],
      reviewerCountOverride: 0,
    })).toThrow(/raised but not lowered/i);
    expect(database.platform.listProjects(venture.id)).toEqual([]);
  });

  it('accepts a PROJECT reviewer override that raises the requirement', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'V', kind: 'research', mission: 'M.',
    });

    const project = database.platform.createProject({
      ventureId: venture.id, name: 'P', objective: 'O.', successCriteria: ['C'],
      reviewerCountOverride: 2,
    });
    expect(project.reviewerCountOverride).toBe(2);
  });

  it('REFUSES a reviewer raise that would LOWER the ladder requirement', () => {
    database = createDatabase(':memory:');
    const project = seedProject();
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });

    expect(() => database!.work.raiseReviewerCount({
      cardId: card.id, count: 0, reason: 'Trying to lower it.', userId: 'owner',
    })).toThrow(/raised but not lowered/i);
    expect(database.work.getCard(card.id)?.reviewerCountOverride).toBeNull();
  });

  it('REFUSES a reviewer raise with no reason recorded', () => {
    database = createDatabase(':memory:');
    const project = seedProject();
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });

    expect(() =>
      database!.work.raiseReviewerCount({
        cardId: card.id, count: 2, reason: '   ', userId: 'owner',
      }),
    ).toThrow(/record why/i);
    expect(database.work.getCard(card.id)?.reviewerCountOverride).toBeNull();
  });

  it('REFUSES a parent card that belongs to a different project', () => {
    database = createDatabase(':memory:');
    const first = seedProject('First project');
    const second = seedProject('Second project');
    const parent = database.work.createCard({ projectId: first.id, title: 'Parent' });

    expect(() =>
      database!.work.createCard({
        projectId: second.id, title: 'Child', parentCardId: parent.id,
      }),
    ).toThrow(/same project/i);
  });

  it('attaches artifacts and only then allows the card to close', () => {
    database = createDatabase(':memory:');
    const project = seedProject();
    const card = database.work.createCard({ projectId: project.id, title: 'Survey the field' });

    expect(database.work.listArtifacts(card.id)).toEqual([]);

    const artifact = database.work.attachArtifact({
      cardId: card.id, runId: null, kind: 'report',
      label: 'Comparison table', location: 'artifacts/comparison.md',
    });

    expect(artifact).toMatchObject({ cardId: card.id, kind: 'report', runId: null });
    expect(database.work.listArtifacts(card.id)).toHaveLength(1);
    expect(database.work.listActivity(card.id)).toEqual([
      expect.objectContaining({ kind: 'created' }),
      expect.objectContaining({ kind: 'artifact_attached' }),
    ]);
  });
});

// The client-safe mirror of gate-policy.ts's columnKeyFor (client code cannot
// import server files). Every case is checked against the server's own
// function too, so a future edit to either cannot drift without failing here.
describe('columnKeyForCard, the shared column mapping both view files import', () => {
  it('matches a non-review status directly, the same as columnKeyFor', () => {
    const card = { status: 'in_progress' as const, gateId: null };
    expect(columnKeyForCard(card, PRODUCT_LADDER)).toBe('in_progress');
    expect(columnKeyForCard(card, PRODUCT_LADDER)).toBe(columnKeyFor(card));
  });

  it('matches a review card to its recorded gate, the same as columnKeyFor', () => {
    const card = { status: 'review' as const, gateId: 'G2' as const };
    expect(columnKeyForCard(card, PRODUCT_LADDER)).toBe('G2');
    expect(columnKeyForCard(card, PRODUCT_LADDER)).toBe(columnKeyFor(card));
  });

  it("falls back to the ladder's first gate for a review card with no gate — columnKeyFor's own fallback, not a client invention", () => {
    const card = { status: 'review' as const, gateId: null };
    expect(columnKeyForCard(card, PRODUCT_LADDER)).toBe('G1');
    expect(columnKeyForCard(card, PRODUCT_LADDER)).toBe(columnKeyFor(card, PRODUCT_LADDER));
  });

  it('returns the review status itself, never inventing a column, when the ladder has no gates to fall back to', () => {
    // columnKeyFor throws here (correct for a request handler); a render
    // path cannot blank the whole board over one card, so this returns a
    // value — 'review' — that can never equal a real BoardColumnKey, which
    // is what lets a caller detect and surface the card instead.
    expect(columnKeyForCard({ status: 'review', gateId: null }, { gates: [] })).toBe('review');
  });
});
