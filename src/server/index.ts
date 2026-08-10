import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { runAgentProcess } from './agent-process.js';
import type { AgentInvoker } from './council.js';
import { createDatabase } from './database.js';
import { createObsidianExporter } from './obsidian-exporter.js';
import { createRunSupervisor } from './run-supervisor.js';
import { resolveRuntimeEnv } from './agent-process.js';
import { resolveAiLabsPaths } from './paths.js';
import { startTenureSweep } from './tenure-sweep.js';

const host = process.env.ORCHESTRATOR_HOST ?? '127.0.0.1';
const port = Number(process.env.ORCHESTRATOR_PORT ?? '4317');
// Walk up to the directory holding package.json. This is correct both for the
// built output (dist/server/server/index.js) and when running from source under
// tsx, where the relative depth differs.
function findRepositoryRoot(startDirectory: string): string {
  let directory = startDirectory;
  for (;;) {
    if (existsSync(resolve(directory, 'package.json'))) return directory;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error(`Could not locate the repository root above ${startDirectory}`);
    }
    directory = parent;
  }
}

const repositoryRoot = findRepositoryRoot(fileURLToPath(new URL('.', import.meta.url)));
const paths = resolveAiLabsPaths({ repositoryRoot });
const database = createDatabase(resolve(paths.dataDir, 'orchestrator.db'));
const invoke: AgentInvoker = async ({ runtime, prompt, projectPath, taskId, runId, options }) => {
  const result = await runAgentProcess({
    runtime,
    prompt,
    projectPath,
    context: { taskId, runId },
    options,
  });
  return result.content;
};

// The mirror is opt-in and has no default path: a hardcoded personal vault
// location would be real data in a published repository. Without it configured,
// events are still recorded durably and simply queue in the export outbox.
const obsidianVaultPath = process.env.AI_LABS_OBSIDIAN_VAULT;
const obsidianExporter = obsidianVaultPath
  ? createObsidianExporter({ vaultPath: obsidianVaultPath })
  : null;
const currentUserId = process.env.AI_LABS_OWNER_USER_ID ?? 'owner';

/**
 * How a run launches an agent's provider.
 *
 * The runtime's own command and arguments are used verbatim, and its `${VAR}`
 * environment references resolve at launch through the same helper every other
 * runtime launch uses. AI Labs never holds a model credential: the provider's
 * own CLI does, and the value is read from the environment at the moment of
 * spawn rather than stored anywhere here.
 */
const supervisor = createRunSupervisor({
  database,
  spawnFor: (agent) => {
    const runtime = database.getAgent(agent.runtimeId);
    if (!runtime) throw new Error(`Runtime not found for agent ${agent.id}: ${agent.runtimeId}`);
    return {
      command: runtime.command,
      args: runtime.argsTemplate,
      cwd: process.cwd(),
      env: resolveRuntimeEnv(runtime.env ?? {}),
    };
  },
});

const app = buildApp({
  database,
  invoke,
  currentUserId,
  supervisor,
  exportEvent: obsidianExporter ? (event) => obsidianExporter.exportEvent(event) : undefined,
});
const webRoot = resolve('./dist/web');

if (existsSync(webRoot)) {
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/',
  });
}

// Date-based tenure expiry needs something to drive it, or a recorded end date is
// a promise the platform never keeps.
const tenureSweep = startTenureSweep(database, {
  onResult: (result) => {
    for (const orgAgentId of result.expired) {
      console.log(`Tenure ended: ${orgAgentId}`);
    }
    for (const blocked of result.blocked) {
      console.warn(`Tenure expiry blocked for ${blocked.orgAgentId}: ${blocked.reason}`);
    }
  },
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'Shutting down AI Labs core');
  tenureSweep.stop();
  await app.close();
  database.close();
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

try {
  await app.listen({ host, port });
  console.log(`AI Labs core listening at http://${host}:${port}`);
  console.log(`Data:    ${paths.dataDir}`);
  console.log(`Profile: ${paths.profileDir}`);
} catch (error) {
  database.close();
  throw error;
}
