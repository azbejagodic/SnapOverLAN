const API_BASE_URL = 'http://localhost:8787';
const REFRESH_INTERVAL_MS = 2000;

const autoCopyToggleBtn = document.getElementById('autoCopyToggleBtn');
const refreshBtn = document.getElementById('refreshBtn');
const statusEl = document.getElementById('status');
const gridEl = document.getElementById('grid');
let autoCopyEnabled = false;
let autoCopyRequestInFlight = false;
let autoCopySettingLoaded = false;
let latestImageSignature = '';
let refreshInFlight = false;

function setStatus(message, type = 'muted') {
  statusEl.textContent = message;
  statusEl.className = type;
}

function toHostPattern(origin) {
  const url = new URL(origin);
  return `${url.protocol}//${url.host}/*`;
}

async function ensureHostPermission(origin) {
  const pattern = toHostPattern(origin);
  const has = await chrome.permissions.contains({ origins: [pattern] });
  if (has) return;

  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    throw new Error(`Host permission denied for ${pattern}`);
  }
}

function renderAutoCopyToggle() {
  autoCopyToggleBtn.textContent = `Auto-copy: ${autoCopyEnabled ? 'On' : 'Off'}`;
  autoCopyToggleBtn.disabled = autoCopyRequestInFlight || !autoCopySettingLoaded;
  autoCopyToggleBtn.setAttribute('aria-pressed', String(autoCopyEnabled));
  autoCopyToggleBtn.setAttribute(
    'aria-label',
    autoCopyEnabled
      ? 'Turn automatic copying of the first uploaded photo off'
      : 'Turn automatic copying of the first uploaded photo on',
  );
}

async function requestAutoCopySetting(origin, method = 'GET', enabled) {
  const requestOptions = { method };
  if (method === 'PUT') {
    requestOptions.headers = { 'Content-Type': 'application/json' };
    requestOptions.body = JSON.stringify({ enabled });
  }

  let response;
  try {
    response = await fetch(`${origin}/api/auto-copy`, requestOptions);
  } catch {
    throw new Error('Could not connect to the desktop app.');
  }

  let json = null;
  try {
    json = await response.json();
  } catch {}
  if (!response.ok) {
    throw new Error(json?.error || `Server returned ${response.status} for /api/auto-copy.`);
  }
  if (typeof json?.enabled !== 'boolean') {
    throw new Error('Invalid auto-copy response from the desktop app.');
  }
  return json.enabled;
}

async function syncAutoCopySetting() {
  if (autoCopyRequestInFlight) return;

  autoCopyRequestInFlight = true;
  renderAutoCopyToggle();
  try {
    const origin = API_BASE_URL;
    await ensureHostPermission(origin);
    autoCopyEnabled = await requestAutoCopySetting(origin);
    autoCopySettingLoaded = true;
    setStatus('', 'muted');
  } catch (error) {
    console.error('[popup] auto-copy read failed', error);
    setStatus(error.message || 'Could not read the Auto-copy setting.', 'error');
  } finally {
    autoCopyRequestInFlight = false;
    renderAutoCopyToggle();
  }
}

async function loadLatest(origin) {
  console.log('[popup] refresh fetch start', { endpoint: `${origin}/api/latest` });
  let response;
  try {
    response = await fetch(`${origin}/api/latest`);
  } catch {
    throw new Error('Server unreachable or CORS/network error while requesting /api/latest.');
  }

  if (!response.ok) {
    throw new Error(`Server returned ${response.status} for /api/latest.`);
  }

  const json = await response.json();
  if (!json || !Array.isArray(json.files)) {
    throw new Error('Invalid API response. Expected { files:[{name,size,url}] }.');
  }

  console.log('[popup] refresh fetch end', { filesCount: json.files.length });
  return json.files;
}

function buildImageUrl(origin, file) {
  if (file && typeof file.url === 'string' && file.url.trim().length > 0) {
    return new URL(file.url, origin).toString();
  }

  if (!file || typeof file.name !== 'string' || file.name.trim().length === 0) {
    throw new Error('Invalid file entry from API (missing name/url).');
  }

  return `${origin}/files/${encodeURIComponent(file.name)}`;
}

function getImageSignature(files) {
  return files
    .map((file) => `${file?.name || ''}|${file?.url || ''}|${file?.size ?? ''}`)
    .join('\n');
}

async function convertImageBlobToPng(blob) {
  console.log('[popup] convert start', { sourceType: blob.type, sourceSize: blob.size });

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (error) {
    console.error('[popup] createImageBitmap failed', error);
    throw new Error('Copy blocked. Use Open then Ctrl+C.');
  }

  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D canvas context unavailable.');
    }

    ctx.drawImage(bitmap, 0, 0);

    const pngBlob = await new Promise((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) {
          resolve(result);
          return;
        }
        reject(new Error('Canvas PNG conversion returned null blob.'));
      }, 'image/png');
    });

    console.log('[popup] convert end', { outputType: pngBlob.type, outputSize: pngBlob.size });
    return pngBlob;
  } catch (error) {
    console.error('[popup] PNG conversion failed', error);
    throw new Error('Copy blocked. Use Open then Ctrl+C.');
  } finally {
    bitmap.close();
  }
}

