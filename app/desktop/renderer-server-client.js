// The file:// renderer uses native IPC instead of trusting the opaque "null"
// browser Origin, which can also belong to a hostile sandboxed web page.
const createRendererServerClient = ({ serverOrigin, fetchImpl = fetch }) => async (resourcePath, method = 'GET') => {
  const allowed = (
    method === 'GET' && ['/api/phone-url', '/api/server-status', '/api/batches'].includes(resourcePath)
  ) || (
    method === 'POST' && /^\/api\/batches\/batch_[a-zA-Z0-9_-]+\/select$/.test(resourcePath)
  ) || (
    method === 'DELETE' && /^\/api\/batches(?:\/batch_[a-zA-Z0-9_-]+)?$/.test(resourcePath)
  );
  if (typeof resourcePath !== 'string' || !allowed) throw new Error('Server request was rejected.');
  const response = await fetchImpl(new URL(resourcePath, serverOrigin), {
    method, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
  return data;
};

export { createRendererServerClient };
