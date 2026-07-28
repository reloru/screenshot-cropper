// Minimal PNG encoder/decoder for test fixtures. Node's zlib does the real
// work; this just wraps it in the PNG chunk format. Enough to write an 8-bit
// RGBA image and to read one back to check its dimensions — no dependency, and
// nothing here ships to the browser.

import { deflateSync, inflateSync } from "node:zlib";

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, body) {
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  body.copy(out, 8);
  const crcInput = Buffer.concat([Buffer.from(type, "ascii"), body]);
  out.writeUInt32BE(crc32(crcInput), body.length + 8);
  return out;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Encode RGBA bytes as a PNG buffer. */
export function encodePng({ data, width, height }) {
  // Filter type 0 (none) in front of every scanline.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const at = y * (width * 4 + 1);
    raw[at] = 0;
    Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.length).copy(
      raw,
      at + 1,
      y * width * 4,
      (y + 1) * width * 4,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Read back width/height (and the pixels) — used to verify cropped output. */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6) return { width, height, data: null };
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    off += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  const data = new Uint8ClampedArray(width * height * 4);
  // Undo the per-scanline filters. Encoders other than ours use all five.
  const prev = new Uint8Array(width * 4);
  const line = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    raw.copy(line, 0, y * stride + 1, y * stride + 1 + width * 4);
    for (let i = 0; i < line.length; i++) {
      const a = i >= 4 ? line[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      if (filter === 1) line[i] = (line[i] + a) & 255;
      else if (filter === 2) line[i] = (line[i] + b) & 255;
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    data.set(line, y * width * 4);
    prev.set(line);
  }
  return { width, height, data };
}

/**
 * Build a test image: a background band color with a distinct content
 * rectangle inset by the given amounts. This is the shape a real screenshot
 * void has — solid margins around live content.
 */
export function makeImage({
  width,
  height,
  top = 0,
  bottom = 0,
  left = 0,
  right = 0,
  band = [0, 0, 0, 255],
  content = [200, 40, 60, 255],
  contentPattern = true,
}) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inside = y >= top && y < height - bottom && x >= left && x < width - right;
      let px = inside ? content : band;
      // Vary the content so it can never be mistaken for a uniform band.
      if (inside && contentPattern && (x + y) % 3 === 0) {
        px = [content[0], (content[1] + 90) % 256, (content[2] + 140) % 256, content[3]];
      }
      data[o] = px[0];
      data[o + 1] = px[1];
      data[o + 2] = px[2];
      data[o + 3] = px[3];
    }
  }
  return { data, width, height };
}

/** Overwrite one pixel — for noise-budget tests. */
export function setPixel(img, x, y, rgba) {
  const o = (y * img.width + x) * 4;
  img.data[o] = rgba[0];
  img.data[o + 1] = rgba[1];
  img.data[o + 2] = rgba[2];
  img.data[o + 3] = rgba[3];
  return img;
}
