!ifndef SNAPOVERLAN_UPDATE_PROGRESS_UI
!define SNAPOVERLAN_UPDATE_PROGRESS_UI

; Reuse the existing application icon as an embedded resource, without extracting
; an asset at runtime. Builder already uses this same ICO for Windows Setup.
Icon "${__FILEDIR__}\..\assets\electron\app.ico"
!define SNAPOVERLAN_PROGRESS_CLOSE_DLL "${__FILEDIR__}\native\update-progress-close.dll"

; Shared native visuals only; production and preview both call these macros.
; Original 432 x 192 client artwork: #343940 shell, #aeefff cyan panel,
; 4px inset, 8px panel radius, and unchanged centered text rectangles.
; Banner has no WM_CTLCOLOR handler. Paint once with GDI into the existing
; Static, which then handles repaints itself. Close handling is native code
; because Banner's window lives on a separate thread from the NSIS interpreter.
Var SnapOverLANUpdateBitmap
Var SnapOverLANUpdateCenterX2
Var SnapOverLANUpdateCenterY2
Var SnapOverLANUpdateCloseModule
Var SnapOverLANUpdateAllowDestroy

!macro showSnapOverLANUpdateProgress
  Banner::show /set 76 "Almost there!" /set 1030 "SnapOverLAN is being updated.$\r$\nThe app will reopen automatically.$\r$\n$\r$\nThis should only take a moment." "SnapOverLAN Update"
  Banner::getWindow
  Pop $9
  ; Save twice the original center before changing styles or dimensions.
  ; Dedicated variables avoid temporary drawing registers changing the anchor.
  System::Call '*(i, i, i, i) p.r10'
  System::Call 'user32::GetWindowRect(p r9, p r10)'
  System::Call '*$R0(i .r0, i .r1, i .r2, i .r3)'
  System::Free $R0
  IntOp $SnapOverLANUpdateCenterX2 $0 + $2
  IntOp $SnapOverLANUpdateCenterY2 $1 + $3
  ; Set Banner's native taskbar/Alt+Tab icons, not the cyan content controls.
  ; NSIS Icon embeds group icon 103. LR_SHARED keeps ownership with Windows.
  System::Call 'kernel32::GetModuleHandleW(p 0) p.r0'
  System::Call 'user32::GetSystemMetrics(i 49) i.r1' ; SM_CXSMICON
  System::Call 'user32::GetSystemMetrics(i 50) i.r2' ; SM_CYSMICON
  System::Call 'user32::LoadImageW(p r0, p 103, i 1, i r1, i r2, i 0x8000) p.r3'
  SendMessage $9 ${WM_SETICON} 0 $3
  System::Call 'user32::GetSystemMetrics(i 11) i.r1' ; SM_CXICON
  System::Call 'user32::GetSystemMetrics(i 12) i.r2' ; SM_CYICON
  System::Call 'user32::LoadImageW(p r0, p 103, i 1, i r1, i r2, i 0x8000) p.r3'
  SendMessage $9 ${WM_SETICON} 1 $3
  GetDlgItem $8 $9 1030
  GetDlgItem $R6 $9 76
  FindWindow $R7 "Static" "" $9 $8
  ShowWindow $9 ${SW_HIDE}

  ; Classic and Modern UI resources have different fonts. Use device DPI
  ; so both callers render the same dimensions, typography, and spacing.
  System::Call 'user32::GetDC(p r9) p.r0'
  System::Call 'gdi32::GetDeviceCaps(p r0, i 90) i.r15'
  ; Width and height: 432 x 192 logical pixels at 96 DPI.
  System::Call 'kernel32::MulDiv(i 432, i r15, i 96) i.r12'
  System::Call 'kernel32::MulDiv(i 192, i r15, i 96) i.r11'
  System::Call 'gdi32::CreateCompatibleDC(p r0) p.r14'
  System::Call 'gdi32::CreateCompatibleBitmap(p r0, i r12, i r11) p.r1'
  StrCpy $SnapOverLANUpdateBitmap $1
  System::Call 'user32::ReleaseDC(p r9, p r0)'
  System::Call 'gdi32::SelectObject(p r14, p r1) p.r13'

  ; GDI COLORREF uses BBGGRR; these are exact CSS RGB values, not new colors.
  System::Call 'gdi32::CreateSolidBrush(i 0x403934) p.r0' ; #343940 shell
  System::Call '*(i 0, i 0, i r12, i r11) p.r10'
  System::Call 'user32::FillRect(p r14, p r10, p r0)'
  System::Free $R0
  System::Call 'gdi32::DeleteObject(p r0)'
  System::Call 'gdi32::CreateSolidBrush(i 0xFFEFAE) p.r0' ; #aeefff panel
  System::Call 'gdi32::SelectObject(p r14, p r0) p.r1'
  System::Call 'gdi32::GetStockObject(i 8) p.r2' ; NULL_PEN: no extra border
  System::Call 'gdi32::SelectObject(p r14, p r2) p.r3'
  System::Call 'kernel32::MulDiv(i 4, i r15, i 96) i.r4'
  IntOp $5 $R2 - $4
  IntOp $6 $R1 - $4
  ; Original 8px panel radius (16px diameter); applies only to the bitmap.
  System::Call 'kernel32::MulDiv(i 16, i r15, i 96) i.r7'
  System::Call 'gdi32::RoundRect(p r14, i r4, i r4, i r5, i r6, i r7, i r7)'
  System::Call 'gdi32::SelectObject(p r14, p r1)'
  System::Call 'gdi32::SelectObject(p r14, p r3)'
  System::Call 'gdi32::DeleteObject(p r0)'
  System::Call 'gdi32::SetBkMode(p r14, i 1)' ; transparent text background

  ; Windows system-ui fallback for Inter WOFF2. Release fonts after rasterizing.
  CreateFont $0 "Segoe UI" 13 700
  System::Call 'gdi32::SelectObject(p r14, p r0) p.r1'
  System::Call 'gdi32::SetTextColor(p r14, i 0x261C0D)' ; #0d1c26 heading
  !insertmacro SnapOverLANUpdateTextRect 26 44 406 68
  System::Call 'user32::DrawTextW(p r14, w "Almost there!", i -1, p r10, i 0x825)'
  System::Free $R0
  System::Call 'gdi32::SelectObject(p r14, p r1)'
  System::Call 'gdi32::DeleteObject(p r0)'
  CreateFont $0 "Segoe UI" 10 400
  System::Call 'gdi32::SelectObject(p r14, p r0) p.r1'
  System::Call 'gdi32::SetTextColor(p r14, i 0x534329)' ; #294353 body
  !insertmacro SnapOverLANUpdateTextRect 26 76 406 112
  System::Call 'user32::DrawTextW(p r14, w "SnapOverLAN is being updated.$\r$\nThe app will reopen automatically.", i -1, p r10, i 0x801)'
  System::Free $R0
  !insertmacro SnapOverLANUpdateTextRect 26 124 406 148
  System::Call 'user32::DrawTextW(p r14, w "This should only take a moment.", i -1, p r10, i 0x825)'
  System::Free $R0
  System::Call 'gdi32::SelectObject(p r14, p r1)'
  System::Call 'gdi32::DeleteObject(p r0)'
  System::Call 'gdi32::SelectObject(p r14, p r13)'
  System::Call 'gdi32::DeleteDC(p r14)'

  ; Keep Banner and its existing body Static. Hide the other Modern UI visuals
  ; (absent in the classic preview resource); never show duplicate text/icons.
  ShowWindow $R6 ${SW_HIDE}
  ShowWindow $R7 ${SW_HIDE}
  System::Call 'user32::GetWindowLong(p r8, i -16) i.r0'
  IntOp $0 $0 & 0xFFFFFFE0
  IntOp $0 $0 | 0xE ; SS_BITMAP
  System::Call 'user32::SetWindowLong(p r8, i -16, i r0)'
  SendMessage $8 0x172 0 $SnapOverLANUpdateBitmap ; STM_SETIMAGE / IMAGE_BITMAP
  System::Call 'user32::SetWindowPos(p r8, p 0, i 0, i 0, i r12, i r11, i 0x34)'

  ; Native caption/system menu/minimize button, with no resize or maximize.
  ; Clear DS_MODALFRAME too so Windows can display the small caption icon.
  System::Call 'user32::GetWindowLong(p r9, i -16) i.r0'
  IntOp $0 $0 & 0xFFFAFF7F ; ~(WS_THICKFRAME | WS_MAXIMIZEBOX | DS_MODALFRAME)
  IntOp $0 $0 | 0x00CA0000 ; WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX
  System::Call 'user32::SetWindowLong(p r9, i -16, i r0)'
  StrCpy $4 $0
  System::Call 'user32::GetWindowLong(p r9, i -20) i.r5'
  IntOp $5 $5 & 0xFFFFFC7E ; remove modal/tool-window and extra edge styles
  IntOp $5 $5 | 0x00040000 ; WS_EX_APPWINDOW: taskbar restore while minimized
  System::Call 'user32::SetWindowLong(p r9, i -20, i r5)'
  System::Call 'user32::SetWindowTextW(p r9, w "SnapOverLAN Update")'
  ; Keep Close disabled until the native hide-only handler is installed.
  System::Call 'user32::GetSystemMenu(p r9, i 0) p.r0'
  System::Call 'user32::EnableMenuItem(p r0, i 0xF060, i 1)' ; SC_CLOSE / MF_GRAYED

  ; Keep the full 432 x 192 DPI-scaled client bitmap; add native frame space.
  System::Call '*(i 0, i 0, i r12, i r11) p.r10'
  System::Call 'user32::AdjustWindowRectEx(p r10, i r4, i 0, i r5)'
  System::Call '*$R0(i .r0, i .r1, i .r6, i .r7)'
  System::Free $R0
  IntOp $6 $6 - $0
  IntOp $7 $7 - $1
  ; Center the OUTER window (including caption/frame) on the saved Banner center.
  IntOp $0 $SnapOverLANUpdateCenterX2 - $6
  IntOp $0 $0 / 2
  IntOp $1 $SnapOverLANUpdateCenterY2 - $7
  IntOp $1 $1 / 2
  System::Call 'user32::SetWindowPos(p r9, p 0, i r0, i r1, i r6, i r7, i 0x34)'

  ; Supported DWM caption styling; unsupported attributes leave Windows defaults.
  ; Honor high contrast. No custom non-client painting or window region is used.
  System::Call '*(i 12, i 0, p 0) p.r0' ; HIGHCONTRASTW (32-bit NSIS)
  System::Call 'user32::SystemParametersInfoW(i 0x42, i 12, p r0, i 0) i.r1'
  System::Call '*$0(i, i .r2)'
  System::Free $0
  IntOp $2 $2 & 1 ; HCF_HIGHCONTRASTON
  ${If} $1 != 0
  ${AndIf} $2 == 0
    System::Call 'dwmapi::DwmSetWindowAttribute(p r9, i 20, *i 1, i 4)'
    System::Call 'dwmapi::DwmSetWindowAttribute(p r9, i 35, *i 0x403934, i 4)' ; #343940 shell (COLORREF)
    System::Call 'dwmapi::DwmSetWindowAttribute(p r9, i 36, *i 0xFFFDF5, i 4)'
  ${EndIf}

  ; This macro is used only for ${isUpdated} (or the standalone UI preview).
  ; Keep the DLL loaded until Banner::destroy has finished, even after X hides
  ; the window. A failed attachment leaves Close disabled, never unsafe.
  InitPluginsDir
  File "/oname=$PLUGINSDIR\SnapOverLANProgressClose.dll" "${SNAPOVERLAN_PROGRESS_CLOSE_DLL}"
  System::Call 'kernel32::LoadLibraryW(w "$PLUGINSDIR\SnapOverLANProgressClose.dll") p.s'
  Pop $SnapOverLANUpdateCloseModule
  StrCpy $1 0
  ${If} $SnapOverLANUpdateCloseModule != 0
    System::Call 'kernel32::GetProcAddress(p $SnapOverLANUpdateCloseModule, m "_AllowDestroy@0") p.s'
    Pop $SnapOverLANUpdateAllowDestroy
    System::Call 'kernel32::GetProcAddress(p $SnapOverLANUpdateCloseModule, m "_Attach@4") p.r0'
    ${If} $0 != 0
    ${AndIf} $SnapOverLANUpdateAllowDestroy != 0
      System::Call '::$0(p r9) i.r1'
    ${EndIf}
    ${If} $1 != 0
      System::Call 'user32::GetSystemMenu(p r9, i 0) p.r0'
      System::Call 'user32::EnableMenuItem(p r0, i 0xF060, i 0)' ; SC_CLOSE / MF_ENABLED
    ${Else}
      System::Call 'kernel32::FreeLibrary(p $SnapOverLANUpdateCloseModule)'
      StrCpy $SnapOverLANUpdateCloseModule 0
      StrCpy $SnapOverLANUpdateAllowDestroy 0
    ${EndIf}
  ${EndIf}

  ShowWindow $9 ${SW_SHOW}
  System::Call 'user32::RedrawWindow(p r9, p 0, p 0, i 0x185)'
  ; This flag tracks resources awaiting cleanup, including a user-hidden window.
  StrCpy $SnapOverLANUpdateProgressVisible "1"
