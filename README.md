# SnapOverLAN

![SnapOverLAN](assets/branding/snapoverlan-logo-horizontal.svg)

SnapOverLAN is a local phone-to-PC media bridge. Photos and videos stay on your LAN, and each successful upload becomes the current batch. It is useful for ChatGPT image workflows, browser clipboard workflows, or any local process that accepts pasted, opened, or downloaded media.

The product has three user-facing parts:

1. **App** - the native Electron application that starts and manages the local LAN server and displays the desktop UI.
2. **Extension** - the Chrome/Brave extension that fetches the latest images and copies them to the clipboard for pasting into ChatGPT or another image-aware workflow.
3. **PWA** - the phone upload web app served over the local network.

The Express server is an internal part of the App, not a separate product.

## Requirements

- Windows PC
- Node.js 18 or newer for development
- Chrome or Brave for the extension
- Phone and PC connected to the same Wi-Fi network

## Development

Install dependencies:

```text
npm install
```

Start the App:

```text
npm start
```

Start only the internal server when testing the API or PWA:

```text
npm run server
```

Build the Windows installer and portable executable:

```text
npm run dist
```

The local server listens on `0.0.0.0:8787` so the phone can connect over the LAN.

## App

The App opens the SnapOverLAN UI in its Electron window. It reuses a compatible server already running on port 8787 or starts and manages its own server process.

The App UI provides:

- The phone upload URL
- A QR code for opening the PWA
- Server and LAN diagnostics
- Saved upload batches
- Open, copy, delete, and download actions for uploaded media

The UI is an internal Electron renderer under `app/renderer/`. It is not served as a browser page.

In development, uploads use `data/latest/`, `data/batches/`, and temporary staging uses `data/upload-tmp/`. Packaged builds use the Electron user-data directory, so uploaded media is not stored in the installation directory or included in later builds.

## PWA

Connect the phone and PC to the same Wi-Fi network. In the App, scan the QR code or open the displayed LAN URL, for example:

```text
http://192.168.1.16:8787
```

The PWA lets the user:

- Take photos one at a time
- Record videos one at a time
- Select multiple photos or supported videos from the gallery
- Review and remove media from the selected tray
- Upload up to 20 files as one batch

Each uploaded image must be no larger than 12 MB. Each uploaded video must be no larger than 100 MB. Supported video formats are MP4, MOV, and WebM.

### PWA installation

On Android, open the LAN URL in Chrome or Brave and use Add to Home Screen when available.

On iPhone, open the LAN URL in Safari, tap Share, then tap Add to Home Screen.

## Extension

The unpacked extension lives in `extension/`.

To install it:

1. Open `chrome://extensions` or `brave://extensions`.
2. Enable Developer Mode.
3. Select **Load unpacked**.
4. Choose the `extension/` folder.

The extension defaults to:

```text
http://localhost:8787
```

When opened, it fetches the latest uploaded images and the desktop app's Auto-copy setting. The popup toggle controls whether the Electron main process automatically copies the first photo in a new upload. The Copy action converts a manually selected image to PNG and writes it to the clipboard so it can be pasted into ChatGPT or any compatible destination. The Open action opens the source image in a browser tab.

## Windows firewall

The Setup installer creates this inbound firewall rule:

- Rule name: `SnapOverLAN LAN Upload`
- Protocol: TCP
- Local port: 8787
- Profile: Private only

The rule is removed during uninstall. The portable build does not run installer-time firewall configuration.

If the phone cannot connect:

1. Set the Windows network profile to Private.
2. Confirm the phone and PC are on the same Wi-Fi.
3. Use the LAN URL shown in the App, not `localhost`.
4. Check for guest Wi-Fi, VPN routing, access-point isolation, or third-party firewall rules.
5. Prefer the Setup installer for normal use.

## API

The App, PWA, and Extension use these internal local-server routes:

- `POST /api/upload` - uploads a multipart media batch using field name `photos`
- `GET /api/latest` - returns the current media batch
- `GET /api/auto-copy` - reads the desktop Auto-copy setting (loopback only)
- `PUT /api/auto-copy` - updates the desktop Auto-copy setting (loopback only)
- `GET /api/phone-url` - returns detected LAN URLs for the App
- `GET /api/server-status` - returns server and LAN diagnostics
- `GET /files/<filename>` - serves an uploaded file
- `GET /` - serves the phone PWA

## Project structure

```text
SnapOverLAN/
  app/
    main.js
    server/
      index.js
      config.js
      lan.js
      storage.js
      routes/
        api.js
        files.js
    renderer/
      index.html
      app.js
      styles.css
  pwa/
    index.html
    manifest.json
    app.js
    styles.css
    icons/
  extension/
    manifest.json
    popup.html
    popup.js
    styles.css
  build/
    installer.nsh
  data/
  dist/
  package.json
  package-lock.json
  README.md
```

## Branding and icons

The SVG masters are in `assets/branding`:

- `snapoverlan-mark.svg` — gradient compact mark for headers, favicons, and extension UI.
- `snapoverlan-mark-black.svg` and `snapoverlan-mark-white.svg` — monochrome uses.
- `snapoverlan-wordmark.svg` — standalone `SnapOverLAN` wordmark for dark backgrounds.
- `snapoverlan-logo-horizontal.svg` — aligned mark and wordmark lockup.
- `snapoverlan-app-icon.svg` — padded rounded-square desktop and install icon.

Run `npm run generate:icons` to render all PNG sizes, Windows ICO, macOS
ICNS, Linux icons, tray icons, extension icons, favicons, Apple touch icon,
and standard/maskable PWA icons. Raster masters and size previews are written
under `assets/branding/png`; platform files are written to `assets/electron`,
`extension/icons`, and `pwa/icons`.

Extension toolbar icons use the rounded dark app tile. Regular PWA icons retain
transparent rounded-square corners, while Apple touch and maskable icons use an
opaque full-bleed dark canvas so platform masking cannot introduce a light frame.

## Environment

SnapOverLAN uses `SNAPOVERLAN_*` environment variables for runtime coordination:

- `SNAPOVERLAN_DATA_DIR`
- `SNAPOVERLAN_LOG_FILE`
- `SNAPOVERLAN_PARENT_PID`
- `SNAPOVERLAN_PACKAGED`
- `SNAPOVERLAN_SERVER_SOURCE`

Legacy `PHOTO_GPT_*` names are still accepted as fallbacks for existing developer scripts and installed workflows.

## Technology

- Electron
- Node.js and Express
- Multer
- Vanilla HTML, CSS, and JavaScript
- Chrome/Brave Manifest V3 extension APIs

No cloud service or external storage is used.
