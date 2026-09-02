import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyServerStatus } from '../app/server/identity.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(testDir, '..');
const serverEntry = path.join(projectRoot, 'app', 'server', 'index.js');
const mainSource = await readFile(path.join(projectRoot, 'app', 'main.js'), 'utf8');
const desktopServerClientSource = await readFile(
  path.join(projectRoot, 'app', 'desktop', 'server-client.js'),
  'utf8',
);
const desktopServerManagerSource = await readFile(
  path.join(projectRoot, 'app', 'desktop', 'server-manager.js'),
  'utf8',
);
const desktopSettingsStoreSource = await readFile(
  path.join(projectRoot, 'app', 'desktop', 'settings-store.js'),
  'utf8',
);
const desktopAutoCopyControllerSource = await readFile(
  path.join(projectRoot, 'app', 'desktop', 'auto-copy-controller.js'),
  'utf8',
);
const desktopBatchDownloadSource = await readFile(
  path.join(projectRoot, 'app', 'desktop', 'batch-download.js'),
  'utf8',
);
const desktopShellSource = await readFile(
  path.join(projectRoot, 'app', 'desktop', 'shell.js'),
  'utf8',
);
const updateDialogControllerSource = await readFile(
  path.join(projectRoot, 'app', 'desktop', 'update-dialog-controller.js'),
  'utf8',
);
const serverSource = await readFile(serverEntry, 'utf8');
const parentBridgeSource = await readFile(
  path.join(projectRoot, 'app', 'server', 'parent-bridge.js'),
  'utf8',
);
const uploadsRouteSource = await readFile(
  path.join(projectRoot, 'app', 'server', 'routes', 'uploads.js'),
  'utf8',
);
const systemRouteSource = await readFile(
  path.join(projectRoot, 'app', 'server', 'routes', 'system.js'),
  'utf8',
);
const batchesRouteSource = await readFile(
  path.join(projectRoot, 'app', 'server', 'routes', 'batches.js'),
  'utf8',
);
const archiveSource = await readFile(path.join(projectRoot, 'app', 'server', 'archive.js'), 'utf8');
const preloadSource = await readFile(path.join(projectRoot, 'app', 'preload.cjs'), 'utf8');
const rendererMarkup = await readFile(path.join(projectRoot, 'app', 'renderer', 'index.html'), 'utf8');
const rendererStyles = await readFile(path.join(projectRoot, 'app', 'renderer', 'styles.css'), 'utf8');
const rendererSource = await readFile(path.join(projectRoot, 'app', 'renderer', 'app.js'), 'utf8');
const rendererBatchHistorySource = await readFile(
  path.join(projectRoot, 'app', 'renderer', 'batch-history.js'),
  'utf8',
);
const extensionMarkup = await readFile(path.join(projectRoot, 'extension', 'popup.html'), 'utf8');
const extensionSource = await readFile(path.join(projectRoot, 'extension', 'popup.js'), 'utf8');
const rendererFont = await readFile(path.join(
  projectRoot,
  'app',
  'renderer',
  'fonts',
  'inter-latin-variable.woff2',
));
const packageConfig = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const requestQuitStart = mainSource.indexOf('async function requestQuit(');
const requestQuitEnd = mainSource.indexOf("ipcMain.handle('server:get-state'", requestQuitStart);
const requestQuitSource = mainSource.slice(requestQuitStart, requestQuitEnd);
const windowCloseSource = desktopShellSource.match(
  /mainWindow\.on\('close',[\s\S]*?mainWindow\.on\('closed'/,
)?.[0];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else resolve();
  }));
  return port;
}

async function getStatus(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/server-status`);
  if (!response.ok) throw new Error(`Unexpected status ${response.status}`);
  return response.json();
}

async function getControl(port) {
  const response = await fetch(`http://127.0.0.1:${port}/api/server-control`);
  if (!response.ok) throw new Error(`Unexpected status ${response.status}`);
  return response.json();
}

async function waitForServer(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const status = await getStatus(port);
      if (status.status === 'listening') return status;
    } catch {}
    await sleep(100);
  }
  throw new Error('Test server did not become ready');
}

function waitForExit(child, timeoutMs = 5000) {
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal }))),
    sleep(timeoutMs).then(() => { throw new Error(`Process ${child.pid} did not exit`); }),
  ]);
}

