import { EventEmitter } from 'events';
import {
  open,
  Protocol,
  FacilityListType,
  SimConnectConstants,
  SimConnectDataType,
  SimConnectPeriod,
  EventFlag,
  InitPosition,
  type SimConnectConnection,
  type RecvOpen,
  type RecvSimObjectData,
  type RecvAssignedObjectID,
  type RecvException,
  type RecvAirportList,
  RawBuffer,
} from 'node-simconnect';
import { liveryIndex } from './liveries';
import { tdsGtnxi, writeDirectPln } from './gps';
import {
  fireThrottleFor,
  getSceneObjects,
  sceneForJob,
  sceneHeading,
  sceneObjectTitles,
  setSceneSimProfile,
} from './scenes';

const EVT_BASE = 5000;
const DEF_POSITION = 1;
const REQ_POSITION = 1;
// LIVERY NAME is an MSFS 2024-only simvar; kept in its own definition so it can
// fail on MSFS 2020 without corrupting the length of the main position packet.
const DEF_LIVERY = 2;
const REQ_LIVERY = 2;
// PMS50 GTN750 state (L: vars) — its own request, tolerant of the vars not existing.
const DEF_GPS = 3;
const REQ_GPS = 3;
// ENGINE TYPE (rotary detection) — its own request so it can't disturb the main packet.
const DEF_ENGINE = 4;
const REQ_ENGINE = 4;
// Repositioning definition for moving injected contacts (drift correction only).
const DEF_MOVE = 6;
const REQ_AIRPORTS = 7;
// Fuel + cruise-speed, for an aircraft range estimate (its own request).
const DEF_PERF = 8;
const REQ_PERF = 8;

/**
 * Throttle on a spawned object. The scene packs' fire objects gate their flames
 * on their own throttle lever, so lighting a fire means writing this after the
 * sim hands back the object id (see `fireThrottleFor`).
 */
const DEF_FIRE = 9;
const REQ_INJECT_BASE = 1000;
const EARTH_RADIUS_M = 6378137;
const NM_PER_DEG = 60;
/** keep airfields within this range of the aircraft */
const AIRPORT_RANGE_NM = 550;

export type Airport = { ident: string; lat: number; lon: number; altFt: number };

export type GpsStatus = {
  /** PMS50 GTN750 gauge is present in the sim (from its L: vars) */
  gtnDetected: boolean;
  gtnPremium: boolean;
  currentPage: number;
  /** TDS GTNXi is installed on this PC (a filesystem check, not a sim var) */
  tdsDetected: boolean;
  /** what proved the GTNXi install */
  tdsEvidence: string | null;
  lastAction: string | null;
  lastResult: string | null;
};

/** Titles that ship with every MSFS install, tried when a preferred object is missing. */
const GENERIC_FALLBACKS = ['Windsock', 'FuelTruck', 'Pushback_Blue', 'PushBack'];

/**
 * Shared-object presets. Each is a chain of base-sim container titles so that
 * MSFS 2020 and 2024 both land on the same visible object. The chain self-heals
 * if a particular title is missing in one sim.
 */
export const OBJECT_PRESETS: Record<string, { label: string; titles: string[] }> = {
  windsock: { label: 'Windsock (marker)', titles: ['Windsock', 'FuelTruck', 'Pushback_Blue'] },
  fueltruck: { label: 'Fuel truck', titles: ['FuelTruck', 'Pushback_Blue', 'Windsock'] },
  pushback: { label: 'Tug', titles: ['Pushback_Blue', 'PushBack', 'FuelTruck', 'Windsock'] },
  aircraft: { label: 'Copy of my aircraft', titles: [] }, // filled with the live title at inject time
};
export type ObjectPresetId = keyof typeof OBJECT_PRESETS;

type SpawnAt = { lat: number; lon: number; altitudeFt: number; headingDeg: number; onGround: boolean };

export type SimPosition = {
  lat: number;
  lon: number;
  altitudeFt: number;
  altitudeAglFt: number;
  headingTrueDeg: number;
  groundSpeedKt: number;
  verticalSpeedFpm: number;
  onGround: boolean;
  /** aircraft.cfg container title for the selected livery */
  aircraftTitle: string;
  /** LIVERY NAME simvar (MSFS 2024; may be empty on 2020) */
  liveryName: string;
  /** best available registration for the aircraft's paint (see tailNumberSource) */
  tailNumber: string;
  /** where tailNumber came from */
  tailNumberSource: 'livery.cfg' | 'livery name' | 'menu' | 'none';
  /** raw ATC ID simvar (the player-editable menu value) */
  atcId: string;
  atcModel: string;
  atcType: string;
  atcAirline: string;
  /** MSFS ENGINE TYPE enum: 0 piston, 1 jet, 2 none, 3 helo-turbine, 4 rocket, 5 turboprop */
  engineType: number;
  /** estimated still-air range on current fuel, with a ~20% reserve (NM); 0 if unknown */
  estRangeNm: number;
  /** cruise speed used for the estimate (kt) */
  cruiseKt: number;
  at: number;
};

/** MSFS reports itself by internal codename; show something a human recognises. */
function friendlySimName(applicationName: string): string {
  const map: Record<string, string> = {
    KittyHawk: 'Microsoft Flight Simulator 2020',
    SunRise: 'Microsoft Flight Simulator 2024',
  };
  return map[applicationName] ?? applicationName;
}

const PLACEHOLDER_ID = /^(|TAIL ?NUMBER|N\/?A|NONE|DEFAULT|UNKNOWN|ASX\d*|AI ?\d+|REG(ISTRATION)?)$/;

function normalizeRego(raw: string): string {
  const t = raw.trim().toUpperCase();
  if (t.includes('-')) return t;
  // insert the hyphen for a 1-2 letter nationality prefix (VHABC -> VH-ABC)
  return t.replace(/^([A-Z]{1,2})([A-Z0-9]{3,4})$/, '$1-$2');
}

/**
 * Livery creators set `atc_id` in the [FLTSIM.n] block of the livery's
 * aircraft.cfg, so the `ATC ID` simvar is usually the real registration. Trust
 * it unless it is empty or an obvious placeholder (the player-overridable
 * "Tail number" field defaults to junk on some aircraft).
 */
function registrationFromAtcId(atcId: string): string {
  const t = atcId.trim().toUpperCase();
  if (t.length < 2 || t.length > 8) return '';
  if (PLACEHOLDER_ID.test(t)) return '';
  if (!/[A-Z]/.test(t)) return ''; // all digits => not a rego
  if (!/^[A-Z0-9]{1,3}-?[A-Z0-9]{2,6}$/.test(t)) return '';
  return normalizeRego(t);
}

/**
 * Fallback: pull a registration out of the livery name / container title when
 * `ATC ID` was blank or placeholder.
 */
function registrationFromLivery(...sources: string[]): string {
  const text = sources.filter(Boolean).join('  ').toUpperCase();
  const patterns: RegExp[] = [
    /\bA\d{1,2}-\d{2,3}\b/, // ADF: A44-223, A39-001
    /\bVH-?[A-Z]{3}\b/, // AU civil: VH-ABC / VHABC
    /\b[A-Z]{1,2}-[A-Z]{3,4}\b/, // ICAO hyphenated: G-ABCD, D-AIMA, ZK-JGB, HB-ZRC, A6-EOG-ish
    /\bN\d{1,5}[A-Z]{0,2}\b/, // US: N12345, N1AB
    /\b[A-Z]\d-[A-Z]{2,4}\b/, // Gulf/one-letter-digit: A6-EOG, A7-BCD
    /\b[A-Z]{2}-\d{3,4}\b/, // e.g. EC-123, HL-1234
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return normalizeRego(m[0]);
  }
  return '';
}

/**
 * Resolve the registration painted on the aircraft, most-authoritative first:
 *  1. the livery's own `atc_id` read from its aircraft.cfg (immune to the menu override)
 *  2. a registration embedded in the livery name / container title
 *  3. the `ATC ID` simvar — the player-editable menu value, only if it looks real
 */
