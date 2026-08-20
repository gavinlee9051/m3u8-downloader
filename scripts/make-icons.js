const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'icons');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4;
      const dst = y * (size * 4 + 1) + 1 + x * 4;
      raw[dst] = rgba[src];
      raw[dst + 1] = rgba[src + 1];
      raw[dst + 2] = rgba[src + 2];
      raw[dst + 3] = rgba[src + 3];
    }
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// Signed distance field to a rounded rectangle centered at origin
function sdRoundRect(x, y, w, h, r) {
  const qx = Math.abs(x) - (w / 2 - r);
  const qy = Math.abs(y) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function render(size, bgHex, ringHex, fgHex) {
  const px = Buffer.alloc(size * size * 4);
  const bg = hexToRgb(bgHex);
  const ring = hexToRgb(ringHex);
  const fg = hexToRgb(fgHex);
  const r = size * 0.24;
  const border = Math.max(1, Math.round(size * 0.06));

  const a = { x: -0.30 * size, y: 0.46 * size };
  const b = { x: 0.46 * size, y: 0 };
  const c = { x: -0.30 * size, y: -0.46 * size };

  function inTriangle(pxx, pyy) {
    const d1 = (pxx - b.x) * (a.y - b.y) - (a.x - b.x) * (pyy - b.y);
    const d2 = (pxx - c.x) * (b.y - c.y) - (b.x - c.x) * (pyy - c.y);
    const d3 = (pxx - a.x) * (c.y - a.y) - (c.x - a.x) * (pyy - a.y);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5 - size / 2;
      const cy = y + 0.5 - size / 2;
      const d = sdRoundRect(cx, cy, size - 4, size - 4, r);

      let col = bg;
      let alpha = 1;

      if (d > 0) {
        alpha = Math.max(0, Math.min(1, 1 - d));
        if (alpha <= 0) {
          px[(y * size + x) * 4 + 3] = 0;
          continue;
        }
      } else if (d > -border) {
        const t = -d / border;
        col = ring;
      }

      if (inTriangle(cx, cy)) {
        col = fg;
      }

      const i = (y * size + x) * 4;
      px[i] = Math.round(col[0]);
      px[i + 1] = Math.round(col[1]);
      px[i + 2] = Math.round(col[2]);
      px[i + 3] = Math.round(255 * alpha);
    }
  }
  return px;
}

fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const px = render(size, '#1a1b37', '#2962ff', '#ffffff');
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), encodePNG(size, px));
  console.log(`wrote icon${size}.png`);
}