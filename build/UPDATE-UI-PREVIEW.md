Run from the project directory on Windows:

```powershell
npm run preview:update-ui
```

Click the loading window and press **Escape** to close it. **Ctrl+C** in the
launching terminal also exits. The window stays visible until you close it.
The production text about installation and reopening is displayed verbatim;
the preview performs neither action.

Both `installer.nsh` and `update-ui-preview.nsi` use `update-progress-ui.nsh`.
Make future visual changes in that shared include. The preview uses the same
Unicode NSIS Banner plugin, controls, strings, and layout as the real update.
No extra buttons or preview labels are added to the window.

The runner compiles only the standalone preview harness, using the existing
electron-builder NSIS 3.0.4.1 cache and its Banner plugin. It never invokes
electron-builder, Electron, or the production installer. Missing cached tools
produce an error; there is no download fallback. `ELECTRON_BUILDER_CACHE` is
supported when the cache lives elsewhere.

Generated preview executables go in ignored `.cache/update-ui-preview/run-*`
directories. NSIS also extracts its UI plugins to its temporary directory at
runtime. There is no application payload, installation section, uninstaller,
registry modification, network call, elevation request, version change, or
application launch. Installer command-line arguments are not accepted by the
npm runner and cannot enable installation in the standalone executable.

The production `--updated` condition, UAC, installation, cleanup, and relaunch
hooks remain in the production installer. Normal installation is unchanged.
