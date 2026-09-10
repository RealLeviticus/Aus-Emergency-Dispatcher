import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';
import { packageRoots } from './liveries';

type Pt = { lat: number; lon: number };

function dms(v: number, pos: string, neg: string): { pretty: string; pln: string } {
  const hemi = v >= 0 ? pos : neg;
  let a = Math.abs(v);
  const d = Math.floor(a);
  a = (a - d) * 60;
  const m = Math.floor(a);
  const s = (a - m) * 60;
  return { pretty: `${hemi}${d}° ${m}' ${s.toFixed(1)}"`, pln: `${hemi}${d}° ${m}' ${s.toFixed(2)}"` };
}

/** MSFS WorldPosition / *LLA: `N47° 26' 17.00",W122° 18' 32.00",+000429.00` */
function lla(lat: number, lon: number, altFt = 0): string {
  const alt = `${altFt >= 0 ? '+' : '-'}${Math.abs(Math.round(altFt)).toString().padStart(6, '0')}.00`;
  return `${dms(lat, 'N', 'S').pln},${dms(lon, 'E', 'W').pln},${alt}`;
}

export type Leg = {
  name: string;
  lat: number;
  lon: number;
  /** 'airport' emits a real ICAO waypoint; 'user' emits a coordinate waypoint */
  kind: 'airport' | 'user';
  /** ICAO ident when kind === 'airport' */
  ident?: string;
};

const looksLikeIcao = (s: string) => /^[A-Z]{2}[A-Z0-9]{1,3}$/.test(s.trim().toUpperCase());

function wpId(name: string, fallback: string): string {
  return (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || fallback).toUpperCase();
}

/**
 * A multi-leg VFR plan. Real airfields (the base / RTB) are emitted as `Airport`
 * waypoints with their ICAO; only the job location is a `User` coordinate point.
 * If the departure is a real airport there's no synthetic present-position point.
 */
