import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { RUNTIME_OPTION_KEYS, SKILL_CATEGORIES, TASK_STATUSES } from '../shared/domain.js';
import { createCouncilOrchestrator, type AgentInvoker } from './council.js';
import { registerRealtime } from './realtime.js';
import type { RunSupervisor } from './run-supervisor.js';
import websocket from '@fastify/websocket';
import type { OrchestratorDatabase } from './database.js';
import { createHierarchyOrchestrator } from './hierarchy.js';
import { registerPlatformApi, type ExportFailureLogger } from './platform-api.js';
import { registerWorkApi } from './work-api.js';
import { registerGovernanceApi } from './governance-api.js';
import { probeAgentRuntimes } from './runtime-health.js';
import type { PlatformEvent } from '../shared/platform.js';

export interface AppDependencies {
  database: OrchestratorDatabase;
  invoke: AgentInvoker;
  /**
   * The trusted actor, resolved server-side. No request body may supply it:
   * that is what stops an approval actor being spoofed.
   */
  currentUserId?: string;
  exportEvent?: (event: PlatformEvent) => Promise<unknown>;
  logExportFailure?: ExportFailureLogger;
  exportDrainTimeoutMs?: number;
  /**
   * Registers the realtime socket when supplied. Optional so a test that only
   * exercises HTTP does not have to stand up a run supervisor and a provider.
   */
  supervisor?: RunSupervisor;
}

const projectSchema = z.object({
  organizationId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(120),
  path: z.string().trim().min(1),
  description: z.string().trim().max(2_000).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
});

const organizationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
});

const skillSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  category: z.enum(SKILL_CATEGORIES).optional(),
  sourceUrl: z.string().trim().max(500).optional(),
  installCommand: z.string().trim().max(500).optional(),
  instructions: z.string().trim().min(1).max(20_000),
});

const taskSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(20_000).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
  assignedAgentId: z.string().trim().min(1).nullable().optional(),
});

const councilSchema = z.object({
  participantAgentIds: z.array(z.string().trim().min(1)).min(2).max(6),
});

const hierarchySchema = z.object({
  rootOrgAgentId: z.string().trim().min(1),
});

const moveTaskSchema = z.object({
  status: z.enum(TASK_STATUSES),
  position: z.number().int().min(0).max(100_000),
});

const optionValuesSchema = z.partialRecord(
  z.enum(RUNTIME_OPTION_KEYS),
  z.array(z.string().trim().min(1).max(200)).max(50),
);

const runtimeEnvSchema = z.record(
  z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'Invalid environment variable name'),
  z.string().max(2_000),
);

const agentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  command: z.string().trim().min(1).max(1_000),
  argsTemplate: z.array(z.string().max(20_000)).max(100),
  acpCommand: z.string().trim().min(1).max(1_000).nullable().optional(),
  acpArgs: z.array(z.string().max(20_000)).max(100).optional(),
  promptTransport: z.enum(['argument', 'stdin']).optional(),
  outputFormat: z.enum(['text', 'json', 'jsonl']).optional(),
  resultField: z.string().trim().max(200).nullable().optional(),
  versionArgs: z.array(z.string().max(1_000)).max(20).optional(),
  optionValues: optionValuesSchema.optional(),
  env: runtimeEnvSchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
});

const runtimeOptionsSchema = z.object({
  optionTemplates: z
    .partialRecord(
      z.enum(RUNTIME_OPTION_KEYS),
      z.array(z.string().trim().min(1).max(500)).min(1).max(10),
    )
    .optional(),
  optionValues: optionValuesSchema.optional(),
  env: runtimeEnvSchema.optional(),
});

const orgAgentSchema = z.object({
  organizationId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(120),
  jobTitle: z.string().trim().min(1).max(160),
  department: z.string().trim().min(1).max(120),
  jobFunction: z.string().trim().min(1).max(4_000),
  responsibilities: z.string().trim().min(1).max(10_000),
  instructions: z.string().trim().max(20_000).optional(),
  runtimeId: z.string().trim().min(1),
  managerId: z.string().trim().min(1).nullable().optional(),
  authorityLevel: z.number().int().min(0).max(100).optional(),
  canDelegate: z.boolean().optional(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  speed: z.string().trim().min(1).max(100).nullable().optional(),
  effort: z.string().trim().min(1).max(100).nullable().optional(),
  skillIds: z.array(z.string().trim().min(1)).max(50).optional(),
});

const managerSchema = z.object({
  managerId: z.string().trim().min(1).nullable(),
});

function assertProjectDirectory(path: string): void {
  if (!isAbsolute(path)) throw new Error('Project path must be absolute');
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error('Project path must be an existing directory');
  }
}

