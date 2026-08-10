import { describe, expect, it } from 'vitest';
import { findViolations } from '../../scripts/check-no-real-data.mjs';

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
