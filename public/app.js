// Screenshot Cropper — UI wiring.
//
// The whole pipeline is local: File -> ImageBitmap -> canvas pixels ->
// detectVoids() -> crop canvas -> Blob -> share sheet. There is no fetch() in
// this file, and the Content-Security-Policy the Worker sends (connect-src
// 'none') means there could not be one.

import { detectVoids, detectVoidsAuto, cropRect } from "./detect.js";

const SIDES = ["top", "bottom", "left", "right"];
const LABELS = { top: "Top", bottom: "Bottom", left: "Left", right: "Right" };
// Safari on iOS refuses to read back canvases past roughly this area. Phone
// screenshots are ~4 MP, so this only trips on large camera photos.
const MAX_PIXELS = 16.7e6;

const el = {
  pick: document.getElementById("pick"),
  file: document.getElementById("file"),
  pickError: document.getElementById("pick-error"),
  work: document.getElementById("work"),
  preview: document.getElementById("preview"),
  sides: document.getElementById("sides"),
  summary: document.getElementById("summary"),
  warning: document.getElementById("warning"),
  save: document.getElementById("save"),
  reset: document.getElementById("reset"),
  saveHint: document.getElementById("save-hint"),
  rowTemplate: document.getElementById("side-row"),
  tolerance: document.querySelectorAll(".tolerance button"),
  bands: {},
};
for (const side of SIDES) {
  el.bands[side] = document.querySelector(`.band-${side}`);
}

const state = {
  file: null,
  source: null, // ImageBitmap (or HTMLImageElement on old Safari)
  width: 0,
  height: 0,
  imageData: null, // kept so a strictness change re-measures without re-decoding
  detection: null,
  trim: { top: 0, bottom: 0, left: 0, right: 0 },
  use: { top: false, bottom: false, left: false, right: false },
  // "auto" sweeps tolerances and takes the stable answer; a number forces one.
  tolerance: "auto",
  outFile: null,
  outUrl: null,
  buildId: 0,
};

// ---------------------------------------------------------------- row widgets

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
    state.use[side] = row.use.checked;
    refresh();
  });
  row.px.addEventListener("input", () => {
    const n = Math.max(0, Math.round(Number(row.px.value) || 0));
    state.trim[side] = n;
    // Typing a number is intent to crop that side; typing zero is intent not to.
    state.use[side] = n > 0;
    row.use.checked = state.use[side];
    refresh();
  });
  row.extend.addEventListener("click", () => {
    const extra = Number(row.extend.dataset.extra || 0);
    state.trim[side] += extra;
    state.use[side] = true;
    row.extend.hidden = true;
    refresh();
  });

  rows[side] = row;
  el.sides.append(node);
}

// -------------------------------------------------------------------- loading

async function decode(file) {
  if (typeof createImageBitmap === "function") {
    try {
      // from-image applies EXIF rotation, so a camera photo measures the way it
      // looks. Screenshots carry no orientation tag, so this is a no-op there.
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      try {
        return await createImageBitmap(file);
      } catch {
        /* fall through to the <img> path */
      }
    }
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode failed"));
    };
    img.src = url;
  });
}

async function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showPickError("That doesn't look like an image file.");
    return;
  }
  hidePickError();
  clearImage();

  let source;
  try {
    source = await decode(file);
  } catch {
    showPickError(
      "This browser couldn't read that image. If it's a HEIC photo, try exporting it as JPEG first.",
    );
    return;
  }

  const width = source.naturalWidth || source.width;
  const height = source.naturalHeight || source.height;
  if (!width || !height) {
    showPickError("That image has no readable dimensions.");
    return;
  }

  state.file = file;
  state.source = source;
  state.width = width;
  state.height = height;

  // Read the pixels once, at full resolution, from a throwaway canvas.
  const scratch = document.createElement("canvas");
  scratch.width = width;
  scratch.height = height;
  const ctx = scratch.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  try {
    state.imageData = ctx.getImageData(0, 0, width, height);
  } catch {
    showPickError("This browser blocked reading that image's pixels.");
    clearImage();
    return;
  }
  scratch.width = scratch.height = 0;

  // The picker is a big target on an empty page, but once there's an image to
  // look at it would push the measurements off a phone screen. Start over
  // brings it back.
  el.pick.hidden = true;
  el.work.hidden = false;
  measure();
  drawPreview();
}

