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
