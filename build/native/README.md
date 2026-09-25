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
