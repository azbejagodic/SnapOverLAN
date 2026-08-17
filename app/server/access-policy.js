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

const createLanAccessPolicy = ({ isLoopbackRequest }) => (req, res, next) => {
  if (isLoopbackRequest(req) || isRemotePwaRequest(req) || isRemoteUploadRequest(req)) {
    next();
    return;
  }
  res.sendStatus(404);
};

export { createLanAccessPolicy, isRemotePwaRequest, isRemoteUploadRequest };
