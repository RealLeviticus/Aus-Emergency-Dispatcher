import path from 'path';
import os from 'os';
import { existsSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import serve from 'electron-serve';
import Store from 'electron-store';
import { createWindow } from './helpers';
import { simBridge, OBJECT_PRESETS, type SimStatus } from './simconnect';
import { SCENE_LIST, reloadSceneTitleOverrides } from './scenes';
import { accounts } from './accounts';
import { autoInstallIfMissing, installPackage, packageStatus } from './packages';
import {
  ADDON_PACKS,
  addonStatus,
  autoInstallAddonsIfPresent,
  installDownloadedPacks,
  openPacksFolder,
} from './addonpacks';
import { contactTitles, fsltlStatus } from './fsltl';
import { isConfigured as discordOauthConfigured, linkDiscord } from './discord-oauth';
import { SyncClient, DEFAULT_SYNC_URL, type RemoteObject, type SyncStatus, type PeerPresence } from './syncclient';
import { discord, DEFAULT_DISCORD_APP_ID } from './discord';
import { getUpdateState, registerUpdaterIpc, stopUpdater } from './updater';
import { configureRegeditScripts } from './regedit-vbs';
import type { SplashProfileId } from '../renderer/config/splash';

let splashWindow: BrowserWindow | null = null;
/** set when the startup auto-install actually refreshed the Community package */
let packageNote: string | null = null;
let mainWindow: BrowserWindow | null = null;
let splashStartTime = 0;

const isProd = process.env.NODE_ENV === 'production';
// Long enough for the branding to register, short enough not to be a toll on
// every launch. The update check runs concurrently and has its own cap, and the
// splash can be clicked to skip the remainder.
const splashMinDuration = 1800;
/** Give the launch update check (10 s cap) room before the backstop fires. */
const SPLASH_BACKSTOP_MS = 60_000;
const preferences = new Store<{
  splashProfile: SplashProfileId;
  raafvOverride?: boolean;
  /** user ticked "don't show the scene-pack setup prompt again" */
  hidePackPrompt?: boolean;
}>({
  name: 'preferences',
});
// Only the per-install identity is persisted now — the sync server URL and the
// Discord app id are hard-coded (DEFAULT_SYNC_URL / DEFAULT_DISCORD_APP_ID) and
// no longer user-configurable.
const identity = new Store<{ syncClientId: string; syncClientHost: string }>({ name: 'identity' });

// A stable per-install id used to tell "my" injected objects from a peer's.
// Regenerate it if this config was copied to another machine (VM image / copied
// %APPDATA%) — otherwise two installs share an id and each silently ignores the
// other's objects. The server also de-dupes ids per session as a backstop.
const thisHost = os.hostname();
let syncClientId = identity.get('syncClientId', '');
const storedHost = identity.get('syncClientHost', '');
if (!syncClientId || (storedHost && storedHost !== thisHost)) {
  syncClientId = randomUUID();
  identity.set('syncClientId', syncClientId);
}
if (storedHost !== thisHost) identity.set('syncClientHost', thisHost);

const syncClient = new SyncClient(syncClientId, { url: DEFAULT_SYNC_URL, token: '' });
syncClient.setOperatorName(accounts.current()?.name ?? 'Operator');

// --- shared job pool (server-generated tasking) -----------------------
type ServerJob = { id: string; status: string; [k: string]: unknown };
const jobPool = new Map<string, ServerJob>();
let pushJobs: () => void = () => undefined;
function jobsArray(): ServerJob[] {
  return [...jobPool.values()];
}

/** Initial true bearing A→B (equirectangular, adequate at these ranges). */
function bearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLon = (b.lon - a.lon) * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  const dLat = b.lat - a.lat;
  return ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
}
syncClient.on('jobList', (jobs: ServerJob[]) => {
  jobPool.clear();
  for (const j of jobs) if (j && j.id) jobPool.set(j.id, j);
  pushJobs();
});
syncClient.on('jobUpsert', (job: ServerJob) => {
  if (job && job.id) {
    jobPool.set(job.id, job);
    pushJobs();
  }
});
syncClient.on('jobRemove', (id: string) => {
  if (jobPool.delete(id)) pushJobs();
});

// Mirror peers' injected objects into this simulator, and drop them when removed.
// Objects that arrive before our sim is connected are queued and flushed on connect.
const pendingRemote = new Map<string, RemoteObject>();

