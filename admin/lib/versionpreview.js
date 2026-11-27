// Version preview API (platform change design-history, D25): the two routes the core uses.
//   POST /admin/shops/{id}/design/requests/{requestId}/version-preview  -> 202 {id, status: "queued", ...}
//   GET  /admin/shops/{id}/design/version-previews/{previewId}          -> the preview (`origin` only for the person who asked)
// Everything the design layer receives is the plain object normalize() returns: no shop id, no token, no raw response.
import { takeApi } from "./api.js";

const { api } = takeApi(); // boot phase only: sealed before the design layer loads (lib/api.js)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (v) => typeof v === "string" && UUID_RE.test(v);

const base = (shopID) => `/admin/shops/${shopID}/design`;
export const createVersionPreview = (shopID, requestId) => api("POST", `${base(shopID)}/requests/${requestId}/version-preview`);
export const fetchVersionPreview = (shopID, previewId) => api("GET", `${base(shopID)}/version-previews/${previewId}`);

const RULE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const ACTIVE = new Set(["queued", "claimed", "ready"]);

/** An origin the browser may be sent to: https only, scheme + host only (no path, query, fragment or credentials), a real DNS name (a dot inside, no trailing dot, no IP literal). "" otherwise. */
export function safeOrigin(v) {
  try {
    const u = new URL(String(v));
    if (u.protocol !== "https:") return "";
    if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return "";
    const host = u.hostname;
    if (!host.includes(".") || host.endsWith(".") || host.startsWith("[") || /^[0-9.]+$/.test(host)) return "";
    return u.origin;
  } catch { return ""; }
}

/**
 * The API object -> what a screen gets. state: waiting (queued, claimed) | ready | failed | expired (expired, superseded, or past
 * expires_at by the clock). `origin` only when the platform sent it (the person who asked, ready, not expired) and it is a plain origin.
 * `readOnly` is always true. failureDetail and failureRuleIds are DATA: render them as text.
 */
export function normalize(d, now = Date.now()) {
  const exp = Date.parse(d.expires_at);
  let status = String(d.status || "");
  if (ACTIVE.has(status) && Number.isFinite(exp) && exp <= now) status = "expired";
  const state = status === "queued" || status === "claimed" ? "waiting" : status === "ready" ? "ready" : status === "failed" ? "failed" : "expired";
  return {
    id: String(d.id || ""), site: d.site === "admin" ? "admin" : "storefront",
    requestId: String(d.target_request_id || ""), tag: String(d.target_tag || ""),
    status, state, superseded: status === "superseded",
    failureCode: d.failure_code ? String(d.failure_code).slice(0, 80) : "",
    failureDetail: d.failure_detail ? String(d.failure_detail).slice(0, 300) : "",
    failureRuleIds: Array.isArray(d.failure_rule_ids) ? d.failure_rule_ids.map(String).filter((x) => RULE_RE.test(x)).slice(0, 20) : [],
    coreVersion: String(d.core_version || ""),
    createdAt: d.created_at || "", readyAt: d.ready_at || null, expiresAt: d.expires_at || "",
    readOnly: true,
    origin: state === "ready" ? safeOrigin(d.origin) : "",
  };
}
