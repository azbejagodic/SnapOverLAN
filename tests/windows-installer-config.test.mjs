import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('production builds package application files in ASAR without broad unpacking', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));

  assert.equal(packageJson.build.asar, true);
  assert.equal(packageJson.build.asarUnpack, undefined);
});

test('Windows Setup remains an all-users assisted installer', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const { nsis } = packageJson.build;

  assert.deepEqual(packageJson.build.win.target, [
    { target: 'nsis', arch: ['x64'] },
    { target: 'portable', arch: ['x64'] },
  ]);
  assert.equal(nsis.oneClick, false);
  assert.equal(nsis.perMachine, true);
  assert.equal(nsis.allowToChangeInstallationDirectory, false);
  assert.equal(nsis.runAfterFinish, true);
  assert.equal(nsis.createStartMenuShortcut, true);
  assert.equal(nsis.createDesktopShortcut, true);
  assert.equal(nsis.shortcutName, 'SnapOverLAN');
  assert.equal(nsis.include, 'build/installer.nsh');
  assert.equal(nsis.artifactName, '${productName}-Setup-${version}-${arch}.${ext}');
  assert.equal(
    packageJson.build.portable.artifactName,
    '${productName}-${version}-portable-${arch}.${ext}',
  );
});

test('update feed uses the canonical source repository without automatic publishing', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));

  assert.deepEqual(packageJson.repository, {
    type: 'git',
    url: 'https://github.com/azbejagodic/SnapOverLAN.git',
  });
  assert.deepEqual(packageJson.build.publish, [{
    provider: 'github',
    owner: 'azbejagodic',
    repo: 'SnapOverLAN',
  }]);
  assert.match(packageJson.scripts.dist, /electron-builder --win --publish never/);
});

test('custom NSIS hooks safely migrate private-profile installs and retain firewall cleanup', async () => {
  const source = await fs.readFile(path.join(projectRoot, 'build', 'installer.nsh'), 'utf8');

  assert.match(source, /!macro customInit/);
  assert.match(source, /ReadRegStr \$R0 HKLM "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/);
  assert.match(source, /EnumRegKey \$R2 HKLM "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList"/);
  assert.match(source, /ReadRegStr \$R3 HKLM "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\\$R2" ProfileImagePath/);
  assert.match(source, /ExpandEnvStrings \$R3 "\$R3"/);
  assert.match(source, /StrCpy \$R5 \$R8 \$R4/);
  assert.match(source, /StrCpy \$INSTDIR "\$R7\\\$\{APP_FILENAME\}"/);
  assert.doesNotMatch(source, /DeleteReg(?:Key|Value)/);

  assert.match(source, /WriteRegStr HKLM "\$\{UNINSTALL_REGISTRY_KEY\}" InstallLocation "\$INSTDIR"/);
  const customInstall = source.match(/!macro customInstall\r?\n([\s\S]*?)!macroend/)?.[1];
  assert.ok(customInstall, 'customInstall macro must exist');
  assert.match(customInstall, /StrCpy \$launchLink "\$appExe"/);
  assert.match(source, /firewall add rule name="\$\{SNAPOVERLAN_FIREWALL_RULE\}"[^\r\n]*protocol=TCP localport=8787 remoteip=localsubnet profile=private program="\$appExe"/);
  assert.match(source, /firewall add rule name="\$\{SNAPOVERLAN_MDNS_FIREWALL_RULE\}"[^\r\n]*protocol=UDP localport=5353 remoteip=localsubnet profile=private/);

  const deleteUploadRule = source.match(/firewall delete rule name="\$\{SNAPOVERLAN_FIREWALL_RULE\}"/g) || [];
  const deleteMdnsRule = source.match(/firewall delete rule name="\$\{SNAPOVERLAN_MDNS_FIREWALL_RULE\}"/g) || [];
  assert.equal(deleteUploadRule.length, 2, 'install and uninstall must both remove the TCP rule');
  assert.equal(deleteMdnsRule.length, 2, 'install and uninstall must both remove the mDNS rule');
});

test('firewall ADD failures warn without aborting or interrupting silent updates', async () => {
  const source = await fs.readFile(path.join(projectRoot, 'build/installer.nsh'), 'utf8');
  const install = source.match(/!macro customInstall\r?\n([\s\S]*?)!macroend/)[1];
  for (const [rule, result] of [['SNAPOVERLAN_FIREWALL_RULE', 'SnapOverLANTcpFirewallResult'], ['SNAPOVERLAN_MDNS_FIREWALL_RULE', 'SnapOverLANMdnsFirewallResult']]) {
    assert.match(install, new RegExp(`firewall add rule name="\\$\\{${rule}\\}"[^\\r\\n]*\\r?\\n\\s*Pop \\$${result}`));
  }
  assert.match(install, /\$\{If\} \$SnapOverLANTcpFirewallResult != "0"\s+\$\{OrIf\} \$SnapOverLANMdnsFirewallResult != "0"/);
  assert.match(install, /DetailPrint "\$\{SNAPOVERLAN_FIREWALL_WARNING\}"/);
  assert.match(install, /MessageBox MB_OK\|MB_ICONEXCLAMATION "\$\{SNAPOVERLAN_FIREWALL_WARNING\}" \/SD IDOK/);
  assert.equal(source.match(/^!define SNAPOVERLAN_FIREWALL_WARNING "([^"]+)"/m)?.[1],
    'SnapOverLAN was installed, but its Private-network firewall rules could not be configured. Phone transfers may not work. Make sure your network is trusted and set to Private, then rerun Setup as administrator to retry.');
  assert.doesNotMatch(install, /\bAbort\b|\bQuit\b/);
  const uninstall = source.match(/!macro customUnInstall\r?\n([\s\S]*?)!macroend/)[1];
  for (const block of [install, uninstall]) {
    assert.equal((block.match(/firewall delete rule[^\r\n]*\r?\n\s*Pop \$0/g) || []).length, 2);
  }
  const builder = await fs.readFile(path.join(projectRoot, 'node_modules/app-builder-lib/templates/nsis/installSection.nsh'), 'utf8');
  assert.ok(builder.indexOf('StrCpy $appExe "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"') < builder.indexOf('!insertmacro customInstall'));
  const manager = await fs.readFile(path.join(projectRoot, 'app/desktop/server-manager.js'), 'utf8');
  assert.match(manager, /ELECTRON_RUN_AS_NODE/);
  assert.match(manager, /process\.execPath/);
});

