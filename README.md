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
- `npm run lint` runs ESLint (flat config in `eslint.config.js`; ESLint 9 does not read
  `.eslintrc.*`, so the old config was silently doing nothing).

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

Two routes only — `/` (startup splash) and `/home` (the Y2K desktop shell and dispatch
console). Preferences live in the in-console **Options** window (File ▸ Options…), not a
separate page.

- The job board is readable at all times; claiming, joining and starting a job require the
  sim to be loaded with an operating base set. See `canAct` / `DutyGate` in
  `renderer/components/DispatchConsole.tsx`.
- Keyboard on the board: `↑`/`↓` move the selection, `Enter` opens the brief, `Esc` closes it.
- Never render `Date.now()` / `new Date()` directly in JSX. These pages are statically
  exported, so the value is frozen at build time AND breaks hydration — use state plus an
  effect (see `StatusClock`).
