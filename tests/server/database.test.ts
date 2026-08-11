import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';

describe('orchestrator database', () => {
  let database: OrchestratorDatabase | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it('seeds authenticated CLI runtimes without storing OAuth credentials', () => {
    database = createDatabase(':memory:');

    expect(database.listAgents()).toEqual([
      expect.objectContaining({ id: 'hermes', kind: 'hermes', command: 'hermes' }),
      expect.objectContaining({ id: 'kimi', kind: 'kimi', command: 'kimi' }),
      expect.objectContaining({ id: 'claude', kind: 'claude', command: 'claude' }),
      expect.objectContaining({ id: 'codex', kind: 'codex', command: 'codex' }),
      expect.objectContaining({ id: 'prime', kind: 'custom', command: 'prime-agent' }),
      expect.objectContaining({ id: 'deepseek', kind: 'custom', command: 'claude' }),
      expect.objectContaining({ id: 'minimax', kind: 'custom', command: 'claude' }),
    ]);

    // API providers bridge through the Claude Code CLI with endpoint env, and
    // credential slots hold ${VAR} references only — never raw secret material.
    for (const agent of database.listAgents()) {
      expect(JSON.stringify(agent).toLowerCase()).not.toContain('sk-');
      for (const [key, value] of Object.entries(agent.env)) {
        if (/token|api_key/i.test(key)) expect(value).toMatch(/^\$\{[A-Z0-9_]+\}$/i);
      }
    }
    const deepseek = database.getAgent('deepseek');
    expect(deepseek?.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(deepseek?.optionValues.model).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash']);
    const minimax = database.getAgent('minimax');
    expect(minimax?.env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');
    expect(minimax?.optionValues.model).toContain('MiniMax-M2.7-highspeed');
  });

  it('seeds provider-accurate option templates and dropdown values', () => {
    database = createDatabase(':memory:');

    const claude = database.getAgent('claude');
    expect(claude?.optionTemplates).toEqual({
      model: ['--model', '{value}'],
      effort: ['--effort', '{value}'],
    });
    expect(claude?.optionValues.model).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-fable-5',
      'claude-haiku-4-5',
    ]);
    expect(claude?.optionValues.effort).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);

    const codex = database.getAgent('codex');
    expect(codex?.optionTemplates.effort).toEqual(['-c', 'model_reasoning_effort={value}']);
    expect(codex?.optionValues.model).toEqual(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
    expect(codex?.optionValues.effort).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);

    const kimi = database.getAgent('kimi');
    expect(kimi?.optionTemplates.model).toEqual(['--model', '{value}']);
    expect(kimi?.optionTemplates.effort).toEqual(['--thinking']);
    expect(kimi?.optionValues.effort).toEqual(['high']);

    // The coordinator runtime: previously published no option templates at
    // all, which is the bug this task closes. It has a real --model flag and
    // no fixed catalog, so no curated optionValues.model is published either.
    const hermes = database.getAgent('hermes');
    expect(hermes?.optionTemplates).toEqual({ model: ['--model', '{value}'] });
    expect(hermes?.optionValues.model).toBeUndefined();

    // Prime Agent: --thinking is a closed, documented enum; --model is a
    // free-form pattern with no published list.
    const prime = database.getAgent('prime');
    expect(prime?.command).toBe('prime-agent');
    expect(prime?.optionTemplates).toEqual({
      model: ['--model', '{value}'],
      effort: ['--thinking', '{value}'],
    });
    expect(prime?.optionValues).toEqual({
      effort: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    });

    // No runtime in this registry accepts a launch flag for speed.
    for (const agent of database.listAgents()) {
      expect(agent.optionTemplates.speed, `${agent.id} unexpectedly publishes a speed template`).toBeUndefined();
    }
  });

  it('registers a custom CLI runtime through the shared adapter contract', () => {
    database = createDatabase(':memory:');

    const runtime = database.createAgent({
      name: 'Local ACP Bridge',
      command: 'local-agent',
      argsTemplate: ['run', '--prompt', '{prompt}'],
      promptTransport: 'argument',
      outputFormat: 'text',
      versionArgs: ['--version'],
      timeoutMs: 120_000,
    });

    expect(runtime).toMatchObject({
      kind: 'custom',
      name: 'Local ACP Bridge',
      command: 'local-agent',
      argsTemplate: ['run', '--prompt', '{prompt}'],
      timeoutMs: 120_000,
    });
    expect(database.getAgent(runtime.id)).toEqual(runtime);
  });

  it('persists development projects with their local repository paths', () => {
    database = createDatabase(':memory:');

    const project = database.createProject({
      name: 'Example Product',
      path: '/workspaces/example-product',
      description: 'Synthetic fixture project',
      color: '#7170ff',
    });

    expect(database.listProjects()).toEqual([project]);
    expect(project).toMatchObject({
      name: 'Example Product',
      path: '/workspaces/example-product',
      color: '#7170ff',
    });
  });

  it('moves ranked tasks atomically between Kanban columns', () => {
    database = createDatabase(':memory:');
    const project = database.createProject({ name: 'Board', path: '/work/board' });
    const first = database.createTask({
      projectId: project.id,
      title: 'Design adapter contract',
      description: 'Define the safe process boundary.',
      priority: 'high',
    });
    const second = database.createTask({
      projectId: project.id,
      title: 'Build project board',
      priority: 'medium',
    });

    const moved = database.moveTask(first.id, 'in_progress', 0);
    const board = database.getBoard(project.id);

    expect(moved).toMatchObject({ id: first.id, status: 'in_progress', position: 0 });
    expect(board.in_progress.map((task) => task.id)).toEqual([first.id]);
    expect(board.backlog.map((task) => task.id)).toEqual([second.id]);
    expect(board.ready).toEqual([]);
    expect(board.review).toEqual([]);
    expect(board.done).toEqual([]);
    expect(board.blocked).toEqual([]);
  });

  it('persists a council run and its attributed message timeline', () => {
    database = createDatabase(':memory:');
    const project = database.createProject({ name: 'Council', path: '/work/council' });
    const task = database.createTask({ projectId: project.id, title: 'Choose an architecture' });

    const run = database.createRun({
      taskId: task.id,
      mode: 'council',
      coordinatorAgentId: 'hermes',
    });
    const message = database.addRunMessage({
      runId: run.id,
      taskId: task.id,
      agentId: 'kimi',
      phase: 'proposal',
      role: 'assistant',
      content: 'Use a local-first process adapter.',
    });
    database.updateRunStatus(run.id, 'completed');

    expect(database.getRun(run.id)).toMatchObject({ id: run.id, status: 'completed' });
    expect(database.listRunMessages(run.id)).toEqual([message]);
  });
});
