; Controlled UI/lifecycle harness: no install, registry, firewall, or app writes.
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${HARNESS_OUTPUT}"
!define PRODUCT_NAME "SnapOverLAN lifecycle test"
!define PRODUCT_FILENAME "SnapOverLAN lifecycle test"
!define VERSION "0.0.0"
!define isUpdated '$HarnessUpdated == 1'
!include "LogicLib.nsh"
!include "MUI2.nsh"
!include "FileFunc.nsh"
!addincludedir "${BUILDER_TEMPLATES}\include"
!addplugindir /x86-unicode "${NSIS_RESOURCES}\plugins\x86-unicode"
!include "StdUtils.nsh"
; Exercise the actual installed builder StartApp macro, including launch args.
!include "${BUILDER_TEMPLATES}\common.nsh"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!include "${PROJECT_ROOT}\build\update-progress-ui.nsh"
!include "${PROJECT_ROOT}\build\update-progress-lifetime.nsh"
Var SnapOverLANUpdateProgressVisible
Var launchLink
Var SavedWindow
Var SavedBitmap
Var HarnessUpdated

Function .onInit
  StrCpy $HarnessUpdated 1
  StrCpy $SnapOverLANUpdateProgressVisible 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--manual" $1
  ${IfNot} ${Errors}
    StrCpy $HarnessUpdated 0
  ${EndIf}
  ${If} ${isUpdated}
    !insertmacro showSnapOverLANUpdateProgress
    StrCpy $SavedWindow $9
    StrCpy $SavedBitmap $SnapOverLANUpdateBitmap
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  !insertmacro closeSnapOverLANUpdateProgress
  !insertmacro cleanupSnapOverLANUpdateReadiness
FunctionEnd

Function .onInstSuccess
  !insertmacro finishSnapOverLANUpdateProgress
  System::Call 'user32::IsWindow(p $SavedWindow) i.r0'
  System::Alloc 24
  Pop $1
  System::Call 'gdi32::GetObjectW(p $SavedBitmap, i 24, p r1) i.r2'
  System::Free $1
  System::Call 'kernel32::GetModuleHandleW(w "SnapOverLANProgressClose.dll") p.r3'
  System::Call 'kernel32::GetModuleHandleW(w "SnapOverLANProgressReady.dll") p.r4'
  ${If} $0 != 0
  ${OrIf} $2 != 0
  ${OrIf} $3 != 0
  ${OrIf} $4 != 0
    SetErrorLevel 10
  ${EndIf}
  WriteINIStr "$EXEDIR\lifetime-result.ini" result readiness "$SnapOverLANUpdateReadyResult"
FunctionEnd

Section
  ; Equivalent to customInstall's last step, before the real StartApp macro.
  ${If} ${isUpdated}
    StrCpy $launchLink "$EXEDIR\startup-fixture.exe"
    !insertmacro prepareSnapOverLANUpdateReadiness "$launchLink"
    System::Call 'user32::SetPropW(p $SavedWindow, w "SnapOverLAN.Test.Armed", p 1)'
    HideWindow
    !insertmacro StartApp
  ${EndIf}
SectionEnd
