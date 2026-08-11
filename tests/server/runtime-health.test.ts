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
    timeoutMs: 5_000,
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
