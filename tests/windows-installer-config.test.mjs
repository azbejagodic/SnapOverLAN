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

test('update feed is separate from canonical source metadata without automatic publishing', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));

  assert.deepEqual(packageJson.repository, {
    type: 'git',
    url: 'https://github.com/azbejagodic/SnapOverLAN.git',
  });
  assert.deepEqual(packageJson.build.publish, [{
    provider: 'github',
    owner: 'azbejagodic',
    repo: 'SnapOverLAN-Releases',
  }]);
  assert.match(packageJson.scripts.dist, /electron-builder --win --publish never/);
  assert.equal(packageJson.version, '2.0.0');
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
  assert.match(source, /firewall add rule name="\$\{SNAPOVERLAN_FIREWALL_RULE\}"[^\r\n]*protocol=TCP localport=8787 profile=private/);
  assert.match(source, /firewall add rule name="\$\{SNAPOVERLAN_MDNS_FIREWALL_RULE\}"[^\r\n]*protocol=UDP localport=5353 remoteip=localsubnet profile=private/);

  const deleteUploadRule = source.match(/firewall delete rule name="\$\{SNAPOVERLAN_FIREWALL_RULE\}"/g) || [];
  const deleteMdnsRule = source.match(/firewall delete rule name="\$\{SNAPOVERLAN_MDNS_FIREWALL_RULE\}"/g) || [];
  assert.equal(deleteUploadRule.length, 2, 'install and uninstall must both remove the TCP rule');
  assert.equal(deleteMdnsRule.length, 2, 'install and uninstall must both remove the mDNS rule');
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
  assert.match(ui, /"Updating SnapOverLAN"/);
  assert.match(ui, /Installing the latest update\./);
  assert.match(ui, /SnapOverLAN will reopen automatically\./);
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
  assert.match(customInstall, /!insertmacro closeSnapOverLANUpdateProgress/);
  assert.match(source, /Function \.onGUIEnd\r?\n\s*!insertmacro closeSnapOverLANUpdateProgress/);
});
