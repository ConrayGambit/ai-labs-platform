import { describe, expect, it } from 'vitest';
import { findCoverageFailures, parseRegister } from '../helpers/doc-coverage.js';

// Deliberately mixed: `secret-safety` appears as a filename, "run supervisor"
// only as a concept. One test needs each, or the spaced form passes both and
// the filename branch is never exercised.
const DOC = `
# Architecture

The run supervisor opens one ACP session per run. The gate ladder attaches
to a project. The transport speaks newline-delimited JSON-RPC. See
secret-safety for the credential tripwire.
`;

describe('parseRegister', () => {
  it('reads an alias entry', () => {
    const parsed = parseRegister('- `src/server/gate-policy.ts` — documented as "gate ladder"');
    expect(parsed.malformed).toEqual([]);
    expect(parsed.entries).toEqual([
      { file: 'src/server/gate-policy.ts', kind: 'alias', value: 'gate ladder', line: 1 },
    ]);
  });

  it('reads a waiver entry', () => {
    const parsed = parseRegister('- `src/shared/wire.ts` — waived: covered by behaviour');
    expect(parsed.entries).toEqual([
      { file: 'src/shared/wire.ts', kind: 'waiver', value: 'covered by behaviour', line: 1 },
    ]);
  });

  it('ignores prose and blank lines, and reports a line matching neither form', () => {
    const parsed = parseRegister(
      ['# Register', '', 'Some prose about why this file exists.', '- `src/a.ts` — mumble'].join('\n'),
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.malformed).toEqual([{ line: 4, text: '- `src/a.ts` — mumble' }]);
  });
});

describe('findCoverageFailures', () => {
  const run = (files: string[], register: string) =>
    findCoverageFailures({ files, docText: DOC, register: parseRegister(register) });

  it('accepts a file the document names by filename', () => {
    // The document writes `secret-safety` literally, hyphen and all.
    expect(run(['src/server/secret-safety.ts'], '').undocumented).toEqual([]);
  });

  it('accepts a file whose hyphens read as spaces in the document', () => {
    // The document says "run supervisor", never "run-supervisor". This is the
    // branch that took the real repository's misses from 29 to 25.
    expect(run(['src/server/run-supervisor.ts'], '').undocumented).toEqual([]);
  });

  it('does not count a name that only appears inside a longer word', () => {
    // The document says "tripwire", which is not a mention of wire.ts. Plain
    // substring matching let this pass, which is a file riding on somebody
    // else's sentence.
    expect(run(['src/shared/wire.ts'], '').undocumented).toEqual(['src/shared/wire.ts']);
  });

  it('still counts a plural, which is the same mention', () => {
    // Anchoring both ends would have rejected this. Only the start is anchored.
    expect(run(['src/server/room.ts'], '').undocumented).toEqual(['src/server/room.ts']);
    const doc = 'The core owns rooms and their members.';
    expect(
      findCoverageFailures({ files: ['src/server/room.ts'], docText: doc, register: parseRegister('') })
        .undocumented,
    ).toEqual([]);
  });

  it('reports a file the document never mentions and no entry covers', () => {
    expect(run(['src/server/tenure-sweep.ts'], '').undocumented).toEqual([
      'src/server/tenure-sweep.ts',
    ]);
  });

  it('accepts a file whose alias appears in the document', () => {
    const result = run(
      ['src/server/gate-policy.ts'],
      '- `src/server/gate-policy.ts` — documented as "gate ladder"',
    );
    expect(result.undocumented).toEqual([]);
    expect(result.brokenAliases).toEqual([]);
  });

  it('reports an alias the document does not contain, and does not let it cover the file', () => {
    const result = run(
      ['src/server/gate-policy.ts'],
      '- `src/server/gate-policy.ts` — documented as "gate policy"',
    );
    expect(result.brokenAliases.map((entry) => entry.value)).toEqual(['gate policy']);
    expect(result.undocumented).toEqual(['src/server/gate-policy.ts']);
  });

  it('accepts a waived file without consulting the document', () => {
    const result = run(['src/shared/wire.ts'], '- `src/shared/wire.ts` — waived: covered by behaviour');
    expect(result.undocumented).toEqual([]);
  });

  it('reports an entry whose file no longer exists', () => {
    const result = run([], '- `src/server/gone.ts` — waived: covered by behaviour');
    expect(result.staleEntries.map((entry) => entry.file)).toEqual(['src/server/gone.ts']);
  });

  it('reports an empty reason, and does not let it cover the file', () => {
    const result = run(['src/shared/wire.ts'], '- `src/shared/wire.ts` — waived:   ');
    expect(result.emptyEntries.map((entry) => entry.file)).toEqual(['src/shared/wire.ts']);
    expect(result.undocumented).toEqual(['src/shared/wire.ts']);
  });
});
