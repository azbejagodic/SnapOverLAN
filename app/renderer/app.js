const refreshBtn = document.getElementById('refreshBtn');
const qrBtn = document.getElementById('qrBtn');
const connectionPill = document.getElementById('connectionPill');
const backgroundToggleBtn = document.getElementById('backgroundToggleBtn');
const autoCopyMessage = document.getElementById('autoCopyMessage');
const retryServerBtn = document.getElementById('retryServerBtn');
const serverStatusBadge = document.getElementById('serverStatusBadge');
const serverStateLabel = document.getElementById('serverStateLabel');
const serverLanAddress = document.getElementById('serverLanAddress');
const serverPort = document.getElementById('serverPort');
const serverUploadUrl = document.getElementById('serverUploadUrl');
const serverLastChecked = document.getElementById('serverLastChecked');
const serverPhotoCount = document.getElementById('serverPhotoCount');
const serverMessage = document.getElementById('serverMessage');
const phoneUrlInput = document.getElementById('phoneUrl');
const copyPhoneUrlBtn = document.getElementById('copyPhoneUrlBtn');
const setupStatus = document.getElementById('setupStatus');
const alternateUrls = document.getElementById('alternateUrls');
const phoneQr = document.getElementById('phoneQr');
const qrFallback = document.getElementById('qrFallback');
const photoSummary = document.getElementById('photoSummary');
const emptyState = document.getElementById('emptyState');
const emptyStateTitle = document.getElementById('emptyStateTitle');
const emptyStateText = document.getElementById('emptyStateText');
const photoGrid = document.getElementById('photoGrid');
const picturesPanel = document.querySelector('.pictures-panel');
const picturePagination = document.getElementById('picturePagination');
const prevPicturesPage = document.getElementById('prevPicturesPage');
const nextPicturesPage = document.getElementById('nextPicturesPage');
const picturesPageLabel = document.getElementById('picturesPageLabel');
const downloadAllBtn = document.getElementById('downloadAllBtn');
const picturesMessage = document.getElementById('picturesMessage');
const gridViewBtn = document.getElementById('gridViewBtn');
const listViewBtn = document.getElementById('listViewBtn');
const gridCountSelect = document.getElementById('gridCountSelect');
const gridCountControl = document.querySelector('.grid-count-control');
const batchesBtn = document.getElementById('batchesBtn');
const batchesPanel = document.getElementById('batchesPanel');
const closeBatchesBtn = document.getElementById('closeBatchesBtn');
const batchesList = document.getElementById('batchesList');
const retentionSelect = document.getElementById('retentionSelect');
const saveRetentionBtn = document.getElementById('saveRetentionBtn');
const clearBatchesBtn = document.getElementById('clearBatchesBtn');
const diagnosticsSummary = document.getElementById('diagnosticsSummary');
const diagnosticsList = document.getElementById('diagnosticsList');
const diagnosticsWarning = document.getElementById('diagnosticsWarning');
const diagnosticsUrls = document.getElementById('diagnosticsUrls');
const diagnosticsPanel = document.getElementById('diagnosticsPanel');
const qrModal = document.getElementById('qrModal');
const closeQrBtn = document.getElementById('closeQrBtn');

const QR_VERSION = 2;
const QR_SIZE = 17 + QR_VERSION * 4;
const QR_DATA_CODEWORDS = 34;
const QR_ECC_CODEWORDS = 10;
const GF_EXP = [];
const GF_LOG = [];
const AUTO_REFRESH_MS = 5000;
const MEDIA_REFRESH_TIMEOUT_MS = 10000;
const UPLOAD_STATUS_REFRESH_MS = 750;
const UPLOAD_LOADING_TIMEOUT_MS = 60000;
const AUTO_COPY_MESSAGE_MS = 4000;
const LIST_PAGE_SIZE = 10;
const DEFAULT_GRID_LAYOUT = {
  columns: 3,
  rows: 2,
  pageSize: 6,
};
const GRID_GAP = 12;
const GRID_MIN_CARD_WIDTH = 160;
const GRID_MIN_CARD_HEIGHT = 96;
const PICTURES_VIEW_KEY = 'photoGptPicturesView';
const GRID_COUNT_KEY = 'photoGptGridCount';
const GRID_COUNT_OPTIONS = ['auto', '4', '8', '12', '16'];
const DEFAULT_GRID_COUNT = '8';
const FIXED_GRID_LAYOUTS = {
  4: { columns: 2, rows: 2 },
  8: { columns: 4, rows: 2 },
  12: { columns: 4, rows: 3 },
  16: { columns: 4, rows: 4 },
};

let currentPhoneUrl = '';
let dashboardRefreshInFlight = false;
let latestPicturesRefreshPromise = null;
let latestPicturesAbortController = null;
let latestPicturesRequestId = 0;
let autoRefreshTimer = null;
let uploadStatusTimer = null;
let uploadStatusRefreshInFlight = false;
let lastUploadInProgress = false;
let lastUploadVersion = null;
let uploadLoadingStartedAt = 0;
let uploadLoadingTimedOut = false;
let hasLoadedPhotos = false;
let latestFiles = [];
let savedBatches = [];
let batchesRefreshPromise = null;
let savedRetentionValue = null;
let currentPicturesPage = 0;
let gridLayout = { ...DEFAULT_GRID_LAYOUT };
let picturesView = localStorage.getItem(PICTURES_VIEW_KEY) === 'list' ? 'list' : 'grid';
let gridCountSetting = GRID_COUNT_OPTIONS.includes(localStorage.getItem(GRID_COUNT_KEY))
  ? localStorage.getItem(GRID_COUNT_KEY)
  : DEFAULT_GRID_COUNT;
let lastServerStatusData = null;
let statusLastCheckedAt = null;
let desktopServerState = 'offline';
let serverRetryOperation = null;
let backgroundModeEnabled = false;
let autoCopyMessageTimer = null;
const launchParams = new URLSearchParams(window.location.search);
const SERVER_ORIGIN = 'http://localhost:8787';

function serverUrl(resourcePath) {
  return new URL(resourcePath, SERVER_ORIGIN).toString();
}

function initGaloisTables() {
  let value = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = value;
    GF_LOG[value] = i;
    value <<= 1;
    if (value & 0x100) {
      value ^= 0x11d;
    }
  }

  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

function gfMultiply(a, b) {
  if (a === 0 || b === 0) {
    return 0;
  }
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function getUtf8Bytes(text) {
  if (window.TextEncoder) {
    return Array.from(new TextEncoder().encode(text));
  }

  return Array.from(unescape(encodeURIComponent(text))).map((char) => char.charCodeAt(0));
}

function appendBits(target, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) {
    target.push(((value >>> i) & 1) === 1);
  }
}