export function buildApp({
  database,
  invoke,
  currentUserId = 'owner',
  exportEvent,
  logExportFailure,
  exportDrainTimeoutMs,
  supervisor,
}: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  const council = createCouncilOrchestrator({ database, invoke });
  const hierarchy = createHierarchyOrchestrator({ database, invoke });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.code(400).send({ error: 'Invalid request', details: error.issues });
      return;
    }
    const message = error instanceof Error ? error.message : 'Unknown server error';
    if (
      message === 'Trusted approval actor does not own this portfolio' ||
      message === 'Trusted user does not own this portfolio' ||
      message === 'Trusted user does not own this idempotency key' ||
      message.startsWith('Access denied:') ||
      message.startsWith('Action not permitted for role') ||
      // governance: who may act, not whether the underlying data exists.
      message.includes('is not a reviewer on') ||
      message.endsWith('(checked again when the review was filed)') ||
      message.includes('may adjudicate:') ||
      message.includes('by the builder; it goes to the owner') ||
      message === 'Only the reviewer who raised the finding may contest the ruling on it' ||
      message.startsWith('Only the owner may resolve a P0 escalation:')
    ) {
      void reply.code(403).send({ error: message });
      return;
    }
    if (
      message === 'Idempotency key conflicts with another request' ||
      // governance: the request is well-formed but the process has not
      // reached, or has already passed, the point where it applies.
      message.includes('assign another before adjudicating') ||
      message.startsWith('All reviews must be filed before adjudication:') ||
      message.startsWith('This finding has a final ruling and cannot be reopened:') ||
      message.startsWith('This finding has already been ruled on; only a contest reopens it:') ||
      message === 'There is no ruling to contest on this finding yet' ||
      message.includes('has already contested this ruling; a reviewer may contest once') ||
      message.startsWith('This escalation is already resolved:')
    ) {
      void reply.code(409).send({ error: message });
      return;
    }
    if (
      message === 'Project path must be absolute' ||
      message === 'Project path must be an existing directory' ||
      message.startsWith('Free text appears to contain a credential')
    ) {
      void reply.code(400).send({ error: message });
      return;
    }
    if (
      message.startsWith('Project not found:') ||
      message.startsWith('Portfolio not found:') ||
      message.startsWith('Venture not found:') ||
      message.startsWith('Approval not found:') ||
      message.startsWith('Task not found:') ||
      message.startsWith('Run not found:') ||
      message.startsWith('User not found:') ||
      message.startsWith('Agent not found:') ||
      message.startsWith('Agent runtime not found:') ||
      message.startsWith('Organization not found:') ||
      message.startsWith('Department not found:') ||
      message.startsWith('Skill not found:') ||
      message.startsWith('Organizational agent not found:')
    ) {
      void reply.code(404).send({ error: message });
      return;
    }
    if (
      message.includes('cycle') ||
      message.startsWith('Invalid project lifecycle transition:') ||
      message.startsWith('Project plan can only be submitted from') ||
      message.startsWith('Project is not pending approval:') ||
      message.startsWith('Approval has already been decided') ||
      message.startsWith('Temporary staff require an expiry condition') ||
      message.startsWith('Only temporary staff carry an expiry condition') ||
      message.startsWith('Permanent staff cannot be') ||
      message.startsWith('Manager cannot delegate:') ||
      message.startsWith('Hierarchy exceeds maximum depth') ||
      message.startsWith('Hierarchy runs support at most') ||
      message.startsWith('Organizational agent is not assigned to project:') ||
      message.startsWith('Agent has no runtime assigned:') ||
      message.startsWith('Agent runtime is disabled:') ||
      // The three refusals `agentSpawnOptions` and `identityOf` add: an owner
      // can act on all three (assign a runtime, or pick a different agent),
      // so they are classified even though their pre-existing siblings below
      // (`assertAgentMayHoldRole`'s disabled/venture messages, and
      // `agentSpawnOptions`'s own "runtime not found") are not — reclassifying
      // those is a separate change this one does not make.
      message.includes('has no runtime assigned and cannot run a session') ||
      message.startsWith('Runtime is disabled for agent ') ||
      message.includes('has no runtime assigned and may not hold a role on a card') ||
      // governance: the submitted content itself is incomplete, not who sent
      // it or what state the record is in.
      message === 'A review must answer the gate checklist; an empty checklist is not a review' ||
      message.startsWith('"Not applicable" is an answer; silence is not.') ||
      message.startsWith('A finding needs evidence at file:line:') ||
      message.startsWith('A finding needs a predicted failure, or it is a worry:') ||
      message.includes('without them it is a finding dropped') ||
      message.includes("is not on this project's ladder")
    ) {
      void reply.code(400).send({ error: message });
      return;
    }
    void reply.code(500).send({ error: message });
  });

  registerPlatformApi(app, database.platform, {
    currentUserId,
    identity: database.identity,
    exportEvent,
    logExportFailure,
    exportDrainTimeoutMs,
  });

  app.get('/api/health', async () => ({ status: 'ok' }));

  app.get('/api/stats', async () => database.getDashboardStats());

  app.get('/api/organizations', async () => ({ organizations: database.listOrganizations() }));

  app.post('/api/organizations', async (request, reply) => {
    const input = organizationSchema.parse(request.body);
    return await reply.code(201).send(database.createOrganization(input));
  });

  app.get('/api/skills', async () => ({ skills: database.listSkills() }));

  app.post('/api/skills', async (request, reply) => {
    const input = skillSchema.parse(request.body);
    return await reply.code(201).send(database.createSkill(input));
  });

  app.get('/api/projects', async () => ({ projects: database.listProjects() }));

  app.get('/api/agents', async () => ({ agents: database.listAgents() }));

  app.post('/api/agents', async (request, reply) => {
    const input = agentSchema.parse(request.body);
    const agent = database.createAgent(input);
    return await reply.code(201).send(agent);
  });

  app.patch<{ Params: { agentId: string } }>(
    '/api/agents/:agentId/options',
    async (request, reply) => {
      const input = runtimeOptionsSchema.parse(request.body);
      const patch: Parameters<typeof database.updateAgentOptions>[1] = {};
      if (input.optionTemplates !== undefined) {
        patch.optionTemplates = Object.fromEntries(
          Object.entries(input.optionTemplates).filter(([, value]) => value !== undefined),
        );
      }
      if (input.optionValues !== undefined) {
        patch.optionValues = Object.fromEntries(
          Object.entries(input.optionValues).filter(([, value]) => value !== undefined),
        );
      }
      if (input.env !== undefined) patch.env = input.env;
      return await reply.send(database.updateAgentOptions(request.params.agentId, patch));
    },
  );

  app.get('/api/agents/health', async () => ({
    health: await probeAgentRuntimes(database.listAgents()),
  }));

  app.get('/api/runs/recent', async () => ({ runs: database.listRecentRuns(12) }));

  app.get('/api/org-agents', async () => ({ agents: database.listOrgAgents() }));

  app.post('/api/org-agents', async (request, reply) => {
    const input = orgAgentSchema.parse(request.body);
    return await reply.code(201).send(database.createOrgAgent(input));
  });

  app.patch<{ Params: { orgAgentId: string } }>(
    '/api/org-agents/:orgAgentId/manager',
    async (request) => {
      const input = managerSchema.parse(request.body);
      return database.setOrgAgentManager(request.params.orgAgentId, input.managerId);
    },
  );

  app.post('/api/projects', async (request, reply) => {
    const input = projectSchema.parse(request.body);
    assertProjectDirectory(input.path);
    const project = database.createProject(input);
    return await reply.code(201).send(project);
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/board', async (request) => {
    const project = database.getProject(request.params.projectId);
    if (!project) throw new Error(`Project not found: ${request.params.projectId}`);
    return database.getBoard(project.id);
  });

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/team', async (request) => {
    const project = database.getProject(request.params.projectId);
    if (!project) throw new Error(`Project not found: ${request.params.projectId}`);
    return { agents: database.listProjectOrgAgents(project.id) };
  });

  app.put<{ Params: { projectId: string; orgAgentId: string } }>(
    '/api/projects/:projectId/team/:orgAgentId',
    async (request, reply) => {
      database.assignOrgAgentToProject(request.params.projectId, request.params.orgAgentId);
      return await reply.code(204).send();
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/tasks',
    async (request, reply) => {
      const project = database.getProject(request.params.projectId);
      if (!project) throw new Error(`Project not found: ${request.params.projectId}`);
      const input = taskSchema.parse(request.body);
      const task = database.createTask({ projectId: project.id, ...input });
      return await reply.code(201).send(task);
    },
  );

  app.patch<{ Params: { taskId: string } }>('/api/tasks/:taskId/move', async (request) => {
    const input = moveTaskSchema.parse(request.body);
    return database.moveTask(request.params.taskId, input.status, input.position);
  });

  app.post<{ Params: { taskId: string } }>('/api/tasks/:taskId/council', async (request, reply) => {
    const input = councilSchema.parse(request.body);
    const run = await council.run({
      taskId: request.params.taskId,
      participantAgentIds: input.participantAgentIds,
    });
    return await reply.code(201).send({
      run,
      messages: database.listRunMessages(run.id),
    });
  });

  app.post<{ Params: { taskId: string } }>(
    '/api/tasks/:taskId/hierarchy',
    async (request, reply) => {
      const input = hierarchySchema.parse(request.body);
      const run = await hierarchy.run({
        taskId: request.params.taskId,
        rootOrgAgentId: input.rootOrgAgentId,
      });
      return await reply.code(201).send({
        run,
        messages: database.listRunMessages(run.id),
      });
    },
  );

  app.get<{ Params: { runId: string } }>('/api/runs/:runId/messages', async (request) => {
    const run = database.getRun(request.params.runId);
    if (!run) throw new Error(`Run not found: ${request.params.runId}`);
    return { run, messages: database.listRunMessages(run.id) };
  });

  registerWorkApi(app, database, { currentUserId, supervisor });
  registerGovernanceApi(app, database, { currentUserId });

  if (supervisor) {
    // Registered last so the plugin is in place before the route it serves.
    //
    // `after` and not `.then()`: the Fastify instance is a thenable, so awaiting
    // it — or attaching a `then` to it — starts the boot from inside the builder.
    // A plugin the caller registers on the app we return (@fastify/static, under
    // `npm start`) would then resolve against that already-running boot without
    // actually loading, and the boot would never finish. `after` queues the same
    // ordering without resolving anything.
    app.register(websocket);
    app.after(() => {
      registerRealtime(app, { database, supervisor, currentUserId });
    });
  }

  return app;
}
