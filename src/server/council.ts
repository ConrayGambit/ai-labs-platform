import type { AgentRuntime, OrchestrationRun, Project, RuntimeOptionValues, Task } from '../shared/domain.js';
import type { OrchestratorDatabase } from './database.js';

export interface AgentInvocation {
  runtime: AgentRuntime;
  prompt: string;
  projectPath: string;
  taskId: string;
  runId: string;
  options?: RuntimeOptionValues;
}

export type AgentInvoker = (invocation: AgentInvocation) => Promise<string>;

export interface CouncilDependencies {
  database: OrchestratorDatabase;
  invoke: AgentInvoker;
}

export interface CouncilRunInput {
  taskId: string;
  participantAgentIds: string[];
}

export interface CouncilOrchestrator {
  run(input: CouncilRunInput): Promise<OrchestrationRun>;
}

interface AttributedResponse {
  agent: AgentRuntime;
  content: string;
}

function requireTask(database: OrchestratorDatabase, taskId: string): Task {
  const task = database.getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

function requireProject(database: OrchestratorDatabase, projectId: string): Project {
  const project = database.getProject(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  return project;
}

function requireAgent(database: OrchestratorDatabase, agentId: string): AgentRuntime {
  const agent = database.getAgent(agentId);
  if (!agent) throw new Error(`Agent not found: ${agentId}`);
  if (!agent.enabled) throw new Error(`Agent is disabled: ${agentId}`);
  return agent;
}

function taskBrief(task: Task, project: Project): string {
  return [
    `Project: ${project.name}`,
    `Repository: ${project.path}`,
    `Task: ${task.title}`,
    task.description ? `Description: ${task.description}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function proposalPrompt(task: Task, project: Project): string {
  return [
    '[PHASE:proposal]',
    taskBrief(task, project),
    '',
    'Produce an independent technical proposal. State assumptions, risks, concrete implementation steps, and verification. Do not defer to other agents.',
  ].join('\n');
}

function critiquePrompt(
  task: Task,
  project: Project,
  proposals: AttributedResponse[],
  currentAgentId: string,
): string {
  const peerProposals = proposals
    .filter(({ agent }) => agent.id !== currentAgentId)
    .map(({ agent, content }) => `--- ${agent.name} ---\n${content}`)
    .join('\n\n');
  return [
    '[PHASE:critique]',
    taskBrief(task, project),
    '',
    'Critique the peer proposals below. Identify concrete defects, disagreements, security concerns, and improvements. Do not repeat your own proposal.',
    '',
    peerProposals,
  ].join('\n');
}

function synthesisPrompt(
  task: Task,
  project: Project,
  proposals: AttributedResponse[],
  critiques: AttributedResponse[],
): string {
  const format = (heading: string, responses: AttributedResponse[]) => [
    heading,
    ...responses.map(({ agent, content }) => `--- ${agent.name} ---\n${content}`),
  ].join('\n\n');
  return [
    '[PHASE:synthesis]',
    taskBrief(task, project),
    '',
    format('PROPOSALS', proposals),
    '',
    format('CRITIQUES', critiques),
    '',
    'Synthesize a single decision and execution brief. Resolve disagreements explicitly, preserve material dissent, define acceptance criteria, and stop after this synthesis.',
  ].join('\n');
}

export function createCouncilOrchestrator({
  database,
  invoke,
}: CouncilDependencies): CouncilOrchestrator {
  return {
    async run(input) {
      if (input.participantAgentIds.length < 2 || input.participantAgentIds.length > 6) {
        throw new Error('Council runs require between 2 and 6 participant agents');
      }

      const task = requireTask(database, input.taskId);
      const project = requireProject(database, task.projectId);
      const workers = [...new Set(input.participantAgentIds)].map((id) => requireAgent(database, id));
      const coordinator = requireAgent(database, 'hermes');
      const run = database.createRun({
        taskId: task.id,
        mode: 'council',
        coordinatorAgentId: coordinator.id,
      });

      try {
        database.updateRunStatus(run.id, 'running');
        database.moveTask(task.id, 'in_progress', 0);

        const proposalContents = await Promise.all(
          workers.map((runtime) =>
            invoke({
              runtime,
              prompt: proposalPrompt(task, project),
              projectPath: project.path,
              taskId: task.id,
              runId: run.id,
            }),
          ),
        );
        const proposals = workers.map((agent, index) => ({
          agent,
          content: proposalContents[index]!,
        }));
        for (const proposal of proposals) {
          database.addRunMessage({
            runId: run.id,
            taskId: task.id,
            agentId: proposal.agent.id,
            phase: 'proposal',
            role: 'assistant',
            content: proposal.content,
          });
        }

        const critiqueContents = await Promise.all(
          workers.map((runtime) =>
            invoke({
              runtime,
              prompt: critiquePrompt(task, project, proposals, runtime.id),
              projectPath: project.path,
              taskId: task.id,
              runId: run.id,
            }),
          ),
        );
        const critiques = workers.map((agent, index) => ({
          agent,
          content: critiqueContents[index]!,
        }));
        for (const critique of critiques) {
          database.addRunMessage({
            runId: run.id,
            taskId: task.id,
            agentId: critique.agent.id,
            phase: 'critique',
            role: 'assistant',
            content: critique.content,
          });
        }

        const synthesis = await invoke({
          runtime: coordinator,
          prompt: synthesisPrompt(task, project, proposals, critiques),
          projectPath: project.path,
          taskId: task.id,
          runId: run.id,
        });
        database.addRunMessage({
          runId: run.id,
          taskId: task.id,
          agentId: coordinator.id,
          phase: 'synthesis',
          role: 'assistant',
          content: synthesis,
        });
        database.moveTask(task.id, 'review', 0);
        return database.updateRunStatus(run.id, 'completed');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        database.addRunMessage({
          runId: run.id,
          taskId: task.id,
          agentId: coordinator.id,
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
