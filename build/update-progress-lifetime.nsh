!ifndef SNAPOVERLAN_UPDATE_PROGRESS_LIFETIME
!define SNAPOVERLAN_UPDATE_PROGRESS_LIFETIME
!define SNAPOVERLAN_PROGRESS_READY_DLL "${__FILEDIR__}\native\update-progress-ready.dll"
!ifndef SNAPOVERLAN_UPDATE_READY_TIMEOUT
  !define SNAPOVERLAN_UPDATE_READY_TIMEOUT 90000
!endif

Var SnapOverLANUpdateReadyModule
Var SnapOverLANUpdateWaitForReady
Var SnapOverLANUpdateReadyResult

; Arm immediately before builder launches $appExe, after installation work.
!macro prepareSnapOverLANUpdateReadiness EXECUTABLE
  InitPluginsDir
  File "/oname=$PLUGINSDIR\SnapOverLANProgressReady.dll" "${SNAPOVERLAN_PROGRESS_READY_DLL}"
  System::Call 'kernel32::LoadLibraryW(w "$PLUGINSDIR\SnapOverLANProgressReady.dll") p.s'
  Pop $SnapOverLANUpdateReadyModule
  StrCpy $SnapOverLANUpdateWaitForReady 0
  StrCpy $SnapOverLANUpdateReadyResult 2
  ${If} $SnapOverLANUpdateReadyModule != 0
    System::Call 'kernel32::GetProcAddress(p $SnapOverLANUpdateReadyModule, m "_Arm@4") p.r0'
    ${If} $0 != 0
      System::Call '::$0(w "${EXECUTABLE}") i.r1'
      ${If} $1 != 0
        System::Call 'kernel32::GetProcAddress(p $SnapOverLANUpdateReadyModule, m "_WaitForReady@4") p.s'
        Pop $SnapOverLANUpdateWaitForReady
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro cleanupSnapOverLANUpdateReadiness
  ${If} $SnapOverLANUpdateReadyModule != ""
  ${AndIf} $SnapOverLANUpdateReadyModule != 0
    System::Call 'kernel32::FreeLibrary(p $SnapOverLANUpdateReadyModule)'
  ${EndIf}
  StrCpy $SnapOverLANUpdateReadyModule 0
  StrCpy $SnapOverLANUpdateWaitForReady 0
!macroend

; .onInstSuccess runs after builder's silent --force-run launch has returned.
; Banner pumps its own thread, so X/minimize continue working during this wait.
!macro finishSnapOverLANUpdateProgress
  ${If} $SnapOverLANUpdateWaitForReady != ""
  ${AndIf} $SnapOverLANUpdateWaitForReady != 0
    System::Call '::$SnapOverLANUpdateWaitForReady(i ${SNAPOVERLAN_UPDATE_READY_TIMEOUT}) i.s'
    Pop $SnapOverLANUpdateReadyResult
  ${EndIf}
  !insertmacro closeSnapOverLANUpdateProgress
  !insertmacro cleanupSnapOverLANUpdateReadiness
!macroend
!endif
