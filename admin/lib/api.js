// API client: base URL, token handling, refresh, Access-redirect handling.
// Contract: ecommerce docs/admin-frontend-integration.md ("任何後台前端都必須實作的契約").
//
// - access token (15 min) lives in memory only.
// - Same-origin (the production topology) => cookie mode: login sends
//   refresh_transport:"cookie"; refresh/logout send {} plus X-Admin-Refresh: 1;
//   JS never sees the refresh token.
// - Cross-origin (localhost dev) => body mode; the refresh token is kept in
//   sessionStorage (dev only; production is always cookie mode).
// - Cloudflare Access session expiry shows up as a failed fetch (TypeError) or
//   an HTML body instead of JSON: reload the page once (30 s loop guard).
// This file builds no DOM and knows nothing about views.
//
// SEALED CAPABILITY (docs/DECISIONS.md D18). The authenticated client and the token live in this module's closure and are
// reachable only through takeApi(), which works ONLY while the boot phase is open: every core module calls it once, at
// evaluation, and app.js calls sealApi() after all of them were evaluated and BEFORE the design layer is imported. Afterwards
// takeApi() throws, so a module imported later (a design module) cannot obtain the client, a token, refresh or sign-in
// functions. There is no `tokens`, no `.access` getter and no exported api()/apiRaw()/refreshTokens().
import { isReadOnly } from "./preview.js";
import { sealBoot } from "./boot.js";

const cfg = window.ADMIN_CONFIG || {};
const isLocalHost = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

// Off localhost the override is ignored on purpose: production is same-origin.
const API_BASE = (isLocalHost ? (cfg.apiBase || "http://localhost:8080") : location.origin).replace(/\/+$/, "");
const COOKIE_MODE = API_BASE === location.origin;

let accessToken = "";
let scope = ""; // "preview_ro" on a preview host (the platform issues a read-only session there), otherwise ""
const RT_KEY = "admin.refresh";

// Closure-private token state (no object, no getter: nothing to hand out).
function storedRefresh() {
  if (COOKIE_MODE) return "";
  try { return sessionStorage.getItem(RT_KEY) || ""; } catch { return ""; }
}
function setPair(pair) {
  accessToken = pair.access_token || "";
  scope = typeof pair.scope === "string" ? pair.scope : "";
  if (!COOKIE_MODE && pair.refresh_token) {
    try { sessionStorage.setItem(RT_KEY, pair.refresh_token); } catch { /* ignore */ }
  }
}
function clearPair() {
  accessToken = "";
  scope = "";
  try { sessionStorage.removeItem(RT_KEY); } catch { /* ignore */ }
}

