// Void detection — pure, no DOM. Given raw RGBA pixels (exactly what
// CanvasRenderingContext2D.getImageData() hands back), measure how many rows of
// blank space sit at the top and bottom and how many columns sit at the left and
// right, then report the rectangle left over.
//
// This module is imported unchanged by the browser (public/app.js) and by the
// Node test suite (test/detect.test.mjs), so what's tested is what ships.
//
// Real screenshots are messier than they look, and the rules below exist because
// of specific failures on real phone screenshots — see README "Detection".

export const DEFAULTS = {
  // Max per-channel difference (0-255) still counted as "the same color".
  tolerance: 12,
  // Fraction of a line allowed to disagree with that line's own color before it
  // stops counting as blank. Letterbox bars from a compressed photo are full of
  // speckle; at 0.5% a bar with 0.3% speckle measured as ZERO blank pixels.
  noiseBudget: 0.02,
  // How many consecutive non-blank lines end the band. Scanning used to stop at
  // the FIRST failure, so one speckled row inside a 180px black bar killed the
  // whole measurement. Only sustained content ends a band now.
  grace: 18,
  // A jump this large in a line's own color starts a new block rather than
  // continuing the band. Below it the band is allowed to drift, which is what
  // lets a gradient background read as blank; above it a solid app header stays
  // safe from being swallowed.
  jump: 40,
};

// Tolerances tried by detectVoidsAuto(), lowest first.
const AUTO_TOLERANCES = [0, 4, 8, 16, 24, 32, 40, 48, 64, 80];

// A line (row or column) is described by a function i -> byte offset of pixel i
// in the RGBA array, plus how many pixels it holds.

// The line's own representative color, taken as a median rather than a specific
// pixel. Pixel 0 is a bad reference: on a noisy bar it is often itself a speckle,
// and then every other pixel "disagrees" with it and the line reads as content.
function lineColor(data, offsetAt, length) {
  if (length <= 0) return null;
  const step = Math.max(1, Math.floor(length / 128));
  const sample = [];
  for (let i = 0; i < length; i += step) {
    const o = offsetAt(i);
    // Sort by luma so the median is the perceptually middle pixel, not the
    // middle of one arbitrary channel.
    sample.push([o, data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114]);
  }
  if (!sample.length) return null;
  sample.sort((a, b) => a[1] - b[1]);
  const o = sample[sample.length >> 1][0];
  return { r: data[o], g: data[o + 1], b: data[o + 2], a: data[o + 3] };
}

// Does this pixel match the line color? A fully transparent reference is
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

// Is this line uniform in itself? Note this asks nothing about the band's color
// — only whether the line is all one shade. Comparing against a single color
// sampled once at the edge is what made gradient backgrounds ratchet forward a
// few pixels per tolerance step instead of being read as blank.
function flatColor(data, offsetAt, length, tolerance, noiseBudget) {
  const ref = lineColor(data, offsetAt, length);
  if (!ref) return null;
  const allowed = Math.floor(length * noiseBudget);
  let bad = 0;
  for (let i = 0; i < length; i++) {
    if (!pixelMatches(data, offsetAt(i), ref, tolerance)) {
      if (++bad > allowed) return null;
    }
  }
  return ref;
}

function colorDistance(a, b) {
  return Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b), Math.abs(a.a - b.a));
}

// The very last line of a void is often not void at all — it is a BLEND of the
// bar and the content beneath it, because the crop that produced the bar landed
// between pixels. Measured on a real photo, the final column was 22% white over
// 78% content, all the way down. That is far too contaminated to keep (it reads
// as a faint white line) but it is not remotely flat — the content shows
// through, so its spread is ~170 and no tolerance will ever make flatColor()
// accept it. It has to be recognised by its structure instead.
//
// The structure is exactly one equation: edge = a*void + (1-a)*inner. Solve it
// per channel against the line one step further in. A blend line gives a
// consistent a of ~0.2; an ordinary content line at the frame edge gives ~0.02.
// A 10x separation, so the threshold is not delicate.
const BLEED = {
  // Below this the wash is invisible anyway, and clean edges live at ~0.02.
  minAlpha: 0.1,
  // A wash is uniform, and this is the threshold that does the real work. Two
  // structurally different lines still produce some median `a` by coincidence
  // (a synthetic content boundary managed 0.28), but they disagree wildly about
  // it: measured spreads were 0.30 and 0.59 there, against 0.026-0.059 for the
  // four genuine blend edges in the reported batch. 0.15 sits well clear of
  // both — 2.5x the worst real blend, half the mildest false positive.
  maxSpread: 0.15,
  // A boundary is one or two pixels wide. This cap is what makes the rule
  // incapable of eating anything that matters.
  max: 2,
  // Channels already at the void colour cannot identify `a` (0/0), so they are
  // skipped rather than allowed to contribute noise.
  headroom: 25,
};

