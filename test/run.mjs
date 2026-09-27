// Test runner:
//  1. builds the server (run via `npm test`, which invokes tsc first)
//  2. spawns the compiled API on an ephemeral port
//  3. registers tsx and executes the jsdom integration suite
//  4. tears the server down afterwards
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const port = Number(process.env.TEST_PORT ?? 3199);
const base = `http://localhost:${port}`;
globalThis.__PACKET_LAB_API_BASE__ = base;

const server = spawn(process.execPath, [join(root, 'dist', 'server', 'index.js')], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', (chunk) => {
  if (process.env.TEST_VERBOSE) process.stdout.write(`[server] ${chunk}`);
});
server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

const waitForHealth = async (deadline = Date.now() + 8000) => {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`test server did not become ready on ${base}`);
};

const shutdown = () => {
  if (!server.killed) server.kill('SIGTERM');
};
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(130); });
process.on('SIGTERM', () => { shutdown(); process.exit(143); });

await waitForHealth();

const { register } = await import('tsx/esm/api');
const unregister = register({});
let exitCode = 0;
try {
  const suite = await import('./integration.tsx');
  await suite.main();
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  unregister();
  shutdown();
}
process.exit(process.exitCode ?? exitCode);
