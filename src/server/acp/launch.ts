import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { resolveRuntimeEnv } from '../agent-process.js';
import type { AgentRuntime } from '../../shared/domain.js';
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
  } catch {
    // Deliberately not re-thrown: the underlying MODULE_NOT_FOUND names a
    // path inside this server, not the package an operator has to install.
    throw new Error(`ACP adapter ${packageName} is not installed`);
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
