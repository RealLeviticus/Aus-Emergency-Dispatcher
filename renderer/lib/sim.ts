import { useEffect, useState } from 'react';

export type SimPosition = {
  lat: number;
  lon: number;
  altitudeFt: number;
  altitudeAglFt: number;
  headingTrueDeg: number;
  groundSpeedKt: number;
  verticalSpeedFpm: number;
  onGround: boolean;
  aircraftTitle: string;
  liveryName: string;
  /** best available registration for the paint */
  tailNumber: string;
  /** where tailNumber came from: livery aircraft.cfg, livery name text, or the menu override */
  tailNumberSource: 'livery.cfg' | 'livery name' | 'menu' | 'none';
  /** raw ATC ID simvar (player-editable menu value) */
  atcId: string;
  atcModel: string;
  atcType: string;
  atcAirline: string;
  /** MSFS ENGINE TYPE enum (3 = helo-turbine) — used to pick rotary vs fixed tasking */
  engineType: number;
  /** estimated still-air range on current fuel with a ~20% reserve (NM); 0 if unknown */
  estRangeNm: number;
  /** cruise speed used for the range estimate (kt) */
  cruiseKt: number;
  at: number;
};

export type InjectedObject = {
  requestId: number;
  objectId: number | null;
  title: string;
  lat: number;
  lon: number;
  headingDeg: number;
  onGround: boolean;
  source: 'local' | 'remote';
  error?: string;
  remoteId?: string;
  isAircraft?: boolean;
  /** airborne contact: current altitude / speed / whether it's still holding */
  altFt?: number;
  speedKt?: number;
  holding?: boolean;
  label?: string;
};

export type SimStatus = {
  connected: boolean;
  simName: string | null;
  simConnectVersion: string | null;
  lastError: string | null;
  position: SimPosition | null;
  injected: InjectedObject[];
};

export type SyncStatus = {
  connected: boolean;
  url: string;
  sessionId: string | null;
  peers: number;
  lastError: string | null;
};

export const EMPTY_SIM_STATUS: SimStatus = {
  connected: false,
  simName: null,
  simConnectVersion: null,
  lastError: null,
  position: null,
  injected: [],
};

export const EMPTY_SYNC_STATUS: SyncStatus = {
  connected: false,
  url: '',
  sessionId: null,
  peers: 0,
  lastError: null,
};

function useIpcStatus<T>(getChannel: string, pushChannel: string, empty: T): T {
  const [status, setStatus] = useState<T>(empty);
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    Promise.resolve(window.ipc?.invoke?.(getChannel))
      .then((value) => {
        if (value) setStatus(value as T);
      })
      .catch(() => undefined);
    try {
      unsubscribe = window.ipc?.on?.(pushChannel, (value: unknown) => setStatus(value as T));
    } catch {
      /* not running in Electron */
    }
    return () => {
      try {
        unsubscribe?.();
      } catch {
        /* ignore */
      }
    };
  }, [getChannel, pushChannel]);
  return status;
}

export const useSimStatus = (): SimStatus => useIpcStatus('sim:getStatus', 'sim:status', EMPTY_SIM_STATUS);
export const useSyncStatus = (): SyncStatus => useIpcStatus('sync:getStatus', 'sync:status', EMPTY_SYNC_STATUS);

export type PeerPresence = {
  clientId: string;
  at: number;
  lat: number;
  lon: number;
  altFt: number;
  headingDeg: number;
  groundSpeedKt: number;
  onGround: boolean;
  callsign: string;
  aircraft: string;
  phase: string;
};

export function useSyncPeers(): PeerPresence[] {
  const [peers, setPeers] = useState<PeerPresence[]>([]);
  useEffect(() => {
    let off: (() => void) | undefined;
    Promise.resolve(window.ipc?.invoke?.('sync:getPeers'))
      .then((v) => Array.isArray(v) && setPeers(v as PeerPresence[]))
      .catch(() => undefined);
    try {
      off = window.ipc?.on?.('sync:peers', (v: unknown) => setPeers((v as PeerPresence[]) ?? []));
    } catch {
      /* not electron */
    }
    return () => {
      try {
        off?.();
      } catch {
        /* ignore */
      }
    };
  }, []);
  return peers;
}

export type InjectResult = {
  ok: boolean;
  object?: InjectedObject;
  error?: string;
  shared?: boolean;
  session?: string | null;
};
export type SceneResult = { ok: boolean; objects?: InjectedObject[]; error?: string; session?: string | null };
export type ClearResult = { ok: boolean; removed?: number };

export type GpsStatus = {
  /** PMS50 GTN750 detected running in the cockpit */
  gtnDetected: boolean;
  gtnPremium: boolean;
  currentPage: number;
  lastAction: string | null;
  lastResult: string | null;
};

