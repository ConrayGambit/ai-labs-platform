import { createHash } from 'node:crypto';
import {
  canTransitionProject,
  type ApprovalRequest,
  type CreateVentureInput,
  type CreateWorkProjectInput,
  type ExecutiveSnapshot,
  type Portfolio,
  type ProjectLifecycle,
  type Venture,
  type WorkProject,
} from '../shared/platform.js';
import type { PlatformRepository } from './platform-repository.js';
import { assertCredentialSafe } from './secret-safety.js';

interface ProjectIntakeInput extends CreateWorkProjectInput {
  summary: string;
  idempotencyKey: string | null;
}

interface ApprovalDecisionInput {
  approvalId: string;
  status: 'approved' | 'rejected';
  decisionNote: string | null;
}

export interface PlatformService {
  getOrCreateDefaultPortfolio(name?: string): Portfolio;
  createVenture(input: CreateVentureInput): Venture;
  submitProjectPlan(input: {
    projectId: string;
    summary: string;
    requestedByOrgAgentId: string | null;
  }): { project: WorkProject; approval: ApprovalRequest };
  createAndSubmitProject(input: ProjectIntakeInput): {
    project: WorkProject; approval: ApprovalRequest; replayed: boolean;
  };
  decideProjectApproval(input: ApprovalDecisionInput): {
    project: WorkProject; approval: ApprovalRequest;
  };
  getExecutiveSnapshot(portfolioId: string): ExecutiveSnapshot;
}

const LIFECYCLES: readonly ProjectLifecycle[] = [
  'draft', 'scoping', 'pending_approval', 'approved',
  'active', 'paused', 'completed', 'cancelled',
];

