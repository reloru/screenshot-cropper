// Void detection — pure, no DOM. Given raw RGBA pixels (exactly what
// CanvasRenderingContext2D.getImageData() hands back), measure how many rows of
// blank space sit at the top and bottom and how many columns sit at the left and
// right, then report the rectangle left over.
//
// This module is imported unchanged by the browser (public/app.js) and by the
// Node test suite (test/detect.test.mjs), so what's tested is what ships.

export const DEFAULTS = {
  // Max per-channel difference (0-255) still counted as "the same color".
  // 0 = exact match; 8 absorbs PNG-to-JPEG-and-back drift; 24 tolerates a
  // gently shaded background.
  tolerance: 8,
  // Fraction of a line allowed to disagree with the band color before the line
  // stops counting as blank. Without this, one stray antialiased pixel in a
  // 1290px row would report a 0px void.
  noiseBudget: 0.005,
};

// A line (row or column) is described by a function i -> byte offset of pixel i
// in the RGBA array, plus how many pixels it holds.

// The band's reference color: the most common color on the outermost line.
// Sampled rather than counted exhaustively — a band color is dominant by
// definition, so ~512 samples find it and a 4K-wide row costs the same as a
// phone-width one.
function modalColor(data, offsetAt, length) {
  if (length <= 0) return null;
  const counts = new Map();
  const step = Math.max(1, Math.floor(length / 512));
  let bestKey = -1;
  let bestCount = 0;
  for (let i = 0; i < length; i += step) {
    const o = offsetAt(i);
    // Pack RGBA into one number (< 2^32) so the Map keys stay primitives.
    const key = data[o] * 16777216 + data[o + 1] * 65536 + data[o + 2] * 256 + data[o + 3];
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n > bestCount) {
      bestCount = n;
      bestKey = key;
    }
  }
  if (bestKey < 0) return null;
  // Recover the channels from the packed key rather than re-reading a pixel,
  // since the modal pixel isn't necessarily pixel 0.
  return {
    r: Math.floor(bestKey / 16777216) % 256,
    g: Math.floor(bestKey / 65536) % 256,
    b: Math.floor(bestKey / 256) % 256,
    a: bestKey % 256,
  };
}

// Does this pixel match the band color? A fully transparent reference is
// compared on alpha alone: RGB under alpha 0 is meaningless (canvas stores it
// premultiplied, so it reads back as 0,0,0) and would otherwise fail the RGB
// test against any other transparent pixel that started life a different color.
function pixelMatches(data, o, ref, tolerance) {
  if (Math.abs(data[o + 3] - ref.a) > tolerance) return false;
  if (ref.a === 0) return true;
  return (
    Math.abs(data[o] - ref.r) <= tolerance &&
    Math.abs(data[o + 1] - ref.g) <= tolerance &&
    Math.abs(data[o + 2] - ref.b) <= tolerance
  );
}

function lineIsUniform(data, offsetAt, length, ref, tolerance, noiseBudget) {
  const allowed = Math.floor(length * noiseBudget);
  let bad = 0;
  for (let i = 0; i < length; i++) {
    if (!pixelMatches(data, offsetAt(i), ref, tolerance)) {
      if (++bad > allowed) return false;
    }
  }
  return true;
}

// Count consecutive uniform lines starting at `start` and stepping by `step`
// (+1 inward from the top/left edge, -1 inward from the bottom/right), up to
// `limit` lines. `lineAt(index)` returns that line's offset function.
//
// Scanning stops at the first color change, so a black bar followed by a white
// bar reports only the black one. That's deliberate: a solid-colored app header
// sitting under a status bar must not be silently swallowed. The follow-on band
// is reported separately as `nextPx` so the UI can offer to extend.
// `wantNext` is false on the follow-on lookup so this recurses exactly one
// level. Unbounded recursion would be a real hazard: in a vertical-gradient
// wallpaper every single row is its own uniform band, which would otherwise
// recurse once per row of image height.
function scanBand(data, lineAt, lineLength, start, step, limit, tolerance, noiseBudget, wantNext = true) {
  if (limit <= 0 || lineLength <= 0) return { px: 0, ref: null, nextPx: 0 };
  const ref = modalColor(data, lineAt(start), lineLength);
  if (!ref) return { px: 0, ref: null, nextPx: 0 };
  let px = 0;
  while (px < limit && lineIsUniform(data, lineAt(start + step * px), lineLength, ref, tolerance, noiseBudget)) {
    px++;
  }
  let nextPx = 0;
  if (wantNext && px > 0 && px < limit) {
    nextPx = scanBand(data, lineAt, lineLength, start + step * px, step, limit - px, tolerance, noiseBudget, false).px;
  }
  return { px, ref, nextPx };
}

