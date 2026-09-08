import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = file => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('preview contains only shared UI, window lifetime management, and an empty section', async () => {
  const harness = await read('build/update-ui-preview.nsi');
  const ui = await read('build/update-progress-ui.nsh');
  assert.match(harness, /RequestExecutionLevel user/);
  assert.match(harness, /!include "update-progress-ui.nsh"/);
  assert.match(harness, /!insertmacro showSnapOverLANUpdateProgress/);
  assert.match(harness, /!insertmacro closeSnapOverLANUpdateProgress/);
  assert.match(harness, /Section\s+SectionEnd/);
  assert.match(harness, /GetAsyncKeyState/);
  // Allow only this compile-time icon resource; it extracts no file at runtime.
  const iconResource = /^Icon "\$\{__FILEDIR__\}\\\.\.\\assets\\electron\\app\.ico"\r?$/gm;
  assert.match(ui, iconResource);
  const instructions = `${harness}\n${ui}`.replace(/;[^\n]*/g, '').replace(iconResource, '');
  assert.doesNotMatch(instructions, /installer\.nsh|electron|https?:|\b(?:File|SetOutPath|Write\w*|Delete(?!(?:Object|DC)\b)\w*|RMDir|Rename|Exec\w*|CreateShortCut|ReadReg\w*)\b/i);
  const calls = [...instructions.matchAll(/System::Call '([^']*)'/g)].map(match => match[1]);
  for (const call of calls) {
    assert.match(call, /^(?:\*|user32::(?:GetWindowRect|SetWindowPos|RedrawWindow|IsWindow|GetForegroundWindow|GetAsyncKeyState|GetDC|ReleaseDC|FillRect|DrawTextW|GetWindowLong|SetWindowLong|SetWindowRgn|GetSystemMetrics|LoadImageW)\(|gdi32::(?:GetDeviceCaps|CreateCompatibleDC|CreateCompatibleBitmap|SelectObject|CreateSolidBrush|DeleteObject|GetStockObject|RoundRect|SetBkMode|SetTextColor|DeleteDC|CreateRoundRectRgn)\(|kernel32::(?:MulDiv|GetModuleHandleW)\()/);
  }
});
