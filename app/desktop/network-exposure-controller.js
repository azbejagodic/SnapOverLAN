const LAN_HOST = '0.0.0.0';
const LOOPBACK_HOST = '127.0.0.1';
const NETWORK_PROFILE_POLL_INTERVAL_MS = 5000;

const createNetworkExposureController = ({
  getLanAddresses,
  getNetworkProfile,
  manager,
  onStateChanged = () => {},
  platform = process.platform,
  pollIntervalMs = NETWORK_PROFILE_POLL_INTERVAL_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) => {
  let disposed = false;
  let paused = false;
  let transitioning = false;
  let pollTimer = null;
  let refreshRequested = false;
  let refreshOperation = null;
  let appliedHost = null;
  let networkProfile = null;
  let lanAccess = 'available';

  const getState = () => ({ lanAccess, networkProfile });

  const publishState = (nextAccess, nextProfile) => {
    if (lanAccess === nextAccess && networkProfile === nextProfile) return;
    lanAccess = nextAccess;
    networkProfile = nextProfile;
    onStateChanged(getState());
  };

  const detectProfile = async () => {
    if (platform !== 'win32') return { lanAllowed: true, profile: null };
    let addresses;
    try {
      addresses = getLanAddresses()
        .map((record) => typeof record === 'string' ? record : record?.address)
        .filter(Boolean);
    } catch {
      return { lanAllowed: false, profile: null };
    }
    if (addresses.length === 0) return { lanAllowed: false, profile: null };
    const profiles = await Promise.all(addresses.map(async (address) => {
      try { return await getNetworkProfile(address); }
      catch { return null; }
    }));
    if (profiles.includes('Public')) return { lanAllowed: false, profile: 'Public' };
    const trustedProfiles = new Set(['Private', 'DomainAuthenticated']);
    if (!profiles.every((profile) => trustedProfiles.has(profile))) {
      return { lanAllowed: false, profile: null };
    }
    return {
      lanAllowed: true,
      profile: profiles.includes('DomainAuthenticated') ? 'DomainAuthenticated' : 'Private',
    };
  };

  const reconcile = async ({ lanAllowed, profile }) => {
    const blocked = !lanAllowed;
    const targetHost = blocked ? LOOPBACK_HOST : LAN_HOST;
    if (blocked) {
      publishState(profile === 'Public' ? 'blocked-public' : 'blocked-profile-unknown', profile);
    }

    if (appliedHost !== targetHost || !manager.isRunning()) {
      transitioning = true;
      try {
        if (manager.isRunning()) await manager.stop();
        if (disposed || paused) return;
        await manager.start({ host: targetHost, lanExposure: !blocked });
        appliedHost = targetHost;
      } finally {
        transitioning = false;
      }
    }

    if (!disposed && !blocked) publishState('available', profile);
  };

  const refresh = () => {
    if (disposed || paused) return Promise.resolve(getState());
    refreshRequested = true;
    if (refreshOperation) return refreshOperation;
    const operation = (async () => {
      while (refreshRequested && !disposed && !paused) {
        refreshRequested = false;
        const profile = await detectProfile();
        if (!disposed && !paused) await reconcile(profile);
      }
      return getState();
    })().finally(() => {
      if (refreshOperation === operation) refreshOperation = null;
    });
    refreshOperation = operation;
    return operation;
  };

  const start = async () => {
    paused = false;
    const state = await refresh();
    if (!disposed && !pollTimer) {
      pollTimer = setIntervalImpl(() => {
        refresh().catch((error) => {
          console.warn('Could not refresh Windows network exposure:', error);
        });
      }, pollIntervalMs);
      pollTimer?.unref?.();
    }
    return state;
  };

  const pause = async () => {
    paused = true;
    refreshRequested = false;
    if (pollTimer) clearIntervalImpl(pollTimer);
    pollTimer = null;
    await refreshOperation?.catch(() => {});
  };

  const dispose = async () => {
    disposed = true;
    refreshRequested = false;
    if (pollTimer) clearIntervalImpl(pollTimer);
    pollTimer = null;
    await refreshOperation?.catch(() => {});
  };

  return {
    dispose,
    getState,
    isTransitioning: () => transitioning,
    pause,
    refresh,
    start,
  };
};

export {
  createNetworkExposureController,
  LAN_HOST,
  LOOPBACK_HOST,
  NETWORK_PROFILE_POLL_INTERVAL_MS,
};
