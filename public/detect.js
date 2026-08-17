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
 * @param {{tolerance?, noiseBudget?, grace?, jump?, window?}} [options]
 *        `window` restricts the scan to a sub-rectangle `{x, y, width, height}`
 *        of the same buffer, with no copy: every line address is already built
 *        through a closure, so windowing only changes the arithmetic inside it.
 *        detectChrome() uses this to re-measure inside its own crop.
 * @returns {{width, height, top, bottom, left, right, sides, crop, blankImage, hasVoid, rotated}}
 */
export function detectVoids(image, options = {}) {
  const { data } = image;
  if (!image.width || !image.height) throw new Error("detectVoids: image has no dimensions");

  // `stride` is how many pixels a row of the underlying buffer holds, which is
  // the full image width even when only a window of it is being scanned.
  const stride = image.width;
  const win = options.window;
  const width = win ? win.width : image.width;
  const height = win ? win.height : image.height;
  const ox = win ? win.x : 0;
  const oy = win ? win.y : 0;
  if (width <= 0 || height <= 0) throw new Error("detectVoids: window has no area");

  const opts = {
    tolerance: options.tolerance ?? DEFAULTS.tolerance,
    noiseBudget: options.noiseBudget ?? DEFAULTS.noiseBudget,
    grace: options.grace ?? DEFAULTS.grace,
    jump: options.jump ?? DEFAULTS.jump,
  };

  // Rows first. Each row spans the full width.
  const rowLine = (y) => (x) => ((oy + y) * stride + ox + x) * 4;
  const topBand = scanBand(data, rowLine, width, 0, 1, height, opts);
  const top = topBand.px;
  const bottomBand = scanBand(data, rowLine, width, height - 1, -1, height - top, opts);
  const bottom = bottomBand.px;

  // Columns second, and only across the rows that survived the trim above.
  // Order matters: a black status bar at the top makes every column start with
  // black pixels, which would drag the left/right band colors off and either
  // hide a real side void or invent one.
  const innerHeight = height - top - bottom;
  const colLine = (x) => (i) => ((oy + top + i) * stride + ox + x) * 4;
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
    // Skipped under a window: this probes the four corners of a whole image to
    // recognise a straightened photo, which is not a question a sub-rectangle
    // can answer, and its addressing assumes stride === width.
    rotated: !win && !hasVoid && !blankImage && looksRotated(data, width, height, opts),
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

// ==========================================================================
// App chrome — the bands that are NOT voids.
//
// A feed screenshot has no blank edge at all. Above the picture sits a status
// bar, a nav bar, a username, a caption; below it a row of icons, a date, and
// usually the top of the NEXT post. None of it is blank, so everything above
// reports four zeroes, and the second screenshot in the pair that prompted this
// even came back "straightened photo" because its corners happened to be flat.
//
// What those bands are instead is a flat interface colour with writing on it.
// That is the whole idea here: measure how much of each line is one single
// colour, and how much of it is ink sitting on that colour.
//
//   a picture line   — no colour owns it            (coverage 0.03-0.48 measured)
//   a chrome line    — one colour owns nearly it all (coverage 0.65-1.00)
//
// The bands then get read as blocks rather than scanned inward from the edge,
// because the thing worth keeping is in the MIDDLE. Trimming from the edges can
// only ever remove the interface above the photo; it can do nothing about the
// next post showing at the bottom, which is content by any measure and still
// wants to go. So: classify every row, take the largest run of picture, and
// report the interface either side of it as the trim.
// ==========================================================================

export const CHROME_DEFAULTS = {
  // How close to a line's dominant colour still counts as that colour. Tighter
  // than the void tolerance on purpose — an interface background is a rendered
  // constant (#0C0F14 held to +/-3 over 400 rows here), not a photographed one.
  tolerance: 10,
  // Fraction of a line owned by that one colour before the line reads as
  // interface. Measured on the pair of Instagram screenshots this was built
  // from: picture rows peaked at 0.48 (a meme's white caption text) and chrome
  // rows bottomed out at 0.65, so the gap is wide and 0.7 sits inside it.
  coverage: 0.7,
  // Share of the line's own-colour pixels that are EXACTLY equal to the pixel
  // before them. THIS IS THE GUARD THAT MATTERS, and coverage alone is
  // dangerous without it: a dim photograph is flat by the coverage measure —
  // the dark half of a bar photo held 0.9 of its rows within 10 of one value —
  // so "crop to the largest run of picture" ate 374px off the top of the
  // picture it was supposed to be keeping. A rendered background is one value
  // repeated, so consecutive pixels are identical (0.97-1.00 measured across
  // every genuine band). A photographed one carries sensor noise at every
  // pixel and scores 0.05-0.30 no matter how dim and smooth it looks.
  evenness: 0.65,
  // A pixel this far from the dominant colour is "ink" — text, an icon, an
  // avatar. Deliberately a big number: ink is high-contrast by design, because
  // it exists to be read.
  contrast: 60,
  // Ink covering this much of a line makes it an inked line. 0.5% of 1290px is
  // ~6 pixels, which is a glyph or two.
  inkRow: 0.005,
  // How many inked lines a band needs before the whole band counts as
  // interface. An absolute count, not a fraction: interface is mostly EMPTY.
  // The band above the photo in a Facebook post is 700px of plain black
  // padding with one 60px row of icons in it, and asking for ink across a
  // fraction of the band scored that 0.09 and reported "no interface" over an
  // obvious app header. What matters is that writing is present, not how much
  // of the band it fills — so the padding rides along with the row that
  // identifies it.
  bandInk: 8,
  // How close a blank band's colour has to be to a colour the interface uses
  // before the band counts as app background too. See bandTrim(). Looser than
  // `tolerance` because it answers a coarser question — not "is this pixel part
  // of this line's colour" but "are these the same surface" — and an app
  // routinely paints those in two near-blacks: Instagram's chrome is #0C0F14
  // and the pillarbox around its media is #000000, a distance of 20.
  family: 24,
  // The picture has to be at least this much of the image. Stops an all-
  // interface screenshot (a settings page, a chat) from "cropping to" whatever
  // 40-pixel gap happened to be the largest.
  minBlock: 0.15,
};

// At most this many pixels are looked at per line. Every row and column is
// still profiled — only the walk ALONG each one is sampled — so block edges
// stay exact to the pixel.
const CHROME_SAMPLES = 512;

// Scratch histogram, reused across every line of every image, and `TOUCHED` so
// the bins written can be zeroed in O(samples) instead of clearing all 32768
// per line. Not re-entrant, which is fine: this is single-threaded and no line
// profile outlives the call that made it.
//
// This runs on every row and every column of a full-resolution screenshot —
// about four thousand lines — so it is the one place in this file where the
// shape of the loop matters. Lines are walked as a base offset plus a stride
// rather than through an index->offset closure like the void scan uses. On a
// 1290x2796 screenshot the closure version measured 167ms against ~30ms for the
// entire ten-pass void sweep; base+stride brings it to ~48ms, which is back in
// proportion to what an image this size costs to decode in the first place.
const HIST = new Int32Array(1 << 15); // 32 levels per channel
const TOUCHED = new Int32Array(CHROME_SAMPLES);

// Evenness is measured in this many slices across the line and the worst slice
// is the line's score. A slice needs this many of the line's own pixels side by
// side before its score counts at all — a slice that is all text, or all some
// other element, has nothing to say about the background.
const SEGMENTS = 8;
const MIN_SEGMENT_PAIRS = 8;

/**
 * Measure one line: which colour owns it, how much of it that colour owns, how
 * much of it is ink, and whether that colour is PAINTED or PHOTOGRAPHED.
 *
 * The dominant colour comes from a coarse histogram rather than a median,
 * because a chrome line is bimodal — background plus text — and the median of a
 * busy nav bar is not the background. It is then refined to the MEAN of the
 * winning bin, and coverage is counted by tolerance around that mean rather
 * than by bin membership, so a background sitting astride a bin boundary still
 * reads as one colour.
 *
 * `even` is the painted-vs-photographed test: of the consecutive pairs where
 * both pixels are the line's own colour, how many are byte-for-byte identical.
 * Ink is excluded from it by construction — only owned pairs are counted — so
 * a busy nav bar scores as high as an empty one.
 *
 * @param {number} base   byte offset of the line's first pixel
 * @param {number} stride bytes between consecutive pixels (4 along a row,
 *                        width*4 down a column)
 */
function lineProfile(data, base, stride, length, tolerance, contrast) {
  if (length <= 0) return null;
  const step = Math.max(1, Math.ceil(length / CHROME_SAMPLES));
  const jump = step * stride;
  const end = base + length * stride;

  let n = 0;
  let hits = 0;
  for (let o = base; o < end; o += jump) {
    const key = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
    if (HIST[key]++ === 0) TOUCHED[hits++] = key;
    n++;
  }
  if (!n) return null;

  let win = TOUCHED[0];
  for (let i = 1; i < hits; i++) if (HIST[TOUCHED[i]] > HIST[win]) win = TOUCHED[i];
  const winCount = HIST[win];
  for (let i = 0; i < hits; i++) HIST[TOUCHED[i]] = 0;

  // Mean of the winning bin.
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sa = 0;
  for (let o = base; o < end; o += jump) {
    const key = ((data[o] >> 3) << 10) | ((data[o + 1] >> 3) << 5) | (data[o + 2] >> 3);
    if (key !== win) continue;
    sr += data[o];
    sg += data[o + 1];
    sb += data[o + 2];
    sa += data[o + 3];
  }
  const rr = sr / winCount;
  const rg = sg / winCount;
  const rb = sb / winCount;
  const ra = sa / winCount;

  let owned = 0;
  let ink = 0;
  let pairs = 0;
  let same = 0;
  let wasOwned = false;
  let first = true;
  let pr = 0;
  let pg = 0;
  let pb = 0;
  // Evenness is scored per SEGMENT and the worst one wins, because a line can
  // be painted in one place and photographed in another. A night-time video
  // pillarboxed in black is the case that forced this: each row is a quarter
  // pure black, which is perfectly even, and the black pads the score enough to
  // carry the noisy video between the pillars over the line. Segment it and the
  // pillars score 1.00, the video scores 0.14, and the row is a picture.
  const segLen = Math.max(1, Math.ceil(n / SEGMENTS));
  let segPairs = 0;
  let segSame = 0;
  let segAll = 0;
  let segAllSame = 0;
  let segLeft = segLen;
  let judged = 0;
  let worst = 1;
  let second = 1;
  const closeSegment = () => {
    let score = -1;
    if (segPairs >= MIN_SEGMENT_PAIRS) score = segSame / segPairs;
    else if (segAll >= MIN_SEGMENT_PAIRS) {
      // A whole slice with none of the LINE's colour in it. Skipping it scored
      // a row that was 70% pillarbox and 30% video a perfect 1.00 off the
      // pillars alone, so it has to be judged — but on whether the slice itself
      // is painted, not on a colour it was never going to have. A status bar's
      // dynamic island and a solid Follow button are as painted as the bar they
      // sit on; the video between two pillars is not.
      score = segAllSame / segAll;
    }
    if (score >= 0) {
      judged++;
      if (score < worst) {
        second = worst;
        worst = score;
      } else if (score < second) second = score;
    }
    segPairs = 0;
    segSame = 0;
    segAll = 0;
    segAllSame = 0;
    segLeft = segLen;
  };
  for (let o = base; o < end; o += jump) {
    const cr = data[o];
    const cg = data[o + 1];
    const cb = data[o + 2];
    let d = Math.abs(cr - rr);
    const dg = Math.abs(cg - rg);
    if (dg > d) d = dg;
    const db = Math.abs(cb - rb);
    if (db > d) d = db;
    const da = Math.abs(data[o + 3] - ra);
    if (da > d) d = da;
    const isOwn = d <= tolerance;
    const alike = cr === pr && cg === pg && cb === pb;
    if (first) first = false;
    else {
      segAll++;
      if (alike) segAllSame++;
    }
    if (isOwn) {
      owned++;
      if (wasOwned) {
        pairs++;
        segPairs++;
        if (alike) {
          same++;
          segSame++;
        }
      }
    } else if (d > contrast) ink++;
    wasOwned = isOwn;
    pr = cr;
    pg = cg;
    pb = cb;
    if (--segLeft === 0) closeSegment();
  }
  closeSegment();
  return {
    cover: owned / n,
    // The SECOND-worst slice, not the worst. One anomalous slice is an element
    // sitting on the bar — a row of coloured emoji in a caption, a circular
    // profile photo on an account row — and condemning the whole line for it
    // turned those rows into picture, which cost 252px of a crop that had been
    // right. Two bad slices means the line is not one surface, and that is what
    // a pillarbox always produces: it leaves the entire middle of the row
    // unaccounted for, six slices of eight at 10% rails and still two at 35%.
    //
    // With nothing to compare, fall back to the whole-line ratio, and to 0 if
    // no two of its own pixels ever landed side by side — itself a
    // photograph's signature.
    even: judged >= 2 ? second : judged === 1 ? worst : pairs > 0 ? same / pairs : 0,
    ink: ink / n,
    r: Math.round(rr),
    g: Math.round(rg),
    b: Math.round(rb),
    a: Math.round(ra),
  };
}

// Every line is one of three things, and the middle one is why the first
// version of this got two of seven real screenshots wrong.
//
//   PICTURE — no colour owns it, or the colour that does is photographed
//             rather than painted. This is the only kind worth keeping.
//   CHROME  — a painted background with writing on it. Interface, for certain.
//   BLANK   — a painted background with nothing on it: the padding inside an
//             app header, the gap between two toolbars, the strip under a
//             browser bar, the pillarbox beside a vertical video.
//
// BLANK is deliberately neither. Treating it as picture is what left a whole
// Safari toolbar attached to a crop (a white gap above the toolbar broke the
// band in two, and the half touching the edge "was content"). Treating it as
// interface would crop the sky off a photograph. So it is inert: it cannot
// anchor a crop, and it cannot break a band either.
const PICTURE = 0;
const BLANK = 1;
const CHROME = 2;

function classify(p, opts) {
  if (!p || p.cover < opts.coverage || p.even < opts.evenness) return PICTURE;
  return p.ink >= opts.inkRow ? CHROME : BLANK;
}

function mergeRuns(runs) {
  const out = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && last.picture === run.picture) last.b = run.b;
    else out.push({ ...run });
  }
  return out;
}

