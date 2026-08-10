import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  canTransitionProject,
  type ApprovalRequest,
  type CreateVentureInput,
  type CreateWorkProjectInput,
  type PlatformEvent,
  type PlatformExportStatus,
  type Portfolio,
  type ProjectLifecycle,
  type Venture,
  type WorkProject,
} from '../shared/platform.js';
import { createPlatformExportOutbox, type PlatformExportJob } from './platform-export-outbox.js';
import { createDefaultPortfolioRepository } from './platform-default-portfolio.js';

type PortfolioRow = { id: string; name: string; owner_user_id: string; created_at: string; updated_at: string };
type VentureRow = {
  id: string; portfolio_id: string; name: string; kind: Venture['kind']; mission: string;
  status: Venture['status']; created_at: string; updated_at: string;
};
type ProjectRow = {
  id: string; venture_id: string; name: string; objective: string; success_criteria_json: string;
  constraints_json: string; zero_first: number; lifecycle: ProjectLifecycle;
  supervision_policy: WorkProject['supervisionPolicy']; workspace_mode: WorkProject['workspaceMode'];
  repository_path: string | null;
  gate_ladder_id: string | null;
  created_at: string; updated_at: string;
};
type ApprovalRow = {
  id: string; portfolio_id: string; venture_id: string; project_id: string; kind: ApprovalRequest['kind'];
  status: ApprovalRequest['status']; summary: string; requested_by_org_agent_id: string | null;
  decided_by_user_id: string | null; decision_note: string | null; created_at: string; decided_at: string | null;
};
type EventRow = {
  id: string; portfolio_id: string; venture_id: string | null; project_id: string | null; type: string;
  actor_type: PlatformEvent['actorType']; actor_id: string | null; payload_json: string; created_at: string;
};

export interface PlatformRepository {
  transaction<T>(operation: () => T): T;
  createPortfolio(input: { name: string; ownerUserId: string }): Portfolio;
  getPortfolio(id: string): Portfolio | null;
  getDefaultPortfolio(ownerUserId: string): Portfolio | null;
  getOrCreateDefaultPortfolio(input: { name: string; ownerUserId: string }): Portfolio;
  createVenture(input: CreateVentureInput): Venture;
  getVenture(id: string): Venture | null;
  listVentures(portfolioId: string): Venture[];
  createProject(input: CreateWorkProjectInput): WorkProject;
  getProject(id: string): WorkProject | null;
  listProjects(ventureId: string): WorkProject[];
  transitionProject(id: string, lifecycle: ProjectLifecycle): WorkProject;
  createApproval(input: {
    portfolioId: string; ventureId: string; projectId: string; summary: string;
    requestedByOrgAgentId?: string | null;
  }): ApprovalRequest;
  getApproval(id: string): ApprovalRequest | null;
  listPendingApprovals(portfolioId: string): ApprovalRequest[];
  decideApproval(input: {
    approvalId: string; status: 'approved' | 'rejected'; decidedByUserId: string; decisionNote?: string | null;
  }): ApprovalRequest;
  appendEvent(input: Omit<PlatformEvent, 'id' | 'createdAt'>): PlatformEvent;
  listEvents(portfolioId: string, limit: number): PlatformEvent[];
  getProjectIntakeIdempotency(key: string): {
    requestHash: string; ownerUserId: string | null; project: WorkProject; approval: ApprovalRequest;
  } | null;
  saveProjectIntakeIdempotency(input: {
    key: string; requestHash: string; ownerUserId: string; projectId: string; approvalId: string;
  }): void;
  listReadyExports(now: string, limit: number, includeDeferred?: boolean): PlatformExportJob[];
  markExportCompleted(eventId: string): void;
  markExportFailed(eventId: string, attempts: number, nextRetryAt: string): void;
  getNextExportAttemptAt(): string | null;
  getExportStatus(portfolioId: string): PlatformExportStatus;
}

