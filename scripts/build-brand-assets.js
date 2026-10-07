/**
 * build-brand-assets.js
 * -------------------------------------------------------------------------
 * Produces the deployable PodVet logo set from the approved artwork in
 * `logo_extract/`.
 *
 * The sources are flat JPEGs (white sheet / navy sheet), so every asset is
 * built the same way:
 *   1. decode the master
 *   2. alpha  = smoothstep(distance from sheet background)   -> knocks out
 *               the sheet and keeps true anti-aliased edges
 *   3. colour = nearest approved brand ink                   -> guarantees the
 *               exact navy / teal / orange values, no JPEG mush
 *   4. crop   to the alpha bounding box, then pad to a sane canvas
 *
 * Brand inks (sampled from the masters):
 *   navy   #12385C
 *   teal   #21B8A5   (brightened to #3CDBC8 on the reversed sheet)
 *   orange #F97216
 *
 * Usage:  node scripts/build-brand-assets.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const jpeg = require('jpeg-js');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'logo_extract');
const OUT = path.join(ROOT, 'public', 'brand');

// ── brand palette ──────────────────────────────────────────────────────────
const INK = {
  navy:   [0x12, 0x38, 0x5c],
  teal:   [0x21, 0xb8, 0xa5],
  tealLt: [0x3c, 0xdb, 0xc8],
  orange: [0xf9, 0x72, 0x16],
  white:  [0xff, 0xff, 0xff],
  black:  [0x00, 0x00, 0x00],
};

// ── minimal PNG writer (8-bit RGBA, no interlace) ──────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── .ico writer (PNG-compressed entries) ───────────────────────────────────
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const dir = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const e = i * 16;
    dir[e] = img.size >= 256 ? 0 : img.size;
    dir[e + 1] = img.size >= 256 ? 0 : img.size;
    dir[e + 2] = 0;  // palette
    dir[e + 3] = 0;  // reserved
    dir.writeUInt16LE(1, e + 4);   // colour planes
    dir.writeUInt16LE(32, e + 6);  // bits per pixel
    dir.writeUInt32LE(img.data.length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += img.data.length;
  }
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

// ── imaging helpers ────────────────────────────────────────────────────────
const dist = (a, b) => {
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (t) => t * t * (3 - 2 * t);

/**
 * Extract a transparent RGBA logo from a flat-background master.
 * `inks` are the approved colours to snap to; `bg` is the sheet colour.
 */
function extract(file, { bg, inks, d0, d1, mono, inset = 0 }) {
  const img = jpeg.decode(fs.readFileSync(file), { useTArray: true, formatAsRGBA: true });
  const { width: w, height: h, data } = img;
  const rgba = Buffer.alloc(w * h * 4);

  for (let y = inset; y < h - inset; y++) {
    for (let x = inset; x < w - inset; x++) {
      const s = (y * w + x) * 4;
      const px = [data[s], data[s + 1], data[s + 2]];

      // alpha from distance to the sheet background
      const t = clamp((dist(px, bg) - d0) / (d1 - d0), 0, 1);
      const a = Math.round(smoothstep(t) * 255);
      if (a === 0) { rgba[s + 3] = 0; continue; }

      // snap to the nearest approved ink (single-colour sets collapse to one)
      const pool = mono ? mono : inks;
      let best = pool[0], bestD = Infinity;
      for (const ink of pool) {
        const d = dist(px, ink);
        if (d < bestD) { bestD = d; best = ink; }
      }
      rgba[s] = best[0];
      rgba[s + 1] = best[1];
      rgba[s + 2] = best[2];
      rgba[s + 3] = a;
    }
  }

  // Speckle pass: the sheets are JPEGs, so blocking noise leaves a faint haze
  // right across the background. Drop anything too weak to be a real edge so
  // the crop below stays tight.
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] < 34) { rgba[i + 3] = 0; rgba[i] = rgba[i + 1] = rgba[i + 2] = 0; }
  }
  return { w, h, rgba };
}

/** Tight crop on alpha, then centre onto a square or padded canvas. */
function crop(img, alphaMin = 40) {
  const { w, h, rgba } = img;
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] < alphaMin) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('empty extraction');
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    rgba.copy(out, y * cw * 4, ((y + minY) * w + minX) * 4, ((y + minY) * w + minX + cw) * 4);
  }
  return { w: cw, h: ch, rgba: out };
}
/** Draw `src` centred on a `size`x`size` transparent canvas (contain). */
function toSquare(src, size) {
  const scale = Math.min(size / src.w, size / src.h);
  const dw = Math.max(1, Math.round(src.w * scale));
  const dh = Math.max(1, Math.round(src.h * scale));
  const out = Buffer.alloc(size * size * 4);
  const ox = Math.floor((size - dw) / 2);
  const oy = Math.floor((size - dh) / 2);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.h - 1, Math.floor((y / dh) * src.h));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.w - 1, Math.floor((x / dw) * src.w));
      const s = (sy * src.w + sx) * 4;
      const a = src.rgba[s + 3];
      if (a === 0) continue;
      const d = ((y + oy) * size + (x + ox)) * 4;
      const inv = 255 - a;
      out[d] = Math.round((src.rgba[s] * a + out[d] * inv) / 255);
      out[d + 1] = Math.round((src.rgba[s + 1] * a + out[d + 1] * inv) / 255);
      out[d + 2] = Math.round((src.rgba[s + 2] * a + out[d + 2] * inv) / 255);
      out[d + 3] = Math.max(out[d + 3], a);
    }
  }
  return { w: size, h: size, rgba: out };
}