// Absorb runs shorter than `minRun`, shortest first.
//
// Needed in both directions. A profile picture is a circle, so the few rows
// through its middle are wide enough to stop owning their line and would split
// one chrome band into three. A meme with a white caption bar across it has the
// mirror problem — a flat strip that would split the picture in two and leave
// the crop on whichever half was larger. Neither is a real boundary.
function bridgeRuns(input, minRun) {
  let runs = input;
  while (runs.length > 1) {
    let k = -1;
    for (let i = 0; i < runs.length; i++) {
      const len = runs[i].b - runs[i].a;
      if (len >= minRun) continue;
      if (k < 0 || len < runs[k].b - runs[k].a) k = i;
    }
    if (k < 0) break;
    runs[k].picture = !runs[k].picture;
    // Flipping always merges with at least one neighbour, so this shrinks the
    // list every pass and cannot spin.
    runs = mergeRuns(runs);
  }
  return runs;
}

// Shortest run of lines that counts as a real section rather than a hairline
// or a stray artefact. 3% of the axis, floored at 24 lines. Shared between
// contentBlock() (deciding where the picture is) and bandTrim() (deciding
// whether a bare band is one clean surface) so the two can't drift apart —
// see the note on bandTrim for why they both need it.
function minRun(extent) {
  return Math.max(24, Math.round(extent * 0.03));
}

