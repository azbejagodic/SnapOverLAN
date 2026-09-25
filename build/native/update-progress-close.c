/* Native code only: Banner owns its window on a separate thread from NSIS.
 * Never run NSIS script callbacks or change installer state on that thread.
 * This DLL is loaded only by the update-progress macro, not manual Setup.
 */
#include <windows.h>

static HWND progressWindow;
static WNDPROC bannerProc;
static volatile LONG allowDestroy;

static LRESULT CALLBACK ProgressProc(HWND window, UINT message,
                                     WPARAM wParam, LPARAM lParam)
{
    WNDPROC original = bannerProc;
    if (!InterlockedCompareExchange(&allowDestroy, 0, 0) &&
        (message == WM_CLOSE ||
         (message == WM_SYSCOMMAND && (wParam & 0xfff0) == SC_CLOSE))) {
        ShowWindow(window, SW_HIDE);
        return 0;
    }
    if (message == WM_NCDESTROY) {
        /* Restore on the owning thread, before Banner completes destruction. */
        SetWindowLongPtrW(window, GWLP_WNDPROC, (LONG_PTR)original);
        progressWindow = NULL;
    }
    return CallWindowProcW(original, window, message, wParam, lParam);
}

__declspec(dllexport) BOOL WINAPI Attach(HWND window)
{
    DWORD processId = 0;
    if (progressWindow || !IsWindow(window)) return FALSE;
    GetWindowThreadProcessId(window, &processId);
    if (processId != GetCurrentProcessId()) return FALSE;
    bannerProc = (WNDPROC)GetWindowLongPtrW(window, GWLP_WNDPROC);
    if (!bannerProc) return FALSE;
    progressWindow = window;
    InterlockedExchange(&allowDestroy, 0);
    /* All callback state is initialized before installing the procedure.
     * SetWindowLongPtr supports another thread in this same process; unlike
     * SetWindowSubclass, it does not require an owner-thread callback to attach.
     */
    SetLastError(0);
    if (!SetWindowLongPtrW(window, GWLP_WNDPROC, (LONG_PTR)ProgressProc) &&
        GetLastError()) {
        progressWindow = NULL;
        return FALSE;
    }
    return TRUE;
}

__declspec(dllexport) void WINAPI AllowDestroy(void)
{
    /* Banner::destroy posts WM_CLOSE and waits for its thread to finish.
     * Permit that close without invoking NSIS from the Banner thread.
     */
    InterlockedExchange(&allowDestroy, 1);
}
