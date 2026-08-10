import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  denylistCandidates,
  findViolations,
  requiresDenylist,
} from '../../scripts/check-no-real-data.mjs';

describe('no-real-data guard', () => {
  it('flags a personal Windows home path', () => {
    const violations = findViolations('README.md', 'See C:\\Users\\someone\\notes.md', []);
    expect(violations).toHaveLength(1);
    expect(violations[0].rule).toBe('personal-home-path');
  });

  it('flags a personal POSIX home path', () => {
    const violations = findViolations('README.md', 'open /home/someone/notes.md', []);
    expect(violations[0].rule).toBe('personal-home-path');
  });

  it('flags an arbitrary absolute drive path', () => {
    const violations = findViolations('docs/x.md', 'stored at D:\\Archive\\record.pdf', []);
    expect(violations[0].rule).toBe('absolute-drive-path');
  });

  it('allows conventional install and system locations', () => {
    const text = 'Installs to C:\\Program Files\\AI Labs and C:\\ProgramData\\AI Labs.';
    expect(findViolations('README.md', text, [])).toEqual([]);
  });

  it('flags a real-looking email address', () => {
    const violations = findViolations('docs/x.md', 'contact person@company.co.za', []);
    expect(violations[0].rule).toBe('email-address');
  });

  it('allows documentation and commit-trailer email addresses', () => {
    const text = 'noreply@anthropic.com and someone@example.com are fine.';
    expect(findViolations('docs/x.md', text, [])).toEqual([]);
  });

  it('flags a private denylist term case-insensitively', () => {
    const violations = findViolations('docs/x.md', 'The AcmeCorp matter.', ['acmecorp']);
    expect(violations[0].rule).toBe('denylist-term');
  });

  // Built from \u escapes rather than pasted, so this file stays pure ASCII and
  // cannot itself be damaged by an encoding round trip or a bulk text rewrite.
  const EM_DASH = '—';
  const MANGLED_EM_DASH = 'â€”'; // what Windows-1252 makes of it
  const MANGLED_ARROW = 'â†’';

  it('flags UTF-8 text mangled by an ANSI round trip', () => {
    const mangled = `design language inferred from the brief ${MANGLED_EM_DASH} no boilerplate`;
    const violations = findViolations('src/server/database.ts', mangled, []);
    expect(violations[0].rule).toBe('encoding-corruption');
  });

  it('flags a mangled arrow as well as a mangled dash', () => {
    const violations = findViolations('src/a.ts', `decompose ${MANGLED_ARROW} spawn`, []);
    expect(violations[0].rule).toBe('encoding-corruption');
  });

  it('allows the correctly encoded character', () => {
    const clean = `design language inferred from the brief ${EM_DASH} no boilerplate`;
    expect(findViolations('src/server/database.ts', clean, [])).toEqual([]);
  });

  it('passes clean content', () => {
    expect(findViolations('src/a.ts', 'export const value = 1;', ['acmecorp'])).toEqual([]);
  });
});

// Path arithmetic only — no file is read, so these run the same everywhere.
// Built with path.join from a resolved base so the expectations hold on both
// separators rather than encoding one platform's.
describe('conventional denylist location', () => {
  const checkout = path.resolve('checkouts', 'app');
  const gitCommonDir = path.join(checkout, '.git');
  const sibling = path.join(path.dirname(checkout), '_private', '.denylist');

  const mainScripts = path.join(checkout, 'scripts');
  // A linked worktree puts the same script two directories deeper.
  const worktreeScripts = path.join(checkout, '.claude', 'worktrees', 'wt-1', 'scripts');

  it('resolves the sibling of the checkout from the main checkout', () => {
    expect(denylistCandidates(mainScripts, gitCommonDir)[0]).toBe(sibling);
  });

  it('resolves the same denylist from inside a worktree as from the main checkout', () => {
    // The defect: the script sits two levels deeper in a worktree, so a hop
    // relative to the script landed inside the worktrees directory and found
    // nothing. A worktree shares the main checkout's git directory, so that is
    // what both must be measured from.
    expect(denylistCandidates(worktreeScripts, gitCommonDir)[0]).toBe(sibling);
    expect(denylistCandidates(worktreeScripts, gitCommonDir)[0]).toBe(
      denylistCandidates(mainScripts, gitCommonDir)[0],
    );
  });

  it('still finds the denylist from the main checkout with no git directory known', () => {
    expect(denylistCandidates(mainScripts, null)).toEqual([sibling]);
  });

  it('offers no correct candidate for a worktree with no git directory known', () => {
    // Pins why the git lookup is load-bearing rather than a nicety: the
    // script-relative hop alone cannot reach the denylist from a worktree.
    // Whoever deletes that lookup should fail this test, not ship a silent pass.
    expect(denylistCandidates(worktreeScripts, null)).not.toContain(sibling);
  });

  it('keeps the git-derived candidate ahead of the script-relative one', () => {
    const candidates = denylistCandidates(worktreeScripts, gitCommonDir);
    expect(candidates[0]).toBe(sibling);
    expect(candidates.length).toBeGreaterThan(1);
  });

  it('lists one candidate when both derivations agree', () => {
    expect(denylistCandidates(mainScripts, gitCommonDir)).toEqual([sibling]);
  });
});

describe('denylist requirement', () => {
  it('is off unless asked for, so a clone with no denylist still passes', () => {
    expect(requiresDenylist([], {})).toBe(false);
  });

  it('is on with the flag', () => {
    expect(requiresDenylist(['--require-denylist'], {})).toBe(true);
  });

  it('is on with the environment variable', () => {
    expect(requiresDenylist([], { AI_LABS_REQUIRE_DENYLIST: '1' })).toBe(true);
    expect(requiresDenylist([], { AI_LABS_REQUIRE_DENYLIST: 'TRUE' })).toBe(true);
  });

  it('treats an explicit off value as off rather than as merely set', () => {
    expect(requiresDenylist([], { AI_LABS_REQUIRE_DENYLIST: '0' })).toBe(false);
    expect(requiresDenylist([], { AI_LABS_REQUIRE_DENYLIST: 'false' })).toBe(false);
    expect(requiresDenylist([], { AI_LABS_REQUIRE_DENYLIST: '' })).toBe(false);
  });
});
