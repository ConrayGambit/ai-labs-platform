import { describe, expect, it } from 'vitest';
import { AGENT_CATALOG } from '../../src/server/agent-catalog.js';
import { createDatabase } from '../../src/server/database.js';

describe('the agent catalog', () => {
  it('offers every builtin provider, normalized to runtime field names', () => {
    const ids = AGENT_CATALOG.map((entry) => entry.id);
    expect(ids).toEqual([
      'hermes', 'kimi', 'claude', 'codex', 'prime', 'deepseek', 'minimax', 'gemini',
    ]);
    for (const entry of AGENT_CATALOG) {
      expect(entry.command, `${entry.id} has no command`).toBeTruthy();
      // Normalized to what CreateAgentInput calls things, not the seed's own
      // shorthand, so a catalog entry can be posted almost as-is.
      expect(Array.isArray(entry.argsTemplate), `${entry.id} argsTemplate`).toBe(true);
      expect(Array.isArray(entry.versionArgs), `${entry.id} versionArgs`).toBe(true);
    }
  });

  it('carries the ACP invocation for the providers that have one', () => {
    const byId = new Map(AGENT_CATALOG.map((entry) => [entry.id, entry]));
    expect(byId.get('claude')?.acpCommand).toBe('npm:@agentclientprotocol/claude-agent-acp');
    expect(byId.get('gemini')?.acpArgs).toEqual(['--acp']);
    // The three with no confirmed ACP mode stay null rather than guessing.
    for (const id of ['kimi', 'hermes', 'prime']) {
      expect(byId.get(id)?.acpCommand, `${id}`).toBeNull();
    }
  });

  it('agrees with what is actually seeded, so the two cannot drift', () => {
    const database = createDatabase(':memory:');
    try {
      for (const entry of AGENT_CATALOG) {
        const seeded = database.getAgent(entry.id);
        expect(seeded, `${entry.id} is in the catalog but not seeded`).toBeTruthy();
        expect(seeded?.command, `${entry.id} command`).toBe(entry.command);
        expect(seeded?.argsTemplate, `${entry.id} argsTemplate`).toEqual(entry.argsTemplate);
        expect(seeded?.acpCommand, `${entry.id} acpCommand`).toBe(entry.acpCommand);
        expect(seeded?.acpArgs, `${entry.id} acpArgs`).toEqual(entry.acpArgs);
        expect(seeded?.optionValues, `${entry.id} optionValues`).toEqual(entry.optionValues);
      }
    } finally {
      database.close();
    }
  });
});