function hexOf(ref) {
  if (!ref) return null;
  const h = (n) => n.toString(16).padStart(2, "0");
  return `#${h(ref.r)}${h(ref.g)}${h(ref.b)}`.toUpperCase();
}

// Plain-language name for the common cases only. Anything with real hue gets
// null and the UI shows the swatch plus hex instead of inventing a name.
export function colorName(ref) {
  if (!ref) return null;
  if (ref.a === 0) return "transparent";
  const max = Math.max(ref.r, ref.g, ref.b);
  const min = Math.min(ref.r, ref.g, ref.b);
  if (max - min > 12) return null;
  if (max < 16) return "black";
  if (min > 239) return "white";
  if (min > 200) return "off-white";
  if (max < 64) return "near-black";
  return "gray";
}

function sideInfo(band, total) {
  return {
    px: band.px,
    pct: total > 0 ? Math.round((band.px / total) * 1000) / 10 : 0,
    hex: band.px > 0 ? hexOf(band.ref) : null,
    alpha: band.px > 0 && band.ref ? band.ref.a : null,
    name: band.px > 0 ? colorName(band.ref) : null,
    nextPx: band.nextPx,
  };
}

/**
 * Measure the blank bands around the edges of an image.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} image
 *        RGBA pixels, as returned by getImageData().
 * @param {{tolerance?: number, noiseBudget?: number}} [options]
 * @returns {{width, height, top, bottom, left, right, sides, crop, blankImage, hasVoid}}
 */
export function detectVoids(image, options = {}) {
  const { data, width, height } = image;
  const tolerance = options.tolerance ?? DEFAULTS.tolerance;
  const noiseBudget = options.noiseBudget ?? DEFAULTS.noiseBudget;

  if (!width || !height) {
    throw new Error("detectVoids: image has no dimensions");
  }

  // Rows first. Each row spans the full width.
  const rowLine = (y) => (x) => (y * width + x) * 4;
  const topBand = scanBand(data, rowLine, width, 0, 1, height, tolerance, noiseBudget);
  const top = topBand.px;
  const bottomBand = scanBand(data, rowLine, width, height - 1, -1, height - top, tolerance, noiseBudget);
  const bottom = bottomBand.px;

  // Columns second, and only across the rows that survived the trim above.
  // Order matters: a black status bar at the top makes every column start with
  // black pixels, which would drag the left/right band colors off and either
  // hide a real side void or invent one.
  const innerTop = top;
  const innerHeight = height - top - bottom;
  const colLine = (x) => (i) => ((innerTop + i) * width + x) * 4;
  const leftBand = scanBand(data, colLine, innerHeight, 0, 1, width, tolerance, noiseBudget);
  const left = leftBand.px;
  const rightBand = scanBand(data, colLine, innerHeight, width - 1, -1, width - left, tolerance, noiseBudget);
  const right = rightBand.px;

  // Nothing but blank: every row matched, or every surviving column did. Report
  // it rather than handing back a zero-pixel crop.
  const blankImage = top >= height || innerHeight <= 0 || left >= width;

  return {
    width,
    height,
    top,
    bottom,
    left,
    right,
    sides: {
      top: sideInfo(topBand, height),
      bottom: sideInfo(bottomBand, height),
      left: sideInfo(leftBand, width),
      right: sideInfo(rightBand, width),
    },
    crop: cropRect({ width, height }, { top, bottom, left, right }),
    blankImage,
    hasVoid: top + bottom + left + right > 0,
  };
}

/**
 * Turn four trim amounts into a crop rectangle, clamped so the result is always
 * at least 1x1 and always inside the image. Used for the auto-detected values
 * and for whatever the user types into the manual overrides.
 */
export function cropRect(image, sides) {
  const { width, height } = image;
  const clamp = (n, max) => Math.max(0, Math.min(Math.round(Number(n) || 0), max));
  let top = clamp(sides.top, height - 1);
  let bottom = clamp(sides.bottom, height - 1);
  let left = clamp(sides.left, width - 1);
  let right = clamp(sides.right, width - 1);
  if (top + bottom > height - 1) bottom = Math.max(0, height - 1 - top);
  if (left + right > width - 1) right = Math.max(0, width - 1 - left);
  return {
    x: left,
    y: top,
    width: width - left - right,
    height: height - top - bottom,
  };
}
