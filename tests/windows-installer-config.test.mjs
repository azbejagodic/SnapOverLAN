import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Windows Setup remains an all-users assisted installer', async () => {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const { nsis } = packageJson.build;

  assert.equal(nsis.oneClick, false);
  assert.equal(nsis.perMachine, true);
  assert.equal(nsis.allowToChangeInstallationDirectory, false);
  assert.equal(nsis.runAfterFinish, false);
  assert.equal(nsis.createStartMenuShortcut, true);
  assert.equal(nsis.createDesktopShortcut, true);
  assert.equal(nsis.shortcutName, 'SnapOverLAN');
  assert.equal(nsis.include, 'build/installer.nsh');
  assert.equal(nsis.artifactName, '${productName} Setup ${version}-${arch}.${ext}');
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
