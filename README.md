# SnapOverLAN

![SnapOverLAN](assets/branding/snapoverlan-logo-horizontal.svg)

SnapOverLAN is a Windows phone-to-PC photo transfer bridge for a trusted local network. Open the phone interface from a QR code, upload a batch of photos, then download the batch from the desktop app or copy individual photos from the Chrome/Brave extension. Transfers and stored photos remain on the PC; no cloud service is involved.

## Key features

- Phone camera and gallery upload over the local network
- JPEG, PNG, WebP, HEIC, and HEIF support
- Up to 10 photos per batch, with a 12 MB limit per photo
- Fast Upload optimization for large photos
- Stable `.local` phone address with direct-IP fallback
- Recent batch history, selection, download, and deletion in the desktop app
- Manual Copy/Open actions and optional first-photo Auto-copy through the browser extension
- Background operation from the Windows system tray
- LAN-facing upload surface separated from localhost-only management routes

## How it works

1. The Electron desktop app starts or reuses the SnapOverLAN server on TCP port `8787` and shows a phone URL and QR code.
2. A phone on the same network opens that address and uploads a photo batch through the browser-based phone interface.
3. The desktop app records the batch. Use the desktop app to manage or download batches, or the extension to copy/open photos from the current batch.

The Express server is an internal part of the desktop app. A standalone server command is provided for development.

## Requirements

- Windows x64 PC
- Phone and PC on the same trusted/private local network
- Chrome or Brave if using the extension
- Node.js 18.17 or newer when running or building from source

The current end-user build target is Windows. The repository does not currently publish installer binaries as GitHub Release assets, so run the app from source or build the Windows distributions locally.

## Installation and getting started

### Run from source

Clone the repository and run:

```text
git clone https://github.com/azbejagodic/SnapOverLAN.git
cd SnapOverLAN
npm install
npm start
```

If the source was downloaded as an archive, open a terminal in the extracted directory and run the final two commands instead.

The desktop app starts the local server and opens the SnapOverLAN window. Connect the phone and PC to the same network, select **QR**, and scan the code with the phone.

### Build the Windows app

```text
npm install
npm run dist
```

The generated files are written to `dist/`:

- `SnapOverLAN Setup 1.0.0-x64.exe` — per-machine NSIS installer with Start Menu and desktop shortcuts, selectable installation directory, and installer-managed firewall rules
- `SnapOverLAN-1.0.0-portable-x64.exe` — portable x64 executable without installer-time firewall configuration

The version in each filename comes from `package.json`.

## Using SnapOverLAN

### Desktop app

The desktop app:

- starts and manages the local server, or reuses a compatible server already on port `8787`;
- reports server and LAN diagnostics;
- displays the preferred phone URL and a QR code;
- lists up to 10 recent upload batches;
- lets you make an older batch current, delete one batch, or clear all batches;
- downloads every photo in the current batch to the standard Windows Downloads folder, preserving stored names and bytes and avoiding overwrites with numbered suffixes; and
- supports Background Mode, which hides the window while keeping the server available from the system tray.

Selecting an older batch also makes it the batch shown by the extension. A desktop download opens the Downloads folder after the files are saved.

### Phone interface

Open the QR-code address in the phone's browser. The interface provides:

- **Take photo** for one camera capture at a time;
- **Choose from gallery** for multiple selection;
- a preview tray for up to 10 photos;
- removal of individual photos before upload;
- the Fast Upload toggle; and
- one action to upload the selected batch.

Supported formats are JPEG, PNG, WebP, HEIC, and HEIF. Each photo sent to the server must be no larger than 12 MB. If more than 10 supported photos are chosen, only the available tray slots are filled.

The included web app manifest supports adding SnapOverLAN to the phone's home screen where the browser offers that option. It is served from the PC over the local network and is not an offline app.

### Fast Upload

Fast Upload is enabled by default and remembers the preference in the phone browser. It attempts to make large photos faster to transfer before upload:

- eligible photos larger than about 1.5 MB are resized to a maximum long edge of 1920 pixels;
- JPEG output and WebP output use approximately 82% quality; and
- PNG files are left unchanged.

Optimization happens on the phone. SnapOverLAN keeps the original when the browser cannot decode or optimize a photo, or when the optimized result would be larger. A decodable HEIC or HEIF photo may be prepared as JPEG; otherwise the original remains eligible for upload.

### Browser extension

The Manifest V3 extension is included as source in `extension/`.

To load it from a repository checkout:

1. Open `chrome://extensions` or `brave://extensions`.
2. Enable **Developer Mode**.
3. Select **Load unpacked**.
4. Choose the repository's `extension/` directory.

The extension connects to `http://localhost:8787`, refreshes the current batch, and shows its photos. **Copy** converts the chosen photo to PNG and writes the image to the clipboard. **Open** opens the stored photo in a browser tab.

The extension also controls **Auto-copy**, which is off by default. When enabled, the Electron app copies the first photo from each newly uploaded batch to the Windows clipboard. The preference is stored by the desktop app and persists across restarts.

## Stable phone address

SnapOverLAN stores a persistent eight-character device ID in its runtime data directory and advertises a hostname such as:

```text
http://snap-a1b2c3d4.local:8787
```

When mDNS starts successfully, the desktop QR code prefers this stable address so ordinary DHCP address changes do not require a new QR code. The diagnostics panel also lists detected LAN IPv4 addresses. If `.local` discovery is unavailable, SnapOverLAN falls back to an address such as `http://192.168.1.16:8787`.

## Local network access and security

SnapOverLAN is designed for a trusted private network. It does not provide accounts, authentication, HTTPS, or protection suitable for an untrusted or public network. Anyone who can reach port `8787` on the LAN can load the phone interface and submit a supported photo batch.