function tryInjectRemote(obj: RemoteObject): void {
  if (simBridge.findRemote(obj.id)) return;
  const meta = (obj.meta ?? {}) as {
    airContact?: boolean;
    speedKt?: number;
    altFt?: number;
    route?: { lat: number; lon: number; altFt: number; speedKt: number }[];
    loop?: boolean;
    label?: string;
  };
  try {
    if (meta.airContact) {
      simBridge.injectAirContact({
        remoteId: obj.id,
        titles: [obj.title, ...(obj.fallbacks ?? [])],
        lat: obj.lat,
        lon: obj.lon,
        altFt: meta.altFt ?? obj.altFt ?? 8000,
        headingDeg: obj.headingDeg,
        speedKt: meta.speedKt ?? 0,
        // Fly the same waypoint list locally so it moves smoothly between the
        // owner's ~1 Hz position reports (which only drift-correct it).
        route: meta.route,
        loop: meta.loop,
        label: meta.label,
      });
    } else {
      simBridge.injectRemote({
        remoteId: obj.id,
        titles: [obj.title, ...(obj.fallbacks ?? [])],
        lat: obj.lat,
        lon: obj.lon,
        altitudeFt: obj.altFt,
        headingDeg: obj.headingDeg,
        onGround: obj.onGround,
      });
    }
    pendingRemote.delete(obj.id);
  } catch {
    pendingRemote.set(obj.id, obj);
  }
}

syncClient.on('remoteCreate', (obj: RemoteObject) => tryInjectRemote(obj));
syncClient.on('remoteUpdate', (obj: RemoteObject) => {
  simBridge.moveContact(obj.id, {
    lat: obj.lat,
    lon: obj.lon,
    altFt: obj.altFt ?? 8000,
    headingDeg: obj.headingDeg,
  });
});
syncClient.on('remoteRemove', (remoteId: string) => {
  pendingRemote.delete(remoteId);
  const record = simBridge.findRemote(remoteId);
  if (record) simBridge.removeInjected(record.requestId);
});

// Broadcast our moving contacts so every unit sees the same track.
const contactServerId = new Map<number, string>(); // local requestId -> server object id
const pendingContactTemp = new Map<string, number>(); // tempId -> local requestId
syncClient.on('ownObject', ({ tempId, id }: { tempId: string; id: string }) => {
  const reqId = pendingContactTemp.get(tempId);
  if (reqId != null) {
    contactServerId.set(reqId, id);
    pendingContactTemp.delete(tempId);
  }
});
simBridge.on(
  'contactMove',
  (m: { requestId: number; remoteId?: string; lat: number; lon: number; altFt: number; headingDeg: number }) => {
    if (m.remoteId) return; // we don't own remote contacts
    const sid = contactServerId.get(m.requestId);
    if (sid) syncClient.updateObject(sid, { lat: m.lat, lon: m.lon, altFt: m.altFt, headingDeg: m.headingDeg });
  },
);
let wasSimConnected = false;
simBridge.on('status', (s: SimStatus) => {
  if (s.connected && !wasSimConnected) for (const o of [...pendingRemote.values()]) tryInjectRemote(o);
  wasSimConnected = s.connected;
});

// --- mission context + peer presence -----------------------------------
let missionContext = { phase: 'idle', jobId: '', jobKind: '', jobLat: 0, jobLon: 0, jobPlace: '', agency: '' };
let lastJobLocate = 0;

function discordCtx(connected: boolean) {
  const p = simBridge.getStatus().position;
  return {
    connected,
    callsign: currentCallsign(),
    aircraft: p?.atcModel || p?.atcType || p?.aircraftTitle || '',
    rotary: p ? p.engineType === 3 : undefined,
    operator: accounts.current()?.name,
    ...missionContext,
  };
}
const peers = new Map<string, PeerPresence>();
let lastPresenceSent = 0;

function currentCallsign(): string {
  const p = simBridge.getStatus().position;
  return p?.tailNumber || p?.atcId || '';
}

syncClient.on('peerPresence', (p: PeerPresence) => {
  peers.set(p.clientId, p);
});
syncClient.on('peerLeft', (clientId: string) => peers.delete(clientId));
setInterval(() => {
  const cutoff = Date.now() - 15_000;
  for (const [id, p] of peers) if (p.at < cutoff) peers.delete(id);
}, 5000);