function resolveTailNumber(
  aircraftTitle: string,
  liveryName: string,
  atcId: string,
): { value: string; source: SimPosition['tailNumberSource'] } {
  const fromCfg = liveryIndex.lookup(aircraftTitle);
  if (fromCfg && registrationFromAtcId(fromCfg)) {
    return { value: normalizeRego(fromCfg), source: 'livery.cfg' };
  }
  const fromText = registrationFromLivery(liveryName, aircraftTitle);
  if (fromText) return { value: fromText, source: 'livery name' };
  const fromMenu = registrationFromAtcId(atcId);
  if (fromMenu) return { value: fromMenu, source: 'menu' };
  return { value: '', source: 'none' };
}

export type InjectedObject = {
  requestId: number;
  objectId: number | null;
  /** the container title currently being tried */
  title: string;
  /** ordered fallback chain; index 0 is the preferred title */
  titles: string[];
  titleIndex: number;
  /** true once a preferred title failed and a fallback was used */
  substituted: boolean;
  lat: number;
  lon: number;
  headingDeg: number;
  onGround: boolean;
  source: 'local' | 'remote';
  /** set if every title in the chain was rejected */
  error?: string;
  /** server object id, when this was mirrored from a peer */
  remoteId?: string;
  /** true = spawned as an AI aircraft (aICreateNonATCAircraft) rather than a static object */
  isAircraft?: boolean;
  /** airborne contact: feet AMSL and a track velocity */
  altFt?: number;
  speedKt?: number;
  /** fire objects only: the throttle percent that makes them burn, and how big */
  fireLevel?: number;
  /** airborne contact: a route to fly (waypoints); when unset it flies a constant track */
  route?: { lat: number; lon: number; altFt: number; speedKt: number }[];
  routeIdx?: number;
  routeLoop?: boolean;
  /** the contact loiters at route[0] until the user's aircraft is within this range */
  holdUntilNm?: number;
  /** true while it is still holding (waiting for the interceptor) */
  holding?: boolean;
  /**
   * A GROUND or surface contact — the car in a police pursuit, a convoy, a
   * vessel of interest. It flies the same route machinery as an air contact
   * but is pinned to terrain, turns like a vehicle rather than an aircraft,
   * and captures waypoints at road scale instead of 1.5 NM.
   */
  isGround?: boolean;
  /** a fleeing vehicle stops dead at the end of its route (the bail-out) */
  stopAtEnd?: boolean;
  /** true once it has reached the end of the route and stopped */
  stopped?: boolean;
  /** display label, e.g. "Fast mover, FL350" */
  label?: string;
  /** current attitude we write for smooth rendering */
  pitch?: number;
  bank?: number;
  /** ms of the last peer position report (for dead-reckon between reports) */
  lastMoveAt?: number;
  /** the job this was placed for, so the whole scene can be cleared again */
  sceneKey?: string;
};

export type SimStatus = {
  connected: boolean;
  simName: string | null;
  simConnectVersion: string | null;
  lastError: string | null;
  position: SimPosition | null;
  injected: InjectedObject[];
};

/**
 * Bridges the Electron main process to MSFS via SimConnect (node-simconnect,
 * a pure-TS reimplementation of the protocol — no native module, no SDK DLL).
 *
 * Responsibilities for the current milestone:
 *  - connect / auto-reconnect to a running sim
 *  - stream the user aircraft position (lat/lon/alt/heading/ground speed/on-ground)
 *  - inject a test simulated object relative to the aircraft, and remove injected objects
 */
export class SimBridge extends EventEmitter {
  private handle: SimConnectConnection | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private nextInjectRequestId = REQ_INJECT_BASE;
  private injected = new Map<number, InjectedObject>();
  /** packet sendId -> injection, so a SimConnect exception can be tied to a create */
  private injectBySendId = new Map<number, InjectedObject>();
  /** requestId -> the position to re-use when retrying a failed spawn with the next title */
  private spawnAt = new Map<number, SpawnAt>();
  /** last LIVERY NAME (MSFS 2024) — updated by its own request, merged into position */
  private liveryName = '';
  /** last ENGINE TYPE — updated by its own request, merged into position */
  private engineType = 0;
  /** estimated range on current fuel (NM) + cruise speed (kt), from DEF_PERF */
  private estRangeNm = 0;
  private cruiseKt = 0;
  /** real airfields near the aircraft, from the sim's facility cache (merged, never reset per page) */
  private airportMap = new Map<string, Airport>();
  private airports: Airport[] = [];
  private airportTimer: NodeJS.Timeout | null = null;
  private lastAirportRebuild = 0;

  /** PMS50 GTN750 state, polled from its L: vars (0 when the vars don't resolve) */
  private gps: GpsStatus = {
    gtnDetected: false,
    gtnPremium: false,
    currentPage: 0,
    tdsDetected: false,
    tdsEvidence: null,
    lastAction: null,
    lastResult: null,
  };
  private gpsSeqRunning = false;

  private status: SimStatus = {
    connected: false,
    simName: null,
    simConnectVersion: null,
    lastError: null,
    position: null,
    injected: [],
  };

  getStatus(): SimStatus {
    return this.status;
  }

  start(): void {
    this.stopped = false;
    void this.refreshTdsStatus();
    void this.connect();
  }

  /**
   * Look for a TDS GTNXi install. Unlike the PMS50 check this is a filesystem
   * probe, not a sim var, so it works with the sim closed and is refreshed on
   * start and on every export rather than polled.
   */
  private async refreshTdsStatus(): Promise<void> {
    try {
      const tds = await tdsGtnxi();
      this.gps = { ...this.gps, tdsDetected: tds.installed, tdsEvidence: tds.evidence };
    } catch {
      /* leave the previous answer in place */
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      this.handle?.close();
    } catch {
      /* ignore */
    }
    if (this.airportTimer) {
      clearInterval(this.airportTimer);
      this.airportTimer = null;
    }
    this.handle = null;
    this.injected.clear();
    this.injectBySendId.clear();
    this.airports = [];
    this.airportMap.clear();
    if (this.contactTimer) {
      clearInterval(this.contactTimer);
      this.contactTimer = null;
    }
    this.patch({ connected: false, position: null, injected: [] });
  }

