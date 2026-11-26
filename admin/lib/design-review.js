// Design review API (T1-T4 PR2, docs/DECISIONS.md D14): the WRITE routes of design history and the screenshot reads, used only by
// core/design-actions.js and ui/design-review.js. Builds no DOM and checks no permission (the core action does).
//   GET  .../design/requests/{id}/screenshots   -> signed read URLs (5 minutes). They stay in the core: never handed to the design layer,
//                                                  never logged, stored or put in a URL; the image is fetched here and shown as a blob.
//   POST .../approve (If-Match + head_sha), .../reject, .../request-changes, .../cancel, .../revert
import { apiRaw } from "./api.js";
import { cleanText } from "./design-history.js";
import { isId } from "./versionpreview.js";

const base = (shopID, id) => `/admin/shops/${shopID}/design/requests/${id}`;
export const NOTE_MAX = 500;
const SHA_RE = /^[0-9a-f]{40}$/;

// ── screenshots ──
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e9) : 0);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** A read URL the core may fetch: https (http only for a loopback development host), no credentials. "" otherwise. */
function readUrl(v) {
  if (typeof v !== "string" || v.length > 4096) return "";
  try {
    const u = new URL(v);
    if (u.username || u.password) return "";
    if (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname))) return u.href;
  } catch { /* not a URL */ }
  return "";
}
/** One screenshot slot. `url` is core-internal. Unknown keys are dropped. */
export function normalizeScreenshot(s) {
  s = s && typeof s === "object" ? s : {};
  const purged = typeof s.purged_at === "string" && s.purged_at !== "";
  const url = purged ? "" : readUrl(s.url);
  const exp = Date.parse(s.url_expires_at);
  return {
    id: isId(s.id) ? s.id : "",
    phase: s.phase === "after" ? "after" : "before",
    role: ["owner", "staff", "anon"].includes(s.role) ? s.role : "anon",
    viewport: s.viewport === 1280 ? 1280 : 390,
    viewKey: cleanText(s.view_key, 80),
    attempt: count(s.attempt), width: count(s.width), height: count(s.height),
    diffPpm: Number.isFinite(s.diff_ppm) && s.diff_ppm >= 0 ? Math.min(Math.floor(s.diff_ppm), 1e6) : null,
    purged, url, urlExpiresAt: Number.isFinite(exp) ? exp : 0,
  };
}
export async function fetchScreenshots(shopID, id) {
  const { data } = await apiRaw("GET", `${base(shopID, id)}/screenshots`);
  const list = data && Array.isArray(data.screenshots) ? data.screenshots : [];
  return list.slice(0, 120).map(normalizeScreenshot).filter((s) => s.id);
}

export class ImageError extends Error {
  /** kind: "expired" (403/404/410: the signed URL is no longer valid) | "failed" (network, CORS, other status) | "bad" (not a PNG) | "purged" */
  constructor(kind) { super(kind); this.name = "ImageError"; this.kind = kind; }
}
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const MAX_IMAGE_BYTES = 40 * 1024 * 1024;
/** Fetches one signed URL as a PNG blob. No cookies, no referrer, no cache, no redirects. The URL is never put in an error or a log. */
export async function fetchImageBlob(url) {
  let res;
  try { res = await fetch(url, { method: "GET", cache: "no-store", referrerPolicy: "no-referrer", credentials: "omit", redirect: "error" }); } catch { throw new ImageError("failed"); }
  if (!res.ok) throw new ImageError([401, 403, 404, 410].includes(res.status) ? "expired" : "failed");
  let buf;
  try { buf = await res.arrayBuffer(); } catch { throw new ImageError("failed"); }
  if (buf.byteLength > MAX_IMAGE_BYTES) throw new ImageError("bad");
  const head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  if (head.length < 8 || PNG.some((b, i) => head[i] !== b)) throw new ImageError("bad");
  return new Blob([buf], { type: "image/png" });
}

// ── writes ──
const clean = (v) => cleanText(typeof v === "string" ? v.trim() : "", NOTE_MAX, true).trim();
/** Approve exactly `headSha` with the ETag the review read. Returns {data, replayed}. */
export async function approveRequest(shopID, id, { etag, headSha }) {
  if (!SHA_RE.test(String(headSha)) || !etag) throw new Error("approve needs the sha and ETag of the review");
  const { data, headers } = await apiRaw("POST", `${base(shopID, id)}/approve`, { head_sha: headSha }, { "If-Match": etag });
  return { data, replayed: Boolean(headers && headers.get && headers.get("Idempotency-Replayed") === "true") };
}
export const rejectRequest = async (shopID, id, reason) => {
  const r = clean(reason);
  return (await apiRaw("POST", `${base(shopID, id)}/reject`, r ? { reason: r } : {})).data;
};
export const requestChanges = async (shopID, id, note) => (await apiRaw("POST", `${base(shopID, id)}/request-changes`, { note: clean(note) })).data;
export const cancelRequest = async (shopID, id) => (await apiRaw("POST", `${base(shopID, id)}/cancel`)).data;
export const revertRequest = async (shopID, id, reason) => {
  const r = clean(reason);
  return (await apiRaw("POST", `${base(shopID, id)}/revert`, r ? { reason: r } : {})).data;
};
export const cleanNote = clean;
