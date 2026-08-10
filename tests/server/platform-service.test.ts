import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { createPlatformService } from '../../src/server/platform-service.js';

describe('platform governance service', () => {
  let database: OrchestratorDatabase | undefined;

  afterEach(() => database?.close());

  it('activates a project only after an approved activation request', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id,
      name: 'Research Lab',
      kind: 'research',
      mission: 'Evaluate useful tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id,
      name: 'Tool Survey',
      objective: 'Compare free research services.',
      successCriteria: ['A sourced comparison is approved'],
    });
    const service = createPlatformService(database.platform);

    const submitted = service.submitProjectPlan({
      projectId: project.id,
      summary: 'Zero-first plan with three researched alternatives.',
      requestedByOrgAgentId: null,
    });
    expect(submitted.project.lifecycle).toBe('pending_approval');
    expect(() => database!.platform.transitionProject(project.id, 'active')).toThrow(
      /invalid project lifecycle transition/i,
    );

    const decided = service.decideProjectApproval({
      approvalId: submitted.approval.id,
      status: 'approved',
      decisionNote: 'Proceed.',
    });
    expect(decided.project.lifecycle).toBe('active');
    expect(database.platform.listEvents(portfolio.id, 1)[0]).toMatchObject({
      type: 'ProjectActivated',
      actorId: 'owner',
      payload: { approvalId: submitted.approval.id },
    });
  });

  it('records a redacted plan submission after moving a draft through scoping', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.', successCriteria: ['Comparison'],
    });

    const submitted = createPlatformService(database.platform).submitProjectPlan({
      projectId: project.id,
      summary: 'Vendor pricing and credentials belong in this plan.',
      requestedByOrgAgentId: 'research-lead',
    });

    expect(submitted.project.lifecycle).toBe('pending_approval');
    const events = database.platform.listEvents(portfolio.id, 10);
    expect(events[0]).toMatchObject({
      type: 'ProjectPlanSubmitted',
      actorType: 'org_agent',
      actorId: 'research-lead',
      payload: { approvalId: submitted.approval.id },
    });
    expect(events.map((event) => event.type)).toContain('ProjectLifecycleChanged');
  });

  it('returns a rejected project to scoping and rejects a second decision', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.', successCriteria: ['Comparison'],
    });
    const service = createPlatformService(database.platform);
    const submitted = service.submitProjectPlan({
      projectId: project.id, summary: 'Zero-first comparison.', requestedByOrgAgentId: null,
    });

    const decided = service.decideProjectApproval({
      approvalId: submitted.approval.id, status: 'rejected', decisionNote: 'Narrow scope.',
    });

    expect(decided.project.lifecycle).toBe('scoping');
    expect(decided.approval).toMatchObject({ status: 'rejected', decidedByUserId: 'owner' });
    expect(database.platform.listEvents(portfolio.id, 10).find(
      ({ type }) => type === 'ApprovalDecided',
    )?.payload).toEqual({ approvalId: submitted.approval.id, status: 'rejected' });
    expect(() => service.decideProjectApproval({
      approvalId: submitted.approval.id, status: 'approved', decisionNote: null,
    })).toThrow('Approval has already been decided');
  });

  it('does not decide an approval when its project is not pending approval', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.', successCriteria: ['Comparison'],
    });
    const approval = database.platform.createApproval({
      portfolioId: portfolio.id, ventureId: venture.id, projectId: project.id, summary: 'Activate this draft.',
    });

    expect(() => createPlatformService(database!.platform).decideProjectApproval({
      approvalId: approval.id, status: 'approved', decisionNote: null,
    })).toThrow(/pending approval/i);
    expect(database.platform.getApproval(approval.id)).toMatchObject({ status: 'pending' });
    expect(database.platform.getProject(project.id)).toMatchObject({ lifecycle: 'draft' });
  });

  it('rolls back a plan submission when its final audit event fails', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.', successCriteria: ['Comparison'],
    });
    const appendEvent = database.platform.appendEvent;
    database.platform.appendEvent = (input) => {
      if (input.type === 'ProjectPlanSubmitted') throw new Error('audit unavailable');
      return appendEvent(input);
    };

    expect(() => createPlatformService(database!.platform).submitProjectPlan({
      projectId: project.id, summary: 'Plan content.', requestedByOrgAgentId: null,
    })).toThrow('audit unavailable');
    expect(database.platform.getProject(project.id)).toMatchObject({ lifecycle: 'draft' });
    expect(database.platform.listPendingApprovals(portfolio.id)).toEqual([]);
    expect(database.platform.listEvents(portfolio.id, 10)).toHaveLength(3);
  });

  it('rolls back an approval decision when activation audit logging fails', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.', successCriteria: ['Comparison'],
    });
    const service = createPlatformService(database.platform);
    const submitted = service.submitProjectPlan({
      projectId: project.id, summary: 'Plan content.', requestedByOrgAgentId: null,
    });
    const appendEvent = database.platform.appendEvent;
    database.platform.appendEvent = (input) => {
      if (input.type === 'ProjectActivated') throw new Error('audit unavailable');
      return appendEvent(input);
    };

    expect(() => service.decideProjectApproval({
      approvalId: submitted.approval.id, status: 'approved', decisionNote: null,
    })).toThrow('audit unavailable');
    expect(database.platform.getProject(project.id)).toMatchObject({ lifecycle: 'pending_approval' });
    expect(database.platform.getApproval(submitted.approval.id)).toMatchObject({ status: 'pending' });
  });

  it('keeps plan content in the approval record but out of audit event payloads', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.', successCriteria: ['Comparison'],
    });
    const secretPlan = 'Do not project this plan to Obsidian.';
    const submitted = createPlatformService(database.platform).submitProjectPlan({
      projectId: project.id, summary: secretPlan, requestedByOrgAgentId: null,
    });

    expect(submitted.approval.summary).toBe(secretPlan);
    expect(database.platform.listEvents(portfolio.id, 10).every(
      (event) => JSON.stringify(event.payload).includes(secretPlan) === false,
    )).toBe(true);
    expect(database.platform.listEvents(portfolio.id, 10).find(
      (event) => event.type === 'ApprovalRequested',
    )?.payload).toEqual({ approvalId: submitted.approval.id });
  });

  it('summarizes every lifecycle state, pending approvals, and the newest 30 events', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.', successCriteria: ['Comparison'],
    });
    const service = createPlatformService(database.platform);
    const submitted = service.submitProjectPlan({
      projectId: project.id, summary: 'Zero-first comparison.', requestedByOrgAgentId: null,
    });
    for (let index = 0; index < 31; index += 1) {
      database.platform.appendEvent({
        portfolioId: portfolio.id, ventureId: venture.id, projectId: project.id,
        type: 'ProgressNoted', actorType: 'system', actorId: null, payload: { index },
      });
    }

    const snapshot = service.getExecutiveSnapshot(portfolio.id);

    expect(snapshot.projectsByLifecycle).toEqual({
      draft: 0, scoping: 0, pending_approval: 1, approved: 0,
      active: 0, paused: 0, completed: 0, cancelled: 0,
    });
    expect(snapshot.pendingApprovals).toEqual([expect.objectContaining({ id: submitted.approval.id })]);
    expect(snapshot.recentEvents).toHaveLength(30);
    expect(snapshot.recentEvents[0]?.payload).toEqual({ index: 30 });
    expect(snapshot.exportStatus).toMatchObject({ pending: expect.any(Number), failed: 0, lastFailure: null });
    expect(snapshot.exportStatus.pending).toBeGreaterThan(0);
  });

  it('rejects an approval decision when the trusted actor does not own its portfolio', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'Other Labs', ownerUserId: 'other-owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const project = database.platform.createProject({
      ventureId: venture.id, name: 'Tool Survey', objective: 'Compare services.', successCriteria: ['Comparison'],
    });
    const otherOwnerService = createPlatformService(database.platform, { currentUserId: 'other-owner' });
    const submitted = otherOwnerService.submitProjectPlan({
      projectId: project.id, summary: 'Zero-first comparison.', requestedByOrgAgentId: null,
    });

    expect(() => createPlatformService(database!.platform, { currentUserId: 'owner' }).decideProjectApproval({
      approvalId: submitted.approval.id, status: 'approved', decisionNote: null,
    })).toThrow('Trusted approval actor does not own this portfolio');
    expect(database.platform.getApproval(submitted.approval.id)).toMatchObject({ status: 'pending' });
    expect(database.platform.getProject(project.id)).toMatchObject({ lifecycle: 'pending_approval' });
  });

  it('creates and submits project intake atomically when approval creation fails', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const createApproval = database.platform.createApproval;
    database.platform.createApproval = () => {
      throw new Error('approval unavailable');
    };

    expect(() => createPlatformService(database!.platform, { currentUserId: 'owner' }).createAndSubmitProject({
      ventureId: venture.id,
      name: 'Tool Survey',
      objective: 'Compare services.',
      successCriteria: ['A sourced comparison'],
      constraints: [],
      summary: 'Zero-first comparison.',
      idempotencyKey: null,
    })).toThrow('approval unavailable');
    expect(database.platform.listProjects(venture.id)).toEqual([]);
    expect(database.platform.listPendingApprovals(portfolio.id)).toEqual([]);
    database.platform.createApproval = createApproval;
  });

  it('replays one project intake for a duplicate idempotency key', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const service = createPlatformService(database.platform, { currentUserId: 'owner' });
    const input = {
      ventureId: venture.id,
      name: 'Tool Survey',
      objective: 'Compare services.',
      successCriteria: ['A sourced comparison'],
      constraints: [],
      summary: 'Zero-first comparison.',
      idempotencyKey: 'intake-123',
    };

    const first = service.createAndSubmitProject(input);
    const replay = service.createAndSubmitProject(input);

    expect(replay).toMatchObject({ project: { id: first.project.id }, approval: { id: first.approval.id }, replayed: true });
    expect(database.platform.listProjects(venture.id)).toHaveLength(1);
    expect(database.platform.listPendingApprovals(portfolio.id)).toHaveLength(1);
  });

  // BLOCKED finding from the 9 August review: the replay path returned the
  // persisted project and approval BEFORE ownership was validated, so a second
  // owner replaying a known key received the first owner's records.
  it('DENIES an idempotency replay by a different owner, returning no record at all', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });
    const input = {
      ventureId: venture.id,
      name: 'Tool Survey',
      objective: 'Compare services.',
      successCriteria: ['A sourced comparison'],
      constraints: [],
      summary: 'Zero-first comparison.',
      idempotencyKey: 'shared-key',
    };

    const owner = createPlatformService(database.platform, { currentUserId: 'owner' });
    const created = owner.createAndSubmitProject(input);

    const intruder = createPlatformService(database.platform, { currentUserId: 'other-owner' });
    expect(() => intruder.createAndSubmitProject(input)).toThrow(/does not own/i);

    // No leak by any other route, and nothing extra created.
    expect(() => intruder.getExecutiveSnapshot(portfolio.id)).toThrow(/does not own/i);
    expect(database.platform.listProjects(venture.id)).toEqual([
      expect.objectContaining({ id: created.project.id }),
    ]);
  });

  // Reordering the checks alone is not enough. A second owner with a portfolio
  // of their own passes `assertOwnedPortfolio` on their own venture, so the key
  // itself has to carry an owner or their replay still returns the first
  // owner's project.
  it('DENIES a replay whose key was recorded by a different owner even on a venture they own', () => {
    database = createDatabase(':memory:');
    const seed = (ownerUserId: string) => {
      const portfolio = database!.platform.createPortfolio({ name: 'AI Labs', ownerUserId });
      const venture = database!.platform.createVenture({
        portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
      });
      return { portfolio, venture };
    };
    const intake = (ventureId: string) => ({
      ventureId,
      name: 'Tool Survey',
      objective: 'Compare services.',
      successCriteria: ['A sourced comparison'],
      constraints: [],
      summary: 'Zero-first comparison.',
      idempotencyKey: 'shared-key',
    });

    const first = seed('owner');
    const second = seed('other-owner');
    const created = createPlatformService(database.platform, { currentUserId: 'owner' })
      .createAndSubmitProject(intake(first.venture.id));

    const other = createPlatformService(database.platform, { currentUserId: 'other-owner' });
    expect(() => other.createAndSubmitProject(intake(second.venture.id))).toThrow(/does not own/i);

    // The key belongs to whoever made the original request, and the second
    // owner's own venture gained nothing from the attempt.
    expect(database.platform.getProjectIntakeIdempotency('shared-key')?.ownerUserId).toBe('owner');
    expect(database.platform.listProjects(second.venture.id)).toEqual([]);
    expect(database.platform.listProjects(first.venture.id)).toEqual([
      expect.objectContaining({ id: created.project.id }),
    ]);
  });

  it('rejects credential-shaped project prose at the service boundary', () => {
    database = createDatabase(':memory:');
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const venture = database.platform.createVenture({
      portfolioId: portfolio.id, name: 'Research Lab', kind: 'research', mission: 'Research tools.',
    });

    expect(() => createPlatformService(database!.platform, { currentUserId: 'owner' }).createAndSubmitProject({
      ventureId: venture.id,
      name: 'Unsafe plan',
      objective: 'Use api_key=sk-live-secret-value in the worker.',
      successCriteria: ['Worker connects'],
      constraints: [],
      summary: 'Approve the plan.',
      idempotencyKey: null,
    })).toThrow('Free text appears to contain a credential');
    expect(database.platform.listProjects(venture.id)).toEqual([]);
  });
});
