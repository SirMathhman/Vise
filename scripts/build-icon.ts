import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

/**
 * Render the logo (the same shapes as assets/icon.svg) to assets/icon.ico at
 * several sizes, with no dependencies: a small supersampling rasterizer, PNG
 * encoding with zlib, and the ICO container (PNG frames are valid since Vista).
 * Run with `bun scripts/build-icon.ts` after changing the shapes below or the SVG.
 */
const SIZES = [16, 32, 48, 64, 128, 256] as const;
const BACKGROUND = [0x1a, 0x1a, 0x2e] as const;
const FOREGROUND = [0x66, 0xcc, 0x99] as const;
const CORNER = 56; // rounded-square radius in the 256 design space
const V: readonly [number, number][] = [
  [56, 64],
  [98, 64],
  [128, 156],
  [158, 64],
  [200, 64],
  [150, 200],
  [106, 200],
];
const SAMPLES = 4; // per axis

function inRoundedSquare(x: number, y: number): boolean {
  const cx = Math.min(Math.max(x, CORNER), 256 - CORNER);
  const cy = Math.min(Math.max(y, CORNER), 256 - CORNER);
  return (x - cx) ** 2 + (y - cy) ** 2 <= CORNER ** 2;
}

function inPolygon(x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = V.length - 1; i < V.length; j = i++) {
    const [xi, yi] = V[i]!;
    const [xj, yj] = V[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** RGBA pixels of the logo at `size` px, antialiased by supersampling. */
function render(size: number): Buffer {
  const px = Buffer.alloc(size * size * 4);
  const scale = 256 / size;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let shape = 0;
      let glyph = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (pxl + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          if (!inRoundedSquare(x, y)) continue;
          shape++;
          if (inPolygon(x, y)) glyph++;
        }
      }
      const n = SAMPLES * SAMPLES;
      const o = (py * size + pxl) * 4;
      const mix = shape === 0 ? 0 : glyph / shape;
      for (let c = 0; c < 3; c++)
        px[o + c] = Math.round(BACKGROUND[c]! * (1 - mix) + FOREGROUND[c]! * mix);
      px[o + 3] = Math.round((shape / n) * 255);
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body));
  return Buffer.concat([head, body, tail]);
}

function png(size: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO: ICONDIR (6 bytes) + one 16-byte ICONDIRENTRY per image + the PNG data. */
function ico(frames: { size: number; data: Buffer }[]): Buffer {
  const head = Buffer.alloc(6 + frames.length * 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(frames.length, 4);
  let offset = head.length;
  frames.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    head[e] = size === 256 ? 0 : size; // 0 means 256
    head[e + 1] = size === 256 ? 0 : size;
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...frames.map((f) => f.data)]);
}

const frames = SIZES.map((size) => ({ size, data: png(size, render(size)) }));
const out = ico(frames);
writeFileSync("assets/icon.ico", out);
console.log(`assets/icon.ico (${out.length} bytes, ${SIZES.join("/")} px)`);
