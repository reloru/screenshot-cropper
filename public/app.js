// Screenshot Cropper — UI wiring.
//
// The whole pipeline is local: File -> ImageBitmap -> canvas pixels ->
// detectVoids() -> crop canvas -> Blob -> share sheet / clipboard. There is no
// fetch() in this file, and the Content-Security-Policy the Worker sends
// (connect-src 'none') means there could not be one.
//
// One image and many images run the same path: state.items always holds the
// list, and a single item just opens straight into the editor.

import { detectVoids, detectVoidsAuto, detectChrome, cropRect } from "./detect.js";
import {
  MAX_PIXELS,
  canCopyImages,
  canShareFiles,
  copyImage,
  decodeImage,
  downloadFile,
  encodeCrop,
  formatBytes,
  hasTransparency,
  makeThumb,
  outputName,
  outputType,
  readPixels,
  releaseSource,
  sourceSize,
} from "./pipeline.js";

const SIDES = ["top", "bottom", "left", "right"];
const LABELS = { top: "Top", bottom: "Bottom", left: "Left", right: "Right" };

const el = {
  pick: document.getElementById("pick"),
  file: document.getElementById("file"),
  pickError: document.getElementById("pick-error"),
  progress: document.getElementById("progress"),
  progressText: document.getElementById("progress-text"),
  progressBar: document.getElementById("progress-bar"),
  batch: document.getElementById("batch"),
  batchTitle: document.getElementById("batch-title"),
  batchList: document.getElementById("batch-list"),
  batchSummary: document.getElementById("batch-summary"),
  batchAdd: document.getElementById("batch-add"),
  work: document.getElementById("work"),
  back: document.getElementById("back"),
  preview: document.getElementById("preview"),
  sides: document.getElementById("sides"),
  summary: document.getElementById("summary"),
  warning: document.getElementById("warning"),
  output: document.getElementById("output"),
  formatNote: document.getElementById("format-note"),
  save: document.getElementById("save"),
  copy: document.getElementById("copy"),
  reset: document.getElementById("reset"),
  saveHint: document.getElementById("save-hint"),
  rowTemplate: document.getElementById("side-row"),
  batchTemplate: document.getElementById("batch-row"),
  panelTitle: document.getElementById("panel-title"),
  strictness: document.getElementById("strictness"),
  offer: document.getElementById("offer"),
  offerText: document.getElementById("offer-text"),
  offerGo: document.getElementById("offer-go"),
  tolerance: document.querySelectorAll("[data-tolerance]"),
  mode: document.querySelectorAll("[data-mode]"),
  format: document.querySelectorAll("[data-format]"),
  bands: {},
};
for (const side of SIDES) el.bands[side] = document.querySelector(`.band-${side}`);

const state = {
  items: [], // { file, name, width, height, detections, detection, trim, use, outFile, thumbUrl, include, error }
  editing: null, // index into items, or null when showing the batch list
  open: null, // { source, imageData } for the item being edited
  tolerance: "auto",
  // "void"   — blank bands at the edges (the original behaviour)
  // "chrome" — the app interface around a picture, which is not blank at all
  mode: "void",
  format: "auto",
  buildId: 0,
};

// Wording that differs between the two detectors, kept in one place so the
// heading, the batch summary and the empty states cannot drift apart.
const MODE_COPY = {
  void: { title: "Blank space found", noun: "blank space", empty: "no blank edge" },
  chrome: { title: "App interface found", noun: "interface", empty: "no interface" },
};

const isBatch = () => state.items.length > 1;
const current = () => (state.editing === null ? null : state.items[state.editing]);

// ---------------------------------------------------------------- side widgets

