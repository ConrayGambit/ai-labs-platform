import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../../src/shared/domain.js';
import { resolveRuntimeEnv, runAgentProcess } from '../../src/server/agent-process.js';

const fixture = resolve('tests/fixtures/fake-agent.mjs');

function fakeRuntime(argsTemplate: string[]): AgentRuntime {
  const timestamp = new Date(0).toISOString();
  return {
    id: 'fake',
    name: 'Fake Agent',
    kind: 'custom',
    command: process.execPath,
    argsTemplate: [fixture, ...argsTemplate],
    promptTransport: 'argument',
    outputFormat: 'text',
    resultField: null,
    versionArgs: ['--version'],
    optionTemplates: {},
    optionValues: {},
    env: {},
    enabled: true,
    isCoordinator: false,
    timeoutMs: 5_000,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('agent process adapter', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('passes prompts as inert argv values without invoking a shell', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'orchestrator-agent-'));
    temporaryDirectories.push(projectPath);
    const sentinel = join(projectPath, 'shell-injection-worked');
    const prompt = `review this; touch ${sentinel}`;

    const result = await runAgentProcess({
      runtime: fakeRuntime(['{prompt}', '{projectPath}']),
      prompt,
      projectPath,
      context: { taskId: 'task-1', runId: 'run-1' },
    });
    const payload = JSON.parse(result.content) as { argv: string[]; cwd: string };

    expect(payload.argv).toEqual([prompt, projectPath]);
    expect(payload.cwd).toBe(projectPath);
    expect(existsSync(sentinel)).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('normalizes a configured JSON result field into message content', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'orchestrator-agent-'));
    temporaryDirectories.push(projectPath);
    const runtime = fakeRuntime(['json-result']);
    runtime.outputFormat = 'json';
    runtime.resultField = 'result';

    const result = await runAgentProcess({
      runtime,
      prompt: 'Return a structured response',
      projectPath,
      context: { taskId: 'task-2', runId: 'run-2' },
    });

    expect(result.content).toBe('Structured final answer');
  });

  it('appends configured model/speed/effort flags and skips options without a template', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'orchestrator-agent-'));
    temporaryDirectories.push(projectPath);
    const runtime = fakeRuntime(['{prompt}']);
    runtime.optionTemplates = {
      model: ['--model', '{value}'],
      effort: ['-c', 'model_reasoning_effort={value}'],
    };

    const result = await runAgentProcess({
      runtime,
      prompt: 'Design pass',
      projectPath,
      context: { taskId: 'task-3', runId: 'run-3' },
      options: { model: 'claude-sonnet-4-5', speed: 'fast', effort: 'high' },
    });
    const payload = JSON.parse(result.content) as { argv: string[] };

    expect(payload.argv).toEqual([
      'Design pass',
      '--model',
      'claude-sonnet-4-5',
      '-c',
      'model_reasoning_effort=high',
    ]);
    expect(payload.argv).not.toContain('fast');
  });

  it('appends valueless flag templates for any truthy option selection', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'orchestrator-agent-'));
    temporaryDirectories.push(projectPath);
    const runtime = fakeRuntime(['{prompt}']);
    runtime.optionTemplates = { effort: ['--thinking'] };

    const result = await runAgentProcess({
      runtime,
      prompt: 'Think deeply',
      projectPath,
      context: { taskId: 'task-4', runId: 'run-4' },
      options: { effort: 'high' },
    });
    const payload = JSON.parse(result.content) as { argv: string[] };

    expect(payload.argv).toEqual(['Think deeply', '--thinking']);
  });

  it('interpolates runtime env from the host environment without persisting secrets', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'orchestrator-agent-'));
    temporaryDirectories.push(projectPath);
    process.env.FAKE_PROVIDER_KEY = 'test-secret-value';
    try {
      const runtime = fakeRuntime(['{prompt}']);
      runtime.env = {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: '${FAKE_PROVIDER_KEY}',
        MISSING_REFERENCE: '${FAKE_PROVIDER_KEY_MISSING}',
      };

      const result = await runAgentProcess({
        runtime,
        prompt: 'Env pass',
        projectPath,
        context: { taskId: 'task-5', runId: 'run-5' },
      });
      const payload = JSON.parse(result.content) as {
        env: Record<string, string | null>;
      };

      expect(payload.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
      expect(payload.env.ANTHROPIC_AUTH_TOKEN).toBe('test-secret-value');
      expect(payload.env.MISSING_REFERENCE).toBe('');
      expect(JSON.stringify(runtime.env)).not.toContain('test-secret-value');
    } finally {
      delete process.env.FAKE_PROVIDER_KEY;
    }
  });

  it('resolves ${VAR} references against the host environment', () => {
    process.env.FAKE_RESOLVE_CHECK = 'resolved';
    try {
      expect(
        resolveRuntimeEnv({
          FIXED: 'https://api.minimax.io/anthropic',
          FROM_HOST: '${FAKE_RESOLVE_CHECK}',
          ABSENT: '${FAKE_RESOLVE_CHECK_ABSENT}',
        }),
      ).toEqual({
        FIXED: 'https://api.minimax.io/anthropic',
        FROM_HOST: 'resolved',
        ABSENT: '',
      });
    } finally {
      delete process.env.FAKE_RESOLVE_CHECK;
    }
  });
});
