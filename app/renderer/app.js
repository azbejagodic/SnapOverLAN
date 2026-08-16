import { drawQrCode } from './qr-code.js';
import { fetchJson, serverUrl } from './server-api.js';
import { createBatchHistory } from './batch-history.js';

const refreshBtn = document.getElementById('refreshBtn');
const qrBtn = document.getElementById('qrBtn');
const connectionPill = document.getElementById('connectionPill');
const backgroundToggleBtn = document.getElementById('backgroundToggleBtn');
const autoCopyMessage = document.getElementById('autoCopyMessage');
const retryServerBtn = document.getElementById('retryServerBtn');
const phoneUrlInput = document.getElementById('phoneUrl');
const phoneQr = document.getElementById('phoneQr');
const qrFallback = document.getElementById('qrFallback');
const batchMessage = document.getElementById('batchMessage');
const batchesList = document.getElementById('batchesList');
const downloadCurrentBatchBtn = document.getElementById('downloadCurrentBatchBtn');
const clearBatchesBtn = document.getElementById('clearBatchesBtn');
const diagnosticsSummary = document.getElementById('diagnosticsSummary');
const diagnosticsList = document.getElementById('diagnosticsList');
const diagnosticsWarning = document.getElementById('diagnosticsWarning');
const diagnosticsUrls = document.getElementById('diagnosticsUrls');
const diagnosticsPanel = document.getElementById('diagnosticsPanel');
const qrModal = document.getElementById('qrModal');
const closeQrBtn = document.getElementById('closeQrBtn');

const AUTO_REFRESH_MS = 5000;
const AUTO_COPY_MESSAGE_MS = 4000;

let currentPhoneUrl = '';
let dashboardRefreshInFlight = false;
let autoRefreshTimer = null;
let batchHistory = null;
let lastServerStatusData = null;
let desktopServerState = 'offline';
let serverRetryOperation = null;
let backgroundModeEnabled = false;
let autoCopyMessageTimer = null;
const launchParams = new URLSearchParams(window.location.search);

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLocalHostname(hostname) {
  return ['localhost', '127.0.0.1', '::1'].includes(hostname);
}

function isUsablePhoneUrl(value) {
  const parsed = parseUrl(value);
  return Boolean(parsed && !isLocalHostname(parsed.hostname));
}

function choosePhoneUrl(data) {
  const urls = Array.isArray(data?.urls) ? data.urls : [];
  const privateUrl = urls.find((item) => item.private && isUsablePhoneUrl(item.url));
  const nonLocalUrl = urls.find((item) => isUsablePhoneUrl(item.url));
  const primaryUrl = isUsablePhoneUrl(data?.primaryUrl) ? { url: data.primaryUrl } : null;
  return privateUrl || nonLocalUrl || primaryUrl || null;
}

function setBadge(element, baseClass, state, label) {
  if (!element) return;
  element.className = `${baseClass} ${state}`;
  const target = element.querySelector('span:last-child') || element;
  target.textContent = label;
}

function renderStatus({ state } = {}) {
  const statusState = state || (
    lastServerStatusData?.status === 'listening' ? 'online' : 'checking'
  );
  const label = statusState === 'online'
    ? 'Server online'
    : statusState === 'offline'
      ? 'Server offline'
      : 'Checking server';
  setBadge(connectionPill, 'server-line', statusState, label);
}

function renderDesktopControls() {
  if (backgroundToggleBtn) {
    backgroundToggleBtn.textContent = `Background: ${backgroundModeEnabled ? 'On' : 'Off'}`;
    backgroundToggleBtn.disabled = desktopServerState !== 'online';
    backgroundToggleBtn.setAttribute('aria-pressed', String(backgroundModeEnabled));
    backgroundToggleBtn.setAttribute(
      'aria-label',
      backgroundModeEnabled ? 'Turn background mode off' : 'Turn background mode on',
    );
  }
  if (retryServerBtn) {
    retryServerBtn.hidden = desktopServerState !== 'error';
    retryServerBtn.disabled = Boolean(serverRetryOperation);
  }
}

function setDesktopServerState(state) {
  desktopServerState = state || 'offline';
  if (desktopServerState !== 'online') {
    backgroundModeEnabled = false;
  }
  renderDesktopControls();
}