const rows = {};
for (const side of SIDES) {
  const node = el.rowTemplate.content.firstElementChild.cloneNode(true);
  const row = {
    root: node,
    use: node.querySelector(".side-use"),
    name: node.querySelector(".side-name"),
    px: node.querySelector(".side-px"),
    pct: node.querySelector(".side-pct"),
    swatch: node.querySelector(".side-swatch"),
    color: node.querySelector(".side-color"),
    extend: node.querySelector(".side-extend"),
  };
  row.use.id = `use-${side}`;
  row.px.id = `px-${side}`;
  row.name.setAttribute("for", `use-${side}`);
  row.name.textContent = LABELS[side];
  row.px.setAttribute("aria-label", `${LABELS[side]} trim in pixels`);

  row.use.addEventListener("change", () => {
    const item = current();
    if (!item) return;
    item.use[side] = row.use.checked;
    refresh();
  });
  row.px.addEventListener("input", () => {
    const item = current();
    if (!item) return;
    const n = Math.max(0, Math.round(Number(row.px.value) || 0));
    item.trim[side] = n;
    // Typing a number is intent to crop that side; typing zero is intent not to.
    item.use[side] = n > 0;
    row.use.checked = item.use[side];
    refresh();
  });
  row.extend.addEventListener("click", () => {
    const item = current();
    if (!item) return;
    item.trim[side] += Number(row.extend.dataset.extra || 0);
    item.use[side] = true;
    row.extend.hidden = true;
    refresh();
  });

  rows[side] = row;
  el.sides.append(node);
}

// -------------------------------------------------------------------- loading

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f.type.startsWith("image/"));
  if (!files.length) {
    showPickError("No image files there. Pick a PNG, JPEG, or HEIC screenshot.");
    return;
  }
  hidePickError();
  closeEditor();
  el.pick.hidden = true;
  el.progress.hidden = false;

  let failures = 0;
  for (let i = 0; i < files.length; i++) {
    el.progressText.textContent =
      files.length > 1 ? `Measuring ${i + 1} of ${files.length}…` : "Measuring…";
    el.progressBar.style.width = `${Math.round((i / files.length) * 100)}%`;
    // Yield so the progress line actually paints between images.
    await new Promise((r) => setTimeout(r, 0));
    const item = await processFile(files[i]);
    if (item.error) failures++;
    state.items.push(item);
  }

  el.progress.hidden = true;
  el.progressBar.style.width = "0%";
  if (failures) {
    showPickError(
      failures === files.length
        ? "None of those could be read. If they're HEIC photos, try exporting as JPEG first."
        : `${failures} of ${files.length} couldn't be read and were skipped.`,
    );
  }
  state.items = state.items.filter((it) => !it.error);
  if (!state.items.length) {
    el.pick.hidden = false;
    return;
  }

  if (state.items.length === 1) {
    await openEditor(0);
  } else {
    showBatch();
  }
  el.output.hidden = false;
  scheduleBuild();
}

/** Decode, measure, crop and encode one file, holding on to as little as possible. */
async function processFile(file) {
  const item = {
    file,
    name: file.name || "screenshot",
    width: 0,
    height: 0,
    detections: null,
    detection: null,
    trim: { top: 0, bottom: 0, left: 0, right: 0 },
    use: { top: false, bottom: false, left: false, right: false },
    transparent: false,
    outFile: null,
    thumbUrl: null,
    // Which mode this thumbnail was rendered for. It shows the CROPPED result,
    // so it goes stale the moment the mode changes — including for images you
    // were not looking at when you changed it.
    thumbMode: null,
    include: true,
    error: null,
  };

  let source = null;
  try {
    source = await decodeImage(file);
    const { width, height } = sourceSize(source);
    if (!width || !height) throw new Error("no dimensions");
    item.width = width;
    item.height = height;

    const pixels = readPixels(source, width, height);
    // Both detectors run now, while the pixels are decoded and in hand. Each is
    // cheap next to the decode, and having both means switching modes is
    // instant and — more usefully — that the app can tell you when the mode you
    // are in found nothing but the other one would have.
    item.detections = { void: measureWith(pixels), chrome: detectChrome(pixels) };
    applyDetection(item);
    item.transparent = hasTransparency(pixels, item.detection.crop);
    item.thumbUrl = await makeThumb(source, item.detection.crop);
    item.thumbMode = state.mode;
  } catch {
    item.error = "unreadable";
  } finally {
    // Crucially, the decoded bitmap and its pixel buffer are released per image.
    // Holding twenty 4MP ImageDatas would be ~320MB and would kill a phone tab.
    releaseSource(source);
  }
  return item;
}

