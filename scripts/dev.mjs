// Development launcher: runs the API (tsx watch) and the web dashboard (Vite)
// together, forwarding any CLI arguments (e.g. --port, --host) to Vite.
// Kills the whole process tree when one side exits or a signal arrives.
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteBin = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
const tsxBin = resolve(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const viteArgs = process.argv.slice(2);

const children = [];
let shuttingDown = false;

function killTree(child) {
  if (child.killed || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killTree(child);
  setTimeout(() => process.exit(code), 300).unref();
}

function run(name, args) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const prefix = (text) =>
    text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => `[${name}] ${line}`)
      .join('\n') + '\n';
  child.stdout.on('data', (chunk) => process.stdout.write(prefix(chunk.toString())));
  child.stderr.on('data', (chunk) => process.stderr.write(prefix(chunk.toString())));
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`[${name}] exited with code ${code ?? 'null'}, stopping the other process`);
      shutdown(code ?? 1);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('api', [tsxBin, 'watch', 'src/server/index.ts']);
run('web', [viteBin, ...viteArgs]);
