import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/App.js';

const organization = {
  id: 'default-org',
  name: 'AI Labs',
  description: 'Default organization',
  color: '#7170ff',
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
};

const project = {
  id: 'project-1',
  organizationId: 'default-org',
  name: 'Atlas',
  path: '/work/atlas',
  description: 'Local-first developer platform',
  color: '#7170ff',
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
};

const runtimes = [
  { id: 'hermes', name: 'Hermes Coordinator', kind: 'hermes', enabled: true, optionTemplates: {}, optionValues: {}, env: {} },
  {
    id: 'claude',
    name: 'Claude Code',
    kind: 'claude',
    enabled: true,
    optionTemplates: { model: ['--model', '{value}'], effort: ['--effort', '{value}'] },
    optionValues: {
      model: ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-haiku-4-5'],
      effort: ['low', 'medium', 'high', 'xhigh'],
    },
    env: {},
  },
  {
    id: 'codex',
    name: 'OpenAI Codex',
    kind: 'codex',
    enabled: true,
    optionTemplates: { model: ['--model', '{value}'], effort: ['-c', 'model_reasoning_effort={value}'] },
    optionValues: {
      model: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      effort: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    },
    env: {},
  },
];

const skills = [
  {
    id: 'skill-taste',
    name: 'Taste Skill',
    slug: 'design-taste-frontend',
    description: 'Anti-slop frontend design framework for stronger interfaces.',
    category: 'design',
    sourceUrl: 'https://github.com/Leonxlnx/taste-skill',
    installCommand: 'npx skills add https://github.com/Leonxlnx/taste-skill',
    instructions: 'Tune DESIGN_VARIANCE, MOTION_INTENSITY, and VISUAL_DENSITY.',
    builtin: true,
    enabled: true,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  },
];

const orgAgents = [
  {
    id: 'chief',
    organizationId: 'default-org',
    name: 'Hermes',
    jobTitle: 'Chief Technology Officer',
    department: 'Executive',
    jobFunction: 'Coordinate technical strategy.',
    responsibilities: 'Route work and approve final recommendations.',
    instructions: '',
    runtimeId: 'hermes',
    managerId: null,
    authorityLevel: 100,
    canDelegate: true,
    model: null,
    speed: null,
    effort: null,
    skillIds: [],
    enabled: true,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
  },
  {
    id: 'lead',
    organizationId: 'default-org',
    name: 'Claudia',
    jobTitle: 'Lead Software Architect',
    department: 'Engineering',
    jobFunction: 'Own architecture and technical design.',
    responsibilities: 'Review boundaries and implementation plans.',
    instructions: '',
    runtimeId: 'claude',
    managerId: 'chief',
    authorityLevel: 80,
    canDelegate: true,
    model: 'claude-sonnet-4-5',
    speed: null,
    effort: null,
    skillIds: ['skill-taste'],
    enabled: true,
    createdAt: '2026-08-09T00:00:01.000Z',
    updatedAt: '2026-08-09T00:00:01.000Z',
  },
  {
    id: 'engineer',
    organizationId: 'default-org',
    name: 'Cody',
    jobTitle: 'Senior Implementation Engineer',
    department: 'Engineering',
    jobFunction: 'Implement and test approved designs.',
    responsibilities: 'Write minimal code and verification evidence.',
    instructions: '',
    runtimeId: 'codex',
    managerId: 'lead',
    authorityLevel: 50,
    canDelegate: false,
    model: null,
    speed: null,
    effort: null,
    skillIds: [],
    enabled: true,
    createdAt: '2026-08-09T00:00:02.000Z',
    updatedAt: '2026-08-09T00:00:02.000Z',
  },
];

const existingTask = {
  id: 'task-existing',
  projectId: project.id,
  title: 'Threat model plugins',
  description: 'Review process and credential boundaries.',
  status: 'ready',
  priority: 'high',
  assignedAgentId: null,
  position: 0,
  createdAt: '2026-08-09T00:00:00.000Z',
  updatedAt: '2026-08-09T00:00:00.000Z',
};

const stats = {
  organizations: 1,
  projects: 1,
  orgAgents: 3,
  skills: 1,
  activeRuns: 0,
  tasksByStatus: { backlog: 0, ready: 1, in_progress: 0, review: 0, done: 0, blocked: 0 },
};

const recentRuns = [
  {
    id: 'run-1',
    taskId: 'task-existing',
    taskTitle: 'Threat model plugins',
    projectId: project.id,
    projectName: project.name,
    organizationId: organization.id,
    mode: 'hierarchy',
    status: 'completed',
    error: null,
    createdAt: '2026-08-09T00:00:10.000Z',
    finishedAt: '2026-08-09T00:01:10.000Z',
  },
];

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  }));
}

async function openOrganizationBoard(): Promise<void> {
  await screen.findByText('Mission control');
  fireEvent.click(screen.getAllByRole('button', { name: 'AI Labs' })[0]!);
  await screen.findByText('Threat model plugins');
}