function measureWith(pixels) {
  return state.tolerance === "auto"
    ? detectVoidsAuto(pixels)
    : detectVoids(pixels, { tolerance: state.tolerance });
}

/** Point an item at the active detector's result and reset its trim to match. */
function applyDetection(item) {
  if (!item.detections) return;
  item.detection = item.detections[state.mode];
  for (const side of SIDES) {
    item.trim[side] = item.detection[side];
    item.use[side] = item.detection[side] > 0;
  }
}

// --------------------------------------------------------------------- editor

async function openEditor(index) {
  closeEditor();
  state.editing = index;
  const item = state.items[index];

  try {
    const source = await decodeImage(item.file);
    state.open = { source, imageData: readPixels(source, item.width, item.height) };
  } catch {
    showPickError("That image could not be re-opened for editing.");
    return;
  }

  el.batch.hidden = true;
  el.work.hidden = false;
  el.back.hidden = !isBatch();
  drawPreview();
  refresh();
}

function closeEditor() {
  if (state.open) {
    releaseSource(state.open.source);
    state.open = null;
  }
  state.editing = null;
  el.preview.width = el.preview.height = 0;
}

function backToBatch() {
  closeEditor();
  el.work.hidden = true;
  showBatch();
  scheduleBuild();
}

function drawPreview() {
  const item = current();
  if (!item || !state.open) return;
  // Draw at display scale rather than natural size: a 12 MP photo does not need
  // a 12 MP canvas sitting in the DOM. The band overlays are positioned in
  // percentages, so they line up at any scale.
  const scale = Math.min(1, 1400 / Math.max(item.width, item.height));
  const w = Math.max(1, Math.round(item.width * scale));
  const h = Math.max(1, Math.round(item.height * scale));
  el.preview.width = w;
  el.preview.height = h;
  const ctx = el.preview.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(state.open.source, 0, 0, w, h);
}

function effective(item, side) {
  return item.use[side] ? item.trim[side] : 0;
}

function rectFor(item) {
  return cropRect(
    { width: item.width, height: item.height },
    {
      top: effective(item, "top"),
      bottom: effective(item, "bottom"),
      left: effective(item, "left"),
      right: effective(item, "right"),
    },
  );
}

