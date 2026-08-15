import path from 'path';
import { promises as fs } from 'fs';
import { normalizeDesktopSettings } from '../desktop-settings.js';

const createSettingsStore = ({ getSettingsPath }) => ({
  load: async () => {
    try {
      return normalizeDesktopSettings(JSON.parse(await fs.readFile(getSettingsPath(), 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Could not read SnapOverLAN desktop settings:', error);
      }
      return normalizeDesktopSettings({});
    }
  },
  save: async (settings) => {
    const settingsPath = getSettingsPath();
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify(normalizeDesktopSettings(settings), null, 2)}\n`, 'utf8');
  },
});

export { createSettingsStore };
