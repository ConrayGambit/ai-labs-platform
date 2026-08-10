#!/usr/bin/env node
// Fails when a tracked file contains material that must not be published.
//
// This file is published. It therefore contains NO proper nouns and NO
// deployment-specific terms. Those belong in a private denylist passed via
// --denylist <path> or AI_LABS_DENYLIST, which is never committed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const ALLOWED_ABSOLUTE_PREFIXES = ['c:\\program files', 'c:\\programdata', 'c:\\windows'];

const ALLOWED_EMAIL_DOMAINS = ['anthropic.com', 'example.com', 'example.org', 'example.net'];

const SKIP_FILES = new Set(['package-lock.json']);
const SKIP_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.db', '.woff', '.woff2',
];

const PERSONAL_HOME = /(?:[A-Za-z]:\\Users\\|\/home\/|\/Users\/)[A-Za-z0-9._-]+/g;
const ABSOLUTE_DRIVE = /\b[A-Za-z]:\\[^\s"'`)\]]*/g;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * @param {string} file
 * @param {string} content
 * @param {string[]} denylist lower-cased terms
 * @returns {{file: string, rule: string, match: string}[]}
 */
export function findViolations(file, content, denylist) {
  const violations = [];
  const add = (rule, match) => violations.push({ file, rule, match });

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

function loadDenylist() {
  const index = process.argv.indexOf('--denylist');
  const path = index === -1 ? process.env.AI_LABS_DENYLIST : process.argv[index + 1];
  if (!path) return { terms: [], path: null };
  if (!existsSync(path)) throw new Error(`Denylist not found: ${path}`);
  const terms = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return { terms, path };
}

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((file) => !SKIP_FILES.has(file))
    .filter((file) => !SKIP_EXTENSIONS.some((extension) => file.toLowerCase().endsWith(extension)));
}

function main() {
  const { terms, path } = loadDenylist();
  const violations = [];
  for (const file of trackedFiles()) {
    if (!existsSync(file) || statSync(file).isDirectory()) continue;
    violations.push(...findViolations(file, readFileSync(file, 'utf8'), terms));
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
  console.log(`Publishable-data check passed (${note}).`);
}

if (process.argv[1]?.endsWith('check-no-real-data.mjs')) {
  main();
}
