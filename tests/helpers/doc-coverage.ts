import { readdirSync } from 'node:fs';
import { basename, join, posix, sep } from 'node:path';

/**
 * One line of `docs/architecture-coverage.md`.
 *
 * An `alias` names the phrase the document uses instead of the filename and is
 * verified against the document. A `waiver` is an unverified reason the file is
 * absent. The split is the point: a waiver is a place to hide, an alias is not.
 */
export interface RegisterEntry {
  file: string;
  kind: 'alias' | 'waiver';
  value: string;
  /** 1-based, so a failure message points at a line a person can open. */
  line: number;
}

export interface ParsedRegister {
  entries: RegisterEntry[];
  malformed: { line: number; text: string }[];
}

export interface CoverageInput {
  files: readonly string[];
  docText: string;
  register: ParsedRegister;
}

export interface CoverageFailures {
  undocumented: string[];
  brokenAliases: RegisterEntry[];
  staleEntries: RegisterEntry[];
  emptyEntries: RegisterEntry[];
}

const ENTRY = /^- `([^`]+)` — (.+)$/;
const ALIAS = /^documented as "(.*)"$/;
const WAIVER = /^waived:(.*)$/;

/**
 * Reads the register, ignoring everything that is not an entry.
 *
 * A line that starts like an entry and then matches neither form is reported
 * rather than skipped: a typo in `documented as` would otherwise silently
 * become "this file has no entry", which is the failure mode inverted.
 */
export function parseRegister(text: string): ParsedRegister {
  const entries: RegisterEntry[] = [];
  const malformed: { line: number; text: string }[] = [];

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const match = ENTRY.exec(raw.trim());
    if (!match) return; // prose, headings, blank lines
    const [, file, tail] = match;

    const alias = ALIAS.exec(tail);
    if (alias) {
      entries.push({ file, kind: 'alias', value: alias[1], line });
      return;
    }
    const waiver = WAIVER.exec(tail);
    if (waiver) {
      entries.push({ file, kind: 'waiver', value: waiver[1].trim(), line });
      return;
    }
    malformed.push({ line, text: raw.trim() });
  });

  return { entries, malformed };
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether the document mentions this file.
 *
 * Two forms, because a document written about concepts says "run supervisor"
 * where the tree says `run-supervisor.ts`. Measured against the real document,
 * the filename alone reported 29 misses and the spaced form brought it to 25 —
 * every one of that difference a false alarm.
 *
 * The match must BEGIN at a word boundary, and may end anywhere. Plain
 * substring matching counted `wire.ts` as documented because the word
 * "tripwire" appeared, which is a file passing on somebody else's sentence.
 * Anchoring only the start keeps "supervisors" and "rooms" matching, which a
 * both-ends anchor would have rejected — the plural is the same mention.
 */
function isMentioned(docLower: string, file: string): boolean {
  const base = basename(file, '.ts').toLowerCase();
  const forms = [base, base.replace(/-/g, ' ')];
  return forms.some((form) => new RegExp(`\\b${escape(form)}`).test(docLower));
}

export function findCoverageFailures(input: CoverageInput): CoverageFailures {
  const docLower = input.docText.toLowerCase();
  const known = new Set(input.files);

  const staleEntries = input.register.entries.filter((entry) => !known.has(entry.file));
  const live = input.register.entries.filter((entry) => known.has(entry.file));
  const emptyEntries = live.filter((entry) => entry.value.trim() === '');
  const brokenAliases = live.filter(
    (entry) =>
      entry.kind === 'alias' &&
      entry.value.trim() !== '' &&
      !docLower.includes(entry.value.toLowerCase()),
  );

  // Only an entry that survived every check may cover a file. An alias the
  // document does not contain is not a weaker pass; it is no pass at all.
  const broken = new Set([...emptyEntries, ...brokenAliases]);
  const covered = new Set(live.filter((entry) => !broken.has(entry)).map((entry) => entry.file));

  const undocumented = input.files
    .filter((file) => !isMentioned(docLower, file) && !covered.has(file))
    .sort();

  return { undocumented, brokenAliases, staleEntries, emptyEntries };
}

/**
 * Every `.ts` file under a directory, as repository-relative POSIX paths so a
 * register entry reads the same on every platform.
 */
export function listSourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.name.endsWith('.ts') && !item.name.endsWith('.d.ts')) found.push(path);
    }
  };
  walk(root);
  return found.map((path) => path.split(sep).join(posix.sep)).sort();
}
