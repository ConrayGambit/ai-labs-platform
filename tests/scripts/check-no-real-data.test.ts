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

  it('passes clean content', () => {
    expect(findViolations('src/a.ts', 'export const value = 1;', ['acmecorp'])).toEqual([]);
  });
});
