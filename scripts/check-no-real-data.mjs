#!/usr/bin/env node
// Fails when a tracked file contains material that must not be published.
//
// This file is published. It therefore contains NO proper nouns and NO
// deployment-specific terms. Those belong in a private denylist passed via
// --denylist <path> or AI_LABS_DENYLIST, which is never committed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The directory holding this file, or null when that cannot be known.
 *
 * Resolved on call, not at import. `import.meta.url` is a file: URL only when
 * this runs as a real module on disk — under the test transform it is not, and
 * throwing here would take down a module whose other exports are being unit
 * tested, turning a missing convenience into a failed suite.
 *
 * @returns {string | null}
 */
function scriptDirectory() {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/**
 * The checkout's shared git directory: the one path that reads the same from the
 * main checkout and from every linked worktree. A worktree has a git directory
 * of its own, nested inside the main one, but its COMMON directory is the main
 * checkout's — which is exactly the property needed here.
 *
 * Asked for from this file's own directory rather than the working directory,
 * for the same reason the hop below is measured from it: a hook, an npm script
 * and a hand-run command all start somewhere different.
 *
 * @param {string | null} from
 * @returns {string | null}
 */
function gitCommonDirectory(from) {
  try {
    const output = execFileSync(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: from ?? undefined, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return output.trim() || null;
  } catch {
    // No git on PATH, not a repository, or a git too old to know --path-format.
    return null;
  }
}

/**
 * Where a private denylist may live when nobody names one, best candidate first.
 * It is deployment material and stays outside the repository, so each candidate
 * is a hop out of the checkout to a private sibling directory.
 *
 * The git-derived candidate comes first because it is the only one correct from
 * inside a linked worktree. A worktree holds this script two directories deeper
 * than the main checkout does, so a hop measured from the script itself lands
 * inside the worktrees directory rather than beside the checkout, and resolves
 * to nothing. Nothing found reads as "no denylist configured" — the strongest
 * rule silently not running, on output that still says the check passed.
 *
 * The script-relative hop is kept behind it, for when git cannot be asked at all.
 *
 * @param {string | null} scriptDir directory holding this file
 * @param {string | null} gitCommonDir shared git directory of the checkout
 * @returns {string[]} absolute paths, most trustworthy first, without duplicates
 */
export function denylistCandidates(scriptDir, gitCommonDir) {
  const candidates = [];
  // <checkout>/.git -> <checkout> -> the directory the checkout sits in.
  if (gitCommonDir) {
    candidates.push(join(dirname(dirname(resolve(gitCommonDir))), '_private', '.denylist'));
  }
  if (scriptDir) {
    candidates.push(resolve(scriptDir, '..', '..', '_private', '.denylist'));
  }
  return [...new Set(candidates)];
}

/**
 * Whether finding no denylist should fail the run rather than warn.
 *
 * Off unless asked for. Every clone outside a deployment that carries real names
 * has no denylist and must still be able to run the generic rules — including
 * this repository's own continuous integration. A deployment that does keep one
 * turns this on, so a denylist that stops resolving, or that loses its terms,
 * becomes a failed check instead of a quietly weaker one.
 *
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function requiresDenylist(argv, env) {
  if (argv.includes('--require-denylist')) return true;
  const value = (env.AI_LABS_REQUIRE_DENYLIST ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Whether the denylist rule will actually run, and whether it not running should
 * stop the check.
 *
 * A denylist that resolved to a real file but yielded no terms enforces exactly
 * as much as no denylist at all. A truncated write, a clobbering redirect, or a
 * file holding nothing but comments each leave the strongest rule inert while a
 * path was still found. That is reported as its own state rather than folded
 * into a missing one, because the two are corrected differently: one by finding
 * the file, the other by looking at what is inside it.
 *
 * Being required is fatal for both, so the flag promises that the rule ran
 * rather than merely that a file existed. The second is the weaker promise, and
 * a check whose guarantee is "a file was present" is the kind that reports a
 * clean repository right up until it matters.
 *
 * @param {string[]} terms
 * @param {string | null} path denylist actually read, if any
 * @param {boolean} required
 * @returns {{state: 'active' | 'missing' | 'empty', fatal: boolean}}
 */
export function denylistVerdict(terms, path, required) {
  if (terms.length > 0) return { state: 'active', fatal: false };
  return { state: path ? 'empty' : 'missing', fatal: required };
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
    return { ...readDenylist(named), candidates: [named] };
  }

  // Nobody named one, so try the conventional locations. This is the difference
  // between the strongest rule running on every commit and it running only when
  // someone remembers to export a variable first.
  const scriptDir = scriptDirectory();
  const candidates = denylistCandidates(scriptDir, gitCommonDirectory(scriptDir));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { ...readDenylist(candidate), candidates };
  }

  return { terms: [], path: null, candidates };
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

/**
 * Says plainly that the strongest rule did not run. The wording this replaced
 * read as reassurance for a check that never happened, which is how a worktree
 * went on reporting a clean tree with the denylist rule silently disabled.
 *
 * @param {{state: 'missing' | 'empty', fatal: boolean}} verdict
 * @param {string | null} path
 * @param {string[]} candidates
 */
function reportInactiveDenylist(verdict, path, candidates) {
  if (verdict.state === 'empty') {
    console.error(`PRIVATE DENYLIST HAS NO TERMS: ${path}`);
    console.error('  It was found and read, and held no term: blank lines and comments only.');
  } else {
    console.error('NO PRIVATE DENYLIST FOUND.');
    for (const candidate of candidates) console.error(`  Looked for: ${candidate}`);
  }
  console.error('  The denylist rule did NOT run. Generic rules ran: personal paths,');
  console.error('  absolute paths, emails, encoding. Real names, were any present,');
  console.error('  would NOT have been detected.');
  console.error(
    verdict.state === 'empty'
      ? '  Put one lower-case term per line, or name another file with --denylist.'
      : '  Name one with --denylist <path> or AI_LABS_DENYLIST.',
  );
  if (verdict.fatal) {
    console.error('\nA denylist was required (--require-denylist or AI_LABS_REQUIRE_DENYLIST),');
    console.error('so this check FAILED rather than running with a weaker rule set.');
    process.exit(1);
  }
  console.error('  Require one with --require-denylist or AI_LABS_REQUIRE_DENYLIST=1.\n');
}

function main() {
  const { terms, path: denylistPath, candidates } = loadDenylist();
  const historyMode = process.argv.includes('--history');
  const verdict = denylistVerdict(
    terms,
    denylistPath,
    requiresDenylist(process.argv, process.env),
  );
  if (verdict.state !== 'active') reportInactiveDenylist(verdict, denylistPath, candidates);
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
  const note =
    verdict.state === 'active'
      ? `${terms.length} private term(s)`
      : 'GENERIC RULES ONLY - the denylist rule did not run';
  const scope = historyMode ? 'entire git history' : 'working tree';
  console.log(`Publishable-data check passed on the ${scope} (${note}).`);
}

if (process.argv[1]?.endsWith('check-no-real-data.mjs')) {
  main();
}
