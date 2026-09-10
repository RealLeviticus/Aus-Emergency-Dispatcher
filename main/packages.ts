import { promises as fs } from 'fs';
import path from 'path';
import { app } from 'electron';
import { packageRoots } from './liveries';

/**
 * Ships the `aus-emergency-dispatcher-objects` MSFS package (built by
 * resources/msfs-packages/_build.mjs) and installs it into every detected
 * MSFS Community folder, so all operators have the same scene objects without
 * any manual setup. A model that isn't a spawnable dynamic SimObject in a given
 * sim simply falls through the injector's title chain to `Windsock`.
 */

const PKG_NAME = 'aus-emergency-dispatcher-objects';
const PKG_VERSION = '1.3.0';

/** Where the bundled package sits, dev vs packaged. */
function sourceDir(): string {
  const packaged = path.join(process.resourcesPath ?? '', 'msfs-packages', PKG_NAME);
  const dev = path.join(app.getAppPath(), 'resources', 'msfs-packages', PKG_NAME);
  return process.resourcesPath ? packaged : dev;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
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

/** Community folders next to each detected InstalledPackagesPath. */
async function communityFolders(): Promise<string[]> {
  const out: string[] = [];
  for (const root of await packageRoots()) {
    const c = path.join(root, 'Community');
    if (await exists(c)) out.push(c);
  }
  return out;
}

export type PackageStatus = {
  bundledVersion: string;
  source: string;
  hasSource: boolean;
  communityFolders: string[];
  installedIn: string[];
};

/** Read `package_version` from an installed/bundled manifest.json (or ''). */
async function manifestVersion(dir: string): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
    const v = JSON.parse(raw)?.package_version;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

export async function packageStatus(): Promise<PackageStatus & { staleIn: string[] }> {
  const src = sourceDir();
  const folders = await communityFolders();
  const bundled = (await manifestVersion(src)) || PKG_VERSION;
  const installedIn: string[] = [];
  const staleIn: string[] = [];
  for (const f of folders) {
    const dir = path.join(f, PKG_NAME);
    if (!(await exists(path.join(dir, 'manifest.json')))) continue;
    installedIn.push(f);
    if ((await manifestVersion(dir)) !== bundled) staleIn.push(f);
  }
  return {
    bundledVersion: bundled,
    source: src,
    hasSource: await exists(path.join(src, 'manifest.json')),
    communityFolders: folders,
    installedIn,
    staleIn,
  };
}

export async function installPackage(): Promise<{ ok: boolean; installed: string[]; message: string }> {
  const src = sourceDir();
  if (!(await exists(path.join(src, 'manifest.json')))) {
    return { ok: false, installed: [], message: 'Bundled object package not found in this build.' };
  }
  const folders = await communityFolders();
  if (folders.length === 0) {
    return { ok: false, installed: [], message: 'No MSFS Community folder found. Open MSFS once, then retry.' };
  }
  const installed: string[] = [];
  for (const f of folders) {
    const dst = path.join(f, PKG_NAME);
    try {
      await fs.rm(dst, { recursive: true, force: true });
      await copyDir(src, dst);
      installed.push(f);
    } catch (err) {
      return {
        ok: false,
        installed,
        message: `Could not write to ${f}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  await recordInstalledPackages(installed.map((f) => path.join(f, PKG_NAME)));
  return {
    ok: true,
    installed,
    message: `Installed the object pack in ${installed.length} Community folder(s). Restart MSFS (or rescan add-ons) to load it.`,
  };
}

/**
 * Leave a breadcrumb the NSIS uninstaller can read (resources/installer.nsh):
 * one absolute package path per line, so uninstalling the app also takes the
 * package back out of every Community folder we copied it into. Nothing else
 * reads this file, and a missing/corrupt one just means the uninstaller skips
 * the step.
 */
async function recordInstalledPackages(dirs: string[]): Promise<void> {
  try {
    const file = path.join(app.getPath('userData'), 'installed-msfs-packages.txt');
    if (dirs.length === 0) {
      await fs.rm(file, { force: true });
      return;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, dirs.map((d) => `${d}\r\n`).join(''), 'utf8');
  } catch {
    /* best effort — never fail an install over the breadcrumb */
  }
}

/** Copy in on startup if a Community folder is missing the package OR has an
 *  out-of-date copy (so a fixed package replaces a broken earlier one). */
export async function autoInstallIfMissing(): Promise<void> {
  try {
    const status = await packageStatus();
    if (!status.hasSource) return;
    if (status.communityFolders.length === 0) return;
    const upToDate = status.installedIn.length === status.communityFolders.length && status.staleIn.length === 0;
    if (upToDate) return;
    await installPackage();
  } catch {
    /* best effort — never block startup */
  }
}
