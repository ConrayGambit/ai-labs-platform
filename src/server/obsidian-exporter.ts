import { mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { PlatformEvent } from '../shared/platform.js';

export interface ObsidianExporter {
  exportEvent(event: PlatformEvent): Promise<{ path: string }>;
}

const MIRROR_PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = {
  PortfolioCreated: ['name'],
  VentureCreated: ['name', 'kind'],
  ProjectCreated: ['name'],
  ProjectLifecycleChanged: ['from', 'to'],
  ApprovalRequested: ['approvalId'],
  ProjectPlanSubmitted: ['approvalId'],
  ApprovalDecided: ['approvalId', 'status'],
  ProjectActivated: ['approvalId'],
};

function projectPayload(event: PlatformEvent): Record<string, string | number | boolean | null> {
  const keys = MIRROR_PAYLOAD_KEYS[event.type] ?? [];
  return Object.fromEntries(keys.flatMap((key) => {
    const value = event.payload[key];
    return value === null || ['string', 'number', 'boolean'].includes(typeof value)
      ? [[key, value as string | number | boolean | null]]
      : [];
  }));
}

const yamlScalar = (value: string | null): string => JSON.stringify(value ?? '');

export function createObsidianExporter(options: { vaultPath: string }): ObsidianExporter {
  if (!isAbsolute(options.vaultPath)) throw new Error('Obsidian vault path must be absolute');

  return {
    async exportEvent(event) {
      const day = event.createdAt.slice(0, 10);
      const directory = join(options.vaultPath, 'AI Labs', 'Events', day);
      const filename = event.id.replace(/[^A-Za-z0-9._-]/g, '_');
      const path = join(directory, `${filename}.md`);
      const temporaryPath = `${path}.tmp`;
      const links = [
        event.ventureId ? `venture: ${yamlScalar(`[[Ventures/${event.ventureId}]]`)}` : null,
        event.projectId ? `project: ${yamlScalar(`[[Projects/${event.projectId}]]`)}` : null,
      ].filter((line): line is string => line !== null);
      const heading = event.type.replace(/[\r\n]/g, ' ');
      const markdown = [
        '---',
        `id: ${yamlScalar(event.id)}`,
        `type: ${yamlScalar(event.type)}`,
        `portfolio: ${yamlScalar(event.portfolioId)}`,
        ...links,
        `actor_type: ${yamlScalar(event.actorType)}`,
        `actor_id: ${yamlScalar(event.actorId)}`,
        `created_at: ${yamlScalar(event.createdAt)}`,
        '---',
        '',
        `# ${heading}`,
        '',
        '```json',
        JSON.stringify(projectPayload(event), null, 2),
        '```',
        '',
      ].join('\n');

      await mkdir(directory, { recursive: true });
      await writeFile(temporaryPath, markdown, 'utf8');
      await rename(temporaryPath, path);
      return { path };
    },
  };
}
