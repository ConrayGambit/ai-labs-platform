import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';

describe('runtime tuning options', () => {
  let database: OrchestratorDatabase | undefined;
  afterEach(() => { database?.close(); database = undefined; });

  const runtimes = () => {
    database = createDatabase(':memory:');
    return new Map(database.listAgents().map((agent) => [agent.id, agent]));
  };

  it('publishes a tuning option for the coordinator runtime', () => {
    const hermes = runtimes().get('hermes')!;
    // The Group CEO runs on this runtime; three "Not supported" fields on the
    // top of the org chart is the registry failing to describe its own default.
    expect(Object.keys(hermes.optionTemplates).length).toBeGreaterThan(0);
  });

  it('registers Prime Agent', () => {
    const prime = runtimes().get('prime');
    expect(prime, 'Prime Agent is not in the runtime registry').toBeDefined();
    expect(prime!.command).toBe('prime-agent');
  });

  it('never publishes values for an option it has no flag for', () => {
    for (const agent of runtimes().values()) {
      for (const key of Object.keys(agent.optionValues)) {
        expect(
          agent.optionTemplates[key as 'model' | 'speed' | 'effort'],
          `${agent.id} publishes ${key} values with no flag to send them on`,
        ).toBeDefined();
      }
    }
  });

  it('publishes no empty choice list', () => {
    for (const agent of runtimes().values()) {
      for (const [key, choices] of Object.entries(agent.optionValues)) {
        expect(choices.length, `${agent.id}.${key} is an empty dropdown`).toBeGreaterThan(0);
      }
    }
  });
});
