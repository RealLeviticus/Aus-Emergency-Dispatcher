import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { app, shell } from 'electron';
import { packageRoots } from './liveries';

/**
 * Guided installer for the third-party scene-object packs the scenes engine
 * targets (30West HEMS Objects, 68ponyGT / HPG "H145 Action Pack" objects).
 *
 * These packs CANNOT be bundled, downloaded or hosted by this app — their
 * licences forbid redistribution:
 *   "Any reupload or redistribution of this file without the author's prior
 *    written consent is forbidden."  (© 68ponyGT / HPG)
 *   flightsim.to's terms likewise forbid re-hosting or hot-linking files.
 *
 * So the app does the next best thing: the user downloads each pack once from
 * flightsim.to into a known "AddonPacks" drop folder, and the app extracts the
 * zips straight into every detected MSFS Community folder — the same copy a
 * user would do by hand, just automated and kept in sync. Packs already sitting
 * in the Community folder are detected and left alone.
 */

const execFileP = promisify(execFile);

export type AddonPack = {
  id: string;
  name: string;
  author: string;
  url: string;
  /** Community sub-folder names this download drops (used for detection). */
  folders: string[];
  /** Scenes that need it, for the UI. */
  usedFor: string;
  required: boolean;
};

export const ADDON_PACKS: AddonPack[] = [
  {
    id: '30west-hems-objects',
    name: '30West — HEMS Objects',
    author: '30West',
    url: 'https://flightsim.to/file/69699/hems-objects',
    folders: ['30west-hems-objects', '30west-smoke'],
    usedFor: 'Ambulances, wrecks, hi-vis crew, patients, cordon, fire & smoke on MVA / rescue / fire calls.',
    required: true,
  },
  {
    id: 'h145-action-pack-hems-objects',
    name: 'HPG H145 Action Pack — HEMS Objects',
    author: '68ponyGT / HPG',
    url: 'https://flightsim.to/file/47913/h145-action-pack-hems-objects',
    folders: [
      '68ponygt-actionpack-hems-construction',
      '68ponygt-actionpack-hems-farming',
      '68ponygt-actionpack-hems-wrecks',
      '68ponygt-actionpack-std-objects',
      '68ponygt-vfx-smoke',
    ],
    usedFor: 'Crashed cars & trucks, tow trucks, farm & construction plant, trains, powerlines, extra smoke/fire VFX.',
    required: true,
  },
  {
    id: 'h145-action-pack-offshore-objects',
    name: 'HPG H145 Action Pack — Offshore Objects',
    author: '68ponyGT / HPG',
    url: 'https://flightsim.to/file/43408/h145-action-pack-offshore-objects',
    folders: ['68ponygt-actionpack-vehicles-offshore'],
    usedFor: 'Boats, life rafts, oil rig and ship props for marine / SAR / swiftwater calls.',
    required: false,
  },
];

const README = [
  'Aus Emergency Dispatcher — scene object packs',
  '============================================',
  '',
  'The dispatcher places real MSFS scene props at MVA, rescue, fire and marine',
  'jobs. Those props come from a few free flightsim.to packs. Their licences do',
  'NOT allow this app to bundle or download them for you, so this is a one-time',
  'manual step:',
  '',
  '  1. Download each pack ZIP (links below) — sign in to flightsim.to first.',
  '  2. Drop the ZIP files into THIS folder (no need to unzip them).',
  '  3. In the app:  Help  ▸  Install downloaded scene packs',
  '     (or just restart the app — it auto-installs any ZIPs it finds here).',
  '  4. Fully restart MSFS so the sim loads the new packages.',
  '',
  'Packs:',
  ...ADDON_PACKS.flatMap((p) => ['', `  ${p.name}   (${p.author})${p.required ? '' : '   [optional]'}`, `    ${p.url}`, `    ${p.usedFor}`]),
  '',
  'The app installs these into every MSFS Community folder it detects and keeps',
  'the ZIPs here so it can re-apply them after an MSFS update. Packs you already',
  'have in your Community folder are detected and left untouched.',
  '',
  'These packs remain under their authors\u2019 own licences and copyright.',
].join('\r\n');

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** `Documents\Aus Emergency Dispatcher\AddonPacks` — created with a README. */
export async function packsDir(): Promise<string> {
  const dir = path.join(app.getPath('documents'), 'Aus Emergency Dispatcher', 'AddonPacks');
  await fs.mkdir(dir, { recursive: true });
  try {
    await fs.writeFile(path.join(dir, 'READ ME — how to add scene packs.txt'), README, { flag: 'w' });
  } catch {
    /* best effort */
  }
  return dir;
}

/** Community folders next to each detected InstalledPackagesPath. */
export async function communityFolders(): Promise<string[]> {
  const out: string[] = [];
  for (const root of await packageRoots()) {
    const c = path.join(root, 'Community');
    if (await exists(c)) out.push(c);
  }
  return out;
}

