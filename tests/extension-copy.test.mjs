import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../extension/popup.js', import.meta.url), 'utf8');
const imageUrl = 'http://localhost:8787/files/photo.jpg';
const warning = 'This photo is too large to copy from the extension. Tap Open to view it in a tab.';

class Element {
  children = [];
  _textContent = '';
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = value; this.children = []; }
  get childNodes() { return this.children; }
  listeners = new Map();
  disabled = false;
  addEventListener(event, listener) { this.listeners.set(event, listener); }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  click() { return this.listeners.get('click')(); }
  setAttribute() {}
}

function createHarness({ width = 4000, height = 3000, fail, fetchImpl, permissionDenied = false } = {}) {
  const events = [];
  const writes = [];
  const opened = [];
  const errors = [];
  const elements = Object.fromEntries(['autoCopyToggleBtn', 'refreshBtn', 'status', 'grid']
    .map((id) => [id, new Element()]));
  const input = new Blob(['source image'], { type: fail === 'type' ? 'text/html' : 'image/jpeg' });
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
  const popup = runInNewContext(`${source}\n({ makeCard, refresh, syncAutoCopySetting })`, {
    URL,
    console: { log() {}, error: (...args) => errors.push(args) },
    document: {
      getElementById: (id) => elements[id],
      addEventListener() {},
      createDocumentFragment: () => new Element(),
      createElement(tag) {
        if (tag !== 'canvas') return new Element();
        events.push('canvas');
        if (fail === 'canvas') throw new Error('canvas failed');
        return canvas;
      },
    },
    window: { addEventListener() {} },
    chrome: {
      tabs: { create: async ({ url }) => opened.push(url) },
      permissions: { contains: async () => !permissionDenied, request: async () => false },
    },
    fetch: async (url, options) => {
      if (fetchImpl) return fetchImpl(url, options);
      if (url.endsWith('/api/latest')) return { ok: true, json: async () => ({ files: [{ name: 'photo.jpg' }] }) };
      if (url.endsWith('/api/auto-copy')) return { ok: true, json: async () => ({ enabled: false }) };
      events.push('fetch');
      assert.equal(url, imageUrl);
      if (fail === 'network') throw new Error('raw network failure');
      return { ok: fail !== 'http', status: fail === 'http' ? 404 : 200, blob: async () => {
        if (fail === 'blob') throw new Error('raw blob failure');
        return input;
      } };
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
  return { events, writes, opened, canvas, png, card, copy, open, popup, errors,
    status: elements.status, refresh: elements.refreshBtn, toggle: elements.autoCopyToggleBtn };
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
      ? "Couldn't copy to the clipboard. Check your browser permissions and try again."
      : "Couldn't convert this photo for copying. Tap Open to view it instead.");
    assert.equal(h.copy.disabled, false);
  });
}

test('decode failure retains the existing error without creating canvas or writing clipboard', async () => {
  const h = createHarness({ fail: 'decode' });
  await h.copy.click();
  assert.deepEqual(h.events, ['fetch', 'decode']);
  assert.equal(h.writes.length, 0);
  assert.equal(h.status.textContent, "Couldn't convert this photo for copying. Tap Open to view it instead.");
  assert.equal(h.status.className, 'error');
  assert.equal(h.copy.disabled, false);
});

for (const [fail, message] of [
  ['network', "Couldn't load this photo. Make sure SnapOverLAN is open, then try again."],
  ['http', "Couldn't get this photo from SnapOverLAN. Tap Refresh and try again."],
  ['type', "Couldn't copy this file because it wasn't received as an image. Try Open instead."],
  ['blob', "Couldn't copy this photo. Try Open instead."],
]) {
  test(`${fail} copy failure shows safe guidance and keeps Open available`, async () => {
    const h = createHarness({ fail });
    await h.copy.click();
    assert.equal(h.status.textContent, message);
    assert.equal(h.status.className, 'error');
    assert.equal(h.copy.disabled, false);
    assert.equal(h.open.textContent, 'Open');
    await h.open.click();
    assert.deepEqual(h.opened, [imageUrl]);
    assert.ok(h.errors.length);
  });
}

for (const method of ['GET', 'PUT']) {
  for (const body of [{ error: 'Internal exception C:/private/settings.json' }, null]) {
    test(`Auto-copy ${method} HTTP failure uses operation-specific wording and logs diagnostics`, async () => {
      let failing = false;
      const h = createHarness({ fetchImpl: async (_url, options) => {
        assert.equal(options.method, failing ? method : 'GET');
        return failing ? { ok: false, status: 500, json: async () => body }
          : { ok: true, json: async () => ({ enabled: false }) };
      } });
      await h.popup.syncAutoCopySetting();
      failing = true;
      if (method === 'GET') await h.popup.syncAutoCopySetting();
      else await h.toggle.click();
      assert.equal(h.status.textContent, method === 'GET'
        ? "Couldn't read Auto-copy settings. Try again."
        : "Couldn't change Auto-copy. Try again.");
      assert.equal(h.status.className, 'error');
      assert.match(h.errors.at(-1)[1].message, body ? /Internal exception/ : /Server returned 500/);
      assert.equal(h.toggle.disabled, false);
    });
  }
}