async function syncDesktopControls() {
  if (!window.snapOverLAN) return;
  try {
    const [server, background] = await Promise.all([
      window.snapOverLAN.getServerState(),
      window.snapOverLAN.getBackgroundMode(),
    ]);
    backgroundModeEnabled = server?.state === 'online' && Boolean(background);
    setDesktopServerState(server?.state);
    if (server?.state === 'error' && server.error) {
      renderStatus({ state: 'offline' });
    }
  } catch (error) {
    console.error('Could not read Electron server controls:', error);
  }
}

function showAutoCopyResult({ success, filename, message, reason } = {}) {
  if (!autoCopyMessage) return;
  const resultMessage = typeof message === 'string' && message
    ? message
    : typeof filename === 'string' && filename
      ? success
        ? `Copied ${filename} to clipboard`
        : `Could not automatically copy ${filename}${reason ? `: ${reason}` : ''}`
      : '';
  if (!resultMessage) return;

  if (autoCopyMessageTimer !== null) window.clearTimeout(autoCopyMessageTimer);
  autoCopyMessage.textContent = resultMessage;
  autoCopyMessage.classList.toggle('error', !success);
  autoCopyMessage.hidden = false;
  autoCopyMessageTimer = window.setTimeout(() => {
    autoCopyMessage.textContent = '';
    autoCopyMessage.hidden = true;
    autoCopyMessage.classList.remove('error');
    autoCopyMessageTimer = null;
  }, AUTO_COPY_MESSAGE_MS);
}

function setBatchMessage(message) {
  if (!batchMessage) return;
  batchMessage.textContent = message;
  batchMessage.hidden = false;
}

function clearBatchMessage() {
  if (!batchMessage) return;
  batchMessage.textContent = '';
  batchMessage.hidden = true;
}

