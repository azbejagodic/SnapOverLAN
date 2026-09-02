import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INSTALL_ERROR_DIALOG_OPTIONS,
  READY_DIALOG_OPTIONS,
  createUpdateDialogController,
} from '../app/desktop/update-dialog-controller.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const downloadedState = (version = '2.0.1') => ({
  status: 'downloaded',
  version,
});

class FakeDialog {
  constructor(responses = [0]) {
    this.calls = [];
    this.responses = [...responses];
    this.implementation = null;
  }

  showMessageBox(...args) {
    this.calls.push(args);
    if (this.implementation) return this.implementation(...args);
    return Promise.resolve({ response: this.responses.shift() ?? 0 });
  }
}

test('a downloaded update shows the exact native ready dialog with a visible owner', async () => {
  const dialog = new FakeDialog();
  const owner = {
    isDestroyed: () => false,
    isVisible: () => true,
  };
  const controller = createUpdateDialogController({
    dialog,
    getMainWindow: () => owner,
    requestInstall: async () => true,
  });

  await controller.handleState(downloadedState());

  assert.equal(dialog.calls.length, 1);
  assert.equal(dialog.calls[0][0], owner);
  assert.deepEqual(dialog.calls[0][1], READY_DIALOG_OPTIONS('2.0.1'));
  assert.equal(dialog.calls[0][1].message, 'SnapOverLAN 2.0.1 is ready to install.');
  assert.deepEqual(dialog.calls[0][1].buttons, ['Later', 'Restart & Update']);
});

test('a hidden main window uses an unowned native dialog without showing the window', async () => {
  const dialog = new FakeDialog();
  const owner = {
    isDestroyed: () => false,
    isVisible: () => false,
  };
  const controller = createUpdateDialogController({
    dialog,
    getMainWindow: () => owner,
    requestInstall: async () => true,
  });

  await controller.handleState(downloadedState());

  assert.equal(dialog.calls.length, 1);
  assert.deepEqual(dialog.calls[0], [READY_DIALOG_OPTIONS('2.0.1')]);
});

test('duplicate downloaded states share one prompt and one session decision', async () => {
  const dialog = new FakeDialog();
  const promptGate = deferred();
  dialog.implementation = () => promptGate.promise;
  let installCalls = 0;
  const controller = createUpdateDialogController({
    dialog,
    requestInstall: async () => { installCalls += 1; return true; },
  });

  const firstPrompt = controller.handleState(downloadedState());
  const duplicatePrompt = controller.handleState(downloadedState());
  assert.equal(firstPrompt, duplicatePrompt);
  await Promise.resolve();
  assert.equal(dialog.calls.length, 1);

  promptGate.resolve({ response: 0 });
  await firstPrompt;
  await controller.handleState(downloadedState());
  assert.equal(dialog.calls.length, 1);
  assert.equal(installCalls, 0);
});

test('Later closes the prompt without requesting installation', async () => {
  const dialog = new FakeDialog([0]);
  let installCalls = 0;
  const controller = createUpdateDialogController({
    dialog,
    requestInstall: async () => { installCalls += 1; return true; },
  });

  assert.equal(await controller.handleState(downloadedState()), false);
  assert.equal(installCalls, 0);
  assert.equal(dialog.calls.length, 1);
});

test('Restart & Update requests the shared installation path only once', async () => {
  const dialog = new FakeDialog([1]);
  let installCalls = 0;
  const controller = createUpdateDialogController({
    dialog,
    requestInstall: async () => { installCalls += 1; return true; },
  });

  assert.equal(await controller.handleState(downloadedState()), true);
  await controller.handleState(downloadedState());
  assert.equal(installCalls, 1);
  assert.equal(dialog.calls.length, 1);
});

test('an explicit installation failure shows only the sanitized native error', async () => {
  const dialog = new FakeDialog([1, 0]);
  const controller = createUpdateDialogController({
    dialog,
    requestInstall: async () => false,
  });

  assert.equal(await controller.handleState(downloadedState()), false);
  assert.equal(dialog.calls.length, 2);
  assert.deepEqual(dialog.calls[1], [INSTALL_ERROR_DIALOG_OPTIONS]);
  assert.equal(dialog.calls[1][0].message, 'The update could not be installed.');
  assert.equal(dialog.calls[1][0].detail, 'Please restart SnapOverLAN and try again.');
});

test('ordinary checking and network-error states never show a dialog', async () => {
  const dialog = new FakeDialog();
  const controller = createUpdateDialogController({
    dialog,
    requestInstall: async () => true,
  });

  await controller.handleState({ status: 'checking', version: '' });
  await controller.handleState({
    status: 'error',
    version: '',
    message: 'Could not reach the update service.',
  });
  await controller.handleState(downloadedState('<script>'));
  assert.equal(dialog.calls.length, 0);
});
