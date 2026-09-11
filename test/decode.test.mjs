// Tests for the debug decoder. PNG only on purpose: that path needs neither
// Chromium nor the HEIC WASM, so `npm test` stays fast and hermetic. The other
// two decoders are exercised by running scripts/inspect.mjs against real files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decode, decodeAll } from "../scripts/decode.mjs";
import { makeImage, encodePng } from "../scripts/png.mjs";

const dir = mkdtempSync(join(tmpdir(), "decode-test-"));

function fixture(name, spec) {
  const path = join(dir, name);
  writeFileSync(path, encodePng(makeImage(spec)));
  return path;
}

test("decodes a PNG to the shape the detectors take", async () => {
  const path = fixture("a.png", { width: 40, height: 25, top: 5, left: 3 });
  const img = await decode(path);
  assert.equal(img.width, 40);
  assert.equal(img.height, 25);
  assert.equal(img.data.length, 40 * 25 * 4, "RGBA, four bytes a pixel");
  assert.ok(img.data instanceof Uint8ClampedArray, "the detectors index this directly");
});

test("a bad file in a batch does not lose the others", async () => {
  // The whole point of a batch tool is measuring a folder of real screenshots,
  // where one unreadable file should cost one measurement, not all of them.
  const good = fixture("good.png", { width: 20, height: 20 });
  const missing = join(dir, "nope.png");
  const weird = join(dir, "thing.xyz");
  writeFileSync(weird, "not an image");

  const results = await decodeAll([good, missing, weird]);
  assert.equal(results.length, 3, "one result per input, in order");
  assert.equal(results[0].width, 20, "the readable one still measured");
  assert.ok(results[1].error, "a missing file reports an error rather than throwing");
  assert.match(results[2].error, /unsupported extension/, "and so does an unknown format");
});

test("results come back in the order they were asked for", async () => {
  const a = fixture("one.png", { width: 10, height: 10 });
  const b = fixture("two.png", { width: 11, height: 11 });
  const results = await decodeAll([b, a]);
  assert.equal(results[0].width, 11, "b first, as passed");
  assert.equal(results[1].width, 10);
});