const mapPortfolio = (row: PortfolioRow): Portfolio => ({
  id: row.id, name: row.name, ownerUserId: row.owner_user_id, createdAt: row.created_at, updatedAt: row.updated_at,
});
const mapVenture = (row: VentureRow): Venture => ({
  id: row.id, portfolioId: row.portfolio_id, name: row.name, kind: row.kind, mission: row.mission,
  status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
});
const mapProject = (row: ProjectRow): WorkProject => ({
  id: row.id, ventureId: row.venture_id, name: row.name, objective: row.objective,
  successCriteria: JSON.parse(row.success_criteria_json) as string[],
  constraints: JSON.parse(row.constraints_json) as string[], zeroFirst: row.zero_first === 1,
  lifecycle: row.lifecycle, supervisionPolicy: row.supervision_policy, workspaceMode: row.workspace_mode,
  repositoryPath: row.repository_path ?? null,
  gateLadderId: row.gate_ladder_id ?? 'product',
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const mapApproval = (row: ApprovalRow): ApprovalRequest => ({
  id: row.id, portfolioId: row.portfolio_id, ventureId: row.venture_id, projectId: row.project_id,
  kind: row.kind, status: row.status, summary: row.summary,
  requestedByOrgAgentId: row.requested_by_org_agent_id, decidedByUserId: row.decided_by_user_id,
  decisionNote: row.decision_note, createdAt: row.created_at, decidedAt: row.decided_at,
});
const mapEvent = (row: EventRow): PlatformEvent => ({
  id: row.id, portfolioId: row.portfolio_id, ventureId: row.venture_id, projectId: row.project_id,
  type: row.type, actorType: row.actor_type, actorId: row.actor_id,
  payload: JSON.parse(row.payload_json) as Record<string, unknown>, createdAt: row.created_at,
});

export function createPlatformRepository(connection: Database.Database): PlatformRepository {
  // Schema is owned by the migration ledger (0004-platform-foundation).
  const exportOutbox = createPlatformExportOutbox(connection);

  const insertEvent = connection.prepare(`
    INSERT INTO platform_events
      (id, portfolio_id, venture_id, project_id, type, actor_type, actor_id, payload_json, created_at)
    VALUES (@id, @portfolioId, @ventureId, @projectId, @type, @actorType, @actorId, @payloadJson, @createdAt)
  `);
  const appendEvent = connection.transaction((input: Omit<PlatformEvent, 'id' | 'createdAt'>): PlatformEvent => {
    const event = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
    insertEvent.run({ ...event, payloadJson: JSON.stringify(event.payload) });
    exportOutbox.enqueue(event.id, event.createdAt);
    return event;
  });
  const getPortfolio = (id: string): Portfolio | null => {
    const row = connection.prepare('SELECT * FROM platform_portfolios WHERE id = ?').get(id) as PortfolioRow | undefined;
    return row ? mapPortfolio(row) : null;
  };
  const getVenture = (id: string): Venture | null => {
    const row = connection.prepare('SELECT * FROM platform_ventures WHERE id = ?').get(id) as VentureRow | undefined;
    return row ? mapVenture(row) : null;
  };
  const getProject = (id: string): WorkProject | null => {
    const row = connection.prepare('SELECT * FROM platform_projects WHERE id = ?').get(id) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  };
  const getApproval = (id: string): ApprovalRequest | null => {
    const row = connection.prepare('SELECT * FROM platform_approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
    return row ? mapApproval(row) : null;
  };

  const createPortfolio = connection.transaction((input: { name: string; ownerUserId: string }): Portfolio => {
    const now = new Date().toISOString();
    const portfolio = { id: randomUUID(), ...input, createdAt: now, updatedAt: now };
    connection.prepare(`
      INSERT INTO platform_portfolios (id, name, owner_user_id, created_at, updated_at)
      VALUES (@id, @name, @ownerUserId, @createdAt, @updatedAt)
    `).run(portfolio);
    appendEvent({ portfolioId: portfolio.id, ventureId: null, projectId: null, type: 'PortfolioCreated',
      actorType: 'user', actorId: input.ownerUserId, payload: { name: input.name } });
    return portfolio;
  });
  const defaultPortfolios = createDefaultPortfolioRepository(connection, createPortfolio);
  const createVenture = connection.transaction((input: CreateVentureInput): Venture => {
    const now = new Date().toISOString();
    const venture: Venture = { id: randomUUID(), ...input, status: 'active', createdAt: now, updatedAt: now };
    connection.prepare(`
      INSERT INTO platform_ventures
        (id, portfolio_id, name, kind, mission, status, created_at, updated_at)
      VALUES (@id, @portfolioId, @name, @kind, @mission, @status, @createdAt, @updatedAt)
    `).run(venture);
    appendEvent({ portfolioId: input.portfolioId, ventureId: venture.id, projectId: null, type: 'VentureCreated',
      actorType: 'user', actorId: null, payload: { name: input.name, kind: input.kind } });
    return venture;
  });
  const createProject = connection.transaction((input: CreateWorkProjectInput): WorkProject => {
    const venture = getVenture(input.ventureId);
    if (!venture) throw new Error(`Venture not found: ${input.ventureId}`);
    const now = new Date().toISOString();
    const project: WorkProject = {
      id: randomUUID(), ventureId: input.ventureId, name: input.name, objective: input.objective,
      successCriteria: input.successCriteria, constraints: input.constraints ?? [], zeroFirst: true,
      lifecycle: 'draft', supervisionPolicy: 'project_defined', workspaceMode: 'configurable',
      repositoryPath: input.repositoryPath ?? null, gateLadderId: input.gateLadderId ?? 'product',
      createdAt: now, updatedAt: now,
    };
    connection.prepare(`
      INSERT INTO platform_projects (
        id, venture_id, name, objective, success_criteria_json, constraints_json,
        zero_first, lifecycle, supervision_policy, workspace_mode, repository_path,
        gate_ladder_id, created_at, updated_at
      ) VALUES (
        @id, @ventureId, @name, @objective, @successCriteriaJson, @constraintsJson,
        @zeroFirst, @lifecycle, @supervisionPolicy, @workspaceMode, @repositoryPath,
        @gateLadderId, @createdAt, @updatedAt
      )
    `).run({ ...project, successCriteriaJson: JSON.stringify(project.successCriteria),
      constraintsJson: JSON.stringify(project.constraints), zeroFirst: 1 });
    appendEvent({ portfolioId: venture.portfolioId, ventureId: venture.id, projectId: project.id, type: 'ProjectCreated',
      actorType: 'user', actorId: null, payload: { name: project.name } });
    return project;
  });
  const transitionProject = connection.transaction((id: string, lifecycle: ProjectLifecycle): WorkProject => {
    const project = getProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    if (!canTransitionProject(project.lifecycle, lifecycle)) {
      throw new Error(`Invalid project lifecycle transition: ${project.lifecycle} -> ${lifecycle}`);
    }
    if (lifecycle === 'active') {
      const approval = connection.prepare(`
        SELECT id FROM platform_approvals
        WHERE project_id = ? AND kind = 'project_activation' AND status = 'approved'
      `).get(project.id);
      if (!approval) throw new Error(`Approved project activation is required: ${project.id}`);
    }
    const updatedAt = new Date().toISOString();
    connection.prepare('UPDATE platform_projects SET lifecycle = ?, updated_at = ? WHERE id = ?').run(lifecycle, updatedAt, id);
    const venture = getVenture(project.ventureId);
    if (!venture) throw new Error(`Venture not found: ${project.ventureId}`);
    appendEvent({ portfolioId: venture.portfolioId, ventureId: venture.id, projectId: project.id,
      type: 'ProjectLifecycleChanged', actorType: 'user', actorId: null, payload: { from: project.lifecycle, to: lifecycle } });
    return { ...project, lifecycle, updatedAt };
  });
  const createApproval = connection.transaction((input: Parameters<PlatformRepository['createApproval']>[0]): ApprovalRequest => {
    const project = getProject(input.projectId);
    if (!project) throw new Error(`Project not found: ${input.projectId}`);
    const venture = getVenture(project.ventureId);
    if (!venture) throw new Error(`Venture not found: ${project.ventureId}`);
    if (input.ventureId !== venture.id || input.portfolioId !== venture.portfolioId) {
      throw new Error(`Approval hierarchy does not match project: ${input.projectId}`);
    }
    const pending = connection.prepare('SELECT id FROM platform_approvals WHERE project_id = ? AND status = ?').get(input.projectId, 'pending');
    if (pending) throw new Error(`Pending approval already exists for project: ${input.projectId}`);
    const approval: ApprovalRequest = {
      id: randomUUID(), portfolioId: input.portfolioId, ventureId: input.ventureId, projectId: input.projectId,
      kind: 'project_activation', status: 'pending', summary: input.summary,
      requestedByOrgAgentId: input.requestedByOrgAgentId ?? null, decidedByUserId: null, decisionNote: null,
      createdAt: new Date().toISOString(), decidedAt: null,
    };
    connection.prepare(`
      INSERT INTO platform_approvals (
        id, portfolio_id, venture_id, project_id, kind, status, summary,
        requested_by_org_agent_id, decided_by_user_id, decision_note, created_at, decided_at
      ) VALUES (
        @id, @portfolioId, @ventureId, @projectId, @kind, @status, @summary,
        @requestedByOrgAgentId, @decidedByUserId, @decisionNote, @createdAt, @decidedAt
      )
    `).run(approval);
    appendEvent({ portfolioId: approval.portfolioId, ventureId: approval.ventureId, projectId: approval.projectId,
      type: 'ApprovalRequested', actorType: approval.requestedByOrgAgentId ? 'org_agent' : 'user',
      actorId: approval.requestedByOrgAgentId, payload: { approvalId: approval.id } });
    return approval;
  });
  const decideApproval = connection.transaction((input: Parameters<PlatformRepository['decideApproval']>[0]): ApprovalRequest => {
    const approval = getApproval(input.approvalId);
    if (!approval) throw new Error(`Approval not found: ${input.approvalId}`);
    if (approval.status !== 'pending') throw new Error(`Approval is not pending: ${input.approvalId}`);
    const decidedAt = new Date().toISOString();
    const decisionNote = input.decisionNote ?? null;
    connection.prepare(`
      UPDATE platform_approvals SET status = ?, decided_by_user_id = ?, decision_note = ?, decided_at = ? WHERE id = ?
    `).run(input.status, input.decidedByUserId, decisionNote, decidedAt, input.approvalId);
    const decided: ApprovalRequest = { ...approval, status: input.status, decidedByUserId: input.decidedByUserId, decisionNote, decidedAt };
    appendEvent({ portfolioId: approval.portfolioId, ventureId: approval.ventureId, projectId: approval.projectId,
      type: 'ApprovalDecided', actorType: 'user', actorId: input.decidedByUserId,
      payload: { approvalId: approval.id, status: input.status } });
    return decided;
  });

  return {
    transaction: <T>(operation: () => T): T => connection.transaction(operation)(),
    createPortfolio, getPortfolio,
    getDefaultPortfolio: defaultPortfolios.get,
    getOrCreateDefaultPortfolio: defaultPortfolios.getOrCreate,
    createVenture, getVenture,
    listVentures: (portfolioId) => connection.prepare(
      'SELECT * FROM platform_ventures WHERE portfolio_id = ? ORDER BY created_at, rowid',
    ).all(portfolioId).map((row) => mapVenture(row as VentureRow)),
    createProject, getProject,
    listProjects: (ventureId) => connection.prepare(
      'SELECT * FROM platform_projects WHERE venture_id = ? ORDER BY created_at, rowid',
    ).all(ventureId).map((row) => mapProject(row as ProjectRow)),
    transitionProject, createApproval, getApproval,
    listPendingApprovals: (portfolioId) => connection.prepare(`
      SELECT * FROM platform_approvals WHERE portfolio_id = ? AND status = 'pending' ORDER BY created_at, rowid
    `).all(portfolioId).map((row) => mapApproval(row as ApprovalRow)),
    decideApproval, appendEvent,
    listEvents: (portfolioId, limit) => {
      if (limit < 1 || limit > 200) throw new Error('Event limit must be between 1 and 200');
      return connection.prepare(`
        SELECT * FROM platform_events WHERE portfolio_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
      `).all(portfolioId, limit).map((row) => mapEvent(row as EventRow));
    },
    getProjectIntakeIdempotency: (key) => {
      const row = connection.prepare(`
        SELECT request_hash, owner_user_id, project_id, approval_id
        FROM platform_idempotency_keys
        WHERE operation = 'project_intake' AND key = ?
      `).get(key) as
        | { request_hash: string; owner_user_id: string | null; project_id: string; approval_id: string }
        | undefined;
      if (!row) return null;
      const project = getProject(row.project_id);
      const approval = getApproval(row.approval_id);
      if (!project || !approval) throw new Error(`Idempotency record is incomplete: ${key}`);
      return {
        requestHash: row.request_hash,
        ownerUserId: row.owner_user_id ?? null,
        project,
        approval,
      };
    },
    saveProjectIntakeIdempotency: (input) => {
      connection.prepare(`
        INSERT INTO platform_idempotency_keys
          (operation, key, request_hash, owner_user_id, project_id, approval_id, created_at)
        VALUES ('project_intake', @key, @requestHash, @ownerUserId, @projectId, @approvalId, @createdAt)
      `).run({ ...input, createdAt: new Date().toISOString() });
    },
    listReadyExports: (now, limit, includeDeferred = false) => exportOutbox.listReady(now, limit, includeDeferred),
    markExportCompleted: exportOutbox.markCompleted,
    markExportFailed: exportOutbox.markFailed,
    getNextExportAttemptAt: exportOutbox.getNextAttemptAt,
    getExportStatus: exportOutbox.getStatus,
  };
}
