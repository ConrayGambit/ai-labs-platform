import type { Dedication, ExpiryKind, Tenure } from './org.js';

export type AgentKind = 'hermes' | 'kimi' | 'claude' | 'codex' | 'custom';
export type PromptTransport = 'argument' | 'stdin';
export type AgentOutputFormat = 'text' | 'json' | 'jsonl';

export const RUNTIME_OPTION_KEYS = ['model', 'speed', 'effort'] as const;
export type RuntimeOptionKey = (typeof RUNTIME_OPTION_KEYS)[number];
export type RuntimeOptionTemplates = Partial<Record<RuntimeOptionKey, string[]>>;
export type RuntimeOptionValues = Partial<Record<RuntimeOptionKey, string | null>>;
/** Curated, provider-accurate dropdown choices per option key for a runtime. */
export type RuntimeOptionChoices = Partial<Record<RuntimeOptionKey, string[]>>;
/** Extra environment for the spawned CLI. Values may reference `${VAR}` from the host env. */
export type RuntimeEnv = Record<string, string>;

export interface AgentRuntime {
  id: string;
  name: string;
  kind: AgentKind;
  command: string;
  argsTemplate: string[];
  /**
   * How this runtime launches for an ACP session, when it can. NULL means it
   * cannot: the single-shot `command`/`argsTemplate` above are a different
   * invocation of the same provider and are not interchangeable with these.
   */
  acpCommand: string | null;
  acpArgs: string[];
  promptTransport: PromptTransport;
  outputFormat: AgentOutputFormat;
  resultField: string | null;
  versionArgs: string[];
  optionTemplates: RuntimeOptionTemplates;
  optionValues: RuntimeOptionChoices;
  env: RuntimeEnv;
  enabled: boolean;
  isCoordinator: boolean;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  name: string;
  command: string;
  argsTemplate: string[];
  acpCommand?: string | null;
  acpArgs?: string[];
  promptTransport?: PromptTransport;
  outputFormat?: AgentOutputFormat;
  resultField?: string | null;
  versionArgs?: string[];
  optionTemplates?: RuntimeOptionTemplates;
  optionValues?: RuntimeOptionChoices;
  env?: RuntimeEnv;
  timeoutMs?: number;
}

export interface RuntimeHealth {
  agentId: string;
  available: boolean;
  version: string | null;
  error: string | null;
  checkedAt: string;
}

export interface Organization {
  id: string;
  name: string;
  description: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrganizationInput {
  name: string;
  description?: string;
  color?: string;
}

export const SKILL_CATEGORIES = ['design', 'marketing', 'browser', '3d', 'custom'] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export interface Skill {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: SkillCategory;
  sourceUrl: string;
  installCommand: string;
  instructions: string;
  builtin: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSkillInput {
  name: string;
  description: string;
  category?: SkillCategory;
  sourceUrl?: string;
  installCommand?: string;
  instructions: string;
}

export interface OrgAgent {
  id: string;
  organizationId: string;
  name: string;
  jobTitle: string;
  department: string;
  jobFunction: string;
  responsibilities: string;
  instructions: string;
  runtimeId: string;
  managerId: string | null;
  authorityLevel: number;
  canDelegate: boolean;
  model: string | null;
  speed: string | null;
  effort: string | null;
  skillIds: string[];
  enabled: boolean;
  /** Permanent staff cannot be deleted. Temporary staff require an expiry condition. */
  tenure: Tenure;
  expiryKind: ExpiryKind | null;
  expiryAt: string | null;
  ventureId: string | null;
  departmentId: string | null;
  /** Recorded because it determines memory scope, not as documentation. */
  dedication: Dedication;
  dedicationReason: string | null;
  /** Set when this agent reports to a human. The owner sits at the root. */
  reportsToUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrgAgentInput {
  organizationId?: string;
  name: string;
  jobTitle: string;
  department: string;
  jobFunction: string;
  responsibilities: string;
  instructions?: string;
  runtimeId: string;
  managerId?: string | null;
  authorityLevel?: number;
  canDelegate?: boolean;
  model?: string | null;
  speed?: string | null;
  effort?: string | null;
  skillIds?: string[];
  /** Defaults to 'hired'. 'temporary' requires expiryKind. */
  tenure?: Tenure;
  expiryKind?: ExpiryKind;
  expiryAt?: string | null;
  ventureId?: string | null;
  departmentId?: string | null;
  dedication?: Dedication;
  dedicationReason?: string | null;
}

export interface Project {
  id: string;
  organizationId: string;
  name: string;
  path: string;
  description: string;
  color: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  organizationId?: string;
  name: string;
  path: string;
  description?: string;
  color?: string;
}

export const TASK_STATUSES = [
  'backlog',
  'ready',
  'in_progress',
  'review',
  'done',
  'blocked',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedAgentId?: string | null;
}

export type KanbanBoard = Record<TaskStatus, Task[]>;
export type RunMode = 'direct' | 'council' | 'hierarchy';
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type MessagePhase = 'proposal' | 'critique' | 'synthesis' | 'execution' | 'system' | 'error';
export type MessageRole = 'user' | 'assistant' | 'system';

export interface OrchestrationRun {
  id: string;
  taskId: string;
  mode: RunMode;
  status: RunStatus;
  coordinatorAgentId: string;
  rootOrgAgentId: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateRunInput {
  taskId: string;
  mode: RunMode;
  coordinatorAgentId: string;
  rootOrgAgentId?: string | null;
}

export interface RunMessage {
  id: string;
  runId: string;
  taskId: string;
  agentId: string | null;
  orgAgentId: string | null;
  phase: MessagePhase;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface CreateRunMessageInput {
  runId: string;
  taskId: string;
  agentId?: string | null;
  orgAgentId?: string | null;
  phase: MessagePhase;
  role: MessageRole;
  content: string;
}

export interface RecentRun {
  id: string;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  organizationId: string;
  mode: RunMode;
  status: RunStatus;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface DashboardStats {
  organizations: number;
  projects: number;
  orgAgents: number;
  skills: number;
  activeRuns: number;
  tasksByStatus: Record<TaskStatus, number>;
}
