import { app, BrowserWindow, ipcMain } from 'electron';
import Store from 'electron-store';
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater';

/**
 * Auto-update against the static feed published on the VPS
 * (electron-builder.yml -> publish.provider: generic). electron-builder bakes
 * that url into app-update.yml at package time; nothing here needs the url.
 *
 * Shape of the experience:
 *   launch    check, capped at 10s. An update downloads on the splash with a
 *             progress bar and installs before the console opens, so nobody
 *             joins a shared job on a stale build. There is no skip: the only
 *             escape is DOWNLOAD_TIMEOUT_MS, after which the app starts and the
 *             update installs on quit instead.
 *   running   re-check every 6h; a ready update raises a banner rather than
 *             interrupting anyone mid-job.
 *   dev       no checks at all - there is no packaged feed to check against.
 */

export type UpdatePhase =
  | 'idle'
  | 'disabled'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export type UpdateChannel = 'latest' | 'beta';

export type UpdateState = {
  phase: UpdatePhase;
  currentVersion: string;
  newVersion: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  /** 0-100 */
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
  error: string | null;
  channel: UpdateChannel;
  /** the launch gate is still holding the splash */
  gating: boolean;
  lastCheckedAt: number | null;
};

/** How long the splash waits on the version check before giving up on it. */
const CHECK_TIMEOUT_MS = 10_000;
/**
 * Hard cap on a launch-time download; past this we start the app regardless and
 * the update installs on quit instead. With the splash's "Skip" control removed
 * this is the ONLY escape from a slow download, so keep it comfortably shorter
 * than a user's patience.
 */
const DOWNLOAD_TIMEOUT_MS = 3 * 60_000;
/** Background re-check while the console is open. */
const RECHECK_INTERVAL_MS = 6 * 60 * 60_000;

const settings = new Store<{ updateChannel: UpdateChannel }>({ name: 'updates' });

let state: UpdateState = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  newVersion: null,
  releaseNotes: null,
  releaseDate: null,
  percent: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0,
  error: null,
  channel: settings.get('updateChannel', 'latest'),
  gating: false,
  lastCheckedAt: null,
};

export type LaunchVerdict = 'proceed' | 'installing';

let wired = false;
let launchVerdict: ((v: LaunchVerdict) => void) | null = null;
let recheckTimer: NodeJS.Timeout | null = null;

/** In dev there is no app-update.yml, so electron-updater would only throw. */
function updatesPossible(): boolean {
  return app.isPackaged || process.env.AED_DEV_UPDATE === '1';
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:state', state);
  }
}

function patch(next: Partial<UpdateState>): void {
  state = { ...state, ...next };
  broadcast();
}

/** Release notes arrive as a string, or as a per-version array. */
function notesToText(info: UpdateInfo): string | null {
  const raw = info.releaseNotes;
  if (!raw) return null;
  const strip = (s: string) => s.replace(/<[^>]+>/g, '').trim();
  if (typeof raw === 'string') return strip(raw) || null;
  return (
    raw
      .map((n) => strip(n.note ?? ''))
      .filter(Boolean)
      .join('\n\n') || null
  );
}

function settleLaunch(verdict: LaunchVerdict): void {
  const resolve = launchVerdict;
  launchVerdict = null;
  if (resolve) {
    patch({ gating: false });
    resolve(verdict);
  }
}

