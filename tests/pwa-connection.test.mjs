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

function createHarness(fetchImpl = async () => ({ ok: true })) {
  const ids = [
    'cameraInput', 'galleryInput', 'uploadBtn', 'status',
    'selectedGrid', 'selectedCount',
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const document = {
    getElementById: (id) => elements[id] || null,
    createElement: () => new FakeElement(),
  };
  const context = vm.createContext({
    File: class FakeFile {},
    FormData: class FakeFormData { append() {} },
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    document,
    fetch: fetchImpl,
    navigator: {},
    window: {},
  });

  vm.runInContext(source, context, { filename: 'pwa/app.js' });
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
  assert.equal(elements.selectedCount.textContent, 'Selected: 1 / 20');
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
  assert.equal(elements.selectedCount.textContent, 'Selected: 1 / 20');
  assert.equal(elements.uploadBtn.disabled, false);
});

test('legacy app-shell worker and cache cleanup cannot block startup', async () => {
  const unregister = async () => { throw new Error('already gone'); };
  const contextSource = source;
  const ids = [
    'cameraInput', 'galleryInput', 'uploadBtn', 'status',
    'selectedGrid', 'selectedCount',
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
    window: { caches: { keys: async () => ['snapoverlan-shell-v1'], delete: async () => true } },
  });

  assert.doesNotThrow(() => vm.runInContext(contextSource, context, { filename: 'pwa/app.js' }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(elements.status.textContent, 'No photos selected yet.');
});
