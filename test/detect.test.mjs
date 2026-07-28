// Unit tests for the void measurement. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { detectVoids, cropRect, colorName } from "../public/detect.js";
import { makeImage, setPixel, encodePng, decodePng } from "../scripts/png.mjs";

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

test("noise budget absorbs a few stray pixels but not a real edge", () => {
  const img = makeImage({ width: 1000, height: 200, top: 50, band: WHITE });
  // 4 off pixels in a 1000px row is 0.4% — under the 0.5% budget.
  for (let x = 0; x < 4; x++) setPixel(img, x, 10, [12, 200, 30, 255]);
  assert.equal(detectVoids(img).top, 50, "sub-budget speckle stays blank");

  // 12 off pixels is 1.2% — over budget, so row 10 ends the band.
  for (let x = 0; x < 12; x++) setPixel(img, x, 10, [12, 200, 30, 255]);
  assert.equal(detectVoids(img).top, 10, "over-budget row ends the band");
});

test("tolerance controls how much drift still counts as blank", () => {
  const img = makeImage({ width: 100, height: 100, top: 30, band: WHITE });
  // Shade the first 10 rows slightly off-white, the way JPEG recompression does.
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 100; x++) setPixel(img, x, y, [249, 249, 249, 255]);
  }
  assert.equal(detectVoids(img, { tolerance: 0 }).top, 10, "exact match splits the shades");
  assert.equal(detectVoids(img, { tolerance: 8 }).top, 30, "normal tolerance merges them");
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

test("a vertical gradient terminates quickly and finds no void", () => {
  // Every row here is uniform in itself but differs from its neighbour. The
  // band scan must not recurse per row while looking for the next band.
  const width = 64;
  const height = 256;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = y;
      data[o + 3] = 255;
    }
  }
  const r = detectVoids({ data, width, height }, { tolerance: 0 });
  assert.equal(r.top, 1);
  assert.equal(r.sides.top.nextPx, 1);
});

test("cropRect clamps hand-entered overrides", () => {
  const img = { width: 100, height: 100 };
  assert.deepEqual(cropRect(img, { top: -5, bottom: 0, left: 0, right: 0 }), { x: 0, y: 0, width: 100, height: 100 });
  const squashed = cropRect(img, { top: 90, bottom: 90, left: 0, right: 0 });
  assert.ok(squashed.height >= 1, "overlapping trims still leave a pixel");
  assert.deepEqual(cropRect(img, { top: 10.6, bottom: 0, left: 0, right: 0 }).y, 11, "fractional input rounds");
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
