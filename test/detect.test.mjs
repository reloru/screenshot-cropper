// Unit tests for the void measurement. Run: npm test
//
// The "real screenshot" group at the bottom reproduces failures found by testing
// on an actual iPhone; each carries the wrong value it used to produce so a
// regression is obvious.
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectVoids, detectVoidsAuto, detectChrome, cropRect, colorName } from "../public/detect.js";
import { makeImage, setPixel, encodePng, decodePng, rows } from "../scripts/png.mjs";

const BLACK = [0, 0, 0, 255];
const WHITE = [255, 255, 255, 255];

test("measures a band on each edge independently", () => {
  const img = makeImage({ width: 200, height: 400, top: 120, bottom: 80, left: 40, right: 25 });
  const r = detectVoids(img);
  assert.equal(r.top, 120);
  assert.equal(r.bottom, 80);
  assert.equal(r.left, 40);
  assert.equal(r.right, 25);
  assert.deepEqual(r.crop, { x: 40, y: 120, width: 135, height: 200 });
  assert.equal(r.hasVoid, true);
  assert.equal(r.blankImage, false);
});

test("reports no void when content reaches every edge", () => {
  const r = detectVoids(makeImage({ width: 120, height: 90 }));
  assert.equal(r.top, 0);
  assert.equal(r.bottom, 0);
  assert.equal(r.left, 0);
  assert.equal(r.right, 0);
  assert.equal(r.hasVoid, false);
  assert.deepEqual(r.crop, { x: 0, y: 0, width: 120, height: 90 });
});

test("letterbox bars: top and bottom only, sides untouched", () => {
  const r = detectVoids(makeImage({ width: 390, height: 844, top: 211, bottom: 211 }));
  assert.equal(r.top, 211);
  assert.equal(r.bottom, 211);
  assert.equal(r.left, 0);
  assert.equal(r.right, 0);
  assert.equal(r.crop.height, 422);
});

test("a colored top bar does not distort the left/right measurement", () => {
  // Rows are scanned first and the columns are then measured only across the
  // surviving rows. If that order were reversed, this black top bar would make
  // every column start with black and the white side margins would be missed.
  const img = makeImage({ width: 300, height: 300, left: 30, right: 30, band: WHITE });
  for (let y = 0; y < 50; y++) {
    for (let x = 0; x < 300; x++) setPixel(img, x, y, BLACK);
  }
  const r = detectVoids(img);
  assert.equal(r.top, 50, "black bar measured as the top void");
  assert.equal(r.left, 30, "white left margin still found");
  assert.equal(r.right, 30, "white right margin still found");
});

test("stops at a color change and reports the follow-on band", () => {
  // 44px black status bar over a 60px white strip over content: the black bar
  // is the void, and the white strip is offered as an optional extension
  // rather than being trimmed automatically.
  const img = makeImage({ width: 200, height: 300, top: 104, band: WHITE });
  for (let y = 0; y < 44; y++) {
    for (let x = 0; x < 200; x++) setPixel(img, x, y, BLACK);
  }
  const r = detectVoids(img);
  assert.equal(r.top, 44);
  assert.equal(r.sides.top.hex, "#000000");
  assert.equal(r.sides.top.name, "black");
  assert.equal(r.sides.top.nextPx, 60, "white strip surfaced as an extension");
});

test("a solid app header under a status bar is never swallowed", () => {
  // The drift rule allows a band's color to creep, so it must still refuse a
  // jump — otherwise a colored header reads as more blank space.
  const img = rows(600, [
    [44, () => [8, 8, 8, 255]], // near-black status bar
    [80, () => [20, 90, 200, 255]], // solid blue header
    [300, (x) => [60 + ((x * 37) % 190), 90 + ((x * 17) % 160), 40 + ((x * 7) % 200), 255]],
  ]);
  const r = detectVoids(img);
  assert.equal(r.top, 44, "stops at the header, does not eat it");
  assert.equal(r.sides.top.nextPx, 80, "header offered as an extension instead");
});

test("noise budget absorbs stray pixels but not a real edge", () => {
  const img = makeImage({ width: 1000, height: 200, top: 50, band: WHITE });
  for (let x = 0; x < 15; x++) setPixel(img, x, 10, [12, 200, 30, 255]);
  assert.equal(detectVoids(img).top, 50, "sub-budget speckle stays blank");

  // Half the row disagreeing is content, not noise.
  for (let x = 0; x < 500; x++) setPixel(img, x, 10, [12, 200, 30, 255]);
  const r = detectVoids(img, { grace: 0 });
  assert.equal(r.top, 10, "a genuinely non-uniform row ends the band");
});

test("a fully transparent border counts as a void", () => {
  const img = makeImage({ width: 80, height: 80, top: 12, bottom: 12, left: 8, right: 8, band: [0, 0, 0, 0] });
  const r = detectVoids(img);
  assert.equal(r.top, 12);
  assert.equal(r.left, 8);
  assert.equal(r.sides.top.name, "transparent");
  assert.equal(r.sides.top.alpha, 0);
});

test("an entirely blank image is flagged instead of cropped to nothing", () => {
  const img = makeImage({ width: 50, height: 50, top: 50, band: WHITE });
  const r = detectVoids(img);
  assert.equal(r.blankImage, true);
  assert.ok(r.crop.width >= 1 && r.crop.height >= 1, "crop never degenerates to 0px");
});

