#!/usr/bin/env node
// Prints the path to a usable gitleaks, or exits 1 if there is none.
//
// The pre-commit hook used a bare `command -v gitleaks` and degraded to a
// warning when that missed. On Windows that is the common case rather than the
// exception: winget installs the binary into a per-package directory and does
// not always leave a shim on PATH, so secret scanning was skipped on every
// commit while the hook reported success. Look in the places an installer
// actually puts it before concluding it is absent.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const WINDOWS = process.platform === 'win32';
const BINARY = WINDOWS ? 'gitleaks.exe' : 'gitleaks';

/**
 * Directories an installer is known to use, in order of preference.
 *
 * Machine-specific roots come from the environment rather than being written
 * out: a literal drive path is exactly what the publishable-data guard exists
 * to keep out of this repository, and it caught this function's first draft.
 */
function candidateDirectories() {
  const home = homedir();
  if (WINDOWS) {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const winget = join(localAppData, 'Microsoft', 'WinGet');
    const directories = [
      join(winget, 'Links'),
      join(winget, 'Packages', 'Gitleaks.Gitleaks_Microsoft.Winget.Source_8wekyb3d8bbwe'),
      join(home, 'scoop', 'shims'),
    ];
    if (process.env.ProgramData) {
      directories.push(join(process.env.ProgramData, 'chocolatey', 'bin'));
    }
    return directories;
  }
  return ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', join(home, '.local', 'bin')];
}

export function findGitleaks(env = process.env) {
  // An explicit path always wins, so an unusual install is one variable away.
  const configured = env.GITLEAKS_PATH;
  if (configured) return existsSync(configured) ? configured : null;

  try {
    // On PATH already: ask it, rather than guessing at the resolution rules.
    execFileSync(BINARY, ['version'], { stdio: 'ignore' });
    return BINARY;
  } catch {
    // Not on PATH. Fall through to the known install directories.
  }

  for (const directory of candidateDirectories()) {
    const candidate = join(directory, BINARY);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// pathToFileURL, not string concatenation: on Windows argv[1] is a drive path
// and the URL is percent-encoded, so a hand-built comparison silently never
// matches and the script exits 0 having printed nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const found = findGitleaks();
  if (!found) process.exit(1);
  process.stdout.write(found);
}
