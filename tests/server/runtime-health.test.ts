import { describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '../../src/shared/domain.js';
import { PROBE_TIMEOUT_MS, probeAgentRuntime } from '../../src/server/runtime-health.js';

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

  it('reports a timed-out probe as distinct from a missing executable', async () => {
    // Fake timers compress the wait rather than sleeping through it: the
    // timeout branch under test is a real `setTimeout(..., PROBE_TIMEOUT_MS)`
    // (src/server/runtime-health.ts), and advancing the fake clock by that
    // exact, imported value fires it immediately in test time. The spawn and
    // the child.kill() that callback triggers are still real - only the
    // waiting is simulated, not the timeout mechanism or the process it
    // controls. Driven by the real constant rather than a duplicated literal
    // so a future change to PROBE_TIMEOUT_MS cannot silently erode this
    // test's margin against vitest's 30s per-test ceiling.
    vi.useFakeTimers();
    try {
      // A real Node child that never exits and never writes anything, so the
      // only way probeAgentRuntime resolves is its own internal timeout
      // killing it - this exercises the actual timeout branch, not a
      // simulation of it. Started alongside the missing-executable probe,
      // not after it, since neither depends on the other's result.
      const timedOutPromise = probeAgentRuntime(
        runtime(process.execPath, ['-e', 'setInterval(() => {}, 1_000)']),
      );
      const missingPromise = probeAgentRuntime(runtime('definitely-not-an-agent-runtime'));

      // advanceTimersByTimeAsync (not the sync advanceTimersByTime) also
      // drains microtasks between ticks, which is what lets the timeout
      // callback's finish()/resolve() actually propagate to the awaited
      // promise below instead of leaving it pending against a clock that
      // will never move on its own.
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);

      const [timedOut, missing] = await Promise.all([timedOutPromise, missingPromise]);

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
    } finally {
      vi.useRealTimers();
    }
  });
});
