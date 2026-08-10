import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';

describe('platform repository', () => {
  let database: OrchestratorDatabase | undefined;

  afterEach(() => database?.close());

  it('persists an isolated portfolio, venture, project, and audit event', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id,
      name: 'Atlas SaaS',
      kind: 'saas',
      mission: 'Ship a zero-first analytics product.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id,
      name: 'Foundation',
      objective: 'Deliver the first usable release.',
      successCriteria: ['Owner can approve the build plan'],
      constraints: ['Prefer free and open-source services'],
    });

    expect(database.platform.listVentures(portfolio.id)).toEqual([venture]);
    expect(database.platform.listProjects(venture.id)).toEqual([project]);
    expect(database.platform.listEvents(portfolio.id, 20).map((event) => event.type)).toEqual([
      'ProjectCreated',
      'VentureCreated',
      'PortfolioCreated',
    ]);
    expect(database.platform.listEvents(portfolio.id, 20).find(({ type }) => type === 'VentureCreated')?.payload).toEqual({
      name: 'Atlas SaaS', kind: 'saas',
    });
    expect(database.platform.listEvents(portfolio.id, 20).find(({ type }) => type === 'ProjectCreated')?.payload).toEqual({
      name: 'Foundation',
    });
  });

  it('rejects approval IDs that do not match the persisted project hierarchy', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const otherPortfolio = database.platform.createPortfolio({ name: 'Other Labs', ownerUserId: 'other' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id,
      name: 'Atlas',
      kind: 'saas',
      mission: 'Build analytics.',
    });
    const otherVenture = database.platform.createVenture({
      portfolioId: portfolio.id,
      name: 'Nova',
      kind: 'saas',
      mission: 'Build planning tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id,
      name: 'Foundation',
      objective: 'Deliver a release.',
      successCriteria: ['A release is available'],
    });

    expect(() => database.platform.createApproval({
      portfolioId: otherPortfolio.id,
      ventureId: venture.id,
      projectId: project.id,
      summary: 'Activate Foundation.',
    })).toThrow();
    expect(() => database.platform.createApproval({
      portfolioId: portfolio.id,
      ventureId: otherVenture.id,
      projectId: project.id,
      summary: 'Activate Foundation.',
    })).toThrow();
    expect(database.platform.listPendingApprovals(portfolio.id)).toEqual([]);
  });

  it('requires an approved project activation request before activating a project', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id,
      name: 'Atlas',
      kind: 'saas',
      mission: 'Build analytics.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id,
      name: 'Foundation',
      objective: 'Deliver a release.',
      successCriteria: ['A release is available'],
    });
    database.platform.transitionProject(project.id, 'scoping');
    database.platform.transitionProject(project.id, 'pending_approval');
    database.platform.transitionProject(project.id, 'approved');

    expect(() => database.platform.transitionProject(project.id, 'active')).toThrow();
    expect(database.platform.getProject(project.id)?.lifecycle).toBe('approved');

    const approval = database.platform.createApproval({
      portfolioId: portfolio.id,
      ventureId: venture.id,
      projectId: project.id,
      summary: 'Activate Foundation.',
    });
    database.platform.decideApproval({
      approvalId: approval.id,
      status: 'approved',
      decidedByUserId: 'owner',
    });

    expect(database.platform.transitionProject(project.id, 'active')).toMatchObject({ lifecycle: 'active' });
  });
});
