import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
const imageUrl = 'http://localhost:8787/files/photo.jpg';
const warning = 'Image is too large to copy. Use Open or Download instead.';

class Element {
  children = [];
  listeners = new Map();
  disabled = false;
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  click() { return this.listeners.get('click')(); }
}

function createHarness({ width = 4000, height = 3000, fail } = {}) {
  const events = [];
  const writes = [];
  const opened = [];
  const elements = Object.fromEntries(['autoCopyToggleBtn', 'refreshBtn', 'status', 'grid']
    .map((id) => [id, new Element()]));
  const input = new Blob(['source image'], { type: 'image/jpeg' });
  const png = new Blob(['converted image'], { type: 'image/png' });
  const bitmap = { width, height, close: () => events.push('close') };
  const canvas = {
    getContext(type) {
      assert.equal(type, '2d');
      if (fail === 'context') return null;
      return { drawImage(image, x, y) {
        events.push('draw');
        assert.equal(image, bitmap);
        assert.equal(x, 0);
        assert.equal(y, 0);
        if (fail === 'draw') throw new Error('draw failed');
      } };
    },
    toBlob(callback, type) {
      events.push('png');
      assert.equal(type, 'image/png');
      callback(fail === 'png' ? null : png);
    },
  };
  const popup = runInNewContext(`${source}\n({ makeCard })`, {
    URL,
    console: { log() {}, error() {} },
    document: {
      getElementById: (id) => elements[id],
      addEventListener() {},
      createElement(tag) {
        if (tag !== 'canvas') return new Element();
        events.push('canvas');
        if (fail === 'canvas') throw new Error('canvas failed');
        return canvas;
      },
    },
    window: { addEventListener() {} },
    chrome: { tabs: { create: async ({ url }) => opened.push(url) } },
    fetch: async (url) => {
      events.push('fetch');
      assert.equal(url, imageUrl);
      return { ok: true, status: 200, blob: async () => input };
    },
    createImageBitmap: async (blob) => {
      events.push('decode');
      assert.equal(blob, input);
      if (fail === 'decode') throw new Error('decode failed');
      return bitmap;
    },
    ClipboardItem: class {
      constructor(data) { this.data = data; }
    },
    navigator: { clipboard: { write: async (items) => {
      events.push('clipboard');
      writes.push(items);
      if (fail === 'clipboard') throw new Error('permission denied');
    } } },
  });
  const card = popup.makeCard('http://localhost:8787', { name: 'photo.jpg', url: '/files/photo.jpg' });
  const [copy, open] = card.children[2].children;
  return { events, writes, opened, canvas, png, card, copy, open, status: elements.status };
}

for (const [label, width, height] of [['12 MP', 4000, 3000], ['exactly 40 MP', 8000, 5000]]) {
  test(`${label} Copy converts at original dimensions and writes PNG`, async () => {
    const h = createHarness({ width, height });
    await h.copy.click();
    assert.deepEqual(h.events, ['fetch', 'decode', 'canvas', 'draw', 'png', 'close', 'clipboard']);
    assert.equal(h.canvas.width, width);
    assert.equal(h.canvas.height, height);
    assert.equal(h.writes.length, 1);
    assert.equal(h.writes[0][0].data['image/png'], h.png);
    assert.equal(h.status.textContent, 'Copied as PNG');
    assert.equal(h.status.className, 'ok');
    assert.equal(h.copy.disabled, false);
  });
}

for (const [width, height] of [[8000, 5001], [1, 40_000_001]]) {
  test(`${width} x ${height} Copy warns, releases the bitmap, and skips canvas and clipboard`, async () => {
    const h = createHarness({ width, height });
    await h.copy.click();
    assert.deepEqual(h.events, ['fetch', 'decode', 'close']);
    assert.equal(h.writes.length, 0);
    assert.equal(h.status.textContent, warning);
    assert.equal(h.status.className, 'error');
    assert.equal(h.copy.disabled, false);
  });
}

test('over-limit image stays visible and Open works before and after blocked Copy', async () => {
  const h = createHarness({ width: 9000, height: 5000 });
  const image = h.card.children[0].children[0];
  assert.equal(image.src, imageUrl);
  assert.equal(image.alt, 'photo.jpg');
  await h.open.click();
  assert.deepEqual(h.events, []);
  await h.copy.click();
  await h.open.click();
  assert.deepEqual(h.opened, [imageUrl, imageUrl]);
  assert.equal(image.src, imageUrl);
  assert.equal(h.open.disabled, false);
  assert.deepEqual(h.events, ['fetch', 'decode', 'close']);
});

for (const fail of ['canvas', 'context', 'draw', 'png', 'clipboard']) {
  test(`${fail} failure still releases the decoded bitmap exactly once`, async () => {
    const h = createHarness({ fail });
    await h.copy.click();
    assert.equal(h.events.filter((event) => event === 'close').length, 1);
    assert.equal(h.writes.length, fail === 'clipboard' ? 1 : 0);
    assert.equal(h.status.className, 'error');
    assert.equal(h.status.textContent, fail === 'clipboard'
      ? 'Clipboard write denied: permission denied'
      : 'Copy blocked. Use Open then Ctrl+C.');
    assert.equal(h.copy.disabled, false);
  });
}

test('decode failure retains the existing error without creating canvas or writing clipboard', async () => {
  const h = createHarness({ fail: 'decode' });
  await h.copy.click();
  assert.deepEqual(h.events, ['fetch', 'decode']);
  assert.equal(h.writes.length, 0);
  assert.equal(h.status.textContent, 'Copy blocked. Use Open then Ctrl+C.');
  assert.equal(h.status.className, 'error');
  assert.equal(h.copy.disabled, false);
});
