import { describe, expect, it } from 'vitest';
import { acpSpawnOptions, resolveAcpLaunch } from '../../src/server/acp/launch.js';
import type { AgentRuntime } from '../../src/shared/domain.js';

/** A runtime with only the fields these functions read. */
function runtime(overrides: Partial<AgentRuntime>): AgentRuntime {
  return {
    id: 'test-runtime',
    name: 'Test Runtime',
    kind: 'custom',
    command: 'test',
    argsTemplate: ['{prompt}'],
    acpCommand: null,
    acpArgs: [],
    promptTransport: 'argument',
    outputFormat: 'text',
    resultField: null,
    versionArgs: ['--version'],
    optionTemplates: {},
    optionValues: {},
    env: {},
    enabled: true,
    isCoordinator: false,
    timeoutMs: 600_000,
    createdAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveAcpLaunch', () => {
  it('passes a plain command through untouched', () => {
    expect(resolveAcpLaunch('gemini', ['--acp'])).toEqual({
      command: 'gemini',
      args: ['--acp'],
    });
  });

  it('resolves an npm: package to its own bin under the current Node', () => {
    const launch = resolveAcpLaunch('npm:@agentclientprotocol/claude-agent-acp', []);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toHaveLength(1);
    expect(launch.args[0]).toMatch(/claude-agent-acp[\\/].*\.js$/);
  });

  it('appends acpArgs after the resolved entry point', () => {
    const launch = resolveAcpLaunch('npm:@agentclientprotocol/claude-agent-acp', ['--verbose']);
    expect(launch.args).toHaveLength(2);
    expect(launch.args[1]).toBe('--verbose');
  });

  it('names the package when it is not installed', () => {
    expect(() => resolveAcpLaunch('npm:@example/not-installed-acp', [])).toThrow(
      /@example\/not-installed-acp.*not installed/i,
    );
  });
});

describe('acpSpawnOptions', () => {
  it('refuses a runtime with no ACP invocation', () => {
    expect(() => acpSpawnOptions(runtime({ id: 'kimi' }), '/tmp/project')).toThrow(
      /kimi.*no ACP invocation/i,
    );
  });

  it('resolves ${VAR} env references at launch, never storing the value', () => {
    process.env.ACP_LAUNCH_TEST_TOKEN = 'resolved-at-launch';
    const options = acpSpawnOptions(
      runtime({ acpCommand: 'gemini', acpArgs: ['--acp'], env: { PROVIDER_TOKEN: '${ACP_LAUNCH_TEST_TOKEN}' } }),
      '/tmp/project',
    );
    expect(options.env).toEqual({ PROVIDER_TOKEN: 'resolved-at-launch' });
    expect(options.cwd).toBe('/tmp/project');
    delete process.env.ACP_LAUNCH_TEST_TOKEN;
  });
});