/** Add equal transparent padding (in output pixels) around a cropped logo. */
function pad(src, px) {
  const w = src.w + px * 2, h = src.h + px * 2;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < src.h; y++) {
    src.rgba.copy(out, ((y + px) * w + px) * 4, y * src.w * 4, (y + 1) * src.w * 4);
  }
  return { w, h, rgba: out };
}

/** ASCII preview so the keying result can be verified without eyeballing PNGs. */
function preview(src, cols = 74) {
  const rows = Math.max(1, Math.round((cols * src.h) / src.w / 2.1));
  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      let acc = 0, n = 0;
      const x0 = Math.floor((c * src.w) / cols), x1 = Math.max(Math.floor(((c + 1) * src.w) / cols), x0 + 1);
      const y0 = Math.floor((r * src.h) / rows), y1 = Math.max(Math.floor(((r + 1) * src.h) / rows), y0 + 1);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { acc += src.rgba[(y * src.w + x) * 4 + 3]; n++; }
      const a = n ? acc / n / 255 : 0;
      line += a > 0.75 ? '#' : a > 0.4 ? '+' : a > 0.12 ? '.' : ' ';
    }
    lines.push(line);
  }
  return lines;
}

function save(name, img) {
  fs.writeFileSync(path.join(OUT, name), encodePng(img.w, img.h, img.rgba));
  const pct = ((img.rgba.length / 4).toString());
  console.log(`  ${name.padEnd(26)} ${String(img.w).padStart(4)} x ${String(img.h).padStart(4)}  (${pct} px)`);
  return img;
}

// ── build ──────────────────────────────────────────────────────────────────
fs.mkdirSync(OUT, { recursive: true });
console.log('PodVet brand asset build');
console.log('  navy #12385C   teal #21B8A5   orange #F97216\n');

// masters -------------------------------------------------------------------
const master = path.join(SRC, 'logo_hd_2.jpg'); // full colour, horizontal
const revSrc = path.join(SRC, 'logo_hd_3.jpg');  // reversed (white), horizontal
const stackSrc = path.join(SRC, 'logo_hd_4.jpg');// full colour, stacked
const iconSrc = path.join(SRC, 'logo_hd_5.jpg'); // symbol only

const INKS_COLOR = [INK.navy, INK.teal, INK.orange];

console.log('full colour (white sheet):');
const primary = crop(extract(master, { bg: INK.white, inks: INKS_COLOR, d0: 22, d1: 105 }));
const stacked = crop(extract(stackSrc, { bg: INK.white, inks: INKS_COLOR, d0: 22, d1: 105 }));
const icon = crop(extract(iconSrc, { bg: INK.white, inks: INKS_COLOR, d0: 22, d1: 105 }));
console.log(`  primary bbox ${primary.w}x${primary.h}   stacked ${stacked.w}x${stacked.h}   icon ${icon.w}x${icon.h}`);

console.log('\nreversed (navy sheet):');
const INKS_REV = [INK.white, INK.tealLt, INK.orange];
// `inset` skips the 1px light keyline the navy sheet picked up on its top/left
// edges during export, which would otherwise read as full-opacity logo.
const reversed = crop(extract(revSrc, { bg: INK.navy, inks: INKS_REV, d0: 34, d1: 118, inset: 4 }));
console.log(`  reversed bbox ${reversed.w}x${reversed.h}`);

console.log('\nwriting assets:');
save('logo-primary.png', pad(primary, 6));
save('logo-reversed.png', pad(reversed, 6));
save('logo-stacked.png', pad(stacked, 4));
save('icon-primary.png', toSquare(icon, 256));
save('icon-reversed.png', toSquare(extract(iconSrc, { bg: INK.white, inks: INKS_COLOR, d0: 22, d1: 105, mono: [INK.white] }), 256));

// single-colour sets (re-use the primary silhouette)
console.log('\nsingle colour:');
save('logo-mono-black.png', pad(crop(extract(master, { bg: INK.white, inks: INKS_COLOR, d0: 22, d1: 105, mono: [INK.black] })), 6));
save('logo-mono-white.png', pad(crop(extract(master, { bg: INK.white, inks: INKS_COLOR, d0: 22, d1: 105, mono: [INK.white] })), 6));

// favicons
console.log('\nfavicons:');
save('favicon-32.png', toSquare(icon, 32));
save('favicon-180.png', toSquare(icon, 180));
const icoSizes = [16, 32, 48].map((size) => {
  const sq = toSquare(icon, size);
  return { size, data: encodePng(sq.w, sq.h, sq.rgba) };
});
fs.writeFileSync(path.join(OUT, 'favicon.ico'), encodeIco(icoSizes));
console.log('  favicon.ico                 16 / 32 / 48');

// ── verification ───────────────────────────────────────────────────────────
console.log('\nalpha-mask previews (keying sanity check):');
for (const [name, img] of [['logo-primary', primary], ['logo-reversed', reversed], ['logo-stacked', stacked], ['icon', icon]]) {
  console.log(`\n  -- ${name} (${img.w}x${img.h}) --`);
  for (const l of preview(img, name === 'icon' ? 46 : 74)) console.log('   |' + l + '|');
}
console.log('\ndone.');
