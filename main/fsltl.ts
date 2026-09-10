import { promises as fs } from 'fs';
import path from 'path';
import { packageRoots } from './liveries';

/**
 * Detects FSLTL (FlightSim Traffic Live) in the user's Community folder and
 * collects its AI aircraft container titles. FSLTL ships civilian airliner AI
 * models — perfect as the "contact of interest" for QRA / intercept / maritime
 * patrol tasking. Most sim pilots run it, so spawning an FSLTL type gives every
 * unit the same visible target.
 */

export type FsltlStatus = {
  installed: boolean;
  trafficBase: boolean;
  packages: string[];
  titles: string[];
  builtAt: number;
};

let cache: FsltlStatus | null = null;
let building: Promise<FsltlStatus> | null = null;

/** A small default set (used only if we can't read titles from the package). */
const FALLBACK_TITLES = [
  'FSLTL A320N',
  'FSLTL A21N',
  'FSLTL B738',
  'FSLTL B38M',
  'FSLTL B77W',
  'FSLTL B789',
  'FSLTL E75L',
  'FSLTL DH8D',
];

async function readTitles(cfgPath: string, into: Set<string>): Promise<void> {
  try {
    const text = await fs.readFile(cfgPath, 'utf8');
    for (const m of text.matchAll(/^\s*title\s*=\s*"?([^"\r\n;]+)"?/gim)) {
      const t = m[1]?.trim();
      if (t) into.add(t);
    }
  } catch {
    /* skip */
  }
}

async function walk(dir: string, depth: number, into: Set<string>): Promise<void> {
  if (depth < 0) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile()) {
      if (/^(aircraft|sim)\.cfg$/i.test(e.name)) await readTitles(full, into);
    } else if (e.isDirectory()) {
      await walk(full, depth - 1, into);
    }
  }
}

async function build(): Promise<FsltlStatus> {
  const packages: string[] = [];
  const titles = new Set<string>();
  let trafficBase = false;

  for (const root of await packageRoots()) {
    const community = path.join(root, 'Community');
    let dirs: import('fs').Dirent[];
    try {
      dirs = await fs.readdir(community, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory() || !/fsltl/i.test(d.name)) continue;
      packages.push(d.name);
      if (/traffic-?base/i.test(d.name)) trafficBase = true;
      await walk(path.join(community, d.name), 5, titles);
    }
  }

  const list = [...titles].filter((t) => /fsltl/i.test(t));
  cache = {
    installed: packages.length > 0,
    trafficBase,
    packages,
    titles: list.length ? list.slice(0, 400) : packages.length ? FALLBACK_TITLES : [],
    builtAt: Date.now(),
  };
  return cache;
}

export async function fsltlStatus(maxAgeMs = 10 * 60_000): Promise<FsltlStatus> {
  if (cache && Date.now() - cache.builtAt < maxAgeMs) return cache;
  if (!building) building = build().finally(() => (building = null));
  return building;
}

export type ContactHint = 'jet' | 'heavy' | 'prop' | 'light';

const HINT_RE: Record<ContactHint, RegExp> = {
  jet: /A19N|A20N|A21N|A319|A320|A321|B73|B38M|E75|E19|E29|CRJ|MD8/i,
  heavy: /B74|B77|B78|B76|A33|A34|A35|A38|B77W|B789|MD11|C17|KC30|A30/i,
  prop: /DH8|AT7|AT4|AT5|ATR|Q40|SF34|DHC|E120|SW4|BE20|C208/i,
  light: /C172|C182|C152|C208|DA40|DA62|SR22|PA28|BE58|BE33|TBM|PC12|M20/i,
};

// Base-game aircraft to fall back to when FSLTL has nothing suitable. A "light"
// or "prop" contact must NEVER become an airliner — a slow-mover intercept has
// to actually be a slow mover.
const BASE_FALLBACK: Record<ContactHint, string[]> = {
  light: [
    'DA62 Asobo',
    'DA40NG Asobo',
    'Asobo_DA62',
    'Beechcraft Baron G58 Asobo',
    'Cub Crafters XCub Asobo',
    'VL3 Asobo',
    'DV20 Asobo',
  ],
  prop: [
    'TBM 930 Asobo',
    'DA62 Asobo',
    'Beechcraft King Air 350i Asobo',
    'Daher TBM 930 Asobo',
    'Cessna 208 Grand Caravan EX Asobo',
  ],
  heavy: ['Boeing 747 8i Asobo', 'Boeing 787 10 Asobo', 'Airbus A320 Neo Asobo'],
  jet: ['Airbus A320 Neo Asobo', 'Boeing 737 MAX 8 Asobo', 'Cessna CJ4 Citation Asobo'],
};

/**
 * Titles that make sense as an airborne contact for the given `hint`. FSLTL
 * matches first; if it has none, we use base-game aircraft of the SAME class
 * (never a jet for a light/prop hint).
 */
export async function contactTitles(hint: ContactHint = 'jet'): Promise<string[]> {
  const s = await fsltlStatus();
  const pool = s.titles.length ? s.titles : FALLBACK_TITLES;
  const matched = pool.filter((t) => HINT_RE[hint].test(t));
  const base = BASE_FALLBACK[hint];
  if (matched.length) return [...matched.slice(0, 10), ...base];
  // Light/prop must stay slow — go straight to the base-game GA aircraft.
  if (hint === 'light' || hint === 'prop') return [...base, 'DA62 Asobo'];
  // jet/heavy: try the FSLTL pool's other big types, then base-game jets.
  for (const h of ['jet', 'heavy'] as ContactHint[]) {
    const m = pool.filter((t) => HINT_RE[h].test(t));
    if (m.length) return [...m.slice(0, 10), ...base];
  }
  return [...base, ...pool.slice(0, 6)];
}
