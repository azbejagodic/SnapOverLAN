import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = (await readFile(new URL('../app/renderer/batch-history.js', import.meta.url), 'utf8'))
  .replace(/^export.*;\r?\n/gm, '');

class Element {
  children = [];
  listeners = new Map();
  disabled = false;
  _textContent = '';
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = value; this.children = []; }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  click() { return this.listeners.get('click')?.(); }
}

function createHarness() {
  const list = new Element();
  const clear = new Element();
  const download = new Element();
  const logs = [];
  const calls = [];
  const confirmations = [];
  let message = '';
  let failure;
  let failedOperation;
  const batch = { id: 'batch_test', current: true, fileCount: 1, createdAt: '2026-10-09', totalSize: 10 };
  const context = {
    console: { error: (...args) => logs.push(args) },
    document: { createElement: () => new Element(), createDocumentFragment: () => new Element() },
    window: {
      confirm: (text) => { confirmations.push(text); return true; },
      snapOverLAN: { downloadBatch: async (id) => {
        calls.push(['download', id]);
        if (failedOperation === 'download') throw failure;
      } },
    },
  };
  const { createBatchHistory } = runInNewContext(`${source}\n({ createBatchHistory })`, context);
  const history = createBatchHistory({
    batchesList: list, clearButton: clear, downloadButton: download,
    formatBytes: () => '10 B',
    setMessage: (text) => { message = text; },
    clearMessage: () => { message = ''; },
    fetchJson: async (path, { method = 'GET' } = {}) => {
      calls.push([path, method]);
      const operation = method === 'GET' ? 'load' : method === 'POST' ? 'select'
        : path === '/api/batches' ? 'clear' : 'delete';
      if (failedOperation === operation) throw failure;
      return { batches: [batch] };
    },
  });
  history.bind();
  history.setAvailable(true);
  return {
    history, logs, calls, confirmations, context, download,
    message: () => message,
    fail: (operation, error) => { failedOperation = operation; failure = error; },
    act: async (operation) => {
      if (operation === 'load') return history.load();
      if (operation === 'download') return download.click();
      if (operation === 'clear') return clear.click();
      return list.children[0].children[0].children[1].children[operation === 'select' ? 0 : 1].click();
    },
  };
}

for (const [operation, expected] of [
  ['load', "Couldn't load saved uploads. Try Refresh."],
  ['select', "Couldn't select this upload. Try again."],
  ['delete', "Couldn't delete this upload. Try again."],
  ['clear', "Couldn't clear saved uploads. Try again."],
  ['download', "Couldn't download the selected upload. Try again."],
]) {
  test(`${operation} displays a safe fallback and keeps the technical error in logs`, async () => {
    const h = createHarness();
    await h.history.load();
    const error = new Error('EACCES C:/private/photos\n at internal function');
    h.fail(operation, error);
    await h.act(operation);
    assert.equal(h.message(), expected);
    assert.equal(h.logs.at(-1)[1], error);
    if (operation === 'download') {
      assert.equal(h.download.disabled, false);
      assert.equal(h.download.textContent, 'Download');
    }
    if (operation === 'clear') assert.equal(h.confirmations[0], 'Clear all saved batches? This cannot be undone.');
    if (operation === 'delete') assert.match(h.confirmations[0], /^Delete the batch from .+\?$/);
  });
}

for (const [technical, expected] of [
  ['Desktop download is unavailable.', "Downloading isn't available right now. Restart SnapOverLAN and try again."],
  ['Download failed (404).', "Couldn't download a photo from this upload. Try again."],
  ['Invalid batch id.', "Couldn't find this upload. Refresh and try again."],
  ['Invalid batch filename.', "Couldn't find a valid file in this upload."],
  ['A destination folder is required.', "Couldn't find a destination for these photos. Check your Downloads folder and try again."],
  ['The selected batch has no files.', 'This upload has no photos to download.'],
  ['Batch not found.', 'This upload is no longer available. Refresh the list.'],
  ['No current batch.', 'There is no current upload to download.'],
  ['Invalid filename.', "A file in this upload couldn't be accessed."],
  ['Invalid batch path.', "This saved upload couldn't be accessed. Try again."],
  ['Storage request failed.', "Couldn't access saved uploads right now. Try again."],
  ['Download timed out. Please try again.', 'Download timed out. Please try again.'],
]) {
  test(`download maps ${technical} at the UI boundary, including Electron IPC wrapping`, async () => {
    for (const message of [technical, `Error invoking remote method 'batch:download': Error: ${technical}`]) {
      const h = createHarness();
      await h.history.load();
      const error = new Error(message);
      h.fail('download', error);
      await h.act('download');
      assert.equal(h.message(), expected);
      assert.equal(h.logs.at(-1)[1], error);
    }
  });
}

test('missing desktop download bridge uses restart guidance', async () => {
  const h = createHarness();
  await h.history.load();
  h.context.window.snapOverLAN = {};
  await h.act('download');
  assert.equal(h.message(), "Downloading isn't available right now. Restart SnapOverLAN and try again.");
});

test('storage errors crossing server IPC are mapped without leaking the wrapper', async () => {
  const h = createHarness();
  h.fail('load', new Error("Error invoking remote method 'server:request': Error: Storage request failed."));
  await h.act('load');
  assert.equal(h.message(), "Couldn't access saved uploads right now. Try again.");
});

test('a list reload failure after an action remains visible; a successful retry clears it', async () => {
  const h = createHarness();
  await h.history.load();
  h.fail('load', new Error('raw load failure'));
  await h.act('select');
  assert.equal(h.message(), "Couldn't load saved uploads. Try Refresh.");
  h.fail(null);
  await h.act('select');
  assert.equal(h.message(), '');
});

test('unexpected technical text containing a recognized message still uses a safe fallback', async () => {
  const h = createHarness();
  await h.history.load();
  h.fail('download', new Error('Internal exception: Invalid batch id. C:/private/file'));
  await h.act('download');
  assert.equal(h.message(), "Couldn't download the selected upload. Try again.");
});