test("percentages and color metadata come back with each side", () => {
  const r = detectVoids(makeImage({ width: 400, height: 1000, top: 250, band: BLACK }));
  assert.equal(r.sides.top.px, 250);
  assert.equal(r.sides.top.pct, 25);
  assert.equal(r.sides.top.hex, "#000000");
  assert.equal(r.sides.bottom.px, 0);
  assert.equal(r.sides.bottom.hex, null, "an absent void reports no color");
});

test("cropRect clamps hand-entered overrides", () => {
  const img = { width: 100, height: 100 };
  assert.deepEqual(cropRect(img, { top: -5, bottom: 0, left: 0, right: 0 }), { x: 0, y: 0, width: 100, height: 100 });
  assert.ok(cropRect(img, { top: 90, bottom: 90, left: 0, right: 0 }).height >= 1);
  assert.equal(cropRect(img, { top: 10.6, bottom: 0, left: 0, right: 0 }).y, 11, "fractional input rounds");
});

test("colorName only names neutral colors", () => {
  assert.equal(colorName({ r: 0, g: 0, b: 0, a: 255 }), "black");
  assert.equal(colorName({ r: 255, g: 255, b: 255, a: 255 }), "white");
  assert.equal(colorName({ r: 128, g: 128, b: 128, a: 255 }), "gray");
  assert.equal(colorName({ r: 200, g: 40, b: 60, a: 255 }), null, "hues are left to the swatch");
});

test("the PNG fixture helper round-trips", () => {
  const img = makeImage({ width: 33, height: 21, top: 4, left: 3 });
  const decoded = decodePng(encodePng(img));
  assert.equal(decoded.width, 33);
  assert.equal(decoded.height, 21);
  const r = detectVoids(decoded);
  assert.equal(r.top, 4);
  assert.equal(r.left, 3);
});

// --------------------------------------------------------------------------
// Regressions from testing on a real iPhone. Each of these measured wrongly
// before the flat/drift/grace rewrite.
// --------------------------------------------------------------------------

// A letterboxed photo: bars that are NEAR black, carrying compression speckle,
// with a soft ramp where the bar meets the picture.
function letterboxedPhoto({ width = 1290, height = 1876, bar = 180, speckleRate = 0.003, ramp = 14 } = {}) {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const inBar = y < bar || y >= height - bar;
      let v;
      if (inBar) {
        v = rnd() < speckleRate ? 8 + Math.round(rnd() * 34) : 0;
        const d = Math.min(Math.abs(y - bar), Math.abs(y - (height - bar)));
        if (d < ramp) v = Math.max(v, Math.round(((ramp - d) / ramp) * 26));
      } else {
        v = 60 + Math.round(rnd() * 180);
      }
      data[o] = v;
      data[o + 1] = inBar ? v : Math.min(255, v + 40);
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return { data, width, height };
}

test("regression: speckled black bars no longer measure as zero", () => {
  // Was: 0 at tolerance 0 and 8 (the reported "Bottom 0px" next to an obviously
  // huge black bar), because one speckled row ended the scan outright.
  const img = letterboxedPhoto();
  for (const tolerance of [8, 24, 48]) {
    const r = detectVoids(img, { tolerance });
    assert.ok(
      Math.abs(r.top - 180) <= 3 && Math.abs(r.bottom - 180) <= 3,
      `tolerance ${tolerance} gave top=${r.top} bottom=${r.bottom}, expected ~180`,
    );
  }
});

test("regression: heavy speckle survives the scan", () => {
  const r = detectVoidsAuto(letterboxedPhoto({ speckleRate: 0.03 }));
  assert.ok(Math.abs(r.top - 180) <= 3, `top=${r.top}, expected ~180`);
  assert.ok(Math.abs(r.bottom - 180) <= 3, `bottom=${r.bottom}, expected ~180`);
});

test("regression: a gradient background reads as blank", () => {
  // The purple share-card screenshots reported "Bottom 29px" with a
  // "+128 px more" chip: the band color drifts continuously, so a fixed
  // tolerance anchored at the edge could never span it.
  const img = rows(600, [
    [200, (x, y) => { const v = 40 + Math.round(y * 0.35); return [v, v - 8, v + 20, 255]; }],
    [300, (x) => [60 + ((x * 37) % 190), 90 + ((x * 17) % 160), 40 + ((x * 7) % 200), 255]],
  ]);
  const r = detectVoidsAuto(img);
  assert.ok(Math.abs(r.top - 200) <= 3, `top=${r.top}, expected ~200 across the gradient`);
});

test("auto never invents a void", () => {
  // The failure that would matter most: cropping away real picture.
  const noBars = letterboxedPhoto({ bar: 0 });
  const auto = detectVoidsAuto(noBars);
  assert.equal(auto.top, 0);
  assert.equal(auto.bottom, 0);
  assert.equal(auto.hasVoid, false);

  const busy = makeImage({ width: 300, height: 500 });
  const r = detectVoidsAuto(busy);
  assert.equal(r.hasVoid, false, "a full-bleed image is left alone");
});

test("auto handles white margins and thin bars", () => {
  const white = detectVoidsAuto(makeImage({ width: 400, height: 600, top: 120, bottom: 120, band: WHITE }));
  assert.equal(white.top, 120);
  assert.equal(white.bottom, 120);

  const thin = detectVoidsAuto(makeImage({ width: 400, height: 600, top: 12, band: BLACK }));
  assert.ok(Math.abs(thin.top - 12) <= 2, `thin bar measured ${thin.top}, expected ~12`);
});