function measure() {
  state.detection =
    state.tolerance === "auto"
      ? detectVoidsAuto(state.imageData)
      : detectVoids(state.imageData, { tolerance: state.tolerance });
  for (const side of SIDES) {
    state.trim[side] = state.detection[side];
    state.use[side] = state.detection[side] > 0;
  }
  refresh();
}

// ------------------------------------------------------------------ rendering

function drawPreview() {
  // Draw at display scale rather than natural size: a 12 MP photo does not need
  // a 12 MP canvas sitting in the DOM. The band overlays are positioned in
  // percentages, so they line up at any scale.
  const longest = Math.max(state.width, state.height);
  const scale = Math.min(1, 1400 / longest);
  const w = Math.max(1, Math.round(state.width * scale));
  const h = Math.max(1, Math.round(state.height * scale));
  el.preview.width = w;
  el.preview.height = h;
  const ctx = el.preview.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(state.source, 0, 0, w, h);
}

function effective(side) {
  return state.use[side] ? state.trim[side] : 0;
}

function currentRect() {
  return cropRect(
    { width: state.width, height: state.height },
    {
      top: effective("top"),
      bottom: effective("bottom"),
      left: effective("left"),
      right: effective("right"),
    },
  );
}

function pctOf(side) {
  const total = side === "top" || side === "bottom" ? state.height : state.width;
  return total ? (state.trim[side] / total) * 100 : 0;
}