  private patch(next: Partial<SimStatus>): void {
    this.status = { ...this.status, ...next };
    this.emit('status', this.status);
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, 5000);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.handle) return;

    let opened: { recvOpen: RecvOpen; handle: SimConnectConnection };
    try {
      // KittyHawk = MSFS 2020+, forward-compatible with MSFS 2024.
      opened = await open('Aus Emergency Dispatcher', Protocol.KittyHawk);
    } catch (err) {
      this.patch({
        connected: false,
        lastError: err instanceof Error ? err.message : String(err),
      });
      this.scheduleRetry();
      return;
    }

    const { recvOpen, handle } = opened;
    this.handle = handle;
    // "SunRise" = MSFS 2024, "KittyHawk" = MSFS 2020. Fire/smoke effect objects
    // that ship in the 2024-built VFX packs only load on 2024, so tell the
    // scenes engine which particle-effect titles to prefer.
    const msfs2024 = recvOpen.applicationName === 'SunRise' || /2024/.test(recvOpen.applicationName);
    setSceneSimProfile({ msfs2024 });
    this.patch({
      connected: true,
      simName: friendlySimName(recvOpen.applicationName),
      simConnectVersion: `${recvOpen.simConnectVersionMajor}.${recvOpen.simConnectVersionMinor}`,
      lastError: null,
    });

    // Scan livery aircraft.cfg files so we can report the painted registration
    // rather than the player's menu override.
    void liveryIndex.ensureBuilt();

    // Only simvars that exist in BOTH MSFS 2020 and 2024. Read order below MUST match.
    handle.addToDataDefinition(DEF_POSITION, 'PLANE LATITUDE', 'degrees', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_POSITION, 'PLANE LONGITUDE', 'degrees', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_POSITION, 'PLANE ALTITUDE', 'feet', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_POSITION, 'PLANE ALT ABOVE GROUND', 'feet', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_POSITION, 'PLANE HEADING DEGREES TRUE', 'degrees', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_POSITION, 'GROUND VELOCITY', 'knots', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_POSITION, 'VERTICAL SPEED', 'feet per minute', SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_POSITION, 'SIM ON GROUND', 'bool', SimConnectDataType.INT32);
    handle.addToDataDefinition(DEF_POSITION, 'TITLE', null, SimConnectDataType.STRING256);
    handle.addToDataDefinition(DEF_POSITION, 'ATC ID', null, SimConnectDataType.STRING256);
    handle.addToDataDefinition(DEF_POSITION, 'ATC MODEL', null, SimConnectDataType.STRING256);
    handle.addToDataDefinition(DEF_POSITION, 'ATC TYPE', null, SimConnectDataType.STRING256);
    handle.addToDataDefinition(DEF_POSITION, 'ATC AIRLINE', null, SimConnectDataType.STRING256);

    // MSFS 2024 only — its own definition so a rejection on 2020 doesn't shift the packet above.
    try {
      handle.addToDataDefinition(DEF_LIVERY, 'LIVERY NAME', null, SimConnectDataType.STRING256);
      handle.requestDataOnSimObject(
        REQ_LIVERY,
        DEF_LIVERY,
        SimConnectConstants.OBJECT_ID_USER,
        SimConnectPeriod.SECOND,
      );
    } catch {
      /* not on this sim version */
    }

    // PMS50 GTN750 L: vars — its own request; resolve to 0 when the GPS isn't installed.
    try {
      handle.addToDataDefinition(DEF_GPS, 'L:PMS50_GTN750_RUNNING', 'number', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_GPS, 'L:PMS50_GTN750_INSTALLED', 'number', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_GPS, 'L:GTN750_CURRENT_PAGE_1', 'number', SimConnectDataType.FLOAT64);
      handle.requestDataOnSimObject(REQ_GPS, DEF_GPS, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND);
    } catch {
      /* GTN750 not present */
    }

    try {
      handle.addToDataDefinition(DEF_ENGINE, 'ENGINE TYPE', 'enum', SimConnectDataType.INT32);
      handle.requestDataOnSimObject(
        REQ_ENGINE,
        DEF_ENGINE,
        SimConnectConstants.OBJECT_ID_USER,
        SimConnectPeriod.SECOND,
      );
    } catch {
      /* ignore */
    }

    // Full state we push onto a moving injected contact ~4×/s. Setting the
    // velocity/attitude vars (not just lat/lon) is what makes MSFS render it
    // gliding smoothly between our updates — an in-air AI aircraft ignores an
    // AI WAYPOINT LIST, so we drive it directly.
    try {
      handle.addToDataDefinition(DEF_MOVE, 'PLANE LATITUDE', 'degrees', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_MOVE, 'PLANE LONGITUDE', 'degrees', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_MOVE, 'PLANE ALTITUDE', 'feet', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_MOVE, 'PLANE HEADING DEGREES TRUE', 'degrees', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_MOVE, 'PLANE PITCH DEGREES', 'degrees', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_MOVE, 'PLANE BANK DEGREES', 'degrees', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_MOVE, 'AIRSPEED TRUE', 'knots', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_MOVE, 'VELOCITY BODY Z', 'feet per second', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(
        DEF_FIRE,
        'GENERAL ENG THROTTLE LEVER POSITION:1',
        'percent',
        SimConnectDataType.FLOAT64,
      );
    } catch {
      /* ignore */
    }

    // Fuel + design cruise speed, for an aircraft range estimate.
    try {
      handle.addToDataDefinition(DEF_PERF, 'FUEL TOTAL QUANTITY', 'gallons', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_PERF, 'FUEL TOTAL CAPACITY', 'gallons', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_PERF, 'DESIGN SPEED VC', 'knots', SimConnectDataType.FLOAT64);
      handle.addToDataDefinition(DEF_PERF, 'NUMBER OF ENGINES', 'number', SimConnectDataType.INT32);
      handle.requestDataOnSimObject(REQ_PERF, DEF_PERF, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND);
    } catch {
      /* ignore */
    }

    handle.requestDataOnSimObject(
      REQ_POSITION,
      DEF_POSITION,
      SimConnectConstants.OBJECT_ID_USER,
      SimConnectPeriod.SECOND,
    );

    // Airfields near the aircraft. `subscribeToFacilities` dumps the whole
    // "reality bubble" immediately (and streams updates as we move) — far more
    // reliable than a one-shot list, which is often empty until you fly.
    const pokeAirports = () => {
      try {
        handle.requestFacilitiesList(FacilityListType.AIRPORT, REQ_AIRPORTS);
      } catch {
        /* older protocol */
      }
    };
    handle.on('airportList', (recv: RecvAirportList) => {
      if (recv.requestID !== REQ_AIRPORTS) return;
      for (const a of recv.airports) {
        const ident = (a.icao || '').trim();
        if (ident) {
          this.airportMap.set(ident, { ident, lat: a.latitude, lon: a.longitude, altFt: a.altitude * 3.28084 });
        }
      }
      this.rebuildAirports();
    });
    try {
      handle.subscribeToFacilities(FacilityListType.AIRPORT, REQ_AIRPORTS);
    } catch {
      /* fall back to polling below */
    }
    pokeAirports();
    this.airportTimer = setInterval(() => {
      pokeAirports();
      this.rebuildAirports();
    }, 60_000);
    this.airportTimer.unref?.();

    handle.on('simObjectData', (recv: RecvSimObjectData) => {
      try {
        if (recv.requestID === REQ_LIVERY) {
          if (recv.data.remaining() >= 256) this.liveryName = recv.data.readString256();
          return;
        }
        if (recv.requestID === REQ_ENGINE) {
          if (recv.data.remaining() >= 4) this.engineType = recv.data.readInt32();
          return;
        }
        if (recv.requestID === REQ_PERF) {
          if (recv.data.remaining() >= 28) {
            const fuelGal = recv.data.readFloat64();
            const fuelCapGal = recv.data.readFloat64();
            const designVc = recv.data.readFloat64();
            const engines = Math.max(1, recv.data.readInt32());
            // Rough cruise burn per engine (gph) by engine type.
            const gph =
              this.engineType === 1
                ? 160 // jet
                : this.engineType === 5
                  ? 45 // turboprop
                  : this.engineType === 3
                    ? 55 // helo turbine
                    : 11; // piston
            const cruise = designVc > 40 ? designVc : this.engineType === 3 ? 125 : 150;
            const usableGal = fuelGal > 1 ? fuelGal : fuelCapGal > 1 ? fuelCapGal : 0;
            const enduranceHr = usableGal > 0 ? usableGal / (gph * engines) : 0;
            this.cruiseKt = Math.round(cruise);
            // 20% reserve on still-air range.
            this.estRangeNm = Math.round(enduranceHr * cruise * 0.8);
          }
          return;
        }
        if (recv.requestID === REQ_GPS) {
          if (recv.data.remaining() >= 24) {
            const running = recv.data.readFloat64();
            const installed = recv.data.readFloat64();
            const page = recv.data.readFloat64();
            const detected = running > 0.5 || installed > 0.5;
            this.gps = {
              ...this.gps,
              gtnDetected: detected,
              // page index is a Premium-only feature; a non-zero page proves Premium.
              gtnPremium: this.gps.gtnPremium || page > 0,
              currentPage: Math.round(page),
            };
          }
          return;
        }
        if (recv.requestID !== REQ_POSITION) return;
        const str = () => (recv.data.remaining() >= 256 ? recv.data.readString256() : '');
        const lat = recv.data.readFloat64();
        const lon = recv.data.readFloat64();
        const altitudeFt = recv.data.readFloat64();
        const altitudeAglFt = recv.data.readFloat64();
        const headingTrueDeg = recv.data.readFloat64();
        const groundSpeedKt = recv.data.readFloat64();
        const verticalSpeedFpm = recv.data.readFloat64();
        const onGround = recv.data.readInt32() !== 0;
        const aircraftTitle = str();
        const atcId = str();
        const atcModel = str();
        const atcType = str();
        const atcAirline = str();
        const liveryName = this.liveryName;
        const tail = resolveTailNumber(aircraftTitle, liveryName, atcId);
        this.patch({
          position: {
            lat,
            lon,
            altitudeFt,
            altitudeAglFt,
            headingTrueDeg,
            groundSpeedKt,
            verticalSpeedFpm,
            onGround,
            aircraftTitle,
            liveryName,
            tailNumber: tail.value || atcId.trim(),
            tailNumberSource: tail.source,
            atcId,
            atcModel,
            atcType,
            atcAirline,
            engineType: this.engineType,
            estRangeNm: this.estRangeNm,
            cruiseKt: this.cruiseKt,
            at: Date.now(),
          },
        });
        // Re-scope the airfield list to the new position (throttled).
        if (Date.now() - this.lastAirportRebuild > 10_000) {
          this.lastAirportRebuild = Date.now();
          this.rebuildAirports();
        }
      } catch {
        /* short/unexpected packet — skip this sample rather than crashing */
      }
    });

    handle.on('assignedObjectID', (recv: RecvAssignedObjectID) => {
      const record = this.injected.get(recv.requestID);
      if (!record) return;
      record.objectId = recv.objectID;
      this.spawnAt.delete(record.requestId);
      // A fire object spawns at throttle 0, which means no flames at all.
      this.writeFireLevel(record);
      for (const [sendId, r] of this.injectBySendId) if (r === record) this.injectBySendId.delete(sendId);
      // Start driving a moving contact the moment the sim confirms its id.
      if (record.isAircraft && (record.route || record.speedKt)) {
        this.writeFly(record);
        this.ensureContactTick();
      }
      this.patch({ injected: [...this.injected.values()] });
      this.emit('injected', { ...record });
    });

    handle.on('exception', (recv: RecvException) => {
      if (this.directToSendIds.has(recv.sendId)) {
        this.directToSendIds.delete(recv.sendId);
        this.patch({ lastError: `GPS direct-to: SimConnect rejected the request (${recv.exceptionName}).` });
        return;
      }
      const failed = this.injectBySendId.get(recv.sendId);
      if (!failed) {
        this.patch({ lastError: `SimConnect exception: ${recv.exceptionName} (index ${recv.index})` });
        return;
      }
      this.injectBySendId.delete(recv.sendId);
      const at = this.spawnAt.get(failed.requestId);
      const rejected = failed.titles[failed.titleIndex];
      if (at && failed.titleIndex + 1 < failed.titles.length) {
        failed.titleIndex += 1;
        failed.substituted = true;
        this.trySpawn(failed, at);
        this.patch({
          injected: [...this.injected.values()],
          lastError: `"${rejected}" not installed — substituting "${failed.titles[failed.titleIndex]}".`,
        });
      } else {
        failed.error = recv.exceptionName;
        this.spawnAt.delete(failed.requestId);
        this.patch({
          injected: [...this.injected.values()],
          lastError: `Inject failed: none of [${failed.titles.join(', ')}] exist in this sim.`,
        });
      }
    });

    handle.on('error', (err: Error) => this.onClosed(err.message));
    handle.on('quit', () => this.onClosed('The simulator closed the connection.'));
    handle.on('close', () => this.onClosed('SimConnect connection closed.'));
  }

  private onClosed(reason: string): void {
    this.handle = null;
    this.injected.clear();
    this.injectBySendId.clear();
    this.spawnAt.clear();
    this.liveryName = '';
    this.engineType = 0;
    this.estRangeNm = 0;
    this.cruiseKt = 0;
    this.airports = [];
    this.airportMap.clear();
    if (this.airportTimer) {
      clearInterval(this.airportTimer);
      this.airportTimer = null;
    }
    if (this.contactTimer) {
      clearInterval(this.contactTimer);
      this.contactTimer = null;
    }
    // TDS detection is a filesystem fact, not a sim one - losing the sim link
    // must not make an installed GTNXi disappear from the console.
    this.gps = {
      ...this.gps,
      gtnDetected: false,
      gtnPremium: false,
      currentPage: 0,
      lastAction: null,
      lastResult: null,
    };
    this.patch({ connected: false, position: null, injected: [], lastError: reason });
    this.scheduleRetry();
  }

  getGpsStatus(): GpsStatus {
    return this.gps;
  }

  /** Real airfields near the aircraft, nearest first. */
  getAirports(): Airport[] {
    return this.airports;
  }

  private rebuildAirports(): void {
    const pos = this.status.position;
    const all = [...this.airportMap.values()];
    const scoped = pos ? all.filter((ap) => roughRangeNm(pos.lat, pos.lon, ap.lat, ap.lon) <= AIRPORT_RANGE_NM) : all;
    if (pos) {
      scoped.sort(
        (a, b) => roughRangeNm(pos.lat, pos.lon, a.lat, a.lon) - roughRangeNm(pos.lat, pos.lon, b.lat, b.lon),
      );
    }
    this.airports = scoped.slice(0, 600);
  }

  /**
   * Dress a job location with a cluster of objects (a scene). Each object is a
   * self-healing title chain (see scenes.ts). Placed at an absolute lat/lon with
   * a scene heading; objects are offset forward/right of that datum.
   */
  injectScene(spec: {
    sceneId: string;
    lat: number;
    lon: number;
    headingDeg?: number;
    kind?: string;
    category?: string;
    /** seed for the procedural layout — pass the job id so every unit matches */
    seed?: string;
    /** stable orientation key (the job id) — used when headingDeg is not given */
    headingSeed?: string;
    /** tag so the whole scene can be removed again when the job is cleared */
    sceneKey?: string;
  }): InjectedObject[] {
    if (!this.handle) throw new Error('Not connected to a simulator.');
    // 'auto' picks the scene that matches the job's incident type.
    const id = spec.sceneId === 'auto' ? sceneForJob(spec.kind ?? '', spec.category ?? '') : spec.sceneId;
    const objects = getSceneObjects(id, spec.seed ?? `${spec.lat.toFixed(3)},${spec.lon.toFixed(3)}`);
    // Orientation follows the job, not the crew: a scene laid out from the
    // placing pilot's inbound bearing rotated depending on who placed it and
    // which base they flew from.
    const hdg =
      spec.headingDeg ?? sceneHeading(spec.headingSeed ?? spec.seed ?? `${spec.lat.toFixed(3)},${spec.lon.toFixed(3)}`);
    const hdgRad = (hdg * Math.PI) / 180;
    const groundFt = this.groundElevationFt(spec.lat, spec.lon);
    const out: InjectedObject[] = [];
    for (const obj of objects) {
      // forward = along heading, right = 90° clockwise of heading
      const north = obj.forwardM * Math.cos(hdgRad) + obj.rightM * Math.cos(hdgRad + Math.PI / 2);
      const east = obj.forwardM * Math.sin(hdgRad) + obj.rightM * Math.sin(hdgRad + Math.PI / 2);
      const lat = spec.lat + (north / EARTH_RADIUS_M) * (180 / Math.PI);
      const lon = spec.lon + (east / (EARTH_RADIUS_M * Math.cos((spec.lat * Math.PI) / 180))) * (180 / Math.PI);
      const fireLevel = fireThrottleFor(obj.group);
      const rec = this.spawn(
        'local',
        sceneObjectTitles(obj),
        {
          lat,
          lon,
          altitudeFt: groundFt,
          headingDeg: (hdg + obj.headingOffsetDeg + 360) % 360,
          onGround: true,
        },
        fireLevel == null ? undefined : { fireLevel },
      );
      rec.sceneKey = spec.sceneKey;
      out.push(rec);
    }
    return out;
  }

  /**
   * Remove every object this client placed for one job — called when the job is
   * cleared, so a finished scene doesn't stay in the world. Without this every
   * completed job left ~22 SimObjects behind for the rest of the session.
   */
  clearScene(sceneKey: string): number {
    if (!this.handle || !sceneKey) return 0;
    let removed = 0;
    for (const [requestId, record] of [...this.injected]) {
      if (record.sceneKey !== sceneKey) continue;
      if (record.objectId != null) this.handle.aIRemoveObject(record.objectId, this.nextInjectRequestId++);
      this.injected.delete(requestId);
      this.spawnAt.delete(requestId);
      removed++;
    }
    if (removed) this.patch({ injected: [...this.injected.values()] });
    return removed;
  }

  /**
   * Drop a scene on the ground a short distance ahead of the aircraft — for
   * eyeballing that the models actually spawn. The scene faces across the nose
   * so a two-vehicle MVA / flame front sits in view.
   */
  injectSceneAhead(spec: { sceneId: string; distanceMeters?: number }): InjectedObject[] {
    if (!this.handle) throw new Error('Not connected to a simulator.');
    const pos = this.status.position;
    if (!pos) throw new Error('Aircraft position is not known yet.');
    const d = spec.distanceMeters ?? 45;
    const brgRad = (pos.headingTrueDeg * Math.PI) / 180;
    const [lat, lon] = offset(pos.lat, pos.lon, d, brgRad);
    return this.injectScene({
      sceneId: spec.sceneId,
      lat,
      lon,
      headingDeg: (pos.headingTrueDeg + 90) % 360, // lay the scene across the nose
      seed: `ahead-${Date.now()}`, // fresh variation each press
    });
  }

  /**
   * Spawn a test object just ahead of the aircraft. Tries a copy of the aircraft
   * the user is flying first (its title is guaranteed to exist here), then base
   * ground objects. Matches the aircraft's ground/air state so it is not snapped
   * to terrain far below when airborne.
   */
  injectTestObject(options?: {
    preset?: string;
    title?: string;
    distanceMeters?: number;
    bearingOffsetDeg?: number;
  }): InjectedObject {
    const pos = this.status.position;
    if (!this.handle) throw new Error('Not connected to a simulator.');
    if (!pos) throw new Error('Aircraft position is not known yet.');

    const preset = OBJECT_PRESETS[options?.preset ?? 'windsock'];
    const titles = options?.title
      ? [options.title]
      : preset
        ? [...(preset.titles.length ? preset.titles : [pos.aircraftTitle]), ...GENERIC_FALLBACKS]
        : [pos.aircraftTitle, ...GENERIC_FALLBACKS];
    const distance = options?.distanceMeters ?? 5;
    const bearingRad = ((pos.headingTrueDeg + (options?.bearingOffsetDeg ?? 0)) * Math.PI) / 180;
    const [lat, lon] = offset(pos.lat, pos.lon, distance, bearingRad);

    return this.spawn('local', titles, {
      lat,
      lon,
      altitudeFt: pos.onGround ? 0 : pos.altitudeFt,
      headingDeg: pos.headingTrueDeg,
      onGround: pos.onGround,
    });
  }

  /**
   * Mirror a peer's object into this sim at an absolute position. If the peer's
   * container title is not installed here, fall back through the peer's own
   * fallback list, then a copy of THIS pilot's aircraft, then base objects — so
   * every unit sees something at the job location even with different add-ons.
   */
  injectRemote(spec: {
    remoteId: string;
    titles: string[];
    lat: number;
    lon: number;
    altitudeFt?: number;
    headingDeg?: number;
    onGround?: boolean;
  }): InjectedObject {
    if (!this.handle) throw new Error('Not connected to a simulator.');
    const chain = [...spec.titles, this.status.position?.aircraftTitle ?? '', ...GENERIC_FALLBACKS].filter(Boolean);
    const record = this.spawn('remote', chain, {
      lat: spec.lat,
      lon: spec.lon,
      // peers publish position but not elevation — estimate it here, or the
      // object lands at sea level and buries itself in any inland terrain
      altitudeFt: spec.altitudeFt ?? this.groundElevationFt(spec.lat, spec.lon),
      headingDeg: spec.headingDeg ?? 0,
      onGround: spec.onGround ?? true,
    });
    record.remoteId = spec.remoteId;
    return record;
  }

  /**
   * The scenery-object packs sim pilots use (30West HEMS Objects, 68ponyGT / HPG
   * "Action Pack") ship every prop as an AIRCRAFT SimObject — those spawn with
   * `AICreateNonATCAircraft`, NOT `AICreateSimulatedObject`. Their titles are
   * multi-word (e.g. "30West wreck", "Wrecked Sedan", "Fire with Light 1"),
   * whereas base-game dynamic objects are single tokens ("Windsock",
   * "FuelTruck"). Use that to choose the spawn call for the current title as the
   * self-healing chain walks it.
   */
  private titleSpawnsAsAircraft(title: string): boolean {
    return (
      /\s/.test(title) ||
      /^(30West|68ponyGT|Wrecked|Female_|Worker_|ATV1|TGV|HeliCrash|Bulldozer|Excavator|Forklift|FrontLoader|Dumptruck|TowTruck)/i.test(
        title,
      )
    );
  }

  /**
   * Best guess at terrain elevation (ft MSL) under a point.
   *
   * SimConnect has no terrain-elevation query, and spawning with `altitude = 0`
   * puts an object at SEA level regardless of `onGround` — at an inland job on a
   * 1500 ft plateau that is 1500 ft underground, i.e. invisible. The aircraft's
   * own altitude minus its AGL gives the local ground level (accurate, since
   * scenes are placed while closing on them); a nearby airfield's published
   * elevation covers anything placed further out.
   */
  private groundElevationFt(lat: number, lon: number): number {
    const pos = this.status.position;
    if (pos && Number.isFinite(pos.altitudeAglFt)) {
      if (roughRangeNm(pos.lat, pos.lon, lat, lon) <= 60) {
        const ground = pos.altitudeFt - pos.altitudeAglFt;
        if (Number.isFinite(ground)) return Math.round(ground);
      }
    }
    let bestFt = 0;
    let bestNm = Infinity;
    for (const a of this.airports) {
      const d = roughRangeNm(a.lat, a.lon, lat, lon);
      if (d < bestNm) {
        bestNm = d;
        bestFt = a.altFt;
      }
    }
    return bestNm <= 80 ? Math.round(bestFt) : 0;
  }

  private trySpawn(record: InjectedObject, at: SpawnAt): void {
    if (!this.handle) return;
    const init = new InitPosition();
    init.latitude = at.lat;
    init.longitude = at.lon;
    init.altitude = at.altitudeFt;
    init.pitch = 0;
    init.bank = 0;
    init.heading = at.headingDeg;
    init.onGround = at.onGround; // true => snap to terrain
    record.title = record.titles[record.titleIndex] ?? record.title;
    const asAircraft = record.isAircraft || this.titleSpawnsAsAircraft(record.title);
    init.airspeed = asAircraft ? Math.round(record.speedKt ?? 0) : 0;
    const sendId = asAircraft
      ? this.handle.aICreateNonATCAircraft(record.title, `AED${record.requestId % 1000}`, init, record.requestId)
      : this.handle.aICreateSimulatedObject(record.title, init, record.requestId);
    this.injectBySendId.set(sendId, record);
  }

  /**
   * Inject a MOVING airborne contact (an FSLTL / base-sim aircraft).
   *
   * MSFS ignores an AI WAYPOINT LIST for an AI aircraft spawned in the air, so we
   * fly it ourselves: a 4 Hz tick advances the contact along its `route` with a
   * turn-rate limit, matching bank, and a climb-rate limit, then pushes the full
   * state (position + heading + pitch/bank + true airspeed + body velocity) so
   * MSFS renders it gliding smoothly between our updates.
   */
  injectAirContact(spec: {
    remoteId?: string;
    titles: string[];
    lat?: number;
    lon?: number;
    altFt: number;
    headingDeg: number;
    speedKt: number;
    route?: { lat: number; lon: number; altFt: number; speedKt: number }[];
    loop?: boolean;
    holdUntilNm?: number;
    label?: string;
  }): InjectedObject {
    if (!this.handle) throw new Error('Not connected to a simulator.');
    const chain = [...spec.titles, this.status.position?.aircraftTitle ?? '', 'DA62 Asobo'].filter(Boolean);
    const wp0 = spec.route?.[0];
    const lat = spec.lat ?? wp0?.lat ?? 0;
    const lon = spec.lon ?? wp0?.lon ?? 0;
    const altFt = wp0?.altFt ?? spec.altFt;
    const speedKt = wp0?.speedKt ?? spec.speedKt;
    const aim = spec.route?.[1] ?? spec.route?.[0];
    const headingDeg = aim ? bearingTo(lat, lon, aim.lat, aim.lon) : spec.headingDeg;
    const rec = this.spawn(
      spec.remoteId ? 'remote' : 'local',
      chain,
      { lat, lon, altitudeFt: altFt, headingDeg, onGround: false },
      { isAircraft: true, altFt, speedKt },
    );
    if (spec.remoteId) rec.remoteId = spec.remoteId;
    rec.label = spec.label;
    rec.bank = 0;
    rec.pitch = 0;
    if (spec.route && spec.route.length) {
      rec.route = spec.route;
      rec.routeIdx = 0;
      rec.routeLoop = spec.loop ?? false;
      // Only the owner holds; a peer just flies the route it was given.
      if (!spec.remoteId && spec.holdUntilNm && spec.holdUntilNm > 0) {
        rec.holdUntilNm = spec.holdUntilNm;
        rec.holding = true;
      }
    }
    this.ensureContactTick();
    this.patch({ injected: [...this.injected.values()] });
    return rec;
  }

  /**
   * Inject a moving GROUND or surface contact — the fleeing car in a police
   * pursuit, a monitored convoy, a vessel of interest.
   *
   * This reuses the air-contact tick (MSFS ignores an AI waypoint list for an
   * object we spawn and then drive ourselves), with three differences that
   * matter: it is pinned to terrain rather than an altitude, it captures
   * waypoints at road scale — the air path's 1.5 NM minimum would skip every
   * turn on a suburban street — and a fleeing vehicle STOPS at the end of its
   * route so the crew can watch the offenders decamp.
   */
  injectGroundContact(spec: {
    remoteId?: string;
    titles: string[];
    route: { lat: number; lon: number; speedKt: number }[];
    /** hold (parked) at route[0] until the aircraft is within this range */
    holdUntilNm?: number;
    /** stop dead at the end of the route rather than carrying on */
    stopAtEnd?: boolean;
    label?: string;
    sceneKey?: string;
  }): InjectedObject {
    if (!this.handle) throw new Error('Not connected to a simulator.');
    if (!spec.route.length) throw new Error('A ground contact needs a route.');
    const chain = [...spec.titles].filter(Boolean);
    const wp0 = spec.route[0]!;
    const aim = spec.route[1] ?? wp0;
    const headingDeg = bearingTo(wp0.lat, wp0.lon, aim.lat, aim.lon);
    const groundFt = this.groundElevationFt(wp0.lat, wp0.lon);
    // Deliberately NOT isAircraft: a ground contact's title chain mixes the
    // packs' aircraft-SimObject props ("30West A45") with base-game simulated
    // objects ("Microsoft_Car_EUR_03"). trySpawn picks the right creation call
    // per title; forcing the aircraft path would make every base car fail.
    const rec = this.spawn(
      spec.remoteId ? 'remote' : 'local',
      chain,
      { lat: wp0.lat, lon: wp0.lon, altitudeFt: groundFt, headingDeg, onGround: true },
      { altFt: groundFt, speedKt: 0 },
    );
    if (spec.remoteId) rec.remoteId = spec.remoteId;
    rec.label = spec.label;
    rec.sceneKey = spec.sceneKey;
    rec.isGround = true;
    rec.stopAtEnd = spec.stopAtEnd ?? true;
    rec.bank = 0;
    rec.pitch = 0;
    // The tick shares one route shape with air contacts; ground waypoints carry
    // no altitude of their own because terrain decides it every tick.
    rec.route = spec.route.map((w) => ({ lat: w.lat, lon: w.lon, altFt: 0, speedKt: w.speedKt }));
    rec.routeIdx = 0;
    rec.routeLoop = false;
    if (!spec.remoteId && spec.holdUntilNm && spec.holdUntilNm > 0) {
      rec.holdUntilNm = spec.holdUntilNm;
      rec.holding = true;
    }
    this.ensureContactTick();
    this.patch({ injected: [...this.injected.values()] });
    return rec;
  }

  private contactTimer: NodeJS.Timeout | null = null;
  private static readonly CONTACT_DT = 0.25; // s — 4 Hz
  private lastContactPatch = 0;
  private ensureContactTick(): void {
    if (this.contactTimer) return;
    this.contactTimer = setInterval(() => this.tickContacts(), SimBridge.CONTACT_DT * 1000);
    this.contactTimer.unref?.();
  }

  /** Advance a contact along its heading by one tick. */
  private advanceRec(rec: InjectedObject, dt: number): void {
    const nm = ((rec.speedKt ?? 0) * dt) / 3600;
    const br = (rec.headingDeg * Math.PI) / 180;
    rec.lat += (nm * Math.cos(br)) / NM_PER_DEG;
    rec.lon += (nm * Math.sin(br)) / (NM_PER_DEG * Math.cos((rec.lat * Math.PI) / 180));
  }

  private tickContacts(): void {
    if (!this.handle) return;
    const dt = SimBridge.CONTACT_DT;
    const me = this.status.position;
    let anyMoving = false;

    for (const rec of this.injected.values()) {
      if ((!rec.isAircraft && !rec.isGround) || rec.objectId == null) continue;

      // Peer-mirrored contact: dead-reckon between the ~1 Hz corrections in moveContact().
      if (rec.source === 'remote') {
        if (!rec.speedKt) continue;
        anyMoving = true;
        this.advanceRec(rec, dt);
        this.writeFly(rec);
        continue;
      }

      if (!rec.route && !rec.speedKt) continue;
      anyMoving = true;

      // Hold near the spawn point until the aircraft closes. An air contact
      // orbits; a vehicle simply sits there with the engine running.
      if (rec.holding) {
        const inRange =
          me && Math.abs(me.lat) > 0.02 && roughRangeNm(me.lat, me.lon, rec.lat, rec.lon) <= (rec.holdUntilNm ?? 80);
        if (inRange) rec.holding = false;
        else if (rec.isGround) {
          rec.speedKt = 0;
          rec.altFt = this.groundElevationFt(rec.lat, rec.lon);
          this.emitContact(rec);
          continue;
        } else {
          rec.headingDeg = (rec.headingDeg + 3 * dt * 3) % 360; // ~9°/s orbit
          rec.speedKt = rampTo(rec.speedKt ?? 200, Math.min(220, (rec.route?.[0]?.speedKt ?? 200) * 0.7), 8);
          rec.bank = 18;
          rec.pitch = 0;
          this.advanceRec(rec, dt);
          this.emitContact(rec);
          continue;
        }
      }

      // Steer toward the next route waypoint.
      if (rec.route && rec.routeIdx != null) {
        if (rec.routeIdx >= rec.route.length) {
          if (rec.routeLoop) rec.routeIdx = 0;
          else if (rec.isGround && rec.stopAtEnd) {
            this.stopGround(rec); // the bail-out
            continue;
          } else {
            rec.route = undefined; // route finished — fly on straight
            rec.routeIdx = undefined;
          }
        }
        const wp = rec.route?.[rec.routeIdx ?? 0];
        if (wp && rec.isGround) {
          // A vehicle turns far harder than an aircraft and its waypoints are
          // metres apart, not miles: the air path's 1.5 NM capture radius would
          // skip every corner of a road and cut the route into a straight line.
          const want = bearingTo(rec.lat, rec.lon, wp.lat, wp.lon);
          rec.headingDeg = turnToward(rec.headingDeg, want, 45 * dt);
          rec.bank = 0;
          rec.pitch = 0;
          rec.altFt = this.groundElevationFt(rec.lat, rec.lon);
          rec.speedKt = rampTo(rec.speedKt ?? 0, wp.speedKt, 12 * dt); // ~6 kt/s
          const near = Math.max(0.022, (rec.speedKt ?? 40) / 1800); // ~40 m, more at speed
          if (roughRangeNm(rec.lat, rec.lon, wp.lat, wp.lon) <= near) rec.routeIdx = (rec.routeIdx ?? 0) + 1;
          // The route's last waypoint asks for a dead stop, and the vehicle
          // reaches zero well before it gets inside the capture radius — so it
          // would never tick past the end and never be marked stopped. Once it
          // is stationary on the final leg, the run is over.
          const onLastLeg = (rec.routeIdx ?? 0) >= rec.route.length - 1;
          if (rec.stopAtEnd && onLastLeg && (rec.speedKt ?? 0) < 1.5) {
            this.stopGround(rec);
            continue;
          }
        } else if (wp) {
          const want = bearingTo(rec.lat, rec.lon, wp.lat, wp.lon);
          const fast = (rec.speedKt ?? wp.speedKt) > 250;
          const maxTurn = (fast ? 2.5 : 6) * dt; // deg this tick
          const newHdg = turnToward(rec.headingDeg, want, maxTurn);
          const d = ((newHdg - rec.headingDeg + 540) % 360) - 180;
          rec.bank = Math.max(-32, Math.min(32, (d / dt) * 4));
          rec.headingDeg = newHdg;

          const curAlt = rec.altFt ?? wp.altFt;
          const dAlt = wp.altFt - curAlt;
          const maxAlt = ((fast ? 4500 : 1500) / 60) * dt; // ft this tick
          rec.altFt = curAlt + Math.max(-maxAlt, Math.min(maxAlt, dAlt));
          rec.pitch = Math.max(-8, Math.min(8, dAlt > 5 ? -4 : dAlt < -5 ? 3 : 0));

          rec.speedKt = rampTo(rec.speedKt ?? wp.speedKt, wp.speedKt, 20 * dt); // ≤ ~20 kt/s
          const near = Math.max(1.5, (rec.speedKt ?? 200) / 90);
          if (roughRangeNm(rec.lat, rec.lon, wp.lat, wp.lon) <= near) rec.routeIdx = (rec.routeIdx ?? 0) + 1;
        }
      } else {
        rec.bank = 0;
        rec.pitch = 0;
      }

      this.advanceRec(rec, dt);
      this.emitContact(rec);
    }

    // Refresh the renderer (map + readouts) ~1×/s.
    if (anyMoving && Date.now() - this.lastContactPatch > 900) {
      this.lastContactPatch = Date.now();
      this.patch({ injected: [...this.injected.values()] });
    }
    if (!anyMoving && this.contactTimer) {
      clearInterval(this.contactTimer);
      this.contactTimer = null;
    }
  }

  /**
   * A fleeing vehicle has finished its run. It stays where it is from here so
   * the crew can watch the offenders decamp, and the console drops the cordon
   * scene on this spot.
   */
  private stopGround(rec: InjectedObject): void {
    rec.route = undefined;
    rec.routeIdx = undefined;
    rec.speedKt = 0;
    rec.stopped = true;
    rec.altFt = this.groundElevationFt(rec.lat, rec.lon);
    this.emitContact(rec);
    this.patch({ injected: [...this.injected.values()] });
  }

  private emitContact(rec: InjectedObject): void {
    this.writeFly(rec);
    this.emit('contactMove', {
      requestId: rec.requestId,
      remoteId: rec.remoteId,
      lat: rec.lat,
      lon: rec.lon,
      altFt: rec.altFt ?? 5000,
      headingDeg: rec.headingDeg,
    });
  }

  /**
   * A peer's ~1 Hz position report for a mirrored contact. Snap to it and derive
   * a speed/heading so the local tick can dead-reckon smoothly until the next one.
   */
  moveContact(remoteId: string, p: { lat: number; lon: number; altFt: number; headingDeg: number }): void {
    const rec = this.findRemote(remoteId);
    if (!rec || rec.objectId == null || !this.handle) return;
    const now = Date.now();
    const dtH = rec.lastMoveAt ? (now - rec.lastMoveAt) / 3_600_000 : 0;
    if (dtH > 0) {
      const nm = roughRangeNm(rec.lat, rec.lon, p.lat, p.lon);
      rec.speedKt = Math.max(0, Math.min(700, nm / dtH));
    }
    rec.lastMoveAt = now;
    rec.lat = p.lat;
    rec.lon = p.lon;
    rec.altFt = p.altFt;
    rec.headingDeg = p.headingDeg;
    this.writeFly(rec);
    this.ensureContactTick();
    this.patch({ injected: [...this.injected.values()] });
  }

  /** Push the full flight state onto a contact (DEF_MOVE order). */
  private writeFly(rec: InjectedObject): void {
    if (!this.handle || rec.objectId == null) return;
    try {
      const spd = rec.speedKt ?? 0;
      const buf = new RawBuffer(64);
      buf.writeFloat64(rec.lat);
      buf.writeFloat64(rec.lon);
      buf.writeFloat64(rec.altFt ?? 5000);
      buf.writeFloat64(rec.headingDeg);
      buf.writeFloat64(rec.pitch ?? 0);
      buf.writeFloat64(rec.bank ?? 0);
      buf.writeFloat64(spd); // AIRSPEED TRUE (kt)
      buf.writeFloat64(spd * 1.68781); // VELOCITY BODY Z (ft/s)
      this.handle.setDataOnSimObject(DEF_MOVE, rec.objectId, { buffer: buf, arrayCount: 1, tagged: false });
    } catch {
      /* ignore */
    }
  }

  /**
   * Light a fire object.
   *
   * The pack's fire models read `GENERAL ENG THROTTLE LEVER POSITION:1` as both
   * the on switch and the size of the blaze, so an object left at the spawn
   * default of 0 renders nothing — no particles, no geometry. Written once the
   * sim confirms the object id, and re-written if the object respawns onto a
   * fallback title, since the substitute needs it just as much.
   */
  private writeFireLevel(rec: InjectedObject): void {
    if (!this.handle || rec.objectId == null || rec.fireLevel == null) return;
    const buf = new RawBuffer(64);
    buf.writeFloat64(rec.fireLevel);
    try {
      this.handle.setDataOnSimObject(DEF_FIRE, rec.objectId, { buffer: buf, arrayCount: 1, tagged: false });
    } catch {
      /* the title that spawned may not be a pack fire object — harmless */
    }
  }

  private spawn(
    source: 'local' | 'remote',
    titles: string[],
    at: SpawnAt,
    opts?: { isAircraft?: boolean; altFt?: number; speedKt?: number; fireLevel?: number },
  ): InjectedObject {
    const clean = Array.from(new Set(titles.map((t) => t.trim()).filter(Boolean)));
    const chain = clean.length ? clean : [...GENERIC_FALLBACKS];
    const requestId = this.nextInjectRequestId++;
    const record: InjectedObject = {
      requestId,
      objectId: null,
      title: chain[0]!,
      titles: chain,
      titleIndex: 0,
      substituted: false,
      lat: at.lat,
      lon: at.lon,
      headingDeg: at.headingDeg,
      onGround: at.onGround,
      source,
      isAircraft: opts?.isAircraft,
      altFt: opts?.altFt,
      speedKt: opts?.speedKt,
      fireLevel: opts?.fireLevel,
    };
    this.injected.set(requestId, record);
    this.spawnAt.set(requestId, at);
    this.trySpawn(record, at);
    this.patch({ injected: [...this.injected.values()] });
    return record;
  }

  private nextEventId = EVT_BASE;
  private directToSendIds = new Set<number>();

  /** Fire an MSFS RPN "H:" event at the cockpit instruments. Returns the packet sendId. */
  private hEvent(name: string): number {
    if (!this.handle) return -1;
    const id = this.nextEventId++;
    const sid1 = this.handle.mapClientEventToSimEvent(id, name);
    const sid2 = this.handle.transmitClientEvent(
      SimConnectConstants.OBJECT_ID_USER,
      id,
      0,
      1, // highest-priority notification group
      EventFlag.EVENT_FLAG_GROUPID_IS_PRIORITY,
    );
    this.directToSendIds.add(sid1);
    this.directToSendIds.add(sid2);
    setTimeout(() => {
      this.directToSendIds.delete(sid1);
      this.directToSendIds.delete(sid2);
    }, 4000);
    return sid2;
  }

  /** Fire one PMS50 GTN event on every likely unit prefix (COM1, COM2, G1000 MFD). */
  private gtnFire(event: string): void {
    for (const p of ['GTN750', 'GTN750_2', 'AS1000_MFD']) this.hEvent(`H:${p}_${event}`);
  }

  /** Type a string on the current GTN keyboard: letters -> K_A.., digits -> K_0.. */
  private async gtnType(text: string, gapMs = 90): Promise<void> {
    for (const ch of text.toUpperCase()) {
      if (ch >= 'A' && ch <= 'Z') this.gtnFire(`K_${ch}`);
      else if (ch >= '0' && ch <= '9') this.gtnFire(`K_${ch}`);
      else if (ch === 'N' || ch === 'S' || ch === 'E' || ch === 'W') this.gtnFire(`K_${ch}`);
      else continue;
      await sleep(gapMs);
    }
  }

  private gpsWpCounter = 0;

  /**
   * Export the whole tasking route for the PMS50 GTN750 as `fpl.pln`:
   * present position → base → scene → hospital (if any) → base.
   *
   * The keystroke/page automation for a live direct-to proved unreliable, so we
   * just write the file into …/pms50-instrument-gtn750/fpl/gtn750/fpl.pln plus a
   * named Documents copy. On the unit: FPL ▸ Menu ▸ Import ▸ fpl.
   */
  async directTo(spec: {
    jobId?: string;
    base?: { name: string; lat: number; lon: number };
    scene: { name: string; lat: number; lon: number };
    hospital?: { name: string; lat: number; lon: number } | null;
  }): Promise<{ ok: boolean; note: string }> {
    if (!this.handle) return { ok: false, note: 'Not connected to a simulator.' };
    const pos = this.status.position;
    if (!pos) return { ok: false, note: 'Aircraft position is not known yet.' };

    const baseIsIcao = spec.base ? /^[A-Z]{2}[A-Z0-9]{1,3}$/.test((spec.base.name || '').trim().toUpperCase()) : false;
    const baseLeg = (name: string) =>
      spec.base
        ? baseIsIcao
          ? {
              name,
              lat: spec.base.lat,
              lon: spec.base.lon,
              kind: 'airport' as const,
              ident: spec.base.name.trim().toUpperCase(),
            }
          : { name, lat: spec.base.lat, lon: spec.base.lon, kind: 'user' as const }
        : null;
    const legs = [
      baseLeg(spec.base?.name || 'BASE'),
      { name: spec.scene.name || 'JOB', lat: spec.scene.lat, lon: spec.scene.lon, kind: 'user' as const },
      spec.hospital
        ? { name: spec.hospital.name || 'HOSP', lat: spec.hospital.lat, lon: spec.hospital.lon, kind: 'user' as const }
        : null,
      baseLeg(`${spec.base?.name || 'BASE'} RTB`),
    ].filter(Boolean) as import('./gps').Leg[];

    const docName = (spec.jobId || 'route').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'route';
    let res: import('./gps').PlnResult;
    try {
      res = await writeDirectPln({ lat: pos.lat, lon: pos.lon }, legs, docName);
    } catch (err) {
      return {
        ok: false,
        note: `Could not write the flight plan: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (this.gps.gtnDetected) this.gtnFire('GoToPage-HOME-PageFlighPlan');

    // Push it into the SIM's own flight plan as well. Per Asobo this populates
    // the ATC/world-map plan on both MSFS 2020 and 2024 — it does NOT push into
    // the avionics, but it costs nothing and the stock GPS units that read the
    // sim plan when they initialise will pick it up.
    let simPlan = false;
    try {
      this.handle.flightPlanLoad(res.plnPath);
      simPlan = true;
    } catch {
      /* older sim / rejected path — the file exports still work */
    }

    this.gps = { ...this.gps, tdsDetected: res.tdsInstalled };

    const targets: string[] = [];
    if (res.pms50 > 0) targets.push(`PMS50 GTN750 x${res.pms50} (FPL ▸ Menu ▸ Import ▸ fpl)`);
    if (res.tds > 0) targets.push('TDS GTNXi (FPL ▸ Menu ▸ Catalog ▸ Import ▸ Activate)');
    if (simPlan) targets.push('sim flight plan / world map');
    targets.push(`Documents\\${docName}.pln + .gfp`);

    this.gps = {
      ...this.gps,
      lastAction: 'export route',
      lastResult: `${legs.length} legs → ${targets.length} target(s)`,
    };
    const where = targets.join(', ');
    // Deliberately NOT patched into lastError: a successful export is not a
    // fault, and the console colours its status bar red off that field. The
    // outcome already reaches the UI through the returned `note`.

    // The two units import differently and neither can be triggered from
    // outside the sim, so the note has to say which one to drive and how.
    const hints: string[] = [];
    if (res.pms50 > 0) hints.push('GTN750: FPL ▸ Menu ▸ Import ▸ fpl.');
    if (res.tds > 0) {
      hints.push(
        `GTNXi: FPL ▸ Menu ▸ Catalog ▸ Import, pick AED_${docName
          .replace(/[^A-Za-z0-9_-]/g, '')
          .slice(0, 24)
          .toUpperCase()}, then Activate. If it isn't listed, restart the GTNXi app.`,
      );
    }
    if (res.pms50 === 0 && !res.tdsInstalled) {
      hints.push(
        'No GTN750 or GTNXi found — install pms50-instrument-gtn750 in your Community folder, or TDS GTNXi. ' +
          'The .pln and .gfp saved in Documents work with either, once one is installed.',
      );
    }

    return {
      ok: true,
      note: `Full route (${legs.map((l) => l.name).join(' → ')}) exported → ${where}. ${hints.join(' ')}`.trim(),
    };
  }

  /** Find an injected record we mirrored from a peer, by its server id. */
  findRemote(remoteId: string): InjectedObject | undefined {
    for (const rec of this.injected.values()) if (rec.remoteId === remoteId) return rec;
    return undefined;
  }

  removeInjected(requestId: number): boolean {
    const record = this.injected.get(requestId);
    if (!record || !this.handle) return false;
    if (record.objectId != null) this.handle.aIRemoveObject(record.objectId, this.nextInjectRequestId++);
    this.injected.delete(requestId);
    this.spawnAt.delete(requestId);
    this.patch({ injected: [...this.injected.values()] });
    return true;
  }

  clearInjectedObjects(): number {
    if (!this.handle) return 0;
    let removed = 0;
    for (const record of this.injected.values()) {
      if (record.objectId != null) {
        this.handle.aIRemoveObject(record.objectId, this.nextInjectRequestId++);
        removed += 1;
      }
    }
    this.injected.clear();
    this.injectBySendId.clear();
    this.spawnAt.clear();
    this.patch({ injected: [] });
    return removed;
  }
}

