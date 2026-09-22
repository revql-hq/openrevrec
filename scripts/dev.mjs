import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { root, requirePython } from './runtime.mjs';

const desktop = process.argv[2] === 'desktop';
const children = new Set();
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}

function launch(command, args, extra = {}) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...extra });
  children.add(child);
  child.on('error', (error) => { console.error(error.message); children.delete(child); stop(1); });
  child.on('exit', (code) => { children.delete(child); if (!stopping) stop(code ?? 1); });
  return child;
}

async function waitFor(url, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline && !stopping) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; } catch { /* Server is starting. */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error(`Could not start ${url}. Check whether ports 5173 or 4318 are already in use.`);
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

try {
  requirePython();
  launch(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--config', 'frontend/vite.config.ts']);
  if (desktop) {
    await waitFor('http://127.0.0.1:5173');
    const electron = (await import('electron')).default;
    const env = { ...process.env, ORR_DEV_URL: 'http://127.0.0.1:5173' };
    delete env.ELECTRON_RUN_AS_NODE;
    launch(electron, ['.'], { env });
  } else {
    launch(requirePython(), ['-m', 'openrevrec', 'serve', '--workspace', resolve(process.env.ORR_WORKSPACE || join(root, '.local/Development.orr')), '--port', '4318']);
    await waitFor('http://127.0.0.1:4318/api/health');
    console.log('\nOpenRevRec is ready at http://127.0.0.1:5173\n');
  }
} catch (error) { console.error(error.message); stop(1); }
