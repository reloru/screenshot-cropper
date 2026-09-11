// Point the detectors at real files and see what they do.
//
//   node scripts/inspect.mjs debug-images/*
//   node scripts/inspect.mjs shot.heic --map
//   node scripts/inspect.mjs shot.heic --overlay /tmp/look
//
// Every number the app shows comes from detect.js, so running it here gives
// exactly what the app would report for the same file — which is the point.
// When a screenshot of the app says "Top 208 px" and this says 208, the
// reproduction is faithful and a fix can be verified without a phone.
//
//   --map        a coarse text picture of where the busy pixels are. Cheap to
//                read, and enough to tell "the photo is centred with a wide
//                margin" from "the photo runs to the top edge" without opening
//                the image — which is how the longhorn's diagonal-gradient
//                background got identified.
//   --overlay    writes a PNG per input with the kept rectangle outlined and
//                the trimmed bands shaded, the same way the app previews it.
//                For seeing an over-crop, this beats staring at numbers.
//   --mode       restrict to void | chrome | both (default: all three).

import { writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";

import { decodeAll } from "./decode.mjs";
import { encodePng } from "./png.mjs";
import { detectVoidsAuto, detectChrome, detectChromeThenEdges } from "../public/detect.js";

const MODES = {
  void: ["blank edges (auto)", (img) => detectVoidsAuto(img)],
  chrome: ["app interface", (img) => detectChrome(img)],
  both: ["interface + edges", (img) => detectChromeThenEdges(img)],
};

/**
 * A coarse map of local variation. '#' is busy, '.' is smooth, ' ' is flat.
 * Measured as the mean absolute difference between neighbouring pixels, which
 * is the same question `evenness` asks in detect.js — so a region that reads as
 * blank here is a region the detectors are liable to call interface.
 */
function contentMap(img, cols = 56, rows = 26) {
  const { data, width, height } = img;
  let out = "";
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * height) / rows);
    const y1 = Math.floor(((r + 1) * height) / rows);
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * width) / cols);
      const x1 = Math.floor(((c + 1) * width) / cols);
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 2) {
        for (let x = x0 + 1; x < x1; x += 2) {
          const o = (y * width + x) * 4;
          const p = o - 4;
          sum += Math.abs(data[o] - data[p]) + Math.abs(data[o + 1] - data[p + 1]) + Math.abs(data[o + 2] - data[p + 2]);
          n++;
        }
      }
      const v = n ? sum / n : 0;
      out += v > 12 ? "#" : v > 3 ? "." : " ";
    }
    out += "\n";
  }
  return out;
}

/** The app's preview, as a file: kept area clear, trimmed bands shaded red. */
function overlay(img, crop, maxSide = 900) {
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const x0 = Math.round(crop.x * scale);
  const y0 = Math.round(crop.y * scale);
  const x1 = Math.round((crop.x + crop.width) * scale);
  const y1 = Math.round((crop.y + crop.height) * scale);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor(y / scale));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / scale));
      const s = (sy * img.width + sx) * 4;
      const d = (y * w + x) * 4;
      const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
      const onEdge = inside && (x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1);
      if (onEdge) {
        out[d] = 255;
        out[d + 1] = 40;
        out[d + 2] = 60;
      } else {
        // Trimmed pixels keep their colour but take a red wash, so you can see
        // WHAT is being thrown away rather than just how much.
        const mix = inside ? 0 : 0.55;
        out[d] = Math.round(img.data[s] * (1 - mix) + 200 * mix);
        out[d + 1] = Math.round(img.data[s + 1] * (1 - mix) + 30 * mix);
        out[d + 2] = Math.round(img.data[s + 2] * (1 - mix) + 50 * mix);
      }
      out[d + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? null : args[i + 1];
};
const has = (name) => args.includes(name);
const overlayDir = flag("--overlay");
const only = flag("--mode");
const consumed = new Set([overlayDir, only]);
const files = args.filter((a) => !a.startsWith("--") && !consumed.has(a));

if (!files.length) {
  console.error("usage: node scripts/inspect.mjs <files...> [--map] [--overlay <dir>] [--mode void|chrome|both]");
  process.exit(1);
}
if (overlayDir) mkdirSync(overlayDir, { recursive: true });

const chosen = only ? { [only]: MODES[only] } : MODES;
if (only && !MODES[only]) {
  console.error(`unknown mode "${only}" — expected void, chrome or both`);
  process.exit(1);
}

for (const img of await decodeAll(files)) {
  const name = basename(img.file);
  if (img.error) {
    console.log(`\n${name}  FAILED: ${img.error}`);
    continue;
  }
  console.log(`\n${name}  (${img.width}x${img.height})`);
  console.log("                           top  bottom    left   right");
  for (const [key, [label, run]] of Object.entries(chosen)) {
    const r = run(img);
    const n = (v) => String(v).padStart(6);
    const flags = [
      !r.hasVoid ? "found nothing" : null,
      r.allChrome ? "allChrome" : null,
      r.rotated ? "rotated" : null,
      r.blankImage ? "blankImage" : null,
    ].filter(Boolean);
    console.log(
      `  ${label.padEnd(20)} ${n(r.top)}  ${n(r.bottom)}  ${n(r.left)}  ${n(r.right)}` +
        `   -> ${r.crop.width}x${r.crop.height}${flags.length ? "  [" + flags.join(", ") + "]" : ""}`,
    );
    if (overlayDir) {
      const to = join(overlayDir, `${basename(img.file, extname(img.file))}.${key}.png`);
      writeFileSync(to, encodePng(overlay(img, r.crop)));
    }
  }
  if (has("--map")) console.log("\n" + contentMap(img));
}
if (overlayDir) console.log(`\noverlays written to ${overlayDir}`);
