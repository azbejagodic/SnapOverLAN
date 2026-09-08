import { access, mkdir, readdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Read the existing Builder cache directly: never call its downloading helpers.
async function findCompiler() {
  const cache = process.env.ELECTRON_BUILDER_CACHE
    || path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache');
  const bundle = path.join(cache, 'nsis-3.0.4.1');
  const candidates = [bundle];
  for (const entry of await readdir(bundle, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) candidates.push(path.join(bundle, entry.name));
  }
  for (const dir of candidates) {
    try {
      await access(path.join(dir, 'Bin', 'makensis.exe'));
      await access(path.join(dir, 'Plugins', 'x86-unicode', 'Banner.dll'));
      return dir;
    } catch { /* Try the next already-extracted cache directory. */ }
  }
  throw new Error(`Cached NSIS 3.0.4.1 compiler/Banner plugin missing in ${bundle}. Preview is offline; nothing was downloaded.`);
}

function run(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: 'inherit', ...options });
    const stop = () => child.kill();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const cleanup = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => {
      cleanup();
      if (code === 0 || signal) resolve();
      else reject(new Error(`${path.basename(executable)} exited with code ${code}`));
    });
  });
}

try {
  if (process.platform !== 'win32') throw new Error('The native NSIS preview requires Windows.');
  if (process.argv.length > 2) throw new Error('This UI-only preview accepts no installer arguments.');
  const nsis = await findCompiler();
  const outputRoot = path.join(root, '.cache', 'update-ui-preview');
  await mkdir(outputRoot, { recursive: true });
  const outputDir = await mkdtemp(path.join(outputRoot, 'run-'));
  const executable = path.join(outputDir, 'SnapOverLAN-UI-Preview.exe');
  await run(path.join(nsis, 'Bin', 'makensis.exe'), [
    '/WX', '/V2', '/INPUTCHARSET', 'UTF8',
    `/DPREVIEW_OUT=${executable.replaceAll('$', '$$')}`,
    path.join(root, 'build', 'update-ui-preview.nsi'),
  ], { env: { ...process.env, NSISDIR: nsis }, windowsHide: true });
  console.log('UI-only preview: click the window and press Escape to close. Ctrl+C here also exits.');
  console.log(`Preview executable: ${executable}`);
  await run(executable, []);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