function createDataCodewords(text) {
  const bytes = getUtf8Bytes(text);
  if (bytes.length > 32) {
    throw new Error('Phone URL is too long for the built-in QR code.');
  }

  const bits = [];
  appendBits(bits, 0x4, 4);
  appendBits(bits, bytes.length, 8);
  bytes.forEach((byte) => appendBits(bits, byte, 8));

  const maxBits = QR_DATA_CODEWORDS * 8;
  const terminatorLength = Math.min(4, maxBits - bits.length);
  appendBits(bits, 0, terminatorLength);

  while (bits.length % 8 !== 0) {
    bits.push(false);
  }

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) {
      value = (value << 1) | (bits[i + j] ? 1 : 0);
    }
    codewords.push(value);
  }

  const pads = [0xec, 0x11];
  for (let i = 0; codewords.length < QR_DATA_CODEWORDS; i += 1) {
    codewords.push(pads[i % 2]);
  }

  return codewords;
}

function reedSolomonRemainder(data, degree) {
  const coefficients = new Array(degree).fill(0);
  coefficients[degree - 1] = 1;

  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      coefficients[j] = gfMultiply(coefficients[j], root);
      if (j + 1 < degree) {
        coefficients[j] ^= coefficients[j + 1];
      }
    }
    root = gfMultiply(root, 0x02);
  }

  const result = new Array(degree).fill(0);
  data.forEach((value) => {
    const factor = value ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) {
      result[i] ^= gfMultiply(coefficients[i], factor);
    }
  });

  return result;
}

function maskCondition(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

function createBaseMatrix() {
  const modules = Array.from({ length: QR_SIZE }, () => new Array(QR_SIZE).fill(false));
  const reserved = Array.from({ length: QR_SIZE }, () => new Array(QR_SIZE).fill(false));

  const setFunction = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= QR_SIZE || y >= QR_SIZE) {
      return;
    }
    modules[y][x] = dark;
    reserved[y][x] = true;
  };

  const drawFinder = (left, top) => {
    for (let y = -1; y <= 7; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        setFunction(left + x, top + y, false);
      }
    }

    for (let y = 0; y < 7; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        const edge = x === 0 || y === 0 || x === 6 || y === 6;
        const center = x >= 2 && x <= 4 && y >= 2 && y <= 4;
        setFunction(left + x, top + y, edge || center);
      }
    }
  };

  const drawAlignment = (centerX, centerY) => {
    for (let y = -2; y <= 2; y += 1) {
      for (let x = -2; x <= 2; x += 1) {
        const distance = Math.max(Math.abs(x), Math.abs(y));
        setFunction(centerX + x, centerY + y, distance === 0 || distance === 2);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(QR_SIZE - 7, 0);
  drawFinder(0, QR_SIZE - 7);
  drawAlignment(18, 18);

  for (let i = 8; i < QR_SIZE - 8; i += 1) {
    const dark = i % 2 === 0;
    setFunction(i, 6, dark);
    setFunction(6, i, dark);
  }

  for (let i = 0; i < 9; i += 1) {
    if (i !== 6) {
      setFunction(8, i, false);
      setFunction(i, 8, false);
    }
  }

  for (let i = 0; i < 8; i += 1) {
    setFunction(QR_SIZE - 1 - i, 8, false);
    setFunction(8, QR_SIZE - 1 - i, false);
  }

  setFunction(8, QR_SIZE - 8, true);
  return { modules, reserved };
}

function drawFormatBits(modules, mask) {
  const data = (1 << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) {
    remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  }

  const bits = ((data << 10) | remainder) ^ 0x5412;
  const getBit = (index) => ((bits >>> index) & 1) === 1;
  const set = (x, y, dark) => {
    modules[y][x] = dark;
  };

  for (let i = 0; i <= 5; i += 1) {
    set(8, i, getBit(i));
  }
  set(8, 7, getBit(6));
  set(8, 8, getBit(7));
  set(7, 8, getBit(8));
  for (let i = 9; i < 15; i += 1) {
    set(14 - i, 8, getBit(i));
  }

  for (let i = 0; i < 8; i += 1) {
    set(QR_SIZE - 1 - i, 8, getBit(i));
  }
  for (let i = 8; i < 15; i += 1) {
    set(8, QR_SIZE - 15 + i, getBit(i));
  }
  set(8, QR_SIZE - 8, true);
}

function drawCodewords(codewords, mask) {
  const { modules, reserved } = createBaseMatrix();
  const bits = [];
  codewords.forEach((codeword) => appendBits(bits, codeword, 8));

  let bitIndex = 0;
  let upward = true;
  for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right -= 1;
    }

    for (let vertical = 0; vertical < QR_SIZE; vertical += 1) {
      const y = upward ? QR_SIZE - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (reserved[y][x]) {
          continue;
        }

        const bit = bitIndex < bits.length ? bits[bitIndex] : false;
        bitIndex += 1;
        modules[y][x] = bit !== maskCondition(mask, x, y);
      }
    }
    upward = !upward;
  }

  drawFormatBits(modules, mask);
  return modules;
}

function getRunPenalty(values) {
  let penalty = 0;
  let runColor = values[0];
  let runLength = 1;

  for (let i = 1; i < values.length; i += 1) {
    if (values[i] === runColor) {
      runLength += 1;
      continue;
    }

    if (runLength >= 5) {
      penalty += 3 + runLength - 5;
    }
    runColor = values[i];
    runLength = 1;
  }

  if (runLength >= 5) {
    penalty += 3 + runLength - 5;
  }

  return penalty;
}

function getPenaltyScore(modules) {
  let penalty = 0;
  for (let y = 0; y < QR_SIZE; y += 1) {
    penalty += getRunPenalty(modules[y]);
  }

  for (let x = 0; x < QR_SIZE; x += 1) {
    const column = [];
    for (let y = 0; y < QR_SIZE; y += 1) {
      column.push(modules[y][x]);
    }
    penalty += getRunPenalty(column);
  }

  for (let y = 0; y < QR_SIZE - 1; y += 1) {
    for (let x = 0; x < QR_SIZE - 1; x += 1) {
      const color = modules[y][x];
      if (modules[y][x + 1] === color && modules[y + 1][x] === color && modules[y + 1][x + 1] === color) {
        penalty += 3;
      }
    }
  }

  return penalty;
}

function createQrMatrix(text) {
  const dataCodewords = createDataCodewords(text);
  const errorCodewords = reedSolomonRemainder(dataCodewords, QR_ECC_CODEWORDS);
  const codewords = dataCodewords.concat(errorCodewords);
  let best = null;

  for (let mask = 0; mask < 8; mask += 1) {
    const modules = drawCodewords(codewords, mask);
    const penalty = getPenaltyScore(modules);
    if (!best || penalty < best.penalty) {
      best = { modules, penalty };
    }
  }

  return best.modules;
}