test("auto sweeps each side separately", () => {
  // Crisp black bar on top, soft gradient at the bottom: one global tolerance
  // cannot serve both, which is why the sweep is per-side.
  const img = rows(500, [
    [100, () => [0, 0, 0, 255]],
    [300, (x) => [60 + ((x * 37) % 190), 90 + ((x * 17) % 160), 40 + ((x * 7) % 200), 255]],
    [150, (x, y) => { const v = 200 - Math.round(y * 0.3); return [v, v, v, 255]; }],
  ]);
  const r = detectVoidsAuto(img);
  assert.equal(r.top, 100, "crisp bar exact");
  assert.ok(Math.abs(r.bottom - 150) <= 3, `gradient bottom=${r.bottom}, expected ~150`);
});

test("a straightened photo is identified rather than reported as nothing", () => {
  // Black triangles in opposite corners: no full row or column is ever blank,
  // so there is genuinely no rectangle to trim. Saying so beats four zeroes.
  const width = 400;
  const height = 400;
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 3;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      // Rotate ~20 degrees: outside the tilted rectangle is black.
      const cx = x - width / 2;
      const cy = y - height / 2;
      const a = (20 * Math.PI) / 180;
      const rx = Math.abs(cx * Math.cos(a) + cy * Math.sin(a));
      const ry = Math.abs(-cx * Math.sin(a) + cy * Math.cos(a));
      const inside = rx < width * 0.42 && ry < height * 0.42;
      const v = inside ? 70 + Math.round(rnd() * 170) : 0;
      data[o] = v;
      data[o + 1] = inside ? Math.min(255, v + 30) : 0;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  const r = detectVoidsAuto({ data, width, height });
  assert.equal(r.hasVoid, false, "correctly finds no straight edge to trim");
  assert.equal(r.rotated, true, "and recognises why");
});

test("a soft-edged bar is trimmed all the way, leaving no sliver", () => {
  // From a real 58-photo batch: every JPEG selfie with white side bars came out
  // with 1-2 columns of white still attached.
  //
  // A void does not end on a pixel boundary. JPEG and antialiasing leave the
  // last columns dimmed AND slightly mottled, so they are still blank but only
  // read as flat at a HIGHER tolerance than the pure bar does. Measured off the
  // real files: the pure bar is 255 flat, then one column at ~248 with a spread
  // of ~9, then one at ~229 with a spread of ~34, then content (spread ~170).
  //
  // So the sweep creeps 40, 40, 41, 41, 42, 42, 42... The old plateau grew one
  // run across all of that and reported its ANCHOR (40), leaving the sliver.
  // The run's max (42) is the answer it settles on.
  const BAR = 40;
  const width = 2 * (BAR + 2) + 200;
  const mottle = (x, y, amp) => Math.round(Math.sin(x * 12.9898 + y * 78.233) * amp);
  const paint = (x, y) => {
    const from = Math.min(x, width - 1 - x); // distance from the nearer side
    if (from < BAR) return [255, 255, 255, 255];
    if (from === BAR) { const v = 248 + mottle(x, y, 5); return [v, v, v, 255]; }
    if (from === BAR + 1) { const v = 229 + mottle(x, y, 18); return [v, v, v, 255]; }
    return [40 + ((x * 53 + y * 31) % 180), 30 + ((x * 17 + y * 7) % 200), 60 + ((x * 29) % 170), 255];
  };
  const img = rows(width, [[220, paint]]);

  const r = detectVoidsAuto(img);
  assert.equal(r.left, BAR + 2, `left=${r.left}, want ${BAR + 2} — a white sliver survived`);
  assert.equal(r.right, BAR + 2, `right=${r.right}, want ${BAR + 2} — a white sliver survived`);
});

test("a smoothly-lit photo is not eaten just because high tolerance flattens it", () => {
  // The counterweight to the test above, and the reason plateau() takes the max
  // of ONE run rather than of the whole sweep. A dim, evenly-lit wall (a bedroom
  // mirror selfie, in the batch that prompted this) reads as flat once tolerance
  // climbs high enough, so the sweep reads 0,0,0,0,0,0,200,200,200,200.
  //
  // Content-eating lunges; a soft edge creeps. The lunge is far outside
  // PLATEAU_SLACK, so it starts a NEW run and the run of zeroes wins on length.
  // Taking the max must never reach across that boundary.
  const width = 240;
  const AMP = 36; // enough tonal range that the wall only flattens at tol 40+
  const wall = (x, y) => {
    const v = 150 + (((x * 7 + y * 13) % (2 * AMP + 1)) - AMP);
    return [v, v - 2, v - 8, 255];
  };
  const busy = (x, y) => [30 + ((x * 61 + y * 23) % 200), 20 + ((x * 13) % 210), 50 + ((y * 37) % 190), 255];
  const img = rows(width, [[200, wall], [300, busy]]);

  const r = detectVoidsAuto(img);
  assert.equal(r.top, 0, `top=${r.top}: trimmed 200px of actual photo`);
});

