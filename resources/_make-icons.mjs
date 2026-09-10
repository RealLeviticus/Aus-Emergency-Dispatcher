/**
 * Regenerates the Windows app icon and web logos from the master illustration.
 * Small sizes are emitted as 32-bit BMP (most reliable in Explorer / taskbar),
 * large sizes as PNG. Run: node resources/_make-icons.mjs [path-to-source.png]
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..');
const SRC = process.argv[2] || path.join(APP, '..', 'b7666909-2731-413d-af52-9d2982325e43.png');

const BMP_SIZES = [16, 20, 24, 32, 40, 48];
const PNG_SIZES = [64, 128, 256];

const master = sharp(readFileSync(SRC)).resize(512, 512, { fit: 'cover' });

async function rgba(size) {
  return master
    .clone()
    .resize(size, size, { fit: 'cover' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

/** 32-bit BGRA DIB (BITMAPINFOHEADER) with a zeroed 1-bpp AND mask, bottom-up. */
function bmpEntry({ data, info }) {
  const s = info.width;
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(s, 4);
  header.writeInt32LE(s * 2, 8); // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB
  header.writeUInt32LE(s * s * 4, 20);

  const xor = Buffer.alloc(s * s * 4);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const src = (y * s + x) * 4;
      const dst = ((s - 1 - y) * s + x) * 4;
      xor[dst] = data[src + 2]; // B
      xor[dst + 1] = data[src + 1]; // G
      xor[dst + 2] = data[src]; // R
      xor[dst + 3] = data[src + 3]; // A
    }
  }
  const andRow = (((s + 31) >> 5) << 2) | 0;
  const andMask = Buffer.alloc(andRow * s); // all zero => fully opaque
  return Buffer.concat([header, xor, andMask]);
}

function buildIco(entries) {
  const count = entries.length;
  const dir = Buffer.alloc(6 + 16 * count);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(count, 4);
  let offset = dir.length;
  const bodies = [];
  entries.forEach((e, i) => {
    const b = 6 + i * 16;
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b);
    dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1);
    dir.writeUInt8(0, b + 2);
    dir.writeUInt8(0, b + 3);
    dir.writeUInt16LE(1, b + 4);
    dir.writeUInt16LE(32, b + 6);
    dir.writeUInt32LE(e.data.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += e.data.length;
    bodies.push(e.data);
  });
  return Buffer.concat([dir, ...bodies]);
}

const entries = [];
for (const size of BMP_SIZES) entries.push({ size, data: bmpEntry(await rgba(size)) });
for (const size of PNG_SIZES) {
  entries.push({
    size,
    data: await master.clone().resize(size, size, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer(),
  });
}
writeFileSync(path.join(HERE, 'icon.ico'), buildIco(entries));
writeFileSync(path.join(HERE, 'icon.png'), await master.clone().png({ compressionLevel: 9 }).toBuffer());

const pub = path.join(APP, 'renderer', 'public');
writeFileSync(
  path.join(pub, 'logo.png'),
  await sharp(readFileSync(SRC)).resize(640, 640, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer(),
);
writeFileSync(
  path.join(pub, 'logo-mark.png'),
  await sharp(readFileSync(SRC)).resize(256, 256, { fit: 'cover' }).png({ compressionLevel: 9 }).toBuffer(),
);

console.log(
  `icon.ico: ${entries.map((e) => e.size).join('/')}  ·  wrote icon.png, renderer/public/logo.png, logo-mark.png`,
);
