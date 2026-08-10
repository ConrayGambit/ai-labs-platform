import { spawn } from 'node:child_process';
import type { AgentRuntime, RuntimeHealth } from '../shared/domain.js';
import { resolveRuntimeEnv } from './agent-process.js';

const PROBE_TIMEOUT_MS = 5_000;
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
      finish({ available: false, version: null, error: error.message });
    });
    child.on('close', (code) => {
      const version = output.trim().split(/\r?\n/).find(Boolean)?.slice(0, 500) ?? null;
      if (code === 0) {
        finish({ available: true, version, error: null });
      } else {
        finish({
          available: false,
          version,
          error: version ?? `Version command exited with code ${code ?? 'unknown'}`,
        });
      }
    });

    const timeout = setTimeout(() => {
      child.kill();
      finish({ available: false, version: null, error: 'Runtime health check timed out' });
    }, PROBE_TIMEOUT_MS);
  });
}

export async function probeAgentRuntimes(runtimes: AgentRuntime[]): Promise<RuntimeHealth[]> {
  return await Promise.all(runtimes.map((runtime) => probeAgentRuntime(runtime)));
}