async function listZips(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.zip'))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** A pack folder counts as installed if it exists with a manifest.json. */
async function folderInstalledSomewhere(folder: string, communities: string[]): Promise<boolean> {
  for (const c of communities) {
    if (await exists(path.join(c, folder, 'manifest.json'))) return true;
  }
  return false;
}

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

export async function addonStatus(): Promise<AddonStatus> {
  const dir = await packsDir();
  const communities = await communityFolders();
  const zips = await listZips(dir);
  const packs: AddonStatus['packs'] = [];
  for (const p of ADDON_PACKS) {
    const present: string[] = [];
    const missing: string[] = [];
    for (const f of p.folders) {
      if (await folderInstalledSomewhere(f, communities)) present.push(f);
      else missing.push(f);
    }
    packs.push({
      id: p.id,
      name: p.name,
      author: p.author,
      url: p.url,
      usedFor: p.usedFor,
      required: p.required,
      installed: missing.length === 0,
      partial: present.length > 0 && missing.length > 0,
      missingFolders: missing,
    });
  }
  const ready = packs.filter((p) => p.required).every((p) => p.installed);
  return { packsDir: dir, communityFolders: communities, zips, packs, ready };
}

/**
 * Extract a zip into `dest`. Prefers Windows' built-in bsdtar (System32\tar.exe,
 * present since Win10 1803) which streams and handles multi-GB archives well;
 * falls back to PowerShell's Expand-Archive. No npm dependency either way.
 */
async function extractZip(zipPath: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const win = process.env.SystemRoot ?? 'C:\\Windows';
  const sysTar = path.join(win, 'System32', 'tar.exe');
  if (await exists(sysTar)) {
    try {
      await execFileP(sysTar, ['-xf', zipPath, '-C', dest], { windowsHide: true, maxBuffer: 1 << 24 });
      return;
    } catch {
      /* fall through to PowerShell */
    }
  }
  const ps = path.join(win, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await execFileP(
    ps,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(dest)} -Force`,
    ],
    { windowsHide: true, maxBuffer: 1 << 24 },
  );
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  for (const entry of await fs.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

/** Find MSFS package dirs (contain a manifest.json) up to `depth` deep. */
async function findPackageDirs(root: string, depth: number, out: string[]): Promise<void> {
  if (await exists(path.join(root, 'manifest.json'))) {
    out.push(root);
    return; // don't descend into a package
  }
  if (depth <= 0) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) await findPackageDirs(path.join(root, e.name), depth - 1, out);
  }
}

export type InstallResult = {
  ok: boolean;
  message: string;
  installedFolders: string[];
  communityFolders: string[];
  zips: string[];
};

/**
 * Extract every ZIP in the drop folder and copy the MSFS packages inside them
 * into every detected Community folder. Idempotent — re-running refreshes.
 */
export async function installDownloadedPacks(): Promise<InstallResult> {
  const dir = await packsDir();
  const communities = await communityFolders();
  const zips = await listZips(dir);

  if (communities.length === 0) {
    return {
      ok: false,
      message: 'No MSFS Community folder found. Start MSFS once so it writes its config, then try again.',
      installedFolders: [],
      communityFolders: [],
      zips,
    };
  }
  if (zips.length === 0) {
    return {
      ok: false,
      message: `No pack ZIPs found. Download the packs from flightsim.to into:\n${dir}`,
      installedFolders: [],
      communityFolders: communities,
      zips,
    };
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'aed-packs-'));
  const installed = new Set<string>();
  try {
    for (const zip of zips) {
      const stage = path.join(tmpRoot, path.basename(zip, '.zip'));
      try {
        await extractZip(zip, stage);
      } catch (err) {
        return {
          ok: false,
          message: `Could not read ${path.basename(zip)} — it may be a corrupt or partial download. ${
            err instanceof Error ? err.message : String(err)
          }`,
          installedFolders: [...installed],
          communityFolders: communities,
          zips,
        };
      }
      const pkgDirs: string[] = [];
      await findPackageDirs(stage, 4, pkgDirs);
      if (pkgDirs.length === 0) continue;
      for (const pkg of pkgDirs) {
        const folderName = path.basename(pkg);
        for (const c of communities) {
          const target = path.join(c, folderName);
          try {
            await fs.rm(target, { recursive: true, force: true });
            await copyDir(pkg, target);
          } catch (err) {
            return {
              ok: false,
              message: `Could not write ${folderName} into ${c}: ${
                err instanceof Error ? err.message : String(err)
              }`,
              installedFolders: [...installed],
              communityFolders: communities,
              zips,
            };
          }
        }
        installed.add(folderName);
      }
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  if (installed.size === 0) {
    return {
      ok: false,
      message:
        'The ZIPs in the drop folder did not contain an MSFS package (no manifest.json inside). ' +
        'Make sure you downloaded the object packs, not a livery or a screenshot pack.',
      installedFolders: [],
      communityFolders: communities,
      zips,
    };
  }

  return {
    ok: true,
    message: `Installed ${installed.size} package folder(s) into ${communities.length} Community folder(s). Fully restart MSFS to load them.`,
    installedFolders: [...installed].sort(),
    communityFolders: communities,
    zips,
  };
}

/** Startup hook: if ZIPs are waiting and a required pack is still missing, install. */
export async function autoInstallAddonsIfPresent(): Promise<void> {
  try {
    await packsDir(); // ensure the folder + README exist even on a clean install
    const status = await addonStatus();
    if (status.zips.length === 0) return;
    if (status.communityFolders.length === 0) return;
    if (status.ready && !status.packs.some((p) => p.partial)) return;
    await installDownloadedPacks();
  } catch {
    /* never block startup */
  }
}

export async function openPacksFolder(): Promise<boolean> {
  const dir = await packsDir();
  await shell.openPath(dir);
  return true;
}
