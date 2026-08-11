import { spawn } from 'node:child_process';
import type { AgentRuntime, RuntimeHealth } from '../shared/domain.js';
import { resolveRuntimeEnv } from './agent-process.js';

/**
 * Bounds a single version probe (e.g. `--version`), not a run - the command
 * itself returns in milliseconds once it actually starts. The real risk is
 * spawn contention: probeAgentRuntimes fires one child process per
 * registered runtime in parallel via Promise.all, and on a loaded machine, a
 * cold start, or Windows spawning several children at once, process
 * creation alone can exceed a tight bound before the child's own version
 * command ever runs - a working runtime would then be reported identically
 * to one that times out because it is genuinely hung. Raised 3x from the
 * original 5s to absorb that contention; a health call being a few seconds
 * slower is a cheap trade against a false negative that tells an operator a
 * working runtime is unavailable.
 *
 * Exported so tests can drive fake timers by the real value instead of a
 * duplicated literal - see tests/server/runtime-health.test.ts.
 */
export const PROBE_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 8_192;

export async function probeAgentRuntime(runtime: AgentRuntime): Promise<RuntimeHealth> {
  const checkedAt = new Date().toISOString();

  return await new Promise<RuntimeHealth>((resolve) => {
    let child;
    try {
      child = spawn(runtime.command, runtime.versionArgs, {
        env: { ...process.env, ...resolveRuntimeEnv(runtime.env) },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        agentId: runtime.id,
        checkedAt,
        available: false,
        version: null,
        error: error instanceof Error ? error.message : String(error),
        timedOut: false,
      });
      return;
    }
    let output = '';
    let settled = false;

    const finish = (health: Omit<RuntimeHealth, 'agentId' | 'checkedAt'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ agentId: runtime.id, checkedAt, ...health });
    };
    const append = (chunk: Buffer) => {
      if (output.length < OUTPUT_LIMIT) output += chunk.toString('utf8');
    };

    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (error) => {
      finish({ available: false, version: null, error: error.message, timedOut: false });
    });
    child.on('close', (code) => {
      const version = output.trim().split(/\r?\n/).find(Boolean)?.slice(0, 500) ?? null;
      if (code === 0) {
        finish({ available: true, version, error: null, timedOut: false });
      } else {
        finish({
          available: false,
          version,
          error: version ?? `Version command exited with code ${code ?? 'unknown'}`,
          timedOut: false,
        });
      }
    });

    const timeout = setTimeout(() => {
      child.kill();
      finish({
        available: false,
        version: null,
        error: `Runtime health check timed out after ${PROBE_TIMEOUT_MS}ms`,
        timedOut: true,
      });
    }, PROBE_TIMEOUT_MS);
  });
}

/**
 * Probes every registered runtime in parallel. Promise.all means this
 * call's latency is bounded by its single slowest probe, not their sum -
 * so /api/agents/health takes up to ~PROBE_TIMEOUT_MS (15s) to answer in
 * the worst case (every runtime unresponsive), versus ~5s before that
 * bound was raised. Nothing renders this endpoint's response today, so
 * that worst case has no visible cost yet, but it is the number to know
 * before building something that does.
 */
export async function probeAgentRuntimes(runtimes: AgentRuntime[]): Promise<RuntimeHealth[]> {
  return await Promise.all(runtimes.map((runtime) => probeAgentRuntime(runtime)));
}
