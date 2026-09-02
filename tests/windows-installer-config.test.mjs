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
  assert.equal(nsis.runAfterFinish, false);
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
  assert.equal(packageJson.version, '1.0.1');
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
  assert.match(source, /firewall add rule name="\$\{SNAPOVERLAN_FIREWALL_RULE\}"[^\r\n]*protocol=TCP localport=8787 profile=private/);
  assert.match(source, /firewall add rule name="\$\{SNAPOVERLAN_MDNS_FIREWALL_RULE\}"[^\r\n]*protocol=UDP localport=5353 remoteip=localsubnet profile=private/);

  const deleteUploadRule = source.match(/firewall delete rule name="\$\{SNAPOVERLAN_FIREWALL_RULE\}"/g) || [];
  const deleteMdnsRule = source.match(/firewall delete rule name="\$\{SNAPOVERLAN_MDNS_FIREWALL_RULE\}"/g) || [];
  assert.equal(deleteUploadRule.length, 2, 'install and uninstall must both remove the TCP rule');
  assert.equal(deleteMdnsRule.length, 2, 'install and uninstall must both remove the mDNS rule');
});
