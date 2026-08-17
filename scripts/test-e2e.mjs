#!/usr/bin/env node
// End-to-end test in a real browser: boots `wrangler dev`, uploads a fixture
// PNG with known blank bands, and checks that the page measures them exactly,
// crops to the right size, and hands back a real image file.
//
//   NODE_PATH=/opt/node22/lib/node_modules node scripts/test-e2e.mjs
//
// The unit tests cover the measuring maths in isolation; this covers the parts
// only a browser has — canvas getImageData, toBlob encoding, the download path,
// and the security headers the Worker stamps on the way out.
//
// Not covered here, because no automation can: the iOS share sheet itself.
// navigator.share needs a real device with a real user tap. See README.
//
// Env overrides: PORT (default 8811), PW_CHROMIUM (default /opt/pw-browsers/chromium).

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { makeImage, encodePng, decodePng } from "./png.mjs";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/opt/node22/lib/node_modules/playwright"));
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.PORT || "8811";
const BASE = `http://127.0.0.1:${PORT}`;
const CHROMIUM = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";

// The fixture: a 400x600 image with a 120px black bar on top, 80px on the
// bottom, and 40px black margins either side.
const FIXTURE = { width: 400, height: 600, top: 120, bottom: 80, left: 40, right: 40 };
const EXPECT_CROP = {
  width: FIXTURE.width - FIXTURE.left - FIXTURE.right,
  height: FIXTURE.height - FIXTURE.top - FIXTURE.bottom,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => {
  console.log(`  ✗ ${m}`);
  failures++;
};
const eq = (actual, expected, label) =>
  actual === expected ? ok(label) : bad(`${label} — expected ${expected}, got ${actual}`);

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + "/");
      if (r.ok) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

let server;
let browser;
const profile = mkdtempSync(join(tmpdir(), "cropper-e2e-"));

