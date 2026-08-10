import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const APPLICATION_DIRECTORY_NAME = 'AI Labs';

export interface AiLabsPaths {
  /** Operational store: database, worktrees, artifacts, run output. */
  dataDir: string;
  /** Deployment profile: ventures, staffing, policy packs, module configuration. */
  profileDir: string;
}

export interface ResolvePathsOptions {
  repositoryRoot: string;
  env?: Record<string, string | undefined>;
}

/**
 * Per-user application root. Windows uses LOCALAPPDATA because roaming a SQLite
 * database across machines corrupts it; other platforms follow XDG.
 */
function applicationRoot(env: Record<string, string | undefined>): string {
  if (process.platform === 'win32') {
    return env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  }
  return env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
}

/**
 * Reject any location inside the source tree. Operational data and profile
 * material must never sit where a contributor could commit them, and a
 * .gitignore entry is a convention rather than a control.
 */
export function assertOutsideRepository(candidate: string, repositoryRoot: string): void {
  const relation = relative(resolve(repositoryRoot), resolve(candidate));
  const isInside = relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
  if (isInside) {
    throw new Error(
      `Refusing a path inside the repository: ${candidate}. ` +
        'Set AI_LABS_DATA_DIR and AI_LABS_PROFILE_DIR to locations outside the source tree.',
    );
  }
}

export function resolveAiLabsPaths(options: ResolvePathsOptions): AiLabsPaths {
  const env = options.env ?? process.env;
  const root = join(applicationRoot(env), APPLICATION_DIRECTORY_NAME);
  const dataDir = resolve(env.AI_LABS_DATA_DIR ?? join(root, 'data'));
  const profileDir = resolve(env.AI_LABS_PROFILE_DIR ?? join(root, 'profile'));
  assertOutsideRepository(dataDir, options.repositoryRoot);
  assertOutsideRepository(profileDir, options.repositoryRoot);
  return { dataDir, profileDir };
}
