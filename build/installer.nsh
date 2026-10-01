!define SNAPOVERLAN_FIREWALL_RULE "SnapOverLAN LAN Upload"
!define SNAPOVERLAN_FIREWALL_DESC "allow phones on the same private LAN to reach SnapOverLAN on port 8787"
!define SNAPOVERLAN_MDNS_FIREWALL_RULE "SnapOverLAN mDNS"
!define SNAPOVERLAN_MDNS_FIREWALL_DESC "allow local devices to discover SnapOverLAN over mDNS"
!define SNAPOVERLAN_FIREWALL_WARNING "SnapOverLAN installed, but Windows Firewall could not be configured completely. Phone connectivity may require manually allowing SnapOverLAN through Windows Firewall on your Private network."

!ifndef BUILD_UNINSTALLER
!include "${__FILEDIR__}\update-progress-ui.nsh"
!include "${__FILEDIR__}\update-progress-lifetime.nsh"

!macro customHeader
  Var SnapOverLANUpdateProgressVisible
  Var SnapOverLANTcpFirewallResult
  Var SnapOverLANMdnsFirewallResult

  ; This callback also runs on aborted/failed installs, so the installer never
  ; leaves its modeless update-progress window behind.
  Function .onGUIEnd
    !insertmacro closeSnapOverLANUpdateProgress
    !insertmacro cleanupSnapOverLANUpdateReadiness
  FunctionEnd

  ; In silent mode NSIS calls success after the install section, including
  ; builder's --force-run StartApp. .onGUIEnd is not the silent success hook.
  Function .onInstSuccess
    !insertmacro finishSnapOverLANUpdateProgress
  FunctionEnd

  Function .onInstFailed
    !insertmacro closeSnapOverLANUpdateProgress
    !insertmacro cleanupSnapOverLANUpdateReadiness
  FunctionEnd
!macroend

; Electron Builder reuses its HKLM InstallLocation during upgrades. If an older
; machine-wide install was accidentally registered inside a user's profile,
; leave the record intact for Builder's normal old-version uninstall, but move
; the replacement installation back to the per-machine default.
!macro customInit
  StrCpy $SnapOverLANUpdateProgressVisible "0"
  ; electron-builder's isUpdated condition is true only when --updated is present.
  ; /S by itself therefore remains a fully silent install with no custom window.
  ${If} ${isUpdated}
    !insertmacro showSnapOverLANUpdateProgress
  ${EndIf}

  ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCpy $R8 "$INSTDIR"
  ${If} $R8 != ""
    StrCpy $R6 "0"
    StrCpy $R1 0
    ${Do}
      EnumRegKey $R2 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList" $R1
      ${If} $R2 == ""
        ${ExitDo}
      ${EndIf}

      ReadRegStr $R3 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\$R2" ProfileImagePath
      ${If} $R3 != ""
        ExpandEnvStrings $R3 "$R3"
        GetFullPathName $R3 "$R3"
        StrCpy $R3 "$R3\"
        StrLen $R4 $R3
        StrCpy $R5 $R8 $R4
        ${If} $R5 == $R3
          StrCpy $R6 "1"
          ${ExitDo}
        ${EndIf}
      ${EndIf}
      IntOp $R1 $R1 + 1
    ${Loop}

    ${If} $R6 == "1"
      ${If} $R0 == $R8
        DetailPrint "Migrating invalid registered per-machine installation path: $R8"
      ${Else}
        DetailPrint "Ignoring invalid per-machine installation path override: $R8"
      ${EndIf}
      StrCpy $R7 "$PROGRAMFILES"
      !ifdef APP_64
        ${If} ${RunningX64}
          StrCpy $R7 "$PROGRAMFILES64"
        ${EndIf}
      !endif
      !ifdef MENU_FILENAME
        StrCpy $R7 "$R7\${MENU_FILENAME}"
      !endif
      StrCpy $INSTDIR "$R7\${APP_FILENAME}"
    ${EndIf}
  ${EndIf}
!macroend
!endif

!macro customInstall
  ; Electron Builder keeps its canonical InstallLocation in INSTALL_REGISTRY_KEY.
  ; Also expose it on the standard Apps & Features uninstall entry for inspection.
  WriteRegStr HKLM "${UNINSTALL_REGISTRY_KEY}" InstallLocation "$INSTDIR"

  DetailPrint "Configuring Windows Firewall rule: ${SNAPOVERLAN_FIREWALL_RULE}"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${SNAPOVERLAN_FIREWALL_RULE}"'
  Pop $0 ; An absent old rule is harmless; consume the result.
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${SNAPOVERLAN_FIREWALL_RULE}" dir=in action=allow protocol=TCP localport=8787 remoteip=localsubnet profile=private program="$appExe" enable=yes description="${SNAPOVERLAN_FIREWALL_DESC}"'
  Pop $SnapOverLANTcpFirewallResult
  DetailPrint "Configuring Windows Firewall rule: ${SNAPOVERLAN_MDNS_FIREWALL_RULE}"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${SNAPOVERLAN_MDNS_FIREWALL_RULE}"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${SNAPOVERLAN_MDNS_FIREWALL_RULE}" dir=in action=allow protocol=UDP localport=5353 remoteip=localsubnet profile=private enable=yes description="${SNAPOVERLAN_MDNS_FIREWALL_DESC}"'
  Pop $SnapOverLANMdnsFirewallResult
  ${If} $SnapOverLANTcpFirewallResult != "0"
  ${OrIf} $SnapOverLANMdnsFirewallResult != "0"
    DetailPrint "${SNAPOVERLAN_FIREWALL_WARNING}"
    DetailPrint "Firewall ADD results: TCP=$SnapOverLANTcpFirewallResult; mDNS=$SnapOverLANMdnsFirewallResult"
    ; /SD keeps silent installs/updates non-interactive; the warning is still logged.
    MessageBox MB_OK|MB_ICONEXCLAMATION "${SNAPOVERLAN_FIREWALL_WARNING}" /SD IDOK
  ${EndIf}

  ; Builder normally launches the all-users Start Menu shortcut here. StdUtils
  ; reports success but does not resolve that shortcut after credentialed UAC.
  ; Launch the same installed executable directly in both Finish and update flows.
  StrCpy $launchLink "$appExe"

  ; Do not destroy Banner before builder's automatic relaunch. Arm observation
  ; now; .onInstSuccess waits for the newly launched main window or timeout.
  ${If} ${isUpdated}
  ${AndIf} ${Silent}
  ${AndIf} ${isForceRun}
    !insertmacro prepareSnapOverLANUpdateReadiness "$appExe"
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing Windows Firewall rule: ${SNAPOVERLAN_FIREWALL_RULE}"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${SNAPOVERLAN_FIREWALL_RULE}"'
  Pop $0
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${SNAPOVERLAN_MDNS_FIREWALL_RULE}"'
  Pop $0
!macroend