test('preload exposes only narrow non-updater desktop methods', () => {
  assert.match(desktopShellSource, /preload:\s*preloadPath/);
  assert.match(desktopShellSource, /contextIsolation:\s*true/);
  assert.match(desktopShellSource, /nodeIntegration:\s*false/);
  assert.match(desktopShellSource, /sandbox:\s*true/);
  assert.match(preloadSource, /getServerState/);
  assert.match(preloadSource, /retryServer/);
  assert.doesNotMatch(preloadSource, /startServer|stopServer|server:start|server:stop/);
  assert.match(preloadSource, /getBackgroundMode/);
  assert.match(preloadSource, /setBackgroundMode/);
  assert.match(preloadSource, /downloadBatch[\s\S]*?ipcRenderer\.invoke\('batch:download', batchId\)/);
  assert.match(preloadSource, /BATCH_ID_PATTERN\.test\(batchId\)/);
  assert.match(preloadSource, /copyImageBytes[\s\S]*?ipcRenderer\.invoke\('image:copy', imageBytes\)/);
  assert.match(preloadSource, /imageBytes\.byteLength > MAX_IMAGE_COPY_BYTES/);
  assert.match(preloadSource, /onAutoCopyResult/);
  assert.match(preloadSource, /onDesktopStateChanged/);
  assert.doesNotMatch(
    preloadSource,
    /getUpdateState|downloadUpdate|restartAndInstallUpdate|onUpdateStateChanged|update:/,
  );
  assert.doesNotMatch(preloadSource, /getAutoCopyFirstPhoto|setAutoCopyFirstPhoto|auto-copy:(?:get|set)/);
  assert.doesNotMatch(preloadSource, /ipcRenderer\.(?:send|sendSync)|require:\s*\(/);
  assert.doesNotMatch(preloadSource, /clipboard|nativeImage|node:fs|['"]fs['"]/);
});

test('desktop companion exposes no manual photo copy or viewer actions', () => {
  assert.doesNotMatch(rendererMarkup, /photoGrid|gridViewBtn|listViewBtn|gridCountSelect|picturePagination/);
  assert.doesNotMatch(rendererSource, /copyImage|copyImageBytes|downloadImage|renderPictures|loadLatestPictures/);
  assert.doesNotMatch(rendererStyles, /\.photo-(?:grid|list|card|row|action)|\.view-toggle|\.grid-count-control|\.picture-pagination/);
});

test('background mode is limited to an online server', () => {
  assert.match(mainSource, /serverState !== 'online' && backgroundMode/);
  assert.match(mainSource, /nextValue && serverState !== 'online'/);
  assert.match(desktopShellSource, /label: `Background Mode:[\s\S]*?enabled: getServerOnline\(\)/);
  assert.match(rendererSource, /backgroundToggleBtn\.disabled = desktopServerState !== 'online'/);
  assert.match(rendererSource, /desktopServerState !== 'online'[\s\S]*?backgroundModeEnabled = false/);
});

test('closing with Background Mode off quits and stops the server', () => {
  assert.notEqual(requestQuitStart, -1);
  assert.notEqual(requestQuitEnd, -1);
  assert.ok(windowCloseSource);
  assert.match(windowCloseSource, /onQuit\(\)/);
  assert.match(mainSource, /onQuit: \(\) => requestQuit\(\)/);
  assert.match(
    requestQuitSource,
    /serverManager\.isRunning\(\)[\s\S]*?await stopServer\(\)/,
  );
});

test('closing with Background Mode on hides the window and keeps the server alive', () => {
  assert.ok(windowCloseSource);
  assert.match(windowCloseSource, /if \(getBackgroundMode\(\)\) \{[\s\S]*?mainWindow\.hide\(\)[\s\S]*?return/);
});

test('tray Quit, before-quit, and repeated quits share one shutdown path', () => {
  assert.match(requestQuitSource, /if \(serverOperation\) \{[\s\S]*?await serverOperation\.catch/);
  assert.match(
    requestQuitSource,
    /if \(quitOperation\) \{[\s\S]*?return quitOperation/,
  );
  assert.match(desktopShellSource, /label: 'Quit', click: onQuit/);
  assert.match(mainSource, /onQuit: \(\) => requestQuit\(\)/);
  assert.match(mainSource, /electronApp\.on\('before-quit',[\s\S]*?requestQuit\(\)/);
  assert.doesNotMatch(mainSource, /label: (?:serverIsRunning \? )?'(?:Start|Stop) Server/);
});

test('updater initialization starts after the visible desktop is ready and cannot fail startup', () => {
  const readyStart = mainSource.indexOf("electronApp.whenReady().then(async () => {");
  const windowShown = mainSource.indexOf('desktopShell.showMainWindow();', readyStart);
  const updaterStarted = mainSource.indexOf('void initializeUpdateManager();', windowShown);
  const fatalCatch = mainSource.indexOf("dialog.showErrorBox('SnapOverLAN could not start'", updaterStarted);
  const initializeStart = mainSource.indexOf('const initializeUpdateManager = () =>');
  const checkStart = mainSource.indexOf('updateManager.checkForUpdates().catch', initializeStart);

  assert.ok(readyStart >= 0);
  assert.ok(windowShown > readyStart);
  assert.ok(updaterStarted > windowShown);
  assert.ok(fatalCatch > updaterStarted);
  assert.ok(initializeStart >= 0);
  assert.ok(checkStart > initializeStart);
  assert.match(mainSource, /updateManagerInitialization = \(async \(\) => \{[\s\S]*?createElectronUpdateManager/);
  assert.match(
    mainSource,
    /createUpdateDialogController\([\s\S]*?updateManager\?\.isInstallationReady\(\)[\s\S]*?requestQuit\(\{ installUpdate: true \}\)/,
  );
  assert.match(mainSource, /updateManager\.onStateChanged\(\(state\) =>/);
  assert.match(mainSource, /Initialization failed without affecting application startup/);
});

test('updater stays in the trusted main process with no renderer IPC or state forwarding', () => {
  assert.doesNotMatch(mainSource, /ipcMain\.handle\('update:/);
  assert.doesNotMatch(mainSource, /desktopShell\?\.send\('update:/);
  assert.doesNotMatch(preloadSource, /update:/);
  assert.match(mainSource, /dialog,[\s\S]*?getMainWindow: \(\) => desktopShell\.getMainWindow\(\)/);
  assert.match(desktopShellSource, /getMainWindow: \(\) =>/);
  assert.doesNotMatch(updateDialogControllerSource, /ipcRenderer|autoUpdater|releaseNotes|downloadedFile|https?:\/\//);
});

test('normal quit and update install share cleanup but use distinct final actions', () => {
  const stopIndex = requestQuitSource.indexOf('await stopServer()');
  const trayIndex = requestQuitSource.indexOf('desktopShell.destroyTray()');
  const allowIndex = requestQuitSource.indexOf('allowQuit = true');
  const installIndex = requestQuitSource.indexOf('updateManager?.installDownloadedUpdate()');
  const normalQuitIndex = requestQuitSource.indexOf('electronApp.quit()');

  assert.ok(stopIndex >= 0);
  assert.ok(trayIndex > stopIndex);
  assert.ok(allowIndex > trayIndex);
  assert.ok(installIndex > allowIndex);
  assert.ok(normalQuitIndex > installIndex);
  assert.match(requestQuitSource, /if \(installStarted\) return true;[\s\S]*?electronApp\.quit\(\)/);
  assert.match(requestQuitSource, /allowQuit = false;[\s\S]*?quitOperation = null/);
});

test('duplicate update restarts and before-quit cannot create a second shutdown loop', () => {
  assert.match(requestQuitSource, /if \(quitOperation\) \{[\s\S]*?return quitOperation/);
  assert.match(mainSource, /electronApp\.on\('before-quit',[\s\S]*?if \(allowQuit\)[\s\S]*?return/);
  assert.match(requestQuitSource, /allowQuit = true;[\s\S]*?installDownloadedUpdate\(\)/);
  assert.match(updateDialogControllerSource, /promptedVersions\.has\(version\)/);
  assert.match(updateDialogControllerSource, /requestInstall\?\.\(\)/);
});

test('unrelated processes are never killed; only verified SnapOverLAN servers receive shutdown', () => {
  assert.match(desktopServerClientSource, /control\?\.service !== SERVER_CONTROL_ID/);
  assert.match(desktopServerClientSource, /'x-snapoverlan-shutdown-token': token/);
  assert.match(
    desktopServerManagerSource,
    /if \(!identity && !serverProcess\)[\s\S]*?not a verified SnapOverLAN server/,
  );
  assert.match(desktopServerManagerSource, /if \(!exited && serverProcess\?\.exitCode === null\)/);
  assert.match(serverSource, /const isLoopbackRequest[\s\S]*?remoteAddress/);
  assert.match(systemRouteSource, /crypto\.timingSafeEqual/);
  assert.match(systemRouteSource, /onShutdown\('localhost-control'\)/);
  assert.doesNotMatch(desktopServerManagerSource, /Leaving the externally managed SnapOverLAN server running/);
});

test('server identity contract recognizes current, legacy, and unrelated responses', () => {
  assert.equal(classifyServerStatus({
    status: 'listening',
    application: 'SnapOverLAN',
    protocolVersion: 1,
    pid: 123,
  }), 'current');
  assert.equal(classifyServerStatus({
    status: 'listening',
    configuredHost: '0.0.0.0',
    bindHost: '0.0.0.0',
    port: 8787,
    lanUrls: [],
    runtimeDataDir: 'data',
    latestDir: 'latest',
    uploadTempDir: 'upload-tmp',
    pid: 123,
  }), 'legacy');
  assert.equal(classifyServerStatus({
    status: 'listening',
    application: 'UnrelatedService',
    protocolVersion: 1,
    configuredHost: '0.0.0.0',
    bindHost: '0.0.0.0',
    port: 8787,
    lanUrls: [],
    runtimeDataDir: 'data',
    latestDir: 'latest',
    uploadTempDir: 'upload-tmp',
    pid: 123,
  }), 'unrelated');
  assert.match(desktopServerManagerSource, /An older SnapOverLAN server is running\. Stop it once and restart the app\./);
  assert.match(desktopServerManagerSource, /if \(existingIdentity\?\.shutdownToken\)/);
});

test('server startup settles before the renderer loads and a failure still creates the window', () => {
  assert.match(desktopShellSource, /show: false/);
  assert.match(
    mainSource,
    /await loadSettings\(\);[\s\S]*?await startServer\(\)\.catch\(\(error\) => \{[\s\S]*?console\.error\('SnapOverLAN server startup failed:', error\);[\s\S]*?\}\);[\s\S]*?await desktopShell\.createWindow\(\);[\s\S]*?desktopShell\.showMainWindow\(\)/,
  );
  assert.match(desktopShellSource, /await mainWindow\.loadFile\(rendererPath,/);
  assert.match(
    desktopServerManagerSource,
    /if \(serverOperationType === 'start'\) return serverOperation/,
  );
  assert.match(desktopServerManagerSource, /if \(existingIdentity\?\.shutdownToken\)[\s\S]*?serverLaunchMode = 'reused'/);
  assert.doesNotMatch(mainSource, /serverAutoStart/);
});

test('packaged child startup explicitly runs the server entry from inside ASAR', () => {
  assert.match(desktopServerManagerSource, /SNAPOVERLAN_RUN_SERVER:\s*'1'/);
  assert.match(serverSource, /process\.env\.SNAPOVERLAN_RUN_SERVER === '1'/);
  assert.match(desktopServerManagerSource, /ELECTRON_RUN_AS_NODE = '1'/);
  assert.match(
    desktopServerManagerSource,
    /serverWorkingDirectory = isPackaged \? process\.resourcesPath : projectRoot/,
  );
  assert.match(desktopServerManagerSource, /cwd:\s*serverWorkingDirectory/);
  assert.match(desktopServerManagerSource, /spawn\(nodePath, \[serverPath\]/);
});

test('manual server controls are removed and retry is error-only', () => {
  assert.doesNotMatch(rendererMarkup, /id="serverToggleBtn"/);
  assert.doesNotMatch(rendererSource, /serverToggleBtn|serverToggleOperation|\.startServer\(|\.stopServer\(/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\('server:(?:start|stop)'/);
  assert.match(rendererMarkup, /id="retryServerBtn"[^>]*hidden/);
  assert.match(rendererSource, /retryServerBtn\.hidden = desktopServerState !== 'error'/);
  assert.match(rendererSource, /window\.snapOverLAN\.retryServer\(\)/);
  assert.match(rendererSource, /server\?\.state === 'error'[\s\S]*?server\.error/);
  assert.match(mainSource, /const handleServerControl = async[\s\S]*?return getServerStatePayload\(\)/);
});

test('desktop settings persist Background Mode and auto-copy with safe migration', () => {
  assert.doesNotMatch(mainSource, /serverAutoStart/);
  assert.match(mainSource, /normalizeDesktopSettings/);
  assert.match(mainSource, /autoCopyFirstPhoto/);
  assert.match(mainSource, /settingsStore\.save\(getDesktopSettings\(\)/);
  assert.match(desktopSettingsStoreSource, /JSON\.stringify\(normalizeDesktopSettings\(settings\)/);
  assert.match(mainSource, /updateDesktopSetting\(previousSettings, 'backgroundMode'/);
  assert.match(mainSource, /updateDesktopSetting\(previousSettings, 'autoCopyFirstPhoto'/);
});

test('disabling Background Mode restores the window without stopping the server', () => {
  const backgroundModeSource = mainSource.match(
    /async function setBackgroundMode[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(backgroundModeSource);
  assert.match(backgroundModeSource, /if \(backgroundMode\) \{[\s\S]*?desktopShell\.createTray\(\)/);
  assert.match(backgroundModeSource, /else \{[\s\S]*?await desktopShell\.openMainWindow\(\);[\s\S]*?desktopShell\.destroyTray\(\)/);
  assert.doesNotMatch(backgroundModeSource, /stopServer\(/);
});

test('header controls are compact, accessible, and preserve existing actions', () => {
  assert.match(rendererMarkup, /id="connectionPill"/);
  assert.match(rendererMarkup, /id="backgroundToggleBtn"[^>]+aria-label=/);
  assert.doesNotMatch(rendererMarkup, /id="autoCopyToggleBtn"/);
  assert.doesNotMatch(rendererSource, /autoCopyToggleBtn|getAutoCopyFirstPhoto|setAutoCopyFirstPhoto/);
  assert.match(rendererMarkup, /id="retryServerBtn"/);
  assert.match(rendererMarkup, /id="qrBtn"/);
  assert.match(rendererMarkup, /id="refreshBtn"/);
  assert.match(rendererStyles, /\.header-toggle:focus-visible/);
  assert.match(rendererStyles, /#backgroundToggleBtn:disabled\s*{\s*cursor:\s*default;/);
});

test('auto-copy uses one validated owned-server IPC path and never gallery refreshes', () => {
  const selectBatchSource = rendererBatchHistorySource.match(
    /async function selectBatch[\s\S]*?\n\}/,
  )?.[0];
  assert.ok(selectBatchSource);
  assert.match(uploadsRouteSource, /const files = await finalizeUploadedBatch\(req\);[\s\S]*?createUploadCompletedEvent\(req\)/);
  assert.match(uploadsRouteSource, /\.find\(\(file\) => \([\s\S]*?isAllowedImageMimeType\(file\?\.mimetype\)/);
  assert.match(uploadsRouteSource, /await onUploadCompleted\(completionEvent\)/);
  assert.match(parentBridgeSource, /processTarget\?\.connected[\s\S]*?typeof processTarget\.send !== 'function'/);
  assert.match(mainSource, /isOwnedServerProcess: \(serverProcess\) => serverManager\?\.isOwnedProcess\(serverProcess\)/);
  assert.match(desktopAutoCopyControllerSource, /if \(!isOwnedServerProcess\(serverProcess\)\) return;/);
  assert.match(desktopAutoCopyControllerSource, /nativeImage\.createFromPath\(filePath\)/);
  assert.match(desktopAutoCopyControllerSource, /nativeImage\.createFromBuffer\(buffer\)/);
  assert.match(desktopAutoCopyControllerSource, /clipboard\.writeImage\(image\)/);
  assert.match(desktopAutoCopyControllerSource, /clipboard\.readImage\(\)/);
  assert.match(mainSource, /desktopShell\?\.send\('desktop:auto-copy-result'/);
  assert.match(desktopAutoCopyControllerSource, /snapoverlan:auto-copy-request/);
  assert.match(desktopAutoCopyControllerSource, /await setEnabled\(message\.enabled\)/);
  assert.match(desktopAutoCopyControllerSource, /snapoverlan:auto-copy-response/);
  assert.match(systemRouteSource, /router\.get\('\/auto-copy'/);
  assert.match(systemRouteSource, /router\.put\('\/auto-copy'/);
  assert.match(systemRouteSource, /typeof req\.body\?\.enabled !== 'boolean'/);
  assert.match(serverSource, /isLoopbackRequest/);
  assert.match(extensionMarkup, /id="autoCopyToggleBtn"[^>]+aria-pressed="false"[^>]*>Auto-copy: Off<\/button>/);
  assert.match(extensionMarkup, /id="autoCopyToggleBtn"[^>]+disabled/);
  assert.match(extensionMarkup, /id="status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(extensionSource, /`Auto-copy: \$\{autoCopyEnabled \? 'On' : 'Off'\}`/);
  assert.match(extensionSource, /setAttribute\('aria-pressed', String\(autoCopyEnabled\)\)/);
  assert.match(extensionSource, /requestAutoCopySetting\(origin, 'PUT', nextEnabled\)/);
  assert.match(extensionSource, /auto-copy update failed[\s\S]*?setStatus\([^;]+,\s*'error'\)/);
  assert.doesNotMatch(preloadSource, /auto-copy:(?:get|set)|getAutoCopyFirstPhoto|setAutoCopyFirstPhoto/);
  assert.doesNotMatch(mainSource, /ipcMain\.handle\('auto-copy:(?:get|set)'/);
  assert.match(rendererSource, /Copied \$\{filename\} to clipboard/);
  assert.doesNotMatch(rendererSource, /copyFirstUploadedImage|nativeImage|clipboard\.writeImage/);
  assert.doesNotMatch(selectBatchSource, /autoCopy|desktop:auto-copy|setAutoCopyFirstPhoto/);
  assert.doesNotMatch(rendererSource, /loadLatestPictures|renderPictures|photoGrid/);
});

test('verified reused servers are replaced by one owned child when auto-copy is enabled', () => {
  assert.match(
    desktopServerManagerSource,
    /identity\?\.kind !== 'current'[\s\S]*?identity\.shutdownToken[\s\S]*?postServerShutdown\(identity\.shutdownToken\)/,
  );
  assert.match(
    desktopServerManagerSource,
    /existingIdentity\?\.shutdownToken && getAutoCopyEnabled\(\)[\s\S]*?stopVerifiedReusedServerForAutoCopy\(existingIdentity\)/,
  );
  assert.match(
    desktopServerManagerSource,
    /serverLaunchMode !== 'reused'[\s\S]*?verifiedShutdownToken[\s\S]*?stopVerifiedReusedServerForAutoCopy[\s\S]*?await start\(\)/,
  );
  assert.match(desktopServerManagerSource, /Auto-copy: Waiting|AUTO_COPY_UNAVAILABLE_MESSAGE/);
  assert.match(desktopServerManagerSource, /ownedServerMessageListeners = new WeakMap\(\)/);
  assert.match(desktopServerManagerSource, /detachOwnedServerMessageListener\(serverProcess\)/);
  assert.ok(packageConfig.dependencies.sharp);
  assert.equal(packageConfig.devDependencies.sharp, undefined);
});

test('desktop typography uses the bundled shared UI font and semantic weights', () => {
  assert.match(
    rendererStyles,
    /@font-face\s*\{[\s\S]*?font-family:\s*"SnapOverLAN UI";[\s\S]*?url\("\.\/fonts\/inter-latin-variable\.woff2"\)[\s\S]*?font-weight:\s*400 700;/,
  );
  assert.match(rendererStyles, /--font-ui:\s*"SnapOverLAN UI", system-ui, sans-serif;/);
  assert.match(rendererStyles, /--font-weight-body:\s*500;/);
  assert.match(rendererStyles, /--font-weight-control:\s*600;/);
  assert.match(rendererStyles, /--font-weight-heading:\s*700;/);
  assert.match(rendererStyles, /-webkit-font-smoothing: antialiased;/);
  assert.match(rendererStyles, /-moz-osx-font-smoothing: grayscale;/);
  assert.match(
    rendererStyles,
    /button,\s*input,\s*select,\s*textarea\s*\{[\s\S]*?font-family:\s*inherit;/,
  );
  assert.match(
    rendererStyles,
    /body\s*\{[\s\S]*?font-family:\s*var\(--font-ui\);[\s\S]*?font-weight:\s*var\(--font-weight-body\);/,
  );
  assert.match(
    rendererStyles,
    /\.header-button\s*\{[\s\S]*?font-weight:\s*var\(--font-weight-control\);/,
  );
  assert.match(
    rendererStyles,
    /\.status-text\s*\{[\s\S]*?font-weight:\s*var\(--font-weight-control\);/,
  );
  assert.doesNotMatch(rendererStyles, /font-family:\s*"Segoe UI"/);
  assert.doesNotMatch(rendererStyles, /font-size:\s*[^;]*rem/);
  assert.doesNotMatch(rendererStyles, /letter-spacing:/);
  assert.ok(rendererFont.length > 0);
  assert.ok(packageConfig.build.files.includes('app/**/*'));
});

test('recent batches are the primary workspace with selection, download, and deletion', () => {
  assert.match(rendererMarkup, /aria-label="Recent batches"/);
  assert.match(rendererMarkup, /id="downloadCurrentBatchBtn"[^>]*>Download<\/button>/);
  assert.match(rendererMarkup, /id="clearBatchesBtn"[^>]*>Clear all<\/button>/);
  assert.doesNotMatch(rendererMarkup, /Back to Pictures|id="batchesBtn"|id="closeBatchesBtn"/);
  assert.match(rendererBatchHistorySource, /textContent = batch\.current \? 'Selected' : 'Select'/);
  assert.match(rendererBatchHistorySource, /deleteButton\.textContent = 'Delete'/);
  assert.match(rendererBatchHistorySource, /window\.snapOverLAN\.downloadBatch\(currentBatch\.id\)/);
  assert.match(rendererBatchHistorySource, /downloadButton\?\.addEventListener\('click', downloadCurrentBatch\)/);
  assert.doesNotMatch(rendererBatchHistorySource, /latest\/download|createObjectURL|\.zip/);
  assert.match(rendererStyles, /\.batches-header[\s\S]*?justify-content:\s*space-between/);
  assert.match(rendererStyles, /\.batch-toolbar-actions[\s\S]*?margin-left:\s*auto/);
});

test('Electron downloads batch files directly to the standard Downloads directory', () => {
  const downloadHandlerSource = mainSource.match(
    /ipcMain\.handle\('batch:download'[\s\S]*?\n\}\);/,
  )?.[0];
  assert.ok(downloadHandlerSource);
  assert.match(
    downloadHandlerSource,
    /ipcMain\.handle\('batch:download'[\s\S]*?desktopShell\.isMainWindowSender\(event\.sender\)/,
  );
  assert.match(downloadHandlerSource, /const destinationDir = electronApp\.getPath\('downloads'\)/);
  assert.doesNotMatch(downloadHandlerSource, /showOpenDialog|openDirectory|createDirectory|Choose folder/);
  assert.match(
    downloadHandlerSource,
    /const result = await downloadBatchToFolder\([\s\S]*?await shell\.openPath\(destinationDir\)[\s\S]*?return result/,
  );
  assert.match(desktopBatchDownloadSource, /Buffer\.from\(await fileResponse\.arrayBuffer\(\)\)/);
  assert.match(desktopBatchDownloadSource, /writeFile[\s\S]*?flag:\s*'wx'/);
  assert.match(desktopBatchDownloadSource, /`\$\{stem\} \(\$\{suffix\}\)\$\{extension\}`/);
  assert.match(batchesRouteSource, /router\.get\('\/batches\/:id\/files\/:name'/);
});

test('server ZIP archive API remains available outside the Electron download flow', () => {
  assert.match(batchesRouteSource, /router\.get\('\/latest\/download'/);
  assert.match(batchesRouteSource, /createZipBuffer\(files\)/);
  assert.match(batchesRouteSource, /'Content-Type', 'application\/zip'/);
  assert.match(archiveSource, /const createZipBuffer = async/);
  assert.match(archiveSource, /batch\.zip|formatBatchZipName/);
});

test('desktop content header omits duplicate SnapOverLAN branding', () => {
  const contentHeader = rendererMarkup.match(/<header class="title-row">[\s\S]*?<\/header>/)?.[0];
  assert.ok(contentHeader);
  assert.doesNotMatch(contentHeader, /SnapOverLAN|snapoverlan-mark/);
  assert.doesNotMatch(rendererStyles, /\.brand-lockup|\.brand-logo|\.brand-lan/);
});

test('Electron companion window uses compact resizable bounds', () => {
  assert.match(desktopShellSource, /width:\s*500/);
  assert.match(desktopShellSource, /height:\s*580/);
  assert.match(desktopShellSource, /minWidth:\s*460/);
  assert.match(desktopShellSource, /resizable:\s*true/);
});

test('Electron companion uses native dark title bar controls and remains draggable', () => {
  assert.match(desktopShellSource, /titleBarStyle:\s*'hidden'/);
  assert.match(desktopShellSource, /titleBarOverlay:\s*\{[\s\S]*?color:\s*'#343940'/);
  assert.match(desktopShellSource, /symbolColor:\s*'#f5fdff'/);
  assert.match(desktopShellSource, /height:\s*32/);
  assert.match(rendererMarkup, /class="titlebar-drag-region"[^>]*aria-hidden="true"/);
  assert.match(rendererMarkup, /class="titlebar-brand"[\s\S]*?snapoverlan-mark\.svg[\s\S]*?SnapOverLAN/);
  assert.match(rendererStyles, /\.titlebar-drag-region[\s\S]*?height:\s*32px[\s\S]*?app-region:\s*drag/);
  assert.match(rendererStyles, /\.titlebar-brand[\s\S]*?pointer-events:\s*none/);
  assert.match(rendererStyles, /\.title-row[\s\S]*?app-region:\s*drag/);
  assert.match(rendererStyles, /\.server-controls,[\s\S]*?\.header-actions[\s\S]*?app-region:\s*no-drag/);
});

test('retention controls are not exposed in desktop batch history', () => {
  assert.doesNotMatch(rendererMarkup, /retentionSelect|saveRetentionBtn|Retention setting/);
  assert.doesNotMatch(rendererBatchHistorySource, /storage-settings|retentionSelect|saveRetention/);
  assert.doesNotMatch(rendererStyles, /\.retention-select/);
});

test('verified reused server requires authentication and shuts down gracefully', async (t) => {
  const port = await getFreePort();
  const childEnv = {
    ...process.env,
    SNAPOVERLAN_PORT: String(port),
    SNAPOVERLAN_SERVER_SOURCE: 'electron-control-test',
  };
  const server = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  t.after(() => {
    if (server.exitCode === null) server.kill();
  });

  const publicStatus = await waitForServer(port);
  assert.equal(publicStatus.application, 'SnapOverLAN');
  assert.equal(publicStatus.protocolVersion, 1);
  assert.equal(classifyServerStatus(publicStatus), 'current');

  const fontResponse = await fetch(
    `http://127.0.0.1:${port}/fonts/inter-latin-variable.woff2`,
  );
  assert.equal(fontResponse.status, 200);
  assert.match(fontResponse.headers.get('content-type') || '', /font\/woff2/i);
  assert.deepEqual(
    [...new Uint8Array((await fontResponse.arrayBuffer()).slice(0, 4))],
    [0x77, 0x4f, 0x46, 0x32],
  );

  const control = await getControl(port);
  assert.equal(control.service, 'snapoverlan-server-control-v1');
  assert.equal(control.server.application, 'SnapOverLAN');
  assert.equal(control.server.protocolVersion, 1);
  assert.equal(classifyServerStatus(control.server), 'current');
  assert.equal(control.server.status, 'listening');
  assert.match(control.shutdownToken, /^[a-f0-9]{64}$/);

  const rejected = await fetch(`http://127.0.0.1:${port}/api/server-shutdown`, {
    method: 'POST',
    headers: { 'x-snapoverlan-shutdown-token': 'not-the-token' },
  });
  assert.equal(rejected.status, 404);
  assert.equal((await getStatus(port)).status, 'listening');

  let duplicateError = '';
  const duplicate = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: childEnv,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  });
  duplicate.stderr.on('data', (chunk) => { duplicateError += chunk; });
  const duplicateExit = await waitForExit(duplicate);
  assert.notEqual(duplicateExit.code, 0);
  assert.match(duplicateError, /EADDRINUSE|address already in use/i);

  const exitPromise = waitForExit(server);
  const shutdownStartedAt = Date.now();
  const accepted = await fetch(`http://127.0.0.1:${port}/api/server-shutdown`, {
    method: 'POST',
    headers: { 'x-snapoverlan-shutdown-token': control.shutdownToken },
  });
  assert.equal(accepted.status, 202);
  const cleanExit = await exitPromise;
  assert.equal(cleanExit.code, 0);
  const shutdownElapsedMs = Date.now() - shutdownStartedAt;
  assert.ok(shutdownElapsedMs < 1200);
  t.diagnostic(`authenticated reused-server shutdown: ${shutdownElapsedMs} ms`);

  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/server-status`));
});

test('an Electron-owned server stops cleanly over IPC', async (t) => {
  const port = await getFreePort();
  const server = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SNAPOVERLAN_PORT: String(port),
      SNAPOVERLAN_PARENT_PID: String(process.pid),
      SNAPOVERLAN_SERVER_SOURCE: 'electron-owned-control-test',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  t.after(() => {
    if (server.exitCode === null) server.kill();
  });

  await waitForServer(port);
  const exitPromise = waitForExit(server);
  const shutdownStartedAt = Date.now();
  server.send({ type: 'snapoverlan:shutdown' });
  const cleanExit = await exitPromise;
  assert.equal(cleanExit.code, 0);
  const shutdownElapsedMs = Date.now() - shutdownStartedAt;
  assert.ok(shutdownElapsedMs < 1000);
  t.diagnostic(`owned IPC shutdown: ${shutdownElapsedMs} ms`);
  await assert.rejects(() => fetch(`http://127.0.0.1:${port}/api/server-status`));
});

test('shutdown cleans up remaining server sockets after a short grace period', async (t) => {
  const port = await getFreePort();
  const server = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      SNAPOVERLAN_PORT: String(port),
      SNAPOVERLAN_PARENT_PID: String(process.pid),
      SNAPOVERLAN_SERVER_SOURCE: 'electron-socket-cleanup-test',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  t.after(() => {
    if (server.exitCode === null) server.kill();
  });

  await waitForServer(port);
  const heldSocket = createConnection({ host: '127.0.0.1', port });
  heldSocket.on('error', () => {});
  t.after(() => heldSocket.destroy());
  await new Promise((resolve) => heldSocket.once('connect', resolve));
  heldSocket.write(`GET /api/server-status HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);

  const exitPromise = waitForExit(server);
  const shutdownStartedAt = Date.now();
  server.send({ type: 'snapoverlan:shutdown' });
  const cleanExit = await exitPromise;
  assert.equal(cleanExit.code, 0);
  const shutdownElapsedMs = Date.now() - shutdownStartedAt;
  assert.ok(shutdownElapsedMs < 1400);
  t.diagnostic(`shutdown with held socket: ${shutdownElapsedMs} ms`);
  assert.equal(heldSocket.destroyed, true);
});