export class ApiError extends Error {
  constructor(status, body, headers) {
    super(body?.error?.message || `HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.code = body?.error?.code || "";
    this.retryAfter = Number(headers?.get?.("Retry-After")) || 0;
  }
  get details() { return this.body?.error?.details || []; }
}

/** True when the user could plausibly obtain a fresh access token. */
function canRefresh() { return COOKIE_MODE || !!storedRefresh(); }

// ── Access redirect handling ───────────────────────────────────────────
function reloadForAccess() {
  if (!COOKIE_MODE) return false;
  try {
    const last = Number(sessionStorage.getItem("admin.accessReloadAt") || 0);
    if (Date.now() - last < 30000) return false;
    sessionStorage.setItem("admin.accessReloadAt", String(Date.now()));
  } catch { /* no sessionStorage: reload once anyway */ }
  location.reload();
  return true;
}

async function accessAwareFetch(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // A cross-domain redirect to the Cloudflare Access login surfaces as TypeError.
    if (reloadForAccess()) return new Promise(() => {});
    throw e;
  }
  const type = res.headers.get("content-type") || "";
  if (COOKIE_MODE && res.status !== 204 && type.includes("text/html") && reloadForAccess()) return new Promise(() => {});
  return res;
}

// A preview host (lib/preview.js) must hold ONLY the platform's read-only preview session (scope "preview_ro"). A session without it
// (the origin is not registered as a preview origin on the platform) is dropped at once: the client read-only flags are UX only.
function acceptPair(data) {
  setPair(data);
  if (isReadOnly() && scope !== "preview_ro") {
    clearPair();
    throw new ApiError(403, { error: { code: "preview_scope_missing", message: "this host is not a registered preview origin" } });
  }
}

// The error code of a response WITHOUT consuming it (the caller still reads the body once).
async function peekCode(res) {
  try { const b = await res.clone().json(); return b && b.error && typeof b.error.code === "string" ? b.error.code : ""; } catch { return ""; }
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const url = (path) => `${API_BASE}/api/v1${path}`;

// ── Unauthorized hook (the shell registers it; lib never imports views) ─
let unauthorizedHandler = () => {};
function onUnauthorized(fn) { unauthorizedHandler = fn; }

// ── Auth endpoints ─────────────────────────────────────────────────────
/** Logs in; throws ApiError (401 bad credentials, 429 locked with retryAfter). */
async function login(email, password) {
  const res = await accessAwareFetch(url("/admin/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, ...(COOKIE_MODE ? { refresh_transport: "cookie" } : {}) }),
  });
  const data = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, data, res.headers);
  acceptPair(data);
}

async function logout() {
  const init = { method: "POST", headers: { "Content-Type": "application/json" } };
  if (COOKIE_MODE) {
    init.headers["X-Admin-Refresh"] = "1";
    init.body = JSON.stringify({});
  } else if (storedRefresh()) {
    init.body = JSON.stringify({ refresh_token: storedRefresh() });
  }
  try { if (COOKIE_MODE || storedRefresh()) await fetch(url("/admin/auth/logout"), init); } catch { /* best effort */ }
  clearPair();
}

let refreshing = null;
/** Single-flight: refresh tokens rotate on use, so concurrent callers share one request. */
function refreshTokens() {
  if (!refreshing) {
    refreshing = (async () => {
      const headers = { "Content-Type": "application/json" };
      let body;
      if (COOKIE_MODE) { headers["X-Admin-Refresh"] = "1"; body = JSON.stringify({}); }
      else body = JSON.stringify({ refresh_token: storedRefresh() });
      const res = await accessAwareFetch(url("/admin/auth/refresh"), { method: "POST", headers, body });
      const data = await readBody(res);
      if (!res.ok) throw new ApiError(res.status, data, res.headers);
      acceptPair(data);
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

/** Page-load restore: true when a session was recovered via refresh. */
async function restoreSession() {
  if (!canRefresh()) return false;
  try { await refreshTokens(); return true; } catch (e) {
    if (e instanceof ApiError) return e.code === "preview_scope_missing" ? "preview_scope" : false; // "preview_scope": this host is not a registered preview origin
    throw e; // network down: the caller shows a connection error
  }
}

// ── Authenticated JSON call ────────────────────────────────────────────
async function api(method, path, body) { return (await apiRaw(method, path, body)).data; }

/**
 * Same call as api() but also returns the response headers and status: {data, headers, status}. `extraHeaders`
 * are added to the request (If-Match / If-None-Match for the content documents). Callers that need the
 * ETag of a response use this; everything else uses api().
 */
async function apiRaw(method, path, body, extraHeaders) {
  // Preview mode is read-only (lib/preview.js): the last line of defence behind the core actions. Sign-in, refresh and sign-out do not pass here.
  if (isReadOnly() && !/^(GET|HEAD)$/i.test(method)) throw new ApiError(403, { error: { code: "read_only", message: "this preview is read-only" } });
  const doFetch = () => accessAwareFetch(url(path), {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, ...(extraHeaders || {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let res = await doFetch();
  if (res.status === 401) {
    if (canRefresh()) {
      try {
        await refreshTokens();
        res = await doFetch();
      } catch (e) {
        clearPair();
        // on a preview host say WHY: the host is not a registered preview origin (no preview_ro scope) / the 30-minute preview session ended (the refresh was refused) / anything else
        unauthorizedHandler(!isReadOnly() ? undefined : e instanceof ApiError && e.code === "preview_scope_missing" ? "preview_scope" : e instanceof ApiError && e.status === 401 ? "preview" : undefined);
        throw new ApiError(401, { error: { message: "session expired" } });
      }
    }
    if (res.status === 401) {
      clearPair();
      unauthorizedHandler();
      throw new ApiError(401, { error: { message: "session expired" } });
    }
  }
  // A disabled account's unexpired access token gets 403 from RBAC while /admin/me answers 401.
  // A disabled MEMBERSHIP (shop_user.status) keeps /admin/me at 200 but every shop path 403s,
  // including GET /admin/shops/{id}/me. A plain missing-permission 403 leaves both at 200.
  // A platform-enforced preview refusal is final and calm: nothing to probe (the session is fine, the preview is read-only).
  const previewDenied = res.status === 403 && (await peekCode(res)) === "preview_read_only";
  if (res.status === 403 && path !== "/admin/me" && !previewDenied) {
    const shopMe = /^\/admin\/shops\/(\d+)\//.exec(path);
    let lost = "";
    try {
      const probe = await accessAwareFetch(url("/admin/me"), { headers: { Authorization: `Bearer ${accessToken}` } });
      if (probe.status === 401) lost = "account";
      else if (probe.ok && shopMe && !path.endsWith("/me")) {
        const sp = await accessAwareFetch(url(`/admin/shops/${shopMe[1]}/me`), { headers: { Authorization: `Bearer ${accessToken}` } });
        if (sp.status === 403) lost = "membership";
      }
    } catch { /* offline: just report the 403 */ }
    if (lost) {
      clearPair();
      unauthorizedHandler(lost);
      throw new ApiError(401, { error: { message: lost === "account" ? "account disabled or session expired" : "membership disabled" } });
    }
  }
  const data = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, data, res.headers);
  return { data, headers: res.headers, status: res.status };
}

/** Unauthenticated JSON call (password-setup, invitations, branding). */
async function publicApi(method, path, body) {
  const res = await accessAwareFetch(url(path), {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, data, res.headers);
  return data;
}

// ── The sealed capability ──────────────────────────────────────────────
let open = true;
const client = Object.freeze({ api, apiRaw, publicApi, login, logout, restoreSession, refreshTokens, canRefresh, onUnauthorized });
/** Boot phase only: the privileged client. Throws once sealApi() ran, so no module imported after boot can get it. */
export function takeApi() {
  if (!open) throw new Error("the API client is sealed");
  return client;
}
/** Called once by app.js after every core module was evaluated and before the design layer is imported. Irreversible. */
export function sealApi() { open = false; sealBoot(); } // also closes every other boot-phase capability (lib/boot.js)
