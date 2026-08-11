import { useEffect, useMemo, useState } from 'react';
import type {
  AgentRuntime,
  CreateOrgAgentInput,
  CreateOrganizationInput,
  CreateProjectInput,
  CreateTaskInput,
  DashboardStats,
  KanbanBoard,
  Organization,
  OrgAgent,
  Project,
  RecentRun,
  RuntimeOptionKey,
  Skill,
  SkillCategory,
  Task,
  TaskStatus,
} from '../shared/domain.js';
import { RequestFailedError } from './idempotency.js';

type RuntimeOptionsPatch = {
  optionTemplates?: AgentRuntime['optionTemplates'];
  optionValues?: AgentRuntime['optionValues'];
  env?: AgentRuntime['env'];
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
  blocked: 'Blocked',
};

const CATEGORY_LABELS: Record<SkillCategory, string> = {
  design: 'Design',
  marketing: 'Marketing',
  browser: 'Browser',
  '3d': '3D',
  custom: 'Custom',
};

const CATEGORY_ORDER: SkillCategory[] = ['design', 'marketing', 'browser', '3d', 'custom'];

const EMPTY_BOARD: KanbanBoard = {
  backlog: [],
  ready: [],
  in_progress: [],
  review: [],
  done: [],
  blocked: [],
};

type View = 'dashboard' | 'organizations' | 'organization' | 'skills' | 'runtimes';
type OrgTab = 'board' | 'team';

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new RequestFailedError(response.status);
  return await response.json() as T;
}

