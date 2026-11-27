// Image upload: media config, HEIC->JPEG, presign -> direct PUT (with progress) -> create image.
// Flow per ecommerce docs/admin-frontend-integration.md ("圖片上傳") and docs/media-r2-setup.md.
// Adapted from ecommerce/admin/lib/upload.js (same HEIC approach, heic2any vendored).
//
// The server only accepts JPEG/PNG/WebP, so HEIC/HEIF MUST be converted here (quality 0.92,
// original resolution; resizing and WebP are the server's job). Size limits are re-checked
// AFTER conversion because HEIC->JPEG can be larger than the original.
import { takeApi } from "./api.js";

const { api } = takeApi(); // boot phase only: sealed before the design layer loads (lib/api.js)
import { t } from "./design.js";

const HEIC_TYPES = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
const JPEG_QUALITY = 0.92;
const DEFAULT_ACCEPTED = ["image/jpeg", "image/png", "image/webp"];

let config = { enabled: false, public_base_url: "", max_bytes: 0, accepted_types: [], max_images_per_product: 20 };

/** Call at login. A failure means "not configured": upload controls stay hidden. */
export async function loadMediaConfig() {
  try {
    config = { max_images_per_product: 20, ...(await api("GET", "/admin/media/config")) };
  } catch {
    config = { enabled: false, public_base_url: "", max_bytes: 0, accepted_types: [], max_images_per_product: 20 };
  }
  return config;
}
export const mediaConfig = () => config;
export const mediaEnabled = () => Boolean(config.enabled);
export const maxImages = () => config.max_images_per_product || 20;
export const maxBytes = () => config.max_bytes || 15 * 1048576;

export function isHeic(file) {
  return HEIC_TYPES.has((file.type || "").toLowerCase()) || /\.(heic|heif)$/i.test(file.name || "");
}

const mib = (n) => (n / 1048576).toFixed(1);

async function canvasToJpeg(bitmap) {
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext("2d").drawImage(bitmap, 0, 0);
    return c.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  }
  const c = document.createElement("canvas");
  c.width = bitmap.width;
  c.height = bitmap.height;
  c.getContext("2d").drawImage(bitmap, 0, 0);
  const blob = await new Promise((resolve) => c.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("toBlob failed");
  return blob;
}

// Safari decodes HEIC natively; other browsers make createImageBitmap reject.
async function heicNative(file) {
  const bitmap = await createImageBitmap(file);
  try { return await canvasToJpeg(bitmap); } finally { bitmap.close?.(); }
}

let heicLoader = null;
let heicFn = null; // the decoder, taken from the page the moment its script ran; the global is removed so a later script cannot swap it
// The vendored decoder starts a worker as soon as it loads, so it is loaded on the first HEIC upload, not at boot. By then the intrinsics are
// frozen (lib/lockdown.js) and the design layer may be running, so the load is guarded: a window.heic2any that already exists was put there by
// someone else (refused), and after the script ran the global must be a plain function-valued data property (anything else = tampered, refused).
function loadHeic2any() {
  if (heicFn) return Promise.resolve(heicFn);
  if (!heicLoader) {
    heicLoader = new Promise((resolve, reject) => {
      try { if (Object.getOwnPropertyDescriptor(window, "heic2any")) delete window.heic2any; } catch { /* checked next */ }
      if (Object.getOwnPropertyDescriptor(window, "heic2any")) { heicLoader = null; reject(new Error("heic2any is already defined")); return; }
      const s = document.createElement("script");
      s.src = new URL("../vendor/heic2any.min.js", import.meta.url).href;
      s.onload = () => {
        const d = Object.getOwnPropertyDescriptor(window, "heic2any");
        if (d && "value" in d && typeof d.value === "function" && d.configurable && d.writable) {
          heicFn = d.value;
          try { delete window.heic2any; } catch { /* kept: heicFn is what the core uses */ }
          resolve(heicFn);
        } else { heicLoader = null; reject(new Error("heic2any missing or tampered")); }
      };
      s.onerror = () => { heicLoader = null; reject(new Error("heic2any load failed")); };
      document.head.append(s);
    });
  }
  return heicLoader;
}

