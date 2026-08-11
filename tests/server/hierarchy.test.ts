import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/server/database.js';
import { createHierarchyOrchestrator } from '../../src/server/hierarchy.js';
import type { AgentInvoker } from '../../src/server/council.js';

describe('hierarchical orchestration', () => {
  it('collects specialist work upward through direct managers with role attribution', async () => {
    const database = createDatabase(':memory:');
    const project = database.createProject({ name: 'Hierarchy Run', path: '/work/hierarchy-run' });
    const task = database.createTask({
      projectId: project.id,
      title: 'Design a safe plugin system',
      description: 'Keep credentials outside the application database.',
      status: 'ready',
    });
    const root = database.createOrgAgent({
      name: 'Hermes',
      jobTitle: 'Chief Technology Officer',
      department: 'Executive',
      jobFunction: 'Coordinate technical strategy.',
      responsibilities: 'Approve the final technical decision.',
      runtimeId: 'hermes',
      authorityLevel: 100,
      canDelegate: true,
    });
    const lead = database.createOrgAgent({
      name: 'Claudia',
      jobTitle: 'Engineering Manager',
      department: 'Engineering',
      jobFunction: 'Review and integrate engineering work.',
      responsibilities: 'Resolve implementation risks before reporting upward.',
      runtimeId: 'claude',
      managerId: root.id,
      authorityLevel: 80,
      canDelegate: true,
    });
    const researcher = database.createOrgAgent({
      name: 'Kim',
      jobTitle: 'Security Researcher',
      department: 'Security',
      jobFunction: 'Find credential and process-boundary risks.',
      responsibilities: 'Return concrete threats and mitigations.',
      runtimeId: 'kimi',
      managerId: lead.id,
      authorityLevel: 50,
    });
    const engineer = database.createOrgAgent({
      name: 'Cody',
      jobTitle: 'Senior Implementation Engineer',
      department: 'Engineering',
      jobFunction: 'Develop an implementable design.',
      responsibilities: 'Return interfaces, tests, and failure handling.',
      runtimeId: 'codex',
      managerId: lead.id,
      authorityLevel: 50,
    });
    for (const agent of [root, lead, researcher, engineer]) {
      database.assignOrgAgentToProject(project.id, agent.id);
    }

    const invocations: Array<{ runtimeId: string; prompt: string }> = [];
    const invoke: AgentInvoker = async ({ runtime, prompt }) => {
      invocations.push({ runtimeId: runtime.id, prompt });
      const orgAgentId = prompt.match(/\[ORG_AGENT:([^\]]+)\]/)?.[1] ?? 'unknown';
      return `response from ${orgAgentId}`;
    };

    try {
      const orchestrator = createHierarchyOrchestrator({ database, invoke });
      const completed = await orchestrator.run({ taskId: task.id, rootOrgAgentId: root.id });
      const messages = database.listRunMessages(completed.id);

      expect(completed).toMatchObject({
        mode: 'hierarchy',
        status: 'completed',
        rootOrgAgentId: root.id,
      });
      expect(invocations.map(({ runtimeId }) => runtimeId)).toEqual(['kimi', 'codex', 'claude', 'hermes']);
      expect(invocations[0]?.prompt).toContain('Security Researcher');
      expect(invocations[0]?.prompt).toContain('Find credential and process-boundary risks.');
      expect(invocations[2]?.prompt).toContain('response from ' + researcher.id);
      expect(invocations[2]?.prompt).toContain('response from ' + engineer.id);
      expect(invocations[3]?.prompt).toContain('response from ' + lead.id);
      expect(messages.map(({ orgAgentId }) => orgAgentId)).toEqual([
        researcher.id,
        engineer.id,
        lead.id,
        root.id,
      ]);
      expect(messages.at(-1)).toMatchObject({
        agentId: 'hermes',
        orgAgentId: root.id,
        phase: 'synthesis',
        content: `response from ${root.id}`,
      });
      expect(database.getBoard(project.id).review.map((item) => item.id)).toContain(task.id);
    } finally {
      database.close();
    }
  });

  it('REFUSES an agent with no runtime assigned, before invoking anything', async () => {
    const database = createDatabase(':memory:');
    const project = database.createProject({ name: 'Hierarchy Guard', path: '/work/hierarchy-guard' });
    const task = database.createTask({
      projectId: project.id,
      title: 'Do the work',
      status: 'ready',
    });
    const root = database.createOrgAgent({
      name: 'Unassigned',
      jobTitle: 'Specialist',
      department: 'Research',
      jobFunction: 'Does the work.',
      responsibilities: 'Work.',
      runtimeId: 'hermes',
    });
    database.assignOrgAgentToProject(project.id, root.id);
    // Nothing in the domain layer produces this state yet (creation still
    // requires a runtime); simulated directly, the same way the governance
    // tests simulate a retired agent.
    database.connection.prepare('UPDATE org_agents SET runtime_id = NULL WHERE id = ?').run(root.id);

    let invoked = false;
    const invoke: AgentInvoker = async () => {
      invoked = true;
      return 'unreachable';
    };

    try {
      const orchestrator = createHierarchyOrchestrator({ database, invoke });
      await expect(
        orchestrator.run({ taskId: task.id, rootOrgAgentId: root.id }),
      ).rejects.toThrow(/no runtime/i);
      // Refused before anything ran — not merely before the run was marked done.
      expect(invoked).toBe(false);
    } finally {
      database.close();
    }
  });
});
