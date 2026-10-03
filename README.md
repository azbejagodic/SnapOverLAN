# SnapOverLAN

![SnapOverLAN](assets/branding/snapoverlan-logo-horizontal.svg)

SnapOverLAN is a Windows phone-to-PC photo transfer bridge for a trusted local network. Open the phone interface from a QR code, upload a batch of photos, then download the batch from the desktop app or copy individual photos from the Chrome/Brave extension. Photo transfer and storage are local, with no cloud photo service. Installed builds use GitHub Releases for update checks and downloads.

## Key features

- Phone camera and gallery upload over the local network
- JPEG, PNG, WebP, HEIC, and HEIF support
- Up to 10 photos per batch, with a 20 MiB limit per photo
- Fast Upload optimization for large photos
- Stable `.local` phone address where available, with direct-IP fallback
- Recent batch history, selection, download, and deletion in the desktop app
- Manual Copy/Open actions and optional first-photo Auto-copy through the browser extension
- Background operation from the Windows system tray
- LAN-facing upload surface separated from localhost-only management routes

## How it works

1. Launch SnapOverLAN on the PC. It shows a phone address and QR code.
2. Open that address on a phone reachable on the same local network, select photos, and press **Upload selected photos**.
3. Use the desktop app to manage or download received batches, or the extension to copy/open photos from the current batch.

The Express server is an internal part of the desktop app. A standalone server command is provided for development.

## Requirements

- Windows x64 PC
- Phone and PC on the same trusted/private local network
- Chrome or Brave if using the extension

