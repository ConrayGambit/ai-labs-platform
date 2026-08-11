import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acpSpawnOptions, resolveAcpLaunch } from '../../src/server/acp/launch.js';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
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

  it('propagates a resolution failure that is not a missing module, instead of relabeling it "not installed"', () => {
    // A package that genuinely exists but whose `exports` map is scoped
    // tightly enough to block the `/package.json` subpath — the case a
    // real, narrowly-exported adapter would hit. This has to sit under a
    // real `node_modules` directory for Node's resolver to treat it as a
    // named package at all (a relative or absolute path bypasses `exports`
    // entirely), so it is built here and torn down after, rather than
    // checked in.
    const fixtureDir = resolve('node_modules/@acp-launch-test-fixture/scoped-exports');
    mkdirSync(fixtureDir, { recursive: true });
    writeFileSync(
      join(fixtureDir, 'package.json'),
      JSON.stringify({
        name: '@acp-launch-test-fixture/scoped-exports',
        version: '1.0.0',
        exports: { '.': './index.js' },
      }),
    );
    writeFileSync(join(fixtureDir, 'index.js'), 'module.exports = {};\n');

    try {
      let thrown: unknown;
      try {
        resolveAcpLaunch('npm:@acp-launch-test-fixture/scoped-exports', []);
      } catch (error) {
        thrown = error;
      }
      // The real Node error, unwrapped: same code, and specifically not the
      // "not installed" message that only applies to a genuinely missing
      // module.
      expect((thrown as NodeJS.ErrnoException)?.code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
      expect((thrown as Error)?.message).not.toMatch(/not installed/i);
    } finally {
      rmSync(resolve('node_modules/@acp-launch-test-fixture'), { recursive: true, force: true });
    }
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

describe('acpSpawnOptions for the registered prime runtime', () => {
  // Prime Agent speaks ACP natively (`prime-agent --mode acp`), so the seeded
  // registry row — not a hand-built fixture — is what must resolve cleanly
  // here. Model: runtime-options.test.ts's `runtimes()` (DB-backed lookup).
  let database: OrchestratorDatabase | undefined;
  afterEach(() => {
    database?.close();
    database = undefined;
  });

  const primeRuntime = (): AgentRuntime => {
    database = createDatabase(':memory:');
    const prime = database.listAgents().find((agent) => agent.id === 'prime');
    if (!prime) throw new Error('prime is not in the runtime registry');
    return prime;
  };

  it('registers the ACP invocation confirmed in the v0.6.0 release notes: prime-agent --mode acp', () => {
    const prime = primeRuntime();
    expect(prime.acpCommand).toBe('prime-agent');
    expect(prime.acpArgs).toEqual(['--mode', 'acp']);
  });

  it('resolves prime to a shell-free launch instead of refusing it', () => {
    const prime = primeRuntime();
    const options = acpSpawnOptions(prime, '/tmp/project');
    // Shell-free: the plain command as-is (see resolveAcpLaunch above), not
    // process.execPath resolving an npm: package's bin. Prime Agent installs
    // through its own versioned installer as a real executable on PATH, so
    // it takes the same non-prefixed path as `gemini` above — not the `npm:`
    // workaround, which exists only for npm-shimmed CLIs.
    expect(options.command).toBe('prime-agent');
    expect(options.args).toEqual(['--mode', 'acp']);
  });
});
