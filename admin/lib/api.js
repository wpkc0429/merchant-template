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

const cfg = window.ADMIN_CONFIG || {};
const isLocalHost = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

// Off localhost the override is ignored on purpose: production is same-origin.
export const API_BASE = (isLocalHost ? (cfg.apiBase || "http://localhost:8080") : location.origin).replace(/\/+$/, "");
export const COOKIE_MODE = API_BASE === location.origin;

let accessToken = "";
const RT_KEY = "admin.refresh";

export const tokens = {
  get access() { return accessToken; },
  get refresh() {
    if (COOKIE_MODE) return "";
    try { return sessionStorage.getItem(RT_KEY) || ""; } catch { return ""; }
  },
  set(pair) {
    accessToken = pair.access_token || "";
    if (!COOKIE_MODE && pair.refresh_token) {
      try { sessionStorage.setItem(RT_KEY, pair.refresh_token); } catch { /* ignore */ }
    }
  },
  clear() {
    accessToken = "";
    try { sessionStorage.removeItem(RT_KEY); } catch { /* ignore */ }
  },
};

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
export function canRefresh() { return COOKIE_MODE || !!tokens.refresh; }

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

async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const url = (path) => `${API_BASE}/api/v1${path}`;

// ── Unauthorized hook (the shell registers it; lib never imports views) ─
let unauthorizedHandler = () => {};
export function onUnauthorized(fn) { unauthorizedHandler = fn; }

// ── Auth endpoints ─────────────────────────────────────────────────────
/** Logs in; throws ApiError (401 bad credentials, 429 locked with retryAfter). */
export async function login(email, password) {
  const res = await accessAwareFetch(url("/admin/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, ...(COOKIE_MODE ? { refresh_transport: "cookie" } : {}) }),
  });
  const data = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, data, res.headers);
  tokens.set(data);
}

export async function logout() {
  const init = { method: "POST", headers: { "Content-Type": "application/json" } };
  if (COOKIE_MODE) {
    init.headers["X-Admin-Refresh"] = "1";
    init.body = JSON.stringify({});
  } else if (tokens.refresh) {
    init.body = JSON.stringify({ refresh_token: tokens.refresh });
  }
  try { if (COOKIE_MODE || tokens.refresh) await fetch(url("/admin/auth/logout"), init); } catch { /* best effort */ }
  tokens.clear();
}

let refreshing = null;
/** Single-flight: refresh tokens rotate on use, so concurrent callers share one request. */
export function refreshTokens() {
  if (!refreshing) {
    refreshing = (async () => {
      const headers = { "Content-Type": "application/json" };
      let body;
      if (COOKIE_MODE) { headers["X-Admin-Refresh"] = "1"; body = JSON.stringify({}); }
      else body = JSON.stringify({ refresh_token: tokens.refresh });
      const res = await accessAwareFetch(url("/admin/auth/refresh"), { method: "POST", headers, body });
      const data = await readBody(res);
      if (!res.ok) throw new ApiError(res.status, data, res.headers);
      tokens.set(data);
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

/** Page-load restore: true when a session was recovered via refresh. */
export async function restoreSession() {
  if (!canRefresh()) return false;
  try { await refreshTokens(); return true; } catch (e) {
    if (e instanceof ApiError) return false;
    throw e; // network down: the caller shows a connection error
  }
}

// ── Authenticated JSON call ────────────────────────────────────────────
export async function api(method, path, body) {
  const doFetch = () => accessAwareFetch(url(path), {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.access}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let res = await doFetch();
  if (res.status === 401) {
    if (canRefresh()) {
      try {
        await refreshTokens();
        res = await doFetch();
      } catch {
        tokens.clear();
        unauthorizedHandler();
        throw new ApiError(401, { error: { message: "session expired" } });
      }
    }
    if (res.status === 401) {
      tokens.clear();
      unauthorizedHandler();
      throw new ApiError(401, { error: { message: "session expired" } });
    }
  }
  // A disabled account's unexpired access token gets 403 from RBAC while /admin/me answers 401.
  // A disabled MEMBERSHIP (shop_user.status) keeps /admin/me at 200 but every shop path 403s,
  // including GET /admin/shops/{id}/me. A plain missing-permission 403 leaves both at 200.
  if (res.status === 403 && path !== "/admin/me") {
    const shopMe = /^\/admin\/shops\/(\d+)\//.exec(path);
    let lost = "";
    try {
      const probe = await accessAwareFetch(url("/admin/me"), { headers: { Authorization: `Bearer ${tokens.access}` } });
      if (probe.status === 401) lost = "account";
      else if (probe.ok && shopMe && !path.endsWith("/me")) {
        const sp = await accessAwareFetch(url(`/admin/shops/${shopMe[1]}/me`), { headers: { Authorization: `Bearer ${tokens.access}` } });
        if (sp.status === 403) lost = "membership";
      }
    } catch { /* offline: just report the 403 */ }
    if (lost) {
      tokens.clear();
      unauthorizedHandler(lost);
      throw new ApiError(401, { error: { message: lost === "account" ? "account disabled or session expired" : "membership disabled" } });
    }
  }
  const data = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, data, res.headers);
  return data;
}

/** Unauthenticated JSON call (password-setup, invitations, branding). */
export async function publicApi(method, path, body) {
  const res = await accessAwareFetch(url(path), {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, data, res.headers);
  return data;
}
