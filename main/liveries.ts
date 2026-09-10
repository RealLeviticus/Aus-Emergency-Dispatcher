import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

/**
 * The `ATC ID` simvar returns whatever the player set in the MSFS menu, which
 * overrides the livery. To get the registration that is actually painted on the
 * aircraft we read it straight from the livery's `aircraft.cfg` on disk.
 *
 * Builds a `container title -> atc_id` index by scanning every `aircraft.cfg`
 * under the sim's Community / Official package folders (each `[FLTSIM.n]` block
 * carries a `title` and, usually, an `atc_id`).
 */
export class LiveryIndex {
  private index = new Map<string, string>();
  private building: Promise<void> | null = null;
  private builtAt = 0;

  ready(): boolean {
    return this.builtAt > 0;
  }

  /** Kick off a build if one hasn't run recently. Safe to call repeatedly. */
  ensureBuilt(maxAgeMs = 10 * 60_000): Promise<void> {
    if (this.building) return this.building;
    if (this.builtAt && Date.now() - this.builtAt < maxAgeMs) return Promise.resolve();
    this.building = this.build()
      .catch(() => undefined)
      .finally(() => {
        this.building = null;
        this.builtAt = Date.now();
      });
    return this.building;
  }

  /** Registration for the current container title, or undefined if not indexed. */
  lookup(title: string): string | undefined {
    if (!title) return undefined;
    return this.index.get(normalizeTitle(title));
  }

  private async build(): Promise<void> {
    const roots = await packageRoots();
    const next = new Map<string, string>();
    const deadline = Date.now() + 12_000;
    let filesRead = 0;

    for (const root of roots) {
      for (const dir of ['Community', 'Official/OneStore', 'Official/Steam']) {
        if (Date.now() > deadline || filesRead > 6000) break;
        await walkForAircraftCfg(path.join(root, dir), 6, async (cfgPath) => {
          if (Date.now() > deadline || filesRead > 6000) return;
          filesRead += 1;
          try {
            const text = await fs.readFile(cfgPath, 'utf8');
            for (const [title, atcId] of parseFltsimBlocks(text)) {
              if (atcId) next.set(normalizeTitle(title), atcId);
            }
          } catch {
            /* unreadable cfg — skip */
          }
        });
      }
    }

    if (next.size) this.index = next;
  }
}

export const liveryIndex = new LiveryIndex();

// --- helpers --------------------------------------------------------------

function normalizeTitle(title: string): string {
  return title
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** yields [title, atc_id] for each [FLTSIM.n] section that has a title */
function* parseFltsimBlocks(cfg: string): Generator<[string, string]> {
  const lines = cfg.split(/\r?\n/);
  let inBlock = false;
  let title = '';
  let atcId = '';
  const flush = function* (): Generator<[string, string]> {
    if (title) yield [title, atcId];
    title = '';
    atcId = '';
  };
  for (const rawLine of lines) {
    const line = rawLine.replace(/;.*$/, '').trim();
    const section = line.match(/^\[([^\]]+)\]/);
    if (section) {
      if (inBlock) yield* flush();
      inBlock = /^fltsim\.\d+$/i.test(section[1]!.trim());
      continue;
    }
    if (!inBlock) continue;
    const kv = line.match(/^([A-Za-z_]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!
      .trim()
      .replace(/^["']|["']$/g, '')
      .trim();
    if (key === 'title') title = value;
    else if (key === 'atc_id') atcId = value;
  }
  if (inBlock) yield* flush();
}

/** Resolve the MSFS 2020 + 2024 InstalledPackagesPath values. */
export async function packageRoots(): Promise<string[]> {
  const candidates = [
    // MS Store
    path.join(
      process.env.LOCALAPPDATA ?? '',
      'Packages',
      'Microsoft.FlightSimulator_8wekyb3d8bbwe',
      'LocalCache',
      'UserCfg.opt',
    ),
    path.join(
      process.env.LOCALAPPDATA ?? '',
      'Packages',
      'Microsoft.Limitless_8wekyb3d8bbwe',
      'LocalCache',
      'UserCfg.opt',
    ),
    // Steam
    path.join(process.env.APPDATA ?? '', 'Microsoft Flight Simulator', 'UserCfg.opt'),
    path.join(process.env.APPDATA ?? '', 'Microsoft Flight Simulator 2024', 'UserCfg.opt'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft Flight Simulator', 'UserCfg.opt'),
  ];

  const roots = new Set<string>();
  for (const opt of candidates) {
    if (!opt) continue;
    try {
      const text = await fs.readFile(opt, 'utf8');
      const m = text.match(/InstalledPackagesPath\s+"([^"]+)"/i);
      if (m?.[1]) roots.add(m[1]);
    } catch {
      /* not this install type */
    }
  }
  return [...roots];
}

async function walkForAircraftCfg(
  dir: string,
  depth: number,
  onFile: (cfgPath: string) => Promise<void>,
): Promise<void> {
  if (depth < 0) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      if (entry.name.toLowerCase() === 'aircraft.cfg') await onFile(full);
    } else if (entry.isDirectory()) {
      await walkForAircraftCfg(full, depth - 1, onFile);
    }
  }
}