/**
 * The largest run of picture on one axis, as `{a, b}`. Null when there is none
 * big enough to be the subject.
 */
function contentBlock(kinds, extent, opts) {
  if (!kinds.length) return null;

  let runs = [];
  for (let i = 0; i < kinds.length; i++) {
    const picture = kinds[i] === PICTURE;
    const last = runs[runs.length - 1];
    if (last && last.picture === picture) last.b = i + 1;
    else runs.push({ picture, a: i, b: i + 1 });
  }

  // Close the gaps in both directions: below minRun a "band" is a UI
  // hairline, not a section.
  runs = bridgeRuns(runs, minRun(extent));

  let best = -1;
  for (let i = 0; i < runs.length; i++) {
    if (!runs[i].picture) continue;
    if (best < 0 || runs[i].b - runs[i].a > runs[best].b - runs[best].a) best = i;
  }
  if (best < 0) return null;
  const block = runs[best];
  if (block.b - block.a < extent * opts.minBlock) return null;
  return { a: block.a, b: block.b };
}

// The colours this image paints its interface in — the dominant colour of every
// line that carried ink, deduplicated. Collected across both axes, and used to
// decide whether a band with nothing written on it is app background or part of
// the photograph. See bandTrim().
const MAX_PALETTE = 8;

function addPalette(pal, kinds, profiles, tolerance) {
  for (let i = 0; i < kinds.length; i++) {
    if (kinds[i] !== CHROME) continue;
    const p = profiles[i];
    if (pal.some((c) => nearColor(c, p, tolerance))) continue;
    if (pal.length >= MAX_PALETTE) return pal;
    pal.push({ r: p.r, g: p.g, b: p.b, a: p.a });
  }
  return pal;
}

