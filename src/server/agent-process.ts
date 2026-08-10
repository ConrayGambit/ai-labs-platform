import { spawn } from 'node:child_process';
import { RUNTIME_OPTION_KEYS } from '../shared/domain.js';
import type { AgentRuntime, RuntimeOptionValues } from '../shared/domain.js';

const DEFAULT_OUTPUT_LIMIT = 2 * 1024 * 1024;

export interface AgentInvocationContext {
  taskId: string;
  runId: string;
}

export interface AgentProcessInvocation {
  runtime: AgentRuntime;
  prompt: string;
  projectPath: string;
  context: AgentInvocationContext;
  options?: RuntimeOptionValues;
  signal?: AbortSignal;
  outputLimitBytes?: number;
}

export interface AgentProcessResult {
  content: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

function renderArgument(
  template: string,
  values: Record<'prompt' | 'projectPath' | 'taskId' | 'runId', string>,
): string {
  return template.replace(/\{(prompt|projectPath|taskId|runId)\}/g, (_, key: keyof typeof values) => {
    return values[key];
  });
}

/**
 * Resolve `${VAR}` references in a runtime env map against the host environment.
 * Missing variables resolve to an empty string so misconfigured providers fail
 * authentication loudly instead of sending a literal placeholder as a token.
 */
export function resolveRuntimeEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => process.env[name] ?? ''),
    ]),
  );
}

function normalizeOutput(runtime: AgentRuntime, stdout: string): string {
  const trimmed = stdout.trim();
  if (runtime.outputFormat !== 'json') {
    return trimmed;
  }

  const parsed = JSON.parse(trimmed) as unknown;
  if (!runtime.resultField) {
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
  }

  let value: unknown = parsed;
  for (const segment of runtime.resultField.split('.')) {
    if (typeof value !== 'object' || value === null || !(segment in value)) {
      throw new Error(`Agent JSON output is missing result field: ${runtime.resultField}`);
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export async function runAgentProcess(
  invocation: AgentProcessInvocation,
): Promise<AgentProcessResult> {
  const { runtime, prompt, projectPath, context } = invocation;
  const outputLimit = invocation.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT;
  const values = {
    prompt,
    projectPath,
    taskId: context.taskId,
    runId: context.runId,
  };
  const args = runtime.argsTemplate.map((argument) => renderArgument(argument, values));
  for (const key of RUNTIME_OPTION_KEYS) {
    const value = invocation.options?.[key];
    const template = runtime.optionTemplates?.[key];
    if (!value || !template) continue;
    if (template.some((argument) => argument.includes('{value}'))) {
      args.push(...template.map((argument) => argument.replaceAll('{value}', value)));
    } else {
      // Valueless flag template (e.g. Kimi's `--thinking`): any truthy
      // selection appends the flag as-is.
      args.push(...template);
    }
  }
  const startedAt = Date.now();

  return await new Promise<AgentProcessResult>((resolve, reject) => {
    const child = spawn(runtime.command, args, {
      cwd: projectPath,
      env: { ...process.env, ...resolveRuntimeEnv(runtime.env) },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;

    const finishWithError = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      invocation.signal?.removeEventListener('abort', abort);
      reject(error);
    };

    const appendOutput = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > outputLimit) {
        child.kill();
        finishWithError(new Error(`Agent output exceeded ${outputLimit} bytes`));
        return;
      }
      if (target === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };

    child.stdout.on('data', (chunk: Buffer) => appendOutput('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => appendOutput('stderr', chunk));
    child.on('error', finishWithError);

    const abort = () => {
      child.kill();
      finishWithError(new Error(`Agent run aborted: ${runtime.name}`));
    };
    invocation.signal?.addEventListener('abort', abort, { once: true });

    const timeout = setTimeout(() => {
      child.kill();
      finishWithError(new Error(`Agent timed out after ${runtime.timeoutMs}ms: ${runtime.name}`));
    }, runtime.timeoutMs);

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      invocation.signal?.removeEventListener('abort', abort);
      const code = exitCode ?? 1;
      if (code !== 0) {
        reject(new Error(`${runtime.name} exited with code ${code}: ${stderr.trim()}`));
        return;
      }
      resolve({
        content: normalizeOutput(runtime, stdout),
        stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - startedAt,
      });
    });

    if (runtime.promptTransport === 'stdin') {
      child.stdin.end(prompt);
    } else {
      child.stdin.end();
    }
  });
}
