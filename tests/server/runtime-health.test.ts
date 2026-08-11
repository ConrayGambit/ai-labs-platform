import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../../src/shared/domain.js';
import { probeAgentRuntime } from '../../src/server/runtime-health.js';

function runtime(command: string): AgentRuntime {
  const timestamp = new Date(0).toISOString();
  return {
    id: 'probe',
    name: 'Probe Runtime',
    kind: 'custom',
    command,
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
    // Raised to match the timeoutMs convention already used by every
    // other AgentRuntime fixture in this suite (see agent-process.test.ts).
    // NOTE: unlike runAgentProcess, probeAgentRuntime never reads
    // runtime.timeoutMs — it bounds its own spawn with the PROBE_TIMEOUT_MS
    // constant in src/server/runtime-health.ts (product code, so it is
    // out of scope here). This field is fixture-shape hygiene only; the
    // probe test below can still time out under heavy parallel load.
    timeoutMs: 120_000,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('runtime health probe', () => {
  it('reports an installed executable and its version output', async () => {
    const health = await probeAgentRuntime(runtime(process.execPath));

    expect(health.available).toBe(true);
    expect(health.version).toContain(process.version);
    expect(health.error).toBeNull();
  });

  it('reports a missing executable without rejecting the health request', async () => {
    const health = await probeAgentRuntime(runtime('definitely-not-an-agent-runtime'));

    expect(health.available).toBe(false);
    expect(health.error).toBeTruthy();
  });
});