function nearColor(a, b, tolerance) {
  return (
    Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance
  );
}

/**
 * Should the band between the picture and the edge be trimmed?
 *
 * Two ways to qualify, and the second one is what a real screenshot needed:
 *
 *   It has writing in it. Ordinary interface — a status bar, a caption, a row
 *   of icons — plus however much empty padding came with it.
 *
 *   It has nothing written in it, but it is painted in a colour this image
 *   uses for interface elsewhere. The black pillarbox either side of a vertical
 *   video in a Facebook post is the case: nothing is written on it, so on its
 *   own it is indistinguishable from a letterbox bar, which belongs to the void
 *   scan. But the app header above it is the same black — and a colour caught
 *   carrying text elsewhere in the same screenshot is app background, not sky.
 *   No interface found anywhere means an empty palette and no second chance,
 *   which is what keeps a plain letterboxed photo out of this detector.
 *
 * The match runs at `family` rather than `tolerance`, because the two are
 * rarely the SAME near-black — see the note on that setting.
 *
 * A single column inside a bare pillar is allowed to fail both tests without
 * vetoing the whole band. contentBlock() already tolerates exactly this kind
 * of thing — a stray highlight, a JPEG artefact, one antialiased pixel — by
 * bridging any run under minRun back into its neighbour before it decides
 * where the picture starts. This function used to rescan the same columns
 * without that tolerance, so one bad column deep inside an otherwise-clean
 * 190px pillar reported the whole band as 0 while a pixel-identical mirror on
 * the other side trimmed correctly. Bridged the same way here: only a run of
 * bad columns AT LEAST minRun long is treated as real content bleeding into
 * the band; anything shorter is noise, not a boundary.
 */
