import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = await readFile(
  path.join(projectRoot, '.github', 'workflows', 'release.yml'),
  'utf8',
);

test('release workflow preserves the tested non-publishing build flow', () => {
  const installIndex = workflow.indexOf('run: npm ci');
  const testIndex = workflow.indexOf('run: node --test');
  const buildIndex = workflow.indexOf('run: npm run release:build');

  assert.ok(installIndex >= 0);
  assert.ok(testIndex > installIndex);
  assert.ok(buildIndex > testIndex);
  assert.match(workflow, /Verify tag matches desktop version[\s\S]*?package\.json[\s\S]*?github\.ref_name/);
  assert.doesNotMatch(workflow, /electron-builder[^\n]*--publish(?:\s+|:)always/);
});

test('release verification requires every updater and companion artifact', () => {
  assert.match(workflow, /\$packageVersion = node -p "require\('\.\/package\.json'\)\.version"/);
  assert.match(workflow, /\$extensionVersion = node -p "require\('\.\/extension\/manifest\.json'\)\.version"/);
  assert.match(workflow, /"dist\/latest\.yml"/);
  assert.match(workflow, /"dist\/\$installerName"/);
  assert.match(workflow, /"dist\/\$installerName\.blockmap"/);
  assert.match(workflow, /"dist\/SnapOverLAN-\$packageVersion-portable-x64\.exe"/);
  assert.match(workflow, /"dist\/SnapOverLAN-extension-\$extensionVersion\.zip"/);
  assert.match(workflow, /Test-Path -LiteralPath \$artifact -PathType Leaf/);
  assert.match(workflow, /Expected release artifact was not generated/);
  assert.match(workflow, /Get-Item -LiteralPath \$artifact[\s\S]*?Length -le 0/);
});

test('release verification rejects incompatible generated update metadata', () => {
  assert.match(workflow, /dist\/latest\.yml does not match package\.json version/);
  assert.match(workflow, /dist\/latest\.yml does not point to \$installerName/);
  assert.match(workflow, /dist\/latest\.yml file URL does not point to \$installerName/);
  assert.match(workflow, /dist\/latest\.yml does not contain an installer sha512/);
  assert.match(workflow, /installer size does not match/);
  assert.match(workflow, /obsolete space-containing installer name/);
  assert.match(workflow, /owner:\\s\*azbejagodic/);
  assert.match(workflow, /repo:\\s\*SnapOverLAN/);
  assert.match(workflow, /provider:\\s\*github/);
});

test('published release assets use exact dynamic filenames from one build', () => {
  assert.match(workflow, /uses: softprops\/action-gh-release@v3/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(workflow, /draft: false/);
  assert.match(workflow, /fail_on_unmatched_files: true/);
  assert.match(workflow, /dist\/latest\.yml/);
  assert.match(
    workflow,
    /dist\/SnapOverLAN-Setup-\$\{\{ steps\.versions\.outputs\.desktop_version \}\}-x64\.exe\n/,
  );
  assert.match(
    workflow,
    /dist\/SnapOverLAN-Setup-\$\{\{ steps\.versions\.outputs\.desktop_version \}\}-x64\.exe\.blockmap/,
  );
  assert.match(
    workflow,
    /dist\/SnapOverLAN-\$\{\{ steps\.versions\.outputs\.desktop_version \}\}-portable-x64\.exe/,
  );
  assert.match(
    workflow,
    /dist\/SnapOverLAN-extension-\$\{\{ steps\.versions\.outputs\.extension_version \}\}\.zip/,
  );
  assert.doesNotMatch(workflow, /dist\/SnapOverLAN Setup/);
});
