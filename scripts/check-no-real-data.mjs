#!/usr/bin/env node
// Fails when a tracked file contains material that must not be published.
//
// This file is published. It therefore contains NO proper nouns and NO
// deployment-specific terms. Those belong in a private denylist passed via
// --denylist <path> or AI_LABS_DENYLIST, which is never committed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Where the private denylist lives when nobody names one. It is deployment
 * material and stays outside the repository, so this is a relative hop out of
 * the checkout, resolved from this file rather than the working directory: a
 * hook, an npm script and a hand-run command all start somewhere different.
 *
 * Resolved on call, not at import. `import.meta.url` is a file: URL only when
 * this runs as a real module on disk — under the test transform it is not, and
 * throwing here would take down a module whose other exports are being unit
 * tested, turning a missing convenience into a failed suite.
 *
 * @returns {string | null}
 */
function conventionalDenylist() {
  try {
    return fileURLToPath(new URL('../../_private/.denylist', import.meta.url));
  } catch {
    return null;
  }
}

const ALLOWED_ABSOLUTE_PREFIXES = ['c:\\program files', 'c:\\programdata', 'c:\\windows'];

const ALLOWED_EMAIL_DOMAINS = ['anthropic.com', 'example.com', 'example.org', 'example.net'];

const SKIP_FILES = new Set(['package-lock.json']);

// These two files define and exercise the detection patterns, so they necessarily
// contain examples of them. Pattern rules are skipped here; the denylist rule is
// NOT, so a real name still fails the check even in the guard's own source.
const PATTERN_EXEMPT_FILES = new Set([
  'scripts/check-no-real-data.mjs',
  'tests/scripts/check-no-real-data.test.ts',
]);
const SKIP_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.db', '.woff', '.woff2',
];

const PERSONAL_HOME = /(?:[A-Za-z]:\\Users\\|\/home\/|\/Users\/)[A-Za-z0-9._-]+/g;
const ABSOLUTE_DRIVE = /\b[A-Za-z]:\\[^\s"'`)\]]*/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// UTF-8 text read as Windows-1252 and re-encoded. Windows PowerShell's
// Get-Content defaults to the ANSI codepage for files without a BOM, so any
// line-splice round trip silently mangles every non-ASCII character. It corrupted
// seeded agent instructions once and no test noticed, because tests assert ids
// and models rather than prose.
// Built with fromCharCode so this file stays pure ASCII. A rule containing the
// byte sequences it detects is destroyed by the next encoding round trip or bulk
// text rewrite - which is exactly what happened the first time it was written.
//
// Signature of UTF-8 read as Windows-1252: a-circumflex (U+00E2) or its capital
// (U+00C2) immediately followed by another non-ASCII character. Legitimate text
// uses those letters before ASCII letters, never before punctuation.
const MOJIBAKE_LEAD = String.fromCharCode(0x00e2) + String.fromCharCode(0x00c3);
const MOJIBAKE = new RegExp(
  '[' + MOJIBAKE_LEAD + ']' + '[\\u0080-\\u00ff\\u2000-\\u20ff\\u2122]',
  'g',
);

/**
 * @param {string} file
 * @param {string} content
 * @param {string[]} denylist lower-cased terms
 * @returns {{file: string, rule: string, match: string}[]}
 */
export function findViolations(file, content, denylist) {
  const violations = [];
  const add = (rule, match) => violations.push({ file, rule, match });

  if (PATTERN_EXEMPT_FILES.has(file.replace(/\\/g, '/'))) {
    const lowerExempt = content.toLowerCase();
    for (const term of denylist) {
      if (term && lowerExempt.includes(term)) add('denylist-term', term);
    }
    return violations;
  }

  for (const match of content.match(MOJIBAKE) ?? []) {
    add('encoding-corruption', match);
  }
  for (const match of content.match(PERSONAL_HOME) ?? []) {
    add('personal-home-path', match);
  }
  for (const match of content.match(ABSOLUTE_DRIVE) ?? []) {
    const lower = match.toLowerCase();
    if (lower.startsWith('c:\\users\\')) continue; // already reported as a personal path
    // Windows paths contain spaces, and ABSOLUTE_DRIVE stops at the first one, so
    // `C:\Program Files\...` arrives here as `c:\program`. Compare in both
    // directions: a truncated system prefix carries no personal information.
    const allowed = ALLOWED_ABSOLUTE_PREFIXES.some(
      (prefix) => lower.startsWith(prefix) || prefix.startsWith(lower),
    );
    if (allowed) continue;
    add('absolute-drive-path', match);
  }
  for (const match of content.match(EMAIL) ?? []) {
    const domain = match.split('@')[1].toLowerCase();
    const allowed = ALLOWED_EMAIL_DOMAINS.some(
      (candidate) => domain === candidate || domain.endsWith(`.${candidate}`),
    );
    if (allowed) continue;
    add('email-address', match);
  }
  const lowerContent = content.toLowerCase();
  for (const term of denylist) {
    if (term && lowerContent.includes(term)) add('denylist-term', term);
  }
  return violations;
}

function readDenylist(path) {
  const terms = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return { terms, path };
}

function loadDenylist() {
  const index = process.argv.indexOf('--denylist');
  const named = index === -1 ? process.env.AI_LABS_DENYLIST : process.argv[index + 1];

  // A denylist that was asked for by name must exist. Falling back to the
  // generic rules because a path was mistyped would report a clean repository
  // on exactly the check the caller went out of their way to request.
  if (named) {
    if (!existsSync(named)) throw new Error(`Denylist not found: ${named}`);
    return readDenylist(named);
  }

  // Nobody named one, so try the conventional location. This is the difference
  // between the strongest rule running on every commit and it running only when
  // someone remembers to export a variable first.
  const conventional = conventionalDenylist();
  if (conventional && existsSync(conventional)) return readDenylist(conventional);

  return { terms: [], path: null };
}

/**
 * Tracked files PLUS untracked files that are not ignored. `git ls-files` alone
 * lists only tracked files, so a newly written file stays invisible to the guard
 * until it is staged — which means `npm run verify` would report a clean repo
 * that the pre-commit hook then rejects.
 */
function trackedFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => !SKIP_FILES.has(file))
    .filter((file) => !SKIP_EXTENSIONS.some((extension) => file.toLowerCase().endsWith(extension)));
}