for (const method of ['GET', 'PUT']) {
  test(`Auto-copy ${method} invalid successful response uses operation-specific wording and logs the technical error`, async () => {
    let invalid = false;
    const h = createHarness({ fetchImpl: async (_url, options) => {
      assert.equal(options.method, invalid ? method : 'GET');
      return { ok: true, status: 200, json: async () => ({ enabled: invalid ? 'bad' : false }) };
    } });
    await h.popup.syncAutoCopySetting();
    invalid = true;
    if (method === 'GET') await h.popup.syncAutoCopySetting();
    else await h.toggle.click();
    assert.equal(h.status.textContent, method === 'GET'
      ? "Couldn't read the Auto-copy setting. Try again."
      : "Couldn't change Auto-copy. Try again.");
    assert.equal(h.status.className, 'error');
    assert.equal(h.errors.at(-1)[0], method === 'GET' ? '[popup] auto-copy read failed' : '[popup] auto-copy update failed');
    assert.equal(h.errors.at(-1)[1].message, 'Invalid auto-copy response from the desktop app.');
    assert.equal(h.toggle.textContent, 'Auto-copy: Off');
    assert.equal(h.toggle.disabled, false);
  });
}

test('Auto-copy connection and invalid-response errors show safe guidance', async () => {
  for (const [fetchImpl, message] of [
    [async () => { throw new Error('raw network failure'); }, "Couldn't reach SnapOverLAN. Make sure the desktop app is open, then try again."],
    [async () => ({ ok: true, json: async () => ({ enabled: 'bad' }) }), "Couldn't read the Auto-copy setting. Try again."],
  ]) {
    const h = createHarness({ fetchImpl });
    await h.popup.syncAutoCopySetting();
    assert.equal(h.status.textContent, message);
    assert.equal(h.status.className, 'error');
    assert.ok(h.errors.length);
    assert.equal(h.toggle.disabled, true);
  }
});

test('permission denial has actionable guidance in refresh and Auto-copy contexts', async () => {
  const h = createHarness({ permissionDenied: true });
  for (const action of [() => h.popup.refresh(), () => h.popup.syncAutoCopySetting()]) {
    await action();
    assert.equal(h.status.textContent, 'Browser access to SnapOverLAN was denied. Allow access in your extension permissions, then try again.');
    assert.equal(h.status.className, 'error');
  }
  assert.match(h.errors.at(-1)[1].message, /Host permission denied for http:\/\/localhost:8787\/\*/);
});

test('invalid image entries and refresh failures use the approved messages', async () => {
  for (const [fetchImpl, message] of [
    [async () => ({ ok: true, json: async () => ({ files: [{}] }) }), "Couldn't display the received photos. Try Refresh."],
    [async () => { throw new Error('raw network failure'); }, "Couldn't load photos. Make sure SnapOverLAN is open on your PC, then tap Refresh."],
  ]) {
    const h = createHarness({ fetchImpl });
    await h.popup.refresh();
    assert.equal(h.status.textContent, message);
    assert.equal(h.status.className, 'error');
    assert.ok(h.errors.length);
  }
  const markup = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  assert.match(markup, /id="refreshBtn"[^>]*>Refresh</);
});

test('background refresh and successful settings reads preserve a displayed copy error until explicit Refresh', async () => {
  const h = createHarness({ fail: 'clipboard' });
  await h.popup.refresh();
  await h.copy.click();
  const message = h.status.textContent;
  await h.popup.refresh(); // Same image signature.
  await h.popup.refresh({ force: true }); // Focus refresh rebuilds the cards.
  await h.popup.syncAutoCopySetting();
  assert.equal(h.status.textContent, message);
  assert.equal(h.status.className, 'error');
  await h.refresh.click();
  assert.equal(h.status.textContent, '');
  assert.equal(h.status.className, 'muted');
});

test('successful Auto-copy read after a manual refresh failure cannot erase that failure', async () => {
  const h = createHarness({ fetchImpl: async (url) => {
    if (url.endsWith('/api/latest')) throw new Error('raw refresh failure');
    return { ok: true, json: async () => ({ enabled: false }) };
  } });
  await h.refresh.click();
  assert.equal(h.status.textContent, "Couldn't load photos. Make sure SnapOverLAN is open on your PC, then tap Refresh.");
  assert.equal(h.status.className, 'error');
});