export const sim = {
  reconnect: () => window.ipc?.invoke?.('sim:start'),
  injectTest: (options?: { preset?: string; title?: string; distanceMeters?: number; bearingOffsetDeg?: number }) =>
    window.ipc?.invoke?.('sim:injectTest', options) as Promise<InjectResult | undefined>,
  injectScene: (spec: {
    sceneId: string;
    lat: number;
    lon: number;
    headingDeg?: number;
    kind?: string;
    category?: string;
    seed?: string;
    headingSeed?: string;
    sceneKey?: string;
  }) => window.ipc?.invoke?.('sim:injectScene', spec) as Promise<SceneResult | undefined>,
  /** Remove everything placed for one job (called when the job is cleared). */
  clearScene: (sceneKey: string) =>
    window.ipc?.invoke?.('sim:clearScene', sceneKey) as Promise<{ ok: boolean; removed: number } | undefined>,
  injectSceneAhead: (spec: { sceneId: string; distanceMeters?: number }) =>
    window.ipc?.invoke?.('sim:injectSceneAhead', spec) as Promise<SceneResult | undefined>,
  injectAirContact: (spec: {
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
  }) => window.ipc?.invoke?.('sim:injectAirContact', spec) as Promise<{ ok: boolean; error?: string } | undefined>,
  fsltlStatus: () =>
    window.ipc?.invoke?.('fsltl:status') as Promise<
      { installed: boolean; trafficBase: boolean; packages: string[]; titles: string[] } | undefined
    >,
  clearInjected: () => window.ipc?.invoke?.('sim:clearInjected') as Promise<ClearResult | undefined>,
  objectPresets: () =>
    window.ipc?.invoke?.('sim:objectPresets') as Promise<{ id: string; label: string }[] | undefined>,
  sceneList: () => window.ipc?.invoke?.('sim:sceneList') as Promise<{ id: string; label: string }[] | undefined>,
  getAirports: () =>
    window.ipc?.invoke?.('sim:getAirports') as Promise<
      { ident: string; lat: number; lon: number; altFt: number }[] | undefined
    >,
  setSession: (sessionId: string | null) => window.ipc?.invoke?.('sync:setSession', sessionId),
  setPresenceContext: (ctx: {
    phase?: string;
    jobId?: string;
    jobKind?: string;
    jobLat?: number;
    jobLon?: number;
    jobPlace?: string;
    agency?: string;
  }) => window.ipc?.invoke?.('presence:setContext', ctx),
  gpsDirectTo: (spec: {
    jobId?: string;
    base?: { name: string; lat: number; lon: number };
    scene: { name: string; lat: number; lon: number };
    hospital?: { name: string; lat: number; lon: number } | null;
  }) => window.ipc?.invoke?.('gps:directTo', spec) as Promise<{ ok: boolean; note: string } | undefined>,
  gpsGetStatus: () => window.ipc?.invoke?.('gps:getStatus') as Promise<GpsStatus | undefined>,

  // --- third-party scene-object packs (30West / HPG H145 Action Pack) ----
  addonStatus: () =>
    window.ipc?.invoke?.('addons:status') as Promise<AddonStatus | undefined>,
  addonInstall: () =>
    window.ipc?.invoke?.('addons:install') as Promise<
      { ok: boolean; message: string; installedFolders: string[] } | undefined
    >,
  addonOpenFolder: () => window.ipc?.invoke?.('addons:openFolder'),
  addonOpenUrl: (url: string) => window.ipc?.invoke?.('addons:openUrl', url),
  addonPromptSuppressed: () =>
    window.ipc?.invoke?.('addons:promptSuppressed') as Promise<boolean | undefined>,
  addonSuppressPrompt: (on: boolean) =>
    window.ipc?.invoke?.('addons:suppressPrompt', on) as Promise<boolean | undefined>,
};

export type AddonStatus = {
  packsDir: string;
  communityFolders: string[];
  zips: string[];
  packs: {
    id: string;
    name: string;
    author: string;
    url: string;
    usedFor: string;
    required: boolean;
    installed: boolean;
    partial: boolean;
    missingFolders: string[];
  }[];
  ready: boolean;
};

// --- geo -------------------------------------------------------------------

const R_NM = 3440.065; // earth radius in nautical miles
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

/** Great-circle range (NM) and initial bearing (deg true) from a → b. */
export function rangeBearing(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): { rangeNm: number; bearingDeg: number } {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  const rangeNm = 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const bearingDeg = (toDeg(Math.atan2(y, x)) + 360) % 360;
  return { rangeNm, bearingDeg };
}

export function formatLatLon(p: { lat: number; lon: number }): string {
  const ns = p.lat >= 0 ? 'N' : 'S';
  const ew = p.lon >= 0 ? 'E' : 'W';
  return `${Math.abs(p.lat).toFixed(4)}° ${ns}  ${Math.abs(p.lon).toFixed(4)}° ${ew}`;
}

export function formatEta(rangeNm: number, groundSpeedKt: number): string {
  if (groundSpeedKt < 20) return '—';
  const minutes = (rangeNm / groundSpeedKt) * 60;
  if (minutes < 1) return '<1 min';
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${Math.round(minutes % 60)}m`;
  return `${Math.round(minutes)} min`;
}