function drawQrCode(canvas, text) {
  const modules = createQrMatrix(text);
  const quietZone = 4;
  const scale = 8;
  const size = (modules.length + quietZone * 2) * scale;
  const context = canvas.getContext('2d');

  canvas.width = size;
  canvas.height = size;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size, size);
  context.fillStyle = '#111827';

  for (let y = 0; y < modules.length; y += 1) {
    for (let x = 0; x < modules.length; x += 1) {
      if (modules[y][x]) {
        context.fillRect((x + quietZone) * scale, (y + quietZone) * scale, scale, scale);
      }
    }
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return 'Unknown size';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatClockTime(date) {
  if (!(date instanceof Date)) {
    return '—';
  }

  return date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function parseUrl(value) {
  try {
    return new URL(value);
  } catch (_error) {
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

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

async function copyImage(imageUrl) {
  if (!window.snapOverLAN?.copyImageBytes) {
    throw new Error('Image clipboard support is unavailable.');
  }

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Copy failed (${response.status})`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('image/')) {
    throw new Error('Copy failed because the selected file is not an image.');
  }

  await window.snapOverLAN.copyImageBytes(await response.arrayBuffer());
}

function getVideoMimeType(file) {
  const extension = file.name?.split('.').pop()?.trim().toLowerCase();
  if (extension === 'mp4') return 'video/mp4';
  if (extension === 'mov') return 'video/quicktime';
  if (extension === 'webm') return 'video/webm';
  return '';
}

function isVideoFile(file) {
  return Boolean(getVideoMimeType(file));
}

async function downloadImage(file, imageUrl) {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Download failed (${response.status})`);
    }

    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = file.name || 'photo';
    link.click();
    URL.revokeObjectURL(objectUrl);
  } catch (_error) {
    window.open(imageUrl, '_blank', 'noopener');
  }
}

async function downloadAllPictures() {
  if (!latestFiles.length) {
    return;
  }

  picturesMessage.hidden = true;
  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = 'Downloading...';

  try {
    const zipName = await getCurrentBatchZipName();
    const response = await fetch(serverUrl('/api/latest/download'));
    if (!response.ok) {
      throw new Error(`Download failed (${response.status})`);
    }

    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = zipName;
    link.click();
    URL.revokeObjectURL(objectUrl);
  } catch (error) {
    picturesMessage.textContent = error.message || 'Could not download all pictures.';
    picturesMessage.hidden = false;
  } finally {
    downloadAllBtn.disabled = false;
    downloadAllBtn.textContent = 'Download all';
  }
}

function formatBatchZipName(batchTimestamp) {
  const date = batchTimestamp ? new Date(batchTimestamp) : new Date();
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = safeDate.getFullYear();
  const month = String(safeDate.getMonth() + 1).padStart(2, '0');
  const day = String(safeDate.getDate()).padStart(2, '0');
  const hours = String(safeDate.getHours()).padStart(2, '0');
  const minutes = String(safeDate.getMinutes()).padStart(2, '0');
  const seconds = String(safeDate.getSeconds()).padStart(2, '0');

  return `snapoverlan_${year}-${month}-${day}_${hours}-${minutes}-${seconds}_batch.zip`;
}

async function getCurrentBatchZipName() {
  let currentBatch = savedBatches.find((batch) => batch.current);

  if (!currentBatch) {
    try {
      const batchData = await fetchJson('/api/batches');
      const batches = Array.isArray(batchData.batches) ? batchData.batches : [];
      currentBatch = batches.find((batch) => batch.current);
      if (batches.length) {
        savedBatches = batches;
        renderBatches();
      }
    } catch {
      // Fall back to the current local time if batch metadata is unavailable.
    }
  }

  return formatBatchZipName(currentBatch?.createdAt);
}

function setPicturesMessage(message) {
  picturesMessage.textContent = message;
  picturesMessage.hidden = false;
  picturesMessage.classList.add('error');
}

function clearPicturesMessage() {
  picturesMessage.textContent = '';
  picturesMessage.hidden = true;
  picturesMessage.classList.remove('error');
}

function formatBatchDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }

  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function fetchJson(resourcePath, options = {}) {
  const response = await fetch(serverUrl(resourcePath), options);
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json();
      if (data?.error) {
        message = data.error;
      }
    } catch {
      // Keep the status-based message when the response is not JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

function renderBatches() {
  if (!batchesList) {
    return;
  }

  batchesList.textContent = '';

  if (!savedBatches.length) {
    const empty = document.createElement('p');
    empty.className = 'batches-empty';
    empty.textContent = 'No saved batches.';
    batchesList.appendChild(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  savedBatches.forEach((batch) => {
    const item = document.createElement('article');
    item.className = batch.current ? 'batch-item current' : 'batch-item';

    const details = document.createElement('div');
    details.className = 'batch-details';

    const title = document.createElement('strong');
    title.textContent = formatBatchDate(batch.createdAt);

    const meta = document.createElement('span');
    const countLabel = batch.fileCount === 1 ? '1 file' : `${batch.fileCount} files`;
    meta.textContent = `${countLabel} · ${formatBytes(batch.totalSize)}${batch.current ? ' · Current' : ''}`;

    details.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'batch-actions';

    const selectButton = document.createElement('button');
    selectButton.className = 'batch-button';
    selectButton.type = 'button';
    selectButton.textContent = batch.current ? 'Selected' : 'Select';
    selectButton.disabled = batch.current;
    selectButton.addEventListener('click', () => selectBatch(batch.id));

    const deleteButton = document.createElement('button');
    deleteButton.className = 'batch-button danger';
    deleteButton.type = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.addEventListener('click', () => deleteBatch(batch));

    actions.append(selectButton, deleteButton);
    item.append(details, actions);
    fragment.appendChild(item);
  });

  batchesList.appendChild(fragment);
}

function normalizeRetentionValue(value) {
  return value ? String(value) : '';
}

function updateRetentionSaveButton() {
  if (!retentionSelect || !saveRetentionBtn) {
    return;
  }

  saveRetentionBtn.disabled = savedRetentionValue !== null
    && retentionSelect.value === savedRetentionValue;
}

async function loadBatchHistory({ showActivity = false } = {}) {
  if (!batchesPanel || batchesPanel.hidden) {
    return;
  }

  if (batchesRefreshPromise) {
    return batchesRefreshPromise;
  }

  batchesRefreshPromise = (async () => {
    try {
      const [batchData, settings] = await Promise.all([
        fetchJson('/api/batches'),
        fetchJson('/api/storage-settings'),
      ]);

      savedBatches = Array.isArray(batchData.batches) ? batchData.batches : [];
      if (retentionSelect) {
        const loadedRetentionValue = normalizeRetentionValue(settings.retentionDays);
        if (savedRetentionValue === null || retentionSelect.value === savedRetentionValue) {
          retentionSelect.value = loadedRetentionValue;
        }
        savedRetentionValue = loadedRetentionValue;
        updateRetentionSaveButton();
      }
      renderBatches();
    } catch (error) {
      setPicturesMessage(error.message || 'Could not load batches.');
    } finally {
      batchesRefreshPromise = null;
    }
  })();

  return batchesRefreshPromise;
}

async function selectBatch(id) {
  try {
    await fetchJson(`/api/batches/${encodeURIComponent(id)}/select`, { method: 'POST' });
    await loadLatestPictures({ source: 'manual', force: true });
    await loadBatchHistory();
    clearPicturesMessage();
  } catch (error) {
    setPicturesMessage(error.message || 'Could not select batch.');
  }
}

async function deleteBatch(batch) {
  const label = formatBatchDate(batch.createdAt);
  if (!window.confirm(`Delete the batch from ${label}?`)) {
    return;
  }

  try {
    await fetchJson(`/api/batches/${encodeURIComponent(batch.id)}`, { method: 'DELETE' });
    await loadLatestPictures({ source: 'manual', force: true });
    await loadBatchHistory();
    clearPicturesMessage();
  } catch (error) {
    setPicturesMessage(error.message || 'Could not delete batch.');
  }
}

async function clearAllBatches() {
  if (!window.confirm('Clear all saved batches? This cannot be undone.')) {
    return;
  }

  try {
    await fetchJson('/api/batches', { method: 'DELETE' });
    await loadLatestPictures({ source: 'manual', force: true });
    await loadBatchHistory();
    clearPicturesMessage();
  } catch (error) {
    setPicturesMessage(error.message || 'Could not clear batches.');
  }
}

async function saveRetentionSetting() {
  try {
    const value = retentionSelect?.value || '';
    const settings = await fetchJson('/api/storage-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retentionDays: value ? Number(value) : null }),
    });
    savedRetentionValue = normalizeRetentionValue(settings.retentionDays);
    updateRetentionSaveButton();
    await loadBatchHistory();
    clearPicturesMessage();
  } catch (error) {
    setPicturesMessage(error.message || 'Could not save retention setting.');
  }
}

function setBatchHistoryOpen(isOpen) {
  if (!batchesPanel) {
    return;
  }

  batchesPanel.hidden = !isOpen;
  picturesPanel?.classList.toggle('history-open', isOpen);
  applyGridLayout();
  batchesBtn?.classList.toggle('active', isOpen);
  if (isOpen) {
    loadBatchHistory({ showActivity: true });
    closeBatchesBtn?.focus();
  } else {
    batchesBtn?.focus();
  }
  if (picturesView === 'grid') {
    renderPictures(latestFiles);
  }
}

function setBadge(element, baseClass, state, label, labelElement = null) {
  if (!element) {
    return;
  }
  element.className = `${baseClass} ${state}`;
  const target = labelElement || element.querySelector('span:last-child') || element;
  target.textContent = label;
}

function renderConnectionState(state, label) {
  setBadge(connectionPill, 'server-line', state, label);
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
  if (!window.snapOverLAN) {
    return;
  }

  try {
    const [server, background] = await Promise.all([
      window.snapOverLAN.getServerState(),
      window.snapOverLAN.getBackgroundMode(),
    ]);
    backgroundModeEnabled = server?.state === 'online' && Boolean(background);
    setDesktopServerState(server?.state);
    if (server?.state === 'error' && server.error) {
      renderStatus({ state: 'offline', message: server.error });
    }
  } catch (error) {
    console.error('Could not read Electron server controls:', error);
  }
}

function showAutoCopyResult({
  success,
  filename,
  message,
  reason,
} = {}) {
  if (!autoCopyMessage) {
    return;
  }
  const resultMessage = typeof message === 'string' && message
    ? message
    : typeof filename === 'string' && filename
      ? success
        ? `Copied ${filename} to clipboard`
        : `Could not automatically copy ${filename}${reason ? `: ${reason}` : ''}`
      : '';
  if (!resultMessage) {
    return;
  }

  if (autoCopyMessageTimer !== null) {
    window.clearTimeout(autoCopyMessageTimer);
  }
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

function renderStatus({ state, message } = {}) {
  const statusState = state || (
    lastServerStatusData?.status === 'listening' ? 'online' : 'checking'
  );
  const statusLabel = statusState === 'online' ? 'Online' : statusState === 'offline' ? 'Offline' : 'Checking';

  setBadge(serverStatusBadge, 'status-badge', statusState, statusLabel, serverStateLabel);
  const connectionLabel = statusState === 'online'
    ? 'Server online'
    : statusState === 'offline'
      ? 'Server offline'
      : 'Checking server';
  renderConnectionState(statusState, connectionLabel);

  if (message) {
    if (serverMessage) {
      serverMessage.textContent = message;
      serverMessage.className = `status-text ${statusState === 'offline' ? 'error' : ''}`.trim();
    }
    return;
  }

  if (statusState === 'online' && currentPhoneUrl) {
    if (serverMessage) {
      serverMessage.textContent = 'Ready for phone uploads on your local network.';
      serverMessage.className = 'status-text success';
    }
    return;
  }

  if (statusState === 'online') {
    if (serverMessage) {
      serverMessage.textContent = 'Server is running, but no phone LAN URL was detected.';
      serverMessage.className = 'status-text error';
    }
    return;
  }

  if (serverMessage) {
    serverMessage.textContent = 'The local server is not responding yet.';
    serverMessage.className = 'status-text error';
  }
}

function renderAlternateUrls(urls) {
  if (!alternateUrls) {
    return;
  }

  const visibleUrls = Array.isArray(urls)
    ? urls.filter((item) => isUsablePhoneUrl(item.url))
    : [];

  if (visibleUrls.length <= 1) {
    alternateUrls.hidden = true;
    alternateUrls.innerHTML = '';
    return;
  }

  alternateUrls.hidden = false;
  alternateUrls.innerHTML = '';
  const title = document.createElement('h3');
  title.textContent = 'Other detected LAN URLs';
  const list = document.createElement('ul');

  visibleUrls.forEach((item) => {
    const listItem = document.createElement('li');
    const link = document.createElement('a');
    link.href = item.url;
    link.textContent = item.private ? `${item.url} (private LAN)` : item.url;
    link.target = '_blank';
    link.rel = 'noopener';
    listItem.appendChild(link);
    list.appendChild(listItem);
  });

  alternateUrls.append(title, list);
}

function renderUrlList(container, titleText, urls) {
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

  urls.forEach((item) => {
    const listItem = document.createElement('li');
    const link = document.createElement('a');
    link.href = item.url;
    link.textContent = item.private ? `${item.url} (private LAN)` : item.url;
    link.target = '_blank';
    link.rel = 'noopener';
    listItem.appendChild(link);
    list.appendChild(listItem);
  });

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
  if (serverMode === 'started') {
    return 'Electron started the local server';
  }
  if (serverMode === 'reused') {
    return 'Electron reused an existing server';
  }
  return 'Unknown launcher';
}

function renderDiagnostics(data) {
  diagnosticsList.innerHTML = '';
  const isListening = data.status === 'listening';
  setBadge(diagnosticsSummary, 'summary status-badge', isListening ? 'online' : 'offline', isListening ? 'Server online' : 'Status unknown');

  addDiagnosticRow('Server status', data.status || 'unknown');
  addDiagnosticRow('Launcher', getLauncherStatus());
  addDiagnosticRow('Server source', data.launchSource || 'unknown');
  addDiagnosticRow('Bind host', data.bindHost || data.configuredHost || 'unknown');
  addDiagnosticRow('Port', String(data.port || 'unknown'));
  addDiagnosticRow('Primary phone URL', currentPhoneUrl || data.primaryLanUrl || 'No LAN URL detected');
  addDiagnosticRow('Runtime data', data.runtimeDataDir || 'unknown');
  addDiagnosticRow('Upload staging', data.uploadTempDir || 'unknown');

  const privateLanUrls = Array.isArray(data.lanUrls) ? data.lanUrls.filter((item) => item.private) : [];
  renderUrlList(diagnosticsUrls, 'Detected LAN URLs', data.lanUrls || []);

  if (privateLanUrls.length === 0) {
    diagnosticsWarning.hidden = false;
    diagnosticsWarning.className = 'diagnostics-note warning';
    diagnosticsWarning.textContent = 'No private LAN IPv4 address was detected. Make sure the PC is connected to the same Wi-Fi as the phone, the network profile is Private, and Windows Firewall allows SnapOverLAN on Private networks.';
    diagnosticsPanel.open = true;
  } else {
    diagnosticsWarning.hidden = false;
    diagnosticsWarning.className = 'diagnostics-note';
    diagnosticsWarning.textContent = 'Phone checklist: use the LAN URL above, keep phone and PC on the same Wi-Fi, set the PC network to Private, and allow SnapOverLAN through Windows Firewall on Private networks if Windows asks.';
  }
}

function renderDiagnosticsError(error) {
  diagnosticsList.innerHTML = '';
  setBadge(diagnosticsSummary, 'summary status-badge', 'offline', 'Server offline');
  diagnosticsWarning.hidden = false;
  diagnosticsWarning.className = 'diagnostics-note warning';
  diagnosticsWarning.textContent = error.message || 'Check that the local server is running and reload the App.';
  diagnosticsPanel.open = true;
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
  } catch (_error) {
    phoneQr.hidden = true;
    qrFallback.textContent = '';
    qrFallback.className = 'status-text';
  }
}

function renderPhoneSetup(data) {
  const selectedPhoneUrl = choosePhoneUrl(data);
  currentPhoneUrl = selectedPhoneUrl?.url || '';
  phoneUrlInput.textContent = currentPhoneUrl || '';
  phoneUrlInput.title = currentPhoneUrl;
  if (copyPhoneUrlBtn) {
    copyPhoneUrlBtn.disabled = !currentPhoneUrl;
  }

  if (setupStatus && currentPhoneUrl) {
    setupStatus.textContent = 'Ready to scan or open from your phone.';
    setupStatus.className = 'status-text success';
  } else if (setupStatus) {
    setupStatus.textContent = 'No LAN address was detected. Check Wi-Fi and firewall settings.';
    setupStatus.className = 'status-text error';
  }

  renderAlternateUrls(data?.urls);
  renderQrCode(currentPhoneUrl);
  renderStatus();
}

function openQrModal() {
  if (!qrModal) {
    return;
  }

  renderQrCode(currentPhoneUrl);
  qrModal.hidden = false;
  closeQrBtn?.focus();
}

function closeQrModal() {
  if (!qrModal) {
    return;
  }

  qrModal.hidden = true;
  qrBtn?.focus();
}

function updatePhotoSummary(files) {
  if (!photoSummary) {
    return;
  }

  const countLabel = files.length === 1 ? '1 picture' : `${files.length} pictures`;
  photoSummary.textContent = `${countLabel} · auto-refresh on`;
  photoSummary.className = 'summary';
  photoSummary.removeAttribute('title');
}

function renderEmptyState(title, text, state = 'empty') {
  emptyStateTitle.textContent = title;
  if (emptyStateText) {
    emptyStateText.textContent = text;
  }
  emptyState.className = `empty-state ${state}`;
  emptyState.hidden = false;
}

function renderMediaLoading() {
  photoGrid.innerHTML = '';
  photoGrid.className = 'media-loading';
  photoGrid.style.removeProperty('--grid-columns');
  photoGrid.style.removeProperty('--grid-rows');
  emptyState.hidden = true;
  if (picturePagination) {
    picturePagination.hidden = true;
  }

  const loading = document.createElement('div');
  loading.className = 'loading-state';
  loading.textContent = 'Loading media...';
  photoGrid.appendChild(loading);
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForMinimumLoadingTime(startedAt, minimumMs = 400) {
  const elapsed = Date.now() - startedAt;
  const remaining = Math.max(0, minimumMs - elapsed);
  if (remaining > 0) {
    await new Promise((resolve) => window.setTimeout(resolve, remaining));
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = MEDIA_REFRESH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const externalSignal = options.signal;

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Could not load media. Try Refresh again.');
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function getGridCountTarget() {
  return gridCountSetting === 'auto' ? null : Number(gridCountSetting);
}

function updateGridCountControl() {
  if (!gridCountSelect) {
    return;
  }

  gridCountSelect.value = gridCountSetting;
  gridCountSelect.disabled = false;
  if (gridCountControl) {
    gridCountControl.hidden = picturesView !== 'grid';
  }
}

function calculateFixedGridDimensions(targetCount) {
  return FIXED_GRID_LAYOUTS[targetCount] || DEFAULT_GRID_LAYOUT;
}

function calculateGridLayout() {
  if (picturesView !== 'grid') {
    return gridLayout;
  }

  const width = photoGrid.clientWidth;
  const height = photoGrid.clientHeight;
  if (width <= 0) {
    return gridLayout;
  }

  const historyOpen = Boolean(batchesPanel && !batchesPanel.hidden);
  const maxColumns = historyOpen
    ? DEFAULT_GRID_LAYOUT.columns
    : Math.max(1, Math.floor((width + GRID_GAP) / (GRID_MIN_CARD_WIDTH + GRID_GAP)));
  const maxRows = historyOpen
    ? DEFAULT_GRID_LAYOUT.rows
    : Math.max(1, Math.floor((height + GRID_GAP) / (GRID_MIN_CARD_HEIGHT + GRID_GAP)));
  const targetCount = getGridCountTarget();
  const dimensions = targetCount
    ? calculateFixedGridDimensions(targetCount)
    : { columns: maxColumns, rows: maxRows };
  const columns = Math.max(1, dimensions.columns);
  const rows = Math.max(1, dimensions.rows);

  return {
    columns,
    rows,
    pageSize: Math.max(1, targetCount ? Math.min(targetCount, columns * rows) : columns * rows),
  };
}

function applyGridLayout() {
  if (picturesView !== 'grid') {
    return;
  }

  gridLayout = calculateGridLayout();
  photoGrid.style.setProperty('--grid-columns', String(gridLayout.columns));
  photoGrid.style.setProperty('--grid-rows', String(gridLayout.rows));
}

function getPicturesPageSize() {
  return picturesView === 'list' ? LIST_PAGE_SIZE : gridLayout.pageSize;
}

function getFileType(file) {
  const extension = file.name?.split('.').pop()?.trim();
  return extension ? extension.toUpperCase() : 'IMAGE';
}

function getPictureKey(file) {
  return file?.url || file?.name || '';
}

function arePictureListsEqual(previousFiles, nextFiles) {
  if (previousFiles.length !== nextFiles.length) {
    return false;
  }

  return previousFiles.every((previousFile, index) => {
    const nextFile = nextFiles[index];
    return getPictureKey(previousFile) === getPictureKey(nextFile)
      && previousFile.size === nextFile.size;
  });
}

function updateViewToggle() {
  gridViewBtn.classList.toggle('active', picturesView === 'grid');
  listViewBtn.classList.toggle('active', picturesView === 'list');
  gridViewBtn.setAttribute('aria-pressed', String(picturesView === 'grid'));
  listViewBtn.setAttribute('aria-pressed', String(picturesView === 'list'));
  updateGridCountControl();
}

function createVideoPlaceholder(className = '') {
  const placeholder = document.createElement('div');
  placeholder.className = className ? `video-placeholder ${className}` : 'video-placeholder';
  placeholder.textContent = 'Video';
  return placeholder;
}

function createPictureActions(file, mediaUrl, variant = '') {
  const actions = document.createElement('div');
  actions.className = variant ? `photo-actions ${variant}` : 'photo-actions';
  const isVideo = isVideoFile(file);

  if (!isVideo) {
    const copyButton = document.createElement('button');
    copyButton.className = 'photo-action';
    copyButton.type = 'button';
    copyButton.textContent = 'Copy';
    copyButton.addEventListener('click', async () => {
      copyButton.disabled = true;
      try {
        await copyImage(mediaUrl);
        clearPicturesMessage();
      } catch (error) {
        setPicturesMessage(error.message || 'Could not copy image.');
      } finally {
        copyButton.disabled = false;
      }
    });
    actions.appendChild(copyButton);
  } else {
    const copySlot = document.createElement('span');
    copySlot.className = 'copy-slot';
    copySlot.setAttribute('aria-hidden', 'true');
    actions.appendChild(copySlot);
  }

  const downloadButton = document.createElement('button');
  downloadButton.className = 'photo-action';
  downloadButton.type = 'button';
  downloadButton.textContent = 'Download';
  downloadButton.addEventListener('click', () => {
    downloadImage(file, mediaUrl);
  });

  actions.appendChild(downloadButton);
  return actions;
}

function updatePicturesPagination(totalPictures) {
  const pageSize = getPicturesPageSize();
  const totalPages = Math.max(1, Math.ceil(totalPictures / pageSize));
  currentPicturesPage = picturesView === 'list' ? 0 : Math.min(currentPicturesPage, totalPages - 1);

  if (!picturePagination || !prevPicturesPage || !nextPicturesPage || !picturesPageLabel) {
    return totalPages;
  }

  picturePagination.hidden = picturesView === 'list' || totalPictures <= pageSize;
  picturesPageLabel.textContent = `${currentPicturesPage + 1} / ${totalPages}`;
  prevPicturesPage.disabled = currentPicturesPage === 0;
  nextPicturesPage.disabled = currentPicturesPage >= totalPages - 1;
  return totalPages;
}

function renderPictures(files) {
  photoGrid.innerHTML = '';
  photoGrid.className = picturesView === 'list' ? 'photo-list' : 'photo-grid';
  if (picturesView === 'grid') {
    applyGridLayout();
  } else {
    photoGrid.style.removeProperty('--grid-columns');
    photoGrid.style.removeProperty('--grid-rows');
  }
  emptyState.hidden = files.length > 0;
  downloadAllBtn.hidden = files.length === 0;
  downloadAllBtn.disabled = files.length === 0;
  updateViewToggle();
  if (files.length > 0) {
    picturesMessage.hidden = true;
  }
  updatePhotoSummary(files);
  updatePicturesPagination(files.length);

  if (files.length === 0) {
    currentPicturesPage = 0;
    updatePicturesPagination(0);
    picturesMessage.hidden = true;
    renderEmptyState('No pictures yet', 'Upload photos from your phone.');
    return;
  }

  const pageSize = getPicturesPageSize();
  const startIndex = currentPicturesPage * pageSize;
  const visibleFiles = picturesView === 'list'
    ? files
    : files.slice(startIndex, startIndex + pageSize);
  const fragment = document.createDocumentFragment();

  visibleFiles.forEach((file) => {
    const mediaUrl = serverUrl(file.url);
    const isVideo = isVideoFile(file);

    if (picturesView === 'list') {
      const row = document.createElement('article');
      row.className = 'photo-row';

      const name = document.createElement('div');
      name.className = 'row-name';
      name.title = file.name;
      name.textContent = file.name || (isVideo ? 'Video' : 'Image');

      const type = document.createElement('div');
      type.className = 'row-type';
      type.textContent = getFileType(file);

      const size = document.createElement('div');
      size.className = 'row-size';
      size.textContent = Number.isFinite(file.size) ? formatBytes(file.size) : '';

      row.append(name, type, size, createPictureActions(file, mediaUrl, 'row-actions'));
      fragment.appendChild(row);
      return;
    }

    const card = document.createElement('article');
    card.className = 'photo-card';

    const thumbWrap = document.createElement('div');
    thumbWrap.className = 'thumb-wrap';
    if (isVideo) {
      thumbWrap.appendChild(createVideoPlaceholder());
    } else {
      const image = document.createElement('img');
      image.src = mediaUrl;
      image.alt = file.name;
      image.loading = 'lazy';
      thumbWrap.appendChild(image);
    }

    card.append(thumbWrap, createPictureActions(file, mediaUrl));
    fragment.appendChild(card);
  });

  photoGrid.appendChild(fragment);
}

function getAppFiles(files) {
  return files.filter((file) => file.name && !file.name.startsWith('.'));
}

async function loadPhoneSetup({ showActivity = false } = {}) {
  if (showActivity && setupStatus) {
    setupStatus.textContent = 'Refreshing phone upload URL...';
    setupStatus.className = 'status-text';
  }

  try {
    const response = await fetch(serverUrl('/api/phone-url'));
    if (!response.ok) {
      throw new Error(`Phone URL request failed (${response.status})`);
    }
    const data = await response.json();
    renderPhoneSetup(data);
    return data;
  } catch (error) {
    currentPhoneUrl = '';
    phoneUrlInput.textContent = '';
    phoneUrlInput.title = '';
    if (copyPhoneUrlBtn) {
      copyPhoneUrlBtn.disabled = true;
    }
    renderAlternateUrls([]);
    renderQrCode('');
    if (setupStatus) {
      setupStatus.textContent = error.message || 'Could not load the phone upload URL.';
      setupStatus.className = 'status-text error';
    }
    renderStatus({ state: 'offline', message: 'Phone upload URL is unavailable because the local server did not respond.' });
    return null;
  }
}

async function loadServerStatus({ showActivity = false } = {}) {
  if (showActivity) {
    renderStatus({ state: 'checking', message: 'Checking the local server...' });
  }

  try {
    const response = await fetch(serverUrl('/api/server-status'));
    if (!response.ok) {
      throw new Error(`Server status request failed (${response.status})`);
    }

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
    statusLastCheckedAt = new Date();
    if (currentSnapOverLAN
      && desktopServerState !== 'starting'
      && desktopServerState !== 'stopping') {
      setDesktopServerState('online');
    }
    if (legacySnapOverLAN && !currentSnapOverLAN) {
      renderStatus({
        state: 'online',
        message: 'An older SnapOverLAN server is running. Stop it once and restart the app.',
      });
    } else {
      renderStatus();
    }
    renderDiagnostics(lastServerStatusData);
    return lastServerStatusData;
  } catch (error) {
    lastServerStatusData = null;
    statusLastCheckedAt = new Date();
    if (desktopServerState !== 'starting'
      && desktopServerState !== 'stopping'
      && desktopServerState !== 'error') {
      setDesktopServerState('offline');
    }
    renderStatus({ state: 'offline', message: error.message || 'The local server is not responding.' });
    renderDiagnosticsError(error);
    return null;
  }
}

async function loadLatestPictures({ source = 'manual', force = false } = {}) {
  if (latestPicturesRefreshPromise) {
    if (source !== 'manual') {
      return latestPicturesRefreshPromise;
    }

    latestPicturesAbortController?.abort();
  }

  const requestId = latestPicturesRequestId + 1;
  latestPicturesRequestId = requestId;
  const requestController = new AbortController();
  latestPicturesAbortController = requestController;

  latestPicturesRefreshPromise = (async () => {
    const isCurrentRequest = () => requestId === latestPicturesRequestId;
    photoGrid.setAttribute('aria-busy', 'true');

    const showActivity = source === 'manual' || source === 'initial';
    const shouldShowLoadingBeforeFetch = source === 'manual' || force;
    let loadingStartedAt = 0;

    const showLoading = async () => {
      loadingStartedAt = Date.now();
      renderMediaLoading();
      await waitForNextPaint();
    };

    if (shouldShowLoadingBeforeFetch) {
      await showLoading();
      if (!isCurrentRequest()) {
        return latestFiles;
      }
    }

    if (showActivity && photoSummary) {
      photoSummary.textContent = 'Refreshing pictures...';
      photoSummary.className = 'summary';
    }

    try {
      const response = await fetchWithTimeout(serverUrl('/api/latest'), {
        signal: requestController.signal,
      });
      if (!response.ok) {
        throw new Error(`Photo request failed (${response.status})`);
      }
      const data = await response.json();
      if (!isCurrentRequest()) {
        return latestFiles;
      }

      const files = getAppFiles(Array.isArray(data.files) ? data.files : []);
      const didPicturesChange = !arePictureListsEqual(latestFiles, files);

      if (loadingStartedAt) {
        await waitForMinimumLoadingTime(loadingStartedAt);
        if (!isCurrentRequest()) {
          return latestFiles;
        }
      }

      if (force || !hasLoadedPhotos || didPicturesChange) {
        latestFiles = files;
        renderPictures(files);
      } else if (picturesMessage.textContent === 'Could not refresh pictures') {
        picturesMessage.hidden = true;
        if (loadingStartedAt) {
          renderPictures(latestFiles);
        }
      } else if (loadingStartedAt) {
        renderPictures(latestFiles);
      }

      hasLoadedPhotos = true;
      renderStatus();
      return files;
    } catch (error) {
      if (!isCurrentRequest()) {
        return latestFiles;
      }
      if (loadingStartedAt) {
        await waitForMinimumLoadingTime(loadingStartedAt);
        if (!isCurrentRequest()) {
          return latestFiles;
        }
      }
      if (!hasLoadedPhotos && latestFiles.length === 0) {
        photoGrid.innerHTML = '';
        renderEmptyState(
          'Could not load media',
          'Try Refresh again.',
          'error',
        );
      }
      if (hasLoadedPhotos || latestFiles.length > 0) {
        if (loadingStartedAt) {
          renderPictures(latestFiles);
        }
        picturesMessage.textContent = error.message || 'Could not load media. Try Refresh again.';
        picturesMessage.hidden = false;
      } else if (photoSummary) {
        photoSummary.textContent = 'Could not load media';
        photoSummary.className = 'summary error';
        photoSummary.title = error.message || 'Could not load media. Try Refresh again.';
      }
      renderStatus({ state: 'offline', message: error.message || 'Could not load media. Try Refresh again.' });
      return [];
    } finally {
      if (isCurrentRequest()) {
        photoGrid.removeAttribute('aria-busy');
      }
    }
  })();

  try {
    return await latestPicturesRefreshPromise;
  } finally {
    if (requestId === latestPicturesRequestId) {
      latestPicturesRefreshPromise = null;
      latestPicturesAbortController = null;
    }
  }
}

function setDashboardRefreshBusy(isBusy) {
  refreshBtn.disabled = isBusy;
  refreshBtn.textContent = isBusy ? 'Refreshing...' : 'Refresh';
}

async function refreshDashboard({ source = 'manual' } = {}) {
  if (dashboardRefreshInFlight) {
    if (source === 'manual') {
      await loadLatestPictures({ source: 'manual', force: true });
    }
    return;
  }

  const showActivity = source === 'manual' || source === 'initial';
  dashboardRefreshInFlight = true;

  if (showActivity) {
    setDashboardRefreshBusy(true);
  }

  try {
    await Promise.all([
      loadServerStatus({ showActivity }),
      loadPhoneSetup({ showActivity }),
      loadLatestPictures({ source }),
      loadBatchHistory(),
    ]);
  } finally {
    dashboardRefreshInFlight = false;
    if (showActivity) {
      setDashboardRefreshBusy(false);
    }
  }
}

function showUploadLoading() {
  if (!uploadLoadingStartedAt) {
    uploadLoadingStartedAt = Date.now();
  }

  if (uploadLoadingTimedOut) {
    return;
  }

  photoGrid.setAttribute('aria-busy', 'true');
  renderMediaLoading();
}

function stopUploadLoading() {
  uploadLoadingStartedAt = 0;
  uploadLoadingTimedOut = false;
  photoGrid.removeAttribute('aria-busy');
}

function handleUploadLoadingTimeout() {
  if (
    uploadLoadingTimedOut
    || !uploadLoadingStartedAt
    || Date.now() - uploadLoadingStartedAt < UPLOAD_LOADING_TIMEOUT_MS
  ) {
    return;
  }

  uploadLoadingTimedOut = true;
  photoGrid.removeAttribute('aria-busy');
  if (hasLoadedPhotos || latestFiles.length > 0) {
    renderPictures(latestFiles);
    picturesMessage.textContent = 'Upload is taking longer than expected. Try Refresh again.';
    picturesMessage.hidden = false;
    return;
  }

  renderEmptyState('Could not load media', 'Upload is taking longer than expected. Try Refresh again.', 'error');
}

async function refreshUploadStatus() {
  if (uploadStatusRefreshInFlight || document.hidden) {
    return;
  }

  uploadStatusRefreshInFlight = true;
  try {
    const response = await fetchWithTimeout(serverUrl('/api/upload-status'), {}, 5000);
    if (!response.ok) {
      throw new Error(`Upload status request failed (${response.status})`);
    }
    const status = await response.json();
    const uploadInProgress = Boolean(status.uploadInProgress);
    const uploadVersion = Number.isFinite(status.uploadVersion) ? status.uploadVersion : 0;
    const previousUploadInProgress = lastUploadInProgress;
    const previousUploadVersion = lastUploadVersion;

    if (lastUploadVersion === null) {
      lastUploadVersion = uploadVersion;
    }

    if (uploadInProgress) {
      lastUploadInProgress = true;
      showUploadLoading();
      handleUploadLoadingTimeout();
      return;
    }

    lastUploadInProgress = false;
    const didUploadFinish = previousUploadInProgress || (
      previousUploadVersion !== null && uploadVersion > previousUploadVersion
    );
    lastUploadVersion = uploadVersion;

    if (didUploadFinish) {
      stopUploadLoading();
      await loadLatestPictures({ source: 'upload-complete', force: true });
    }
  } catch (_error) {
    if (lastUploadInProgress && !uploadLoadingTimedOut) {
      handleUploadLoadingTimeout();
    }
  } finally {
    uploadStatusRefreshInFlight = false;
  }
}

function startUploadStatusRefresh() {
  if (uploadStatusTimer !== null || document.hidden) {
    return;
  }

  refreshUploadStatus();
  uploadStatusTimer = window.setInterval(refreshUploadStatus, UPLOAD_STATUS_REFRESH_MS);
}

function stopUploadStatusRefresh() {
  if (uploadStatusTimer === null) {
    return;
  }

  window.clearInterval(uploadStatusTimer);
  uploadStatusTimer = null;
}

function runAutoRefresh() {
  if (!document.hidden && !lastUploadInProgress) {
    loadLatestPictures({ source: 'auto' });
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer !== null || document.hidden) {
    return;
  }
  autoRefreshTimer = window.setInterval(runAutoRefresh, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (autoRefreshTimer === null) {
    return;
  }
  window.clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}

function handleGridResize() {
  if (picturesView !== 'grid') {
    return;
  }

  const previousPageSize = gridLayout.pageSize;
  const previousColumns = gridLayout.columns;
  const previousRows = gridLayout.rows;
  applyGridLayout();

  if (
    gridLayout.pageSize !== previousPageSize
    || gridLayout.columns !== previousColumns
    || gridLayout.rows !== previousRows
  ) {
    renderPictures(latestFiles);
  }
}

initGaloisTables();
renderStatus({ state: 'checking', message: 'Checking the local server...' });
renderQrCode('');

refreshBtn.addEventListener('click', () => {
  refreshDashboard({ source: 'manual' });
});

retryServerBtn?.addEventListener('click', async () => {
  if (!window.snapOverLAN || serverRetryOperation) {
    return;
  }

  setDesktopServerState('starting');
  renderStatus({ state: 'checking', message: 'Starting the local server...' });
  serverRetryOperation = window.snapOverLAN.retryServer();
  try {
    const server = await serverRetryOperation;
    setDesktopServerState(server?.state);
    if (server?.state === 'error') {
      renderStatus({
        state: 'offline',
        message: server.error || 'Could not change server state.',
      });
    }
  } catch (error) {
    const server = await window.snapOverLAN.getServerState().catch(() => ({ state: 'error' }));
    setDesktopServerState(server?.state || 'error');
    renderStatus({ state: 'offline', message: server?.error || error.message || 'Could not change server state.' });
  } finally {
    serverRetryOperation = null;
    renderDesktopControls();
    await refreshDashboard({ source: 'manual' });
  }
});

backgroundToggleBtn?.addEventListener('click', async () => {
  if (!window.snapOverLAN) {
    return;
  }

  backgroundToggleBtn.disabled = true;
  try {
    backgroundModeEnabled = await window.snapOverLAN.setBackgroundMode(!backgroundModeEnabled);
    renderDesktopControls();
  } catch (error) {
    console.error('Could not change background mode:', error);
  } finally {
    renderDesktopControls();
  }
});

qrBtn.addEventListener('click', openQrModal);

closeQrBtn.addEventListener('click', closeQrModal);

qrModal.addEventListener('click', (event) => {
  if (event.target === qrModal) {
    closeQrModal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && qrModal && !qrModal.hidden) {
    closeQrModal();
  }
});

downloadAllBtn.addEventListener('click', downloadAllPictures);
batchesBtn?.addEventListener('click', () => setBatchHistoryOpen(true));
closeBatchesBtn?.addEventListener('click', () => setBatchHistoryOpen(false));
saveRetentionBtn?.addEventListener('click', saveRetentionSetting);
retentionSelect?.addEventListener('change', updateRetentionSaveButton);
clearBatchesBtn?.addEventListener('click', clearAllBatches);
gridCountSelect?.addEventListener('change', () => {
  if (!GRID_COUNT_OPTIONS.includes(gridCountSelect.value)) {
    return;
  }

  gridCountSetting = gridCountSelect.value;
  localStorage.setItem(GRID_COUNT_KEY, gridCountSetting);
  currentPicturesPage = 0;
  applyGridLayout();
  renderPictures(latestFiles);
});

gridViewBtn.addEventListener('click', () => {
  if (picturesView === 'grid') {
    return;
  }

  picturesView = 'grid';
  localStorage.setItem(PICTURES_VIEW_KEY, picturesView);
  renderPictures(latestFiles);
});

listViewBtn.addEventListener('click', () => {
  if (picturesView === 'list') {
    return;
  }

  picturesView = 'list';
  localStorage.setItem(PICTURES_VIEW_KEY, picturesView);
  renderPictures(latestFiles);
});

prevPicturesPage.addEventListener('click', () => {
  if (picturesView === 'list' || currentPicturesPage === 0) {
    return;
  }

  currentPicturesPage -= 1;
  renderPictures(latestFiles);
});

nextPicturesPage.addEventListener('click', () => {
  if (picturesView === 'list') {
    return;
  }

  const totalPages = Math.max(1, Math.ceil(latestFiles.length / getPicturesPageSize()));
  if (currentPicturesPage >= totalPages - 1) {
    return;
  }

  currentPicturesPage += 1;
  renderPictures(latestFiles);
});

if (copyPhoneUrlBtn) {
  copyPhoneUrlBtn.addEventListener('click', async () => {
    if (!currentPhoneUrl) {
      return;
    }

    try {
      await copyText(currentPhoneUrl);
      if (setupStatus) {
        setupStatus.textContent = 'Phone upload URL copied.';
        setupStatus.className = 'status-text success';
      }
    } catch (_error) {
      if (setupStatus) {
        setupStatus.textContent = 'Copy failed. Select the URL and copy it manually.';
        setupStatus.className = 'status-text error';
      }
    }
  });
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopAutoRefresh();
    stopUploadStatusRefresh();
    return;
  }

  loadLatestPictures({ source: 'auto' });
  startUploadStatusRefresh();
  startAutoRefresh();
});

window.addEventListener('pagehide', () => {
  stopAutoRefresh();
  stopUploadStatusRefresh();
});

if (window.ResizeObserver) {
  const gridResizeObserver = new ResizeObserver(handleGridResize);
  gridResizeObserver.observe(photoGrid);
} else {
  window.addEventListener('resize', handleGridResize);
}

refreshDashboard({ source: 'initial' });
syncDesktopControls();
window.snapOverLAN?.onDesktopStateChanged?.(({
  server,
  backgroundMode,
}) => {
  backgroundModeEnabled = server?.state === 'online' && Boolean(backgroundMode);
  setDesktopServerState(server?.state);
  if (server?.state === 'starting') {
    renderStatus({ state: 'checking', message: 'Starting the local server...' });
  } else if (server?.state === 'error') {
    renderStatus({ state: 'offline', message: server.error || 'The local server could not start.' });
  } else if (server?.state === 'online') {
    renderStatus({ state: 'online', message: 'Server online' });
  }
});
window.snapOverLAN?.onAutoCopyResult?.(showAutoCopyResult);
startUploadStatusRefresh();
startAutoRefresh();