Download packaged binaries from [GitHub Releases](https://github.com/azbejagodic/SnapOverLAN/releases). The filenames below refer to v2.0.0. Source builds are covered separately under [Development](#development).

## Installation and getting started

### Windows Setup

Download `SnapOverLAN-Setup-2.0.0-x64.exe` from [GitHub Releases](https://github.com/azbejagodic/SnapOverLAN/releases), run the installer, and launch SnapOverLAN. The installer creates Start Menu and desktop shortcuts and configures the required Private-network Windows Firewall rules.

The current build is unsigned, so Windows may show **Unknown publisher** in the administrator (UAC) prompt.

### Connect your phone

Phone and PC must be reachable on the same local network. Open **QR** in SnapOverLAN and scan it with the phone, or open the displayed address in the phone's browser. A `.local` address is available when mDNS discovery is running; the direct LAN IP shown in **Server diagnostics** is the reliable fallback when `.local` does not work.

On Windows, the network must be set to **Private** for SnapOverLAN's firewall rules to allow phone access. See [Windows network profile](#windows-network-profile) below. Clean-laptop and hotspot acceptance testing is still pending.

### Portable app

Download `SnapOverLAN-2.0.0-portable-x64.exe` from the same Releases page and run it directly. It serves the phone interface and receives uploads normally.

Windows UAC approval is expected when portable mode needs temporary firewall access. The temporary SnapOverLAN rules allow only Private-network, local-subnet access for the running executable and are removed automatically after the portable app exits. After elevation, the firewall helper runs hidden; there is no persistent PowerShell window to manage. Manual firewall rule creation is not normally needed.

Portable mode does not use the updater. To update, download the newer portable executable and replace the old one after quitting SnapOverLAN.

### Browser extension

Download and extract `SnapOverLAN-extension-2.0.0.zip` from the same release. The extension is installed unpacked using Developer Mode, rather than through a browser store:

1. Open `chrome://extensions` or `brave://extensions`.
2. Enable **Developer Mode**.
3. Select **Load unpacked**.
4. Choose the extracted directory containing `manifest.json`.

## Using SnapOverLAN

### Windows network profile

SnapOverLAN intentionally allows phone access through Windows Firewall only on **Private** networks and from the **local subnet**. On a Public network, the app can show **Server online** while the firewall blocks the phone connection.

When SnapOverLAN detects that the network used for phone access is Public, it shows a warning. On a network you trust:

1. Click **Open network settings**. It opens Ethernet or Wi-Fi settings when the adapter is detected, or general network settings otherwise.
2. Under **Network profile type**, select **Private network**.
3. Return to SnapOverLAN; the warning updates automatically without an app restart.

Use Private only on networks you trust. SnapOverLAN does not change the Windows network profile automatically or enable Public-profile firewall access.

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

Legacy servers are recognized only to show a helpful error; they are never reused. Background Mode is off by default. When enabled, closing the window hides it and keeps the server running in the tray; when disabled, closing requests Quit. Tray **Quit** exits the application when no send is active. An active send blocks shutdown and update restart, including during phone-side optimization; finish or cancel the send, then retry.

### Phone interface

Open the QR-code address in the phone's browser. The interface provides:

- **Take photo** for one camera capture at a time;
- **Choose from gallery** for multiple selection;
- a preview tray for up to 10 photos;
- removal of individual photos before upload;
- the Fast Upload toggle;
- **Upload selected photos** to send the selected batch; and
- **Cancel send** while preparing or uploading.

Selecting photos alone does not prevent desktop shutdown. Pressing Upload first asks the PC to protect the send; optimization starts only after the PC acknowledges it. If the PC cannot acknowledge the start, the phone shows an error and keeps the photos selected for retry.

Once acknowledged, the send is protected through phone-side optimization and actual upload: closing the desktop to quit, tray **Quit**, and **Restart & Update** are blocked. Completion, failure, or cancellation releases the protection after any upload cleanup. If the phone disappears during preparation, protection expires automatically rather than leaving the PC locked indefinitely.

Supported upload formats are JPEG, PNG, WebP, HEIC, and HEIF. Each photo sent to the server must be no larger than 20 MiB (shown as 20 MB in the UI). If more than 10 supported photos are chosen, only the available tray slots are filled.

The included web app manifest supports adding SnapOverLAN to the phone's home screen where the browser offers that option. It is served from the PC over the local network and is not an offline app.

Each server accepts one upload at a time, including validation and cleanup. Before receiving files, it requires 1 GiB of free-space reserve plus the maximum 200 MiB batch allowance on the staging drive. Busy or low-disk requests are rejected with an explanation; selected photos stay available for manual retry. Disk space can still change during upload, so a disk-full failure also asks you to free space on the PC.

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

After download, choose **Later** or **Restart & Update**. Ordinary Quit does not install the update. Active sends block installation, including during phone-side optimization; finish or cancel the send and retry **Restart & Update**. During installation, a native NSIS progress window appears. Closing that window hides it rather than cancelling installation; the app reopens after the update.

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

Non-loopback clients are intentionally limited to the phone interface, its static assets, upload, and send-session requests. Upload and send-session requests are checked against the allowed Host, Origin, Referer, and Fetch-Metadata rules. Saved batches, stored-file reads, diagnostics, Auto-copy, and server-control operations return `404` to LAN clients and remain available only through loopback (`localhost`/`127.0.0.1`) for the desktop app and extension.

Loopback management also rejects ordinary cross-site web Origins, opaque (`null`) Origins, and non-loopback Host names. The desktop renderer uses native IPC; installed Chrome/Brave extension Origins are allowed independently of their installation ID. Native clients without browser Origin headers and same-origin localhost requests remain supported. This boundary trusts local software and installed extensions with localhost access.

Uploads are decoded before a batch becomes available, and stored extensions come from the verified image format. Validation allows up to 60 megapixels per file (including all image frames), accommodating 48/50 MP phone photos; the separate clipboard limit remains 40 megapixels. HEIC/HEIF validation uses a bundled local HEVC decoder because Sharp's prebuilt binaries omit that codec. Invalid batches are removed, and stored-file responses use safe image types and `nosniff`.

## Windows Firewall and troubleshooting

The Setup installer creates two inbound Windows Firewall rules, both restricted to the **Private** profile and **LocalSubnet**:

- `SnapOverLAN LAN Upload` — TCP port `8787` for the LAN service
- `SnapOverLAN mDNS` — UDP port `5353` for mDNS discovery

The portable executable creates separate, program-bound temporary rules with the same ports and restrictions, then removes them when the portable app exits. Public-profile access is intentionally not enabled. Keep Windows Firewall enabled.

### Uninstall

Uninstall SnapOverLAN through Windows Settings > Apps. Uninstalling the installed build removes the application, its shortcuts, and both installed SnapOverLAN firewall rules.

### Troubleshooting

| Symptom | What to do |
| --- | --- |
| Phone cannot connect | Confirm the phone and PC are reachable on the same LAN, check that the trusted Windows network is Private, and try a direct LAN IP shown in Server diagnostics. Do not use `localhost` on the phone. |
| `.local` address does not open | Use a direct LAN IP from Server diagnostics. |
| A previous QR code or address no longer works | The network or IP may have changed. Use the current QR code/address shown in SnapOverLAN. |
| Public-network warning appears | Follow **Open network settings** and select Private only if you trust the network. |
| Portable launch asks for UAC approval | This is expected for temporary firewall setup; approve it to allow phone access on your trusted Private network. |

## Storage and upload history

Each successful non-empty upload creates a batch and makes it current. SnapOverLAN retains at most the 50 newest batches; adding a 51st removes the oldest. Count-based cleanup runs at server startup and after uploads. Batches do not expire with age, and users can manually delete individual batches or clear all batches.

Runtime storage is separate from application files. Default locations are:

- Development and standalone server: `data/` in the repository
- Packaged desktop app: `data/` inside Electron's user-data directory, shown in **Server diagnostics** (normally `%APPDATA%\SnapOverLAN\data` on Windows)

`SNAPOVERLAN_DATA_DIR` can override standalone/development storage. Portable builds also use Electron's user-data directory, not the executable directory. A reused server retains its own storage location; consult **Server diagnostics** for the active paths.

The runtime data includes batch directories, the current-batch pointer, device identity, and upload staging. It is excluded from packaged distributions.

## Development

Source development requires Node.js **24.19.0 or newer**. Normal users should use the packaged Setup or portable executable; `npm start` and `dist/win-unpacked` are development/build outputs, not the release acceptance artifacts.

Clone the repository and install dependencies:

```text
git clone https://github.com/azbejagodic/SnapOverLAN.git
cd SnapOverLAN
npm ci
```

If you downloaded a source archive, open a terminal in the extracted directory and run `npm ci` instead.

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

For v2.0.0, the packaged release and acceptance artifacts in `dist/` are:

- `SnapOverLAN-Setup-2.0.0-x64.exe`
- `SnapOverLAN-2.0.0-portable-x64.exe`
- `SnapOverLAN-extension-2.0.0.zip`

The build also produces `latest.yml` and the installer `.blockmap` for the updater. Versions come from `package.json` and `extension/manifest.json` and must match for release CI.

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
- `POST /api/send-session` — begin a protected send before phone-side preparation
- `POST /api/send-session/:sessionId/renew` — renew that send
- `POST /api/send-session/:sessionId/end` — release that send
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