test('NSIS owns update progress only for the --updated installer path', async () => {
  const source = await fs.readFile(path.join(projectRoot, 'build', 'installer.nsh'), 'utf8');
  const customInit = source.match(/!macro customInit\r?\n([\s\S]*?)!macroend/)?.[1];
  const customInstall = source.match(/!macro customInstall\r?\n([\s\S]*?)!macroend/)?.[1];

  assert.ok(customInit, 'customInit macro must exist');
  assert.ok(customInstall, 'customInstall macro must exist');

  const updateBranch = customInit.match(/\$\{If\} \$\{isUpdated\}([\s\S]*?)\$\{EndIf\}/)?.[1];
  assert.ok(updateBranch, 'update progress must be gated by electron-builder isUpdated');
  assert.match(updateBranch, /!insertmacro showSnapOverLANUpdateProgress/);
  const ui = await fs.readFile(path.join(projectRoot, 'build', 'update-progress-ui.nsh'), 'utf8');
  assert.match(source, /!include .*update-progress-ui\.nsh/);
  assert.match(ui, /Banner::show/);
  assert.match(ui, /"SnapOverLAN Update"/);
  assert.match(ui, /"Almost there!"/);
  assert.match(ui, /SnapOverLAN is being updated\./);
  assert.match(ui, /The app will reopen automatically\./);
  assert.match(ui, /This should only take a moment\./);
  assert.match(ui, /Banner::getWindow/);
  assert.match(ui, /GetDlgItem \$8 \$9 1030/);
  assert.match(ui, /GetDlgItem \$R6 \$9 76/);
  assert.match(ui, /FindWindow \$R7 "Static" "" \$9 \$8/);
  assert.match(ui, /GetWindowRect\(p r9, p r10\)/);
  assert.match(ui, /user32::SetWindowPos\(p r8/);
  assert.match(ui, /user32::RedrawWindow\(p r9/);
  assert.doesNotMatch(updateBranch, /\$\{Silent\}/);

  const outsideUpdateBranch = customInit.replace(/\$\{If\} \$\{isUpdated\}[\s\S]*?\$\{EndIf\}/, '');
  assert.doesNotMatch(outsideUpdateBranch, /Banner::show/);
  assert.match(customInstall, /StrCpy \$launchLink "\$appExe"/);
  assert.doesNotMatch(customInstall, /!insertmacro closeSnapOverLANUpdateProgress/);
  assert.match(customInstall, /\$\{If\} \$\{isUpdated\}\s+\$\{AndIf\} \$\{Silent\}\s+\$\{AndIf\} \$\{isForceRun\}\s+!insertmacro prepareSnapOverLANUpdateReadiness "\$appExe"/);
  assert.match(source, /Function \.onInstSuccess\s+!insertmacro finishSnapOverLANUpdateProgress/);
  assert.match(source, /Function \.onInstFailed\s+!insertmacro closeSnapOverLANUpdateProgress/);
  assert.match(source, /Function \.onGUIEnd\r?\n\s*!insertmacro closeSnapOverLANUpdateProgress/);
});

test('the installed builder launches before NSIS success and readiness is bounded', async () => {
  const templates = path.join(projectRoot, 'node_modules/app-builder-lib/templates/nsis');
  const install = await fs.readFile(path.join(templates, 'installSection.nsh'), 'utf8');
  const common = await fs.readFile(path.join(templates, 'common.nsh'), 'utf8');
  assert.ok(install.indexOf('!insertmacro customInstall') < install.lastIndexOf('!insertmacro doStartApp'));
  assert.match(install, /\$\{if\} \$\{isForceRun\}\s+\$\{andIf\} \$\{Silent\}\s+!insertmacro doStartApp/);
  assert.match(common, /!macro StartApp[\s\S]*StrCpy \$startAppArgs "--updated"[\s\S]*\$\{StdUtils.ExecShellAsUser\}/);
  const lifetime = await fs.readFile(path.join(projectRoot, 'build/update-progress-lifetime.nsh'), 'utf8');
  assert.match(lifetime, /!define SNAPOVERLAN_UPDATE_READY_TIMEOUT 90000/);
  const finish = lifetime.slice(lifetime.indexOf('!macro finishSnapOverLANUpdateProgress'));
  assert.ok(finish.indexOf('::$SnapOverLANUpdateWaitForReady') < finish.indexOf('!insertmacro closeSnapOverLANUpdateProgress'));
  assert.doesNotMatch(lifetime, /\bSleep\b|\bShowWindow\b/);
  const shell = await fs.readFile(path.join(projectRoot, 'app/desktop/shell.js'), 'utf8');
  const main = await fs.readFile(path.join(projectRoot, 'app/main.js'), 'utf8');
  assert.match(shell, /await mainWindow\.loadFile/);
  assert.match(main, /await desktopShell\.createWindow\(\);[\s\S]*desktopShell\.showMainWindow\(\);/);
});