!macroend

; Temporary RECT in R0, coordinates scaled from the project's pixel spacing.
!macro SnapOverLANUpdateTextRect LEFT TOP RIGHT BOTTOM
  System::Call 'kernel32::MulDiv(i ${LEFT}, i r15, i 96) i.r2'
  System::Call 'kernel32::MulDiv(i ${TOP}, i r15, i 96) i.r3'
  System::Call 'kernel32::MulDiv(i ${RIGHT}, i r15, i 96) i.r4'
  System::Call 'kernel32::MulDiv(i ${BOTTOM}, i r15, i 96) i.r5'
  System::Call '*(i r2, i r3, i r4, i r5) p.r10'
!macroend

!macro closeSnapOverLANUpdateProgress
  ${If} $SnapOverLANUpdateProgressVisible == "1"
    ${If} $SnapOverLANUpdateCloseModule != 0
      System::Call '::$SnapOverLANUpdateAllowDestroy()'
    ${EndIf}
    Banner::destroy
    ${If} $SnapOverLANUpdateCloseModule != 0
      System::Call 'kernel32::FreeLibrary(p $SnapOverLANUpdateCloseModule)'
      StrCpy $SnapOverLANUpdateCloseModule 0
      StrCpy $SnapOverLANUpdateAllowDestroy 0
    ${EndIf}
    System::Call 'gdi32::DeleteObject(p $SnapOverLANUpdateBitmap)'
    StrCpy $SnapOverLANUpdateProgressVisible "0"
    ; Banner can reveal its owner when it closes. Keep the silent installer hidden.
    ${If} ${Silent}
      HideWindow
    ${EndIf}
  ${EndIf}
!macroend
!endif