function bandTrim(kinds, profiles, a, b, pal, opts, minRun) {
  if (b <= a) return false;
  let inked = 0;
  for (let i = a; i < b; i++) if (kinds[i] === CHROME) inked++;
  if (inked >= opts.bandInk) return true;
  if (!pal.length) return false;
  let run = 0;
  let longestBad = 0;
  for (let i = a; i < b; i++) {
    const bad = kinds[i] === PICTURE || !pal.some((c) => nearColor(c, profiles[i], opts.family));
    run = bad ? run + 1 : 0;
    if (run > longestBad) longestBad = run;
  }
  return longestBad < minRun;
}

// The colour to show for a trimmed band. The middle INKED line, because that is
// the interface the user is being told about; the middle line of the band as a
// whole is often padding, and the line at the boundary is often a blend of the
// band and the picture.
function bandRef(kinds, profiles, a, b) {
  if (b <= a) return null;
  const inked = [];
  for (let i = a; i < b; i++) if (kinds[i] === CHROME) inked.push(i);
  const p = profiles[inked.length ? inked[inked.length >> 1] : (a + b) >> 1];
  return p ? { r: p.r, g: p.g, b: p.b, a: p.a } : null;
}

/**
 * Measure the interface around the picture in an app screenshot.
 *
 * Returns the same shape as detectVoids() so the UI and the crop path can use
 * either without caring which one ran, plus:
 *   chrome     — true, to mark which detector produced this
 *   allChrome  — the image is interface end to end, with no picture in it
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} image
 * @param {Partial<typeof CHROME_DEFAULTS>} [options]
 */
