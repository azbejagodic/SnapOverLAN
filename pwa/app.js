const MAX_FILES = 20;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const cameraInput = document.getElementById('cameraInput');
const galleryInput = document.getElementById('galleryInput');
const uploadBtn = document.getElementById('uploadBtn');
const statusEl = document.getElementById('status');

const selectedGrid = document.getElementById('selectedGrid');
const selectedCount = document.getElementById('selectedCount');

// File inputs expose a transient, read-only FileList, so this array is the tray's source of truth.
let selectedFiles = [];
let hasEverSelectedFiles = false;

function setStatus(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = kind ? kind : '';
}

function updateSelectedCount() {
  selectedCount.textContent = `Selected: ${selectedFiles.length} / ${MAX_FILES}`;
  uploadBtn.disabled = selectedFiles.length === 0;
}

function isSupportedImage(file) {
  return ALLOWED_IMAGE_MIME_TYPES.has((file.type || '').toLowerCase());
}

function renderSelectedTray() {
  selectedGrid.innerHTML = '';

  selectedFiles.forEach((file, index) => {
    const tile = document.createElement('div');
    tile.className = 'tile';

    const img = document.createElement('img');
    const objectUrl = URL.createObjectURL(file);
    img.src = objectUrl;
    img.alt = file.name || `selected-photo-${index + 1}`;
    img.onload = () => URL.revokeObjectURL(objectUrl);
    tile.appendChild(img);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'remove';
    removeBtn.setAttribute('aria-label', `Remove photo ${index + 1}`);
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      selectedFiles.splice(index, 1);
      renderSelectedTray();
      updateSelectedCount();
      if (selectedFiles.length === 0) setStatus('Tray is empty.');
    });

    tile.appendChild(removeBtn);
    selectedGrid.appendChild(tile);
  });

}

function appendFiles(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;
  const supportedFiles = files.filter(isSupportedImage);

  if (supportedFiles.length === 0) {
    setStatus('Only JPEG, PNG, WebP, HEIC, and HEIF photos are supported.', 'error');
    return;
  }

  if (selectedFiles.length >= MAX_FILES) {
    setStatus(`Limit reached (${MAX_FILES}). Remove a file before adding more.`, 'error');
    return;
  }

  const availableSlots = MAX_FILES - selectedFiles.length;
  const acceptedFiles = supportedFiles.slice(0, availableSlots);
  if (acceptedFiles.length === 0) {
    return;
  }

  hasEverSelectedFiles = true;
  selectedFiles.push(...acceptedFiles);

  if (supportedFiles.length < files.length) {
    setStatus(`Added ${acceptedFiles.length} photo${acceptedFiles.length > 1 ? 's' : ''}. Unsupported files were skipped.`, 'error');
  } else if (acceptedFiles.length < supportedFiles.length) {
    setStatus(`Added ${acceptedFiles.length}. Tray limit is ${MAX_FILES}, extra photos were skipped.`, 'error');
  } else {
    setStatus(`Added ${acceptedFiles.length} photo${acceptedFiles.length > 1 ? 's' : ''} to tray.`);
  }

  renderSelectedTray();
  updateSelectedCount();
}

cameraInput.addEventListener('change', () => {
  appendFiles(cameraInput.files);
  cameraInput.value = '';
});

galleryInput.addEventListener('change', () => {
  appendFiles(galleryInput.files);
  galleryInput.value = '';
});

uploadBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) {
    setStatus('Add at least one photo before upload.', 'error');
    return;
  }

  uploadBtn.disabled = true;
  setStatus('Uploading...');

  try {
    const formData = new FormData();
    selectedFiles.forEach((file) => formData.append('photos', file, file.name));

    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) throw new Error(`Upload failed (${response.status})`);

    const uploadedCount = selectedFiles.length;
    selectedFiles = [];
    renderSelectedTray();
    updateSelectedCount();
    setStatus(`Uploaded ${uploadedCount} photo${uploadedCount > 1 ? 's' : ''}.`, 'success');
  } catch (error) {
    setStatus('Upload failed. Your selected files are still available.', 'error');
    uploadBtn.disabled = selectedFiles.length === 0;
  }
});

updateSelectedCount();
renderSelectedTray();
if (!hasEverSelectedFiles && selectedFiles.length === 0) {
  setStatus('No photos selected yet.');
}

// Retire the temporary app-shell worker so it cannot keep an older HTML/JS pair alive.
// Every operation is best-effort and deliberately isolated from application startup.
if ('serviceWorker' in navigator && typeof navigator.serviceWorker.getRegistrations === 'function') {
  navigator.serviceWorker.getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .catch(() => {});
}

if ('caches' in window) {
  window.caches.keys()
    .then((keys) => Promise.all(
      keys
        .filter((key) => key.startsWith('snapoverlan-shell-'))
        .map((key) => window.caches.delete(key)),
    ))
    .catch(() => {});
}