if (isProd) {
  serve({ directory: 'app' });
}

function appUrl(route = '') {
  if (isProd) {
    return `app://./${route}`;
  }

  const port = process.argv[2] || '8888';
  return `http://localhost:${port}/${route}`;
}

function getWindowIcon(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), 'resources', 'icon.ico'),
    path.join(process.resourcesPath, 'icon.ico'),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function createSplashWindow() {
  splashStartTime = Date.now();

  splashWindow = createWindow('bootstrapper', {
    width: 500,
    height: 300,
    center: true,
    frame: false,
    autoHideMenuBar: true,
    resizable: false,
    icon: getWindowIcon(),
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  await splashWindow.loadURL(appUrl());

  // Backstop: the splash is what asks for the main window, so a renderer that
  // fails to load would otherwise leave the user staring at it. Open anyway
  // unless an update is mid-flight and about to restart us.
  setTimeout(() => {
    const phase = getUpdateState().phase;
    if (!mainWindow && phase !== 'downloading' && phase !== 'installing') ipcMain.emit('openApp');
  }, SPLASH_BACKSTOP_MS);
}

app.whenReady().then(() => {
  // Before any SimConnect autodetect, which falls back to a registry read.
  configureRegeditScripts();
  registerUpdaterIpc();
  createSplashWindow();
  void writeSceneTitleExample();
  void writeCreditsFile();
  // Put the shared scene-object package into the MSFS Community folder(s) so every
  // operator sees the same objects with no setup. An app update that changes the
  // models or their effects is pushed out here too, so nobody reinstalls by hand.
  void autoInstallIfMissing().then((r) => {
    if (r.action === 'updated') {
      // MSFS only reads Community packages at startup, so say so.
      packageNote = `Scene objects updated to ${r.version} in ${r.folders} Community folder(s) — restart MSFS to load the new models and fire/smoke effects.`;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('packages:note', packageNote);
    }
  });
  // If the user has dropped the third-party pack ZIPs into the AddonPacks folder,
  // extract them into every Community folder (licences forbid us bundling them).
  void autoInstallAddonsIfPresent();
});

/** A plain-text credits / licence note in the data folder (Help ▸ Model credits). */
async function writeCreditsFile(): Promise<void> {
  try {
    const dir = path.join(app.getPath('documents'), 'Aus Emergency Dispatcher');
    await mkdir(dir, { recursive: true });
    const body = [
      'Aus Emergency Dispatcher — models & credits',
      '',
      'Scene objects (cars, ambulance, fire appliance, police car, rescue boat,',
      'hi-vis figures, patient, spot fires, cordon) are ORIGINAL low-poly meshes',
      'generated by resources/msfs-packages/_build.mjs and shipped in the',
      '"aus-emergency-dispatcher-objects" package that the app installs into your',
      'MSFS Community folder. They are free to use, modify and share. No',
      'third-party / flightsim.to models are bundled or redistributed.',
      '',
      'MSFS 2024 base-game fallback: on MSFS 2024, before falling back to the',
      'AED_* meshes the app uses the sim’s OWN SimObjects - Microsoft_Car_*,',
      'Microsoft_Truck_Fire_*, Microsoft_Bus_*, Tarmac_/Marshaller_ figures,',
      'Stretcher01_orange, Cone_Medium, PowerPylon_*, Log_01, LifeRaft, animals -',
      'so a clean MSFS 2024 with no add-on packs still shows real vehicles and',
      'people at every job. (These are Asobo/Microsoft base content.)',
      '',
      'Recommended free packs (bring your own): the scenes engine targets these',
      'flightsim.to object packs. Their licences forbid us bundling or downloading',
      'them, so download each one yourself and drop the ZIP into',
      '"Aus Emergency Dispatcher\\AddonPacks" — the app extracts them into your',
      'MSFS Community folder(s) and re-applies them after sim updates.',
      '  - 30West HEMS Objects        https://flightsim.to/file/69699/hems-objects',
      '  - HPG H145 Action Pack HEMS  https://flightsim.to/file/47913/h145-action-pack-hems-objects',
      '  - HPG H145 Offshore Objects  https://flightsim.to/file/43408/h145-action-pack-offshore-objects',
      '    (c) 30West and (c) 68ponyGT / HPG - used under their own licences;',
      '    redistribution by third parties is not permitted.',
      '',
      'FSLTL and any "moving vehicle simobject library" (wsv_*) are also picked up',
      'automatically if present. Map object pools to titles with scene-titles.json',
      '(see scene-titles.example.json).',
      '',
      'Fire & smoke: these are the simulator’s OWN particle effects. They are',
      'drawn by MSFS from a VisualEffectLib SimObject - on MSFS 2024 the app',
      'prefers the 2024-native effect objects from the 30West / 68ponyGT VFX packs',
      '(Smoke_Grey_*, Signal_Smoke_Orange, Fire with Light *). MSFS 2024 has no',
      'free stand-alone spawnable fire/smoke object of its own, and SimConnect',
      'cannot place a raw effect, so a VFX pack (or the app’s AED_SpotFire',
      'fallback) is still what carries the effect. On MSFS 2020 the 2024-only',
      'effect objects are skipped automatically.',
      '',
      'GPS routes are exported as fpl.pln for the PMS50 GTN750 (its own product).',
    ].join('\n');
    await writeFile(path.join(dir, 'CREDITS.md'), body, { flag: 'w' });
  } catch {
    /* best effort */
  }
}

/**
 * Drop a documented template for the scene-title override next to where the app
 * looks for the real file, so a tester can see the format. Never overwrites the
 * live `scene-titles.json`.
 */
async function writeSceneTitleExample(): Promise<void> {
  try {
    const dir = path.join(app.getPath('documents'), 'Aus Emergency Dispatcher');
    await mkdir(dir, { recursive: true });
    const body = {
      _readme:
        'Rename to scene-titles.json to use. Each key is an object pool; the value is an ' +
        'ordered list of SimObject container titles to try (first that spawns wins; Windsock ' +
        'is always the last resort). The defaults below use the 30West HEMS Objects and ' +
        '68ponyGT / HPG "H145 Action Pack" object packs — install those in your Community ' +
        'folder. Add your own titles here to override any pool.',
      car: ['Wrecked Sedan', 'Mercedes A45', '30West A45'],
      carAlt: ['Wrecked Hatchback', 'WreckedSUV01-D2', 'Renault Clio Wrecked'],
      truck: ['TowTruck1', 'Wrecked Fuel Truck', 'EU Tanker Truck 1'],
      emergency: ['30West Ambu Berlin', '30West Ambu Johanniter', 'TowTruck2'],
      police: ['30West Ambu Berlin lights'],
      boat: ['Cabin Boat 1', 'Fishing Boat 1', 'Lifeboat1'],
      debris: ['30West wreck', 'WreckedCar01-D9'],
      marker: ['30West marker post 6m', '30West constr_light', 'Heliport Beacon 30m'],
      person: ['30West Worker injured', 'Worker_lying', 'Female_lying_blanket', '30West dazed'],
      medic: ['30West paramedic', '30West cpr', 'Worker_sitting'],
      patient: ['Female_lying_blanket', 'Worker_lying', 'Female_recovery_pose'],
      spotfire: ['Fire with Light 1', 'Fire with Light 2', 'Signal Flare', 'Smoke Effects'],
      fireseat: ['Fire with Light 3', 'Fire with Light 2', 'Smoke Effects'],
    };
    await writeFile(path.join(dir, 'scene-titles.example.json'), JSON.stringify(body, null, 2), { flag: 'w' });
  } catch {
    /* best effort */
  }
}

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  simBridge.stop();
  syncClient.stop();
  discord.stop();
  stopUpdater();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createSplashWindow();
  }
});

