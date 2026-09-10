# Releasing Aus Emergency Dispatcher

Every install updates itself from a static feed on the VPS. A release is two things: an
installer, and a `latest.yml` next to it that tells running apps the installer exists.

```
  npm version patch          bump the version (0.29.0 -> 0.29.1)
  npm run release            build the installer, then upload it
```

That is the whole loop. The rest of this file is what sits behind it.

---

## One-time setup

### 1. The folder on the VPS

```bash
sudo mkdir -p /opt/aed-dispatcher/updates
sudo chown "$USER" /opt/aed-dispatcher/updates
```

### 2. Caddy

Append the `dispatcher.actuallyleviticus.xyz` block from [`Caddyfile.snippet`](https://github.com/RealLeviticus/Aus-Emergency-Dispatcher-API/blob/main/Caddyfile.snippet)
to the VPS Caddyfile and reload. It adds a `handle_path /updates/*` file server in front of
the existing `reverse_proxy` to the sync API, so one hostname serves both.

```bash
sudo systemctl reload caddy
curl -I https://dispatcher.actuallyleviticus.xyz/updates/
```

### 3. Credentials on your machine

`npm run publish` uploads over `scp`, so it needs somewhere to send things. Set these once
(System Properties ▸ Environment Variables, or a `.env` you load yourself):

| Variable | Example | |
| --- | --- | --- |
| `AED_PUBLISH_TARGET` | `deploy@139.99.195.169:/opt/aed-dispatcher/updates` | required |
| `AED_PUBLISH_URL` | `https://dispatcher.actuallyleviticus.xyz/updates` | optional, read from `electron-builder.yml` if unset |
| `AED_PUBLISH_SSH_KEY` | `C:\Users\you\.ssh\id_ed25519` | optional |

`AED_PUBLISH_HOST` + `AED_PUBLISH_PATH` (+ `AED_PUBLISH_USER`) work instead of `TARGET`.

Use an SSH key, not a password — `scp` cannot prompt for one mid-script.

---

## Cutting a release

```bash
cd "Desktop App"
npm version patch          # or minor / major — this is what users compare against
npm run release
```

`release` runs `build` then `publish`:

- **build** — `nextron build --no-pack`, strip the stray `app/package.json`, then
  `electron-builder --win --publish never`. Produces `dist/`:
  `Aus Emergency Dispatcher Setup <version>.exe`, its `.blockmap`, and `latest.yml`.
- **publish** — uploads the `.exe`, then the `.blockmap`, then `latest.yml`, and reads the
  feed back to confirm the version it now serves matches what you built.

The upload order is deliberate. `latest.yml` goes last because the moment it lands, every
running app treats the installer it names as downloadable. Upload it first and clients spend
that window taking 404s.

`npm run publish -- --dry-run` shows what would go up without sending anything.

### Version numbers

`package.json` `version` is the only source of truth. electron-updater compares it against
the feed with semver, so `0.29.1` beats `0.29.0` and `0.30.0-beta.1` is a prerelease that
only beta-channel installs will take.

---

## What users experience

**Installing.** A normal Windows wizard: welcome page with the app artwork, the GPL licence,
per-user vs all-users, a directory they can change, shortcut options, and a finish page that
launches the app. Per-user is the default and needs no admin rights.

**Updating.** On launch the splash checks the feed (10s cap). If there is a new version it
downloads it right there with a progress bar and installs before the console opens — nobody
joins a shared job on a stale build. A **Skip** link appears after 4 seconds and demotes it to
a background download that installs when they next close the app.

If a release lands while someone is already flying, the app picks it up on its 6-hourly
re-check and raises a quiet banner above the console instead of interrupting. **Help ▸ Check
for updates…** opens the same dialog on demand.

A failed check never blocks anyone. An unreachable feed, a half-published release, a timeout —
all of them fall through to starting the app normally, and it tries again next launch.

**Uninstalling.** Removes the app, the `aus-emergency-dispatcher-objects` package from every
MSFS Community folder it was copied into (tracked in `installed-msfs-packages.txt`), and — only
if the user says yes — their settings and operator accounts.

---

## Beta channel

The update dialog has a **Get beta builds** checkbox, which points that install at `beta.yml`
instead of `latest.yml`. To publish one:

```bash
npm version 0.30.0-beta.1
npm run build -- --config.publish.channel=beta
npm run publish
```

Stable users never see it; `latest.yml` is untouched. Ship the real release normally afterwards.

---

## Code signing

Builds are currently **unsigned**. Two consequences:

1. Windows SmartScreen shows "Windows protected your PC" on the downloaded installer. Users
   click **More info -> Run anyway**. Unsigned files build reputation per-file-hash, so every
   new release starts from zero, forever.
2. `win.verifyUpdateCodeSignature: false` is set in `electron-builder.yml`. With no publisher
   name to match, electron-updater would otherwise refuse its own downloads.

**This is a first-install problem, not an every-update problem.** SmartScreen's prompt keys off
the Mark-of-the-Web that *browsers* attach to downloads. electron-updater fetches the installer
over plain HTTP from within the app and runs it directly, so no MOTW is set and no prompt
appears. Only the initial download from a link hits SmartScreen.

### Options, for an Australian developer

| | Cost | Available to AU? | SmartScreen |
| --- | --- | --- | --- |
| **SignPath Foundation** (open source) | Free | Yes | OV-level; reputation builds over releases |
| **Microsoft Store, MSIX** | Free | Yes | None at all - Microsoft re-signs |
| **OV certificate** (DigiCert/Sectigo/GlobalSign) | ~$150-300/yr | Yes | Reputation builds over releases |
| **Azure Artifact Signing** (ex-Trusted Signing) | ~$9.99/mo | **No** | - |
| **EV certificate** | $400+/yr | Yes | Same as OV since 2024 |
| **Self-signed** | Free | Yes | Worse than unsigned - blocks install |

Two corrections to what "everyone knows" about code signing, both of which matter here:

- **Azure Artifact Signing is not open to Australia.** Organizations are limited to the USA,
  Canada, the EU and the UK; individual developers to the USA and Canada. It is the usual
  recommendation for a project this size and it is simply unavailable, so don't burn time on it.
- **EV certificates no longer bypass SmartScreen.** That behaviour was removed in 2024; EV now
  builds reputation exactly like OV. Paying the EV premium for SmartScreen alone is wasted money.

**The free route that fits this project: SignPath Foundation.** `LICENSE.txt` is already GPL-3
(an OSI licence), which is the main hurdle. Their conditions: OSI-approved licence with no
commercial dual-licensing, the signing team must own the repository, builds must be traceable
to source, every release needs manual approval, MFA for all contributors, and the project must
be actively maintained and already released with "verifiable reputation". Neither repo is
pushed anywhere public yet, so that has to happen first.

The other free route, the **Microsoft Store as MSIX**, is the only option with *zero* SmartScreen
friction, but it replaces this entire updater: Store apps update through the Store, so
`main/updater.ts`, the feed and the NSIS installer all become dead code. Not worth it unless
Store distribution is a goal in its own right.

### Wiring a certificate in

Once you have one, set `CSC_LINK` (path or base64 of the `.pfx`) and `CSC_KEY_PASSWORD` in the
environment - electron-builder picks them up with no config change. Then delete the
`verifyUpdateCodeSignature` line from `electron-builder.yml` so update payloads are signature-
checked again, and keep signing every release with the *same* identity, or reputation restarts.

## Artwork

The wizard bitmaps are generated, not hand-drawn — regenerate them after changing the logo:

```bash
npm run art:installer      # resources/{installer,uninstaller}Sidebar.bmp, installerHeader.bmp
```

MUI2 fixes those sizes (164×314 sidebars, 150×57 header) and only reads Windows BMP, so
`resources/_make-installer-art.mjs` composes with sharp and writes the 24-bit DIB itself.

---

## Troubleshooting

**"The app never sees a new version."** The feed url is baked into each build at package time
(`electron-builder.yml` ▸ `publish.url`, copied to `app-update.yml` inside the package). An app
built against the wrong url will keep polling the wrong url forever — check with:

```bash
cat dist/win-unpacked/resources/app-update.yml
```

**"Update check failed" in the dialog.** Fetch what the app fetches:

```bash
curl -s https://dispatcher.actuallyleviticus.xyz/updates/latest.yml
curl -I  "https://dispatcher.actuallyleviticus.xyz/updates/Aus%20Emergency%20Dispatcher%20Setup%200.29.1.exe"
```

Both must be 200. A 200 on the manifest with a 404 on the installer is the classic
half-published release — re-run `npm run publish`.

**Testing the updater without shipping.** Set `AED_DEV_UPDATE=1` to make a dev run check the
real feed (electron-updater reads `dev-app-update.yml` for the url). Easier in practice: build
a release one patch version *below* what is published and run the installed app.

**Old releases.** Nothing prunes `/opt/aed-dispatcher/updates`. Old `.exe`s cost disk but let
people re-download a known-good build; delete them by hand when the folder gets unwieldy.
Never delete the `.exe` that the current `latest.yml` names.
