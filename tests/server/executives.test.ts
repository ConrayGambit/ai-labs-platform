import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type OrchestratorDatabase } from '../../src/server/database.js';

describe('prebuilt executive team', () => {
  let database: OrchestratorDatabase | undefined;
  const directories: string[] = [];

  const fileDatabase = (): OrchestratorDatabase => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestrator-execs-'));
    directories.push(directory);
    return createDatabase(join(directory, 'orchestrator.db'));
  };

  afterEach(() => {
    database?.close();
    database = undefined;
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('seeds the Group CEO and executive team into file-backed databases', () => {
    database = fileDatabase();

    const agents = database.listOrgAgents();
    expect(agents.map((agent) => agent.id)).toEqual([
      'exec-ceo',
      'exec-chief-of-staff',
      'exec-cino',
      'exec-cto',
      'exec-cmo',
      'exec-cdo',
    ]);

    const [ceo, ...directReports] = agents;
    expect(ceo).toMatchObject({
      name: 'Aria',
      jobTitle: 'Group CEO',
      managerId: null,
      authorityLevel: 100,
      canDelegate: true,
      organizationId: 'default-org',
    });
    for (const report of directReports) {
      expect(report.organizationId).toBe('default-org');
      expect(report.canDelegate).toBe(true);
    }

    // The Chief of Staff is a coordinating layer, not a peer. The Chief
    // Innovation Officer reports to the CEO because her promotion boundary is
    // the owner's alone.
    const managerOf = new Map(agents.map((agent) => [agent.id, agent.managerId]));
    expect(managerOf.get('exec-chief-of-staff')).toBe('exec-ceo');
    expect(managerOf.get('exec-cino')).toBe('exec-ceo');
    expect(managerOf.get('exec-cto')).toBe('exec-chief-of-staff');
    expect(managerOf.get('exec-cmo')).toBe('exec-chief-of-staff');
    expect(managerOf.get('exec-cdo')).toBe('exec-chief-of-staff');

    // Every seeded executive is permanent staff.
    for (const agent of agents) expect(agent.tenure).toBe('permanent');
    expect(agents.map((agent) => agent.jobTitle)).toEqual([
      'Group CEO',
      'Chief of Staff',
      'Chief Innovation Officer',
      'Chief Technology Officer',
      'Chief Marketing Officer',
      'Chief Design Officer',
    ]);
  });

  it('assigns executive skills and provider tuning', () => {
    database = fileDatabase();

    const chiefOfStaff = database.getOrgAgent('exec-chief-of-staff');
    expect(chiefOfStaff).toMatchObject({
      runtimeId: 'claude',
      model: 'claude-opus-5',
      effort: 'high',
    });

    const innovationOfficer = database.getOrgAgent('exec-cino');
    expect(innovationOfficer).toMatchObject({ runtimeId: 'kimi', effort: 'high' });
    expect(innovationOfficer?.skillIds).toEqual([
      'skill-hermes-builtins',
      'skill-claude-code-builtins',
      'skill-codex-builtins',
    ]);

    const designOfficer = database.getOrgAgent('exec-cdo');
    expect(designOfficer?.skillIds).toEqual([
      'skill-taste',
      'skill-impeccable',
      'skill-awesome-design',
    ]);
    expect(
      database.listOrgAgentSkills('exec-cdo').map((skill) => skill.slug),
    ).toEqual(['design-taste-frontend', 'impeccable', 'awesome-design-md']);

    const marketingOfficer = database.getOrgAgent('exec-cmo');
    expect(marketingOfficer).toMatchObject({
      runtimeId: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'medium',
    });
    expect(marketingOfficer?.skillIds).toEqual(['skill-taste', 'skill-awesome-design']);
  });

  it('keeps executive seeding idempotent across reopen and does not duplicate rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestrator-execs-'));
    directories.push(directory);
    const filename = join(directory, 'orchestrator.db');

    const first = createDatabase(filename);
    const firstIds = first.listOrgAgents().map((agent) => agent.id);
    const firstSkillCount = first.listOrgAgentSkills('exec-cdo').length;
    first.close();

    database = createDatabase(filename);
    expect(database.listOrgAgents().map((agent) => agent.id)).toEqual(firstIds);
    expect(database.listOrgAgentSkills('exec-cdo')).toHaveLength(firstSkillCount);
  });

  it('backfills builtin runtime env bridges on reopen without touching user edits', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestrator-execs-'));
    directories.push(directory);
    const filename = join(directory, 'orchestrator.db');

    const first = createDatabase(filename);
    // Simulate a database seeded before the env bridge existed.
    const raw = first.getAgent('deepseek');
    expect(raw?.env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    first.close();

    database = createDatabase(filename);
    const deepseek = database.getAgent('deepseek');
    expect(deepseek?.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: '${DEEPSEEK_API_KEY}',
      ANTHROPIC_API_KEY: '${DEEPSEEK_API_KEY}',
    });
    const minimax = database.getAgent('minimax');
    expect(minimax?.env.ANTHROPIC_BASE_URL).toBe('https://api.minimax.io/anthropic');

    // A user edit is preserved while missing builtin keys are still backfilled.
    database.updateAgentOptions('deepseek', {
      env: { ANTHROPIC_BASE_URL: 'https://proxy.internal/anthropic' },
    });
    database.close();
    database = createDatabase(filename);
    const customized = database.getAgent('deepseek');
    expect(customized?.env.ANTHROPIC_BASE_URL).toBe('https://proxy.internal/anthropic');
    expect(customized?.env.ANTHROPIC_AUTH_TOKEN).toBe('${DEEPSEEK_API_KEY}');
  });

  it('never seeds executives into in-memory test databases', () => {
    database = createDatabase(':memory:');
    expect(database.listOrgAgents()).toEqual([]);
  });
});