ipcMain.on('openApp', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return;
  }

  const elapsed = Date.now() - splashStartTime;
  const waitTime = Math.max(0, splashMinDuration - elapsed);

  setTimeout(async () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
    }

    mainWindow = createWindow(
      'main',
      {
        width: 1440,
        height: 960,
        minWidth: 1024,
        minHeight: 640,
        resizable: true,
        frame: false,
        autoHideMenuBar: true,
        icon: getWindowIcon(),
        backgroundColor: '#16283a',
        title: 'Aus Emergency Dispatcher',
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
        },
      },
      { maximizeOnFirstRun: true },
    );

    mainWindow.setMenuBarVisibility(false);

    mainWindow.on('closed', () => {
      mainWindow = null;
      simBridge.stop();
      app.quit();
    });

    // Push SimConnect + sync status to the renderer as they change.
    const send = (channel: string, payload: unknown) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
    };
    const forwardSimStatus = (status: SimStatus) => {
      send('sim:status', status);
      const pos = status.position;
      if (pos && Date.now() - lastPresenceSent > 2000) {
        lastPresenceSent = Date.now();
        syncClient.sendPresence({
          lat: pos.lat,
          lon: pos.lon,
          altFt: pos.altitudeFt,
          headingDeg: pos.headingTrueDeg,
          groundSpeedKt: pos.groundSpeedKt,
          onGround: pos.onGround,
          callsign: currentCallsign(),
          aircraft: pos.atcModel || pos.atcType || pos.aircraftTitle,
          phase: missionContext.phase,
        });
      }
      // Bias the shared job pool toward where the operator actually is.
      if (pos && Math.abs(pos.lat) > 0.02 && Date.now() - lastJobLocate > 60_000) {
        lastJobLocate = Date.now();
        syncClient.locateForJobs(pos.lat, pos.lon);
      }
      discord.update(discordCtx(status.connected));
    };
    const forwardSyncStatus = (status: SyncStatus) => send('sync:status', status);
    simBridge.on('status', forwardSimStatus);
    syncClient.on('status', forwardSyncStatus);
    syncClient.on('peerPresence', () => send('sync:peers', [...peers.values()]));
    syncClient.on('peerLeft', () => send('sync:peers', [...peers.values()]));
    pushJobs = () => send('jobs:feed', jobsArray());
    mainWindow.webContents.once('did-finish-load', () => {
      forwardSimStatus(simBridge.getStatus());
      forwardSyncStatus(syncClient.getStatus());
      send('sync:peers', [...peers.values()]);
      pushJobs();
    });
    simBridge.start();
    discord.start(DEFAULT_DISCORD_APP_ID);

    await mainWindow.loadURL(appUrl('home'));

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });
  }, waitTime);
});