describe('orchestrator dashboard', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/organizations') return jsonResponse({ organizations: [organization] });
      if (url === '/api/projects' && init?.method === 'POST') {
        const inputProject = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({
          ...project,
          ...inputProject,
          id: 'project-2',
          createdAt: '2026-08-09T00:00:04.000Z',
          updatedAt: '2026-08-09T00:00:04.000Z',
        }, 201);
      }
      if (url === '/api/projects') return jsonResponse({ projects: [project] });
      if (url === '/api/agents' && init?.method === 'PATCH') return jsonResponse({});
      if (url === '/api/agents/hermes/options' && init?.method === 'PATCH') {
        return jsonResponse({ ...runtimes[0], optionTemplates: { model: ['--model', '{value}'] } });
      }
      if (url === '/api/agents') return jsonResponse({ agents: runtimes });
      if (url === '/api/org-agents' && init?.method === 'POST') {
        const inputAgent = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({
          instructions: '',
          managerId: null,
          model: null,
          speed: null,
          effort: null,
          skillIds: [],
          ...inputAgent,
          id: 'new-agent',
          enabled: true,
          createdAt: '2026-08-09T00:00:03.000Z',
          updatedAt: '2026-08-09T00:00:03.000Z',
        }, 201);
      }
      if (url === '/api/org-agents') return jsonResponse({ agents: orgAgents });
      if (url === '/api/skills') return jsonResponse({ skills });
      if (url === '/api/stats') return jsonResponse(stats);
      if (url === '/api/runs/recent') return jsonResponse({ runs: recentRuns });
      if (url === `/api/projects/${project.id}/team/new-agent` && init?.method === 'PUT') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === `/api/projects/${project.id}/team`) return jsonResponse({ agents: orgAgents });
      if (url === `/api/projects/${project.id}/tasks` && init?.method === 'POST') {
        const inputTask = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({
          ...inputTask,
          id: 'task-1',
          projectId: project.id,
          assignedAgentId: null,
          position: 0,
          createdAt: '2026-08-09T00:00:05.000Z',
          updatedAt: '2026-08-09T00:00:05.000Z',
        }, 201);
      }
      if (url === `/api/projects/${project.id}/board`) {
        return jsonResponse({ backlog: [], ready: [existingTask], in_progress: [], review: [], done: [], blocked: [] });
      }
      if (url === '/api/tasks/task-existing/hierarchy' && init?.method === 'POST') {
        return jsonResponse({
          run: { id: 'run-1', mode: 'hierarchy', status: 'completed', rootOrgAgentId: 'chief' },
          messages: [],
        }, 201);
      }
      if (url === '/api/projects/project-2/board') {
        return jsonResponse({ backlog: [], ready: [], in_progress: [], review: [], done: [], blocked: [] });
      }
      if (url === '/api/projects/project-2/team') return jsonResponse({ agents: [] });
      // AdjudicationReportView (fix round 1) is reachable from its own nav
      // item now; any date it asks for answers "no report" here, since none
      // of this file's tests need real report content, only that the route
      // is reached at all.
      if (url.startsWith('/api/adjudication-reports/')) return jsonResponse(null);
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens on the dashboard with stats, organizations, and recent runs', async () => {
    render(<App />);

    expect(await screen.findByText('Mission control')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: 'Dashboard' })).not.toHaveLength(0);
    expect(screen.getAllByText('Organizations').length).toBeGreaterThan(0);
    expect(screen.getByText('Active runs')).toBeInTheDocument();
    expect(screen.getByText('Recent runs')).toBeInTheDocument();
    expect(screen.getByText('Threat model plugins')).toBeInTheDocument();
    expect(screen.getByText('Tasks by status')).toBeInTheDocument();

    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/stats'));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/runs/recent'));
  });

  it('nests the board inside the organization and runs a hierarchy from it', async () => {
    render(<App />);
    await openOrganizationBoard();

    expect(screen.getByRole('tab', { name: 'Board' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('button', { name: /run hierarchy for threat model plugins/i }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/tasks/task-existing/hierarchy',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ rootOrgAgentId: 'chief' }),
      }),
    ));
    expect(await screen.findByText(/hierarchy run completed/i)).toBeInTheDocument();
  });

  it('shows the reporting hierarchy with tuning and skill pills on the team tab', async () => {
    render(<App />);
    await openOrganizationBoard();
    fireEvent.click(screen.getByRole('tab', { name: 'Team' }));

    expect(await screen.findByText('Chief Technology Officer')).toBeInTheDocument();
    expect(screen.getByText('Lead Software Architect')).toBeInTheDocument();
    expect(screen.getByText('Senior Implementation Engineer')).toBeInTheDocument();
    expect(screen.getByText(/reports to hermes/i)).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument();
    expect(screen.getByText('Taste Skill')).toBeInTheDocument();
  });

  it('creates an agent with dropdown model and effort tuning plus an assigned skill', async () => {
    render(<App />);
    await openOrganizationBoard();
    fireEvent.click(screen.getByRole('tab', { name: 'Team' }));
    fireEvent.click(await screen.findByRole('button', { name: /new agent/i }));

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Kim' } });
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Security Reviewer' } });
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'Security' } });
    fireEvent.change(screen.getByLabelText('Job function'), { target: { value: 'Challenge unsafe implementation choices.' } });
    fireEvent.change(screen.getByLabelText('Responsibilities'), { target: { value: 'Audit code and report evidence.' } });
    fireEvent.change(screen.getByLabelText('Runtime'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByLabelText('Reports to'), { target: { value: 'chief' } });

    expect(screen.getByLabelText('Speed')).toBeDisabled();
    // Model and effort are dropdowns fed by the provider's real option list.
    const modelSelect = screen.getByLabelText('Model') as HTMLSelectElement;
    expect(modelSelect.tagName).toBe('SELECT');
    expect(Array.from(modelSelect.options).map((option) => option.value)).toEqual([
      '',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    fireEvent.change(modelSelect, { target: { value: 'gpt-5.6-luna' } });
    const effortSelect = screen.getByLabelText('Effort') as HTMLSelectElement;
    expect(Array.from(effortSelect.options).map((option) => option.value)).toEqual([
      '',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    fireEvent.change(effortSelect, { target: { value: 'high' } });
    fireEvent.click(screen.getByLabelText(/taste skill/i));
    fireEvent.click(screen.getByRole('button', { name: /create agent/i }));

    expect(await screen.findByText('Security Reviewer')).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/org-agents',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"model":"gpt-5.6-luna","speed":null,"effort":"high","skillIds":["skill-taste"]'),
      }),
    ));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/project-1/team/new-agent',
      expect.objectContaining({ method: 'PUT' }),
    ));
  });

  it('registers another local development project from the sidebar', async () => {
    render(<App />);
    await screen.findByText('Mission control');
    fireEvent.click(screen.getByLabelText('Add project'));

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: 'Nova' } });
    fireEvent.change(screen.getByLabelText('Local repository path'), { target: { value: '/work/nova' } });
    fireEvent.change(screen.getByLabelText('Project description'), { target: { value: 'Second local project' } });
    fireEvent.click(screen.getByRole('button', { name: /create project/i }));

    expect((await screen.findAllByText('Nova')).length).toBeGreaterThan(0);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"organizationId":"default-org"'),
      }),
    ));
  });

  it('creates a prioritized task on the selected project board', async () => {
    render(<App />);
    await openOrganizationBoard();
    fireEvent.click(screen.getAllByRole('button', { name: /new task/i })[0]!);

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Audit credential boundary' } });
    fireEvent.change(screen.getByLabelText('Task description'), { target: { value: 'Verify that no OAuth tokens enter SQLite.' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'ready' } });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: /create task/i }));

    expect(await screen.findByText('Audit credential boundary')).toBeInTheDocument();
    expect(screen.getAllByText('high')).toHaveLength(2);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/project-1/tasks',
      expect.objectContaining({ method: 'POST' }),
    ));
  });

  it('lists the seeded design and marketing skills on the skills view', async () => {
    render(<App />);
    await screen.findByText('Mission control');
    fireEvent.click(screen.getByRole('button', { name: /skills/i }));

    expect(await screen.findByText('Taste Skill')).toBeInTheDocument();
    expect(screen.getByText(/anti-slop frontend design/i)).toBeInTheDocument();
    expect(screen.getByText('npx skills add https://github.com/Leonxlnx/taste-skill')).toBeInTheDocument();
    expect(screen.getByText('built-in')).toBeInTheDocument();
  });

  it('saves provider option flags, values, and environment from the runtimes view', async () => {
    render(<App />);
    await screen.findByText('Mission control');
    fireEvent.click(screen.getByRole('button', { name: /runtimes/i }));

    const modelFlags = await screen.findAllByLabelText('Model flag');
    fireEvent.change(modelFlags[0]!, { target: { value: '--model {value}' } });
    fireEvent.click(screen.getAllByRole('button', { name: /save flags/i })[0]!);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/agents/hermes/options',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          optionTemplates: { model: ['--model', '{value}'] },
          optionValues: {},
          env: {},
        }),
      }),
    ));
  });

  it('opens the daily adjudication report from its own nav item (fix round 1: it was reachable by nothing before)', async () => {
    vi.setSystemTime(new Date('2026-08-11T12:00:00.000Z'));
    render(<App />);
    await screen.findByText('Mission control');
    fireEvent.click(screen.getByRole('button', { name: /report/i }));

    expect(await screen.findByText('Daily report')).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/adjudication-reports/2026-08-11'));
    // Eight sections render even here, from a live nav click rather than a
    // directly-rendered component in the view's own test file.
    expect(screen.getByText('P0 escalations')).toBeInTheDocument();
    expect(screen.getByText('Next work item')).toBeInTheDocument();

    vi.useRealTimers();
  });
});
