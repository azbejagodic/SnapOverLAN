const fetchJson = async (resourcePath, options = {}) => {
  if (typeof window.snapOverLAN?.serverRequest !== 'function') {
    throw new Error('Desktop preload bridge is unavailable: snapOverLAN.serverRequest must be a function.');
  }
  return window.snapOverLAN.serverRequest(resourcePath, options.method || 'GET');
};

export { fetchJson };
