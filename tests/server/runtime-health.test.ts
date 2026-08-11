import { describe, expect, it } from 'vitest';
import type { AgentRuntime } from '../../src/shared/domain.js';
import { probeAgentRuntime } from '../../src/server/runtime-health.js';

function runtime(command: string, versionArgs: string[] = ['--version']): AgentRuntime {
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
    versionArgs,
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

  it('reports a timed-out probe as distinct from a missing executable', async () => {
    // A real Node child that never exits and never writes anything, so the
    // only way probeAgentRuntime resolves is its own internal timeout
    // killing it - this exercises the actual timeout branch, not a
    // simulation of it.
    const hungRuntime = runtime(process.execPath, ['-e', 'setInterval(() => {}, 1_000)']);

    const timedOut = await probeAgentRuntime(hungRuntime);
    const missing = await probeAgentRuntime(runtime('definitely-not-an-agent-runtime'));

    // Both are "not usable right now" - a runtime that did not answer in
    // time is no more usable than one that was never there, so `available`
    // stays false for both.
    expect(timedOut.available).toBe(false);
    expect(missing.available).toBe(false);

    // But they must not be the same shape: a caller has to be able to tell
    // "this might just be slow" from "this executable does not exist"
    // without parsing `error`'s free text.
    expect(timedOut.timedOut).toBe(true);
    expect(missing.timedOut).toBe(false);
    expect(timedOut.timedOut).not.toBe(missing.timedOut);
  });
});