/** Point `distance` metres from (lat,lon) along `bearingRad`. Returns [lat, lon] in degrees. */
function offset(lat: number, lon: number, distance: number, bearingRad: number): [number, number] {
  const dLatRad = (distance * Math.cos(bearingRad)) / EARTH_RADIUS_M;
  const dLonRad = (distance * Math.sin(bearingRad)) / (EARTH_RADIUS_M * Math.cos((lat * Math.PI) / 180));
  return [lat + (dLatRad * 180) / Math.PI, lon + (dLonRad * 180) / Math.PI];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Cheap equirectangular range in NM — fine for a few-hundred-mile filter. */
function roughRangeNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * NM_PER_DEG;
  const dLon = (lon2 - lon1) * NM_PER_DEG * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

/** Initial true bearing from A to B (equirectangular — fine at these ranges). */
function bearingTo(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = (lon2 - lon1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const dLat = lat2 - lat1;
  return ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
}

/** Rotate `from` toward `to` by at most `maxStep` degrees, shortest way round. */
function turnToward(from: number, to: number, maxStep: number): number {
  let d = ((to - from + 540) % 360) - 180; // -180..180
  if (d > maxStep) d = maxStep;
  else if (d < -maxStep) d = -maxStep;
  return (from + d + 360) % 360;
}

/** Move `cur` toward `target` by at most `maxStep`. */
function rampTo(cur: number, target: number, maxStep: number): number {
  const d = target - cur;
  if (Math.abs(d) <= maxStep) return target;
  return cur + Math.sign(d) * maxStep;
}

export const simBridge = new SimBridge();