try {
  console.log("Booting wrangler dev...");
  server = spawn("npx", ["wrangler", "dev", "--port", PORT, "--local"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", () => {});

  if (!(await waitForServer(90_000))) throw new Error("wrangler dev never became ready");
  ok("dev server up");

  // --- Worker-level checks -------------------------------------------------
  const res = await fetch(BASE + "/");
  const csp = res.headers.get("content-security-policy") || "";
  eq(res.status, 200, "GET / returns 200");
  csp.includes("connect-src 'none'")
    ? ok("CSP forbids network requests from the page")
    : bad(`CSP missing connect-src 'none' (got: ${csp})`);
  eq(res.headers.get("x-content-type-options"), "nosniff", "nosniff header present");
  eq((await fetch(BASE + "/app.js")).status, 200, "app.js is served");
  eq((await fetch(BASE + "/detect.js")).status, 200, "detect.js is served");

  // --- Browser checks ------------------------------------------------------
  browser = await chromium.launch({ executablePath: CHROMIUM });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });

  await page.goto(BASE + "/", { waitUntil: "load" });

  const png = encodePng(makeImage(FIXTURE));
  await page.setInputFiles("#file", {
    name: "IMG_0042.png",
    mimeType: "image/png",
    buffer: png,
  });

  await page.waitForSelector("#work:not([hidden])", { timeout: 10_000 });
  await page.waitForFunction(() => !document.getElementById("save").disabled, null, {
    timeout: 10_000,
  });
  ok("image loaded and a cropped file was prepared");

  for (const [side, expected] of Object.entries({
    top: FIXTURE.top,
    bottom: FIXTURE.bottom,
    left: FIXTURE.left,
    right: FIXTURE.right,
  })) {
    const value = await page.inputValue(`#px-${side}`);
    eq(Number(value), expected, `${side} void measured as ${expected}px`);
    eq(await page.isChecked(`#use-${side}`), true, `${side} is selected for cropping`);
  }

  const summary = await page.textContent("#summary");
  summary.includes(`${EXPECT_CROP.width} × ${EXPECT_CROP.height}`)
    ? ok(`summary reports the cropped size (${EXPECT_CROP.width} × ${EXPECT_CROP.height})`)
    : bad(`summary did not report the cropped size: ${summary}`);

  const bandLabel = await page.textContent(".band-top span");
  eq(bandLabel.trim(), `${FIXTURE.top} px`, "the top band overlay is labelled");

  // Unchecking a side must widen the crop back out.
  await page.uncheck("#use-top");
  await page.waitForFunction(
    (h) => document.getElementById("summary").textContent.includes(String(h)),
    EXPECT_CROP.height + FIXTURE.top,
    { timeout: 5000 },
  );
  ok("unchecking a side puts those pixels back");
  await page.check("#use-top");

  // Manual override.
  await page.fill("#px-left", "10");
  await page.waitForFunction(
    (w) => document.getElementById("summary").textContent.includes(String(w)),
    EXPECT_CROP.width + FIXTURE.left - 10,
    { timeout: 5000 },
  );
  ok("typing a value overrides the detected one");
  await page.fill("#px-left", String(FIXTURE.left));

  // The real payoff: the saved file is a correctly cropped PNG. Chromium has
  // no share sheet, so Save takes the download fallback — which is exactly the
  // desktop behaviour we want to verify.
  await page.waitForFunction(() => !document.getElementById("save").disabled, null, {
    timeout: 5000,
  });
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }),
    page.click("#save"),
  ]);
  eq(download.suggestedFilename(), "IMG_0042-cropped.png", "cropped file keeps a sensible name");

  const outPath = join(profile, "out.png");
  await download.saveAs(outPath);
  const decoded = decodePng(readFileSync(outPath));
  eq(decoded.width, EXPECT_CROP.width, "saved image width");
  eq(decoded.height, EXPECT_CROP.height, "saved image height");

  // Every pixel of the output should be content, not band colour.
  const corner = [decoded.data[0], decoded.data[1], decoded.data[2]];
  corner.some((c) => c > 20)
    ? ok("the black bands are gone from the saved image")
    : bad(`top-left pixel is still band-coloured: rgb(${corner.join(",")})`);

  // --- The real-world case: a noisy letterboxed photo on Auto ---------------
  // Bars that are near-black with compression speckle and a soft ramp. Before
  // the flat/drift/grace rewrite this measured 0 on the default setting.
  await page.click("#reset");
  await page.waitForFunction(() => document.getElementById("work").hidden, null, { timeout: 5000 });

  const BAR = 180;
  const lw = 700;
  const lh = 1200;
  const noisy = new Uint8ClampedArray(lw * lh * 4);
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      const o = (y * lw + x) * 4;
      const inBar = y < BAR || y >= lh - BAR;
      let v;
      if (inBar) {
        v = rnd() < 0.004 ? 8 + Math.round(rnd() * 34) : 0;
        const d = Math.min(Math.abs(y - BAR), Math.abs(y - (lh - BAR)));
        if (d < 14) v = Math.max(v, Math.round(((14 - d) / 14) * 26));
      } else {
        v = 60 + Math.round(rnd() * 180);
      }
      noisy[o] = v;
      noisy[o + 1] = inBar ? v : Math.min(255, v + 40);
      noisy[o + 2] = v;
      noisy[o + 3] = 255;
    }
  }
  await page.setInputFiles("#file", {
    name: "letterboxed.png",
    mimeType: "image/png",
    buffer: encodePng({ data: noisy, width: lw, height: lh }),
  });
  await page.waitForFunction(() => !document.getElementById("save").disabled, null, { timeout: 20_000 });

  const autoActive = await page.getAttribute('.tolerance button[data-tolerance="auto"]', "aria-checked");
  eq(autoActive, "true", "Auto is the default strictness");

  for (const side of ["top", "bottom"]) {
    const got = Number(await page.inputValue(`#px-${side}`));
    Math.abs(got - BAR) <= 3
      ? ok(`noisy letterbox ${side} measured ${got}px (expected ~${BAR}) without touching strictness`)
      : bad(`noisy letterbox ${side} measured ${got}px, expected ~${BAR}`);
  }
  for (const side of ["left", "right"]) {
    const got = Number(await page.inputValue(`#px-${side}`));
    eq(got, 0, `noisy letterbox has no ${side} void`);
  }

  // --- Format selection ----------------------------------------------------
  // A PNG source on Auto must stay PNG: cropping only drops pixels, so there is
  // no reason to re-encode it lossily.
  await page.click('[data-format="jpeg"]');
  await page.waitForFunction(() => !document.getElementById("save").disabled, null, { timeout: 10_000 });
  const [jpegDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }),
    page.click("#save"),
  ]);
  eq(jpegDl.suggestedFilename().endsWith(".jpg"), true, "JPEG format produces a .jpg file");

  await page.click('[data-format="auto"]');
  await page.waitForFunction(() => !document.getElementById("save").disabled, null, { timeout: 10_000 });
  const [autoDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }),
    page.click("#save"),
  ]);
  eq(autoDl.suggestedFilename().endsWith(".png"), true, "Auto keeps a PNG source as PNG");

  // --- Copy to clipboard ---------------------------------------------------
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const copyVisible = await page.isVisible("#copy");
  copyVisible ? ok("Copy is offered for a single image") : bad("Copy button never appeared");
  if (copyVisible) {
    // Whatever image is loaded right now — read the expected size off the page
    // rather than assuming, since earlier sections swap the fixture.
    const shown = (await page.textContent("#summary")).match(/cropped\s+(\d+)\s*×\s*(\d+)/);
    const want = shown ? { w: Number(shown[1]), h: Number(shown[2]) } : null;

    await page.click("#copy");
    await page.waitForFunction(
      () => document.getElementById("save-hint").textContent.includes("Copied"),
      null,
      { timeout: 10_000 },
    );
    const copied = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const png = items.find((i) => i.types.includes("image/png"));
      if (!png) return null;
      const blob = await png.getType("image/png");
      const bmp = await createImageBitmap(blob);
      return { w: bmp.width, h: bmp.height, type: blob.type };
    });
    copied && want && copied.w === want.w && copied.h === want.h
      ? ok(`clipboard holds the cropped image (${copied.w} × ${copied.h})`)
      : bad(`clipboard image wrong: got ${JSON.stringify(copied)}, expected ${JSON.stringify(want)}`);
    // Even with JPEG selected a moment ago, the clipboard copy must be PNG —
    // it is the only bitmap type browsers reliably accept on write.
    copied && copied.type === "image/png"
      ? ok("clipboard copy is PNG regardless of the save format")
      : bad(`clipboard type was ${copied && copied.type}`);
  }

  // --- App interface mode ---------------------------------------------------
  // A feed screenshot: nothing in it is blank, so the void scan has nothing to
  // say. The picture is in the MIDDLE, with interface above it, interface below
  // it, and the next post already showing at the bottom edge.
  await page.click("#reset");
  await page.waitForFunction(() => document.getElementById("work").hidden, null, { timeout: 5000 });

  const fw = 800;
  const feedBands = [
    [320, "chrome"], // status bar, nav bar, username, caption
    [900, "picture"],
    [360, "chrome"], // likes, caption, date, next account row
    [300, "picture"], // the next post, running off the bottom edge
  ];
  const fh = feedBands.reduce((n, [h]) => n + h, 0);
  const feed = new Uint8ClampedArray(fw * fh * 4);
  let fy = 0;
  for (const [h, kind] of feedBands) {
    for (let y = fy; y < fy + h; y++) {
      for (let x = 0; x < fw; x++) {
        const o = (y * fw + x) * 4;
        let px;
        if (kind === "chrome") {
          // Flat #0C0F14 with sparse high-contrast glyphs on it. The text runs
          // are 24 rows deep on a 30-row pitch, like real lines of type — that
          // matters, because runs shorter than the void scan's 18-row grace
          // window let it walk straight through the band and call it blank.
          const inked = x > 40 && x < fw - 40 && y % 30 < 24 && (x * 7 + y * 13) % 97 < 11;
          px = inked ? [235, 236, 238] : [12, 15, 20];
        } else {
          px = [40 + ((x * 53 + y * 31) % 190), 30 + ((x * 17 + y * 7) % 200), 60 + ((x * 29 + y * 11) % 170)];
        }
        feed[o] = px[0];
        feed[o + 1] = px[1];
        feed[o + 2] = px[2];
        feed[o + 3] = 255;
      }
    }
    fy += h;
  }
  await page.setInputFiles("#file", {
    name: "feed.png",
    mimeType: "image/png",
    buffer: encodePng({ data: feed, width: fw, height: fh }),
  });
  await page.waitForFunction(() => !document.getElementById("save").disabled, null, { timeout: 20_000 });

  // Blank-edges mode is still the default and correctly finds nothing here.
  eq(Number(await page.inputValue("#px-top")), 0, "blank-edges mode finds no void in a feed screenshot");
  eq(await page.isVisible("#offer"), true, "and offers the interface crop instead");

  await page.click("#offer-go");
  await page.waitForFunction(
    () => document.getElementById("panel-title").textContent.includes("interface"),
    null,
    { timeout: 5000 },
  );
  eq(Number(await page.inputValue("#px-top")), 320, "interface above the picture measured");
  eq(
    Number(await page.inputValue("#px-bottom")),
    660,
    "interface below it AND the next post trimmed — an edge scan cannot do this",
  );
  eq(await page.isVisible("#strictness"), false, "strictness is hidden — interface mode has no tolerance dial");
  eq(await page.isVisible("#offer"), false, "the offer goes away once taken");

  await page.waitForFunction(() => !document.getElementById("save").disabled, null, { timeout: 20_000 });
  const [feedDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }),
    page.click("#save"),
  ]);
  const feedPath = join(profile, "feed-out.png");
  await feedDl.saveAs(feedPath);
  const feedOut = decodePng(readFileSync(feedPath));
  eq(feedOut.width, 800, "saved interface crop width");
  eq(feedOut.height, 900, "saved interface crop height");
  // The proof: no row of the result is dominated by one colour the way an
  // interface row is.
  let flattest = 0;
  for (const y of [0, 1, feedOut.height - 2, feedOut.height - 1]) {
    const bins = new Map();
    for (let x = 0; x < feedOut.width; x++) {
      const o = (y * feedOut.width + x) * 4;
      const k = ((feedOut.data[o] >> 3) << 10) | ((feedOut.data[o + 1] >> 3) << 5) | (feedOut.data[o + 2] >> 3);
      bins.set(k, (bins.get(k) || 0) + 1);
    }
    flattest = Math.max(flattest, Math.max(...bins.values()) / feedOut.width);
  }
  flattest < 0.5
    ? ok("the interface bands are gone from the saved image")
    : bad(`a saved edge row is ${(flattest * 100).toFixed(0)}% one colour — interface survived the crop`);

  // --- Interface + edges ---------------------------------------------------
  // Same shape, but with the leftover a real batch showed: a few rows of
  // near-black between the band and the picture, flat enough for the void scan
  // to call it blank but not EVEN enough for the interface pass, which
  // therefore reads it as picture and keeps it. Invisible on a phone preview,
  // plainly there in the saved file.
  await page.click("#reset");
  await page.waitForFunction(() => document.getElementById("work").hidden, null, { timeout: 5000 });

  const LEFT_OVER = 8;
  const ovW = 800;
  const ovBands = [
    [300, "chrome"],
    [LEFT_OVER, "leftover"],
    [900, "picture"],
    [LEFT_OVER, "leftover"],
    [300, "chrome"],
  ];
  const ovH = ovBands.reduce((n, [h]) => n + h, 0);
  const shot = new Uint8ClampedArray(ovW * ovH * 4);
  let ovY = 0;
  for (const [h, kind] of ovBands) {
    for (let y = ovY; y < ovY + h; y++) {
      for (let x = 0; x < ovW; x++) {
        const o = (y * ovW + x) * 4;
        let px;
        if (kind === "chrome") {
          const inked = x > 40 && x < ovW - 40 && y % 30 < 24 && (x * 7 + y * 13) % 97 < 11;
          px = inked ? [235, 236, 238] : [12, 15, 20];
        } else if (kind === "leftover") {
          const d = ((x * 2654435761 + y * 40503) >>> 0) % 4;
          px = [12 + d, 15 + d, 20 + d];
        } else {
          px = [40 + ((x * 53 + y * 31) % 190), 30 + ((x * 17 + y * 7) % 200), 60 + ((x * 29 + y * 11) % 170)];
        }
        shot[o] = px[0];
        shot[o + 1] = px[1];
        shot[o + 2] = px[2];
        shot[o + 3] = 255;
      }
    }
    ovY += h;
  }
  await page.setInputFiles("#file", {
    name: "leftover.png",
    mimeType: "image/png",
    buffer: encodePng({ data: shot, width: ovW, height: ovH }),
  });
  await page.waitForFunction(() => !document.getElementById("save").disabled, null, { timeout: 20_000 });

  await page.click('#work [data-mode="chrome"]');
  await page.waitForFunction(
    () => document.getElementById("panel-title").textContent === "App interface found",
    null,
    { timeout: 5000 },
  );
  eq(Number(await page.inputValue("#px-top")), 300, "interface mode stops at the band and keeps the leftover");

  await page.click('#work [data-mode="both"]');
  await page.waitForFunction(
    () => document.getElementById("panel-title").textContent.includes("edges"),
    null,
    { timeout: 5000 },
  );
  eq(Number(await page.inputValue("#px-top")), 300 + LEFT_OVER, "interface + edges takes the leftover too");
  eq(Number(await page.inputValue("#px-bottom")), 300 + LEFT_OVER, "on both ends");
  eq(await page.isVisible("#strictness"), true, "strictness is back — this mode's second stage is the void scan");

  await page.waitForFunction(() => !document.getElementById("save").disabled, null, { timeout: 20_000 });
  const [bothDl] = await Promise.all([
    page.waitForEvent("download", { timeout: 15_000 }),
    page.click("#save"),
  ]);
  const bothPath = join(profile, "both-out.png");
  await bothDl.saveAs(bothPath);
  const bothOut = decodePng(readFileSync(bothPath));
  eq(bothOut.height, 900, "saved size is the picture exactly, leftover and all");
  // The point of the whole mode: the first and last rows of the file are
  // picture, not a strip of near-black that looked like nothing on screen.
  let edgeFlat = 0;
  for (const y of [0, bothOut.height - 1]) {
    const bins = new Map();
    for (let x = 0; x < bothOut.width; x++) {
      const o = (y * bothOut.width + x) * 4;
      const k = ((bothOut.data[o] >> 3) << 10) | ((bothOut.data[o + 1] >> 3) << 5) | (bothOut.data[o + 2] >> 3);
      bins.set(k, (bins.get(k) || 0) + 1);
    }
    edgeFlat = Math.max(edgeFlat, Math.max(...bins.values()) / bothOut.width);
  }
  edgeFlat < 0.5
    ? ok("no near-black leftover survives on the saved edges")
    : bad(`a saved edge row is ${(edgeFlat * 100).toFixed(0)}% one colour — the leftover survived`);

  // Scoped to the editor: the batch panel carries its own copy of these pills.
  await page.click('#work [data-mode="void"]');
  await page.waitForFunction(
    () => !document.getElementById("panel-title").textContent.includes("interface"),
    null,
    { timeout: 5000 },
  );
  eq(await page.isVisible("#strictness"), true, "strictness comes back in blank-edges mode");

  // --- Batch mode ----------------------------------------------------------
  await page.click("#reset");
  await page.waitForFunction(() => document.getElementById("pick").hidden === false, null, { timeout: 5000 });

  const batchFixtures = [
    { name: "one.png", spec: { width: 300, height: 400, top: 60, bottom: 40 } },
    { name: "two.png", spec: { width: 300, height: 400, left: 25, right: 25 } },
    { name: "three.png", spec: { width: 300, height: 400 } }, // nothing to trim
  ];
  await page.setInputFiles(
    "#file",
    batchFixtures.map((f) => ({
      name: f.name,
      mimeType: "image/png",
      buffer: encodePng(makeImage(f.spec)),
    })),
  );
  await page.waitForFunction(() => document.getElementById("batch").hidden === false, null, {
    timeout: 20_000,
  });
  await page.waitForFunction(() => !document.getElementById("save").disabled, null, { timeout: 30_000 });
  ok("three images processed into the batch list");

  eq(await page.locator(".batch-row").count(), 3, "one row per image");
  const saveLabel = await page.textContent("#save");
  eq(saveLabel.trim(), "Save all 3", "Save button reflects the batch");
  eq(await page.isVisible("#copy"), false, "Copy is hidden for a batch");

  const rowText = await page.locator(".batch-row").nth(0).textContent();
  rowText.includes("300×400")
    ? ok("batch rows show original and cropped dimensions")
    : bad(`batch row text unexpected: ${rowText}`);

  // Excluding one image must drop it from the save set.
  await page.locator(".batch-use").nth(2).uncheck();
  await page.waitForFunction(
    () => document.getElementById("save").textContent.includes("Save all 2"),
    null,
    { timeout: 10_000 },
  );
  ok("unchecking an image removes it from the save set");

  // Downloads: two files, each cropped correctly.
  const downloads = [];
  page.on("download", (d) => downloads.push(d));
  await page.click("#save");
  const deadline = Date.now() + 20_000;
  while (downloads.length < 2 && Date.now() < deadline) await sleep(250);
  eq(downloads.length, 2, "batch save produced two files");
  if (downloads.length >= 2) {
    const sizes = [];
    for (const d of downloads) {
      const p = join(profile, d.suggestedFilename());
      await d.saveAs(p);
      const dec = decodePng(readFileSync(p));
      sizes.push(`${dec.width}x${dec.height}`);
    }
    sizes.includes("300x300") && sizes.includes("250x400")
      ? ok(`each batch file cropped independently (${sizes.join(", ")})`)
      : bad(`batch crop sizes wrong: ${sizes.join(", ")}`);
  }

  // Adjusting one image from the batch and coming back.
  await page.locator(".batch-tune").nth(0).click();
  await page.waitForFunction(() => document.getElementById("work").hidden === false, null, { timeout: 10_000 });
  eq(Number(await page.inputValue("#px-top")), 60, "Adjust opens that image's own measurements");
  await page.click("#back");
  await page.waitForFunction(() => document.getElementById("batch").hidden === false, null, { timeout: 10_000 });
  ok("Back returns to the batch list");

  // Start over must clear everything.
  await page.click("#reset");
  await page.waitForFunction(
    () => document.getElementById("work").hidden && document.getElementById("preview").width === 0,
    null,
    { timeout: 5000 },
  );
  ok("Start over clears the loaded image and releases the canvas");

  if (pageErrors.length) {
    bad(`page logged errors: ${pageErrors.join(" | ")}`);
  } else {
    ok("no console or page errors");
  }
} catch (err) {
  bad(`harness error: ${err && err.stack ? err.stack : err}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) {
    server.kill("SIGTERM");
    await sleep(500);
    server.kill("SIGKILL");
  }
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll end-to-end checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
