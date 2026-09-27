/* Read-only observation of the newly launched app window. No app/installer
 * control, injection, polling sleeps, or changes to the close-only helper.
 */
#define _WIN32_WINNT 0x0600
#include <windows.h>

typedef BOOL (WINAPI *QueryImageName)(HANDLE, DWORD, LPWSTR, PDWORD);
/* NSIS's configured string limit is 1024, including executable paths. */
static WCHAR expectedImage[1024];
static FILETIME armedAt;
static BOOL armed, ready;
static QueryImageName queryImageName;

static BOOL IsReadyWindow(HWND window)
{
    WCHAR name[64], image[1024];
    DWORD processId, length = 1024;
    FILETIME created, exited, kernel, user;
    HANDLE process;
    BOOL matches;
    if (!window || !IsWindowVisible(window) || IsIconic(window) ||
        GetAncestor(window, GA_ROOT) != window) return FALSE;
    if (!GetClassNameW(window, name, 64) ||
        lstrcmpW(name, L"Chrome_WidgetWin_1")) return FALSE;
    if (!GetWindowTextW(window, name, 64) ||
        lstrcmpW(name, L"SnapOverLAN")) return FALSE;
    GetWindowThreadProcessId(window, &processId);
    process = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, FALSE, processId);
    if (!process) return FALSE;
    matches = GetProcessTimes(process, &created, &exited, &kernel, &user) &&
        CompareFileTime(&created, &armedAt) >= 0 &&
        queryImageName(process, 0, image, &length) &&
        !lstrcmpiW(image, expectedImage);
    CloseHandle(process);
    return matches;
}

static BOOL CALLBACK FindReadyWindow(HWND window, LPARAM unused)
{
    if (IsReadyWindow(window)) ready = TRUE;
    return !ready;
}

static void CALLBACK WindowEvent(HWINEVENTHOOK hook, DWORD event, HWND window,
                                 LONG object, LONG child, DWORD thread, DWORD time)
{
    if (object == OBJID_WINDOW && child == 0 &&
        (event == EVENT_OBJECT_SHOW || event == EVENT_OBJECT_NAMECHANGE) &&
        IsReadyWindow(window)) ready = TRUE;
}

__declspec(dllexport) BOOL WINAPI Arm(LPCWSTR executable)
{
    DWORD length;
    armed = ready = FALSE;
    queryImageName = (QueryImageName)GetProcAddress(GetModuleHandleW(L"kernel32.dll"),
                                                   "QueryFullProcessImageNameW");
    if (!queryImageName || !executable || !*executable) return FALSE;
    length = GetFullPathNameW(executable, 1024, expectedImage, NULL);
    if (!length || length >= 1024) return FALSE;
    GetSystemTimeAsFileTime(&armedAt);
    armed = TRUE;
    return TRUE;
}

/* 1 = new app main window shown, 0 = timeout, 2 = preparation/wait failure.
 * Called AFTER electron-builder's normal launch, from NSIS .onInstSuccess.
 */
__declspec(dllexport) DWORD WINAPI WaitForReady(DWORD timeout)
{
    HWINEVENTHOOK hook;
    DWORD start, elapsed, result = 0;
    MSG message;
    if (!armed) return 2;
    if (timeout > 90000) timeout = 90000;
    start = GetTickCount();
    hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_NAMECHANGE, NULL,
                          WindowEvent, 0, 0, WINEVENT_OUTOFCONTEXT);
    /* Subscribe before scanning: covers both instant startup before this call
     * and a window appearing between subscription and enumeration.
     */
    EnumWindows(FindReadyWindow, 0);
    while (!ready) {
        elapsed = GetTickCount() - start;
        if (elapsed >= timeout) break;
        if (MsgWaitForMultipleObjects(0, NULL, FALSE, timeout - elapsed,
                                      QS_ALLINPUT) == WAIT_FAILED) {
            result = 2;
            break;
        }
        while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
            if (ready || GetTickCount() - start >= timeout) break;
        }
    }
    if (hook) UnhookWinEvent(hook);
    if (ready) result = 1;
    armed = FALSE;
    return result;
}
