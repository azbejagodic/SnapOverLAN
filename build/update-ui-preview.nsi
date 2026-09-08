; Standalone visual harness: deliberately never include installer.nsh or Builder.
Unicode true
Name "SnapOverLAN UI Preview"
OutFile "${PREVIEW_OUT}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
!include "LogicLib.nsh"
!include "WinMessages.nsh"
!include "update-progress-ui.nsh"

Var SnapOverLANUpdateProgressVisible

Function .onInit
  StrCpy $SnapOverLANUpdateProgressVisible "0"
  !insertmacro showSnapOverLANUpdateProgress
  ; Leave every visual property untouched. Escape closes only while focused.
  ${Do}
    Sleep 50
    System::Call 'user32::IsWindow(p r9) i.r0'
    ${If} $0 == 0
      ${ExitDo}
    ${EndIf}
    System::Call 'user32::GetForegroundWindow() p.r0'
    ${If} $0 == $9
      System::Call 'user32::GetAsyncKeyState(i 0x1B) i.r0'
      IntOp $0 $0 & 0x8000
      ${If} $0 != 0
        ${ExitDo}
      ${EndIf}
    ${EndIf}
  ${Loop}
  !insertmacro closeSnapOverLANUpdateProgress
  Quit
FunctionEnd

Function .onGUIEnd
  !insertmacro closeSnapOverLANUpdateProgress
FunctionEnd

; NSIS requires a section. It is empty and never reached.
Section
SectionEnd
