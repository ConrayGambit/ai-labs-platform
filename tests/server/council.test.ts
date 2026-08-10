import { describe, expect, it } from 'vitest';
import { createCouncilOrchestrator, type AgentInvoker } from '../../src/server/council.js';
import { createDatabase } from '../../src/server/database.js';

describe('multi-agent council', () => {
  it('runs proposal, cross-critique, and Hermes synthesis phases before review', async () => {
    const database = createDatabase(':memory:');
    const project = database.createProject({ name: 'Council Project', path: '/work/council-project' });
    const task = database.createTask({
      projectId: project.id,
      title: 'Choose an orchestration architecture',
      description: 'Prefer local-first execution and existing OAuth sessions.',
      status: 'ready',
    });
    const invocations: Array<{ agentId: string; prompt: string }> = [];
    const invoke: AgentInvoker = async ({ runtime, prompt }) => {
      invocations.push({ agentId: runtime.id, prompt });
      const phase = prompt.match(/\[PHASE:(\w+)\]/)?.[1] ?? 'unknown';
      return `${phase} response from ${runtime.id}`;
    };

    try {
      const orchestrator = createCouncilOrchestrator({ database, invoke });
      const completed = await orchestrator.run({
        taskId: task.id,
        participantAgentIds: ['kimi', 'claude', 'codex'],
      });
      const messages = database.listRunMessages(completed.id);

      expect(completed.status).toBe('completed');
      expect(messages.filter((message) => message.phase === 'proposal')).toHaveLength(3);
      expect(messages.filter((message) => message.phase === 'critique')).toHaveLength(3);
      expect(messages.at(-1)).toMatchObject({
        agentId: 'hermes',
        phase: 'synthesis',
        content: 'synthesis response from hermes',
      });
      const kimiCritique = invocations.find(
        (invocation) => invocation.agentId === 'kimi' && invocation.prompt.includes('[PHASE:critique]'),
      );
      expect(kimiCritique?.prompt).toContain('proposal response from claude');
      expect(kimiCritique?.prompt).toContain('proposal response from codex');
      expect(kimiCritique?.prompt).not.toContain('proposal response from kimi');
      expect(database.getBoard(project.id).review.map((item) => item.id)).toContain(task.id);
    } finally {
      database.close();
    }
  });
});