ipcMain.handle('getAppVersion', () => app.getVersion());

// Which app surfaces the operator is entitled to. The public emergency console
// is always available. RAAFv normally requires a linked Discord account with the
// RAAFv role — but a local testing override (Start ▸ "RAAFv local unlock", or the
// locked taskbar pill) flips it on without Discord, for FSLTL / tasking testing.
ipcMain.handle('getEntitlements', () => ({
  emergency: true,
  raafv: accounts.current()?.entitlements?.raafv === true || preferences.get('raafvOverride', false) === true,
}));
ipcMain.handle('auth:raafvOverrideGet', () => preferences.get('raafvOverride', false) === true);
ipcMain.handle('auth:raafvOverride', (_e, on: boolean) => {
  preferences.set('raafvOverride', Boolean(on));
  notifyEntitlements();
  return preferences.get('raafvOverride', false) === true;
});
ipcMain.handle('auth:discordConfigured', () => discordOauthConfigured());
function notifyEntitlements(): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('entitlements:changed', null);
}
ipcMain.handle('auth:discordLink', async () => {
  const cur = accounts.current();
  if (!cur) return { ok: false, error: 'Sign in to a local operator profile first.' };
  const res = await linkDiscord();
  if (res.ok && res.user) {
    accounts.setDiscord(cur.id, { discord: res.user, raafv: Boolean(res.raafv) });
    notifyEntitlements();
  }
  return res;
});
ipcMain.handle('auth:discordUnlink', () => {
  const cur = accounts.current();
  if (cur) accounts.setDiscord(cur.id, null);
  notifyEntitlements();
  return accounts.current();
});

ipcMain.handle('getSplashProfile', () => preferences.get('splashProfile', 'emergency'));

ipcMain.handle('setSplashProfile', (_event, profile: SplashProfileId) => {
  if (profile !== 'emergency' && profile !== 'military') return false;
  preferences.set('splashProfile', profile);
  return true;
});

ipcMain.handle('getSystemStatus', () => ({
  cad: { status: 'Offline', detail: 'CAD link not configured' },
  mapping: { status: 'Offline', detail: 'Map provider not configured' },
  radio: { status: 'Offline', detail: 'Radio gateway not configured' },
}));

