const fs = require('fs');
const path = require('path');

// Next's static export drops a bare `app/package.json` (`{"type":"commonjs"}`).
// electron-builder then treats `app/` as a second package manifest and aborts
// for want of name/version. We package in single-manifest mode (root
// package.json + `files: [package.json, app]`), so remove that stub if it has
// no name. Runs after the renderer export, before electron-builder.
function stripBareAppPackageJson() {
  try {
    const p = path.join(__dirname, 'app', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!pkg || !pkg.name) fs.rmSync(p, { force: true });
  } catch {
    /* nothing to strip */
  }
}

module.exports = {
  // Bundle every dependency into the main process bundle so the packaged app does
  // not rely on node_modules being copied. `target: 'electron-main'` still keeps
  // `electron` and node built-ins external via its externals preset.
  webpack: (config) => {
    config.externals = [];
    stripBareAppPackageJson();
    return config;
  },
};
