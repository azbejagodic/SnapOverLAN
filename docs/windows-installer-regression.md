# Windows installer regression test

SnapOverLAN Setup is a per-machine installer. Its application binaries belong
under 64-bit Program Files, while each Windows account keeps its own Electron
settings and runtime data under that account's roaming AppData directory.

## Clean test

1. Uninstall any existing SnapOverLAN installation.
2. Verify no valid SnapOverLAN installation remains.
3. Log into a STANDARD/non-admin Windows account.
4. Run the new SnapOverLAN Setup executable.
5. When UAC appears, enter credentials belonging to a DIFFERENT administrator account.
6. Finish Setup.
7. Stay logged into the original standard account.
8. Do not switch to the administrator account.
9. Launch SnapOverLAN from the Start Menu.
10. Confirm SnapOverLAN starts.
11. Inspect the shortcut target.
12. Confirm it points to the actual machine-wide executable.
13. Confirm the executable is in a machine-wide directory such as Program Files.
14. Confirm there is no dependency on the administrator user's AppData.
15. Confirm the SnapOverLAN server reaches the online state.
16. Confirm the QR code works.
17. Connect a phone on the same private LAN.
18. Upload photos.
19. Verify the desktop app receives the upload.
20. Test the browser extension if available.
21. Close and reopen SnapOverLAN from the standard account.
22. Restart Windows if practical and test again.
23. Log into the administrator account and verify the machine-wide installation still behaves sensibly there.
24. Uninstall SnapOverLAN.
25. Verify the SnapOverLAN firewall rules are removed.

## Paths and registry values to inspect

The expected executable and shortcut target are approximately:

```text
C:\Program Files\SnapOverLAN\SnapOverLAN.exe
```

Inspect the SnapOverLAN uninstall entry in both applicable 64-bit HKLM locations:

```text
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall
HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall
```

Report these values:

```text
DisplayName
DisplayIcon
InstallLocation
UninstallString
```

Electron Builder also stores its canonical installation state in a SnapOverLAN-specific
HKLM application key. Confirm that its `InstallLocation`, the uninstall entry's
`InstallLocation`, and both shortcut targets refer to the same machine-wide directory.
No machine-wide `InstallLocation` may point below a path like:

```text
C:\Users\<some-admin>\AppData\...
```

Confirm the Start Menu shortcut is in the all-users Programs folder and the desktop
shortcut is on the Public Desktop. After uninstall, confirm that SnapOverLAN's install
and uninstall registry keys, shortcuts, application directory, and these rules are gone:

```text
SnapOverLAN LAN Upload
SnapOverLAN mDNS
```
