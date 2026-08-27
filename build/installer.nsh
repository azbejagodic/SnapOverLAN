!define SNAPOVERLAN_FIREWALL_RULE "SnapOverLAN LAN Upload"
!define SNAPOVERLAN_FIREWALL_DESC "allow phones on the same private LAN to reach SnapOverLAN on port 8787"
!define SNAPOVERLAN_MDNS_FIREWALL_RULE "SnapOverLAN mDNS"
!define SNAPOVERLAN_MDNS_FIREWALL_DESC "allow local devices to discover SnapOverLAN over mDNS"

!ifndef BUILD_UNINSTALLER
; Electron Builder reuses its HKLM InstallLocation during upgrades. If an older
; machine-wide install was accidentally registered inside a user's profile,
; leave the record intact for Builder's normal old-version uninstall, but move
; the replacement installation back to the per-machine default.
!macro customInit
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
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${SNAPOVERLAN_FIREWALL_RULE}" dir=in action=allow protocol=TCP localport=8787 profile=private enable=yes description="${SNAPOVERLAN_FIREWALL_DESC}"'
  DetailPrint "Configuring Windows Firewall rule: ${SNAPOVERLAN_MDNS_FIREWALL_RULE}"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${SNAPOVERLAN_MDNS_FIREWALL_RULE}"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="${SNAPOVERLAN_MDNS_FIREWALL_RULE}" dir=in action=allow protocol=UDP localport=5353 remoteip=localsubnet profile=private enable=yes description="${SNAPOVERLAN_MDNS_FIREWALL_DESC}"'
!macroend

!macro customUnInstall
  DetailPrint "Removing Windows Firewall rule: ${SNAPOVERLAN_FIREWALL_RULE}"
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${SNAPOVERLAN_FIREWALL_RULE}"'
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="${SNAPOVERLAN_MDNS_FIREWALL_RULE}"'
!macroend