/** Boot phase (app.js): the conversion hook object cannot be replaced by anything that runs later. */
export function sealUpload() { Object.freeze(heicHooks); }

/** Exposed so tests can observe/replace the conversion step. */
export const heicHooks = {
  async convert(file) {
    try { return await heicNative(file); } catch { /* fall back to the vendored decoder */ }
    const heic2any = await loadHeic2any();
    const out = await heic2any({ blob: file, toType: "image/jpeg", quality: JPEG_QUALITY });
    return Array.isArray(out) ? out[0] : out;
  },
};

/**
 * Turns a user-picked File into a Blob that can go straight to presign.
 * Throws an Error with a Chinese explanation (and sends NOTHING) on any problem.
 */
export async function prepareImage(file) {
  const limit = maxBytes();
  let blob = file;
  let type = (file.type || "").toLowerCase();
  if (isHeic(file)) {
    // Do not decode something absurdly large just to find out it is too big.
    if (file.size > limit * 3) throw new Error(t("upload.tooBig", { size: mib(file.size), limit: mib(limit) }));
    try { blob = await heicHooks.convert(file); } catch {
      throw new Error(t("upload.heicFailed"));
    }
    type = "image/jpeg";
  }
  const accepted = config.accepted_types?.length ? config.accepted_types : DEFAULT_ACCEPTED;
  if (!accepted.includes(type)) {
    throw new Error(t("upload.badType", { type: type || t("upload.unknownType") }));
  }
  if (blob.size > limit) {
    throw new Error(t("upload.imageTooBig", { size: mib(blob.size), limit: mib(limit) }) + (isHeic(file) ? t("upload.heicGrew") : ""));
  }
  return { blob, type };
}

// PUT straight to object storage. fetch() has no upload progress, so XHR.
// No Authorization header: the signature is in the URL and the headers come from the presign reply.
function putWithProgress(uploadUrl, headers, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl);
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(t("upload.putFailed", { status: xhr.status }))));
    xhr.onerror = () => reject(new Error(t("upload.putNetwork")));
    xhr.send(blob);
  });
}

/**
 * Full product image upload: prepare -> presign -> PUT -> create image record.
 * onStage("converting"|"uploading"|"saving"), onProgress(0..1). Returns the created image.
 */
export async function uploadProductImage(shopID, productID, file, { alt = "", onStage, onProgress } = {}) {
  onStage?.("converting");
  const { blob, type } = await prepareImage(file);
  onStage?.("uploading");
  const intent = await api("POST", `/admin/shops/${shopID}/media/uploads`, {
    content_type: type, size_bytes: blob.size, purpose: "product_image",
  });
  await putWithProgress(intent.upload_url, intent.headers, blob, onProgress);
  onStage?.("saving");
  return api("POST", `/admin/shops/${shopID}/products/${productID}/images`, { upload_id: intent.upload_id, alt });
}

/**
 * Content-image upload (CMS `x-editor: image` fields): the same prepare -> presign -> PUT pipeline as product
 * images with purpose "content_image", then POST media/content-images which converts it (WebP, EXIF removed)
 * and returns {urls: {thumb, large}, width, height}. The field value is `urls.large`. Returns that object.
 */
export async function uploadContentImage(shopID, file, { onStage, onProgress } = {}) {
  onStage?.("converting");
  const { blob, type } = await prepareImage(file);
  onStage?.("uploading");
  const intent = await api("POST", `/admin/shops/${shopID}/media/uploads`, {
    content_type: type, size_bytes: blob.size, purpose: "content_image",
  });
  await putWithProgress(intent.upload_url, intent.headers, blob, onProgress);
  onStage?.("saving");
  return api("POST", `/admin/shops/${shopID}/media/content-images`, { upload_id: intent.upload_id });
}