export function detectChrome(image, options = {}) {
  const { data, width, height } = image;
  if (!width || !height) throw new Error("detectChrome: image has no dimensions");
  const opts = { ...CHROME_DEFAULTS, ...options };

  // Rows first, then columns across only the surviving rows — the same ordering
  // and the same reason as the void scan. A full-width nav bar otherwise starts
  // every column with interface colour and every column reads as chrome.
  const rowProfiles = [];
  for (let y = 0; y < height; y++) {
    rowProfiles.push(lineProfile(data, y * width * 4, 4, width, opts.tolerance, opts.contrast));
  }
  const rowKinds = rowProfiles.map((p) => classify(p, opts));
  const pal = addPalette([], rowKinds, rowProfiles, opts.tolerance);
  const vertical = contentBlock(rowKinds, height, opts);

  // The block bounds the picture; whether the band outside it actually goes is
  // a separate question, and the answer is no for a photograph that simply has
  // a flat top. Each side is asked independently.
  const top =
    vertical && bandTrim(rowKinds, rowProfiles, 0, vertical.a, pal, opts, minRun(height))
      ? vertical.a
      : 0;
  const bottom =
    vertical && bandTrim(rowKinds, rowProfiles, vertical.b, height, pal, opts, minRun(height))
      ? height - vertical.b
      : 0;
  const innerHeight = height - top - bottom;

  let horizontal = null;
  const colProfiles = [];
  let colKinds = [];
  if (vertical && innerHeight > 0) {
    for (let x = 0; x < width; x++) {
      colProfiles.push(
        lineProfile(data, (top * width + x) * 4, width * 4, innerHeight, opts.tolerance, opts.contrast),
      );
    }
    colKinds = colProfiles.map((p) => classify(p, opts));
    addPalette(pal, colKinds, colProfiles, opts.tolerance);
    horizontal = contentBlock(colKinds, width, opts);
  }
  const left =
    horizontal && bandTrim(colKinds, colProfiles, 0, horizontal.a, pal, opts, minRun(width))
      ? horizontal.a
      : 0;
  const right =
    horizontal && bandTrim(colKinds, colProfiles, horizontal.b, width, pal, opts, minRun(width))
      ? width - horizontal.b
      : 0;

  const band = (px, kinds, profiles, a, b) => ({
    px,
    ref: px > 0 ? bandRef(kinds, profiles, a, b) : null,
    nextPx: 0,
  });
  const sides = {
    top: sideInfo(band(top, rowKinds, rowProfiles, 0, top), height),
    bottom: sideInfo(band(bottom, rowKinds, rowProfiles, height - bottom, height), height),
    left: sideInfo(band(left, colKinds, colProfiles, 0, left), width),
    right: sideInfo(band(right, colKinds, colProfiles, width - right, width), width),
  };

  const hasVoid = top + bottom + left + right > 0;
  return {
    width,
    height,
    top,
    bottom,
    left,
    right,
    sides,
    crop: cropRect({ width, height }, { top, bottom, left, right }),
    blankImage: false,
    hasVoid,
    rotated: false,
    chrome: true,
    // Nothing but interface: no run of picture cleared minBlock. Worth saying,
    // because it is a different answer from "this already fills the frame".
    allChrome: !vertical && rowKinds.some((k) => k === CHROME),
  };
}