test("the blended boundary line is absorbed, not left as a faint white edge", () => {
  // Second real-batch report: after soft ramps were fixed, a "very faint white
  // line" still showed on the sides. Measured on the file, the final column was
  // a uniform 22% white over 78% content — far too contaminated to keep, but
  // with a spread of ~170 it can never pass flatColor() at any tolerance. It is
  // recognised structurally instead: edge = a*void + (1-a)*inner.
  //
  // The content here is locally SMOOTH, which is the property that makes the
  // equation solvable at all — a real photo's neighbouring columns are nearly
  // equal, so the blend column resolves against the one beside it.
  const BAR = 30;
  const ALPHA = 0.22;
  const width = 2 * (BAR + 1) + 200;
  const content = (x, y) => {
    const v = (k) => 90 + 46 * Math.sin((x + k * 3) / 31) + 38 * Math.sin(y / 19) + 18 * Math.sin((x + y) / 13);
    return [0, 1, 2].map((k) => Math.max(4, Math.min(232, Math.round(v(k)))));
  };
  const paint = (x, y) => {
    const from = Math.min(x, width - 1 - x);
    if (from < BAR) return [255, 255, 255, 255];
    const c = content(x, y);
    if (from === BAR) return [...c.map((n) => Math.round(n + ALPHA * (255 - n))), 255];
    return [...c, 255];
  };
  const img = rows(width, [[240, paint]]);

  const r = detectVoidsAuto(img);
  assert.equal(r.left, BAR + 1, `left=${r.left}: the blended column was left behind`);
  assert.equal(r.right, BAR + 1, `right=${r.right}: the blended column was left behind`);
});

test("an ordinary bright edge is not mistaken for a blended boundary", () => {
  // The guard on the rule above. Content that is simply lighter at the frame
  // edge must survive: with no band found there is no void colour to solve
  // against, and even with one, a structurally different line gives wildly
  // inconsistent values for `a` rather than a uniform wash.
  const width = 260;
  const img = rows(width, [
    [
      240,
      (x, y) => {
        const edge = Math.min(x, width - 1 - x) < 2;
        const base = [40 + ((x * 53 + y * 31) % 180), 30 + ((x * 17 + y * 7) % 200), 60 + ((x * 29) % 170)];
        // Brighter at the edge, but structured — not a flat wash toward white.
        return edge ? [...base.map((v, i) => Math.min(255, v + 50 + ((y * (7 + i)) % 60))), 255] : [...base, 255];
      },
    ],
  ]);
  const r = detectVoidsAuto(img);
  assert.equal(r.left, 0, `left=${r.left}: trimmed real content`);
  assert.equal(r.right, 0, `right=${r.right}: trimmed real content`);
});

// --------------------------------------------------------------------------
// App interface (detectChrome). These come from a pair of Instagram feed
// screenshots that the void scan could say nothing useful about: one reported
// four zeroes, the other found a 64px strip and missed the picture entirely.
// --------------------------------------------------------------------------

const UI_BG = [12, 15, 20, 255];
const UI_INK = [235, 236, 238, 255];

/**
 * A band of interface: a flat background with writing on it. `density` is
 * roughly the percentage of the row that is ink, kept well under the coverage
 * threshold so the band still reads as one colour.
 */
function chromeBand(bg, ink, density, inset = 40) {
  return (x, y, width) =>
    x > inset && x < width - inset && y % 11 > 2 && (x * 7 + y * 13) % 97 < density ? ink : bg;
}

/** Busy picture content — no colour owns any row of it. */
function picture(seedA = 53, seedB = 31) {
  return (x, y) => [
    40 + ((x * seedA + y * seedB) % 190),
    30 + ((x * 17 + y * 7) % 200),
    60 + ((x * 29 + y * 11) % 170),
    255,
  ];
}

/**
 * A dim photograph — the inside of a bar, a night beach. Coverage cannot tell
 * this from a nav bar: 99% of every row sits within 10 of one value, and the
 * bright specks in it (a neon sign, a highlight) read as ink. The one thing
 * that separates them is that neighbouring pixels are never equal.
 */
function darkPicture(base = 18, spread = 7) {
  return (x, y) => {
    const n = (x * 2654435761 + y * 40503 + ((x * y) % 7)) >>> 0;
    if (n % 997 < 6) {
      const v = 150 + (n % 90);
      return [v, v - 20, v - 40, 255];
    }
    const d = (n % (2 * spread + 1)) - spread;
    return [Math.max(0, base + d), Math.max(0, base + d - 2), Math.max(0, base + d + 3), 255];
  };
}

/** rows() with the width handed to each painter, so bands can inset from it. */
function screen(width, bands) {
  return rows(width, bands.map(([h, fn]) => [h, (x, y) => fn(x, y, width)]));
}

