# Update-progress close handler

`update-progress-close.dll` is an x86 DLL for the x86 NSIS installer engine
(including installers that package the x64 app). Its only purpose is to hide
the Banner window on user close. It does not invoke NSIS, cancel installation,
or launch/terminate processes. The checked-in DLL avoids a C compiler dependency
for ordinary installer and preview builds.

Banner 3.04 creates its dialog on a separate thread, destroys it on `WM_CLOSE`,
and implements `Banner::destroy` by posting that same message and waiting:
https://github.com/kichik/nsis/blob/25cf71ac318c73016d0706add96f25ef70ccd4f7/Contrib/Banner/Banner.c

The helper subclasses only the supplied window in the current process. It
consumes `WM_CLOSE` and `WM_SYSCOMMAND/SC_CLOSE` with `ShowWindow(SW_HIDE)`;
all other messages go to the original procedure. Cleanup calls `AllowDestroy`
before `Banner::destroy`, restores the original procedure on `WM_NCDESTROY`,
and unloads the helper only after Banner has finished. Attachment failure
leaves X disabled so installation can continue safely.

Build from the repository root using portable TinyCC 0.9.27 **win32**:

```powershell
& .\.cache\popup-close-tools\tcc\tcc.exe -shared -o build/native/update-progress-close.dll build/native/update-progress-close.c -luser32
```

Compiler archive: https://download.savannah.gnu.org/releases/tinycc/tcc-0.9.27-win32-bin.zip

Archive SHA-256: `02E2BFE8C272A549B15E4BFA4507BD7E05304692AF1761DB6C1E8E88AF675651`.
The compiler is a build-time tool only and is not shipped with the application.

The compiler also emits `update-progress-close.def`, recording the x86 stdcall
exports used by NSIS. DLL SHA-256:
`4CFEEADF6D81BE38D6B2EE505D841E10D36D57A3877B4AA6223B743157CA1C93`.

## Update readiness observer

`update-progress-ready.dll` is a separate x86 helper. The close handler above
is unchanged. No Electron code or launch arguments are modified.

The installed electron-builder 26.15.3 templates run `customInstall` before
`StartApp`. For this assisted, silent update, `--force-run` triggers
`StdUtils.ExecShellAsUser` with `--updated`. NSIS 3.04 then calls
`.onInstSuccess` after the install section completes. Its silent success path
does not call `.onGUIEnd`:
https://github.com/kichik/nsis/blob/25cf71ac318c73016d0706add96f25ef70ccd4f7/Source/exehead/Ui.c

`customInstall` now arms the observer only for `isUpdated && Silent && isForceRun`,
recording the installed executable path and current time. `.onInstSuccess`
waits for a visible, non-minimized top-level `Chrome_WidgetWin_1` window titled
`SnapOverLAN`, owned by that executable in a process created after arming.
This is the main window created by `app/desktop/shell.js`; `app/main.js` shows
it only after `createWindow()` has awaited `loadFile()`.

The observer subscribes to Windows show/name-change events, then enumerates
existing windows to cover an app that opened before the wait started. It has
no polling sleeps, does not show any window, and does not inject into the app.
The normal cleanup trigger is **the newly launched main window becoming visible**.
After 90 seconds without readiness (or a preparation/wait error), it cleans up
and allows Setup to exit successfully. This is a maximum wait, not an added
delay on successful startup. X remains hide-only throughout the wait.

The event hook is removed before returning; inspected process handles are
closed immediately. Success then destroys Banner, deletes its bitmap, and
unloads both helper DLLs. `.onGUIEnd` and `.onInstFailed` provide safety cleanup.
No files, named events, or registry values are used as readiness markers.

Rebuild the observer from the repository root:

```powershell
& .\.cache\popup-close-tools\tcc\tcc.exe -shared -o build/native/update-progress-ready.dll build/native/update-progress-ready.c -luser32
```

Observer DLL SHA-256:
`6DBD6B13C6C4B802044EAF46E2403B8D94284B534CB4370C44A10453D876B2CA`.

Run the controlled Windows lifecycle tests (requires TinyCC above and the
electron-builder NSIS cache, or pass `-Compiler` pointing to win32 TinyCC):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tests/update-progress-lifetime.ps1
```

The harness uses the real builder `StartApp` macro and the production readiness
macros. Its test app stays hidden until a test-owned event tells it to show.
The tests cover delayed startup, X-hidden startup, timeout, early app exit,
an old process, a different executable with the same window title/class, and
manual mode. They assert successful exit and window/bitmap/DLL cleanup. Only
the test timeout is shortened to five seconds; production stays at 90 seconds.
Nothing is installed or published by the harness.