function requireProject(repository: PlatformRepository, projectId: string): WorkProject {
  const project = repository.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

function transitionProject(
  repository: PlatformRepository,
  project: WorkProject,
  lifecycle: ProjectLifecycle,
): WorkProject {
  if (!canTransitionProject(project.lifecycle, lifecycle)) {
    throw new Error(`Invalid project lifecycle transition: ${project.lifecycle} -> ${lifecycle}`);
  }
  return repository.transitionProject(project.id, lifecycle);
}

function intakeHash(input: ProjectIntakeInput): string {
  return createHash('sha256').update(JSON.stringify({
    ventureId: input.ventureId,
    name: input.name,
    objective: input.objective,
    successCriteria: input.successCriteria,
    constraints: input.constraints ?? [],
    summary: input.summary,
  })).digest('hex');
}

export function createPlatformService(
  repository: PlatformRepository,
  context: { currentUserId: string } = { currentUserId: 'owner' },
): PlatformService {
  const assertOwnedPortfolio = (portfolioId: string): Portfolio => {
    const portfolio = repository.getPortfolio(portfolioId);
    if (!portfolio) throw new Error(`Portfolio not found: ${portfolioId}`);
    if (portfolio.ownerUserId !== context.currentUserId) {
      throw new Error('Trusted user does not own this portfolio');
    }
    return portfolio;
  };

  const submitProjectPlan = (input: {
    projectId: string; summary: string; requestedByOrgAgentId: string | null;
  }) => repository.transaction(() => {
    assertCredentialSafe([input.summary]);
    let project = requireProject(repository, input.projectId);
    if (project.lifecycle === 'draft') project = transitionProject(repository, project, 'scoping');
    if (project.lifecycle !== 'scoping') {
      throw new Error(`Project plan can only be submitted from draft or scoping: ${project.id}`);
    }
    const venture = repository.getVenture(project.ventureId);
    if (!venture) throw new Error(`Venture not found: ${project.ventureId}`);
    assertOwnedPortfolio(venture.portfolioId);
    const approval = repository.createApproval({
      portfolioId: venture.portfolioId,
      ventureId: venture.id,
      projectId: project.id,
      summary: input.summary,
      requestedByOrgAgentId: input.requestedByOrgAgentId,
    });
    project = transitionProject(repository, project, 'pending_approval');
    repository.appendEvent({
      portfolioId: venture.portfolioId,
      ventureId: venture.id,
      projectId: project.id,
      type: 'ProjectPlanSubmitted',
      actorType: input.requestedByOrgAgentId ? 'org_agent' : 'user',
      actorId: input.requestedByOrgAgentId,
      payload: { approvalId: approval.id },
    });
    return { project, approval };
  });

  return {
    getOrCreateDefaultPortfolio(name = 'AI Labs') {
      assertCredentialSafe([name]);
      return repository.getOrCreateDefaultPortfolio({ name, ownerUserId: context.currentUserId });
    },

    createVenture(input) {
      assertCredentialSafe([input.name, input.mission]);
      assertOwnedPortfolio(input.portfolioId);
      return repository.createVenture(input);
    },

    submitProjectPlan,

    createAndSubmitProject(input) {
      assertCredentialSafe([
        input.name, input.objective, input.summary,
        ...input.successCriteria, ...(input.constraints ?? []),
      ]);
      const requestHash = intakeHash(input);

      /**
       * Ownership is established BEFORE any persisted record is returned.
       *
       * The replay path used to return the stored project and approval first and
       * validate ownership afterwards, so replaying a known key handed the caller
       * another owner's records. Both the main path and the recovery path below
       * go through this.
       */
      const replayFor = (key: string) => {
        const existing = repository.getProjectIntakeIdempotency(key);
        if (!existing) return null;
        if (existing.ownerUserId !== context.currentUserId) {
          throw new Error('Trusted user does not own this idempotency key');
        }
        if (existing.requestHash !== requestHash) {
          throw new Error('Idempotency key conflicts with another request');
        }
        return { project: existing.project, approval: existing.approval, replayed: true as const };
      };

      const execute = () => repository.transaction(() => {
        const venture = repository.getVenture(input.ventureId);
        if (!venture) throw new Error(`Venture not found: ${input.ventureId}`);
        assertOwnedPortfolio(venture.portfolioId);

        if (input.idempotencyKey) {
          const replayed = replayFor(input.idempotencyKey);
          if (replayed) return replayed;
        }

        const project = repository.createProject(input);
        const submitted = submitProjectPlan({
          projectId: project.id,
          summary: input.summary,
          requestedByOrgAgentId: null,
        });
        if (input.idempotencyKey) {
          repository.saveProjectIntakeIdempotency({
            key: input.idempotencyKey,
            requestHash,
            ownerUserId: context.currentUserId,
            projectId: submitted.project.id,
            approvalId: submitted.approval.id,
          });
        }
        return { ...submitted, replayed: false };
      });

      try {
        return execute();
      } catch (reason) {
        // Recovery after a lost response. Ownership is re-checked here too: this
        // path is reachable by anyone, and skipping the check was half of the
        // original defect.
        if (input.idempotencyKey) {
          const replayed = replayFor(input.idempotencyKey);
          if (replayed) return replayed;
        }
        throw reason;
      }
    },

    decideProjectApproval(input) {
      assertCredentialSafe([input.decisionNote]);
      return repository.transaction(() => {
        const existing = repository.getApproval(input.approvalId);
        if (!existing) throw new Error(`Approval not found: ${input.approvalId}`);
        const portfolio = repository.getPortfolio(existing.portfolioId);
        if (!portfolio) throw new Error(`Portfolio not found: ${existing.portfolioId}`);
        if (portfolio.ownerUserId !== context.currentUserId) {
          throw new Error('Trusted approval actor does not own this portfolio');
        }
        if (existing.status !== 'pending') throw new Error('Approval has already been decided');
        let project = requireProject(repository, existing.projectId);
        if (project.lifecycle !== 'pending_approval') {
          throw new Error(`Project is not pending approval: ${project.id}`);
        }
        const approval = repository.decideApproval({
          ...input,
          decidedByUserId: context.currentUserId,
        });
        if (input.status === 'rejected') {
          project = transitionProject(repository, project, 'scoping');
          return { project, approval };
        }
        project = transitionProject(repository, project, 'approved');
        project = transitionProject(repository, project, 'active');
        const venture = repository.getVenture(project.ventureId);
        if (!venture) throw new Error(`Venture not found: ${project.ventureId}`);
        repository.appendEvent({
          portfolioId: venture.portfolioId,
          ventureId: venture.id,
          projectId: project.id,
          type: 'ProjectActivated',
          actorType: 'user',
          actorId: context.currentUserId,
          payload: { approvalId: approval.id },
        });
        return { project, approval };
      });
    },

    getExecutiveSnapshot(portfolioId) {
      const portfolio = assertOwnedPortfolio(portfolioId);
      const ventures = repository.listVentures(portfolioId);
      const projectsByLifecycle = Object.fromEntries(
        LIFECYCLES.map((lifecycle) => [lifecycle, 0]),
      ) as Record<ProjectLifecycle, number>;
      for (const venture of ventures) {
        for (const project of repository.listProjects(venture.id)) {
          projectsByLifecycle[project.lifecycle] += 1;
        }
      }
      return {
        portfolio,
        ventures,
        pendingApprovals: repository.listPendingApprovals(portfolioId),
        projectsByLifecycle,
        recentEvents: repository.listEvents(portfolioId, 30),
        exportStatus: repository.getExportStatus(portfolioId),
      };
    },
  };
}
