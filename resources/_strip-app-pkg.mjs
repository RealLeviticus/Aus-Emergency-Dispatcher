// Next writes a bare app/package.json ({"type":"commonjs"}); electron-builder then
// treats app/ as a second manifest and aborts. We package single-manifest, so
// drop it (unless it has a real name). Runs between the nextron build and packaging.
import { existsSync, readFileSync, rmSync } from 'fs';
const p = new URL('../app/package.json', import.meta.url);
try {
  if (existsSync(p)) {
    const pkg = JSON.parse(readFileSync(p, 'utf8'));
    if (!pkg?.name) { rmSync(p, { force: true }); console.log('[strip] removed bare app/package.json'); }
  }
} catch (e) { console.warn('[strip]', e.message); }