function refresh() {
  const item = current();
  if (!item || !item.detection) return;
  const det = item.detection;

  for (const side of SIDES) {
    const row = rows[side];
    const info = det.sides[side];
    const px = item.trim[side];

    row.use.checked = item.use[side];
    if (document.activeElement !== row.px) row.px.value = String(px);
    row.px.max = String(side === "top" || side === "bottom" ? item.height : item.width);
    const total = side === "top" || side === "bottom" ? item.height : item.width;
    row.pct.textContent = px > 0 ? `${((px / total) * 100).toFixed(1)}%` : "—";
    row.root.classList.toggle("is-empty", px === 0);

    if (info.hex) {
      row.swatch.hidden = false;
      row.swatch.style.background = info.alpha === 0 ? "transparent" : info.hex;
      row.color.textContent = info.name ? `${info.hex} ${info.name}` : info.hex;
    } else {
      row.swatch.hidden = true;
      row.color.textContent = px > 0 ? "manual" : MODE_COPY[state.mode].empty;
    }

    // Offer the next solid band only while the auto value is untouched —
    // otherwise the offer no longer matches what the number says.
    const canExtend = info.nextPx > 0 && px === det[side] && px > 0;
    row.extend.hidden = !canExtend;
    if (canExtend) {
      row.extend.dataset.extra = String(info.nextPx);
      row.extend.textContent = `+${info.nextPx} px more`;
    }
  }

  for (const side of SIDES) {
    const band = el.bands[side];
    const px = effective(item, side);
    const vertical = side === "top" || side === "bottom";
    const pct = ((px / (vertical ? item.height : item.width)) * 100).toFixed(4) + "%";
    band.hidden = px === 0;
    band.querySelector("span").textContent = `${px} px`;
    if (vertical) {
      band.style.height = pct;
    } else {
      band.style.width = pct;
      band.style.top = ((effective(item, "top") / item.height) * 100).toFixed(4) + "%";
      band.style.bottom = ((effective(item, "bottom") / item.height) * 100).toFixed(4) + "%";
    }
  }

  const rect = rectFor(item);
  const removed = 1 - (rect.width * rect.height) / (item.width * item.height);
  const anyTrim = SIDES.some((s) => effective(item, s) > 0);
  el.summary.innerHTML = anyTrim
    ? `Original <b>${item.width} × ${item.height}</b> → cropped <b>${rect.width} × ${rect.height}</b> · ` +
      `<b>${(removed * 100).toFixed(1)}%</b> removed`
    : `Original <b>${item.width} × ${item.height}</b> · nothing selected to trim`;

  if (det.allChrome) {
    // A settings page, a chat, a wall of text. There is nothing in it to crop
    // TO, which is a different answer from "this already fills the frame".
    showWarning(
      "This is nearly all interface — there's no picture in it big enough to crop to. " +
        "Try <b>Blank edges</b> instead, or type your own numbers.",
    );
  } else if (det.blankImage) {
    showWarning("This image is blank edge to edge, so there's nothing to crop out of it.");
  } else if (det.rotated) {
    // Straightened photos have blank *triangles* in the corners, so no whole row
    // or column is blank and there is no rectangle to trim. Four zeroes and
    // "no blank edge" reads like a failure, so explain the actual shape.
    showWarning(
      "This looks like a straightened or rotated photo — the blank areas are triangles in the corners, " +
        "not bands along the edges, so there's no rectangle to trim off. You can still type in your own numbers to crop it manually.",
    );
  } else if (!det.hasVoid && state.mode === "chrome") {
    showWarning(
      "No app interface found around a picture here. That's the right answer for an ordinary photo — " +
        "try <b>Blank edges</b>, or type your own numbers.",
    );
  } else if (!det.hasVoid) {
    showWarning(
      state.tolerance === "auto"
        ? "No blank edges found — this image looks like it already fills the frame. You can still type in your own numbers."
        : "No blank edges found at this strictness. Switch back to <b>Auto</b>, or type the numbers yourself.",
    );
  } else if (item.width * item.height > MAX_PIXELS) {
    showWarning(
      `That's a ${((item.width * item.height) / 1e6).toFixed(1)} megapixel image. Some phone browsers cap canvas size near 16 MP, so if the saved file looks wrong, shrink it first.`,
    );
  } else {
    el.warning.hidden = true;
  }

  updateOffer(item);
  scheduleBuild();
}

// Point at the other detector when it would take substantially more off.
//
// Keyed on how much more, not on "this mode found nothing", because the near
// miss is the case that matters. One of the two screenshots this was built from
// has a 64px black strip above its status bar: the void scan dutifully finds
// it, reports a 2% trim, and never mentions that the picture in the middle is a
// 42% trim away. "Found nothing" would not have fired there.
const OFFER_GAIN = 0.1;

function updateOffer(item) {
  const otherMode = state.mode === "void" ? "chrome" : "void";
  const other = item.detections && item.detections[otherMode];
  const area = item.width * item.height;
  const mine = rectFor(item);
  const gain = other ? (mine.width * mine.height - other.crop.width * other.crop.height) / area : 0;

  el.offer.hidden = gain < OFFER_GAIN;
  if (el.offer.hidden) return;
  const size = `${other.crop.width} × ${other.crop.height}`;
  const now = `${mine.width} × ${mine.height}`;
  el.offerText.textContent =
    otherMode === "chrome"
      ? `There's a picture inside the interface — trimming to it leaves ${size} instead of ${now}.`
      : `There's blank space around the edges — trimming it leaves ${size} instead of ${now}.`;
  el.offerGo.textContent = otherMode === "chrome" ? "Trim to the picture" : "Trim the blank edges";
  el.offerGo.dataset.go = otherMode;
}

