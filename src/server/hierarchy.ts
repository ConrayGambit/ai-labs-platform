import type { AgentRuntime, OrgAgent, OrchestrationRun, Project, Skill, Task } from '../shared/domain.js';
import type { AgentInvoker } from './council.js';
import type { OrchestratorDatabase } from './database.js';

const MAX_PARTICIPANTS = 12;

export interface HierarchyDependencies {
  database: OrchestratorDatabase;
  invoke: AgentInvoker;
}

export interface HierarchyRunInput {
  taskId: string;
  rootOrgAgentId: string;
}

export interface HierarchyOrchestrator {
  run(input: HierarchyRunInput): Promise<OrchestrationRun>;
}

interface AgentExecution {
  agent: OrgAgent;
  content: string;
}

function roleContext(agent: OrgAgent, skills: Skill[]): string {
  const lines = [
    `[ORG_AGENT:${agent.id}]`,
    `Name: ${agent.name}`,
    `Job title: ${agent.jobTitle}`,
    `Department: ${agent.department}`,
    `Job function: ${agent.jobFunction}`,
    `Responsibilities: ${agent.responsibilities}`,
    agent.instructions ? `Role instructions: ${agent.instructions}` : '',
    `Authority level: ${agent.authorityLevel}/100`,
  ].filter(Boolean);
  if (skills.length > 0) {
    lines.push(
      '',
      'ASSIGNED SKILLS — apply this guidance in your work:',
      ...skills.map((skill) => `--- ${skill.name} ---\n${skill.instructions}`),
    );
  }
  return lines.join('\n');
}

function taskContext(task: Task, project: Project): string {
  return [
    `Project: ${project.name}`,
    `Repository: ${project.path}`,
    `Task: ${task.title}`,
    task.description ? `Description: ${task.description}` : '',
  ].filter(Boolean).join('\n');
}

function specialistPrompt(agent: OrgAgent, task: Task, project: Project, skills: Skill[]): string {
  return [
    '[PHASE:execution]',
    roleContext(agent, skills),
    '',
    taskContext(task, project),
    '',
    'Complete the task only from your assigned job function. Return concrete findings, evidence, risks, and recommendations to your direct manager. Do not claim authority outside your role and stop after this report.',
  ].join('\n');
}

function managerPrompt(
  agent: OrgAgent,
  task: Task,
  project: Project,
  reports: AgentExecution[],
  skills: Skill[],
): string {
  const reportText = reports.map(({ agent: report, content }) => [
    `--- ${report.name} | ${report.jobTitle} | ${report.department} ---`,
    content,
  ].join('\n')).join('\n\n');
  return [
    '[PHASE:synthesis]',
    roleContext(agent, skills),
    '',
    taskContext(task, project),
    '',
    'DIRECT REPORTS',
    reportText,
    '',
    'Review only the direct reports above. Reconcile conflicts explicitly, preserve material dissent, identify missing evidence, and produce a bounded decision/report for your own manager. Do not start another discussion round.',
  ].join('\n');
}

function requireRuntime(database: OrchestratorDatabase, agent: OrgAgent): AgentRuntime {
  const runtime = database.getAgent(agent.runtimeId);
  if (!runtime) throw new Error(`Agent runtime not found: ${agent.runtimeId}`);
  if (!runtime.enabled) throw new Error(`Agent runtime is disabled: ${agent.runtimeId}`);
  return runtime;
}

export function createHierarchyOrchestrator({
  database,
  invoke,
}: HierarchyDependencies): HierarchyOrchestrator {
  return {
    async run(input) {
      const task = database.getTask(input.taskId);
      if (!task) throw new Error(`Task not found: ${input.taskId}`);
      const project = database.getProject(task.projectId);
      if (!project) throw new Error(`Project not found: ${task.projectId}`);
      const team = database.listProjectOrgAgents(project.id).filter((agent) => agent.enabled);
      const root = team.find((agent) => agent.id === input.rootOrgAgentId);
      if (!root) throw new Error(`Organizational agent is not assigned to project: ${input.rootOrgAgentId}`);

      const childrenByManager = new Map<string, OrgAgent[]>();
      for (const agent of team) {
        if (!agent.managerId) continue;
        const reports = childrenByManager.get(agent.managerId) ?? [];
        reports.push(agent);
        childrenByManager.set(agent.managerId, reports);
      }

      const participants: OrgAgent[] = [];
      const collectSubtree = (agent: OrgAgent): void => {
        participants.push(agent);
        for (const report of childrenByManager.get(agent.id) ?? []) collectSubtree(report);
      };
      collectSubtree(root);
      if (participants.length > MAX_PARTICIPANTS) {
        throw new Error(`Hierarchy runs support at most ${MAX_PARTICIPANTS} participants`);
      }
      for (const agent of participants) requireRuntime(database, agent);

      const rootRuntime = requireRuntime(database, root);
      const run = database.createRun({
        taskId: task.id,
        mode: 'hierarchy',
        coordinatorAgentId: rootRuntime.id,
        rootOrgAgentId: root.id,
      });

      const executeAgent = async (agent: OrgAgent): Promise<AgentExecution> => {
        const reports = await Promise.all(
          (childrenByManager.get(agent.id) ?? []).map((report) => executeAgent(report)),
        );
        const runtime = requireRuntime(database, agent);
        const skills = database.listOrgAgentSkills(agent.id);
        const prompt = reports.length === 0
          ? specialistPrompt(agent, task, project, skills)
          : managerPrompt(agent, task, project, reports, skills);
        const content = await invoke({
          runtime,
          prompt,
          projectPath: project.path,
          taskId: task.id,
          runId: run.id,
          options: { model: agent.model, speed: agent.speed, effort: agent.effort },
        });
        database.addRunMessage({
          runId: run.id,
          taskId: task.id,
          agentId: runtime.id,
          orgAgentId: agent.id,
          phase: reports.length === 0 ? 'execution' : 'synthesis',
          role: 'assistant',
          content,
        });
        return { agent, content };
      };

      try {
        database.updateRunStatus(run.id, 'running');
        database.moveTask(task.id, 'in_progress', 0);
        await executeAgent(root);
        database.moveTask(task.id, 'review', 0);
        return database.updateRunStatus(run.id, 'completed');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        database.addRunMessage({
          runId: run.id,
          taskId: task.id,
          agentId: rootRuntime.id,
          orgAgentId: root.id,
          phase: 'error',
          role: 'system',
          content: message,
        });
        database.updateRunStatus(run.id, 'failed', message);
        database.moveTask(task.id, 'blocked', 0);
        throw error;
      }
    },
  };
}