function refresh() {
  const det = state.detection;
  if (!det) return;

  for (const side of SIDES) {
    const row = rows[side];
    const info = det.sides[side];
    const px = state.trim[side];

    row.use.checked = state.use[side];
    if (document.activeElement !== row.px) row.px.value = String(px);
    row.px.max = String(side === "top" || side === "bottom" ? state.height : state.width);
    row.pct.textContent = px > 0 ? `${(Math.round(pctOf(side) * 10) / 10).toFixed(1)}%` : "—";
    row.root.classList.toggle("is-empty", px === 0);

    if (info.hex) {
      row.swatch.hidden = false;
      row.swatch.style.background = info.alpha === 0 ? "transparent" : info.hex;
      row.color.textContent = info.name ? `${info.hex} ${info.name}` : info.hex;
    } else {
      row.swatch.hidden = true;
      row.color.textContent = px > 0 ? "manual" : "no blank edge";
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

  // Position the shaded overlays.
  for (const side of SIDES) {
    const band = el.bands[side];
    const px = effective(side);
    const vertical = side === "top" || side === "bottom";
    const pct = ((px / (vertical ? state.height : state.width)) * 100).toFixed(4) + "%";
    band.hidden = px === 0;
    band.querySelector("span").textContent = `${px} px`;
    if (vertical) {
      band.style.height = pct;
    } else {
      band.style.width = pct;
      band.style.top = ((effective("top") / state.height) * 100).toFixed(4) + "%";
      band.style.bottom = ((effective("bottom") / state.height) * 100).toFixed(4) + "%";
    }
  }

  const rect = currentRect();
  const removed = 1 - (rect.width * rect.height) / (state.width * state.height);
  const anyTrim = SIDES.some((s) => effective(s) > 0);
  el.summary.innerHTML = anyTrim
    ? `Original <b>${state.width} × ${state.height}</b> → cropped <b>${rect.width} × ${rect.height}</b> · ` +
      `<b>${(removed * 100).toFixed(1)}%</b> removed`
    : `Original <b>${state.width} × ${state.height}</b> · nothing selected to trim`;

  if (det.blankImage) {
    showWarning("This image is blank edge to edge, so there's nothing to crop out of it.");
  } else if (det.rotated) {
    // Straightened photos have blank *triangles* in the corners, so no whole row
    // or column is blank and there is no rectangle to trim. Four zeroes and
    // "no blank edge" reads like a failure, so explain the actual shape.
    showWarning(
      "This looks like a straightened or rotated photo — the blank areas are triangles in the corners, " +
        "not bands along the edges, so there's no rectangle to trim off. You can still type in your own numbers to crop it manually.",
    );
  } else if (!det.hasVoid) {
    showWarning(
      state.tolerance === "auto"
        ? "No blank edges found — this image looks like it already fills the frame. You can still type in your own numbers."
        : "No blank edges found at this strictness. Switch back to <b>Auto</b>, or type the numbers yourself.",
    );
  } else if (state.width * state.height > MAX_PIXELS) {
    showWarning(
      `That's a ${(( state.width * state.height) / 1e6).toFixed(1)} megapixel image. Some phone browsers cap canvas size near 16 MP, so if the saved file looks wrong, shrink it first.`,
    );
  } else {
    el.warning.hidden = true;
  }

  scheduleBuild();
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

// ----------------------------------------------------------- building the file

let buildTimer = null;

function scheduleBuild() {
  el.save.disabled = true;
  clearTimeout(buildTimer);
  buildTimer = setTimeout(build, 120);
}

function outputType(inputType) {
  return ["image/png", "image/jpeg", "image/webp"].includes(inputType) ? inputType : "image/png";
}

function outputName(inputName, type) {
  const base = (inputName || "screenshot").replace(/\.[^.]+$/, "");
  const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
  return `${base}-cropped.${ext}`;
}

// The cropped file is built ahead of the tap, not inside the Save handler.
// iOS Safari only honours navigator.share() while the tap's transient
// activation is alive, and canvas.toBlob() is asynchronous — awaiting it first
// loses the activation and the share sheet silently never opens.
async function build() {
  if (!state.source) return;
  const id = ++state.buildId;
  const rect = currentRect();
  const type = outputType(state.file.type);

  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(state.source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, type, type === "image/jpeg" ? 0.92 : undefined),
  );
  canvas.width = canvas.height = 0;
  if (id !== state.buildId) return; // a newer build already superseded this one
  if (!blob) {
    el.saveHint.textContent = "This browser couldn't encode the cropped image.";
    return;
  }

  releaseOutput();
  state.outFile = new File([blob], outputName(state.file.name, type), { type: blob.type });
  el.save.disabled = false;
  el.saveHint.textContent = canShareFile(state.outFile)
    ? `${formatBytes(blob.size)} · Save opens the share sheet — pick “Save Image” or “Save to Files”.`
    : `${formatBytes(blob.size)} · Save downloads the cropped image.`;
}

function canShareFile(file) {
  return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
}

function formatBytes(n) {
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function releaseOutput() {
  if (state.outUrl) {
    URL.revokeObjectURL(state.outUrl);
    state.outUrl = null;
  }
  state.outFile = null;
}

function download(file) {
  state.outUrl = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = state.outUrl;
  a.download = file.name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  el.saveHint.textContent = "Downloaded.";
}

// --------------------------------------------------------------------- events

el.save.addEventListener("click", async () => {
  const file = state.outFile;
  if (!file) return;
  if (canShareFile(file)) {
    try {
      // Called synchronously in the handler — see the note on build().
      await navigator.share({ files: [file] });
      el.saveHint.textContent = "Sent to the share sheet.";
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return; // user dismissed the sheet
      // Anything else (a browser that claims canShare but refuses) falls back.
    }
  }
  download(file);
});

el.reset.addEventListener("click", () => {
  clearImage();
  el.work.hidden = true;
  el.pick.hidden = false;
  el.file.value = "";
  el.saveHint.textContent = "";
  hidePickError();
  el.file.focus();
});

function clearImage() {
  if (state.source && typeof state.source.close === "function") state.source.close();
  releaseOutput();
  state.buildId++;
  clearTimeout(buildTimer);
  state.file = null;
  state.source = null;
  state.imageData = null;
  state.detection = null;
  state.width = state.height = 0;
  el.preview.width = el.preview.height = 0;
  el.save.disabled = true;
  el.warning.hidden = true;
}

el.file.addEventListener("change", () => loadFile(el.file.files[0]));

for (const button of el.tolerance) {
  button.addEventListener("click", () => {
    const raw = button.dataset.tolerance;
    state.tolerance = raw === "auto" ? "auto" : Number(raw);
    for (const other of el.tolerance) {
      other.setAttribute("aria-checked", String(other === button));
    }
    if (state.imageData) measure();
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
  loadFile(e.dataTransfer?.files?.[0]);
});
// The browser would otherwise navigate away to a file dropped anywhere else.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

document.addEventListener("paste", (e) => {
  const file = Array.from(e.clipboardData?.files || []).find((f) => f.type.startsWith("image/"));
  if (file) loadFile(file);
});

// Nothing survives a reload: no storage is written, and the object URLs and
// decoded bitmap are released here as well as on Start over.
window.addEventListener("pagehide", clearImage);
