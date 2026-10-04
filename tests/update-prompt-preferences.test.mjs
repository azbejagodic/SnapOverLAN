import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeDesktopSettings, updateDesktopSetting } from '../app/desktop-settings.js';
import { createSettingsStore } from '../app/desktop/settings-store.js';

test('skipped version persists through settings reloads and unrelated preference changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'snap-update-preference-'));
  const settingsPath = path.join(directory, 'desktop-settings.json');
  const makeStore = () => createSettingsStore({ getSettingsPath: () => settingsPath });
  try {
    await makeStore().save({ skippedUpdateVersion: '2.0.1', promptedVersions: ['2.0.2'] });
    const loaded = await makeStore().load();
    assert.equal(loaded.skippedUpdateVersion, '2.0.1');
    await makeStore().save(updateDesktopSetting(loaded, 'backgroundMode', true));
    assert.equal((await makeStore().load()).skippedUpdateVersion, '2.0.1');
    assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), {
      backgroundMode: true, autoCopyFirstPhoto: false, skippedUpdateVersion: '2.0.1',
    });
    assert.throws(() => updateDesktopSetting(loaded, 'skippedUpdateVersion', true));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('old settings migrate safely and invalid skipped preferences cannot suppress updates', () => {
  for (const value of [undefined, null, true, 201, '', '<script>', '2.0.1\n']) {
    assert.equal(normalizeDesktopSettings({ skippedUpdateVersion: value }).skippedUpdateVersion, '');
  }
  assert.equal(normalizeDesktopSettings({ skippedUpdateVersion: '2.0.10' }).skippedUpdateVersion, '2.0.10');
});
