/**
 * Measure how much every installed human SimObject actually moves.
 *
 * The scene builder has to pick people who stand still. It cannot tell from a
 * title: the 30West humans are all Mixamo clips with `typeparam="AutoPlay"`, so
 * they loop unconditionally and nothing SimConnect sends can stop them — and
 * one of them is a file called EveDancing. Picking by eye in the sim is slow and
 * easy to get wrong, so this reads the glTF animation data directly.
 *
 * For each model it reports:
 *   travel   peak spread of root translation, metres — does it walk about?
 *   rot span peak spread of joint rotation, degrees — does it flail?
 *
 * Past roughly 120 degrees a figure reads as "dancing" at the distance a pilot
 * sees it from. Feed the numbers back into the group table in main/scenes.ts.
 *
 *   node resources/_measure-human-motion.mjs [community-folder]
 *
 * With no argument it reads the sim's Community folder out of UserCfg.opt.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import path from 'path';

const COMPONENT = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COUNT = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function communityFromUserCfg() {
  const roots = [
    path.join(process.env.LOCALAPPDATA ?? '', 'Packages/Microsoft.Limitless_8wekyb3d8bbwe/LocalCache/UserCfg.opt'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Packages/Microsoft.FlightSimulator_8wekyb3d8bbwe/LocalCache/UserCfg.opt'),
    path.join(process.env.APPDATA ?? '', 'Microsoft Flight Simulator 2024/UserCfg.opt'),
  ];
  for (const f of roots) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(/InstalledPackagesPath\s+"([^"]+)"/i);
    if (m) {
      const c = path.join(m[1], 'Community');
      if (existsSync(c)) return c;
    }
  }
  return null;
}

/** Read one accessor out of the buffer as an array of tuples. */
function readAccessor(gltf, bin, index) {
  const a = gltf.accessors[index];
  const view = gltf.bufferViews[a.bufferView];
  const size = COMPONENT[a.componentType];
  const n = COUNT[a.type];
  const stride = view.byteStride || size * n;
  const base = (view.byteOffset || 0) + (a.byteOffset || 0);
  const out = [];
  for (let i = 0; i < a.count; i++) {
    const at = base + i * stride;
    const tuple = [];
    for (let c = 0; c < n; c++) {
      // every animation sampler we care about is float; anything else is skipped
      tuple.push(a.componentType === 5126 ? bin.readFloatLE(at + c * 4) : 0);
    }
    out.push(tuple);
  }
  return out;
}

/** Rotation magnitude of a quaternion, in degrees. */
function quatAngle(q) {
  const w = Math.max(-1, Math.min(1, q[3]));
  return (2 * Math.acos(Math.abs(w)) * 180) / Math.PI;
}

function measure(dir) {
  const gltfName = readdirSync(dir).find((f) => f.toLowerCase().endsWith('.gltf'));
  if (!gltfName) return null;
  const gltf = JSON.parse(readFileSync(path.join(dir, gltfName), 'utf8'));
  const anims = gltf.animations ?? [];
  if (!anims.length) return { clip: gltfName, joints: 0, secs: 0, travel: 0, rot: 0 };
  const bufUri = (gltf.buffers ?? []).find((b) => b.uri)?.uri;
  if (!bufUri) return null;
  const bin = readFileSync(path.join(dir, decodeURIComponent(bufUri)));

  let secs = 0;
  let travel = 0;
  let rot = 0;
  const joints = new Set();
  for (const an of anims) {
    for (const ch of an.channels) {
      const s = an.samplers[ch.sampler];
      joints.add(ch.target.node);
      const times = readAccessor(gltf, bin, s.input);
      if (times.length) secs = Math.max(secs, times[times.length - 1][0]);
      const vals = readAccessor(gltf, bin, s.output);
      if (!vals.length) continue;
      if (ch.target.path === 'translation') {
        for (let axis = 0; axis < 3; axis++) {
          const col = vals.map((v) => v[axis]);
          travel = Math.max(travel, Math.max(...col) - Math.min(...col));
        }
      } else if (ch.target.path === 'rotation') {
        const angs = vals.map(quatAngle);
        rot = Math.max(rot, Math.max(...angs) - Math.min(...angs));
      }
    }
  }
  return { clip: gltfName, joints: joints.size, secs, travel, rot };
}

function verdict(m) {
  if (!m.joints) return 'STATIC — safe anywhere';
  if (m.travel > 0.6) return 'LOCOMOTION — walks about';
  if (m.rot > 120) return 'LARGE MOTION — reads as dancing';
  if (m.rot > 60) return 'moderate — gesturing';
  return 'subtle idle — fine for a standing figure';
}

/** Paths that denote a person rather than a vehicle or a prop. */
const HUMAN = /human|civ\d|mother|grandpa|paramedic|worker|female_|pilot|casualt|medic|sam_|mac_|hhop|bald|dazed|dying|officer|cpr|eve/i;

const community = process.argv[2] ?? communityFromUserCfg();
if (!community || !existsSync(community)) {
  console.error('  Community folder not found. Pass it as an argument.');
  process.exit(1);
}
console.log(`  reading ${community}\n`);

/** every folder that looks like a SimObject model variant */
const rows = [];
function walk(dir, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  const isModel = path.basename(dir) === 'model' || path.basename(dir).startsWith('model.');
  if (isModel && entries.some((f) => f.toLowerCase().endsWith('.gltf'))) {
    // Only people. Without this the numbers are meaningless: an ambulance's
    // rotating beacon and a tractor's wheels both peg the rotation span at 180
    // degrees, and "reads as dancing" is not a sensible thing to say about a
    // wheel.
    if (HUMAN.test(path.relative(community, dir))) {
      const m = measure(dir);
      if (m) rows.push({ pack: path.relative(community, dir), ...m });
    }
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e);
    try {
      if (statSync(p).isDirectory()) walk(p, depth + 1);
    } catch {
      /* unreadable — skip */
    }
  }
}

// only the packages that actually carry people
for (const pack of readdirSync(community)) {
  if (!/human|hems|std-objects|h145/i.test(pack)) continue;
  walk(path.join(community, pack), 0);
}

rows.sort((a, b) => b.rot - a.rot);
console.log(`  ${'model'.padEnd(62)} ${'joints'.padStart(6)} ${'secs'.padStart(6)} ${'travel'.padStart(7)} ${'rot'.padStart(6)}  verdict`);
for (const r of rows) {
  const name = r.pack.length > 62 ? '…' + r.pack.slice(-61) : r.pack;
  console.log(
    `  ${name.padEnd(62)} ${String(r.joints).padStart(6)} ${r.secs.toFixed(1).padStart(6)} ` +
      `${r.travel.toFixed(2).padStart(7)} ${r.rot.toFixed(0).padStart(6)}  ${verdict(r)}`,
  );
}
console.log(`\n  ${rows.length} model(s) measured.`);
