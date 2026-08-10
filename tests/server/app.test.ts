import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';

describe('orchestrator API', () => {
  let database: OrchestratorDatabase | undefined;
  const directories: string[] = [];

  afterEach(async () => {
    database?.close();
    database = undefined;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates a registered project and a task visible on its board', async () => {
    database = createDatabase(':memory:');
    const projectPath = mkdtempSync(join(tmpdir(), 'orchestrator-project-'));
    directories.push(projectPath);
    const app = buildApp({
      database,
      invoke: async ({ runtime }) => `response from ${runtime.id}`,
    });

    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: {
        name: 'API Project',
        path: projectPath,
        description: 'Created through the local API',
      },
    });
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json<{ id: string }>();

    const taskResponse = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/tasks`,
      payload: { title: 'Wire the board', priority: 'high' },
    });
    expect(taskResponse.statusCode).toBe(201);
    const task = taskResponse.json<{ id: string }>();

    const boardResponse = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/board`,
    });
    expect(boardResponse.statusCode).toBe(200);
    expect(boardResponse.json<{ backlog: Array<{ id: string }> }>().backlog[0]?.id).toBe(task.id);

    const moveResponse = await app.inject({
      method: 'PATCH',
      url: `/api/tasks/${task.id}/move`,
      payload: { status: 'in_progress', position: 0 },
    });
    expect(moveResponse.statusCode).toBe(200);
    expect(moveResponse.json<{ status: string }>().status).toBe('in_progress');

    const movedBoard = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/board`,
    });
    expect(movedBoard.json<{ in_progress: Array<{ id: string }> }>().in_progress[0]?.id).toBe(
      task.id,
    );

    await app.close();
  });

  it('runs a bounded council and returns its attributed transcript', async () => {
    database = createDatabase(':memory:');
    const projectPath = mkdtempSync(join(tmpdir(), 'orchestrator-project-'));
    directories.push(projectPath);
    const app = buildApp({
      database,
      invoke: async ({ runtime, prompt }) => {
        const phase = prompt.match(/\[PHASE:(\w+)\]/)?.[1] ?? 'unknown';
        return `${phase} from ${runtime.id}`;
      },
    });
    const project = database.createProject({ name: 'Council API', path: projectPath });
    const task = database.createTask({ projectId: project.id, title: 'Reach consensus' });

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/council`,
      payload: { participantAgentIds: ['kimi', 'claude', 'codex'] },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      run: { id: string; status: string };
      messages: Array<{ phase: string; agentId: string }>;
    }>();
    expect(body.run.status).toBe('completed');
    expect(body.messages).toHaveLength(7);
    expect(body.messages.at(-1)).toMatchObject({ phase: 'synthesis', agentId: 'hermes' });

    const transcript = await app.inject({
      method: 'GET',
      url: `/api/runs/${body.run.id}/messages`,
    });
    expect(transcript.statusCode).toBe(200);
    expect(transcript.json<{ messages: unknown[] }>().messages).toHaveLength(7);

    await app.close();
  });

  it('registers and probes an extensible custom agent runtime', async () => {
    database = createDatabase(':memory:');
    const app = buildApp({
      database,
      invoke: async ({ runtime }) => `response from ${runtime.id}`,
    });

    const createdResponse = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'Node-backed Agent',
        command: process.execPath,
        argsTemplate: ['{prompt}'],
        promptTransport: 'argument',
        outputFormat: 'text',
        versionArgs: ['--version'],
      },
    });
    expect(createdResponse.statusCode).toBe(201);
    const runtime = createdResponse.json<{ id: string }>();

    const healthResponse = await app.inject({ method: 'GET', url: '/api/agents/health' });
    expect(healthResponse.statusCode).toBe(200);
    const health = healthResponse
      .json<{ health: Array<{ agentId: string; available: boolean }> }>()
      .health.find((entry) => entry.agentId === runtime.id);
    expect(health).toMatchObject({ agentId: runtime.id, available: true });

    await app.close();
  });

  it('creates an organizational hierarchy and assigns it to a project team', async () => {
    database = createDatabase(':memory:');
    const projectPath = mkdtempSync(join(tmpdir(), 'orchestrator-project-'));
    directories.push(projectPath);
    const project = database.createProject({ name: 'Org API', path: projectPath });
    const app = buildApp({
      database,
      invoke: async ({ runtime }) => `response from ${runtime.id}`,
    });

    const chiefResponse = await app.inject({
      method: 'POST',
      url: '/api/org-agents',
      payload: {
        name: 'Hermes',
        jobTitle: 'Chief Technology Officer',
        department: 'Executive',
        jobFunction: 'Coordinate technical strategy.',
        responsibilities: 'Route work and approve recommendations.',
        runtimeId: 'hermes',
        authorityLevel: 100,
        canDelegate: true,
      },
    });
    expect(chiefResponse.statusCode).toBe(201);
    const chief = chiefResponse.json<{ id: string }>();

    const leadResponse = await app.inject({
      method: 'POST',
      url: '/api/org-agents',
      payload: {
        name: 'Architecture Lead',
        jobTitle: 'Lead Software Architect',
        department: 'Engineering',
        jobFunction: 'Own architecture.',
        responsibilities: 'Review design and risk.',
        runtimeId: 'claude',
        managerId: chief.id,
        authorityLevel: 80,
        canDelegate: true,
      },
    });
    expect(leadResponse.statusCode).toBe(201);
    const lead = leadResponse.json<{ id: string }>();

    for (const orgAgentId of [chief.id, lead.id]) {
      const assignment = await app.inject({
        method: 'PUT',
        url: `/api/projects/${project.id}/team/${orgAgentId}`,
      });
      expect(assignment.statusCode).toBe(204);
    }

    const organization = await app.inject({ method: 'GET', url: '/api/org-agents' });
    expect(organization.statusCode).toBe(200);
    expect(organization.json<{ agents: Array<{ managerId: string | null }> }>().agents).toEqual([
      expect.objectContaining({ managerId: null }),
      expect.objectContaining({ managerId: chief.id }),
    ]);

    const team = await app.inject({
      method: 'GET',
      url: `/api/projects/${project.id}/team`,
    });
    expect(team.json<{ agents: Array<{ id: string }> }>().agents.map((agent) => agent.id)).toEqual([
      chief.id,
      lead.id,
    ]);

    await app.close();
  });

  it('runs a task through its assigned organizational hierarchy', async () => {
    database = createDatabase(':memory:');
    const projectPath = mkdtempSync(join(tmpdir(), 'orchestrator-project-'));
    directories.push(projectPath);
    const project = database.createProject({ name: 'Hierarchy API', path: projectPath });
    const task = database.createTask({ projectId: project.id, title: 'Review the design', status: 'ready' });
    const chief = database.createOrgAgent({
      name: 'Hermes',
      jobTitle: 'Chief Technology Officer',
      department: 'Executive',
      jobFunction: 'Approve technical work.',
      responsibilities: 'Synthesize reports.',
      runtimeId: 'hermes',
      canDelegate: true,
    });
    const reviewer = database.createOrgAgent({
      name: 'Kim',
      jobTitle: 'Security Reviewer',
      department: 'Security',
      jobFunction: 'Find security defects.',
      responsibilities: 'Report evidence.',
      runtimeId: 'kimi',
      managerId: chief.id,
    });
    database.assignOrgAgentToProject(project.id, chief.id);
    database.assignOrgAgentToProject(project.id, reviewer.id);
    const app = buildApp({
      database,
      invoke: async ({ prompt }) => `result from ${prompt.match(/\[ORG_AGENT:([^\]]+)\]/)?.[1]}`,
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/tasks/${task.id}/hierarchy`,
      payload: { rootOrgAgentId: chief.id },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<{
      run: { mode: string; status: string; rootOrgAgentId: string };
      messages: Array<{ orgAgentId: string }>;
    }>();
    expect(body.run).toMatchObject({ mode: 'hierarchy', status: 'completed', rootOrgAgentId: chief.id });
    expect(body.messages.map(({ orgAgentId }) => orgAgentId)).toEqual([reviewer.id, chief.id]);

    await app.close();
  });
});
