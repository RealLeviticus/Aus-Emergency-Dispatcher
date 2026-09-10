# Aus Emergency Dispatcher

Nextron/Electron desktop app using the hub template structure.

## Scripts

- `npm run dev` starts the Nextron development app.
- `npm run build` builds the renderer + main process and packages the Windows installer
  into `dist/` (no upload).
- `npm run package` builds the desktop app output.
- `npm run publish` uploads a built release to the update feed on the VPS.
- `npm run release` = `build` then `publish` — the normal way to ship.
- `npm run art:installer` regenerates the NSIS wizard bitmaps from `resources/icon.png`.

See [RELEASING.md](RELEASING.md) for the release loop, the update feed, the beta channel
and code signing.

## Distribution

Users get a signed-in-future NSIS wizard (`Aus Emergency Dispatcher Setup <version>.exe`)
and the app keeps itself current from `https://dispatcher.actuallyleviticus.xyz/updates`:
it checks on the splash at launch, again every 6 hours, and on demand from
**Help ▸ Check for updates…**.

- installer/uninstaller behaviour: `electron-builder.yml` + `resources/installer.nsh`
- updater: `main/updater.ts`, surfaced by `renderer/components/UpdateDialog.tsx` and the splash
- server side: the `handle_path /updates/*` block in `API/Caddyfile.snippet`

## Current Shell

- Hub-style startup splash route at `/`.
- Main dispatcher workspace at `/home`.
- Slide-out sidebar layout for core dispatcher sections.