async function copyImageFromPopup(imageUrl) {
  console.log('[popup] copy fetch start', { imageUrl });
  let response;
  try {
    response = await fetch(imageUrl);
  } catch (error) {
    console.error('[popup] copy fetch failed', error);
    throw new Error('Network/CORS error while downloading image.');
  }

  console.log('[popup] copy fetch end', { status: response.status });
  if (!response.ok) {
    throw new Error(`Failed to fetch image (${response.status}).`);
  }

  const blob = await response.blob();
  if (!blob.type || !blob.type.startsWith('image/')) {
    throw new Error(`Fetched resource is not an image blob (type: ${blob.type || 'unknown'}).`);
  }

  setStatus('Converting...', 'muted');
  const pngBlob = await convertImageBlobToPng(blob);

  try {
    console.log('[popup] clipboard write start', { mime: 'image/png', size: pngBlob.size });
    const item = new ClipboardItem({ 'image/png': pngBlob });
    await navigator.clipboard.write([item]);
    console.log('[popup] clipboard write end');
  } catch (error) {
    console.error('[popup] clipboard write failed', error);
    throw new Error(`Clipboard write denied: ${error?.message || 'unknown error'}`);
  }
}

function makeCard(origin, file) {
  const imageUrl = buildImageUrl(origin, file);

  const card = document.createElement('div');
  card.className = 'card';

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'thumb-wrap';

  const img = document.createElement('img');
  img.src = imageUrl;
  img.alt = file?.name || 'image';
  img.loading = 'lazy';
  thumbWrap.appendChild(img);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = file?.name || '(unnamed)';

  const actions = document.createElement('div');
  actions.className = 'actions';

  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', async () => {
    console.log('[popup] copy clicked', { imageUrl });
    setStatus('Copying...', 'muted');
    copyBtn.disabled = true;
    try {
      await copyImageFromPopup(imageUrl);
      setStatus('Copied as PNG', 'ok');
    } catch (error) {
      console.error('[popup] copy failed', error);
      setStatus(error.message || 'Failed to copy image.', 'error');
    } finally {
      copyBtn.disabled = false;
    }
  });

  const openBtn = document.createElement('button');
  openBtn.textContent = 'Open';
  openBtn.addEventListener('click', async () => {
    await chrome.tabs.create({ url: imageUrl });
  });

  actions.append(copyBtn, openBtn);
  card.append(thumbWrap, meta, actions);
  return card;
}

async function refresh({ showLoading = false, force = false } = {}) {
  if (refreshInFlight) return;

  refreshInFlight = true;
  if (showLoading) {
    setStatus('Loading...', 'muted');
    refreshBtn.disabled = true;
  }

  try {
    const origin = API_BASE_URL;
    await ensureHostPermission(origin);

    const files = await loadLatest(origin);
    const imageOrigin = origin;
    const nextSignature = getImageSignature(files);

    if (!force && nextSignature === latestImageSignature) {
      setStatus('', 'muted');
      return;
    }

    if (files.length === 0) {
      console.log('[popup] rendering count computed', { apiFilesCount: files.length, renderedCount: 0 });
      latestImageSignature = nextSignature;
      gridEl.textContent = '';
      setStatus('No files found.', 'muted');
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const file of files) {
      try {
        fragment.appendChild(makeCard(imageOrigin, file));
      } catch (error) {
        console.error('[popup] skipping malformed file', { file, error });
      }
    }

    const renderedCount = fragment.childNodes.length;
    console.log('[popup] rendering count computed', {
      apiFilesCount: files.length,
      renderedCount
    });

    if (!renderedCount) {
      latestImageSignature = nextSignature;
      gridEl.textContent = '';
      setStatus('No valid image entries found in API response.', 'error');
      return;
    }

    const scrollTop = gridEl.scrollTop;
    gridEl.textContent = '';
    gridEl.appendChild(fragment);
    gridEl.scrollTop = scrollTop;
    latestImageSignature = nextSignature;
    setStatus('', 'muted');
  } catch (error) {
    console.error('[popup] refresh failed', error);
    setStatus('Could not connect to server.', 'error');
  } finally {
    refreshInFlight = false;
    refreshBtn.disabled = false;
  }
}

async function init() {
  console.log('[popup] popup loaded');

  // Popup auto-refreshes on open so users immediately see latest images.
  await refresh({ showLoading: true, force: true });
  await syncAutoCopySetting();
  setInterval(() => refresh(), REFRESH_INTERVAL_MS);
}

autoCopyToggleBtn.addEventListener('click', async () => {
  if (autoCopyRequestInFlight) return;

  const nextEnabled = !autoCopyEnabled;
  autoCopyRequestInFlight = true;
  renderAutoCopyToggle();
  try {
    const origin = API_BASE_URL;
    await ensureHostPermission(origin);
    autoCopyEnabled = await requestAutoCopySetting(origin, 'PUT', nextEnabled);
    autoCopySettingLoaded = true;
    setStatus('', 'muted');
  } catch (error) {
    console.error('[popup] auto-copy update failed', error);
    setStatus(error.message || 'Could not update the Auto-copy setting.', 'error');
  } finally {
    autoCopyRequestInFlight = false;
    renderAutoCopyToggle();
  }
});
refreshBtn.addEventListener('click', async () => {
  await refresh({ showLoading: true, force: true });
  await syncAutoCopySetting();
});
window.addEventListener('focus', () => {
  refresh({ force: true });
  syncAutoCopySetting();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refresh({ force: true });
  }
});
document.addEventListener('DOMContentLoaded', init);
