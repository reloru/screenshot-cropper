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

`public/detect.js` scans inward from each edge. A row or column counts as blank
while every pixel matches the band's color within a tolerance — with a 0.5%
noise budget, so one stray antialiased pixel doesn't reset a 1290px-wide row to
zero. Fully transparent bands count as blank too.

Two details that matter in practice:

- **Rows are measured first, then columns across only the surviving rows.** A
  black bar along the top otherwise makes every column start with black pixels,
  which hides real margins on the sides.
- **Scanning stops at the first color change.** A 44px black status bar over a
  60px white strip reports the black bar only — a solid-colored app header must
  never be swallowed silently. The next band is offered as a `+60 px more` chip
  you can tap.

Strictness is adjustable: **Exact** (identical pixels only), **Normal**
(tolerates recompression drift), **Loose** (tolerates a gently shaded
background).

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