function buildPln(from: Pt, legs: Leg[]): string {
  const clean = legs.filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon));
  type P = { id: string; lla: string; name: string; kind: 'airport' | 'user'; ident?: string };
  const pts: P[] = [];

  const depIsAirport = clean[0]?.kind === 'airport' && looksLikeIcao(clean[0]!.ident ?? clean[0]!.name);
  if (!depIsAirport) {
    pts.push({ id: 'START', lla: lla(from.lat, from.lon, 0), name: 'Present position', kind: 'user' });
  }
  clean.forEach((w, i) => {
    if (w.kind === 'airport' && looksLikeIcao(w.ident ?? w.name)) {
      pts.push({
        id: (w.ident ?? w.name).trim().toUpperCase(),
        lla: lla(w.lat, w.lon, 0),
        name: w.name,
        kind: 'airport',
        ident: (w.ident ?? w.name).trim().toUpperCase(),
      });
    } else {
      let id = wpId(w.name, `WP${i + 1}`);
      while (pts.some((p) => p.id === id)) id = `${id}${i + 1}`.slice(0, 12);
      pts.push({ id, lla: lla(w.lat, w.lon, 0), name: w.name, kind: 'user' });
    }
  });

  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const body = pts
    .map((p) => {
      const icao =
        p.kind === 'airport'
          ? `\n            <ICAO>\n                <ICAOIdent>${p.ident}</ICAOIdent>\n            </ICAO>`
          : '';
      return `        <ATCWaypoint id="${p.id}">\n            <ATCWaypointType>${
        p.kind === 'airport' ? 'Airport' : 'User'
      }</ATCWaypointType>\n            <WorldPosition>${p.lla}</WorldPosition>${icao}\n        </ATCWaypoint>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<SimBase.Document Type="AceXML" version="1,0">
    <Descr>AceXML Document</Descr>
    <FlightPlan.FlightPlan>
        <Title>AED tasking</Title>
        <FPType>VFR</FPType>
        <RouteType>Direct</RouteType>
        <CruisingAlt>2000</CruisingAlt>
        <DepartureID>${first.id}</DepartureID>
        <DepartureLLA>${first.lla}</DepartureLLA>
        <DestinationID>${last.id}</DestinationID>
        <DestinationLLA>${last.lla}</DestinationLLA>
        <Descr>Aus Emergency Dispatcher tasking route</Descr>
        <DepartureName>${first.name}</DepartureName>
        <DestinationName>${last.name}</DestinationName>
        <AppVersion><AppVersionMajor>11</AppVersionMajor><AppVersionBuild>282174</AppVersionBuild></AppVersion>
${body}
    </FlightPlan.FlightPlan>
</SimBase.Document>
`;
}

// ---- Garmin .gfp (TDS GTNXi) ------------------------------------------
/**
 * Garmin flight-plan coordinates are DEGREES + DECIMAL MINUTES with no
 * separator, not decimal degrees: latitude is N/S + exactly 5 digits (DD MM.M),
 * longitude E/W + exactly 6 digits (DDD MM.M). 67° 30.2' N -> `N67302`.
 */
function gfpCoord(v: number, pos: string, neg: string, degDigits: number): string {
  const hemi = v >= 0 ? pos : neg;
  const a = Math.abs(v);
  let d = Math.floor(a);
  let tenths = Math.round((a - d) * 600); // minutes x 10
  if (tenths >= 600) {
    tenths -= 600;
    d += 1;
  }
  return `${hemi}${String(d).padStart(degDigits, '0')}${String(tenths).padStart(3, '0')}`;
}

/**
 * A Garmin flight plan for the TDS GTNXi — one line, `FPN/RI:F:<pt>:F:<pt>…`,
 * uppercase letters/digits/colons/periods only (the unit rejects anything else).
 * Real airfields go in by ICAO; job locations as lat/long user waypoints, which
 * the GTN renames to USERWPT… on import.
 */
export function buildGfp(legs: Leg[]): string {
  const pts = legs
    .filter((w) => Number.isFinite(w.lat) && Number.isFinite(w.lon))
    .map((w) =>
      w.kind === 'airport' && looksLikeIcao(w.ident ?? w.name)
        ? (w.ident ?? w.name).trim().toUpperCase()
        : `${gfpCoord(w.lat, 'N', 'S', 2)}${gfpCoord(w.lon, 'E', 'W', 3)}`,
    );
  // collapse a repeated point (base … RTB base) — the GTN rejects duplicates
  const out: string[] = [];
  for (const p of pts) if (p !== out[out.length - 1]) out.push(p);
  return `FPN/RI:F:${out.join(':F:')}`;
}

export type TdsInfo = {
  installed: boolean;
  /** where .gfp plans belong, whether or not it exists yet */
  fplDir: string;
  /** what proved the install, for the UI and support */
  evidence: string | null;
};

/**
 * Find a TDS GTNXi install and the folder its FPL catalog imports from
 * (`ProgramData\TDS\GTNXi\FPL`, per the TDS manual).
 *
 * The catch: that folder only appears once the catalog has been used, so keying
 * detection off it misses everyone who has GTNXi installed but has never
 * imported a plan — they'd silently get no .gfp at all. The licence files GTNXi
 * drops in `TDS\Common` exist from install time, so they are the dependable
 * signal; we create the FPL folder ourselves when writing.
 */
export async function tdsGtnxi(): Promise<TdsInfo> {
  const root = path.join(process.env.ProgramData || 'C:\\ProgramData', 'TDS');
  const fplDir = path.join(root, 'GTNXi', 'FPL');

  if (await exists(fplDir)) return { installed: true, fplDir, evidence: 'FPL catalog folder' };
  if (await exists(path.dirname(fplDir))) return { installed: true, fplDir, evidence: 'GTNXi data folder' };
  for (const dat of ['TDSGTNXiFlightSim.dat', 'TDSGTNXiFlightSimProUpgrade.dat']) {
    if (await exists(path.join(root, 'Common', dat))) return { installed: true, fplDir, evidence: dat };
  }
  return { installed: false, fplDir, evidence: null };
}

/** The GTNXi FPL folder as a list — empty when GTNXi isn't installed. */
export async function tdsFplDirs(): Promise<string[]> {
  const tds = await tdsGtnxi();
  return tds.installed ? [tds.fplDir] : [];
}

/**
 * The GTNXi loads at most 50 .gfp files from the FPL folder, so one plan per job
 * would eventually crowd the user's own plans out of the Import list. Keep only
 * the newest few of ours, and never touch a file we didn't write.
 */
const GFP_KEEP = 8;

async function pruneOurGfp(dir: string): Promise<void> {
  try {
    const mine = (await fs.readdir(dir)).filter((f) => /^AED_.*\.gfp$/i.test(f));
    if (mine.length <= GFP_KEEP) return;
    const stamped = await Promise.all(mine.map(async (f) => ({ f, t: (await fs.stat(path.join(dir, f))).mtimeMs })));
    stamped.sort((a, b) => b.t - a.t);
    for (const { f } of stamped.slice(GFP_KEEP)) await fs.rm(path.join(dir, f), { force: true });
  } catch {
    /* best effort — a crowded folder beats a failed export */
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Every PMS50 GTN750 user-flight-plan folder found in the sim's Community folders. */
export async function pms50FplDirs(): Promise<string[]> {
  const out: string[] = [];
  for (const root of await packageRoots()) {
    for (const pkg of ['pms50-instrument-gtn750', 'pms50-gtn750', 'pms50-instrument-gtn750-premium']) {
      const dir = path.join(root, 'Community', pkg, 'fpl', 'gtn750');
      const base = path.join(root, 'Community', pkg);
      if (await exists(base)) out.push(dir);
    }
  }
  return out;
}

export type PlnResult = {
  files: string[];
  pms50: number;
  /** how many TDS GTNXi FPL folders got the .gfp */
  tds: number;
  /** GTNXi is installed (even if the write failed, e.g. permissions) */
  tdsInstalled: boolean;
  /** absolute path of the .pln, for SimConnect flightPlanLoad */
  plnPath: string;
};

/**
 * Write the whole tasking route — present position → base → scene → hospital
 * (if any) → base — into the PMS50 GTN750's user-flight-plan folder as
 * `fpl.pln` (…/pms50-instrument-gtn750/fpl/gtn750/fpl.pln), plus a named copy in
 * Documents. On the unit: FPL ▸ Menu ▸ Import ▸ fpl.
 */
export async function writeDirectPln(from: Pt, legs: Leg[], docName = 'route'): Promise<PlnResult> {
  const safe = (docName.replace(/[^A-Za-z0-9_-]/g, '') || 'route').slice(0, 24);
  const body = buildPln(from, legs);
  const files: string[] = [];

  const docs = path.join(app.getPath('documents'), 'Aus Emergency Dispatcher');
  await fs.mkdir(docs, { recursive: true });
  const docFile = path.join(docs, `${safe}.pln`);
  await fs.writeFile(docFile, body, 'utf8');
  files.push(docFile);

  const fplDirs = await pms50FplDirs();
  for (const dir of fplDirs) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const f = path.join(dir, 'fpl.pln');
      await fs.writeFile(f, body, 'utf8');
      files.push(f);
    } catch {
      /* read-only / permissions — the Documents copy still works */
    }
  }

  // TDS GTNXi wants a Garmin .gfp in its own catalog folder. Create it if this
  // is the user's first import — GTNXi only makes it once the catalog is used,
  // and it reads whatever is there regardless of who created it.
  const gfp = buildGfp(legs);
  const tdsInfo = await tdsGtnxi();
  let tds = 0;
  if (tdsInfo.installed) {
    try {
      await fs.mkdir(tdsInfo.fplDir, { recursive: true });
      const f = path.join(tdsInfo.fplDir, `AED_${safe.toUpperCase()}.gfp`);
      await fs.writeFile(f, gfp, 'utf8');
      files.push(f);
      tds++;
      await pruneOurGfp(tdsInfo.fplDir);
    } catch {
      /* read-only / permissions — the Documents copy still works */
    }
  }
  await fs.writeFile(path.join(docs, `${safe}.gfp`), gfp, 'utf8').catch(() => undefined);

  return { files, pms50: fplDirs.length, tds, tdsInstalled: tdsInfo.installed, plnPath: docFile };
}
