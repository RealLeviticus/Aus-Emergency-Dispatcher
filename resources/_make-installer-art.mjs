/**
 * Regenerates the NSIS wizard artwork from resources/icon.png.
 *
 * NSIS/MUI2 will only load Windows BMP, and sharp has no BMP encoder, so we
 * compose with sharp, pull raw RGB out, and write a 24-bit BI_RGB DIB here.
 * (Same trick as _make-icons.mjs, which hand-writes the .ico DIBs.)
 *
 * Sizes are fixed by MUI2 — a mismatched bitmap is silently drawn wrong:
 *   installerSidebar / uninstallerSidebar  164 x 314
 *   installerHeader                        150 x 57
 *
 * Run: node resources/_make-installer-art.mjs
 */
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOGO = path.join(HERE, 'icon.png');

const SIDEBAR = { w: 164, h: 314 };
const HEADER = { w: 150, h: 57 };

/** 24-bit BI_RGB BMP, bottom-up, rows padded to 4 bytes. */
function bmp24({ data, info }) {
  const { width: w, height: h } = info;
  const channels = info.channels;
  const rowRaw = w * 3;
  const rowPad = (rowRaw + 3) & ~3;
  const pixels = Buffer.alloc(rowPad * h); // padding stays zeroed
  for (let y = 0; y < h; y++) {
    const dstRow = (h - 1 - y) * rowPad; // bottom-up
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * channels;
      const d = dstRow + x * 3;
      pixels[d] = data[s + 2]; // B
      pixels[d + 1] = data[s + 1]; // G
      pixels[d + 2] = data[s]; // R
    }
  }
  const file = Buffer.alloc(14);
  const dib = Buffer.alloc(40);
  file.write('BM', 0, 'ascii');
  file.writeUInt32LE(14 + 40 + pixels.length, 2);
  file.writeUInt32LE(14 + 40, 10);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(w, 4);
  dib.writeInt32LE(h, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(24, 14);
  dib.writeUInt32LE(0, 16); // BI_RGB
  dib.writeUInt32LE(pixels.length, 20);
  dib.writeInt32LE(2835, 24); // 72 dpi
  dib.writeInt32LE(2835, 28);
  return Buffer.concat([file, dib, pixels]);
}

async function writeBmp(name, svg, { w, h }) {
  const raw = await sharp(Buffer.from(svg))
    .resize(w, h, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = path.join(HERE, name);
  writeFileSync(out, bmp24(raw));
  return `${name} ${w}x${h}`;
}

/** icon.png as a data URI so the SVG is self-contained (sharp resolves no hrefs). */
async function logoDataUri(size) {
  const png = await sharp(readFileSync(LOGO)).resize(size, size, { fit: 'cover' }).png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

const FONT = "Segoe UI, Tahoma, Arial, Helvetica, sans-serif";

/**
 * The sidebar has to read as ours even if librsvg can't find a font — the
 * beacon stripe, chevrons and logo carry the identity, the text is a bonus.
 */
function sidebarSvg({ logo, accentA, accentB, ground, title, subtitle, kicker }) {
  const chevrons = Array.from({ length: 9 }, (_, i) => {
    const x = -20 + i * 22;
    return `<path d="M${x} 314 l14 -22 l11 0 l-14 22 z" fill="#ffffff" opacity="0.05"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDEBAR.w}" height="${SIDEBAR.h}" viewBox="0 0 164 314">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0%" stop-color="${ground[0]}"/>
      <stop offset="55%" stop-color="${ground[1]}"/>
      <stop offset="100%" stop-color="${ground[2]}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.26" r="0.62">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="164" height="314" fill="url(#bg)"/>
  <rect width="164" height="314" fill="url(#glow)"/>
  ${chevrons}

  <!-- beacon bar down the left edge -->
  <rect x="0" y="0" width="5" height="157" fill="${accentA}"/>
  <rect x="0" y="157" width="5" height="157" fill="${accentB}"/>
  <rect x="5" y="0" width="1" height="314" fill="#ffffff" opacity="0.16"/>

  <!-- logo plate -->
  <rect x="40" y="40" width="88" height="88" fill="#000000" opacity="0.35"/>
  <image x="42" y="42" width="84" height="84" href="${logo}" preserveAspectRatio="xMidYMid slice"/>
  <rect x="41.5" y="41.5" width="85" height="85" fill="none" stroke="#ffffff" stroke-opacity="0.28"/>

  <text x="82" y="156" text-anchor="middle" font-family="${FONT}" font-size="8" letter-spacing="2.2"
        fill="#ffffff" fill-opacity="0.45">${kicker}</text>
  <rect x="46" y="166" width="72" height="1" fill="${accentA}" opacity="0.8"/>

  <text x="82" y="192" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="700"
        letter-spacing="0.4" fill="#ffffff">${title[0]}</text>
  <text x="82" y="209" text-anchor="middle" font-family="${FONT}" font-size="15" font-weight="700"
        letter-spacing="0.4" fill="#ffffff">${title[1]}</text>

  <text x="82" y="231" text-anchor="middle" font-family="${FONT}" font-size="9"
        fill="#ffffff" fill-opacity="0.5">${subtitle}</text>

  <text x="82" y="266" text-anchor="middle" font-family="${FONT}" font-size="8" letter-spacing="0.8"
        fill="#ffffff" fill-opacity="0.3">by ActuallyLeviticus</text>

  <!-- tape at the foot -->
  <rect x="0" y="296" width="164" height="18" fill="#000000" opacity="0.32"/>
  <text x="82" y="307.5" text-anchor="middle" font-family="${FONT}" font-size="6.5" letter-spacing="1"
        fill="#ffffff" fill-opacity="0.42">FOR MICROSOFT FLIGHT SIMULATOR</text>
</svg>`;
}

function headerSvg(logo) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${HEADER.w}" height="${HEADER.h}" viewBox="0 0 150 57">
  <rect width="150" height="57" fill="#ffffff"/>
  <rect x="96" y="6" width="46" height="46" fill="#16283a"/>
  <image x="97" y="7" width="44" height="44" href="${logo}" preserveAspectRatio="xMidYMid slice"/>
  <rect x="88" y="6" width="3" height="23" fill="#c0392b"/>
  <rect x="88" y="29" width="3" height="23" fill="#1f4e79"/>
</svg>`;
}

const logo84 = await logoDataUri(168);
const logo44 = await logoDataUri(88);

const wrote = [];
wrote.push(
  await writeBmp(
    'installerSidebar.bmp',
    sidebarSvg({
      logo: logo84,
      accentA: '#c0392b',
      accentB: '#1f4e79',
      ground: ['#22405c', '#16283a', '#0b1420'],
      kicker: 'S E T U P',
      title: ['AUS EMERGENCY', 'DISPATCHER'],
      subtitle: 'Live dispatch console for MSFS',
    }),
    SIDEBAR,
  ),
);
wrote.push(
  await writeBmp(
    'uninstallerSidebar.bmp',
    sidebarSvg({
      logo: logo84,
      accentA: '#6b6b6b',
      accentB: '#8a3b30',
      ground: ['#33383d', '#212528', '#131517'],
      kicker: 'U N I N S T A L L',
      title: ['AUS EMERGENCY', 'DISPATCHER'],
      subtitle: 'Remove the dispatch console',
    }),
    SIDEBAR,
  ),
);
wrote.push(await writeBmp('installerHeader.bmp', headerSvg(logo44), HEADER));

console.log(`installer art: ${wrote.join('  ·  ')}`);