// Per-channel median of a line. lineColor() returns one PIXEL's colour (the
// median by luma), which is the right reference for "does this line match
// itself" but the wrong one for solving the blend equation: on a speckled bar
// that single pixel can carry an off channel — a real white bar sampled
// (255, 209, 255) — and a bogus channel wrecks the algebra for that channel
// alone, inflating the spread until a genuine blend edge gets rejected.
function lineMedianColor(data, offsetAt, length) {
  const step = Math.max(1, Math.floor(length / 128));
  const ch = [[], [], []];
  for (let i = 0; i < length; i += step) {
    const o = offsetAt(i);
    for (let c = 0; c < 3; c++) ch[c].push(data[o + c]);
  }
  if (!ch[0].length) return null;
  const mid = (a) => {
    a.sort((x, y) => x - y);
    return a[a.length >> 1];
  };
  return { r: mid(ch[0]), g: mid(ch[1]), b: mid(ch[2]) };
}

// Solve edge = a*void + (1-a)*inner per channel; report the median and spread
// of the solutions. Null when too few channels had headroom to be conclusive.
function blendAlpha(data, edgeAt, innerAt, length, ref) {
  const solved = [];
  const step = Math.max(1, Math.floor(length / 256));
  const voidCh = [ref.r, ref.g, ref.b];
  for (let i = 0; i < length; i += step) {
    const eo = edgeAt(i);
    const io = innerAt(i);
    // A blend of a transparent void is an alpha ramp, not a colour mix.
    if (ref.a === 0 || data[eo + 3] !== 255 || data[io + 3] !== 255) return null;
    for (let c = 0; c < 3; c++) {
      const denom = voidCh[c] - data[io + c];
      if (Math.abs(denom) < BLEED.headroom) continue;
      solved.push((data[eo + c] - data[io + c]) / denom);
    }
  }
  if (solved.length < 24) return null;
  solved.sort((a, b) => a - b);
  const at = (p) => solved[Math.min(solved.length - 1, Math.floor(solved.length * p))];
  return { median: at(0.5), spread: at(0.75) - at(0.25) };
}