// --- SimConnect / MSFS bridge ---------------------------------------------
ipcMain.handle('sim:getStatus', () => simBridge.getStatus());
ipcMain.handle('sim:start', () => {
  simBridge.start();
  return simBridge.getStatus();
});
ipcMain.handle('sim:stop', () => {
  simBridge.stop();
  return simBridge.getStatus();
});
ipcMain.handle(
  'sim:injectTest',
  (_event, options?: { preset?: string; title?: string; distanceMeters?: number; bearingOffsetDeg?: number }) => {
    try {
      const object = simBridge.injectTestObject(options);
      // Share it so every unit in the session sees it in the same place. Peers
      // that lack the preferred title fall back through this list.
      const { sent } = syncClient.publishObject({
        title: object.titles[0]!,
        fallbacks: object.titles.slice(1, 6),
        lat: object.lat,
        lon: object.lon,
        headingDeg: object.headingDeg,
        onGround: object.onGround,
        kind: 'test',
      });
      return { ok: true, object, shared: sent, session: syncClient.connectedSession };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);
ipcMain.handle('sim:clearInjected', () => {
  syncClient.removeMine();
  return { ok: true, removed: simBridge.clearInjectedObjects() };
});
// Tear down one job's scene when the job is cleared. removeMine() tells the
// session so other crews drop their mirrored copies too (they handle
// 'object.removed' already).
ipcMain.handle('sim:clearScene', (_e, sceneKey: string) => {
  const removed = simBridge.clearScene(String(sceneKey ?? ''));
  if (removed > 0) syncClient.removeMine();
  return { ok: true, removed };
});
ipcMain.handle('sim:getAirports', () => simBridge.getAirports());

// --- shared job pool -------------------------------------------------
ipcMain.handle('jobs:list', () => jobsArray());
ipcMain.handle('jobs:locate', (_e, lat: number, lon: number, channel?: 'emergency' | 'raafv') =>
  syncClient.locateForJobs(lat, lon, channel ?? 'emergency'),
);
ipcMain.handle('jobs:claim', (_e, jobId: string) => syncClient.claimJob(jobId));
ipcMain.handle('jobs:join', (_e, jobId: string) => syncClient.joinJob(jobId));
ipcMain.handle('jobs:leave', (_e, jobId: string) => syncClient.leaveJob(jobId));
ipcMain.handle('jobs:release', (_e, jobId: string) => syncClient.releaseJob(jobId));
ipcMain.handle('jobs:start', (_e, jobId: string) => syncClient.startJob(jobId));
ipcMain.handle('jobs:progress', (_e, jobId: string, phase: string) => syncClient.jobProgress(jobId, phase));
ipcMain.handle('jobs:complete', (_e, jobId: string) => syncClient.completeJob(jobId));

// --- operator accounts (local profiles) --------------------------------
function syncOperatorName(): void {
  syncClient.setOperatorName(accounts.current()?.name ?? 'Operator');
}
ipcMain.handle('account:list', () => accounts.list());
ipcMain.handle('account:current', () => accounts.current());
ipcMain.handle('account:create', (_e, input: { name: string; callsign?: string; role?: string }) => {
  const a = accounts.create(input ?? { name: 'Operator' });
  syncOperatorName();
  return a;
});
ipcMain.handle('account:update', (_e, id: string, patch: { name?: string; callsign?: string; role?: string }) => {
  const a = accounts.update(id, patch ?? {});
  syncOperatorName();
  return a;
});
ipcMain.handle('account:switch', (_e, id: string | null) => {
  const a = accounts.switch(id ?? null);
  syncOperatorName();
  return a;
});
ipcMain.handle('account:delete', (_e, id: string) => {
  accounts.remove(id);
  syncOperatorName();
  return accounts.list();
});

// --- app / window helpers for the menu bar ----------------------------
ipcMain.handle('app:openDataFolder', async () => {
  await shell.openPath(path.join(app.getPath('documents'), 'Aus Emergency Dispatcher'));
  return true;
});
ipcMain.handle('app:openUserData', async () => {
  await shell.openPath(app.getPath('userData'));
  return true;
});
ipcMain.handle('window:setAlwaysOnTop', (_e, on: boolean) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(Boolean(on));
  return Boolean(on);
});
ipcMain.handle('window:reload', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reload();
  return true;
});

