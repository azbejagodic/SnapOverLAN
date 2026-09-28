const MAX_FILES = 10;
const FAST_UPLOAD_STORAGE_KEY = 'snapoverlan-fast-upload-v1';
const FAST_UPLOAD_MIN_BYTES = 1.5 * 1024 * 1024;
const FAST_UPLOAD_MAX_LONG_EDGE = 1920;
const FAST_UPLOAD_QUALITY = 0.82;
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
const fastUploadToggle = document.getElementById('fastUploadToggle');
const fastUploadState = document.getElementById('fastUploadState');
const inputButtons = document.querySelectorAll?.('.input-btn') || [];

const selectedGrid = document.getElementById('selectedGrid');
const selectedCount = document.getElementById('selectedCount');

// File inputs expose a transient, read-only FileList, so this array is the tray's source of truth.
let selectedFiles = [];
let isUploading = false;

function clearPressedInputButtons() {
  inputButtons.forEach((button) => button.classList.remove('is-pressed'));
}

inputButtons.forEach((button) => {
  button.addEventListener('pointerdown', (event) => {
    if (event.button === 0) button.classList.add('is-pressed');
  });
  for (const eventName of ['pointerup', 'pointercancel', 'pointerleave']) {
    button.addEventListener(eventName, () => button.classList.remove('is-pressed'));
  }
});

window.addEventListener?.('blur', clearPressedInputButtons);
window.addEventListener?.('focus', clearPressedInputButtons);

function readFastUploadPreference() {
  try {
    const savedValue = window.localStorage?.getItem(FAST_UPLOAD_STORAGE_KEY);
    if (savedValue === 'false') return false;
    if (savedValue === 'true') return true;
  } catch (error) {
    console.warn('Fast Upload preference could not be read; using the default.', error);
  }

  return true;
}

function writeFastUploadPreference(enabled) {
  try {
    window.localStorage?.setItem(FAST_UPLOAD_STORAGE_KEY, String(enabled));
  } catch (error) {
    console.warn('Fast Upload preference could not be saved.', error);
  }
}

function updateFastUploadControl(enabled) {
  fastUploadToggle.checked = enabled;
  fastUploadState.textContent = enabled ? 'On' : 'Off';
}

let fastUploadEnabled = readFastUploadPreference();
updateFastUploadControl(fastUploadEnabled);

function setStatus(message, kind = '') {
  statusEl.textContent = message;
  statusEl.className = kind ? kind : '';
}

function updateSelectedCount() {
  selectedCount.textContent = `Selected: ${selectedFiles.length} / ${MAX_FILES}`;
  uploadBtn.disabled = isUploading || selectedFiles.length === 0;
}

function isSupportedImage(file) {
  return ALLOWED_IMAGE_MIME_TYPES.has((file.type || '').toLowerCase());
}

function shouldOptimizeImage(file) {
  const type = (file.type || '').toLowerCase();
  return file.size > FAST_UPLOAD_MIN_BYTES && type !== 'image/png' && ALLOWED_IMAGE_MIME_TYPES.has(type);
}

function calculateOutputSize(width, height) {
  const scale = Math.min(1, FAST_UPLOAD_MAX_LONG_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        cleanup: () => bitmap.close?.(),
      };
    } catch (error) {
      // Some browsers expose createImageBitmap but cannot decode every accepted format.
    }
  }

  if (typeof Image !== 'function') throw new Error('No browser image decoder is available.');

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  const loaded = new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error(`The browser could not decode ${file.name || 'this image'}.`));
  });

  try {
    image.src = objectUrl;
    if (typeof image.decode === 'function') {
      try {
        await image.decode();
      } catch (error) {
        await loaded;
      }
    } else {
      await loaded;
    }

    return {
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      cleanup: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Canvas conversion returned no image data.'));
          return;
        }
        resolve(blob);
      }, type, FAST_UPLOAD_QUALITY);
    } catch (error) {
      reject(error);
    }
  });
}

function jpegFilename(filename) {
  const baseName = (filename || 'photo').replace(/\.[^./\\]+$/, '') || 'photo';
  return `${baseName}.jpg`;
}