// ----------------------------------------------------------------- batch view

function showBatch() {
  el.batch.hidden = false;
  el.work.hidden = true;
  // Thumbnails built for the other mode have to be rebuilt from the files
  // before the list means anything. refreshThumbs() calls back in here.
  if (state.items.some((item) => item.thumbMode !== state.mode)) {
    refreshThumbs();
    return;
  }
  el.batchTitle.textContent = `${state.items.length} images`;
  el.batchList.replaceChildren();

  state.items.forEach((item, index) => {
    const node = el.batchTemplate.content.firstElementChild.cloneNode(true);
    const use = node.querySelector(".batch-use");
    const thumb = node.querySelector(".batch-thumb");
    const name = node.querySelector(".batch-name");
    const dims = node.querySelector(".batch-dims");
    const tune = node.querySelector(".batch-tune");

    use.checked = item.include;
    use.id = `include-${index}`;
    use.setAttribute("aria-label", `Include ${item.name}`);
    if (item.thumbUrl) thumb.src = item.thumbUrl;
    name.textContent = item.name;

    const rect = rectFor(item);
    const removed = 1 - (rect.width * rect.height) / (item.width * item.height);
    dims.textContent =
      removed > 0
        ? `${item.width}×${item.height} → ${rect.width}×${rect.height} · ${(removed * 100).toFixed(1)}% off`
        : `${item.width}×${item.height} · nothing to trim`;
    node.classList.toggle("is-untrimmed", removed <= 0);

    use.addEventListener("change", () => {
      item.include = use.checked;
      node.classList.toggle("is-excluded", !item.include);
      updateBatchSummary();
      scheduleBuild();
    });
    tune.addEventListener("click", () => openEditor(index));

    el.batchList.append(node);
  });

  updateBatchSummary();
}

function updateBatchSummary() {
  const included = state.items.filter((i) => i.include);
  const trimmed = included.filter((i) => SIDES.some((s) => effective(i, s) > 0));
  el.batchSummary.innerHTML =
    `<b>${included.length}</b> of ${state.items.length} selected · ` +
    `<b>${trimmed.length}</b> had ${MODE_COPY[state.mode].noun} to remove`;
}

function showWarning(html) {
  el.warning.innerHTML = html;
  el.warning.hidden = false;
}

function showPickError(msg) {
  el.pickError.textContent = msg;
  el.pickError.hidden = false;
}

function hidePickError() {
  el.pickError.hidden = true;
}

// ----------------------------------------------------------- building the files

let buildTimer = null;

function scheduleBuild() {
  el.save.disabled = true;
  el.copy.disabled = true;
  clearTimeout(buildTimer);
  buildTimer = setTimeout(build, 140);
}

function typeFor(item) {
  return outputType(item.file.type, state.format, item.transparent);
}

// Cropped files are built ahead of the tap, not inside the Save handler.
// iOS Safari only honours navigator.share() while the tap's transient
// activation is alive, and canvas.toBlob() is asynchronous — awaiting it inside
// the click handler loses the activation and the share sheet silently never
// opens.
async function build() {
  const id = ++state.buildId;
  const targets = state.editing !== null ? [current()] : state.items.filter((i) => i.include);
  if (!targets.length) {
    el.saveHint.textContent = "Nothing selected.";
    return;
  }

  let bytes = 0;
  for (const item of targets) {
    let source = null;
    try {
      // Re-decode rather than caching every bitmap; the encode is the slow part
      // and this keeps peak memory to one image at a time.
      source = state.open && current() === item ? state.open.source : await decodeImage(item.file);
      const type = typeFor(item);
      const blob = await encodeCrop(source, rectFor(item), type);
      if (id !== state.buildId) return; // superseded by a newer build
      if (!blob) throw new Error("encode failed");
      item.outFile = new File([blob], outputName(item.name, type), { type: blob.type });
      bytes += blob.size;
    } catch {
      item.outFile = null;
    } finally {
      if (!(state.open && current() === item)) releaseSource(source);
    }
  }
  if (id !== state.buildId) return;

  const files = targets.map((i) => i.outFile).filter(Boolean);
  if (!files.length) {
    el.saveHint.textContent = "This browser couldn't encode the cropped image.";
    return;
  }

  el.save.disabled = false;
  el.save.textContent = files.length > 1 ? `Save all ${files.length}` : "Save";
  // Copying is inherently one image, so it only appears for a single target.
  el.copy.hidden = !(canCopyImages() && files.length === 1);
  el.copy.disabled = false;

  const shareable = canShareFiles(files);
  el.saveHint.textContent = shareable
    ? `${formatBytes(bytes)} · Save opens the share sheet — pick “Save Image” or “Save to Files”.`
    : `${formatBytes(bytes)} · Save downloads ${files.length > 1 ? "the files" : "the cropped image"}.`;
  updateFormatNote(targets);
}

