import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { runAgentProcess } from './agent-process.js';
import type { AgentInvoker } from './council.js';
import { createDatabase } from './database.js';

const host = process.env.ORCHESTRATOR_HOST ?? '127.0.0.1';
const port = Number(process.env.ORCHESTRATOR_PORT ?? '4317');
const dataDirectory = resolve(process.env.ORCHESTRATOR_DATA_DIR ?? './data');
const database = createDatabase(resolve(dataDirectory, 'orchestrator.db'));
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
const app = buildApp({ database, invoke });
const webRoot = resolve('./dist/web');

if (existsSync(webRoot)) {
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/',
  });
}

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'Shutting down Hermes Orchestrator');
  await app.close();
  database.close();
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

try {
  await app.listen({ host, port });
  console.log(`Hermes Orchestrator listening at http://${host}:${port}`);
  console.log(`Local data: ${dataDirectory}`);
} catch (error) {
  database.close();
  throw error;
}
