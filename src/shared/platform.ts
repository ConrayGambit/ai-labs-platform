export type VentureKind = 'company' | 'saas' | 'brand' | 'research' | 'campaign' | 'other';
export type ProjectLifecycle =
  | 'draft'
  | 'scoping'
  | 'pending_approval'
  | 'approved'
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface Portfolio {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Venture {
  id: string;
  portfolioId: string;
  name: string;
  kind: VentureKind;
  mission: string;
  status: 'active' | 'paused' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface WorkProject {
  id: string;
  ventureId: string;
  name: string;
  objective: string;
  successCriteria: string[];
  constraints: string[];
  zeroFirst: boolean;
  lifecycle: ProjectLifecycle;
  supervisionPolicy: 'project_defined';
  workspaceMode: 'configurable';
  /**
   * Absolute path to the repository this project builds in, when it has one.
   *
   * A repository is an attribute of a project, not a peer concept: the codebase
   * previously carried two unrelated notions of "project" — a registered
   * repository path and a governed initiative — which is why a card could belong
   * to one and its work happen in the other.
   */
  repositoryPath: string | null;
  /** Which gate ladder this project's board is built from. */
  gateLadderId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequest {
  id: string;
  portfolioId: string;
  ventureId: string;
  projectId: string;
  kind: 'project_activation';
  status: ApprovalStatus;
  summary: string;
  requestedByOrgAgentId: string | null;
  decidedByUserId: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface PlatformEvent {
  id: string;
  portfolioId: string;
  ventureId: string | null;
  projectId: string | null;
  type: string;
  actorType: 'user' | 'org_agent' | 'system';
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface PlatformExportStatus {
  pending: number;
  failed: number;
  lastFailure: {
    eventId: string;
    eventType: string;
    attempts: number;
    errorCode: 'export_failed';
    nextRetryAt: string;
  } | null;
}

export interface CreateVentureInput {
  portfolioId: string;
  name: string;
  kind: VentureKind;
  mission: string;
}

export interface CreateWorkProjectInput {
  ventureId: string;
  name: string;
  objective: string;
  successCriteria: string[];
  constraints?: string[];
  repositoryPath?: string | null;
  gateLadderId?: string;
}

export interface ExecutiveSnapshot {
  portfolio: Portfolio;
  ventures: Venture[];
  pendingApprovals: ApprovalRequest[];
  projectsByLifecycle: Record<ProjectLifecycle, number>;
  recentEvents: PlatformEvent[];
  exportStatus: PlatformExportStatus;
}

const TRANSITIONS: Record<ProjectLifecycle, readonly ProjectLifecycle[]> = {
  draft: ['scoping', 'cancelled'],
  scoping: ['pending_approval', 'cancelled'],
  pending_approval: ['scoping', 'approved', 'cancelled'],
  approved: ['active', 'cancelled'],
  active: ['paused', 'completed', 'cancelled'],
  paused: ['active', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function canTransitionProject(from: ProjectLifecycle, to: ProjectLifecycle): boolean {
  return TRANSITIONS[from].includes(to);
}
