# SnapOverLAN

![SnapOverLAN](assets/branding/snapoverlan-logo-horizontal.svg)

SnapOverLAN is a Windows phone-to-PC photo transfer bridge for a trusted local network. Open the phone interface from a QR code, upload a batch of photos, then download the batch from the desktop app or copy individual photos from the Chrome/Brave extension. Photo transfer and storage are local, with no cloud photo service. Installed builds use GitHub Releases for update checks and downloads.

## Key features

- Phone camera and gallery upload over the local network
- JPEG, PNG, WebP, HEIC, and HEIF support
- Up to 10 photos per batch, with a 20 MiB limit per photo
- Fast Upload optimization for large photos
- Stable `.local` phone address with direct-IP fallback
- Recent batch history, selection, download, and deletion in the desktop app
- Manual Copy/Open actions and optional first-photo Auto-copy through the browser extension
- Background operation from the Windows system tray
- LAN-facing upload surface separated from localhost-only management routes

## How it works

1. The Electron desktop app starts a server or reuses a verified current SnapOverLAN server on TCP port `8787`, then shows a phone URL and QR code.
2. A phone on the same network opens that address and uploads a photo batch through the browser-based phone interface.
3. The desktop app records the batch. Use the desktop app to manage or download batches, or the extension to copy/open photos from the current batch.

The Express server is an internal part of the desktop app. A standalone server command is provided for development.

## Requirements

- Windows x64 PC
- Phone and PC on the same trusted/private local network
- Chrome or Brave if using the extension
- Node.js 24.19.0 or newer when running or building from source

