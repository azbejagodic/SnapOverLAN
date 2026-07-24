import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const smokeEntry = path.join(projectRoot, 'tests', 'electron-auto-copy-smoke.mjs');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, [smokeEntry], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
  windowsHide: true,
});

child.once('error', (error) => {
  console.error('[electron-smoke] Could not launch Electron:', error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`[electron-smoke] Electron exited from signal ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