test("a feed screenshot is cropped to the picture, not to its edges", () => {
  // The shape that prompted all of this. Nothing here is blank: interface above
  // the picture, interface below it, and the NEXT post already showing at the
  // bottom edge. Scanning inward from the edges cannot touch that last part —
  // it is real content by any measure — which is why this reads the image as
  // blocks and keeps the largest run of picture.
  const img = screen(800, [
    [60, chromeBand(UI_BG, UI_INK, 6)], // status bar
    [120, chromeBand(UI_BG, UI_INK, 14)], // nav bar
    [140, chromeBand(UI_BG, UI_INK, 10)], // username, caption, date
    [900, picture()], // the picture
    [200, chromeBand(UI_BG, UI_INK, 12)], // likes, caption
    [160, chromeBand(UI_BG, UI_INK, 8)], // date, next account row
    [300, picture(41, 19)], // the next post, at the bottom edge
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 320, `top=${r.top}`);
  assert.equal(r.bottom, 660, `bottom=${r.bottom}: the next post was left attached`);
  assert.deepEqual(r.crop, { x: 0, y: 320, width: 800, height: 900 });
  assert.equal(r.sides.top.hex, "#0C0F14", "reports the interface colour it trimmed");
  assert.equal(r.chrome, true);
});

test("interface detection works in light mode too", () => {
  // Ink is an absolute distance from the background, so dark-on-white is the
  // same problem as white-on-dark.
  const PAPER = [250, 250, 249, 255];
  const TEXT = [24, 24, 27, 255];
  const img = screen(700, [
    [260, chromeBand(PAPER, TEXT, 12)],
    [800, picture()],
    [240, chromeBand(PAPER, TEXT, 10)],
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 260);
  assert.equal(r.bottom, 240);
  assert.equal(r.sides.top.name, "white");
});

test("a flat sky is not mistaken for interface", () => {
  // THE test. A gradient sky owns its rows just as completely as a nav bar
  // does, so coverage alone would crop it off and destroy the photo. The
  // difference is ink: interface has writing on it, sky does not.
  const img = rows(500, [
    [400, (x, y) => { const v = 150 + Math.round(y * 0.12); return [v - 40, v - 10, v + 40, 255]; }],
    [500, picture(61, 23)],
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 0, `top=${r.top}: cropped 400px of sky off a photograph`);
  assert.equal(r.hasVoid, false);
});

test("a plain studio backdrop is not mistaken for interface either", () => {
  const img = rows(500, [
    [300, () => [232, 231, 229, 255]],
    [400, picture()],
    [300, () => [232, 231, 229, 255]],
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 0);
  assert.equal(r.bottom, 0);
});

test("a letterbox bar is a void, not interface — the two detectors divide the work", () => {
  // Black bars carry no ink, so interface mode correctly declines and leaves
  // them to the void scan. The modes are complementary, not competing.
  const img = rows(400, [[200, () => [0, 0, 0, 255]], [500, picture()], [200, () => [0, 0, 0, 255]]]);
  assert.equal(detectChrome(img).hasVoid, false, "interface mode declines a plain black bar");
  const v = detectVoidsAuto(img);
  assert.equal(v.top, 200, "and the void scan still gets it");
  assert.equal(v.bottom, 200);
});

test("interface detection never invents a crop on a full-bleed photo", () => {
  const r = detectChrome(makeImage({ width: 400, height: 700 }));
  assert.equal(r.hasVoid, false);
  assert.equal(r.allChrome, false);
  assert.deepEqual(r.crop, { x: 0, y: 0, width: 400, height: 700 });
});

test("a wide button does not split the interface band around it", () => {
  // A Follow button spans far too much of its rows for them to read as one
  // colour, so without bridging the nav bar splits into three and the button's
  // rows become a "picture" wedged inside the interface.
  const BUTTON = [80, 84, 92, 255];
  const nav = chromeBand(UI_BG, UI_INK, 10);
  const img = screen(800, [
    [280, nav],
    [40, (x, y, w) => (x > w * 0.3 && x < w * 0.9 ? BUTTON : nav(x, y, w))],
    [280, nav],
    [1000, picture()],
    [800, nav],
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 600, `top=${r.top}: the interface band was split at the button`);
  assert.equal(r.crop.height, 1000);
});

test("a captioned meme is not split at its caption bar", () => {
  // The mirror image: a flat, inked strip lying across the middle of the
  // picture. Left alone it splits the picture in two and the crop keeps
  // whichever half is bigger, throwing away the other.
  const CAPTION = [250, 250, 250, 255];
  const img = screen(800, [
    [400, chromeBand(UI_BG, UI_INK, 12)],
    [420, picture()],
    [50, chromeBand(CAPTION, [20, 20, 20, 255], 14)], // white caption bar, black text
    [430, picture(29, 47)],
    [400, chromeBand(UI_BG, UI_INK, 12)],
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 400, `top=${r.top}`);
  assert.equal(r.crop.height, 900, `height=${r.crop.height}: the caption bar split the picture`);
});

test("columns are measured across the surviving rows only", () => {
  // Same ordering rule as the void scan, for the same reason: a full-width nav
  // bar starts every column with interface colour, so measuring columns first
  // would read the entire image as chrome.
  //
  // Sidebars either side of the picture — the wide-screen layout, where the
  // interface is beside the content as well as above and below it.
  const rail = (x0, x1) => (x, y) =>
    x > x0 + 15 && x < x1 - 15 && x % 9 > 2 && (x * 7 + y * 13) % 97 < 12 ? UI_INK : UI_BG;
  const left = rail(0, 150);
  const right = rail(800, 900);
  const img = screen(900, [
    [300, chromeBand(UI_BG, UI_INK, 12)],
    [800, (x, y, w) => (x < 150 ? left(x, y) : x >= w - 100 ? right(x, y) : picture()(x, y))],
    [300, chromeBand(UI_BG, UI_INK, 12)],
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 300);
  assert.equal(r.bottom, 300);
  assert.equal(r.left, 150, `left=${r.left}`);
  assert.equal(r.right, 100, `right=${r.right}`);
  assert.deepEqual(r.crop, { x: 150, y: 300, width: 650, height: 800 });
});

test("bare bars in the interface colour go with the interface", () => {
  // From the Facebook video screenshot: a vertical video pillarboxed in black,
  // inside an app whose header is the same black. Nothing is written on the
  // pillars, so on their own they are indistinguishable from a letterbox bar —
  // but the header above them was caught carrying text in that exact colour,
  // which makes it app background rather than sky.
  //
  // This measured left=0 right=0 before, and the crop came out as the video
  // with both black pillars still attached.
  const img = screen(900, [
    [300, chromeBand(UI_BG, UI_INK, 12)],
    [800, (x, y, w) => (x < 150 || x >= w - 100 ? UI_BG : picture()(x, y))],
    [300, chromeBand(UI_BG, UI_INK, 12)],
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 300, "the inked bands above and below still go");
  assert.equal(r.left, 150, `left=${r.left}`);
  assert.equal(r.right, 100, `right=${r.right}`);
});

test("a bare bar in a colour the interface never uses is left alone", () => {
  // The guard on the rule above. The palette is evidence, not a licence: a
  // colour that never carried ink anywhere in this image is not known to be
  // interface, so it stays and the void scan can have it.
  const img = screen(900, [
    [300, chromeBand(UI_BG, UI_INK, 12)],
    [800, (x, y, w) => (x < 150 || x >= w - 100 ? [255, 255, 255, 255] : picture()(x, y))],
    [300, chromeBand(UI_BG, UI_INK, 12)],
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 300, "the inked bands above and below still go");
  assert.equal(r.left, 0, `left=${r.left}`);
  assert.equal(r.right, 0, `right=${r.right}`);
});

test("an all-interface screenshot is flagged rather than cropped to a gap", () => {
  // A settings page or a chat: there is no picture in it, so there is nothing
  // to crop TO. Saying so beats cropping to whatever 40px gap was largest.
  const img = screen(600, [[1200, chromeBand(UI_BG, UI_INK, 12)]]);
  const r = detectChrome(img);
  assert.equal(r.allChrome, true);
  assert.equal(r.hasVoid, false);
  assert.deepEqual(r.crop, { x: 0, y: 0, width: 600, height: 1200 });
});

test("a picture too small to be the subject is not cropped to", () => {
  // 8% of the image. Below minBlock, so this reports nothing rather than
  // cropping a tall screenshot down to one thumbnail inside it.
  const img = screen(600, [
    [900, chromeBand(UI_BG, UI_INK, 12)],
    [160, picture()],
    [940, chromeBand(UI_BG, UI_INK, 12)],
  ]);
  assert.equal(detectChrome(img).hasVoid, false);
});

// --------------------------------------------------------------------------
// Regressions from a seven-screenshot batch shot on a real phone. Three of the
// seven came out wrong, each for a different reason, and each is reproduced
// here with the number it used to give.
// --------------------------------------------------------------------------

test("a dim photograph is not mistaken for interface", () => {
  // An Instagram post of a photo taken in a dark bar. The top of the picture is
  // nearly black, so it is flat by every coverage measure, and the neon sign in
  // it supplies the ink — the top band swallowed 374px of the picture it was
  // supposed to be keeping and the crop cut the subjects' heads off.
  const img = screen(800, [
    [300, chromeBand(UI_BG, UI_INK, 12)], // status bar, username, audio row
    [500, darkPicture()], // the dark top half of the photo
    [500, picture()], // the lit bottom half
    [400, chromeBand(UI_BG, UI_INK, 12)], // likes, caption, the next post
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 300, `top=${r.top}: ate the dark top of the picture`);
  assert.equal(r.bottom, 400, `bottom=${r.bottom}`);
  assert.equal(r.crop.height, 1000);
});

test("a dark video is not swallowed by the header its pillarboxes match", () => {
  // The worst measurement in the batch: 1208px, 43% of a Facebook video post,
  // because the night-time top of the video went with the header above it.
  //
  // Two things conspire, and the pillarboxes are the nastier one. Each row of
  // the video is a quarter pure black, which is perfectly even, and averaged
  // over the whole row that black pads the score enough to carry the noisy
  // video between the pillars over the line. Scoring evenness per segment and
  // taking the worst is what separates them: the pillars score 1.00, the video
  // scores near zero, and the row is a picture.
  // Swept across pillar widths because the whole-line score degrades smoothly
  // with them and the screenshot that failed sat in the survivable part of the
  // range: measured on this fixture it reads 0.23 / 0.37 / 0.56 / 0.70 / 0.85
  // as the rails go 10% / 14% / 20% / 28% / 35%, crossing the 0.65 threshold
  // at a pillar width that is nothing unusual — a 9:16 video in a squarer
  // frame. Per segment it is 0.00 at every width.
  const UI = [1, 1, 1, 255]; // the app's own black, which the pillars match
  const PILLAR = [0, 0, 0, 255];
  const night = darkPicture(6, 5); // dark enough that black owns the row
  for (const fraction of [0.1, 0.138, 0.2, 0.28, 0.35]) {
    const width = 900;
    const rail = Math.round(width * fraction);
    const bar = (inner) => (x, y, w) => (x < rail || x >= w - rail ? PILLAR : inner(x, y));
    const img = screen(width, [
      [300, chromeBand(UI, UI_INK, 12)], // status bar, "See more videos", name
      [500, bar(night)],
      [500, bar(picture())],
      [260, chromeBand(UI, UI_INK, 10)], // like / comment
    ]);
    const r = detectChrome(img);
    const at = `rails at ${Math.round(fraction * 100)}%`;
    assert.equal(r.top, 300, `top=${r.top} with ${at}: the dark top of the video went with the header`);
    assert.equal(r.bottom, 260, `bottom=${r.bottom} with ${at}`);
    assert.equal(r.left, rail, `left=${r.left} with ${at}: the pillarbox stayed`);
    assert.equal(r.right, rail, `right=${r.right} with ${at}`);
  }
});

test("a mostly empty interface band still counts as interface", () => {
  // A Facebook photo post: one 60px row of icons at the top of the screen and
  // then 600px of plain black padding before the photo starts. Requiring ink
  // across a FRACTION of the band scored that 0.09 and reported "no interface"
  // over an unmistakable app header, leaving all of it attached.
  const img = screen(800, [
    [60, chromeBand(UI_BG, UI_INK, 12)], // close button, overflow menu
    [600, () => UI_BG], // padding
    [900, picture()],
    [70, chromeBand(UI_BG, UI_INK, 12)], // caption
    [330, () => UI_BG],
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 660, `top=${r.top}: reported "no interface" over an app header`);
  assert.equal(r.bottom, 400, `bottom=${r.bottom}`);
});

test("a stack of differently coloured bars reads as one band", () => {
  // A Facebook post open in Safari, at both ends. Above the picture: the
  // phone's LIGHT status bar over the app's black header. Below it: a dark
  // like/comment row, a white gap, the browser's own toolbar, a white strip.
  //
  // Validating a stack as one band failed it on colour — light grey to black is
  // a drift of 220, white to black is 255, against a limit of 48 — so both ends
  // of the screenshot were kept. Four of the seven shots in the batch hit this,
  // reporting "no interface" over an unmistakable app header at the top and
  // "Bottom 0px" with a Safari toolbar plainly in frame.
  const PAPER = [255, 255, 255, 255];
  const STATUS = [232, 232, 234, 255]; // iOS light status bar
  const img = screen(800, [
    [70, chromeBand(STATUS, [20, 20, 22, 255], 10)], // clock, signal, battery
    [230, chromeBand(UI_BG, UI_INK, 12)], // the app's own black header
    [900, picture()],
    [90, chromeBand(UI_BG, UI_INK, 10)], // like / comment
    [30, () => PAPER], // gap
    [180, chromeBand([28, 28, 30, 255], UI_INK, 12)], // browser toolbar
    [40, () => PAPER], // home indicator strip
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 300, `top=${r.top}: reported "no interface" over a status bar and a header`);
  assert.equal(r.bottom, 340, `bottom=${r.bottom}: the browser toolbar stayed in the crop`);
});

test("a solid element covering a whole slice does not condemn its row", () => {
  // The counterweight to the pillarbox rule above, and the reason a slice
  // holding none of the line's colour is judged on whether IT is painted
  // rather than simply scored zero. Scoring it zero is what the pillarbox
  // needs — but the phone's own status bar has a black pill punched through
  // the middle of it, wide enough to own a whole slice, and a nav bar has
  // solid buttons on it. Those are as painted as the bar they sit on. A video
  // between two pillars is not, which is what tells them apart.
  //
  // Sized so the row still passes coverage — this is about the slice rule on
  // its own, not about the pill being wide enough to fail on colour too.
  // Every row of the top band carries the pill, so the band stands or falls on
  // those rows alone — no clean rows beside them to carry it.
  const STATUS = [232, 232, 234, 255];
  const ISLAND = [0, 0, 0, 255];
  const bar = chromeBand(STATUS, [20, 20, 22, 255], 6);
  const img = screen(800, [
    [120, (x, y, w) => (x >= w * 0.375 && x < w * 0.5625 ? ISLAND : bar(x, y, w))],
    [900, picture()],
    [400, chromeBand(UI_BG, UI_INK, 12)],
  ]);
  const r = detectChrome(img);
  assert.equal(r.top, 120, `top=${r.top}: the status bar read as photograph`);
  assert.equal(r.crop.height, 900);
});

test("one photographic element on a bar does not make the bar a photograph", () => {
  // Regression from the batch this all came out of, caught on the re-run. The
  // caption row under an Instagram post is a run of coloured emoji and the
  // account row below it carries a circular profile photo; either fills a whole
  // slice on its own. Condemning a line for its ONE worst slice turned those
  // rows into picture, the block swallowed them, and a crop that had been right
  // came back 300px where 552px belonged — the likes, the caption and the date
  // all left in frame.
  //
  // Two bad slices is the line, and it is what separates an element on a bar
  // from a pillarbox: a pillar leaves the whole middle of the row unaccounted
  // for — six slices of eight at 10% rails, still two at 35% — while an emoji
  // leaves one.
  const emoji = picture(71, 13);
  const bar = chromeBand(UI_BG, UI_INK, 10);
  const img = screen(800, [
    [400, chromeBand(UI_BG, UI_INK, 12)],
    [900, picture()],
    [60, (x, y, w) => (x >= w * 0.375 && x < w * 0.5 ? emoji(x, y) : bar(x, y, w))],
    [340, chromeBand(UI_BG, UI_INK, 12)],
  ]);
  const r = detectChrome(img);
  assert.equal(r.bottom, 400, `bottom=${r.bottom}: the caption row was swallowed into the picture`);
  assert.equal(r.crop.height, 900);
});

test("a pillarbox goes with a chrome that is a different near-black", () => {
  // An Instagram post: chrome at #0C0F14, the pillarbox around its media at
  // #000000. Twenty apart, so matching the palette at the per-pixel tolerance
  // of 10 left both black bars attached to an otherwise correct crop. They are
  // plainly the same surface, which is why that match is the looser one.
  const PILLAR = [0, 0, 0, 255];
  const rail = 150;
  const post = (bar) =>
    screen(900, [
      [400, chromeBand(UI_BG, UI_INK, 12)], // header, caption, account row
      [900, (x, y, w) => (x < rail || x >= w - rail ? bar : picture()(x, y))],
      [400, chromeBand(UI_BG, UI_INK, 12)], // likes, caption, the next post
    ]);
  const r = detectChrome(post(PILLAR));
  assert.equal(r.top, 400, `top=${r.top}`);
  assert.equal(r.left, rail, `left=${r.left}: the pillarbox stayed`);
  assert.equal(r.right, rail, `right=${r.right}: the pillarbox stayed`);

  // ...but only as far as "same surface". A bar this interface could not have
  // painted is still left alone for the void scan.
  const grey = detectChrome(post([90, 92, 96, 255]));
  assert.equal(grey.top, 400, "the inked bands above and below still go");
  assert.equal(grey.left, 0, `left=${grey.left}: a mid-grey bar is not the app's black`);
});

test("one stray column inside a pillar does not veto the whole band", () => {
  // A pixel-identical pair of 190px pillars either side of a photo, except
  // one column deep inside the RIGHT pillar — nowhere near the photo edge or
  // the frame edge — reads as noise: a stray highlight, a JPEG artefact, one
  // antialiased pixel. Before this fix that single column made bandTrim()
  // reject the ENTIRE band, because it rescanned every raw column with no
  // tolerance for the kind of thing contentBlock() already bridges away when
  // it decides where the picture is. Left trimmed to 190, right stayed 0 —
  // two visually identical bars, one kept and one not.
  const PILLAR = [0, 0, 0, 255];
  const noise = (x, y) => {
    const n = (x * 2654435761 + y * 40503) >>> 0;
    return [n % 90, (n >> 7) % 90, (n >> 3) % 90, 255];
  };
  const rail = 190;
  const width = 900;
  const build = (noisyCol) =>
    screen(width, [
      [400, chromeBand(UI_BG, UI_INK, 12)],
      [
        900,
        (x, y, w) => {
          if (x < rail) return PILLAR;
          if (x >= w - rail) return noisyCol !== null && x === w - rail + noisyCol ? noise(x, y) : PILLAR;
          return picture()(x, y);
        },
      ],
      [400, chromeBand(UI_BG, UI_INK, 12)],
    ]);
  const clean = detectChrome(build(null));
  assert.equal(clean.right, rail, `right=${clean.right}: baseline pillar should trim in full`);

  const dented = detectChrome(build(95)); // dead centre of the pillar
  assert.equal(dented.left, rail, `left=${dented.left}: the untouched mirror still trims`);
  assert.equal(dented.right, rail, `right=${dented.right}: one stray column killed the whole band`);
});

test("a real chunk of content inside a pillar still declines the band", () => {
  // The guard on the fix above. A run of picture-like columns floating in the
  // middle of a pillar — a thumbnail sitting in what looked like a bare bar —
  // has to keep vetoing the band once it's wide enough to be a real thing
  // rather than noise. The threshold is exactly minRun: 3% of 900 is 27, so
  // this sweeps 26 (tolerated) against 27 (not) to pin it precisely.
  const PILLAR = [0, 0, 0, 255];
  const leak = picture(97, 59);
  const rail = 190;
  const width = 900;
  const leakStart = width - rail + 60; // clear of both the photo and frame edges
  const build = (leakWidth) =>
    screen(width, [
      [400, chromeBand(UI_BG, UI_INK, 12)],
      [
        900,
        (x, y, w) => {
          if (x < rail) return PILLAR;
          if (x >= w - rail) return x >= leakStart && x < leakStart + leakWidth ? leak(x, y) : PILLAR;
          return picture()(x, y);
        },
      ],
      [400, chromeBand(UI_BG, UI_INK, 12)],
    ]);
  assert.equal(detectChrome(build(26)).right, rail, "26px is still noise, the pillar trims in full");
  assert.equal(detectChrome(build(27)).right, 0, "27px is a real chunk of content, the band stays");
});

test("detectChrome returns the same shape detectVoids does", () => {
  // The UI and the crop path consume either without knowing which ran.
  const img = screen(400, [
    [200, chromeBand(UI_BG, UI_INK, 12)],
    [600, picture()],
    [200, chromeBand(UI_BG, UI_INK, 12)],
  ]);
  const chrome = detectChrome(img);
  const voids = detectVoids(img);
  for (const key of ["width", "height", "top", "bottom", "left", "right", "sides", "crop", "blankImage", "hasVoid", "rotated"]) {
    assert.ok(key in chrome, `missing ${key}`);
  }
  assert.deepEqual(Object.keys(chrome.sides).sort(), Object.keys(voids.sides).sort());
  for (const side of ["top", "bottom", "left", "right"]) {
    assert.deepEqual(Object.keys(chrome.sides[side]).sort(), Object.keys(voids.sides[side]).sort());
  }
});
