const SERVER_ORIGIN = 'http://localhost:8787';
const DEFAULT_TIMEOUT_MS = 10000;

const serverUrl = (resourcePath) => new URL(resourcePath, SERVER_ORIGIN).toString();

const fetchJson = async (resourcePath, options = {}) => {
  const response = await fetch(serverUrl(resourcePath), options);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {
      // Keep the status-based message when the response is not JSON.
    }
    throw new Error(message);
  }
  return response.json();
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = options.signal;

  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Could not load photos. Try Refresh again.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
};

export { fetchJson, fetchWithTimeout, serverUrl };
