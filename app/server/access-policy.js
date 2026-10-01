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

// IDs differ between unpacked installations and the store; grant only the
// popup's required methods and paths rather than general local-client access.
const isExtensionOrigin = (origin) => /^chrome-extension:\/\/[a-p]{32}$/.test(origin || '');
const isLoopbackHost = (hostname) => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

const isAllowedExtensionRequest = (req) => {
  const method = req.method === 'OPTIONS' ? req.get('access-control-request-method') : req.method;
  const requestPath = String(req.path || '');
  if (requestPath === '/api/auto-copy') return method === 'GET' || method === 'PUT';
  return method === 'GET' && (requestPath === '/api/latest' || /^\/files\/[^/]+$/.test(requestPath));
};

const isExtensionBrowserRequest = (req) => {
  const origin = req.get('origin');
  if (origin) return isExtensionOrigin(origin);
  try {
    const source = new URL(req.get('referer'));
    return isExtensionOrigin(`${source.protocol}//${source.host}`);
  } catch { return false; }
};

const isTrustedLocalBrowserRequest = (req) => {
  // Do not trust Host supplied through a proxy or a DNS-rebinding hostname.
  let target;
  try { target = new URL(`http://${req.get('host')}`); } catch { return false; }
  if (!isLoopbackHost(target.hostname) || target.username || target.password) return false;
  const origin = req.get('origin');
  if (origin) return isExtensionOrigin(origin) ? isAllowedExtensionRequest(req) : origin === target.origin;

  // No-Origin native clients remain supported. Browser no-cors subresources
  // and cross-site navigations must not inherit native privileges.
  const referer = req.get('referer');
  if (referer) {
    try {
      const source = new URL(referer);
      if (isExtensionOrigin(`${source.protocol}//${source.host}`)) return isAllowedExtensionRequest(req);
      if (source.origin !== target.origin) return false;
    } catch { return false; }
  }
  const site = req.get('sec-fetch-site');
  if (site && site !== 'none' && site !== 'same-origin') return false;
  return true;
};

const createLanAccessPolicy = ({ isLoopbackRequest }) => (req, res, next) => {
  if (!isExtensionBrowserRequest(req)
    && (isRemotePwaRequest(req) || (isRemoteUploadRequest(req) && !isLoopbackRequest(req)))) {
    next();
    return;
  }
  if (!isLoopbackRequest(req)) { res.sendStatus(404); return; }
  if (!isTrustedLocalBrowserRequest(req)) { res.sendStatus(403); return; }
  next();
};

export { createLanAccessPolicy, isExtensionOrigin, isAllowedExtensionRequest };
