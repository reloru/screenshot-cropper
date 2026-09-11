// Decode any image a phone produces into the raw RGBA the detectors want.
//
// This exists because measuring a REAL failure was, for a long time, the one
// thing that could not be done here. Every fix in detect.js up to this point
// was built against synthetic fixtures reconstructed from a description, and
// twice that produced a "fix" for a mechanism that turned out not to be the
// real one — once shipping a regression. A file straight off a phone closes
// that loop.
//
// Three decoders, because no single one covers the set:
//
//   PNG    — scripts/png.mjs, already here, no browser and no dependency.
//   HEIC   — libheif-js. iOS shares photos as HEIC and nothing else in the
//            toolchain reads it: no ImageMagick, no ffmpeg, no vips, and
//            Chromium on Linux does not decode it either.
//   rest   — Chromium, via createImageBitmap + canvas. JPEG, WebP, AVIF and
//            anything else the browser knows. Worth preferring for these
//            precisely BECAUSE it is the same path public/pipeline.js takes,
//            so what gets measured here is what the app would have measured.
//
// Chromium is slow to start, so decodeAll() launches it once for the whole
// batch and not at all when nothing needs it.
//
//   import { decodeAll } from "./decode.mjs";
//   const images = await decodeAll(["a.heic", "b.webp"]);   // [{data,width,height,file}]
//
// As a CLI, converts to PNG so the results can be looked at:
//   node scripts/decode.mjs debug-images/* --out /tmp/png

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { createRequire } from "node:module";

import { decodePng, encodePng } from "./png.mjs";

const require = createRequire(import.meta.url);

const HEIC = new Set([".heic", ".heif"]);
const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

/** Playwright lives outside the project in this environment, as in test-e2e.mjs. */
function playwright() {
  try {
    return require("playwright");
  } catch {
    return require("/opt/node22/lib/node_modules/playwright");
  }
}

function decodeHeic(file) {
  const libheif = require("libheif-js");
  const images = new libheif.HeifDecoder().decode(readFileSync(file));
  if (!images.length) throw new Error("no image in HEIC container");
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  const data = new Uint8ClampedArray(width * height * 4);
  // display() is callback-style and fills the buffer in place.
  return new Promise((resolve, reject) =>
    image.display({ data, width, height }, (ok) =>
      ok ? resolve({ data, width, height }) : reject(new Error("HEIC display failed")),
    ),
  );
}

/**
 * Decode a list of files to `{data, width, height, file}`, newest formats and
 * all. Anything that fails comes back as `{file, error}` rather than throwing,
 * so one unreadable file in a batch does not lose the rest of the measurements.
 */
export async function decodeAll(files) {
  const out = [];
  const viaBrowser = [];

  for (const file of files) {
    const ext = extname(file).toLowerCase();
    try {
      if (ext === ".png") out.push({ file, ...decodePng(readFileSync(file)) });
      else if (HEIC.has(ext)) out.push({ file, ...(await decodeHeic(file)) });
      else if (MIME[ext]) viaBrowser.push(file);
      else out.push({ file, error: `unsupported extension ${ext || "(none)"}` });
    } catch (e) {
      out.push({ file, error: e.message });
    }
  }

  if (viaBrowser.length) {
    const { chromium } = playwright();
    const browser = await chromium.launch({
      executablePath: process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium",
    });
    try {
      const page = await browser.newPage();
      for (const file of viaBrowser) {
        try {
          const b64 = readFileSync(file).toString("base64");
          const mime = MIME[extname(file).toLowerCase()];
          const r = await page.evaluate(
            async ([b64, mime]) => {
              const blob = await (await fetch(`data:${mime};base64,${b64}`)).blob();
              const bmp = await createImageBitmap(blob);
              const canvas = new OffscreenCanvas(bmp.width, bmp.height);
              const ctx = canvas.getContext("2d", { willReadFrequently: true });
              ctx.drawImage(bmp, 0, 0);
              const d = ctx.getImageData(0, 0, bmp.width, bmp.height);
              // Structured clone cannot carry a Uint8ClampedArray out of the
              // page, so it crosses as a plain array and is rewrapped below.
              return { width: bmp.width, height: bmp.height, data: Array.from(d.data) };
            },
            [b64, mime],
          );
          out.push({ file, width: r.width, height: r.height, data: new Uint8ClampedArray(r.data) });
        } catch (e) {
          out.push({ file, error: e.message });
        }
      }
    } finally {
      await browser.close();
    }
  }

  // Restore the caller's order; the browser batch was decoded out of sequence.
  const byFile = new Map(out.map((r) => [r.file, r]));
  return files.map((f) => byFile.get(f));
}

/** One file. Convenience around decodeAll for callers with a single image. */
export async function decode(file) {
  const [r] = await decodeAll([file]);
  if (r.error) throw new Error(`${file}: ${r.error}`);
  return r;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("--out");
  const dir = outAt >= 0 ? args[outAt + 1] : null;
  // `outAt + 1` is 0 when --out is absent, which would silently swallow the
  // first file. Compare against the flag's value instead of its index.
  const files = args.filter((a, i) => !a.startsWith("--") && !(outAt >= 0 && i === outAt + 1));
  if (!files.length) {
    console.error("usage: node scripts/decode.mjs <files...> [--out <dir>]");
    process.exit(1);
  }
  if (dir) mkdirSync(dir, { recursive: true });
  for (const r of await decodeAll(files)) {
    if (r.error) {
      console.log(`${basename(r.file).padEnd(24)} FAILED: ${r.error}`);
      continue;
    }
    let note = "";
    if (dir) {
      const to = join(dir, basename(r.file, extname(r.file)) + ".png");
      writeFileSync(to, encodePng(r));
      note = ` -> ${to}`;
    }
    console.log(`${basename(r.file).padEnd(24)} ${r.width}x${r.height}${note}`);
  }
}
