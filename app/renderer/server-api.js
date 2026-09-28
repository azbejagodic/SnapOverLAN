const SERVER_ORIGIN = 'http://localhost:8787';

const serverUrl = (resourcePath) => new URL(resourcePath, SERVER_ORIGIN).toString();

const fetchJson = async (resourcePath, options = {}) => {
  if (window.snapOverLAN?.serverRequest) {
    return window.snapOverLAN.serverRequest(resourcePath, options.method || 'GET');
  }
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

export { fetchJson, serverUrl };
