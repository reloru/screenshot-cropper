# Screenshot Cropper

Phone screenshots come with dead space: black letterbox bars around a video
frame, white margins above and below page content, a solid status-bar strip.
This measures those blank bands exactly, tells you how big they are, and crops
them off.

**Everything runs in the browser.** The image is read, measured, cropped, and
handed to the share sheet without ever leaving the device. There is no upload,
no storage, and no cache — the Worker serves a `Content-Security-Policy` with
`connect-src 'none'`, so the page is *incapable* of making a network request.
That's enforced by the browser, not just promised here.

## How it works

1. **Pick an image** — tap the picker, or drag a file in, or paste from the
   clipboard.
2. **It measures the voids** — how many pixels of blank space sit on the top,
   bottom, left, and right, as pixels, as a percentage, and with the band's
   actual color.
3. **Choose what to trim** — every side has a checkbox and an editable pixel
   value, so you can drop one bar and keep another, or type your own number.
   Shaded overlays on the preview show exactly what's going.
4. **Save** — opens the phone's native share sheet, where **Save Image** puts it
   in Photos and **Save to Files** puts it wherever you like. Browsers without
   file sharing (most desktops) download the file instead.

### Detection

`public/detect.js` scans inward from each edge, counting blank lines. Every rule
below exists because of a specific failure on a real phone screenshot — the
naive version (match one color sampled at the edge, stop at the first line that
disagrees) is wrong in three separate ways.

- **A line's reference color is its own median**, not a color sampled once at
  the edge, and not pixel 0 — on a noisy bar pixel 0 is frequently itself a
  speckle, and then every other pixel "disagrees" with it and a solid black bar
  reads as content.
- **A line is blank if it is uniform in itself**, with a 2% noise budget. It is
  not required to match the edge's color. That is what lets a **gradient
  background** read as blank: each row of it is flat, even though the color at
  the bottom is nothing like the color at the top.
- **Drift is allowed, jumps are not.** The band's color may creep from line to
  line (gradient → keeps going), but a jump larger than ~40 starts a new block.
  So a 44px black status bar above a solid blue app header reports the black bar
  only, and offers the header as a `+80 px more` chip. A colored header is never
  swallowed silently.
- **A failed line does not end the band — 18 consecutive failures do.** Bars in
  a compressed photo are full of speckle, and stopping at the first bad line
  meant a single dirty row inside a 180px bar measured the whole thing as `0`.
- **Rows are measured first, then columns across only the surviving rows.** A
  black bar along the top otherwise makes every column start with black pixels,
  which hides real margins on the sides.

**Auto** (the default) doesn't ask you to pick a tolerance. It sweeps ten of
them per side and takes the *plateau* — the longest run of near-identical
answers. A real edge is a huge discontinuity, so the measurement goes flat
across a wide band of tolerances once it clears the noise floor, while a
noise-limited measurement creeps upward with every step. Taking the flat part
lands on the true edge. Each side sweeps independently, since one screenshot can
have crisp black bars top and bottom and a soft gradient at the sides.

Exact / Normal / Loose remain as manual overrides.

**Straightened photos are out of scope by construction.** If you rotate a photo,
the black fills the *corners* as triangles — no whole row or column is ever
blank, so there is no rectangle to trim. The app detects that shape and says so
rather than showing four zeroes that look like a bug.

## Develop

```sh
npm install
npm run dev        # wrangler dev on http://localhost:8787
npm test           # unit tests for the measuring maths
npm run deploy     # wrangler deploy
```

### Tests

- `npm test` — `node --test`, no browser. Covers the measurement rules against
  synthetic images built by `scripts/png.mjs` (a dependency-free PNG codec used
  only by tests): per-edge bands, the rows-before-columns ordering, the noise
  budget, tolerance behavior, transparent borders, an all-blank image, and the
  clamping of hand-entered overrides.
- `NODE_PATH=/opt/node22/lib/node_modules node scripts/test-e2e.mjs` — the same
  thing in a real browser: boots `wrangler dev`, uploads a fixture PNG with
  known bands, asserts the on-screen numbers, exercises the checkboxes and the
  manual override, then saves the file and decodes it to confirm the output
  dimensions and that the bands are actually gone. Also checks the security
  headers. Needs Playwright + Chromium available.

**One thing no test can cover: the share sheet itself.** `navigator.share()`
requires a real device and a real user tap, so after deploying, open the site on
a phone, crop something, tap **Save**, and confirm the sheet appears and
**Save Image** lands it in Photos.

## Layout

```
public/          the entire app — served as static assets, no build step
  index.html
  app.css
  app.js         UI wiring (ES module)
  detect.js      pure measurement logic, imported by the app AND the tests
src/worker.js    serves public/ and stamps the security headers
wrangler.jsonc   run_worker_first: true, so the Worker sees every request
```

`detect.js` has no DOM dependencies and is imported unchanged by both the
browser and the Node test suite, so the tested code is the shipped code.

### Gotcha worth knowing before editing `app.js`

The cropped file is built **ahead of** the Save tap, not inside its handler.
iOS Safari only honors `navigator.share()` while the tap's transient activation
is alive, and `canvas.toBlob()` is asynchronous — awaiting it inside the click
handler loses the activation and the share sheet silently never opens. Keep the
encode debounced on change, and keep `share()` as the first thing the handler
does.
