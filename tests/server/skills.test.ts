import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import type { AgentInvoker } from '../../src/server/council.js';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { createHierarchyOrchestrator } from '../../src/server/hierarchy.js';
import type { AgentInvocation } from '../../src/server/council.js';

describe('skills, tuning, and organizations', () => {
  let database: OrchestratorDatabase | undefined;
  const directories: string[] = [];

  afterEach(() => {
    database?.close();
    database = undefined;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('seeds the built-in skills for design, marketing, and agent runtimes', () => {
    database = createDatabase(':memory:');

    const skills = database.listSkills();
    expect(skills.map((skill) => skill.id)).toEqual([
      'skill-taste',
      'skill-impeccable',
      'skill-playwright-cli',
      'skill-awesome-design',
      'skill-img2threejs',
      'skill-claude-code-builtins',
      'skill-codex-builtins',
      'skill-hermes-builtins',
    ]);
    for (const skill of skills) {
      expect(skill.builtin).toBe(true);
      expect(skill.instructions.length).toBeGreaterThan(50);
      expect(skill.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it('persists skill assignments and model/speed/effort tuning on organizational agents', () => {
    database = createDatabase(':memory:');

    const agent = database.createOrgAgent({
      name: 'Mira',
      jobTitle: 'Design Director',
      department: 'Design',
      jobFunction: 'Own visual direction for product surfaces.',
      responsibilities: 'Approve layouts, typography, and motion language.',
      runtimeId: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      skillIds: ['skill-taste', 'skill-impeccable'],
    });

    expect([...agent.skillIds].sort()).toEqual(['skill-impeccable', 'skill-taste']);
    expect(agent.model).toBe('claude-sonnet-4-5');
    expect(agent.effort).toBe('high');
    expect(agent.organizationId).toBe('default-org');
    expect([...(database.getOrgAgent(agent.id)?.skillIds ?? [])].sort()).toEqual([
      'skill-impeccable',
      'skill-taste',
    ]);
    expect(
      database.listOrgAgentSkills(agent.id).map((skill) => skill.slug).sort(),
    ).toEqual(['design-taste-frontend', 'impeccable']);
  });

  it('rejects skill assignments that do not exist', () => {
    database = createDatabase(':memory:');

    expect(() =>
      database!.createOrgAgent({
        name: 'Mira',
        jobTitle: 'Design Director',
        department: 'Design',
        jobFunction: 'Own visual direction.',
        responsibilities: 'Approve layouts.',
        runtimeId: 'claude',
        skillIds: ['skill-does-not-exist'],
      }),
    ).toThrow('Skill not found: skill-does-not-exist');
  });

  it('scopes agents and projects to their organization', () => {
    database = createDatabase(':memory:');

    const studio = database.createOrganization({ name: 'Studio North', description: 'Marketing' });
    const agent = database.createOrgAgent({
      organizationId: studio.id,
      name: 'Kai',
      jobTitle: 'Content Strategist',
      department: 'Marketing',
      jobFunction: 'Plan campaign messaging.',
      responsibilities: 'Draft positioning and channel briefs.',
      runtimeId: 'kimi',
    });
    expect(agent.organizationId).toBe(studio.id);

    expect(() =>
      database!.createOrgAgent({
        organizationId: 'missing-org',
        name: 'Kai',
        jobTitle: 'Content Strategist',
        department: 'Marketing',
        jobFunction: 'Plan campaign messaging.',
        responsibilities: 'Draft positioning.',
        runtimeId: 'kimi',
      }),
    ).toThrow('Organization not found: missing-org');
  });

  it('injects assigned skill guidance into hierarchy prompts and passes tuning to the runtime', async () => {
    database = createDatabase(':memory:');
    const projectPath = mkdtempSync(join(tmpdir(), 'orchestrator-skills-'));
    directories.push(projectPath);
    const project = database.createProject({ name: 'Brand Site', path: projectPath });
    const task = database.createTask({
      projectId: project.id,
      title: 'Rebuild the landing page',
      status: 'ready',
    });
    const designer = database.createOrgAgent({
      name: 'Mira',
      jobTitle: 'Design Director',
      department: 'Design',
      jobFunction: 'Own visual direction for product surfaces.',
      responsibilities: 'Approve layouts, typography, and motion language.',
      runtimeId: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'high',
      skillIds: ['skill-taste'],
    });
    database.assignOrgAgentToProject(project.id, designer.id);

    const invocations: AgentInvocation[] = [];
    const invoke: AgentInvoker = async (invocation) => {
      invocations.push(invocation);
      return 'done';
    };
    const hierarchy = createHierarchyOrchestrator({ database, invoke });
    const run = await hierarchy.run({ taskId: task.id, rootOrgAgentId: designer.id });

    expect(run.status).toBe('completed');
    expect(invocations).toHaveLength(1);
    const invocation = invocations[0]!;
    expect(invocation.prompt).toContain('ASSIGNED SKILLS');
    expect(invocation.prompt).toContain('Taste Skill');
    expect(invocation.prompt).toContain('DESIGN_VARIANCE');
    expect(invocation.options).toEqual({ model: 'claude-sonnet-4-5', speed: null, effort: 'high' });
    expect(database.getTask(task.id)?.status).toBe('review');
  });

  it('exposes skills, organizations, option flags, stats, and recent runs over the API', async () => {
    database = createDatabase(':memory:');
    const projectPath = mkdtempSync(join(tmpdir(), 'orchestrator-api-'));
    directories.push(projectPath);
    const app = buildApp({ database, invoke: async () => 'ok' });

    const skillsResponse = await app.inject({ method: 'GET', url: '/api/skills' });
    expect(skillsResponse.statusCode).toBe(200);
    expect(skillsResponse.json<{ skills: unknown[] }>().skills).toHaveLength(8);

    const customSkill = await app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: {
        name: 'Launch Copy',
        description: 'Marketing launch copy framework.',
        category: 'marketing',
        instructions: 'Lead with the outcome, then proof, then the ask.',
      },
    });
    expect(customSkill.statusCode).toBe(201);

    const organization = await app.inject({
      method: 'POST',
      url: '/api/organizations',
      payload: { name: 'Studio North', description: 'Marketing organization' },
    });
    expect(organization.statusCode).toBe(201);

    const optionsResponse = await app.inject({
      method: 'PATCH',
      url: '/api/agents/kimi/options',
      payload: {
        optionTemplates: { model: ['--model', '{value}'], speed: ['--fast'] },
        optionValues: { model: ['kimi-k2-thinking', 'kimi-k2.7-code'] },
        env: { MOONSHOT_BASE_URL: 'https://api.moonshot.ai/anthropic' },
      },
    });
    expect(optionsResponse.statusCode).toBe(200);
    const runtime = optionsResponse.json<{
      optionTemplates: Record<string, string[]>;
      optionValues: Record<string, string[]>;
      env: Record<string, string>;
    }>();
    expect(runtime.optionTemplates).toEqual({
      model: ['--model', '{value}'],
      speed: ['--fast'],
    });
    expect(runtime.optionValues).toEqual({ model: ['kimi-k2-thinking', 'kimi-k2.7-code'] });
    expect(runtime.env).toEqual({ MOONSHOT_BASE_URL: 'https://api.moonshot.ai/anthropic' });
    expect(database.getAgent('kimi')?.optionTemplates.speed).toEqual(['--fast']);

    const project = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { name: 'Site', path: projectPath },
    });
    expect(project.statusCode).toBe(201);
    const task = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.json<{ id: string }>().id}/tasks`,
      payload: { title: 'Design pass' },
    });
    const run = database.createRun({
      taskId: task.json<{ id: string }>().id,
      mode: 'direct',
      coordinatorAgentId: 'hermes',
    });
    database.updateRunStatus(run.id, 'completed');

    const stats = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(stats.statusCode).toBe(200);
    const statsBody = stats.json<{ projects: number; skills: number; tasksByStatus: { backlog: number } }>();
    expect(statsBody.projects).toBe(1);
    expect(statsBody.skills).toBe(9);
    expect(statsBody.tasksByStatus.backlog).toBe(1);

    const recent = await app.inject({ method: 'GET', url: '/api/runs/recent' });
    expect(recent.statusCode).toBe(200);
    const recentBody = recent.json<{ runs: Array<{ taskTitle: string; projectName: string; status: string }> }>();
    expect(recentBody.runs[0]).toMatchObject({
      taskTitle: 'Design pass',
      projectName: 'Site',
      status: 'completed',
    });

    await app.close();
  });
});
