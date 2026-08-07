// Unit tests for the void measurement. Run: npm test
//
// The "real screenshot" group at the bottom reproduces failures found by testing
// on an actual iPhone; each carries the wrong value it used to produce so a
// regression is obvious.
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectVoids, detectVoidsAuto, cropRect, colorName } from "../public/detect.js";
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
