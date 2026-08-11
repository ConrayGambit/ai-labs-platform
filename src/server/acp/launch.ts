import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resolveRuntimeEnv } from '../agent-process.js';
import type { AgentRuntime, OrgAgent } from '../../shared/domain.js';
import type { OrchestratorDatabase } from '../database.js';
import type { AcpClientOptions } from './client.js';

/**
 * How a stored ACP command becomes a spawnable one.
 *
 * A runtime's `acpCommand` is either a plain command, used as-is, or
 * `npm:<package>`, meaning "resolve that package's own bin and run it under
 * the Node executable already running this server".
 *
 * The prefix exists because of what a bare command actually does here. The
 * whole codebase spawns with `shell: false`, and under that, on Windows,
 * `npx` is ENOENT, `npx.cmd` is EINVAL (Node refuses to spawn `.cmd` without
 * a shell), and a bare `claude` is ENOENT because only npm's shims are on
 * PATH — the real executable sits inside the package. Resolving the package's
 * own `.js` entry and handing it to `process.execPath` sidesteps shims,
 * PATHEXT and `.cmd` blocking on every platform, without a shell.
 */
export const ACP_PACKAGE_PREFIX = 'npm:';

const require = createRequire(import.meta.url);

/** The bin entry a package publishes, as an absolute path. */
function resolvePackageBin(packageName: string): string {
  let manifestPath: string;
  try {
    manifestPath = require.resolve(`${packageName}/package.json`);
  } catch (error) {
    // Only a missing module actually means "not installed" — that generic
    // message is friendlier than MODULE_NOT_FOUND's, which names a path
    // inside this server, not the package an operator has to install. Any
    // other failure (e.g. ERR_PACKAGE_PATH_NOT_EXPORTED, thrown when a
    // package's own `exports` map is scoped tightly enough to block the
    // `/package.json` subpath) is a real, installed package this resolver
    // just can't read; relabeling that "not installed" would send an
    // operator to run a redundant `npm install` that fixes nothing, so it
    // propagates unchanged instead.
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
      throw new Error(`ACP adapter ${packageName} is not installed`);
    }
    throw error;
  }
  const manifest = require(manifestPath) as { bin?: string | Record<string, string> };
  const bin = manifest.bin;
  if (typeof bin === 'string') return join(dirname(manifestPath), bin);
  const entries = Object.values(bin ?? {});
  if (entries.length === 1) return join(dirname(manifestPath), entries[0]);
  if (entries.length === 0) throw new Error(`ACP adapter ${packageName} publishes no bin entry`);
  // Picking by position would be a coin flip recorded as a decision.
  throw new Error(
    `ACP adapter ${packageName} publishes ${entries.length} bin entries; it needs an explicit one`,
  );
}

export function resolveAcpLaunch(
  acpCommand: string,
  acpArgs: string[],
): { command: string; args: string[] } {
  if (!acpCommand.startsWith(ACP_PACKAGE_PREFIX)) {
    return { command: acpCommand, args: [...acpArgs] };
  }
  const packageName = acpCommand.slice(ACP_PACKAGE_PREFIX.length);
  return { command: process.execPath, args: [resolvePackageBin(packageName), ...acpArgs] };
}

/**
 * What `RunSupervisor` needs to launch this runtime for a session.
 *
 * Throws before anything is spawned when the runtime has no ACP invocation.
 * The alternative — spawning its single-shot command — is what this whole
 * change exists to stop: it sends a literal `{prompt}` to a real provider as
 * a billed call, then waits for JSON-RPC from a process that will never speak
 * it.
 */
export function acpSpawnOptions(runtime: AgentRuntime, cwd: string): AcpClientOptions {
  if (!runtime.acpCommand) {
    throw new Error(
      `Runtime ${runtime.id} has no ACP invocation and cannot run a session; ` +
        'register an acpCommand for it, or pick a runtime that has one',
    );
  }
  const { command, args } = resolveAcpLaunch(runtime.acpCommand, runtime.acpArgs);
  return { command, args, cwd, env: resolveRuntimeEnv(runtime.env ?? {}) };
}

/**
 * What `RunSupervisor`'s real `spawnFor` dependency uses to launch an
 * organizational agent's provider for a session — see `src/server/index.ts`.
 *
 * Three refusals, all before anything spawns, for the three ways an agent can
 * fail to name a live, usable, ACP-capable provider:
 *
 * 1. No runtime assigned at all (`OrgAgent.runtimeId` is null — an agent may
 *    exist with no provider; PRODUCT.md's "the model powers an employee; it
 *    does not define that employee's identity"). Refused before the registry
 *    is even consulted, and named by agent, since there is no runtime id to
 *    name instead.
 * 2. The assigned runtime no longer exists in the registry.
 * 3. The assigned runtime exists but is disabled. This is the ACP run path —
 *    the one every run actually takes — honouring `enabled`; the legacy
 *    hierarchy orchestrator (`requireRuntime` in `hierarchy.ts`) already did,
 *    and nothing here did until now.
 *
 * `acpSpawnOptions` performs a fourth, on the runtime itself: no ACP
 * invocation registered.
 */
export function agentSpawnOptions(
  agent: OrgAgent,
  database: Pick<OrchestratorDatabase, 'getAgent'>,
  cwd: string,
): AcpClientOptions {
  if (!agent.runtimeId) {
    throw new Error(
      `Agent ${agent.id} has no runtime assigned and cannot run a session; assign it one first`,
    );
  }
  const runtime = database.getAgent(agent.runtimeId);
  if (!runtime) {
    throw new Error(`Runtime not found for agent ${agent.id}: ${agent.runtimeId}`);
  }
  if (!runtime.enabled) {
    throw new Error(`Runtime is disabled for agent ${agent.id}: ${agent.runtimeId}`);
  }
  return acpSpawnOptions(runtime, cwd);
}
