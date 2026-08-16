!define SNAPOVERLAN_FIREWALL_RULE "SnapOverLAN LAN Upload"
!define SNAPOVERLAN_FIREWALL_DESC "allow phones on the same private LAN to reach SnapOverLAN on port 8787"
!define SNAPOVERLAN_MDNS_FIREWALL_RULE "SnapOverLAN mDNS"
!define SNAPOVERLAN_MDNS_FIREWALL_DESC "allow local devices to discover SnapOverLAN over mDNS"

!macro customInstall
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