// Walk inward from an edge counting blank lines.
//
// Two rules do the real work:
//   drift vs jump — the band's color may creep (a gradient stays blank) but a
//     sudden change means a new block, so a solid header under a status bar is
//     reported separately instead of being eaten.
//   grace window  — a line that fails does not end the band; only `grace`
//     consecutive failures do. Speckle in a compressed black bar is survivable.
function scanBand(data, lineAt, lineLength, start, step, limit, opts, wantNext = true) {
  const { tolerance, noiseBudget, grace, jump } = opts;
  if (limit <= 0 || lineLength <= 0) return { px: 0, ref: null, nextPx: 0 };

  let lastBlank = -1;
  let firstRef = null;
  let prevRef = null;
  let stoppedOnJump = false;

  for (let i = 0; i < limit; i++) {
    const ref = flatColor(data, lineAt(start + step * i), lineLength, tolerance, noiseBudget);
    if (ref && prevRef && colorDistance(ref, prevRef) > jump) {
      stoppedOnJump = true;
      break;
    }
    if (ref) {
      if (!firstRef) firstRef = ref;
      lastBlank = i;
      prevRef = ref;
    } else if (i - lastBlank > grace) {
      break;
    }
  }

  let px = lastBlank + 1;

  // Absorb the blend line(s) at the boundary. Gated on having actually found a
  // band, because `prevRef` IS the void colour — without a band there is no
  // reference to solve against and no reason to think the edge is contaminated.
  // Skipped after a jump: that means another solid block starts here, which is
  // the `nextPx` case below, not a soft boundary.
  if (!stoppedOnJump && px > 0 && prevRef) {
    // Solve against the last blank line's per-channel median, not prevRef —
    // see lineMedianColor(). Alpha is unchanged for a clean bar and far steadier
    // for a speckled one. Falls back to prevRef if the line can't be sampled.
    const voidRef = lineMedianColor(data, lineAt(start + step * (px - 1)), lineLength) ?? prevRef;
    for (let n = 0; n < BLEED.max && px + 1 < limit; n++) {
      const blend = blendAlpha(
        data,
        lineAt(start + step * px),
        lineAt(start + step * (px + 1)),
        lineLength,
        { ...voidRef, a: prevRef.a },
      );
      if (!blend || blend.median < BLEED.minAlpha || blend.spread > BLEED.maxSpread) break;
      px++;
    }
  }

  let nextPx = 0;
  // Only offer to extend when a color change is what stopped us — that is the
  // "there is another solid band right there" case. If content stopped the scan
  // there is nothing to extend into.
  // `wantNext` is false on the follow-on lookup so this recurses exactly one
  // level; a vertical-gradient image would otherwise recurse once per row.
  if (wantNext && stoppedOnJump && px > 0 && px < limit) {
    nextPx = scanBand(data, lineAt, lineLength, start + step * px, step, limit - px, opts, false).px;
  }
  return { px, ref: firstRef, nextPx };
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

// Are the corners blank while the edges are not? That is a straightened photo:
// the blank areas are triangles, so no full row or column is ever blank and
// there is no rectangle to trim. Worth saying out loud rather than showing four
// zeroes that read like a failure.
function looksRotated(data, width, height, opts) {
  const probe = Math.max(8, Math.round(Math.min(width, height) * 0.04));
  let blankCorners = 0;
  for (const [cx, cy] of [
    [0, 0],
    [width - probe, 0],
    [0, height - probe],
    [width - probe, height - probe],
  ]) {
    // A corner counts as blank when its whole probe square is one flat color.
    const flat = flatColor(
      data,
      (i) => ((cy + Math.floor(i / probe)) * width + cx + (i % probe)) * 4,
      probe * probe,
      opts.tolerance,
      opts.noiseBudget,
    );
    if (flat) blankCorners++;
  }
  return blankCorners >= 2;
}

/**
 * Measure the blank bands around the edges of an image at one tolerance.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} image
 *        RGBA pixels, as returned by getImageData().
 * @param {{tolerance?, noiseBudget?, grace?, jump?}} [options]
 * @returns {{width, height, top, bottom, left, right, sides, crop, blankImage, hasVoid, rotated}}
 */
export function detectVoids(image, options = {}) {
  const { data, width, height } = image;
  if (!width || !height) throw new Error("detectVoids: image has no dimensions");

  const opts = {
    tolerance: options.tolerance ?? DEFAULTS.tolerance,
    noiseBudget: options.noiseBudget ?? DEFAULTS.noiseBudget,
    grace: options.grace ?? DEFAULTS.grace,
    jump: options.jump ?? DEFAULTS.jump,
  };

  // Rows first. Each row spans the full width.
  const rowLine = (y) => (x) => (y * width + x) * 4;
  const topBand = scanBand(data, rowLine, width, 0, 1, height, opts);
  const top = topBand.px;
  const bottomBand = scanBand(data, rowLine, width, height - 1, -1, height - top, opts);
  const bottom = bottomBand.px;

  // Columns second, and only across the rows that survived the trim above.
  // Order matters: a black status bar at the top makes every column start with
  // black pixels, which would drag the left/right band colors off and either
  // hide a real side void or invent one.
  const innerHeight = height - top - bottom;
  const colLine = (x) => (i) => ((top + i) * width + x) * 4;
  const leftBand = scanBand(data, colLine, innerHeight, 0, 1, width, opts);
  const left = leftBand.px;
  const rightBand = scanBand(data, colLine, innerHeight, width - 1, -1, width - left, opts);
  const right = rightBand.px;

  const blankImage = top >= height || innerHeight <= 0 || left >= width;
  const hasVoid = top + bottom + left + right > 0;

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
    hasVoid,
    // Only interesting when we found nothing — otherwise there IS a rectangle.
    rotated: !hasVoid && !blankImage && looksRotated(data, width, height, opts),
    tolerance: opts.tolerance,
  };
}

