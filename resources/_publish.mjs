/**
 * Uploads a built release to the static update feed on the VPS.
 *
 * electron-builder's own `--publish` has no generic-provider uploader, so this
 * does it over scp (bundled with Windows OpenSSH).
 *
 * The one rule that matters: the installer and its blockmap go up BEFORE the
 * channel manifest. A client that reads latest.yml the moment it appears must
 * find the .exe already there, or every install in the field takes a 404 and
 * reports a failed update.
 *
 *   npm run publish                 upload dist/ to the configured target
 *   npm run publish -- --dry-run    show what would be uploaded
 *
 * Configure with environment variables (see RELEASING.md):
 *   AED_PUBLISH_TARGET   user@host:/absolute/path        (or HOST + PATH below)
 *   AED_PUBLISH_HOST     139.99.195.169
 *   AED_PUBLISH_USER     deploy                          (default: current user)
 *   AED_PUBLISH_PATH     /opt/aed-dispatcher/updates
 *   AED_PUBLISH_URL      https://dispatcher.actuallyleviticus.xyz/updates
 *   AED_PUBLISH_SSH_KEY  path to a private key           (optional)
 */
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');
const DIST = path.join(APP, 'dist');

const dryRun = process.argv.includes('--dry-run');

function fail(msg) {
  console.error(`\n  publish failed: ${msg}\n`);
  process.exit(1);
}

// --- where are we sending it -------------------------------------------------

function resolveTarget() {
  if (process.env.AED_PUBLISH_TARGET) return process.env.AED_PUBLISH_TARGET;
  const host = process.env.AED_PUBLISH_HOST;
  const dir = process.env.AED_PUBLISH_PATH;
  if (!host || !dir) {
    fail(
      'set AED_PUBLISH_TARGET (user@host:/path), or AED_PUBLISH_HOST and AED_PUBLISH_PATH.\n' +
        '  See RELEASING.md.',
    );
  }
  const user = process.env.AED_PUBLISH_USER;
  return `${user ? `${user}@` : ''}${host}:${dir}`;
}

/** The feed url the built app will actually poll, for the post-upload check. */
function resolveFeedUrl() {
  if (process.env.AED_PUBLISH_URL) return process.env.AED_PUBLISH_URL.replace(/\/+$/, '');
  const yml = path.join(APP, 'electron-builder.yml');
  const m = existsSync(yml) && readFileSync(yml, 'utf8').match(/^\s*url:\s*(\S+)\s*$/m);
  return m ? m[1].replace(/\/+$/, '') : null;
}

// --- what are we sending -----------------------------------------------------

const version = JSON.parse(readFileSync(path.join(APP, 'package.json'), 'utf8')).version;

if (!existsSync(DIST)) fail(`no dist/ folder — run "npm run build" first.`);
const files = readdirSync(DIST);

const manifests = files.filter((f) => /^(latest|beta|alpha)\.yml$/.test(f));
if (manifests.length === 0) {
  fail('dist/ has no latest.yml — that file is the feed, so the build did not produce a publishable release.');
}

const installers = files.filter((f) => f.endsWith('.exe'));
const blockmaps = files.filter((f) => f.endsWith('.exe.blockmap'));
if (installers.length === 0) fail('dist/ has no installer .exe.');

// Guard against shipping a manifest that points at a version we did not build.
for (const m of manifests) {
  const body = readFileSync(path.join(DIST, m), 'utf8');
  const mv = body.match(/^version:\s*(\S+)/m)?.[1];
  if (mv !== version) {
    fail(`dist/${m} is for version ${mv}, but package.json says ${version}. Rebuild before publishing.`);
  }
  const named = body.match(/^\s*-?\s*url:\s*(.+)$/m)?.[1]?.trim();
  if (named && !files.includes(decodeURIComponent(named))) {
    fail(`dist/${m} points at "${named}", which is not in dist/.`);
  }
}

const target = resolveTarget();
const feedUrl = resolveFeedUrl();

// Payload before manifest — see the note at the top of this file.
const ordered = [...installers, ...blockmaps, ...manifests];

console.log(`\n  Aus Emergency Dispatcher ${version}`);
console.log(`  -> ${target}`);
if (feedUrl) console.log(`  feed ${feedUrl}`);
console.log('');
for (const f of ordered) {
  const mb = (readFileSync(path.join(DIST, f)).length / 1024 / 1024).toFixed(1);
  console.log(`    ${f.padEnd(48)} ${mb.padStart(7)} MB`);
}
console.log('');

if (dryRun) {
  console.log('  --dry-run: nothing uploaded.\n');
  process.exit(0);
}

// --- upload ------------------------------------------------------------------

const sshOpts = process.env.AED_PUBLISH_SSH_KEY ? ['-i', process.env.AED_PUBLISH_SSH_KEY] : [];

for (const f of ordered) {
  process.stdout.write(`  uploading ${f} … `);
  const res = spawnSync('scp', [...sshOpts, '-q', path.join(DIST, f), `${target}/${f}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  if (res.error) fail(`could not run scp (${res.error.message}). Is the OpenSSH client installed?`);
  if (res.status !== 0) fail(`scp exited ${res.status} on ${f}. Nothing after this point was uploaded.`);
  console.log('ok');
}

// --- verify ------------------------------------------------------------------

if (!feedUrl) {
  console.log('\n  Uploaded. No feed url configured, so skipping the readback check.\n');
  process.exit(0);
}

const channel = manifests.includes('latest.yml') ? 'latest' : manifests[0].replace('.yml', '');
try {
  const res = await fetch(`${feedUrl}/${channel}.yml`, { cache: 'no-store' });
  if (!res.ok) fail(`uploaded, but ${feedUrl}/${channel}.yml returned HTTP ${res.status}. Check the Caddy config.`);
  const served = (await res.text()).match(/^version:\s*(\S+)/m)?.[1];
  if (served !== version) {
    fail(`uploaded, but the feed still serves ${served}. Caching, or the wrong path on the server.`);
  }
  // Nobody can update to an installer they cannot fetch.
  const exe = installers[0];
  const head = await fetch(`${feedUrl}/${encodeURIComponent(exe)}`, { method: 'HEAD' });
  if (!head.ok) fail(`the feed serves ${version}, but "${exe}" returned HTTP ${head.status}.`);

  console.log(`\n  Published ${version}. Installed apps will pick it up on their next launch.\n`);
} catch (err) {
  if (err?.message?.startsWith('publish failed')) throw err;
  console.warn(`\n  Uploaded, but the readback check could not run: ${err.message}`);
  console.warn(`  Verify by hand:  curl ${feedUrl}/${channel}.yml\n`);
}