async function optimizeImage(file) {
  const decoded = await decodeImage(file);
  const canvas = document.createElement('canvas');

  try {
    if (!Number.isFinite(decoded.width) || !Number.isFinite(decoded.height)
      || decoded.width <= 0 || decoded.height <= 0) {
      throw new Error('The decoded image has invalid dimensions.');
    }

    const outputSize = calculateOutputSize(decoded.width, decoded.height);
    canvas.width = outputSize.width;
    canvas.height = outputSize.height;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('A canvas drawing context is unavailable.');
    context.drawImage(decoded.image, 0, 0, outputSize.width, outputSize.height);

    const sourceType = (file.type || '').toLowerCase();
    const outputType = sourceType === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const blob = await canvasToBlob(canvas, outputType);
    if (blob.type !== outputType || blob.size >= file.size) return file;

    const outputName = outputType === 'image/jpeg' ? jpegFilename(file.name) : file.name;
    return new File([blob], outputName, {
      type: outputType,
      lastModified: file.lastModified,
    });
  } finally {
    decoded.cleanup();
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function optimizeImageWithFallback(file) {
  if (!shouldOptimizeImage(file)) return file;

  try {
    return await optimizeImage(file);
  } catch (error) {
    console.warn(`Fast Upload could not optimize "${file.name || 'photo'}"; uploading the original.`, error);
    return file;
  }
}

async function prepareUploadBatch(files) {
  const preparedFiles = [];
  for (const file of files) {
    // Sequential processing keeps peak memory bounded for a full 10-photo tray.
    preparedFiles.push(await optimizeImageWithFallback(file));
  }
  return preparedFiles;
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
  clearPressedInputButtons();
  appendFiles(cameraInput.files);
  cameraInput.value = '';
});

galleryInput.addEventListener('change', () => {
  clearPressedInputButtons();
  appendFiles(galleryInput.files);
  galleryInput.value = '';
});

fastUploadToggle.addEventListener('change', () => {
  fastUploadEnabled = fastUploadToggle.checked;
  updateFastUploadControl(fastUploadEnabled);
  writeFastUploadPreference(fastUploadEnabled);
});

async function getUploadErrorMessage(response) {
  let error;
  try {
    const body = await response.json();
    if (typeof body?.error === 'string') error = body.error;
  } catch {
    // An empty or non-JSON response still gets a safe status-based message.
  }

  if (response.status === 503) return 'SnapOverLAN is shutting down. Try again after reopening it.';
  if (response.status >= 500 && response.status < 600) return 'SnapOverLAN could not complete the upload. Try again.';
  if (response.status >= 400 && response.status < 500) {
    switch (error) {
      case 'Each image must be <= 20MB.':
      case 'Invalid image: Image is empty or exceeds the 20MB file limit.':
        return 'Each photo must be 20 MB or smaller.';
      case 'Maximum 10 files are allowed.':
        return 'You can upload up to 10 photos at a time.';
      case 'Only JPEG, PNG, WebP, HEIC, and HEIF images are allowed.':
        return 'Only JPEG, PNG, WebP, HEIC, and HEIF photos are supported.';
      case 'Invalid image: Image exceeds the 60 megapixel upload limit or has invalid dimensions.':
      case 'Invalid image: HEIF images exceed the 60 megapixel upload limit.':
      case 'Invalid image: Input image exceeds pixel limit':
        return 'One or more photos exceed the 60 MP upload limit.';
      case 'Invalid image: AVIF uploads are not supported.':
        return 'AVIF photos are not supported. Use JPEG, PNG, WebP, HEIC, or HEIF.';
      case 'Invalid image: Unsupported HEIF image compression.':
      case 'Invalid image: Invalid HEIF image count.':
      case 'Invalid image: Malformed HEIF image data.':
        return 'One or more HEIC/HEIF photos could not be read.';
      case 'Invalid image: Only valid JPEG, PNG, WebP, HEIC, and HEIF images are allowed.':
      case 'Invalid image: Invalid HEIF file type box.':
      case 'Invalid image: Image format does not match its content.':
      case 'Invalid image: Input buffer contains unsupported image format':
        return 'One or more selected files are not valid supported photos.';
    }
    // Recognize decoder diagnostics, but never show their variable details.
    if (typeof error === 'string') {
      if (/^Invalid image: (?:Input buffer has corrupt header: )?heif:/.test(error)) {
        return 'One or more HEIC/HEIF photos could not be read.';
      }
      if (/^Invalid image: (?:Input buffer has corrupt header: |VipsJpeg: |pngload(?:_buffer)?: |webpload(?:_buffer)?: )/.test(error)) {
        return 'One or more selected files are not valid supported photos.';
      }
    }
    return 'Upload rejected. Check the selected photos and try again.';
  }
  return 'Upload failed. Your selected files are still available.';
}

uploadBtn.addEventListener('click', async () => {
  if (selectedFiles.length === 0) {
    setStatus('Add at least one photo before upload.', 'error');
    return;
  }

  isUploading = true;
  updateSelectedCount();
  let failureMessage = 'Upload failed. Your selected files are still available.';

  try {
    const uploadFiles = selectedFiles.slice();
    let preparedFiles = uploadFiles;
    if (fastUploadEnabled && uploadFiles.some(shouldOptimizeImage)) {
      setStatus('Optimizing photos...');
      preparedFiles = await prepareUploadBatch(uploadFiles);
    }

    setStatus('Uploading...');
    const formData = new FormData();
    preparedFiles.forEach((file) => formData.append('photos', file, file.name));

    let response;
    try {
      response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
    } catch (error) {
      failureMessage = 'Upload interrupted. Check your Wi-Fi connection and try again.';
      throw error;
    }

    if (!response.ok) {
      failureMessage = await getUploadErrorMessage(response);
      throw new Error(`Upload failed (${response.status})`);
    }

    const uploadedCount = uploadFiles.length;
    selectedFiles = [];
    isUploading = false;
    renderSelectedTray();
    updateSelectedCount();
    setStatus(`Uploaded ${uploadedCount} photo${uploadedCount > 1 ? 's' : ''}.`, 'success');
  } catch (error) {
    isUploading = false;
    setStatus(failureMessage, 'error');
    updateSelectedCount();
  }
});

updateSelectedCount();
renderSelectedTray();
if (selectedFiles.length === 0) {
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