function wire(): void {
  if (wired) return;
  wired = true;

  autoUpdater.autoDownload = true;
  // A download that outlives the splash still lands: it is applied the next
  // time the app closes, with no prompt.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.channel = state.channel;
  autoUpdater.allowPrerelease = state.channel !== 'latest';
  if (process.env.AED_DEV_UPDATE === '1') autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.logger = {
    info: (m: unknown) => console.log('[updater]', m),
    warn: (m: unknown) => console.warn('[updater]', m),
    error: (m: unknown) => console.error('[updater]', m),
    debug: () => undefined,
  };

  autoUpdater.on('checking-for-update', () => patch({ phase: 'checking', error: null }));

  autoUpdater.on('update-not-available', () => {
    patch({ phase: 'up-to-date', newVersion: null, lastCheckedAt: Date.now() });
    settleLaunch('proceed');
  });

  autoUpdater.on('update-available', (info: UpdateInfo) =>
    patch({
      phase: 'available',
      newVersion: info.version,
      releaseNotes: notesToText(info),
      releaseDate: info.releaseDate ?? null,
      lastCheckedAt: Date.now(),
    }),
  );

  autoUpdater.on('download-progress', (p: ProgressInfo) =>
    patch({
      phase: 'downloading',
      percent: Math.max(0, Math.min(100, Math.round(p.percent))),
      bytesPerSecond: Math.round(p.bytesPerSecond),
      transferred: p.transferred,
      total: p.total,
    }),
  );

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    patch({ phase: 'downloaded', newVersion: info.version, percent: 100 });
    // Only take over the launch if the splash is still waiting on us. Once the
    // console is open, a ready update waits for the operator to say when.
    if (launchVerdict) {
      patch({ phase: 'installing' });
      settleLaunch('installing');
      setTimeout(() => install(), 400);
    }
  });

  autoUpdater.on('error', (err: Error) => {
    // An unreachable or half-published feed must never keep anyone out of the
    // app - record it and carry on.
    patch({ phase: 'error', error: err?.message ?? String(err), lastCheckedAt: Date.now() });
    settleLaunch('proceed');
  });
}

/**
 * The launch-time check. Resolves 'installing' only when the app is about to
 * restart into a new version; every other outcome resolves 'proceed' so the
 * splash can open the console.
 */
export async function runLaunchCheck(): Promise<LaunchVerdict> {
  if (!updatesPossible()) {
    patch({ phase: 'disabled' });
    return 'proceed';
  }
  wire();
  patch({ gating: true, error: null });

  const verdict = new Promise<LaunchVerdict>((resolve) => {
    launchVerdict = resolve;
  });

  // Two guards: one on the check itself, one on the whole download. Both fall
  // through to starting the app.
  const checkGuard = setTimeout(() => {
    if (state.phase === 'checking' || state.phase === 'idle') settleLaunch('proceed');
  }, CHECK_TIMEOUT_MS);
  const downloadGuard = setTimeout(() => settleLaunch('proceed'), DOWNLOAD_TIMEOUT_MS);

  // Deliberately not awaited: a request that never settles must not outlive the
  // guards above. Failures surface through the 'error' handler.
  void autoUpdater.checkForUpdates().catch(() => undefined);

  const result = await verdict;
  clearTimeout(checkGuard);
  clearTimeout(downloadGuard);
  return result;
}

/** Manual check from the Help menu. Never gates anything. */
export async function checkNow(): Promise<UpdateState> {
  if (!updatesPossible()) {
    patch({ phase: 'disabled' });
    return state;
  }
  wire();
  patch({ error: null });
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    patch({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
  }
  return state;
}

export function install(): void {
  if (state.phase !== 'downloaded' && state.phase !== 'installing') return;
  patch({ phase: 'installing' });
  // Silent, so operators are not walked through the wizard on every patch, and
  // relaunch straight back into the console.
  setImmediate(() => autoUpdater.quitAndInstall(true, true));
}

export function getState(): UpdateState {
  return state;
}

/** Named alias for callers outside this module (background.ts). */
export const getUpdateState = getState;

export function setChannel(channel: UpdateChannel): UpdateState {
  settings.set('updateChannel', channel);
  patch({ channel });
  if (wired) {
    autoUpdater.channel = channel;
    autoUpdater.allowPrerelease = channel !== 'latest';
  }
  return state;
}

/** Re-check periodically so a long session still picks up a release. */
function startPeriodicChecks(): void {
  if (recheckTimer || !updatesPossible()) return;
  recheckTimer = setInterval(() => {
    if (state.phase === 'downloading' || state.phase === 'downloaded' || state.phase === 'installing') return;
    void checkNow();
  }, RECHECK_INTERVAL_MS);
}

export function registerUpdaterIpc(): void {
  ipcMain.handle('update:getState', () => getState());
  ipcMain.handle('update:check', () => checkNow());
  ipcMain.handle('update:install', () => {
    install();
    return getState();
  });
  ipcMain.handle('update:setChannel', (_e, channel: UpdateChannel) =>
    setChannel(channel === 'beta' ? 'beta' : 'latest'),
  );
  ipcMain.handle('update:launchCheck', async () => {
    const verdict = await runLaunchCheck();
    startPeriodicChecks();
    return verdict;
  });
}

export function stopUpdater(): void {
  if (recheckTimer) clearInterval(recheckTimer);
  recheckTimer = null;
}