Non-loopback clients are intentionally limited to the phone interface and its static assets plus `POST /api/upload`. Saved batches, stored-file reads, storage settings, diagnostics, Auto-copy, and server-control operations return `404` to LAN clients and remain available only through loopback (`localhost`/`127.0.0.1`) for the desktop app and extension.

## Windows Firewall and troubleshooting

The Setup installer creates two inbound Windows Firewall rules on the Private profile:

- `SnapOverLAN LAN Upload` — TCP port `8787`
- `SnapOverLAN mDNS` — UDP port `5353`, restricted to the local subnet

Both rules are removed during uninstall. The portable executable does not run this installer hook, so Windows Firewall access may need to be allowed separately.

If the phone cannot connect:

1. Set the Windows network profile to **Private**.
2. Confirm the phone and PC are on the same Wi-Fi or private LAN.
3. Use the `.local` or LAN IP address shown by the desktop app, not `localhost`.
4. Try a listed direct-IP URL if `.local` resolution fails.
5. Check guest Wi-Fi, access-point isolation, VPN routing, multicast filtering, and third-party firewall settings.
6. Prefer the Setup installer when installer-managed firewall rules are desired.

## Storage and upload history

Each successful non-empty upload creates a batch and makes it current. SnapOverLAN retains at most the 10 newest batches; adding an eleventh removes the oldest. An optional localhost-only `retentionDays` setting can remove older batches sooner. Retention cleanup runs at server startup, after uploads, and when that setting changes. The desktop UI does not currently expose the time-based setting.

Runtime storage is separate from application files:

- Development and standalone server: `data/` in the repository
- Packaged desktop app: `data/` inside Electron's user-data directory, shown in **Server diagnostics** (normally `%APPDATA%\SnapOverLAN\data` on Windows)

The runtime data includes batch directories, the current-batch pointer, device identity, optional retention settings, and upload staging. It is excluded from packaged distributions.

## Development

Install dependencies:

```text
npm install
```

Start the Electron desktop app:

```text
npm start
```

Start only the standalone Express server and phone interface:

```text
npm run server
```

Generate platform and web icons from the SVG masters:

```text
npm run generate:icons
```

Build the Windows Setup and portable distributions:

```text
npm run dist
```

`npm run dist` regenerates icons before invoking Electron Builder with the Windows x64 targets.

### Testing

Run the complete Node test suite:

```text
node --test
```

Focused package scripts are also available:

```text
npm run test:pwa-connection
npm run test:electron-controls
npm run test:electron-clipboard-smoke
```

The clipboard smoke test launches Electron, exercises native image decoding and clipboard writes, restores the previous clipboard content, and requires a desktop session.

## Internal local API

The HTTP interface is an implementation detail shared by the phone UI, desktop app, and extension; it should not be treated as a stable public API.

LAN-accessible surface:

- `GET`/`HEAD /` and the phone interface's static assets
- `POST /api/upload` — multipart form field `photos`, with up to 10 supported photos

Important localhost-only routes:

- `GET /api/latest` and `GET /files/:name` — current batch metadata and files
- `GET /api/latest/download` — current batch as a ZIP archive
- `/api/batches` and `/api/batches/:id` — list, inspect, select, download, and delete batches
- `GET`/`PUT /api/storage-settings` — optional time-based retention
- `GET /api/upload-status`, `/api/phone-url`, and `/api/server-status` — local state and diagnostics
- `GET`/`PUT /api/auto-copy` — desktop Auto-copy integration

Additional lifecycle routes are reserved for the Electron app and intentionally undocumented.

## Project structure

```text
SnapOverLAN/
  app/
    main.js                 Electron main process
    desktop/                server lifecycle, tray, settings, and downloads
    renderer/               desktop window UI
    server/                 Express server, LAN/mDNS, and identity
      routes/               upload, batch, file, and system routes
      storage/              batch storage and retention
  pwa/                      phone upload interface and manifest
  extension/                Chrome/Brave Manifest V3 extension
  assets/
    branding/               SVG logo and icon masters
    electron/               generated desktop and tray assets
    fonts/                  bundled font licensing
  build/                    NSIS installer customization
  scripts/                  icon generation and Electron smoke runner
  tests/                    server, PWA, desktop, storage, and mDNS tests
  data/                     development runtime data (ignored)
  dist/                     generated Windows distributions (ignored)
  package.json
  README.md
```

## Branding and icons

The SVG masters live in `assets/branding/`. Run `npm run generate:icons` to regenerate Electron application/tray assets, extension icons, favicons, Apple touch icons, and standard/maskable phone icons. Generated files are written to `assets/electron/`, `extension/icons/`, and `pwa/icons/`.

## Environment variables

The standalone server recognizes these developer-facing variables:

- `SNAPOVERLAN_PORT` — HTTP port; defaults to `8787` (the desktop app and extension expect `8787`)
- `SNAPOVERLAN_DATA_DIR` — runtime data root
- `SNAPOVERLAN_LOG_FILE` — optional startup log path
- `SNAPOVERLAN_DEBUG_MDNS=1` — verbose mDNS diagnostics

`SNAPOVERLAN_PARENT_PID`, `SNAPOVERLAN_PACKAGED`, and `SNAPOVERLAN_SERVER_SOURCE` are used internally to coordinate the Electron app and child server. Legacy `PHOTO_GPT_*` names remain accepted as fallbacks for the port, data/log paths, and internal coordination variables; mDNS debug logging recognizes only `SNAPOVERLAN_DEBUG_MDNS`.

## Technology

- Electron and Electron Builder
- Node.js, Express, Multer, and Sharp
- `bonjour-service` for mDNS
- Vanilla HTML, CSS, and JavaScript
- Chrome/Brave Manifest V3 extension APIs