function updateFormatNote(targets) {
  const sample = targets[0];
  const type = typeFor(sample);
  const label = type === "image/jpeg" ? "JPEG" : type === "image/webp" ? "WebP" : "PNG";
  const transparent = targets.some((i) => i.transparent);

  if (state.format === "auto") {
    el.formatNote.innerHTML =
      `Matching each original — this one saves as <b>${label}</b>. ` +
      (type === "image/png"
        ? "Cropping only drops pixels, so a PNG screenshot stays pixel-for-pixel identical."
        : "The source is already a compressed photo; re-wrapping it as PNG would not recover quality, only add size.");
  } else if (state.format === "jpeg" && transparent) {
    el.formatNote.innerHTML =
      "Some of these have transparent edges, so they'll stay <b>PNG</b> — JPEG has no transparency and would fill those areas in.";
  } else if (state.format === "jpeg") {
    el.formatNote.innerHTML = "Smaller files, and re-encoding adds one generation of loss.";
  } else {
    el.formatNote.innerHTML =
      "Lossless. A PNG screenshot stays identical; a photo will be noticeably larger than the original.";
  }
}

// --------------------------------------------------------------------- actions

el.save.addEventListener("click", async () => {
  const targets = state.editing !== null ? [current()] : state.items.filter((i) => i.include);
  const files = targets.map((i) => i.outFile).filter(Boolean);
  if (!files.length) return;

  if (canShareFiles(files)) {
    try {
      // Called synchronously in the handler — see the note on build().
      await navigator.share({ files });
      el.saveHint.textContent = "Sent to the share sheet.";
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return; // user dismissed the sheet
      // Anything else (a browser that claims canShare but refuses) falls back.
    }
  }
  for (const file of files) downloadFile(file);
  el.saveHint.textContent = files.length > 1 ? `Downloaded ${files.length} files.` : "Downloaded.";
});

el.copy.addEventListener("click", async () => {
  const item = state.editing !== null ? current() : state.items.find((i) => i.include);
  if (!item) return;
  try {
    // Clipboard bitmaps are PNG-only across browsers, so re-encode if the save
    // format is JPEG. The promise is handed straight to ClipboardItem so Safari
    // keeps the tap's activation — see copyImage().
    const png =
      item.outFile && item.outFile.type === "image/png"
        ? Promise.resolve(item.outFile)
        : (async () => {
            const source = await decodeImage(item.file);
            const blob = await encodeCrop(source, rectFor(item), "image/png");
            releaseSource(source);
            return blob;
          })();
    await copyImage(png);
    el.saveHint.textContent = "Copied — paste it anywhere.";
  } catch {
    el.saveHint.textContent = "This browser wouldn't let the page copy an image.";
  }
});

el.reset.addEventListener("click", () => {
  clearAll();
  el.file.value = "";
  el.file.focus();
});

el.back.addEventListener("click", backToBatch);
el.batchAdd.addEventListener("click", () => el.file.click());