async function sendJson<T>(
  url: string,
  method: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // The status travels with the error: a caller holding an idempotency key needs
  // to tell an undecided outcome from a decided one.
  if (!response.ok) throw new RequestFailedError(response.status);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function formatRunTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function RuntimeMark({ runtimeId }: { runtimeId: string }) {
  return <span className={`runtime-mark runtime-${runtimeId}`}>{runtimeId.slice(0, 1).toUpperCase()}</span>;
}

function OrgCard({
  agent,
  agentsById,
  runtimesById,
  skillsById,
  depth,
}: {
  agent: OrgAgent;
  agentsById: Map<string, OrgAgent>;
  runtimesById: Map<string, AgentRuntime>;
  skillsById: Map<string, Skill>;
  depth: number;
}) {
  const manager = agent.managerId ? agentsById.get(agent.managerId) : null;
  const runtime = runtimesById.get(agent.runtimeId);
  const tuning = [agent.model, agent.speed, agent.effort].filter(Boolean) as string[];
  return (
    <article className="org-card" style={{ '--depth': depth } as React.CSSProperties}>
      <div className="org-connector" aria-hidden="true" />
      <div className="org-card-topline">
        <RuntimeMark runtimeId={agent.runtimeId} />
        <div className="org-identity">
          <h3>{agent.jobTitle}</h3>
          <p className="agent-name">{agent.name}</p>
        </div>
        <span className="authority-pill">Level {agent.authorityLevel}</span>
      </div>
      <p className="agent-function">{agent.jobFunction}</p>
      <div className="org-meta">
        <span>{agent.department}</span>
        <span>{runtime?.name ?? agent.runtimeId}</span>
        <span>{manager ? `Reports to ${manager.name}` : 'Organization root'}</span>
        {agent.canDelegate && <span>Can delegate</span>}
        {tuning.map((value) => <span className="tuning-pill" key={value}>{value}</span>)}
        {agent.skillIds.map((skillId) => (
          <span className="skill-pill" key={skillId}>{skillsById.get(skillId)?.name ?? skillId}</span>
        ))}
      </div>
    </article>
  );
}

const TUNING_OPTION_LABELS: Record<RuntimeOptionKey, string> = {
  model: 'Model',
  speed: 'Speed',
  effort: 'Effort',
};

/**
 * Runtime tuning field. Dropdowns are fed by the runtime's curated,
 * provider-accurate option values; runtimes with a flag but no curated list
 * fall back to free text, and unsupported options are disabled.
 */
function TuningOptionField({
  optionKey,
  runtime,
  value,
  onChange,
}: {
  optionKey: RuntimeOptionKey;
  runtime: AgentRuntime | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  const template = runtime?.optionTemplates[optionKey];
  const choices = runtime?.optionValues[optionKey];
  const label = TUNING_OPTION_LABELS[optionKey];
  if (!template) {
    return (
      <label>{label}
        <input disabled placeholder="Not supported" readOnly value="" />
      </label>
    );
  }
  if (choices && choices.length > 0) {
    return (
      <label>{label}
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Provider default</option>
          {choices.map((choice) => (
            <option key={choice} value={choice}>{choice}</option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label>{label}
      <input
        placeholder="Provider default"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function NewAgentDialog({
  agents,
  runtimes,
  skills,
  organizations,
  defaultOrganizationId,
  onClose,
  onCreate,
}: {
  agents: OrgAgent[];
  runtimes: AgentRuntime[];
  skills: Skill[];
  organizations: Organization[];
  defaultOrganizationId: string;
  onClose: () => void;
  onCreate: (input: CreateOrgAgentInput) => Promise<void>;
}) {
  const [organizationId, setOrganizationId] = useState(defaultOrganizationId);
  const [name, setName] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [jobFunction, setJobFunction] = useState('');
  const [responsibilities, setResponsibilities] = useState('');
  const [instructions, setInstructions] = useState('');
  const [runtimeId, setRuntimeId] = useState(runtimes[0]?.id ?? '');
  const [managerId, setManagerId] = useState('');
  const [authorityLevel, setAuthorityLevel] = useState(50);
  const [canDelegate, setCanDelegate] = useState(false);
  const [model, setModel] = useState('');
  const [speed, setSpeed] = useState('');
  const [effort, setEffort] = useState('');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRuntime = runtimes.find((runtime) => runtime.id === runtimeId);
  const orgAgents = agents.filter((agent) => agent.organizationId === organizationId);
  const speedViaModelVariant = (selectedRuntime?.optionValues.model ?? []).some((choice) =>
    choice.includes('-highspeed'),
  );

  // Provider option lists differ per runtime; reset tuning when the runtime changes.
  useEffect(() => {
    setModel('');
    setSpeed('');
    setEffort('');
  }, [runtimeId]);

  function toggleSkill(skillId: string): void {
    setSkillIds((current) =>
      current.includes(skillId)
        ? current.filter((id) => id !== skillId)
        : [...current, skillId],
    );
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({
        organizationId,
        name,
        jobTitle,
        department,
        jobFunction,
        responsibilities,
        instructions,
        runtimeId,
        managerId: managerId || null,
        authorityLevel,
        canDelegate,
        model: model || null,
        speed: speed || null,
        effort: effort || null,
        skillIds,
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to create agent');
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section aria-labelledby="new-agent-title" aria-modal="true" className="dialog" role="dialog">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">Organizational identity</p>
            <h2 id="new-agent-title">Create agent</h2>
          </div>
          <button aria-label="Close" className="icon-button" onClick={onClose} type="button">×</button>
        </div>
        <form className="agent-form" onSubmit={submit}>
          <div className="form-grid two-columns">
            <label>Name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>Job title<input required value={jobTitle} onChange={(event) => setJobTitle(event.target.value)} /></label>
          </div>
          <div className="form-grid two-columns">
            <label>Organization
              <select required value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>{organization.name}</option>
                ))}
              </select>
            </label>
            <label>Department<input required value={department} onChange={(event) => setDepartment(event.target.value)} /></label>
          </div>
          <label>Job function<textarea required rows={2} value={jobFunction} onChange={(event) => setJobFunction(event.target.value)} /></label>
          <label>Responsibilities<textarea required rows={3} value={responsibilities} onChange={(event) => setResponsibilities(event.target.value)} /></label>
          <label>Role instructions<textarea rows={3} value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label>
          <div className="form-grid two-columns">
            <label>Runtime
              <select required value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}>
                {runtimes.filter((runtime) => runtime.enabled).map((runtime) => (
                  <option key={runtime.id} value={runtime.id}>{runtime.name}</option>
                ))}
              </select>
            </label>
            <label>Reports to
              <select value={managerId} onChange={(event) => setManagerId(event.target.value)}>
                <option value="">Organization root</option>
                {orgAgents.filter((agent) => agent.canDelegate && agent.enabled).map((agent) => (
                  <option key={agent.id} value={agent.id}>{agent.name} — {agent.jobTitle}</option>
                ))}
              </select>
            </label>
          </div>
          <fieldset className="tuning-fieldset">
            <legend>Runtime tuning</legend>
            <div className="form-grid three-columns">
              <TuningOptionField optionKey="model" runtime={selectedRuntime} value={model} onChange={setModel} />
              <TuningOptionField optionKey="speed" runtime={selectedRuntime} value={speed} onChange={setSpeed} />
              <TuningOptionField optionKey="effort" runtime={selectedRuntime} value={effort} onChange={setEffort} />
            </div>
            <p className="form-note">
              Options are real provider choices loaded from the runtime registry and passed to the
              provider CLI only when the runtime defines a flag for them (configure flags and value
              lists under Runtimes). Unsupported options stay with the provider default.
              {speedViaModelVariant
                ? ' For this provider, speed is a model choice: pick a -highspeed model variant for ~100 tps output.'
                : ''}
            </p>
          </fieldset>
          <fieldset className="tuning-fieldset">
            <legend>Skills <small>recommended for design and marketing teams</small></legend>
            <div className="skill-picker">
              {skills.filter((skill) => skill.enabled).map((skill) => (
                <label className="skill-option" key={skill.id}>
                  <input
                    checked={skillIds.includes(skill.id)}
                    type="checkbox"
                    onChange={() => toggleSkill(skill.id)}
                  />
                  <span>
                    <strong>{skill.name}</strong>
                    <small>{skill.description}</small>
                  </span>
                </label>
              ))}
              {skills.length === 0 && <p className="form-note">No skills registered yet.</p>}
            </div>
          </fieldset>
          <div className="form-grid authority-row">
            <label>Authority level
              <input max="100" min="0" type="number" value={authorityLevel} onChange={(event) => setAuthorityLevel(Number(event.target.value))} />
            </label>
            <label className="checkbox-label">
              <input
                aria-label="Can delegate"
                checked={canDelegate}
                type="checkbox"
                onChange={(event) => setCanDelegate(event.target.checked)}
              />
              <span><strong>Can delegate</strong><small>May manage direct reports</small></span>
            </label>
          </div>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="ghost-button" onClick={onClose} type="button">Cancel</button>
            <button className="primary-button" disabled={submitting} type="submit">
              {submitting ? 'Creating…' : 'Create agent'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function NewProjectDialog({
  organizations,
  defaultOrganizationId,
  onClose,
  onCreate,
}: {
  organizations: Organization[];
  defaultOrganizationId: string;
  onClose: () => void;
  onCreate: (input: CreateProjectInput) => Promise<void>;
}) {
  const [organizationId, setOrganizationId] = useState(defaultOrganizationId);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ organizationId, name, path, description });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to create project');
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section aria-labelledby="new-project-title" aria-modal="true" className="dialog compact-dialog" role="dialog">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">Local development workspace</p>
            <h2 id="new-project-title">Register project</h2>
          </div>
          <button aria-label="Close" className="icon-button" onClick={onClose} type="button">×</button>
        </div>
        <form className="agent-form" onSubmit={submit}>
          <label>Organization
            <select required value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>
              {organizations.map((organization) => (
                <option key={organization.id} value={organization.id}>{organization.name}</option>
              ))}
            </select>
          </label>
          <label>Project name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Local repository path<input required value={path} onChange={(event) => setPath(event.target.value)} /></label>
          <label>Project description<textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <p className="form-note">The path must already exist on this machine. It becomes the working directory for assigned CLI agents.</p>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="ghost-button" onClick={onClose} type="button">Cancel</button>
            <button className="primary-button" disabled={submitting} type="submit">
              {submitting ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function NewOrganizationDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (input: CreateOrganizationInput) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await onCreate({ name, description });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to create organization');
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section aria-labelledby="new-organization-title" aria-modal="true" className="dialog compact-dialog" role="dialog">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">Company workspace</p>
            <h2 id="new-organization-title">Create organization</h2>
          </div>
          <button aria-label="Close" className="icon-button" onClick={onClose} type="button">×</button>
        </div>
        <form className="agent-form" onSubmit={submit}>
          <label>Organization name<input required value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>Description<textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <p className="form-note">Each organization gets its own board, projects, and agent hierarchy.</p>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="ghost-button" onClick={onClose} type="button">Cancel</button>
            <button className="primary-button" disabled={submitting} type="submit">
              {submitting ? 'Creating…' : 'Create organization'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function NewTaskDialog({
  projects,
  organizations,
  defaultProjectId,
  onClose,
  onCreate,
}: {
  projects: Project[];
  organizations: Organization[];
  defaultProjectId: string | null;
  onClose: () => void;
  onCreate: (projectId: string, input: Omit<CreateTaskInput, 'projectId'>) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(defaultProjectId ?? projects[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState<TaskStatus>('backlog');
  const [priority, setPriority] = useState<CreateTaskInput['priority']>('medium');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId) {
      setError('Register a project before creating a task');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(projectId, { title, description, status, priority });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to create task');
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section aria-labelledby="new-task-title" aria-modal="true" className="dialog compact-dialog" role="dialog">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">Selected development project</p>
            <h2 id="new-task-title">Create task</h2>
          </div>
          <button aria-label="Close" className="icon-button" onClick={onClose} type="button">×</button>
        </div>
        <form className="agent-form" onSubmit={submit}>
          <label>Project
            <select required value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {organizations.find((organization) => organization.id === project.organizationId)?.name ?? ''} · {project.name}
                </option>
              ))}
            </select>
          </label>
          <label>Task title<input required value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Task description<textarea rows={4} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <div className="form-grid two-columns">
            <label>Status
              <select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>
                {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((value) => (
                  <option key={value} value={value}>{STATUS_LABELS[value]}</option>
                ))}
              </select>
            </label>
            <label>Priority
              <select value={priority} onChange={(event) => setPriority(event.target.value as CreateTaskInput['priority'])}>
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>
          {error && <div className="form-error" role="alert">{error}</div>}
          <div className="dialog-actions">
            <button className="ghost-button" onClick={onClose} type="button">Cancel</button>
            <button className="primary-button" disabled={submitting} type="submit">
              {submitting ? 'Creating…' : 'Create task'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function DashboardView({
  stats,
  recentRuns,
  projects,
  organizations,
  onOpenOrganization,
  onNewTask,
}: {
  stats: DashboardStats | null;
  recentRuns: RecentRun[];
  projects: Project[];
  organizations: Organization[];
  onOpenOrganization: (organizationId: string, tab: OrgTab, projectId?: string) => void;
  onNewTask: () => void;
}) {
  const totalTasks = stats ? Object.values(stats.tasksByStatus).reduce((sum, n) => sum + n, 0) : 0;
  return (
    <section className="workspace-panel dashboard-panel" aria-labelledby="dashboard-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Mission control</p>
          <h2 id="dashboard-title">Dashboard</h2>
          <p>Every organization, team, skill, and run at a glance.</p>
        </div>
        <button className="primary-button" disabled={projects.length === 0} onClick={onNewTask} type="button">+ New task</button>
      </div>
      <div className="stat-grid">
        <article className="stat-card"><span>{stats?.organizations ?? '—'}</span><p>Organizations</p></article>
        <article className="stat-card"><span>{stats?.projects ?? '—'}</span><p>Projects</p></article>
        <article className="stat-card"><span>{stats?.orgAgents ?? '—'}</span><p>Agents</p></article>
        <article className="stat-card"><span>{stats?.skills ?? '—'}</span><p>Skills</p></article>
        <article className="stat-card"><span>{stats?.activeRuns ?? '—'}</span><p>Active runs</p></article>
        <article className="stat-card"><span>{stats ? totalTasks : '—'}</span><p>Tasks</p></article>
      </div>
      <div className="dashboard-columns">
        <div className="dashboard-block">
          <h3>Tasks by status</h3>
          <div className="status-ledger">
            {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((status) => (
              <button
                className="status-ledger-row"
                key={status}
                onClick={() => {
                  const project = projects[0];
                  if (project) onOpenOrganization(project.organizationId, 'board', project.id);
                }}
                type="button"
              >
                <span className={`status-dot status-${status}`} />
                <span>{STATUS_LABELS[status]}</span>
                <strong>{stats?.tasksByStatus[status] ?? 0}</strong>
              </button>
            ))}
          </div>
          <h3>Organizations</h3>
          <div className="org-quick-list">
            {organizations.map((organization) => (
              <button
                className="org-quick-row"
                key={organization.id}
                onClick={() => onOpenOrganization(organization.id, 'board')}
                type="button"
              >
                <span className="project-dot" style={{ background: organization.color }} />
                <span>{organization.name}</span>
                <small>Open board →</small>
              </button>
            ))}
          </div>
        </div>
        <div className="dashboard-block">
          <h3>Recent runs</h3>
          {recentRuns.length === 0 ? (
            <div className="empty-state compact-empty">
              <strong>No runs yet</strong>
              <span>Open an organization board and run a hierarchy on a task.</span>
            </div>
          ) : (
            <div className="run-list">
              {recentRuns.map((run) => (
                <article className="run-row" key={run.id}>
                  <span className={`run-status run-${run.status}`}>{run.status}</span>
                  <div className="run-detail">
                    <strong>{run.taskTitle}</strong>
                    <small>{run.projectName} · {run.mode} · {formatRunTime(run.createdAt)}</small>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function OrganizationsView({
  organizations,
  projects,
  agents,
  onOpenOrganization,
  onCreate,
}: {
  organizations: Organization[];
  projects: Project[];
  agents: OrgAgent[];
  onOpenOrganization: (organizationId: string, tab: OrgTab) => void;
  onCreate: (input: CreateOrganizationInput) => Promise<void>;
}) {
  const [showCreate, setShowCreate] = useState(false);
  return (
    <section className="workspace-panel" aria-labelledby="organizations-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Companies</p>
          <h2 id="organizations-title">Organizations</h2>
          <p>Each organization holds its own board, projects, and reporting hierarchy.</p>
        </div>
        <button className="primary-button" onClick={() => setShowCreate(true)} type="button">+ New organization</button>
      </div>
      <div className="organization-grid">
        {organizations.map((organization) => {
          const projectCount = projects.filter((project) => project.organizationId === organization.id).length;
          const agentCount = agents.filter((agent) => agent.organizationId === organization.id).length;
          return (
            <button
              className="organization-card"
              key={organization.id}
              onClick={() => onOpenOrganization(organization.id, 'board')}
              type="button"
            >
              <div className="organization-card-top">
                <span className="project-dot" style={{ background: organization.color }} />
                <h3>{organization.name}</h3>
              </div>
              {organization.description && <p>{organization.description}</p>}
              <div className="org-meta">
                <span>{projectCount} project{projectCount === 1 ? '' : 's'}</span>
                <span>{agentCount} agent{agentCount === 1 ? '' : 's'}</span>
              </div>
            </button>
          );
        })}
      </div>
      {showCreate && (
        <NewOrganizationDialog onClose={() => setShowCreate(false)} onCreate={onCreate} />
      )}
    </section>
  );
}

function TeamTree({ agents, runtimes, skills }: { agents: OrgAgent[]; runtimes: AgentRuntime[]; skills: Skill[] }) {
  const agentsById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const runtimesById = useMemo(() => new Map(runtimes.map((runtime) => [runtime.id, runtime])), [runtimes]);
  const skillsById = useMemo(() => new Map(skills.map((skill) => [skill.id, skill])), [skills]);
  const childrenByManager = useMemo(() => {
    const children = new Map<string | null, OrgAgent[]>();
    for (const agent of agents) {
      const siblings = children.get(agent.managerId) ?? [];
      siblings.push(agent);
      children.set(agent.managerId, siblings);
    }
    return children;
  }, [agents]);

  const renderBranch = (agent: OrgAgent, depth: number): React.ReactNode => (
    <div className="org-branch" key={agent.id}>
      <OrgCard agent={agent} agentsById={agentsById} runtimesById={runtimesById} skillsById={skillsById} depth={depth} />
      {(childrenByManager.get(agent.id) ?? []).map((child) => renderBranch(child, depth + 1))}
    </div>
  );

  const roots = childrenByManager.get(null) ?? [];
  if (agents.length === 0) {
    return (
      <div className="empty-state">
        <strong>No agents in this organization yet</strong>
        <span>Create a root coordinator, then add managers and specialists.</span>
      </div>
    );
  }
  return <div className="org-tree">{roots.map((root) => renderBranch(root, 0))}</div>;
}

function BoardView({
  board,
  canRunHierarchy,
  onRunHierarchy,
  runningTaskId,
}: {
  board: KanbanBoard;
  canRunHierarchy: boolean;
  onRunHierarchy: (taskId: string) => Promise<void>;
  runningTaskId: string | null;
}) {
  return (
    <section className="board" aria-label="Project Kanban board">
      {(Object.keys(STATUS_LABELS) as TaskStatus[]).map((status) => (
        <div className="kanban-column" key={status}>
          <div className="column-heading">
            <span className={`status-dot status-${status}`} />
            <h2>{STATUS_LABELS[status]}</h2>
            <span className="count-badge">{board[status].length}</span>
          </div>
          <div className="task-stack">
            {board[status].map((task) => (
              <article className="task-card" key={task.id}>
                <span className={`priority priority-${task.priority}`}>{task.priority}</span>
                <h3>{task.title}</h3>
                {task.description && <p>{task.description}</p>}
                <button
                  aria-label={`Run hierarchy for ${task.title}`}
                  className="task-action"
                  disabled={!canRunHierarchy || runningTaskId !== null}
                  onClick={() => { void onRunHierarchy(task.id); }}
                  type="button"
                >
                  {runningTaskId === task.id ? 'Running team…' : 'Run hierarchy'}
                </button>
              </article>
            ))}
            {board[status].length === 0 && <div className="column-empty">No tasks</div>}
          </div>
        </div>
      ))}
    </section>
  );
}

function OrganizationDetailView({
  organization,
  projects,
  agents,
  runtimes,
  skills,
  tab,
  selectedProjectId,
  board,
  projectTeam,
  runNotice,
  runningTaskId,
  onSelectTab,
  onSelectProject,
  onRunHierarchy,
  onNewProject,
  onNewTask,
  onNewAgent,
}: {
  organization: Organization;
  projects: Project[];
  agents: OrgAgent[];
  runtimes: AgentRuntime[];
  skills: Skill[];
  tab: OrgTab;
  selectedProjectId: string | null;
  board: KanbanBoard;
  projectTeam: OrgAgent[];
  runNotice: string | null;
  runningTaskId: string | null;
  onSelectTab: (tab: OrgTab) => void;
  onSelectProject: (projectId: string) => void;
  onRunHierarchy: (taskId: string) => Promise<void>;
  onNewProject: () => void;
  onNewTask: () => void;
  onNewAgent: () => void;
}) {
  const orgProjects = projects.filter((project) => project.organizationId === organization.id);
  const orgAgents = agents.filter((agent) => agent.organizationId === organization.id);
  const selectedProject = orgProjects.find((project) => project.id === selectedProjectId) ?? null;
  return (
    <section aria-labelledby="organization-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Organization</p>
          <h2 id="organization-title">
            <span className="project-dot inline-dot" style={{ background: organization.color }} />
            {organization.name}
          </h2>
          <p>{organization.description || 'Board, projects, and team for this organization.'}</p>
        </div>
        <div className="topbar-actions">
          <div className="tab-strip" role="tablist">
            <button
              aria-selected={tab === 'board'}
              className={tab === 'board' ? 'active' : ''}
              onClick={() => onSelectTab('board')}
              role="tab"
              type="button"
            >
              Board
            </button>
            <button
              aria-selected={tab === 'team'}
              className={tab === 'team' ? 'active' : ''}
              onClick={() => onSelectTab('team')}
              role="tab"
              type="button"
            >
              Team
            </button>
          </div>
          {tab === 'board' ? (
            <button className="primary-button" disabled={!selectedProject} onClick={onNewTask} type="button">+ New task</button>
          ) : (
            <button className="primary-button" onClick={onNewAgent} type="button">+ New agent</button>
          )}
        </div>
      </div>
      {runNotice && <div className="run-notice" role="status">{runNotice}</div>}
      {tab === 'board' && (
        <>
          <div className="project-pills">
            {orgProjects.map((project) => (
              <button
                className={project.id === selectedProjectId ? 'active' : ''}
                key={project.id}
                onClick={() => onSelectProject(project.id)}
                type="button"
              >
                <span className="project-dot" style={{ background: project.color }} />
                {project.name}
              </button>
            ))}
            <button className="add-pill" onClick={onNewProject} type="button">+ Project</button>
          </div>
          {selectedProject ? (
            <BoardView
              board={board}
              canRunHierarchy={projectTeam.some((agent) => agent.managerId === null)}
              onRunHierarchy={onRunHierarchy}
              runningTaskId={runningTaskId}
            />
          ) : (
            <div className="empty-state">
              <strong>No projects in this organization</strong>
              <span>Register a local repository to give this organization a board.</span>
            </div>
          )}
        </>
      )}
      {tab === 'team' && <TeamTree agents={orgAgents} runtimes={runtimes} skills={skills} />}
    </section>
  );
}

function SkillsView({ skills }: { skills: Skill[] }) {
  const grouped = useMemo(() => {
    const groups = new Map<SkillCategory, Skill[]>();
    for (const skill of skills) {
      const bucket = groups.get(skill.category) ?? [];
      bucket.push(skill);
      groups.set(skill.category, bucket);
    }
    return groups;
  }, [skills]);
  return (
    <section className="workspace-panel" aria-labelledby="skills-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Capability library</p>
          <h2 id="skills-title">Skills</h2>
          <p>Assign skills to agents — their guidance is injected into every run prompt. Ideal for design and marketing teams.</p>
        </div>
      </div>
      {CATEGORY_ORDER.filter((category) => (grouped.get(category) ?? []).length > 0).map((category) => (
        <div className="skill-category" key={category}>
          <h3 className="skill-category-title">{CATEGORY_LABELS[category]}</h3>
          <div className="skill-grid">
            {(grouped.get(category) ?? []).map((skill) => (
              <article className="skill-card" key={skill.id}>
                <div className="skill-card-top">
                  <h4>{skill.name}</h4>
                  {skill.builtin && <span className="builtin-badge">built-in</span>}
                </div>
                <p>{skill.description}</p>
                {skill.installCommand && (
                  <code className="install-command">{skill.installCommand}</code>
                )}
                <details className="skill-details">
                  <summary>Prompt guidance</summary>
                  <p>{skill.instructions}</p>
                </details>
                {skill.sourceUrl && (
                  <a className="skill-link" href={skill.sourceUrl} rel="noreferrer" target="_blank">
                    Source repository ↗
                  </a>
                )}
              </article>
            ))}
          </div>
        </div>
      ))}
      {skills.length === 0 && (
        <div className="empty-state">
          <strong>No skills registered</strong>
          <span>Built-in skills are seeded on first launch.</span>
        </div>
      )}
    </section>
  );
}

const OPTION_LABELS: Array<{ key: RuntimeOptionKey; label: string; hint: string }> = [
  { key: 'model', label: 'Model flag', hint: '--model {value}' },
  { key: 'speed', label: 'Speed flag', hint: '--fast' },
  { key: 'effort', label: 'Effort flag', hint: '-c model_reasoning_effort={value}' },
];

function parseEnvDraft(draft: string): AgentRuntime['env'] | null {
  const env: AgentRuntime['env'] = {};
  for (const rawLine of draft.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) return null;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
    env[key] = line.slice(separator + 1).trim();
  }
  return env;
}

function RuntimeOptionsEditor({
  runtime,
  onSave,
}: {
  runtime: AgentRuntime;
  onSave: (agentId: string, patch: RuntimeOptionsPatch) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({
    model: (runtime.optionTemplates.model ?? []).join(' '),
    speed: (runtime.optionTemplates.speed ?? []).join(' '),
    effort: (runtime.optionTemplates.effort ?? []).join(' '),
  }));
  const [valueDrafts, setValueDrafts] = useState<Record<string, string>>(() => ({
    model: (runtime.optionValues.model ?? []).join(', '),
    speed: (runtime.optionValues.speed ?? []).join(', '),
    effort: (runtime.optionValues.effort ?? []).join(', '),
  }));
  const [envDraft, setEnvDraft] = useState(() =>
    Object.entries(runtime.env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  async function save(): Promise<void> {
    setState('saving');
    try {
      const optionTemplates: AgentRuntime['optionTemplates'] = {};
      const optionValues: AgentRuntime['optionValues'] = {};
      for (const { key } of OPTION_LABELS) {
        const trimmed = drafts[key]?.trim();
        if (trimmed) optionTemplates[key] = trimmed.split(/\s+/);
        const values = (valueDrafts[key] ?? '')
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (values.length > 0) optionValues[key] = values;
      }
      const env = parseEnvDraft(envDraft);
      if (env === null) {
        setState('error');
        return;
      }
      await onSave(runtime.id, { optionTemplates, optionValues, env });
      setState('saved');
      setTimeout(() => setState('idle'), 2000);
    } catch {
      setState('error');
    }
  }

  return (
    <div className="options-editor">
      {OPTION_LABELS.map(({ key, label, hint }) => (
        <div className="option-row" key={key}>
          <label>
            {label}
            <input
              placeholder={hint}
              value={drafts[key] ?? ''}
              onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
            />
          </label>
          <label>
            {`${label.replace('flag', 'values')}`}
            <input
              placeholder="comma-separated provider choices"
              value={valueDrafts[key] ?? ''}
              onChange={(event) => setValueDrafts((current) => ({ ...current, [key]: event.target.value }))}
            />
          </label>
        </div>
      ))}
      <label>
        Environment (KEY=VALUE per line, ${'{VAR}'} reads host env)
        <textarea
          rows={3}
          placeholder="ANTHROPIC_BASE_URL=https://api.example.com/anthropic"
          value={envDraft}
          onChange={(event) => setEnvDraft(event.target.value)}
        />
      </label>
      <button className="ghost-button" disabled={state === 'saving'} onClick={() => { void save(); }} type="button">
        {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved ✓' : state === 'error' ? 'Save failed' : 'Save flags'}
      </button>
    </div>
  );
}

function RuntimesView({
  runtimes,
  onSaveOptions,
}: {
  runtimes: AgentRuntime[];
  onSaveOptions: (agentId: string, patch: RuntimeOptionsPatch) => Promise<void>;
}) {
  return (
    <section className="workspace-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Official CLI sessions</p>
          <h2>Agent runtimes</h2>
          <p>Authentication remains owned by each installed provider CLI. Option flags map agent model / speed / effort tuning onto CLI arguments; include {'{value}'} where the setting goes. Value lists feed the dropdowns in agent creation — keep them aligned with the provider's real options.</p>
        </div>
      </div>
      <div className="runtime-grid">
        {runtimes.map((runtime) => (
          <article className="runtime-card runtime-card-wide" key={runtime.id}>
            <div className="runtime-card-head">
              <RuntimeMark runtimeId={runtime.id} />
              <div>
                <h3>{runtime.name}</h3>
                <p>{runtime.command}</p>
                {runtime.env.ANTHROPIC_BASE_URL && (
                  <p className="runtime-endpoint">Endpoint: {runtime.env.ANTHROPIC_BASE_URL}</p>
                )}
              </div>
              <span className={runtime.enabled ? 'health-ready' : 'health-offline'}>
                {runtime.enabled ? 'Configured' : 'Disabled'}
              </span>
            </div>
            <RuntimeOptionsEditor runtime={runtime} onSave={onSaveOptions} />
          </article>
        ))}
      </div>
    </section>
  );
}

export function App() {
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [runtimes, setRuntimes] = useState<AgentRuntime[]>([]);
  const [orgAgents, setOrgAgents] = useState<OrgAgent[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [projectTeam, setProjectTeam] = useState<OrgAgent[]>([]);
  const [selectedOrganizationId, setSelectedOrganizationId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [orgTab, setOrgTab] = useState<OrgTab>('board');
  const [board, setBoard] = useState<KanbanBoard>(EMPTY_BOARD);
  const [view, setView] = useState<View>('dashboard');
  const [showProjectCreate, setShowProjectCreate] = useState(false);
  const [showTaskCreate, setShowTaskCreate] = useState(false);
  const [showAgentCreate, setShowAgentCreate] = useState(false);
  const [showOrganizationCreate, setShowOrganizationCreate] = useState(false);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      getJson<{ organizations: Organization[] }>('/api/organizations'),
      getJson<{ projects: Project[] }>('/api/projects'),
      getJson<{ agents: AgentRuntime[] }>('/api/agents'),
      getJson<{ agents: OrgAgent[] }>('/api/org-agents'),
      getJson<{ skills: Skill[] }>('/api/skills'),
      getJson<DashboardStats>('/api/stats'),
      getJson<{ runs: RecentRun[] }>('/api/runs/recent'),
    ]).then(([organizationData, projectData, runtimeData, agentData, skillData, statsData, runData]) => {
      if (cancelled) return;
      setOrganizations(organizationData.organizations);
      setProjects(projectData.projects);
      setRuntimes(runtimeData.agents);
      setOrgAgents(agentData.agents);
      setSkills(skillData.skills);
      setStats(statsData);
      setRecentRuns(runData.runs);
      setSelectedOrganizationId(organizationData.organizations[0]?.id ?? null);
      setSelectedProjectId(projectData.projects[0]?.id ?? null);
      setLoading(false);
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : 'Unable to load the dashboard');
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedProjectId || view !== 'organization') return;
    let cancelled = false;
    void Promise.all([
      getJson<KanbanBoard>(`/api/projects/${selectedProjectId}/board`),
      getJson<{ agents: OrgAgent[] }>(`/api/projects/${selectedProjectId}/team`),
    ]).then(([boardData, teamData]) => {
      if (!cancelled) {
        setBoard(boardData);
        setProjectTeam(teamData.agents);
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'Unable to load the project');
    });
    return () => { cancelled = true; };
  }, [selectedProjectId, view]);

  async function refreshActivity(): Promise<void> {
    try {
      const [statsData, runData] = await Promise.all([
        getJson<DashboardStats>('/api/stats'),
        getJson<{ runs: RecentRun[] }>('/api/runs/recent'),
      ]);
      setStats(statsData);
      setRecentRuns(runData.runs);
    } catch {
      // non-fatal: stale dashboard numbers until the next refresh
    }
  }

  function openOrganization(organizationId: string, tab: OrgTab, projectId?: string): void {
    setSelectedOrganizationId(organizationId);
    setOrgTab(tab);
    setView('organization');
    const fallback = projects.find((project) => project.organizationId === organizationId);
    const nextProject = projectId ?? fallback?.id ?? null;
    if (nextProject) setSelectedProjectId(nextProject);
    setRunNotice(null);
  }

  const selectedOrganization = organizations.find((organization) => organization.id === selectedOrganizationId) ?? null;

  async function createOrganization(input: CreateOrganizationInput): Promise<void> {
    const organization = await sendJson<Organization>('/api/organizations', 'POST', input);
    setOrganizations((current) => [...current, organization]);
    await refreshActivity();
    openOrganization(organization.id, 'board');
  }

  async function createOrgAgent(input: CreateOrgAgentInput): Promise<void> {
    const agent = await sendJson<OrgAgent>('/api/org-agents', 'POST', input);
    if (selectedProjectId) {
      const project = projects.find((candidate) => candidate.id === selectedProjectId);
      if (project && project.organizationId === agent.organizationId) {
        await sendJson<undefined>(`/api/projects/${selectedProjectId}/team/${agent.id}`, 'PUT');
        setProjectTeam((current) => [...current, agent]);
      }
    }
    setOrgAgents((current) => [...current, agent]);
    await refreshActivity();
  }

  async function createProject(input: CreateProjectInput): Promise<void> {
    const project = await sendJson<Project>('/api/projects', 'POST', input);
    setProjects((current) => [...current, project]);
    await refreshActivity();
    openOrganization(project.organizationId, 'board', project.id);
  }

  async function createTask(projectId: string, input: Omit<CreateTaskInput, 'projectId'>): Promise<void> {
    const task = await sendJson<Task>(`/api/projects/${projectId}/tasks`, 'POST', input);
    if (projectId === selectedProjectId) {
      setBoard((current) => ({
        ...current,
        [task.status]: [...current[task.status], task],
      }));
    }
    await refreshActivity();
  }

  async function runHierarchy(taskId: string): Promise<void> {
    const root = projectTeam.find((agent) => agent.managerId === null);
    if (!root || !selectedProjectId) {
      setRunNotice('Assign a root organizational agent to this project first.');
      return;
    }
    setRunningTaskId(taskId);
    setRunNotice(null);
    try {
      await sendJson(`/api/tasks/${taskId}/hierarchy`, 'POST', { rootOrgAgentId: root.id });
      const refreshed = await getJson<KanbanBoard>(`/api/projects/${selectedProjectId}/board`);
      setBoard(refreshed);
      setRunNotice('Hierarchy run completed. The task is ready for review.');
    } catch (reason) {
      setRunNotice(reason instanceof Error ? reason.message : 'Hierarchy run failed');
    } finally {
      setRunningTaskId(null);
      void refreshActivity();
    }
  }

  async function saveRuntimeOptions(agentId: string, patch: RuntimeOptionsPatch): Promise<void> {
    const updated = await sendJson<AgentRuntime>(`/api/agents/${agentId}/options`, 'PATCH', patch);
    setRuntimes((current) => current.map((runtime) => (runtime.id === agentId ? updated : runtime)));
  }

  const viewTitle = view === 'dashboard'
    ? 'Dashboard'
    : view === 'organizations'
      ? 'Organizations'
      : view === 'organization'
        ? (selectedOrganization?.name ?? 'Organization')
        : view === 'skills'
          ? 'Skills'
          : 'Runtime registry';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">AI</span>
          <div><strong>AI Labs</strong><span>Platform</span></div>
        </div>
        <nav className="primary-nav" aria-label="Workspace views">
          <button className={view === 'dashboard' ? 'active' : ''} onClick={() => setView('dashboard')} type="button">
            <span aria-hidden="true">◧</span> Dashboard
          </button>
          <button className={view === 'organizations' ? 'active' : ''} onClick={() => setView('organizations')} type="button">
            <span aria-hidden="true">▤</span> Organizations
          </button>
          <button className={view === 'skills' ? 'active' : ''} onClick={() => setView('skills')} type="button">
            <span aria-hidden="true">✦</span> Skills
          </button>
          <button className={view === 'runtimes' ? 'active' : ''} onClick={() => setView('runtimes')} type="button">
            <span aria-hidden="true">◇</span> Runtimes
          </button>
        </nav>
        <div className="sidebar-section">
          <div className="sidebar-label">
            <span>Organizations</span>
            <button type="button" aria-label="Add organization" onClick={() => setShowOrganizationCreate(true)}>+</button>
          </div>
          <div className="project-list">
            {organizations.map((organization) => (
              <button
                className={organization.id === selectedOrganizationId && view === 'organization' ? 'selected' : ''}
                key={organization.id}
                onClick={() => openOrganization(organization.id, 'board')}
                type="button"
              >
                <span className="project-dot" style={{ background: organization.color }} />
                {organization.name}
              </button>
            ))}
          </div>
        </div>
        <div className="sidebar-section">
          <div className="sidebar-label">
            <span>Projects</span>
            <button type="button" aria-label="Add project" onClick={() => setShowProjectCreate(true)}>+</button>
          </div>
          <div className="project-list">
            {projects.map((project) => (
              <button
                className={project.id === selectedProjectId && view === 'organization' ? 'selected' : ''}
                key={project.id}
                onClick={() => openOrganization(project.organizationId, 'board', project.id)}
                type="button"
              >
                <span className="project-dot" style={{ background: project.color }} />
                {project.name}
              </button>
            ))}
          </div>
        </div>
        <div className="local-badge"><span className="health-ready" />Local only · credentials excluded</div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div>
            <p className="eyebrow">{selectedOrganization?.description || 'Multi-company agent orchestration'}</p>
            <h1>{viewTitle}</h1>
          </div>
          <div className="topbar-actions">
            <span className="command-hint">Ctrl K</span>
            <button
              className="primary-button"
              disabled={projects.length === 0}
              onClick={() => setShowTaskCreate(true)}
              type="button"
            >
              + New task
            </button>
          </div>
        </header>

        <div className="content-area">
          {loading && <div className="loading-state">Loading local workspace…</div>}
          {error && <div className="error-banner" role="alert">{error}</div>}
          {!loading && !error && view === 'dashboard' && (
            <DashboardView
              stats={stats}
              recentRuns={recentRuns}
              projects={projects}
              organizations={organizations}
              onOpenOrganization={openOrganization}
              onNewTask={() => setShowTaskCreate(true)}
            />
          )}
          {!loading && !error && view === 'organizations' && (
            <OrganizationsView
              organizations={organizations}
              projects={projects}
              agents={orgAgents}
              onOpenOrganization={openOrganization}
              onCreate={createOrganization}
            />
          )}
          {!loading && !error && view === 'organization' && selectedOrganization && (
            <OrganizationDetailView
              organization={selectedOrganization}
              projects={projects}
              agents={orgAgents}
              runtimes={runtimes}
              skills={skills}
              tab={orgTab}
              selectedProjectId={selectedProjectId}
              board={board}
              projectTeam={projectTeam}
              runNotice={runNotice}
              runningTaskId={runningTaskId}
              onSelectTab={setOrgTab}
              onSelectProject={setSelectedProjectId}
              onRunHierarchy={runHierarchy}
              onNewProject={() => setShowProjectCreate(true)}
              onNewTask={() => setShowTaskCreate(true)}
              onNewAgent={() => setShowAgentCreate(true)}
            />
          )}
          {!loading && !error && view === 'skills' && <SkillsView skills={skills} />}
          {!loading && !error && view === 'runtimes' && (
            <RuntimesView runtimes={runtimes} onSaveOptions={saveRuntimeOptions} />
          )}
        </div>
      </main>
      {showProjectCreate && organizations.length > 0 && (
        <NewProjectDialog
          organizations={organizations}
          defaultOrganizationId={selectedOrganizationId ?? organizations[0]!.id}
          onClose={() => setShowProjectCreate(false)}
          onCreate={createProject}
        />
      )}
      {showTaskCreate && (
        <NewTaskDialog
          projects={projects}
          organizations={organizations}
          defaultProjectId={selectedProjectId}
          onClose={() => setShowTaskCreate(false)}
          onCreate={createTask}
        />
      )}
      {showAgentCreate && organizations.length > 0 && (
        <NewAgentDialog
          agents={orgAgents}
          runtimes={runtimes}
          skills={skills}
          organizations={organizations}
          defaultOrganizationId={selectedOrganizationId ?? organizations[0]!.id}
          onClose={() => setShowAgentCreate(false)}
          onCreate={createOrgAgent}
        />
      )}
      {showOrganizationCreate && (
        <NewOrganizationDialog onClose={() => setShowOrganizationCreate(false)} onCreate={createOrganization} />
      )}
    </div>
  );
}
