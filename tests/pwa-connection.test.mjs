import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../pwa/app.js', import.meta.url), 'utf8');
const markup = await readFile(new URL('../pwa/index.html', import.meta.url), 'utf8');
const styles = await readFile(new URL('../pwa/styles.css', import.meta.url), 'utf8');
const extensionStyles = await readFile(new URL('../extension/styles.css', import.meta.url), 'utf8');
const electronStyles = await readFile(new URL('../app/renderer/styles.css', import.meta.url), 'utf8');
const interLicense = await readFile(new URL('../assets/fonts/Inter-OFL.txt', import.meta.url), 'utf8');
const fontAssets = await Promise.all([
  readFile(new URL('../app/renderer/fonts/inter-latin-variable.woff2', import.meta.url)),
  readFile(new URL('../extension/fonts/inter-latin-variable.woff2', import.meta.url)),
  readFile(new URL('../pwa/fonts/inter-latin-variable.woff2', import.meta.url)),
]);

class FakeElement {
  constructor() {
    this.listeners = new Map();
    this.className = '';
    this.disabled = false;
    this.files = [];
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.width = 0;
    this.height = 0;
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  async dispatch(type) {
    return this.listeners.get(type)?.({ type, target: this });
  }

  appendChild() {}
  setAttribute() {}
}

function createHarness(fetchImpl = async () => ({ ok: true }), options = {}) {
  const ids = [
    'cameraInput', 'galleryInput', 'uploadBtn', 'status',
    'selectedGrid', 'selectedCount', 'fastUploadToggle', 'fastUploadState',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const formDataEntries = [];
  const canvases = [];
  const storageWrites = [];
  const warnings = [];
  const localStorage = options.localStorage || {
    getItem: () => options.savedPreference ?? null,
    setItem: (key, value) => storageWrites.push([key, value]),
  };
  const document = {
    getElementById: (id) => elements[id] || null,
    createElement: (tagName) => {
      const element = new FakeElement();
      if (tagName === 'canvas') {
        element.getContext = () => ({
          drawImage: (...args) => { element.drawImageArgs = args; },
        });
        element.toBlob = (callback, type, quality) => {
          element.outputType = type;
          element.outputQuality = quality;
          if (options.canvasToBlob) {
            options.canvasToBlob({ callback, canvas: element, quality, type });
          } else {
            callback(new Blob(['optimized'], { type }));
          }
        };
        canvases.push(element);
      }
      return element;
    },
  };

  class FakeFile {
    constructor(parts, name, fileOptions = {}) {
      this.name = name;
      this.type = fileOptions.type || '';
      this.lastModified = fileOptions.lastModified;
      this.size = parts.reduce((total, part) => total + (part.size ?? String(part).length), 0);
    }
  }

  const window = { localStorage };
  const context = vm.createContext({
    Blob,
    File: FakeFile,
    FormData: class FakeFormData {
      append(...entry) { formDataEntries.push(entry); }
    },
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    console: { warn: (...args) => warnings.push(args) },
    document,
    fetch: fetchImpl,
    navigator: {},
    window,
  });
  if (options.createImageBitmap) context.createImageBitmap = options.createImageBitmap;

  vm.runInContext(source, context, { filename: 'pwa/app.js' });
  Object.assign(elements, { canvases, formDataEntries, storageWrites, warnings });
  return elements;
}

test('all runtime interfaces bundle and use the shared Inter typography', () => {
  for (const targetStyles of [electronStyles, extensionStyles, styles]) {
    assert.match(
      targetStyles,
      /@font-face\s*\{[\s\S]*?font-family:\s*"SnapOverLAN UI";[\s\S]*?src:\s*url\("\.\/fonts\/inter-latin-variable\.woff2"\)\s*format\("woff2"\);[\s\S]*?font-weight:\s*400 700;[\s\S]*?\}/,
    );
    assert.match(targetStyles, /--font-ui:\s*"SnapOverLAN UI", system-ui, sans-serif;/);
    assert.match(targetStyles, /--font-weight-regular:\s*400;/);
    assert.match(targetStyles, /--font-weight-body:\s*500;/);
    assert.match(targetStyles, /--font-weight-control:\s*600;/);
    assert.match(targetStyles, /--font-weight-heading:\s*700;/);
    assert.match(targetStyles, /-webkit-font-smoothing: antialiased;/);
    assert.match(targetStyles, /-moz-osx-font-smoothing: grayscale;/);
    assert.match(
      targetStyles,
      /button,\s*input,\s*select,\s*textarea\s*\{[\s\S]*?font-family:\s*inherit;/,
    );
    assert.match(
      targetStyles,
      /body\s*\{[\s\S]*?font-family:\s*var\(--font-ui\);[\s\S]*?font-weight:\s*var\(--font-weight-body\);/,
    );
    assert.match(targetStyles, /font-synthesis:\s*none;/);
    assert.doesNotMatch(targetStyles, /font-family:\s*"Segoe UI"/);
    assert.doesNotMatch(targetStyles, /https?:\/\/[^;)]+\.(?:woff2?|ttf|otf)/i);
    assert.doesNotMatch(targetStyles, /font-size:\s*[^;]*rem/);
    assert.doesNotMatch(targetStyles, /letter-spacing:/);
  }

  assert.ok(fontAssets.every((asset) => asset.length > 0));
  assert.ok(fontAssets.slice(1).every((asset) => asset.equals(fontAssets[0])));
  assert.match(interLicense, /SIL OPEN FONT LICENSE Version 1\.1/);
});

test('restored PWA shell has no connection-status UI or styling', () => {
  assert.doesNotMatch(markup, /connectionStatus|connectionMessage|retryConnectionBtn/);
  assert.doesNotMatch(styles, /connection-status|retry-connection/);
  assert.doesNotMatch(source, /connecting|connected|disconnected|addEventListener\('online'|addEventListener\('offline'/);
});

test('Fast Upload control is compact, accessible, and enabled by default', () => {
  assert.match(markup, /id="fastUploadToggle"[^>]*type="checkbox"[^>]*role="switch"/);
  assert.match(markup, />Fast upload</);
  assert.match(markup, />Resize large photos for faster transfer</);
  assert.match(styles, /\.fast-upload\s*\{[\s\S]*?min-height:\s*52px;/);

  const elements = createHarness();
  assert.equal(elements.fastUploadToggle.checked, true);
  assert.equal(elements.fastUploadState.textContent, 'On');
  assert.deepEqual(elements.storageWrites, []);
});

test('Fast Upload restores both saved states and persists toggle changes', async () => {
  const disabled = createHarness(undefined, { savedPreference: 'false' });
  assert.equal(disabled.fastUploadToggle.checked, false);
  assert.equal(disabled.fastUploadState.textContent, 'Off');

  disabled.fastUploadToggle.checked = true;
  await disabled.fastUploadToggle.dispatch('change');
  assert.equal(disabled.fastUploadState.textContent, 'On');
  assert.deepEqual(disabled.storageWrites, [['snapoverlan-fast-upload-v1', 'true']]);

  const enabled = createHarness(undefined, { savedPreference: 'true' });
  assert.equal(enabled.fastUploadToggle.checked, true);
  enabled.fastUploadToggle.checked = false;
  await enabled.fastUploadToggle.dispatch('change');
  assert.deepEqual(enabled.storageWrites, [['snapoverlan-fast-upload-v1', 'false']]);
});

test('Fast Upload preference failures fall back to enabled without blocking startup', () => {
  const localStorage = {
    getItem: () => { throw new Error('storage unavailable'); },
    setItem: () => { throw new Error('storage unavailable'); },
  };
  const elements = createHarness(undefined, { localStorage });
  assert.equal(elements.fastUploadToggle.checked, true);
  assert.equal(elements.status.textContent, 'No photos selected yet.');
  assert.equal(elements.warnings.length, 1);
});

test('phone interface exposes only approved photo inputs and rejects video selections', async () => {
  const supportedTypes = 'image/jpeg,image/png,image/webp,image/heic,image/heif';
  assert.doesNotMatch(markup, /videoInput|Record video|video\//i);
  assert.doesNotMatch(
    source,
    /isVideoFile|normalizeRecordedVideo|videoInput|video\/(?:mp4|quicktime|webm)|\.(?:mp4|mov|webm)/i,
  );
  assert.doesNotMatch(styles, /\.video-/i);
  assert.match(markup, new RegExp(`id="cameraInput"[^>]*accept="${supportedTypes}"`));
  assert.match(markup, new RegExp(`id="galleryInput"[^>]*accept="${supportedTypes}"`));

  const elements = createHarness();
  elements.galleryInput.files = [{ name: 'clip.mp4', type: 'video/mp4', size: 10 }];
  await elements.galleryInput.dispatch('change');
  assert.equal(elements.uploadBtn.disabled, true);
  assert.match(elements.status.textContent, /Only JPEG, PNG, WebP, HEIC, and HEIF photos/);

  elements.galleryInput.files = [{ name: 'photo.heic', type: 'image/heic', size: 10 }];
  await elements.galleryInput.dispatch('change');
  assert.equal(elements.uploadBtn.disabled, false);
  assert.equal(elements.selectedCount.textContent, 'Selected: 1 / 10');
});

test('phone selection tray keeps only the first 10 photos', async () => {
  const elements = createHarness();
  elements.galleryInput.files = Array.from({ length: 11 }, (_, index) => ({
    name: `photo-${index + 1}.jpg`,
    type: 'image/jpeg',
    size: 10,
  }));

  await elements.galleryInput.dispatch('change');
  assert.equal(elements.selectedCount.textContent, 'Selected: 10 / 10');
  assert.match(elements.status.textContent, /Tray limit is 10, extra photos were skipped/);
});

test('disabling Fast Upload appends the original selected file untouched', async () => {
  let decodeCount = 0;
  const elements = createHarness(undefined, {
    savedPreference: 'false',
    createImageBitmap: async () => {
      decodeCount += 1;
      throw new Error('should not decode');
    },
  });
  const original = { name: 'large.jpg', type: 'image/jpeg', size: 5_000_000, lastModified: 123 };
  elements.galleryInput.files = [original];

  await elements.galleryInput.dispatch('change');
  await elements.uploadBtn.dispatch('click');

  assert.equal(decodeCount, 0);
  assert.strictEqual(elements.formDataEntries[0][1], original);
  assert.equal(elements.formDataEntries[0][2], 'large.jpg');
});

test('small photos bypass decoding and recompression when Fast Upload is enabled', async () => {
  let decodeCount = 0;
  const elements = createHarness(undefined, {
    createImageBitmap: async () => {
      decodeCount += 1;
      throw new Error('should not decode');
    },
  });
  const original = { name: 'small.jpg', type: 'image/jpeg', size: 1.5 * 1024 * 1024 };
  elements.galleryInput.files = [original];

  await elements.galleryInput.dispatch('change');
  await elements.uploadBtn.dispatch('click');

  assert.equal(decodeCount, 0);
  assert.strictEqual(elements.formDataEntries[0][1], original);
});

test('large PNG photos remain lossless and bypass Fast Upload decoding', async () => {
  let decodeCount = 0;
  const elements = createHarness(undefined, {
    createImageBitmap: async () => {
      decodeCount += 1;
      throw new Error('should not decode');
    },
  });
  const original = { name: 'screenshot.png', type: 'image/png', size: 7_000_000 };
  elements.galleryInput.files = [original];

  await elements.galleryInput.dispatch('change');
  await elements.uploadBtn.dispatch('click');

  assert.equal(decodeCount, 0);
  assert.strictEqual(elements.formDataEntries[0][1], original);
});

test('a large JPEG is resized to 1920px and uploaded as a correctly named JPEG', async () => {
  let bitmapClosed = false;
  let bitmapOptions;
  const bitmap = { width: 4032, height: 3024, close: () => { bitmapClosed = true; } };
  const elements = createHarness(undefined, {
    createImageBitmap: async (file, options) => {
      bitmapOptions = options;
      return bitmap;
    },
  });
  const original = {
    name: 'IMG_4521.JPEG', type: 'image/jpeg', size: 8_000_000, lastModified: 456,
  };
  elements.galleryInput.files = [original];

  await elements.galleryInput.dispatch('change');
  await elements.uploadBtn.dispatch('click');

  const optimized = elements.formDataEntries[0][1];
  assert.notStrictEqual(optimized, original);
  assert.equal(optimized.type, 'image/jpeg');
  assert.equal(optimized.name, 'IMG_4521.jpg');
  assert.equal(optimized.lastModified, 456);
  assert.equal(elements.formDataEntries[0][2], 'IMG_4521.jpg');
  assert.equal(elements.canvases[0].outputQuality, 0.82);
  assert.equal(elements.canvases[0].drawImageArgs[3], 1920);
  assert.equal(elements.canvases[0].drawImageArgs[4], 1440);
  assert.equal(bitmapOptions.imageOrientation, 'from-image');
  assert.equal(bitmapClosed, true);
});

test('a decodable HEIC is converted to JPEG with a matching .jpg filename', async () => {
  const elements = createHarness(undefined, {
    createImageBitmap: async () => ({ width: 3024, height: 4032, close() {} }),
  });
  const original = { name: 'IMG_9876.HEIC', type: 'image/heic', size: 9_000_000 };
  elements.galleryInput.files = [original];

  await elements.galleryInput.dispatch('change');
  await elements.uploadBtn.dispatch('click');

  const optimized = elements.formDataEntries[0][1];
  assert.equal(optimized.type, 'image/jpeg');
  assert.equal(optimized.name, 'IMG_9876.jpg');
  assert.equal(elements.formDataEntries[0][2], 'IMG_9876.jpg');
});

test('a compression failure falls back to the original and continues the batch', async () => {
  const elements = createHarness(undefined, {
    createImageBitmap: async (file) => {
      if (file.name === 'broken.jpg') throw new Error('corrupt image');
      return { width: 2400, height: 1200, close() {} };
    },
  });
  const broken = { name: 'broken.jpg', type: 'image/jpeg', size: 4_000_000 };
  const valid = { name: 'valid.jpg', type: 'image/jpeg', size: 4_000_000 };
  elements.galleryInput.files = [broken, valid];

  await elements.galleryInput.dispatch('change');
  await elements.uploadBtn.dispatch('click');

  assert.equal(elements.formDataEntries.length, 2);
  assert.strictEqual(elements.formDataEntries[0][1], broken);
  assert.notStrictEqual(elements.formDataEntries[1][1], valid);
  assert.equal(elements.warnings.length, 1);
  assert.match(elements.warnings[0][0], /broken\.jpg/);
  assert.equal(elements.status.textContent, 'Uploaded 2 photos.');
});

test('unsupported HEIC decoding falls back to the original without blocking upload', async () => {
  const elements = createHarness(undefined, {
    createImageBitmap: async () => { throw new Error('HEIC unsupported'); },
  });
  const original = { name: 'camera.heif', type: 'image/heif', size: 6_000_000 };
  elements.galleryInput.files = [original];

  await elements.galleryInput.dispatch('change');
  await elements.uploadBtn.dispatch('click');

  assert.strictEqual(elements.formDataEntries[0][1], original);
  assert.equal(elements.status.textContent, 'Uploaded 1 photo.');
  assert.equal(elements.warnings.length, 1);
});

test('application mounts without making a startup server request', () => {
  let fetchCount = 0;
  const elements = createHarness(async () => {
    fetchCount += 1;
    throw new TypeError('server unavailable');
  });

  assert.equal(fetchCount, 0);
  assert.equal(elements.status.textContent, 'No photos selected yet.');
  assert.equal(elements.uploadBtn.disabled, true);
});

test('an upload network failure is caught and keeps the selected file available', async () => {
  const elements = createHarness(async () => {
    throw new TypeError('server unavailable');
  });

  elements.galleryInput.files = [{ name: 'photo.jpg', type: 'image/jpeg', size: 10 }];
  await elements.galleryInput.dispatch('change');
  assert.equal(elements.uploadBtn.disabled, false);

  await elements.uploadBtn.dispatch('click');
  assert.equal(elements.status.textContent, 'Upload failed. Your selected files are still available.');
  assert.equal(elements.status.className, 'error');
  assert.equal(elements.selectedCount.textContent, 'Selected: 1 / 10');
  assert.equal(elements.uploadBtn.disabled, false);
});

test('legacy app-shell worker and cache cleanup cannot block startup', async () => {
  const unregister = async () => { throw new Error('already gone'); };
  const contextSource = source;
  const ids = [
    'cameraInput', 'galleryInput', 'uploadBtn', 'status',
    'selectedGrid', 'selectedCount', 'fastUploadToggle', 'fastUploadState',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const context = vm.createContext({
    File: class FakeFile {},
    FormData: class FakeFormData { append() {} },
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: () => new FakeElement(),
    },
    fetch: async () => ({ ok: true }),
    navigator: { serviceWorker: { getRegistrations: async () => [{ unregister }] } },
    window: {
      localStorage: { getItem: () => null, setItem: () => {} },
      caches: { keys: async () => ['snapoverlan-shell-v1'], delete: async () => true },
    },
  });

  assert.doesNotThrow(() => vm.runInContext(contextSource, context, { filename: 'pwa/app.js' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(elements.status.textContent, 'No photos selected yet.');
});