// --- bundled MSFS scene-object package --------------------------------
ipcMain.handle('packages:status', () => packageStatus());
ipcMain.handle('packages:note', () => packageNote);
ipcMain.handle('packages:install', () => installPackage());
ipcMain.handle('packages:openCommunity', async () => {
  const s = await packageStatus();
  if (s.communityFolders[0]) await shell.openPath(s.communityFolders[0]);
  return Boolean(s.communityFolders[0]);
});

// --- third-party scene-object packs (30West / HPG H145 Action Pack) ----
// Licences forbid redistribution, so we can't download or bundle these. The
// user drops the flightsim.to ZIPs into Documents\Aus Emergency Dispatcher\
// AddonPacks and the app extracts them into every MSFS Community folder.
ipcMain.handle('addons:list', () => ADDON_PACKS);
ipcMain.handle('addons:status', () => addonStatus());
ipcMain.handle('addons:install', () => installDownloadedPacks());
ipcMain.handle('addons:openFolder', () => openPacksFolder());
ipcMain.handle('addons:openUrl', (_e, url: string) => {
  if (typeof url === 'string' && /^https:\/\/flightsim\.to\//i.test(url)) void shell.openExternal(url);
  return true;
});
// First-run setup prompt: the renderer shows the Scene Objects dialog on launch
// when a required pack is missing, unless the user has opted out here.
ipcMain.handle('addons:promptSuppressed', () => preferences.get('hidePackPrompt', false) === true);
ipcMain.handle('addons:suppressPrompt', (_e, on: boolean) => {
  preferences.set('hidePackPrompt', Boolean(on));
  return preferences.get('hidePackPrompt', false) === true;
});

// --- Object sync (dispatcher-api) ---------------------------------------
// Server URL is hard-coded (DEFAULT_SYNC_URL); the only knob is which session
// to join, which follows the accepted job.
ipcMain.handle('sync:getStatus', () => syncClient.getStatus());
ipcMain.handle('sync:setSession', (_event, sessionId: string | null) => {
  syncClient.setSession(sessionId && typeof sessionId === 'string' ? sessionId : null);
  return syncClient.getStatus();
});
ipcMain.handle('sync:getPeers', () => [...peers.values()]);
ipcMain.handle('sim:objectPresets', () => Object.entries(OBJECT_PRESETS).map(([id, p]) => ({ id, label: p.label })));
ipcMain.handle('sim:sceneList', () => SCENE_LIST);

// --- mission context, Discord presence, GPS direct-to ------------------
ipcMain.handle(
  'presence:setContext',
  (
    _event,
    ctx: {
      phase?: string;
      jobId?: string;
      jobKind?: string;
      jobLat?: number;
      jobLon?: number;
      jobPlace?: string;
      agency?: string;
    },
  ) => {
    missionContext = {
      phase: ctx.phase ?? 'idle',
      jobId: ctx.jobId ?? '',
      jobKind: ctx.jobKind ?? '',
      jobLat: typeof ctx.jobLat === 'number' ? ctx.jobLat : 0,
      jobLon: typeof ctx.jobLon === 'number' ? ctx.jobLon : 0,
      jobPlace: ctx.jobPlace ?? '',
      agency: ctx.agency ?? '',
    };
    discord.update(discordCtx(simBridge.getStatus().connected));
    return true;
  },
);
ipcMain.handle(
  'gps:directTo',
  (
    _event,
    spec: {
      jobId?: string;
      base?: { name: string; lat: number; lon: number };
      scene: { name: string; lat: number; lon: number };
      hospital?: { name: string; lat: number; lon: number } | null;
    },
  ) => simBridge.directTo(spec),
);
ipcMain.handle('gps:getStatus', () => simBridge.getGpsStatus());
ipcMain.handle(
  'sim:injectScene',
  (
    _event,
    spec: {
      sceneId: string;
      lat: number;
      lon: number;
      headingDeg?: number;
      kind?: string;
      category?: string;
      seed?: string;
      headingSeed?: string;
      sceneKey?: string;
    },
  ) => {
    try {
      reloadSceneTitleOverrides(); // pick up edits to scene-titles.json without a restart
      const objects = simBridge.injectScene(spec);
      for (const object of objects) {
        syncClient.publishObject({
          title: object.titles[0]!,
          fallbacks: object.titles.slice(1, 6),
          lat: object.lat,
          lon: object.lon,
          headingDeg: object.headingDeg,
          onGround: object.onGround,
          kind: 'static',
        });
      }
      return { ok: true, objects, session: syncClient.connectedSession };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

// Local-only: drop a scene on the ground just ahead of the aircraft, for
// eyeballing that the MVA / fire / etc. models spawn correctly. Not shared.
ipcMain.handle('sim:injectSceneAhead', (_event, spec: { sceneId: string; distanceMeters?: number }) => {
  try {
    reloadSceneTitleOverrides();
    const objects = simBridge.injectSceneAhead(spec);
    return { ok: true, objects };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// --- FSLTL / moving airborne contacts --------------------------------
ipcMain.handle('fsltl:status', () => fsltlStatus());
ipcMain.handle(
  'sim:injectAirContact',
  async (
    _event,
    spec: {
      lat?: number;
      lon?: number;
      altFt?: number;
      headingDeg?: number;
      speedKt?: number;
      title?: string;
      titleHint?: 'jet' | 'heavy' | 'prop' | 'light';
      route?: { lat: number; lon: number; altFt: number; speedKt: number }[];
      loop?: boolean;
      formation?: number;
      holdUntilNm?: number;
      label?: string;
    },
  ) => {
    try {
      const pool = spec.title ? [spec.title] : await contactTitles(spec.titleHint ?? 'jet');
      const wp0 = spec.route?.[0];
      const altFt = wp0?.altFt ?? spec.altFt ?? 9000;
      const speedKt = wp0?.speedKt ?? spec.speedKt ?? 240;
      const headingDeg = spec.headingDeg ?? 90;
      const n = Math.max(1, Math.min(4, spec.formation ?? 1));

      // Offset each formation member ~2 NM back along the initial track, so a raid
      // spawns in trail rather than on top of each other.
      const NM = 60;
      const trailBrg =
        spec.route && spec.route.length > 1 ? bearing(spec.route[0]!, spec.route[1]!) : (headingDeg + 180) % 360;
      const shift = (rt: { lat: number; lon: number; altFt: number; speedKt: number }[] | undefined, back: number) => {
        if (!rt) return rt;
        const br = ((trailBrg + 180) % 360) * (Math.PI / 180); // opposite = behind
        const dLat = (back * Math.cos(br)) / NM;
        return rt.map((w) => ({
          ...w,
          lat: w.lat + dLat,
          lon: w.lon + (back * Math.sin(br)) / (NM * Math.cos((w.lat * Math.PI) / 180)),
        }));
      };

      let first: ReturnType<typeof simBridge.injectAirContact> | null = null;
      for (let i = 0; i < n; i++) {
        const route = shift(spec.route, i * 2.2);
        const label = n > 1 ? `${spec.label ?? 'Contact'} #${i + 1}` : spec.label;
        // Randomise the model each spawn (each raid member gets a different one).
        const titles = [...pool].sort(() => Math.random() - 0.5);
        const rec = simBridge.injectAirContact({
          titles,
          lat: route ? undefined : spec.lat,
          lon: route ? undefined : spec.lon,
          altFt,
          headingDeg,
          speedKt,
          route,
          loop: spec.loop,
          holdUntilNm: spec.holdUntilNm,
          label,
        });
        if (!first) first = rec;
        const { tempId } = syncClient.publishObject({
          title: rec.titles[0]!,
          fallbacks: rec.titles.slice(1, 6),
          lat: rec.lat,
          lon: rec.lon,
          headingDeg: rec.headingDeg,
          onGround: false,
          kind: 'aircraft',
          altFt: rec.altFt ?? altFt,
          // Peers fly the same waypoint list, so give them the route too.
          meta: {
            airContact: true,
            speedKt: rec.speedKt ?? speedKt,
            altFt: rec.altFt ?? altFt,
            route: route ?? undefined,
            loop: spec.loop,
            label,
          },
        });
        pendingContactTemp.set(tempId, rec.requestId);
      }
      return { ok: true, object: first, count: n, session: syncClient.connectedSession };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

ipcMain.on('windowControl', (_event, arg) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (arg === 'minimize') {
    mainWindow.minimize();
    return;
  }

  if (arg === 'maximize') {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
    return;
  }

  if (arg === 'close') {
    mainWindow.removeAllListeners('close');
    mainWindow.removeAllListeners('closed');
    mainWindow.close();
    app.quit();
  }
});