// The longest run of near-identical values, and the value it settles on.
//
// A run is grown against its own first value, so every member sits within
// PLATEAU_SLACK of the anchor and the run really is "one answer, measured ten
// ways". The value reported is the run's MAXIMUM, not its anchor.
//
// That distinction is the whole point. A void does not end on a pixel boundary:
// JPEG and antialiasing leave the last column or two of a white bar dimmed
// (255 -> 248 -> 229 -> content). Those columns are still blank — uniform in
// themselves — they just need a higher tolerance to read as flat. So the sweep
// creeps 40, 40, 40, 41, 42, 42, 42 and the honest answer is 42. Reporting the
// anchor gave 40 and left a two-pixel white sliver on every photo with a soft
// edge, which is exactly what a real 58-image batch turned up.
//
// Taking the max is safe because it is bounded by construction: a member more
// than PLATEAU_SLACK above the anchor would have started a new run, so this can
// never exceed anchor + PLATEAU_SLACK. Tolerance that starts eating real content
// does not creep — it lunges (0 -> 206 on a smoothly-lit wall), which breaks the
// run and loses on length instead.
const PLATEAU_SLACK = 2;

function plateau(values) {
  let best = { length: 0, value: values[0] ?? 0, index: 0 };
  let i = 0;
  while (i < values.length) {
    let j = i;
    let max = values[i];
    // `index` must point at the run member that produced the reported value,
    // not at the run's start — detectVoidsAuto() reads that run's band color and
    // "+N px more" chip back out, and they have to describe the same edge.
    let maxIndex = i;
    while (j + 1 < values.length && Math.abs(values[j + 1] - values[i]) <= PLATEAU_SLACK) {
      j++;
      if (values[j] > max) {
        max = values[j];
        maxIndex = j;
      }
    }
    const length = j - i + 1;
    // >= keeps the LAST equally-long run: at equal evidence prefer the higher
    // tolerance, which is the one that got past the noise.
    if (length >= best.length) best = { length, value: max, index: maxIndex };
    i = j + 1;
  }
  return best;
}

/**
 * Measure without being told a tolerance.
 *
 * Sweeps tolerances and takes the plateau — the longest run of near-identical
 * answers. A real edge is a large discontinuity, so the measurement goes flat
 * across a wide band of tolerances once the noise floor is cleared; a
 * noise-limited measurement instead creeps upward with every step. Picking the
 * flat part is what makes the letterboxed-photo and gradient cases work without
 * anyone touching a strictness control.
 *
 * Each side is swept independently: a screenshot can have crisp black bars top
 * and bottom and a soft gradient at the sides.
 */
export function detectVoidsAuto(image, options = {}) {
  const runs = AUTO_TOLERANCES.map((tolerance) => detectVoids(image, { ...options, tolerance }));

  const chosen = {};
  for (const side of ["top", "bottom", "left", "right"]) {
    const best = plateau(runs.map((r) => r[side]));
    chosen[side] = best;
  }

  // Rebuild a full result from the per-side winners, taking each side's metadata
  // from the run that produced it so the reported color matches the number.
  const base = runs[runs.length - 1];
  const result = {
    width: base.width,
    height: base.height,
    sides: {},
    blankImage: runs.every((r) => r.blankImage),
    auto: true,
  };
  for (const side of ["top", "bottom", "left", "right"]) {
    const source = runs[chosen[side].index];
    result[side] = source[side];
    result.sides[side] = source.sides[side];
  }
  result.hasVoid = result.top + result.bottom + result.left + result.right > 0;
  result.crop = cropRect(
    { width: result.width, height: result.height },
    { top: result.top, bottom: result.bottom, left: result.left, right: result.right },
  );
  result.rotated = !result.hasVoid && !result.blankImage && runs.some((r) => r.rotated);
  return result;
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
