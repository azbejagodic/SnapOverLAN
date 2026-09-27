/* Controlled startup fixture: the test, not a sleep, decides when it is ready.
 * Same native class/title as the inspected Electron main window. No install IO.
 */
#include <windows.h>

static LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM w, LPARAM l)
{
    if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window, message, w, l);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR args, int show)
{
    WCHAR config[MAX_PATH], eventName[128];
    WNDCLASSW cls = {0};
    HWND window;
    HANDLE readyEvent;
    MSG message;
    DWORD length;
    GetModuleFileNameW(NULL, config, MAX_PATH);
    length = lstrlenW(config);
    while (length && config[length - 1] != L'\\') --length;
    lstrcpyW(config + length, L"startup-fixture.ini");
    if (GetPrivateProfileIntW(L"test", L"ExitEarly", 0, config)) return 0;
    GetPrivateProfileStringW(L"test", L"ReadyEvent", L"", eventName, 128, config);
    readyEvent = OpenEventW(SYNCHRONIZE, FALSE, eventName);
    if (!readyEvent) return 2;
    cls.lpfnWndProc = WindowProc;
    cls.hInstance = instance;
    cls.lpszClassName = L"Chrome_WidgetWin_1";
    RegisterClassW(&cls);
    window = CreateWindowW(cls.lpszClassName, L"SnapOverLAN", WS_OVERLAPPEDWINDOW,
                           CW_USEDEFAULT, CW_USEDEFAULT, 400, 200, NULL, NULL, instance, NULL);
    /* Start hidden, just as createDesktopShell does while awaiting loadFile. */
    for (;;) {
        DWORD result = MsgWaitForMultipleObjects(1, &readyEvent, FALSE, INFINITE, QS_ALLINPUT);
        if (result == WAIT_OBJECT_0) break;
        while (PeekMessageW(&message, NULL, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) { CloseHandle(readyEvent); return 0; }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    CloseHandle(readyEvent);
    ShowWindow(window, SW_SHOW);
    while (GetMessageW(&message, NULL, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    return 0;
}
