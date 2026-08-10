import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertOutsideRepository, resolveAiLabsPaths } from '../../src/server/paths.js';

const REPOSITORY_ROOT = resolve('C:/repos/ai-labs');

describe('assertOutsideRepository', () => {
  it('rejects the repository root itself', () => {
    expect(() => assertOutsideRepository(REPOSITORY_ROOT, REPOSITORY_ROOT)).toThrow(
      /inside the repository/i,
    );
  });

  it('rejects a nested path inside the repository', () => {
    expect(() => assertOutsideRepository(join(REPOSITORY_ROOT, 'data'), REPOSITORY_ROOT)).toThrow(
      /inside the repository/i,
    );
  });

  it('accepts a sibling directory that merely shares a prefix', () => {
    expect(() =>
      assertOutsideRepository(resolve('C:/repos/ai-labs-data'), REPOSITORY_ROOT),
    ).not.toThrow();
  });
});

describe('resolveAiLabsPaths', () => {
  it('honours explicit environment overrides', () => {
    const paths = resolveAiLabsPaths({
      repositoryRoot: REPOSITORY_ROOT,
      env: {
        AI_LABS_DATA_DIR: 'C:/labs/data',
        AI_LABS_PROFILE_DIR: 'C:/labs/profile',
      },
    });
    expect(paths.dataDir).toBe(resolve('C:/labs/data'));
    expect(paths.profileDir).toBe(resolve('C:/labs/profile'));
  });

  it('refuses an override that points inside the repository', () => {
    expect(() =>
      resolveAiLabsPaths({
        repositoryRoot: REPOSITORY_ROOT,
        env: { AI_LABS_DATA_DIR: join(REPOSITORY_ROOT, 'data') },
      }),
    ).toThrow(/inside the repository/i);
  });

  it('falls back to a per-user application directory outside the repository', () => {
    const paths = resolveAiLabsPaths({ repositoryRoot: REPOSITORY_ROOT, env: {} });
    expect(paths.dataDir).toMatch(/AI Labs/);
    expect(paths.profileDir).toMatch(/AI Labs/);
    expect(() => assertOutsideRepository(paths.dataDir, REPOSITORY_ROOT)).not.toThrow();
    expect(() => assertOutsideRepository(paths.profileDir, REPOSITORY_ROOT)).not.toThrow();
  });
});