function clearAll() {
  closeEditor();
  state.buildId++;
  clearTimeout(buildTimer);
  for (const item of state.items) {
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
  }
  state.items = [];
  el.batchList.replaceChildren();
  el.work.hidden = true;
  el.batch.hidden = true;
  el.output.hidden = true;
  el.progress.hidden = true;
  el.pick.hidden = false;
  el.save.disabled = true;
  el.save.textContent = "Save";
  el.copy.hidden = true;
  el.warning.hidden = true;
  el.offer.hidden = true;
  el.saveHint.textContent = "";
  hidePickError();
}

el.file.addEventListener("change", () => {
  if (el.file.files.length) addFiles(el.file.files);
});

for (const button of el.tolerance) {
  button.addEventListener("click", async () => {
    const raw = button.dataset.tolerance;
    state.tolerance = raw === "auto" ? "auto" : Number(raw);
    for (const other of el.tolerance) other.setAttribute("aria-checked", String(other === button));
    // Only the open image is re-measured; batch items keep what they already
    // have unless you open them.
    const item = current();
    if (item && state.open) {
      item.detections.void = measureWith(state.open.imageData);
      applyDetection(item);
      refresh();
    }
  });
}

// Strictness is a property of the void scan — it sweeps tolerances looking for
// a flat band. Interface detection has no such dial (it keys off how much of a
// line is one colour and whether there is writing on it), so the control is
// hidden rather than left there doing nothing.
function setMode(mode) {
  if (state.mode === mode) return;
  state.mode = mode;
  for (const button of el.mode) {
    button.setAttribute("aria-checked", String(button.dataset.mode === mode));
  }
  el.panelTitle.textContent = MODE_COPY[mode].title;
  el.strictness.hidden = mode !== "void";

  for (const item of state.items) applyDetection(item);
  if (state.editing !== null) {
    // The batch rows behind the editor are now stale; showBatch() rebuilds them
    // when you go back.
    refresh();
  } else {
    refreshThumbs();
  }
}

async function refreshThumbs() {
  el.progress.hidden = false;
  el.progressText.textContent = "Re-measuring…";
  for (let i = 0; i < state.items.length; i++) {
    const item = state.items[i];
    el.progressBar.style.width = `${Math.round((i / state.items.length) * 100)}%`;
    await new Promise((r) => setTimeout(r, 0));
    let source = null;
    try {
      source = await decodeImage(item.file);
      const url = await makeThumb(source, rectFor(item));
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      item.thumbUrl = url;
    } catch {
      // Keep the stale thumbnail rather than blanking the row; the numbers
      // beside it are rebuilt from the detection either way.
    } finally {
      releaseSource(source);
      // Marked done even on failure: a decode that failed here will fail again,
      // and showBatch() would otherwise keep asking for another refresh.
      item.thumbMode = state.mode;
    }
  }
  el.progress.hidden = true;
  el.progressBar.style.width = "0%";
  showBatch();
  scheduleBuild();
}

for (const button of el.mode) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}

el.offerGo.addEventListener("click", () => setMode(el.offerGo.dataset.go));

for (const button of el.format) {
  button.addEventListener("click", () => {
    state.format = button.dataset.format;
    for (const other of el.format) other.setAttribute("aria-checked", String(other === button));
    scheduleBuild();
  });
}

// Drag and drop (desktop convenience; harmless on touch).
for (const type of ["dragenter", "dragover"]) {
  el.pick.addEventListener(type, (e) => {
    e.preventDefault();
    el.pick.classList.add("dragging");
  });
}
for (const type of ["dragleave", "drop"]) {
  el.pick.addEventListener(type, () => el.pick.classList.remove("dragging"));
}
el.pick.addEventListener("drop", (e) => {
  e.preventDefault();
  addFiles(e.dataTransfer?.files);
});
// The browser would otherwise navigate away to a file dropped anywhere else.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

document.addEventListener("paste", (e) => {
  const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith("image/"));
  if (files.length) addFiles(files);
});

// Nothing survives a reload: no storage is written, and the object URLs and
// decoded bitmaps are released here as well as on Start over.
window.addEventListener("pagehide", clearAll);