The current end-user build target is Windows. Tagged releases are configured to provide the Windows Setup executable, portable executable, and browser-extension ZIP through [GitHub Releases](https://github.com/azbejagodic/SnapOverLAN/releases). If the available release does not yet include those assets, use the source or local-build instructions below.

## Installation and getting started

### Windows Setup

From [GitHub Releases](https://github.com/azbejagodic/SnapOverLAN/releases), download `SnapOverLAN-Setup-<version>-x64.exe` from a release that includes binary assets and run it. The per-machine installer creates Start Menu and desktop shortcuts and configures the required Private-network Windows Firewall rules.

### Portable app

Download `SnapOverLAN-<version>-portable-x64.exe` from the same release and run it directly. The portable build does not perform installer-time firewall configuration, so Windows Firewall access may need to be allowed separately.

### Browser extension

Download and extract `SnapOverLAN-extension-<version>.zip` from the same release. Then:

1. Open `chrome://extensions` or `brave://extensions`.
2. Enable **Developer Mode**.
3. Select **Load unpacked**.
4. Choose the extracted directory containing `manifest.json`.

### Run from source

Clone the repository and run:

```text
git clone https://github.com/azbejagodic/SnapOverLAN.git
cd SnapOverLAN
npm ci
npm start
```

If the source was downloaded as an archive, open a terminal in the extracted directory and run the final two commands instead.

The desktop app starts the local server and opens the SnapOverLAN window. Connect the phone and PC to the same network, select **QR**, and scan the code with the phone.

### Build release artifacts locally

```text
npm ci
npm run release:build
```

The user downloads are written to `dist/`:

- `SnapOverLAN-Setup-<version>-x64.exe`
- `SnapOverLAN-<version>-portable-x64.exe`
- `SnapOverLAN-extension-<version>.zip`

The build also produces `latest.yml` and the installer `.blockmap` for the updater. The desktop version comes from `package.json`; release CI requires `extension/manifest.json` to use the same version.

## Using SnapOverLAN

### Desktop app

The desktop app:

- starts and manages the local server, or reuses only a verified current SnapOverLAN server on port `8787`;
- provides a read-only **Server diagnostics** section below recent uploads; click its heading to expand it (collapsed by default);
- displays the preferred phone URL and a QR code;
- lists up to 50 recent upload batches;
- lets you make an older batch current, delete one batch, or clear all batches;
- downloads every photo in the current batch to the standard Windows Downloads folder, preserving stored names and bytes and avoiding overwrites with numbered suffixes; and
- supports Background Mode, which hides the window while keeping the server available from the system tray.

Selecting an older batch also makes it the batch shown by the extension. A desktop download opens the Downloads folder after the files are saved.

Legacy servers are recognized only to show a helpful error; they are never reused. Background Mode is off by default. When enabled, closing the window hides it; when disabled, closing requests Quit. Tray **Quit** also requests shutdown. Active uploads block Quit and update restart: wait for the upload to finish, then retry.

### Phone interface

Open the QR-code address in the phone's browser. The interface provides:

- **Take photo** for one camera capture at a time;
- **Choose from gallery** for multiple selection;
- a preview tray for up to 10 photos;
- removal of individual photos before upload;
- the Fast Upload toggle; and
- one action to upload the selected batch.

Supported upload formats are JPEG, PNG, WebP, HEIC, and HEIF. Each photo sent to the server must be no larger than 20 MiB (shown as 20 MB in the UI). If more than 10 supported photos are chosen, only the available tray slots are filled.

The included web app manifest supports adding SnapOverLAN to the phone's home screen where the browser offers that option. It is served from the PC over the local network and is not an offline app.

### Fast Upload

Fast Upload is enabled by default and remembers the preference in the phone browser. It attempts to make large photos faster to transfer before upload:

- eligible photos larger than about 1.5 MB are resized to a maximum long edge of 1920 pixels;
- JPEG output and WebP output use approximately 82% quality; and
- PNG files are left unchanged.

Optimization happens on the phone. SnapOverLAN keeps the original when the browser cannot decode or optimize a photo, or when the optimized result would be larger. A decodable HEIC or HEIF photo may be prepared as JPEG; otherwise the original remains eligible for upload.

### Browser extension

The Manifest V3 extension is included as source in `extension/`. From a repository checkout, that directory can be selected directly with **Load unpacked**; release users can select the extracted extension archive as described above.

The extension connects to `http://localhost:8787`, refreshes the current batch, and shows its photos. **Copy** converts the chosen photo to PNG and writes the image to the clipboard. **Open** opens the stored photo in a browser tab.

The extension also controls **Auto-copy**, which is off by default. When enabled, the Electron app copies the first photo from each newly uploaded batch to the Windows clipboard. The preference is stored by the desktop app and persists across restarts.

Copy and Auto-copy have a 40 MP limit and require successful decoding. Supported upload formats do not guarantee browser Copy or desktop clipboard support: HEIC/HEIF may upload successfully but fail preview, Copy, or Auto-copy depending on decoder support.

The extension declares `clipboardWrite` and HTTP host access for `localhost` and `127.0.0.1` on port `8787`. It does not request arbitrary LAN-host access.

## Updates

Only installed Windows builds use the updater. They check GitHub Releases after startup and every 12 hours, and automatically download available updates. Explicitly reopening the app also checks for updates or re-presents an already downloaded update. Periodic checks do not re-present a dismissed prompt.

After download, choose **Later** or **Restart & Update**. Ordinary Quit does not install the update. Active uploads block installation; wait for the upload to finish and retry **Restart & Update**. During installation, a native NSIS progress window appears. Closing that window hides it rather than cancelling installation; the app reopens after the update.

Portable and development builds do not use the updater. Portable users download a newer release and replace the executable manually.

## Stable phone address

SnapOverLAN stores a persistent eight-character device ID in its runtime data directory and advertises a hostname such as:

```text
http://snap-a1b2c3d4.local:8787
```

When mDNS starts successfully and a usable private LAN address is available, the desktop QR code prefers this stable address so ordinary DHCP address changes do not require a new QR code. If server-side mDNS is unavailable, it automatically uses an available LAN IP URL such as `http://192.168.1.16:8787`.

The desktop cannot detect a phone's failure to resolve `.local`. If that happens while mDNS is running, use one of the LAN IP URLs shown in **Server diagnostics**. Expand that section for detected addresses, the live server source, storage paths, and troubleshooting guidance. Failed status requests show an error and clear previously listed LAN links.

## Local network access and security

SnapOverLAN is designed for a trusted private network. It provides no user accounts, authenticated phone uploads, or HTTPS, and is unsuitable for an untrusted or public network. Anyone who can reach port `8787` on the LAN can load the phone interface and submit a supported photo batch. Internal desktop lifecycle/control uses a shutdown/control token.

Non-loopback clients are intentionally limited to the phone interface and its static assets plus `POST /api/upload`. Saved batches, stored-file reads, diagnostics, Auto-copy, and server-control operations return `404` to LAN clients and remain available only through loopback (`localhost`/`127.0.0.1`) for the desktop app and extension.

Loopback management also rejects ordinary cross-site web Origins, opaque (`null`) Origins, and non-loopback Host names. The desktop renderer uses native IPC; installed Chrome/Brave extension Origins are allowed independently of their installation ID. Native clients without browser Origin headers and same-origin localhost requests remain supported. This boundary trusts local software and installed extensions with localhost access.

Uploads are decoded before a batch becomes available, and stored extensions come from the verified image format. Validation allows up to 60 megapixels per file (including all image frames), accommodating 48/50 MP phone photos; the separate clipboard limit remains 40 megapixels. HEIC/HEIF validation uses a bundled local HEVC decoder because Sharp's prebuilt binaries omit that codec. Invalid batches are removed, and stored-file responses use safe image types and `nosniff`.

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

Each successful non-empty upload creates a batch and makes it current. SnapOverLAN retains at most the 50 newest batches; adding a 51st removes the oldest. Count-based cleanup runs at server startup and after uploads. Batches do not expire with age, and users can manually delete individual batches or clear all batches.

Runtime storage is separate from application files. Default locations are:

- Development and standalone server: `data/` in the repository
- Packaged desktop app: `data/` inside Electron's user-data directory, shown in **Server diagnostics** (normally `%APPDATA%\SnapOverLAN\data` on Windows)

`SNAPOVERLAN_DATA_DIR` can override standalone/development storage. Portable builds also use Electron's user-data directory, not the executable directory. A reused server retains its own storage location; consult **Server diagnostics** for the active paths.

The runtime data includes batch directories, the current-batch pointer, device identity, and upload staging. It is excluded from packaged distributions.

## Development

Install dependencies:

```text
npm ci
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

Package only the browser extension:

```text
npm run package:extension
```

Build all three release artifacts:

```text
npm run release:build
```

### CI and releases

Normal CI (`.github/workflows/ci.yml`) runs on pushes to `main` and pull requests targeting `main`. It uses a Windows runner and Node 24.19.0 to run `npm ci` and `node --test`, without building or publishing artifacts.

Release CI (`.github/workflows/release.yml`) runs for version tags such as `v2.0.0`. Before building, it requires the tag to equal `v<package version>` and the extension version to equal the package version. It uses Windows and Node 24.19.0, installs dependencies, runs tests, builds and validates the Windows artifacts and extension ZIP, then creates or updates the GitHub Release. User downloads are the Setup EXE, portable EXE, and extension ZIP; `latest.yml` and the installer `.blockmap` are updater metadata. Release builds are unsigned unless a maintainer configures Windows code signing.

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
- `GET`/`DELETE /api/batches` — list or clear batches
- `GET`/`DELETE /api/batches/:id` — inspect or delete one batch
- `POST /api/batches/:id/select` — make a batch current
- `GET /api/batches/:id/files/:name` — read an individual batch file
- `GET /api/server-status` — local state and diagnostics
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
  scripts/                  icon generation, extension packaging, Electron smoke runner
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

`SNAPOVERLAN_PARENT_PID`, `SNAPOVERLAN_PACKAGED`, and `SNAPOVERLAN_SERVER_SOURCE` are used internally to coordinate the Electron app and child server. SnapOverLAN configuration uses only the `SNAPOVERLAN_*` names.

## Technology

- Electron and Electron Builder
- Node.js, Express, Multer, and Sharp
- `bonjour-service` for mDNS
- Vanilla HTML, CSS, and JavaScript
- Chrome/Brave Manifest V3 extension APIs
