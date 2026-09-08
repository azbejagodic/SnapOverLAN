!ifndef SNAPOVERLAN_UPDATE_PROGRESS_UI
!define SNAPOVERLAN_UPDATE_PROGRESS_UI

; Shared native visuals only. No installation or update operations belong here.
!macro showSnapOverLANUpdateProgress
  Banner::show /set 76 "Updating SnapOverLAN…" /set 1030 "Installing the latest version.$\r$\nSnapOverLAN will reopen automatically.$\r$\nThis may take up to 30 seconds." "SnapOverLAN Update"
  Banner::getWindow
  Pop $9
  GetDlgItem $8 $9 1030
  GetDlgItem $R6 $9 76
  ; The stock Banner icon uses control ID -1. In the dialog order it is the
  ; Static immediately after the known body control.
  FindWindow $R7 "Static" "" $9 $8
  ShowWindow $9 ${SW_HIDE}

  ; Use the stock Banner dialog, heading, body, and icon controls. Lay them out
  ; once while hidden so resizing cannot leave stale/duplicated text behind.
  System::Call '*(i, i, i, i) p.r10'
  System::Call 'user32::GetWindowRect(p r9, p r10)'
  System::Call '*$R0(i .r0, i .r1, i .r2, i .r3)'
  System::Free $R0
  System::Call '*(i, i, i, i) p.r10'
  System::Call 'user32::GetWindowRect(p r8, p r10)'
  System::Call '*$R0(i .r4, i .r5, i .r6, i .r7)'
  System::Free $R0

  ; The original body height is one dialog-font line. Use it as the DPI-aware
  ; layout unit: 27x10 units produces about 432x160 px at 100% scaling.
  IntOp $R5 $7 - $5
  IntOp $4 $2 + $0
  IntOp $4 $4 / 2
  IntOp $5 $3 + $1
  IntOp $5 $5 / 2
  IntOp $2 $R5 * 27
  IntOp $3 $R5 * 10
  IntOp $0 $2 / 2
  IntOp $0 $4 - $0
  IntOp $1 $3 / 2
  IntOp $1 $5 - $1

  ; Resize the window around its existing center.
  System::Call 'user32::SetWindowPos(p r9, p 0, i r0, i r1, i r2, i r3, i 0x14)'

  ; Content geometry: 1.5-unit outer margin, 4.5-unit text inset, and enough
  ; height for one heading plus the three body lines with breathing room.
  IntOp $0 $R5 / 2
  IntOp $1 $R5 + $0
  IntOp $2 $R5 * 4
  IntOp $2 $2 + $0
  IntOp $3 $R5 * 27
  IntOp $3 $3 - $2
  IntOp $3 $3 - $1
  IntOp $3 $3 - $R5
  IntOp $4 $R5 * 3
  System::Call 'user32::SetWindowPos(p r17, p 0, i r1, i r4, i 0, i 0, i 0x15)'
  StrCpy $4 $R5
  IntOp $5 $R5 * 2
  System::Call 'user32::SetWindowPos(p r16, p 0, i r2, i r4, i r3, i r5, i 0x14)'
  IntOp $4 $R5 * 3
  IntOp $5 $R5 * 4
  System::Call 'user32::SetWindowPos(p r8, p 0, i r2, i r4, i r3, i r5, i 0x14)'

  ; 0x185 = invalidate, erase, redraw all children, and update immediately.
  ShowWindow $9 ${SW_SHOW}
  System::Call 'user32::RedrawWindow(p r9, p 0, p 0, i 0x185)'
  StrCpy $SnapOverLANUpdateProgressVisible "1"
!macroend

!macro closeSnapOverLANUpdateProgress
  ${If} $SnapOverLANUpdateProgressVisible == "1"
    Banner::destroy
    StrCpy $SnapOverLANUpdateProgressVisible "0"
    ; Banner can reveal its owner when it closes. Keep the silent installer hidden.
    ${If} ${Silent}
      HideWindow
    ${EndIf}
  ${EndIf}
!macroend
!endif
