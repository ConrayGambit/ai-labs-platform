import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createObsidianExporter } from '../../src/server/obsidian-exporter.js';

describe('Obsidian event exporter', () => {
  const directories: string[] = [];

  afterEach(() => directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

  it('writes linked Markdown from the event allowlist without arbitrary prose', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'ai-labs-vault-'));
    directories.push(vaultPath);
    const exporter = createObsidianExporter({ vaultPath });

    const result = await exporter.exportEvent({
      id: 'event-1',
      portfolioId: 'portfolio-1',
      ventureId: 'venture-1',
      projectId: 'project-1',
      type: 'ProjectPlanSubmitted',
      actorType: 'org_agent',
      actorId: 'chief-of-staff',
      payload: { approvalId: 'approval-1', summary: 'must-not-mirror', apiKey: 'must-not-leak' },
      createdAt: '2026-08-09T12:00:00.000Z',
    });

    const markdown = readFileSync(result.path, 'utf8');
    expect(markdown).toContain('type: "ProjectPlanSubmitted"');
    expect(markdown).toContain('[[Ventures/venture-1]]');
    expect(markdown).toContain('[[Projects/project-1]]');
    expect(markdown).toContain('approval-1');
    expect(markdown).not.toContain('must-not-mirror');
    expect(markdown).not.toContain('must-not-leak');
  });

  it('rejects a relative vault path', () => {
    expect(() => createObsidianExporter({ vaultPath: 'relative-vault' })).toThrow(
      'Obsidian vault path must be absolute',
    );
  });

  it('omits every payload field for an unknown event type', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'ai-labs-vault-'));
    directories.push(vaultPath);
    const exporter = createObsidianExporter({ vaultPath });

    const result = await exporter.exportEvent({
      id: 'event-separators',
      portfolioId: 'portfolio-1',
      ventureId: null,
      projectId: null,
      type: 'CredentialedEvent',
      actorType: 'system',
      actorId: null,
      payload: {
        title: 'Retained event metadata',
        api_key: 'secret-underscore',
        'api-key': 'secret-hyphen',
        'x-api-key': 'secret-prefixed',
        items: [
          { api_key: 'secret-nested-underscore', label: 'Retained nested metadata' },
          { session_secret: 'secret-nested-session' },
        ],
      },
      createdAt: '2026-08-09T12:00:00.000Z',
    });

    const markdown = readFileSync(result.path, 'utf8');
    expect(markdown).not.toContain('Retained event metadata');
    expect(markdown).not.toContain('Retained nested metadata');
    expect(markdown).not.toContain('secret-underscore');
    expect(markdown).not.toContain('secret-hyphen');
    expect(markdown).not.toContain('secret-prefixed');
    expect(markdown).not.toContain('secret-nested-underscore');
    expect(markdown).not.toContain('secret-nested-session');
  });

  it('quotes frontmatter scalars so actor metadata cannot inject YAML keys', async () => {
    const vaultPath = mkdtempSync(join(tmpdir(), 'ai-labs-vault-'));
    directories.push(vaultPath);
    const exporter = createObsidianExporter({ vaultPath });

    const result = await exporter.exportEvent({
      id: 'event-frontmatter',
      portfolioId: 'portfolio-1',
      ventureId: null,
      projectId: null,
      type: 'PortfolioCreated',
      actorType: 'user',
      actorId: 'owner\ninjected: true',
      payload: { name: 'AI Labs' },
      createdAt: '2026-08-09T12:00:00.000Z',
    });

    const markdown = readFileSync(result.path, 'utf8');
    expect(markdown).toContain('actor_id: "owner\\ninjected: true"');
    expect(markdown).not.toContain('\ninjected: true\n');
  });
});
