import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/server/database.js';

describe('organizational agent hierarchy', () => {
  it('persists job functions, reporting lines, and project team assignments', () => {
    const database = createDatabase(':memory:');
    try {
      const project = database.createProject({ name: 'Hierarchy Project', path: '/work/hierarchy' });
      const chief = database.createOrgAgent({
        name: 'Hermes',
        jobTitle: 'Chief Technology Officer',
        department: 'Executive',
        jobFunction: 'Coordinate technical strategy and approve final recommendations.',
        responsibilities: 'Route work, reconcile disagreement, and protect project constraints.',
        instructions: 'Be decisive and preserve material dissent.',
        runtimeId: 'hermes',
        authorityLevel: 100,
        canDelegate: true,
      });
      const lead = database.createOrgAgent({
        name: 'Claudia',
        jobTitle: 'Lead Software Architect',
        department: 'Engineering',
        jobFunction: 'Own architecture and technical design.',
        responsibilities: 'Review boundaries, risks, and implementation plans.',
        instructions: 'Prefer maintainable local-first designs.',
        runtimeId: 'claude',
        managerId: chief.id,
        authorityLevel: 80,
        canDelegate: true,
      });
      const engineer = database.createOrgAgent({
        name: 'Cody',
        jobTitle: 'Senior Implementation Engineer',
        department: 'Engineering',
        jobFunction: 'Implement and test approved designs.',
        responsibilities: 'Write minimal code, tests, and verification evidence.',
        runtimeId: 'codex',
        managerId: lead.id,
        authorityLevel: 50,
      });

      database.assignOrgAgentToProject(project.id, chief.id);
      database.assignOrgAgentToProject(project.id, lead.id);
      database.assignOrgAgentToProject(project.id, engineer.id);

      expect(database.listOrgAgents().map(({ id, managerId }) => ({ id, managerId }))).toEqual([
        { id: chief.id, managerId: null },
        { id: lead.id, managerId: chief.id },
        { id: engineer.id, managerId: lead.id },
      ]);
      expect(database.listProjectOrgAgents(project.id).map((agent) => agent.id)).toEqual([
        chief.id,
        lead.id,
        engineer.id,
      ]);
    } finally {
      database.close();
    }
  });

  it('rejects reporting cycles', () => {
    const database = createDatabase(':memory:');
    try {
      const manager = database.createOrgAgent({
        name: 'Manager',
        jobTitle: 'Engineering Manager',
        department: 'Engineering',
        jobFunction: 'Manage delivery.',
        responsibilities: 'Review direct reports.',
        runtimeId: 'claude',
        canDelegate: true,
      });
      const report = database.createOrgAgent({
        name: 'Report',
        jobTitle: 'Engineer',
        department: 'Engineering',
        jobFunction: 'Implement tasks.',
        responsibilities: 'Build and test.',
        runtimeId: 'codex',
        managerId: manager.id,
      });

      expect(() => database.setOrgAgentManager(manager.id, report.id)).toThrow(/cycle/i);
      expect(database.getOrgAgent(manager.id)?.managerId).toBeNull();
    } finally {
      database.close();
    }
  });
});