function renderUrlList(container, titleText, urls) {
  if (!container) return;
  if (!Array.isArray(urls) || urls.length === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = '';
  const title = document.createElement('h3');
  title.textContent = titleText;
  const list = document.createElement('ul');
  for (const item of urls) {
    const listItem = document.createElement('li');
    const link = document.createElement('a');
    link.href = item.url;
    link.textContent = item.private ? `${item.url} (private LAN)` : item.url;
    link.target = '_blank';
    link.rel = 'noopener';
    listItem.appendChild(link);
    list.appendChild(listItem);
  }
  container.append(title, list);
}

function addDiagnosticRow(label, value) {
  const term = document.createElement('dt');
  term.textContent = label;
  const description = document.createElement('dd');
  description.textContent = value || 'Not available';
  diagnosticsList.append(term, description);
}

function getLauncherStatus() {
  const serverMode = launchParams.get('server');
  if (serverMode === 'started') return 'Electron started the local server';
  if (serverMode === 'reused') return 'Electron reused an existing server';
  return 'Unknown launcher';
}

function renderDiagnostics(data) {
  if (!diagnosticsList) return;
  diagnosticsList.innerHTML = '';
  const isListening = data.status === 'listening';
  if (diagnosticsSummary) {
    diagnosticsSummary.className = `summary status-badge ${isListening ? 'online' : 'offline'}`;
    diagnosticsSummary.textContent = isListening ? 'Server online' : 'Status unknown';
  }
  addDiagnosticRow('Server status', data.status || 'unknown');
  addDiagnosticRow('Launcher', getLauncherStatus());
  addDiagnosticRow('Server source', data.launchSource || 'unknown');
  addDiagnosticRow('Bind host', data.bindHost || data.configuredHost || 'unknown');
  addDiagnosticRow('Port', String(data.port || 'unknown'));
  addDiagnosticRow('Primary phone URL', currentPhoneUrl || data.primaryLanUrl || 'No LAN URL detected');
  addDiagnosticRow('Runtime data', data.runtimeDataDir || 'unknown');
  addDiagnosticRow('Upload staging', data.uploadTempDir || 'unknown');
  renderUrlList(diagnosticsUrls, 'Detected LAN URLs', data.lanUrls || []);

  const privateLanUrls = Array.isArray(data.lanUrls)
    ? data.lanUrls.filter((item) => item.private)
    : [];
  if (diagnosticsWarning) {
    diagnosticsWarning.hidden = false;
    diagnosticsWarning.className = privateLanUrls.length ? 'diagnostics-note' : 'diagnostics-note warning';
    diagnosticsWarning.textContent = privateLanUrls.length
      ? 'Phone checklist: use the LAN URL above, keep phone and PC on the same Wi-Fi, set the PC network to Private, and allow SnapOverLAN through Windows Firewall on Private networks if Windows asks.'
      : 'No private LAN IPv4 address was detected. Make sure the PC is connected to the same Wi-Fi as the phone, the network profile is Private, and Windows Firewall allows SnapOverLAN on Private networks.';
  }
  if (!privateLanUrls.length && diagnosticsPanel) diagnosticsPanel.open = true;
}

function renderDiagnosticsError(error) {
  if (!diagnosticsList) return;
  diagnosticsList.innerHTML = '';
  if (diagnosticsSummary) {
    diagnosticsSummary.className = 'summary status-badge offline';
    diagnosticsSummary.textContent = 'Server offline';
  }
  if (diagnosticsWarning) {
    diagnosticsWarning.hidden = false;
    diagnosticsWarning.className = 'diagnostics-note warning';
    diagnosticsWarning.textContent = error.message || 'Check that the local server is running and reload the app.';
  }
  if (diagnosticsPanel) diagnosticsPanel.open = true;
}

function renderQrCode(phoneUrl) {
  if (!phoneUrl) {
    phoneQr.hidden = true;
    qrFallback.textContent = '';
    qrFallback.className = 'status-text';
    return;
  }
  try {
    drawQrCode(phoneQr, phoneUrl);
    qrFallback.textContent = '';
    qrFallback.className = 'status-text';
    phoneQr.hidden = false;
  } catch {
    phoneQr.hidden = true;
    qrFallback.textContent = '';
    qrFallback.className = 'status-text';
  }
}

function renderPhoneSetup(data) {
  currentPhoneUrl = choosePhoneUrl(data)?.url || '';
  phoneUrlInput.textContent = currentPhoneUrl;
  phoneUrlInput.title = currentPhoneUrl;
  renderQrCode(currentPhoneUrl);
  renderStatus();
}

function openQrModal() {
  renderQrCode(currentPhoneUrl);
  qrModal.hidden = false;
  closeQrBtn?.focus();
}

function closeQrModal() {
  qrModal.hidden = true;
  qrBtn?.focus();
}

async function loadPhoneSetup() {
  try {
    const response = await fetch(serverUrl('/api/phone-url'));
    if (!response.ok) throw new Error(`Phone URL request failed (${response.status})`);
    const data = await response.json();
    renderPhoneSetup(data);
    return data;
  } catch (error) {
    currentPhoneUrl = '';
    phoneUrlInput.textContent = '';
    phoneUrlInput.title = '';
    renderQrCode('');
    renderStatus({ state: 'offline' });
    return null;
  }
}

async function loadServerStatus({ showActivity = false } = {}) {
  if (showActivity) renderStatus({ state: 'checking' });
  try {
    const response = await fetch(serverUrl('/api/server-status'));
    if (!response.ok) throw new Error(`Server status request failed (${response.status})`);
    const status = await response.json();
    const currentSnapOverLAN = status.status === 'listening'
      && status.application === 'SnapOverLAN'
      && status.protocolVersion === 1;
    const legacySnapOverLAN = status.status === 'listening'
      && status.application === undefined
      && status.protocolVersion === undefined
      && Number.isInteger(status.pid)
      && typeof status.runtimeDataDir === 'string'
      && typeof status.latestDir === 'string'
      && typeof status.uploadTempDir === 'string';
    if (!currentSnapOverLAN && !legacySnapOverLAN) {
      throw new Error('Port 8787 is responding, but it is not a verified SnapOverLAN server.');
    }
    lastServerStatusData = status;
    if (desktopServerState !== 'starting' && desktopServerState !== 'stopping') {
      setDesktopServerState('online');
    }
    renderStatus({ state: 'online' });
    renderDiagnostics(status);
    return status;
  } catch (error) {
    lastServerStatusData = null;
    if (desktopServerState !== 'starting'
      && desktopServerState !== 'stopping'
      && desktopServerState !== 'error') {
      setDesktopServerState('offline');
    }
    renderStatus({ state: 'offline' });
    renderDiagnosticsError(error);
    return null;
  }
}

function setDashboardRefreshBusy(isBusy) {
  refreshBtn.disabled = isBusy;
  refreshBtn.textContent = isBusy ? 'Refreshing...' : 'Refresh';
}

async function refreshDashboard({ source = 'manual' } = {}) {
  if (dashboardRefreshInFlight) return;
  const showActivity = source === 'manual' || source === 'initial';
  dashboardRefreshInFlight = true;
  if (showActivity) setDashboardRefreshBusy(true);
  try {
    await Promise.all([
      loadServerStatus({ showActivity }),
      loadPhoneSetup(),
      batchHistory.load(),
    ]);
  } finally {
    dashboardRefreshInFlight = false;
    if (showActivity) setDashboardRefreshBusy(false);
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer !== null || document.hidden) return;
  autoRefreshTimer = window.setInterval(
    () => refreshDashboard({ source: 'auto' }),
    AUTO_REFRESH_MS,
  );
}

function stopAutoRefresh() {
  if (autoRefreshTimer === null) return;
  window.clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}

renderStatus({ state: 'checking' });
renderQrCode('');

batchHistory = createBatchHistory({
  batchesList,
  clearButton: clearBatchesBtn,
  clearMessage: clearBatchMessage,
  downloadButton: downloadCurrentBatchBtn,
  fetchJson,
  formatBytes,
  setMessage: setBatchMessage,
});
batchHistory.bind();

refreshBtn.addEventListener('click', () => refreshDashboard({ source: 'manual' }));

retryServerBtn?.addEventListener('click', async () => {
  if (!window.snapOverLAN || serverRetryOperation) return;
  setDesktopServerState('starting');
  renderStatus({ state: 'checking' });
  serverRetryOperation = window.snapOverLAN.retryServer();
  try {
    const server = await serverRetryOperation;
    setDesktopServerState(server?.state);
    if (server?.state === 'error') {
      renderStatus({ state: 'offline', message: server.error });
    }
  } catch (error) {
    const server = await window.snapOverLAN.getServerState().catch(() => ({ state: 'error' }));
    setDesktopServerState(server?.state || 'error');
    renderStatus({ state: 'offline', message: server?.error || error.message });
  } finally {
    serverRetryOperation = null;
    renderDesktopControls();
    await refreshDashboard({ source: 'manual' });
  }
});

backgroundToggleBtn?.addEventListener('click', async () => {
  if (!window.snapOverLAN) return;
  backgroundToggleBtn.disabled = true;
  try {
    backgroundModeEnabled = await window.snapOverLAN.setBackgroundMode(!backgroundModeEnabled);
  } catch (error) {
    console.error('Could not change background mode:', error);
  } finally {
    renderDesktopControls();
  }
});

qrBtn.addEventListener('click', openQrModal);
closeQrBtn.addEventListener('click', closeQrModal);
qrModal.addEventListener('click', (event) => {
  if (event.target === qrModal) closeQrModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !qrModal.hidden) closeQrModal();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAutoRefresh();
    return;
  }
  refreshDashboard({ source: 'auto' });
  startAutoRefresh();
});
window.addEventListener('pagehide', stopAutoRefresh);

refreshDashboard({ source: 'initial' });
syncDesktopControls();
window.snapOverLAN?.onDesktopStateChanged?.(({ server, backgroundMode }) => {
  backgroundModeEnabled = server?.state === 'online' && Boolean(backgroundMode);
  setDesktopServerState(server?.state);
  if (server?.state === 'starting') renderStatus({ state: 'checking' });
  else if (server?.state === 'error') renderStatus({ state: 'offline', message: server.error });
  else if (server?.state === 'online') renderStatus({ state: 'online' });
});
window.snapOverLAN?.onAutoCopyResult?.(showAutoCopyResult);
startAutoRefresh();
