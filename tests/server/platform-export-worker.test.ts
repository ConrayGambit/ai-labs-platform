import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';
import { createPlatformExportWorker } from '../../src/server/platform-export-worker.js';

describe('durable platform export worker', () => {
  const directories: string[] = [];
  const databases: OrchestratorDatabase[] = [];

  afterEach(() => {
    databases.splice(0).forEach((database) => database.close());
    directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }));
  });

  it('retries a failed export from durable state without exposing the error text', async () => {
    const database = createDatabase(':memory:');
    databases.push(database);
    const portfolio = database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    let attempts = 0;
    const failures: unknown[] = [];
    const worker = createPlatformExportWorker({
      repository: database.platform,
      retryDelaysMs: [0],
      exportEvent: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('vault password must stay private');
      },
      logFailure: (failure) => failures.push(failure),
    });

    worker.start();
    await vi.waitFor(() => expect(database.platform.getExportStatus(portfolio.id).pending).toBe(0));

    expect(attempts).toBe(2);
    expect(failures).toEqual([{ eventId: expect.any(String), eventType: 'PortfolioCreated', attempts: 1 }]);
    expect(JSON.stringify(failures)).not.toContain('vault password');
    await worker.stop();
  });

  it('replays failed export work after the database is reopened', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-labs-export-restart-'));
    directories.push(directory);
    const filename = join(directory, 'orchestrator.db');
    const firstDatabase = createDatabase(filename);
    const portfolio = firstDatabase.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const failingWorker = createPlatformExportWorker({
      repository: firstDatabase.platform,
      retryDelaysMs: [60_000],
      exportEvent: async () => { throw new Error('vault unavailable'); },
    });
    failingWorker.start();
    await vi.waitFor(() => expect(firstDatabase.platform.getExportStatus(portfolio.id).failed).toBe(1));
    await failingWorker.stop();
    firstDatabase.close();

    const reopened = createDatabase(filename);
    databases.push(reopened);
    const exported: string[] = [];
    const recoveryWorker = createPlatformExportWorker({
      repository: reopened.platform,
      retryDelaysMs: [0],
      exportEvent: async (event) => { exported.push(event.id); },
    });
    recoveryWorker.start({ includeDeferredFailures: true });
    await vi.waitFor(() => expect(reopened.platform.getExportStatus(portfolio.id).pending).toBe(0));

    expect(exported).toHaveLength(1);
    await recoveryWorker.stop();
  });

  it('bounds shutdown while an export remains stuck', async () => {
    const database = createDatabase(':memory:');
    databases.push(database);
    database.platform.createPortfolio({ name: 'AI Labs', ownerUserId: 'owner' });
    const worker = createPlatformExportWorker({
      repository: database.platform,
      drainTimeoutMs: 10,
      exportEvent: () => new Promise(() => undefined),
    });
    worker.start();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const startedAt = Date.now();
    await worker.stop();
    expect(Date.now() - startedAt).toBeLessThan(250);
  });
});
