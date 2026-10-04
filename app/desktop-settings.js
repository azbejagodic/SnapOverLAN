const DEFAULT_DESKTOP_SETTINGS = Object.freeze({
  backgroundMode: false,
  autoCopyFirstPhoto: false,
  skippedUpdateVersion: '',
});

const normalizeDesktopSettings = (value) => ({
  backgroundMode: value?.backgroundMode === true,
  autoCopyFirstPhoto: value?.autoCopyFirstPhoto === true,
  skippedUpdateVersion: typeof value?.skippedUpdateVersion === 'string'
    && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value.skippedUpdateVersion)
    ? value.skippedUpdateVersion : '',
});

const updateDesktopSetting = (settings, key, enabled) => {
  if (!['backgroundMode', 'autoCopyFirstPhoto'].includes(key)) {
    throw new Error(`Unknown desktop setting: ${key}`);
  }

  return {
    ...normalizeDesktopSettings(settings),
    [key]: Boolean(enabled),
  };
};

export {
  DEFAULT_DESKTOP_SETTINGS,
  normalizeDesktopSettings,
  updateDesktopSetting,
};