/**
 * Interface first, then blank edges — the two detectors run one after the other,
 * the second one inside the first one's crop.
 *
 * This exists because of what a 139-screenshot batch showed: interface mode gets
 * the crop visually right, but leaves a few pixels of the band behind on most
 * images — about 4-6px on the sides and 6-8 top and bottom, worst case around
 * 12, and never balanced, because each edge of a media container blends into the
 * picture over a slightly different distance. Saving that crop and running the
 * void scan over it by hand cleaned up all 139 without damaging one of them.
 * This is that second run, done in one step.
 *
 * Why it is a separate function rather than folded into detectChrome():
 *
 *   detectChrome() keeps its contract. The refinement is a genuinely different
 *   question — "is there blank space inside this crop" — answered by the
 *   detector built for it, and mixing the two silently cost 12px off the top of
 *   a dim photograph when it was tried inline. Here it is a mode the user picks
 *   and can see, so an over-trim lands in the editable side fields instead of
 *   disappearing into one number.
 *
 *   Capped per side. A leftover is a boundary artefact and is small by nature —
 *   the worst measured was about 12px. Uncapped, this pass reads the whole dark
 *   half of a dim photograph as blank and takes 500px of it, because at the
 *   tolerances the sweep reaches, a dim photograph IS flat. EDGE_CAP of the
 *   axis, floored at 12px, recovers every leftover measured in full while
 *   bounding that worst case to a fraction of a percent.
 *
 * The second pass reads the same pixel buffer through a window, so nothing is
 * copied. `tolerance` is forwarded to it, which is why the strictness control is
 * meaningful in this mode and hidden in plain interface mode.
 *
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} image
 * @param {Partial<typeof CHROME_DEFAULTS> & {tolerance?: number}} [options]
 */
const EDGE_CAP = 0.005;

export function detectChromeThenEdges(image, options = {}) {
  const chrome = detectChrome(image, options);
  const rect = chrome.crop;
  // Nothing found, nothing to refine — and refining a crop that is the whole
  // image would just BE the void scan, which is the other mode.
  if (!chrome.hasVoid || rect.width < 4 || rect.height < 4) return chrome;

  const edges =
    options.tolerance == null
      ? detectVoidsAuto(image, { window: rect })
      : detectVoids(image, { ...options, window: rect });

  const cap = (axis) => Math.max(12, Math.round(axis * EDGE_CAP));
  const add = (side) =>
    Math.min(edges[side], cap(side === "top" || side === "bottom" ? chrome.height : chrome.width));
  const trim = {
    top: chrome.top + add("top"),
    bottom: chrome.bottom + add("bottom"),
    left: chrome.left + add("left"),
    right: chrome.right + add("right"),
  };

  // Report the interface colour where interface was trimmed, and the leftover's
  // own colour where it was not — the number is the total either way.
  const sides = {};
  for (const side of ["top", "bottom", "left", "right"]) {
    const total = side === "top" || side === "bottom" ? chrome.height : chrome.width;
    const from = chrome.sides[side].px > 0 ? chrome.sides[side] : edges.sides[side];
    sides[side] = {
      ...from,
      px: trim[side],
      pct: total > 0 ? Math.round((trim[side] / total) * 1000) / 10 : 0,
      nextPx: 0,
    };
  }

  return {
    ...chrome,
    ...trim,
    sides,
    crop: cropRect({ width: chrome.width, height: chrome.height }, trim),
    hasVoid: trim.top + trim.bottom + trim.left + trim.right > 0,
    // Marks which pipeline produced this, for anything that needs to tell.
    edges: true,
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
