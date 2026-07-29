// Browser-side image plumbing: decode, read pixels, crop, encode, copy.
//
// Kept apart from app.js (UI wiring) and detect.js (pure measurement) so the
// single-image and batch paths run the exact same pipeline and cannot drift.
// Everything here needs a DOM/canvas, so it is exercised by the browser test
// (scripts/test-e2e.mjs) rather than the node unit tests.

// Safari on iOS refuses to read back canvases past roughly this area.
export const MAX_PIXELS = 16.7e6;

/** Decode a File into something drawable, coping with older Safari. */
export async function decodeImage(file) {
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

export function sourceSize(source) {
  return {
    width: source.naturalWidth || source.width,
    height: source.naturalHeight || source.height,
  };
}

export function releaseSource(source) {
  if (source && typeof source.close === "function") source.close();
}

/** Full-resolution pixels, for measuring. */
export function readPixels(source, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0);
  const data = ctx.getImageData(0, 0, width, height);
  canvas.width = canvas.height = 0;
  return data;
}

/**
 * Does anything inside this rectangle have transparency?
 *
 * Matters for format choice: JPEG has no alpha channel, so saving a
 * transparent-edged PNG as JPEG turns those areas into a solid fill. Auto must
 * never silently do that.
 */
export function hasTransparency(imageData, rect) {
  const { data, width } = imageData;
  for (let y = rect.y; y < rect.y + rect.height; y++) {
    const row = y * width;
    for (let x = rect.x; x < rect.x + rect.width; x++) {
      if (data[(row + x) * 4 + 3] < 255) return true;
    }
  }
  return false;
}

/**
 * Which file type to write.
 *
 * `auto` keeps the source's format, which is the honest default: cropping is a
 * lossless subset of the pixels, so a PNG screenshot stays bit-perfect, while a
 * photo that is already JPEG is not improved by being re-wrapped in PNG — it
 * only gets bigger. Transparency forces PNG regardless.
 */
export function outputType(inputType, format, transparent) {
  if (format === "png") return "image/png";
  if (format === "jpeg") return transparent ? "image/png" : "image/jpeg";
  if (transparent) return "image/png";
  if (inputType === "image/jpeg" || inputType === "image/webp") return inputType;
  if (inputType === "image/png") return "image/png";
  // HEIC and friends cannot be re-encoded by canvas; they are photos, so JPEG
  // is the size-sane choice.
  return "image/jpeg";
}

export function outputName(inputName, type) {
  const base = (inputName || "screenshot").replace(/\.[^.]+$/, "");
  const ext = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
  return `${base}-cropped.${ext}`;
}

/** Draw the crop rectangle to a canvas and encode it. */
export async function encodeCrop(source, rect, type, { quality = 0.92 } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = rect.width;
  canvas.height = rect.height;
  const ctx = canvas.getContext("2d");
  if (type === "image/jpeg") {
    // JPEG cannot store alpha; without this any transparency composites onto
    // black, which is a nasty surprise. White matches how viewers show it.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
  }
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, type, type === "image/jpeg" ? quality : undefined),
  );
  canvas.width = canvas.height = 0;
  return blob;
}

/** A small preview of the cropped result, for the batch list. */
export async function makeThumb(source, rect, maxPx = 320) {
  const scale = Math.min(1, maxPx / Math.max(rect.width, rect.height));
  const w = Math.max(1, Math.round(rect.width * scale));
  const h = Math.max(1, Math.round(rect.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, w, h);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  canvas.width = canvas.height = 0;
  return blob ? URL.createObjectURL(blob) : null;
}

export function formatBytes(n) {
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------- sharing

export function canShareFiles(files) {
  return Boolean(navigator.canShare && navigator.share && navigator.canShare({ files }));
}

export function canCopyImages() {
  return typeof ClipboardItem !== "undefined" && Boolean(navigator.clipboard && navigator.clipboard.write);
}

/**
 * Put an image on the clipboard.
 *
 * Always PNG: image/png is the only bitmap type browsers reliably accept on
 * write (Chrome rejects image/jpeg outright), so a JPEG output still gets
 * copied as PNG.
 *
 * The ClipboardItem is handed a *promise* rather than a resolved blob. That is
 * deliberate and load-bearing on Safari: it only honours a clipboard write
 * during the tap's transient activation, and awaiting the encode first would
 * lose it. Passing the promise lets the write start inside the gesture.
 */
export async function copyImage(pngBlobOrPromise) {
  const item = new ClipboardItem({ "image/png": pngBlobOrPromise });
  await navigator.clipboard.write([item]);
}

export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
