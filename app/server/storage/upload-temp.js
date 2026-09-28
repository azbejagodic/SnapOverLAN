import path from 'node:path';
import { promises as fs } from 'node:fs';
import { UPLOAD_TEMP_DIR } from '../config.js';

// Startup only: storage initialization finishes before the server listens.
const cleanUploadTempDirectory = async () => {
  const configuredRoot = path.resolve(UPLOAD_TEMP_DIR);
  await fs.mkdir(configuredRoot, { recursive: true });
  const root = await fs.realpath(configuredRoot);
  const parent = await fs.realpath(path.dirname(configuredRoot));
  const stats = await fs.lstat(configuredRoot);
  // Allow a canonicalized data parent, but never a redirected upload-tmp root
  // (including Windows junctions) that could point at saved data.
  if (!stats.isDirectory() || stats.isSymbolicLink()
    || root !== path.join(parent, 'upload-tmp')) {
    throw new Error(`Unsafe upload staging directory: ${configuredRoot}`);
  }

  // Root access failures must propagate; only individual child failures are safe
  // to contain. readdir supplies direct names, checked again before deletion.
  const entries = await fs.readdir(root);
  for (const name of entries) {
    try {
      const child = path.resolve(root, name);
      if (!name || name === '.' || name === '..' || name.includes('/')
        || name.includes('\\') || name.includes(':') || path.dirname(child) !== root) {
        throw new Error('Invalid upload staging child path');
      }
      // rm removes symlinks/junctions themselves, including nested links; it
      // does not traverse their targets. Never pass a child's realpath to rm.
      await fs.rm(child, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Could not remove stale upload staging entry ${JSON.stringify(name)} in ${root}:`, error);
    }
  }
  await fs.mkdir(root, { recursive: true });
};

export { cleanUploadTempDirectory };
