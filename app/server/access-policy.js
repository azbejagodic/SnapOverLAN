const REMOTE_PWA_PATHS = new Set([
  '/',
  '/app.js',
  '/index.html',
  '/manifest.json',
  '/styles.css',
]);

const isRemotePwaRequest = (req) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const requestPath = String(req.path || '').toLowerCase();
  return REMOTE_PWA_PATHS.has(requestPath)
    || requestPath.startsWith('/fonts/')
    || requestPath.startsWith('/icons/');
};

const isRemoteUploadRequest = (req) => (
  req.method === 'POST' && String(req.path || '').toLowerCase() === '/api/upload'
);

// Installed Chromium extensions are local clients; their IDs differ between
// unpacked installations and the store. Ordinary websites cannot send this Origin.
const isExtensionOrigin = (origin) => /^chrome-extension:\/\/[a-p]{32}$/.test(origin || '');
const isLoopbackHost = (hostname) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

const isTrustedLocalBrowserRequest = (req) => {
  // Do not trust Host supplied through a proxy or a DNS-rebinding hostname.
  let target;
  try { target = new URL(`http://${req.get('host')}`); } catch { return false; }
  if (!isLoopbackHost(target.hostname) || target.username || target.password) return false;
  const origin = req.get('origin');
  if (origin) return isExtensionOrigin(origin) || origin === target.origin;

  // No-Origin native clients remain supported. Browser no-cors subresources
  // and cross-site navigations must not inherit native privileges.
  const referer = req.get('referer');
  if (referer) {
    try {
      const source = new URL(referer);
      if (isExtensionOrigin(`${source.protocol}//${source.host}`)) return true;
      if (source.origin !== target.origin) return false;
    } catch { return false; }
  }
  const site = req.get('sec-fetch-site');
  if (site && site !== 'none' && site !== 'same-origin') return false;
  return true;
};

const createLanAccessPolicy = ({ isLoopbackRequest }) => (req, res, next) => {
  if (isRemotePwaRequest(req) || isRemoteUploadRequest(req)) {
    next();
    return;
  }
  if (!isLoopbackRequest(req)) { res.sendStatus(404); return; }
  if (!isTrustedLocalBrowserRequest(req)) { res.sendStatus(403); return; }
  next();
};

export { createLanAccessPolicy, isExtensionOrigin, isRemotePwaRequest, isRemoteUploadRequest };