const skipPath = (file) =>
  SKIP_FILES.has(file) || SKIP_EXTENSIONS.some((ext) => file.toLowerCase().endsWith(ext));

/**
 * Every unique blob ever committed, with the path it was stored under. Deleting a
 * file does not remove it from history, and a public push publishes every commit,
 * so the working tree being clean says nothing about what is publishable.
 *
 * Deduplicating by blob hash keeps this near-instant: identical content across
 * many commits is scanned once.
 */
function historyBlobs() {
  // rev-list --objects lists trees with their directory path too, so the object
  // type has to be resolved before reading. One batch call rather than a failing
  // cat-file per object.
  const blobs = new Set();
  const typeListing = execFileSync(
    'git',
    ['cat-file', '--batch-check=%(objectname) %(objecttype)', '--batch-all-objects'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  for (const line of typeListing.split(/\r?\n/)) {
    const [sha, type] = line.split(' ');
    if (type === 'blob') blobs.add(sha);
  }

  const seen = new Map();
  const listing = execFileSync('git', ['rev-list', '--objects', '--all'], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  for (const line of listing.split(/\r?\n/)) {
    const separator = line.indexOf(' ');
    if (separator === -1) continue; // commits and root trees carry no path
    const sha = line.slice(0, separator);
    const file = line.slice(separator + 1);
    if (!file || !blobs.has(sha) || skipPath(file) || seen.has(sha)) continue;
    seen.set(sha, file);
  }
  return seen;
}

function scanHistory(terms) {
  const violations = [];
  for (const [sha, file] of historyBlobs()) {
    let content;
    try {
      content = execFileSync('git', ['cat-file', 'blob', sha], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      continue; // unreadable or binary blob
    }
    violations.push(...findViolations(file, content, terms));
  }
  return violations;
}

function main() {
  const { terms, path } = loadDenylist();
  const historyMode = process.argv.includes('--history');
  const violations = [];
  if (historyMode) {
    violations.push(...scanHistory(terms));
  } else {
    for (const file of trackedFiles()) {
      if (!existsSync(file) || statSync(file).isDirectory()) continue;
      violations.push(...findViolations(file, readFileSync(file, 'utf8'), terms));
    }
  }
  if (violations.length > 0) {
    console.error('Publishable-data check FAILED:\n');
    for (const violation of violations) {
      console.error(`  ${violation.file}  [${violation.rule}]  ${violation.match}`);
    }
    console.error(
      '\nRemove the material or move it to the private profile. ' +
        'See CONTRIBUTING.md on data separation.',
    );
    process.exit(1);
  }
  const note = path ? `${terms.length} private term(s)` : 'no private denylist configured';
  const scope = historyMode ? 'entire git history' : 'working tree';
  console.log(`Publishable-data check passed on the ${scope} (${note}).`);
}

if (process.argv[1]?.endsWith('check-no-real-data.mjs')) {
  main();
}
