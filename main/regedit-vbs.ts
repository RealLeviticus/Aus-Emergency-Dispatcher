import { existsSync } from 'fs';
import path from 'path';
import { app } from 'electron';
import regedit from 'regedit';

/**
 * Teach `regedit` where its scripts live.
 *
 * regedit does not read the registry itself — it shells out to `cscript.exe`
 * against .wsf/.vbs files it expects to find in `<its own module dir>/vbs`.
 * webpack bundles regedit's JavaScript into background.js but cannot bundle
 * those scripts, so `__dirname` resolves beside the bundle and every lookup
 * dies with:
 *
 *   Input Error: Can not find script file "...\app\vbs\regList.wsf"
 *
 * We ship the folder verbatim via electron-builder `extraResources`
 * (-> resources/regedit-vbs) and point regedit at it. It must stay OUTSIDE the
 * asar: cscript.exe is a separate process and cannot read an archive member.
 *
 * Who needs this: node-simconnect reads
 * HKCU\Software\Microsoft\Microsoft Games\Flight Simulator\SimConnect_Port_IPv4
 * as the last resort in its autodetect chain, after SimConnect.cfg and the MSFS
 * named pipe. A normal local sim answers on the pipe, which is why this stayed
 * invisible until the app ran from a package with no sim running.
 *
 * Both regedit importers resolve to the same bundled module instance, so
 * setting the location once here covers node-simconnect's own `require`.
 */
export function configureRegeditScripts(): void {
  const candidates = [
    // packaged: electron-builder extraResources
    path.join(process.resourcesPath ?? '', 'regedit-vbs'),
    // dev: straight out of node_modules
    path.join(app.getAppPath(), 'node_modules', 'regedit', 'vbs'),
  ];

  const dir = candidates.find((c) => c && existsSync(path.join(c, 'regList.wsf')));
  if (!dir) {
    // Not fatal: only the IPv4 fallback needs it, and the named pipe covers a
    // normal local sim. Say so once rather than letting cscript complain per call.
    console.warn('[regedit] no vbs script folder found; SimConnect IPv4 autodetect will not work');
    return;
  }

  const result = regedit.setExternalVBSLocation(dir);
  if (result !== 'Folder found and set') console.warn(`[regedit] ${result}: ${dir}`);
}
