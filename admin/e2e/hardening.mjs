// Real-browser test of the PR2 runtime hardening (docs/DECISIONS.md D18), headless Chromium via Playwright. NO platform needed: one tiny server
// serves the admin files under the REAL strict CSP of admin/deploy/nginx.conf.template plus a fake platform API that records every request and the
// Authorization header it carried. Test-only modules are served from memory and imported AFTER the app booted, the way a hostile design module is.
// Covered: (1) the sealed API capability (lib/api.js has no token / client export; takeApi() throws after boot; no core module leaks the token;
// ZERO authenticated requests from the test module) with a CONTROL run that switches the seal off to prove the test can fail; (2) frozen intrinsics:
// ~45 poisoning attempts (Promise, JSON, Object.prototype, Headers, Response, fetch, XHR, Array, Function, iterators, ...) all throw and capture nothing,
// again with a control run with the freeze off that DOES capture the refresh response; (3) HEIC / PNG conversion inside the frozen page and a hostile
// window.heic2any pre-seed; (4) login, refresh at expiry, logout; (5) the preview host (scope preview_ro, expiry message, no-scope refusal, 403
// preview_read_only); (6) the 1 s approve / reject delay with trusted clicks and the keyboard; (7) the scan report in the review dialog.
// Needs Playwright via $PLAYWRIGHT_DIR and SKIPS cleanly (exit 0) when it is not found.   Run: node admin/e2e/hardening.mjs
// Needs Playwright via $PLAYWRIGHT_DIR (a folder with node_modules/playwright) and SKIPS cleanly (exit 0) when it is not found.
// Screenshots go to $HISTORY_SHOTS (default admin/e2e/out/design-history).   Run: node admin/e2e/design-history.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hookBrowser } from "./lib/shadow-hook.mjs";
import { SCRIPT_SRC } from "./lib/csp.mjs";
import { readdirSync } from "node:fs";

const ADMIN = resolve(fileURLToPath(new URL("..", import.meta.url)));
const csp = (connect) => "default-src 'self'; " + SCRIPT_SRC + "; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src " + connect + "; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const SHOTS = process.env.HARDENING_SHOTS || resolve(ADMIN, "e2e/out/hardening");
const HOST = "admin.example.test";
function loadPlaywright() {
  for (const d of [process.env.PLAYWRIGHT_DIR].filter(Boolean)) {
    try { return createRequire(join(d, "package.json"))("playwright"); } catch { /* try the next */ }
  }
  return null;
}
const pw = loadPlaywright();
if (!pw) { console.log("SKIP hardening browser test: Playwright not found (set PLAYWRIGHT_DIR)"); process.exit(0); }
let browser;
try { browser = hookBrowser(await pw.chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })); } catch (e) {
  console.log(`SKIP hardening browser test: Chromium could not start (${String(e.message).split("\n")[0]})`); process.exit(0);
}
mkdirSync(SHOTS, { recursive: true });

// ── PNG fixtures ──
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { const o = y * (w * 3 + 1); raw[o] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); raw[o + 1 + x * 3] = r; raw[o + 2 + x * 3] = g; raw[o + 3 + x * 3] = b; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNGS = [png(390, 500, (x, y) => (y < 90 ? [70, 70, 80] : [250, 250, 248])), png(390, 500, (x, y) => (y < 90 ? [230, 120, 165] : [250, 250, 248]))];

// ── fake platform ──
const uid = (n) => `${String(n).padStart(8, "0")}-1111-4222-8333-${String(n).padStart(12, "0")}`;
const RID = uid(1), CUR = uid(2), PUB = uid(3), DRAFT = uid(4), REJ = uid(5), FAIL = uid(6), ADM1 = uid(7), ADM2 = uid(8), NEWREV = uid(900);
const SHA1 = "a1".repeat(20);
const PERMS = { owner: ["design.view", "design.request", "design.approve", "design.revert"], editor: ["design.view"], staff: ["order.view"] };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const ALLOW = /^\/(hostile\/[a-z-]+\.js|index\.html|app\.js|config\.js|config-loader\.js|styles\.css|(lib|ui|core|vendor)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+|(design|design-defaults)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+\.(js|css|svg|png))$/;
let PORT = 0;
const LONG_PROMPT = "make the banner pink and <b>bold</b> ‮drow " + "very long request text ".repeat(60);
let S;
const mk = (id, o) => ({
  id, site: "storefront", kind: "change", status: "published", base_sha: SHA1, head_sha: SHA1, candidate_sha: null, core_version: "0.4.2", design_floor_version: "0.3.0",
  rev: 5, created_at: "2026-11-26T09:00:00Z", updated_at: "2026-11-26T10:00:00Z", prompt_excerpt: "excerpt " + id.slice(0, 8), prompt_text: "full prompt " + id.slice(0, 8),
  proposed_by_name: "Team member", approved_by_name: null, is_current: false, revert_target_tag: null, published_tag: null, publish_tag: null,
  diff_summary: { files_changed: 2, additions: 12, deletions: 3, files: [{ path: "admin/design/theme.css", status: "modified", additions: 10, deletions: 3 }, { path: "admin/design/copy.js", status: "modified", additions: 2, deletions: 0 }] },
  guard: { passed: true, checked_sha: SHA1, rule_ids: [], violation_count: 0, guard_version: "0.4.2", checked_at: "2026-11-26T10:00:00Z" },
  preview_origin: null, preview_read_only: true, ...o,
});
const resetState = (o = {}) => {
  const reqs = new Map();
  const put = (r) => reqs.set(r.id, r);
  put(mk(RID, { status: "awaiting_approval", candidate_sha: SHA1, created_at: "2026-11-27T09:00:00Z", prompt_text: LONG_PROMPT, prompt_excerpt: "make the banner pink", proposed_by_name: "Team‮ member", preview_origin: "https://p-1.preview.example", preview_expires_at: "2026-11-27T15:30:00Z" }));
  put(mk(CUR, { is_current: true, published_tag: "design-2026-11-25-1", approved_by_name: "Shop owner", approved_at: "2026-11-25T08:00:00Z", published_at: "2026-11-25T08:10:00Z", approved_head_sha: SHA1, created_at: "2026-11-25T07:00:00Z", prompt_excerpt: "current design" }));
  put(mk(PUB, { published_tag: "design-2026-10-01", approved_by_name: "Shop owner", approved_at: "2026-10-01T08:00:00Z", published_at: "2026-10-01T08:10:00Z", approved_head_sha: SHA1, created_at: "2026-10-01T07:00:00Z", prompt_excerpt: "an older published design", proposed_by_name: "" }));
  put(mk(DRAFT, { status: "drafting", created_at: "2026-11-26T20:00:00Z", prompt_excerpt: "work in progress" }));
  put(mk(REJ, { status: "rejected", rejected_by_name: "Shop owner", rejected_at: "2026-11-20T08:00:00Z", reject_reason: "not pink enough", created_at: "2026-11-20T07:00:00Z" }));
  put(mk(FAIL, { status: "failed", failure_code: "guard_failed", failure_detail: "the gatekeeper refused it", created_at: "2026-11-19T07:00:00Z" }));
  for (let i = 0; i < 19; i++) put(mk(uid(100 + i), { status: "cancelled", created_at: `2026-11-${String(10 + (i % 9)).padStart(2, "0")}T07:00:00Z`, prompt_excerpt: `filler ${i}` }));
  put(mk(ADM1, { site: "admin", status: "published", is_current: true, published_tag: "design-admin-1", created_at: "2026-11-24T07:00:00Z", prompt_excerpt: "admin theme" }));
  put(mk(ADM2, { site: "admin", status: "awaiting_approval", candidate_sha: SHA1, created_at: "2026-11-27T07:00:00Z", prompt_excerpt: "admin pending" }));
  S = { role: "owner", preview: "", captured: [], log: [], n: 0, valid: "", refreshCount: 0, logoutCalls: 0, refreshDenied: false, roServer: false, loginScope: "", noScope: false, reqs, approveCalls: [], rejectCalls: [], changeCalls: [], revertCalls: [], cancelCalls: [], writes: 0, listCalls: 0, stateFail: false,
    storage503: false, listError: false, empty: false, untracked: 2, ...o };
};
resetState();
const order = (a, b) => (a.created_at < b.created_at ? 1 : -1);
const json = (res, status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  if (p.startsWith("/hostile/")) { const body = MODULES[p]; if (!body) { res.writeHead(404); res.end("no"); return; } res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" }); res.end(body); return; }
  if (p === "/_cap") { S.captured.push(u.searchParams.get("v")); res.writeHead(204); res.end(); return; }
  if (p.startsWith("/_shots/")) { res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "Content-Type": "image/png" }); res.end(PNGS[Number(p.split("/").pop().replace(".png", ""))]); return; }
  if (p.startsWith("/api/v1/")) {
    const a = p.slice("/api/v1".length), m = req.method;
    S.log.push({ method: m, a, auth: req.headers.authorization || "" });
    if (m !== "GET" && !a.startsWith("/admin/auth/")) S.writes++;
    if (S.roServer && m !== "GET" && !a.startsWith("/admin/auth/")) return json(res, 403, { error: { code: "preview_read_only", message: "RAW read only" } });
    if (m === "POST" && a === "/admin/auth/login") { await readBody(req); if (S.loginScope === "none") { S.valid = "tok-" + ++S.n; return json(res, 200, { access_token: S.valid }); } S.valid = "tok-" + ++S.n; return json(res, 200, { access_token: S.valid, ...(S.loginScope ? { scope: S.loginScope } : S.preview ? { scope: "preview_ro" } : {}) }); }
    if (m === "POST" && a === "/admin/auth/logout") { S.logoutCalls++; S.valid = ""; res.writeHead(204); res.end(); return; }
    if (m === "POST" && a === "/admin/auth/refresh") {
      S.refreshCount++;
      if (S.refresh500) return json(res, 500, { error: { code: "boom", message: "RAW" } });
      if (S.refreshDenied) return json(res, 401, { error: { code: "unauthorized", message: "RAW expired" } });
      S.valid = "tok-" + ++S.n;
      return json(res, 200, { access_token: S.valid, ...(S.preview && !S.noScope ? { scope: "preview_ro" } : {}) });
    }
    if (a !== "/admin/branding" && a !== "/admin/auth/login" && (req.headers.authorization || "") !== "Bearer " + S.valid) return json(res, 401, { error: { code: "unauthorized", message: "RAW" } });
    if (a === "/admin/me") return json(res, 200, { id: S.role === "owner" ? 1 : S.role === "editor" ? 2 : 3, email: `${S.role}@example.com`, sids: [1], platform_permissions: [] });
    if (a === "/admin/shops/1/me") return json(res, 200, { permissions: PERMS[S.role] });
    if (a === "/admin/branding") return json(res, 200, { name: "Test Shop", branding: {} });
    if (a === "/admin/media/config") return json(res, 200, { enabled: false });
    if (a === "/admin/shops/1/branding") return json(res, 200, { name: "Test Shop", branding: {} });
    if (m === "GET" && a === "/admin/shops/1/design/requests") {
      S.listCalls++;
      if (S.storage503) return json(res, 503, { error: { code: "design_storage_not_configured", message: "RAW" } });
      if (S.listError) return json(res, 500, { error: { code: "boom", message: "RAW" } });
      const site = u.searchParams.get("site"), status = u.searchParams.get("status");
      const page = Number(u.searchParams.get("page") || 1), size = Number(u.searchParams.get("page_size") || 20);
      if (S.inconsistent) return json(res, 200, { requests: [], page, page_size: size, total: 50 });
      const all = S.empty ? [] : [...S.reqs.values()].filter((r) => (!site || r.site === site) && (!status || r.status === status)).sort(order);
      return json(res, 200, { requests: all.slice((page - 1) * size, page * size), page, page_size: size, total: all.length });
    }
    if (m === "GET" && a === "/admin/shops/1/design/state") {
      if (S.stateFail) return json(res, 500, { error: { code: "boom", message: "RAW" } });
      const pend = (site) => [...S.reqs.values()].filter((r) => r.site === site && r.status === "awaiting_approval").length;
      return json(res, 200, { sites: [
        { site: "storefront", untracked_changes: S.untracked, current_request_id: CUR, current_tag: "design-2026-11-25-1", core_version: "0.4.2", pending_approval_count: pend("storefront") },
        { site: "admin", untracked_changes: 0, current_request_id: ADM1, current_tag: "design-admin-1", core_version: "0.4.2", pending_approval_count: pend("admin") },
      ], pending_approval_count: pend("storefront") + pend("admin"), ...(S.designEnabledRaw !== undefined ? { design_enabled: S.designEnabledRaw } : S.noDesignEnabledField ? {} : { design_enabled: S.designEnabled !== false }) });
    }
    let mm = /^\/admin\/shops\/1\/design\/requests\/([0-9a-f-]+)(\/[a-z-]+)?$/.exec(a);
    if (mm) {
      const id = mm[1], sub = mm[2] || "", r = S.reqs.get(id);
      if (!r) return json(res, 404, { error: { code: "not_found", message: "no" } });
      if (m === "GET" && !sub) return json(res, 200, r, { ETag: `"${r.rev}"` });
      if (m === "GET" && sub === "/events") return json(res, 200, { events: [{ seq: 1, kind: "status_changed", from_status: "drafting", to_status: "previewing", actor_type: "service", actor_name: null, created_at: "2026-11-26T09:30:00Z" }, { seq: 2, kind: "status_changed", from_status: "previewing", to_status: r.status, actor_type: "user", actor_name: "Shop owner", created_at: "2026-11-26T10:00:00Z" }] });
      if (m === "GET" && sub === "/screenshots") {
        return json(res, 200, { screenshots: [0, 1].map((k) => ({ id: uid(500 + k), request_id: id, phase: k ? "after" : "before", site: r.site, role: "owner", viewport: 390, view_key: "home", attempt: 1, commit_sha: SHA1, content_type: "image/png", byte_size: 1000, width: 390, height: 500, sha256: "x", diff_ppm: k ? 1000 : null, purged_at: null, created_at: "2026-11-27T10:00:00Z", url: `http://127.0.0.1:${PORT}/_shots/${k}.png?sig=${k}`, url_expires_at: new Date(Date.now() + 300000).toISOString() })) });
      }
      const body = await readBody(req);
      if (m === "POST" && sub === "/approve") { S.approveCalls.push({ ifMatch: req.headers["if-match"], body }); r.status = "approved"; r.rev++; r.approved_by_name = "Shop owner"; r.approved_at = "2026-11-27T10:05:00Z"; r.approval_expires_at = "2026-11-27T13:00:00Z"; return json(res, 200, r); }
      if (m === "POST" && sub === "/reject") { S.rejectCalls.push(body); r.status = "rejected"; r.rev++; return json(res, 200, r); }
      if (m === "POST" && sub === "/request-changes") { S.changeCalls.push(body); r.status = "drafting"; r.rev++; return json(res, 200, r); }
      if (m === "POST" && sub === "/revert") { S.revertCalls.push({ id, body }); const n = mk(NEWREV, { kind: "revert", status: "drafting", revert_target_tag: r.published_tag, prompt_excerpt: "", created_at: "2026-11-27T11:00:00Z" }); S.reqs.set(NEWREV, n); return json(res, 201, n); }
      if (m === "POST" && sub === "/cancel") { S.cancelCalls.push(id); r.status = "cancelled"; r.rev++; return json(res, 200, r); }
      if (m === "POST" && sub === "/version-preview") return json(res, 201, { id: uid(700), site: r.site, target_request_id: id, target_tag: r.published_tag, status: "ready", created_at: new Date().toISOString(), ready_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(), read_only: true, origin: "https://v-1.preview.example" });
    }
    return json(res, 404, { error: { code: "not_found", message: "no" } });
  }
  if (p === "/site-config.js") { res.writeHead(200, { "Content-Type": TYPES[".js"] }); res.end('window.ADMIN_CONFIG.siteOrigin = "https://www.example.com";'); return; }
  if (p === "/preview-config.js") {
    res.writeHead(200, { "Content-Type": TYPES[".js"] });
    res.end(`window.ADMIN_CONFIG.preview = ${S.preview ? `{"kind":"${S.preview}","tag":"design-2026-10-01","expiresAt":"2999-01-01T00:00:00Z"}` : "null"};\nwindow.ADMIN_CONFIG.previewConfig = true;\n`); return;
  }
  const path = p === "/" ? "/index.html" : p;
  if (!ALLOW.test(path) || path.includes("..")) { res.writeHead(404); res.end("no"); return; }
  const extra = path === "/index.html" ? { "Content-Security-Policy": csp("'self' http://127.0.0.1:" + PORT).replace(SCRIPT_SRC, APP_MODE.evalCsp ? SCRIPT_SRC + " 'unsafe-eval'" : SCRIPT_SRC) } : {};
  try { let b = await readFile(join(ADMIN, path)); if (path === "/app.js") { let t = b.toString("utf8"); if (APP_MODE.noLockdown) t = t.replace("lockdownIntrinsics();", "/* control run: lockdown off */"); if (APP_MODE.noSeal) t = t.replace("  sealApi();", "  /* control run: seal off */"); b = Buffer.from(t); } res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream", "Cache-Control": "no-store", ...extra }); res.end(b); } catch { res.writeHead(404); res.end("no"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
PORT = server.address().port;
const MODULES = {};
let APP_MODE = { noLockdown: false, noSeal: false, evalCsp: false };
const URL0 = `http://${HOST}:${PORT}/`;

let failures = 0;
const check = (name, cond, extra = "") => { if (cond) console.log(`  ok  ${name}`); else { failures++; console.error(`  FAIL ${name} ${extra}`); } return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (id) => `[data-testid="${id}"]`;
const problems = []; // console errors, page errors, CSP violations: all must stay empty
const warnings = [];

async function open(hash, { width = 1280, height = 900, ...state } = {}) {
  resetState(state);
  const ctx = await browser.newContext({ viewport: { width, height } });
  const pg = await ctx.newPage();
  const tag = `${state.role || "owner"}@${width} ${hash}`;
  pg.on("console", (m) => {
    if (m.location().url.includes("/deny/")) return; // the canary's deliberate probe of /deny/ (lib/canary/probe.js, D19) is a 404 the browser logs as an error
    const x = m.text();
    if (state.expectHttp && /status of (404|500|503)/.test(x)) void 0;
    else if (m.type() === "error" || /Content Security Policy|Refused to/i.test(x)) problems.push(`${tag}: ${x}`);
    else if (m.type() === "warning") warnings.push(`${tag}: ${x}`);
  });
  pg.on("pageerror", (e) => problems.push(`${tag}: pageerror ${e.message}`));
  await pg.goto(URL0 + "#" + hash, { waitUntil: "load" });
  await pg.waitForSelector(".shell", { timeout: 15000 });
  return { ctx, pg };
}
const settle = async (pg, sel = T("dh-area")) => { await pg.waitForFunction((s) => { const a = document.querySelector(s); return a && !a.querySelector(".state--loading"); }, sel, { timeout: 10000 }); await sleep(150); };
const overflow = (pg) => pg.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
const small = (pg, sel) => pg.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null).map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10).filter((h) => h < 43.9), sel);
const shot = (pg, name) => pg.screenshot({ path: join(SHOTS, name + ".png"), fullPage: true });
const dialogGone = (pg) => pg.waitForFunction(() => !__dq("dialog[open]"), null, { timeout: 8000 });
// ── test-only modules, imported by the test AFTER the app booted (the way a hostile design module would be) ──
const CORE_FILES = ["lib", "core", "ui"].flatMap((d) => readdirSync(join(ADMIN, d)).filter((f) => f.endsWith(".js")).map((f) => `/${d}/${f}`)).concat(["/app.js"]);
MODULES["/hostile/seal.js"] = `
const out = { errors: [], leaks: [], exported: {}, probes: {} };
const tok = window.__tok;
const seen = new WeakSet();
const walk = (v, path, depth) => {
  if (typeof v === "string") { if (tok && v.includes(tok)) out.leaks.push(path); return; }
  if (!v || (typeof v !== "object" && typeof v !== "function") || depth > 4 || seen.has(v) || (typeof Node === "function" && v instanceof Node)) return;
  seen.add(v);
  for (const k of Reflect.ownKeys(v)) {
    let d; try { d = Object.getOwnPropertyDescriptor(v, k); } catch { continue; }
    if (!d) continue;
    let val; try { val = "value" in d ? d.value : d.get ? d.get.call(v) : undefined; } catch { continue; }
    walk(val, path + "." + String(k), depth + 1);
  }
};
const api = await import("/lib/api.js");
out.apiKeys = Object.keys(api).sort();
try { api.takeApi(); out.takeApi = "returned"; } catch (e) { out.takeApi = "threw"; }
for (const p of JSON.parse(window.__mods)) {
  try { const m = await import(p); out.exported[p] = Object.keys(m); walk(m, p, 0); } catch (e) { out.errors.push(p + ": " + e.message); }
}
out.suspect = Object.entries(out.exported).flatMap(([p, ks]) => ks.filter((k) => /^(tokens?|api|apiRaw|publicApi|refreshTokens|takeApi|canRefresh|onUnauthorized|accessToken|getToken|restoreSession)$/.test(k) && !(p === "/lib/api.js" && k === "takeApi")).map((k) => p + "#" + k));
let storage = ""; try { storage = JSON.stringify([localStorage, sessionStorage].map((s) => Object.entries(s))) + document.cookie; } catch {}
out.storageLeak = Boolean(tok) && storage.includes(tok);
export default out;
`;
MODULES["/hostile/poison.js"] = `
"use strict";
const cap = [];
const once = new Set();
const rec = (x) => { if (once.has(String(x))) return; once.add(String(x)); try { o.reflectApply(o.fetch, window, ["/_cap?v=" + encodeURIComponent(String(x).slice(0, 60))]); } catch {} };
const note = (what, v) => { try { if (String(v).includes("tok-")) rec(what + ":" + String(v).slice(0, 40)); } catch {} };
const o = {
  then: Promise.prototype.then, resolve: Promise.resolve, parse: JSON.parse, stringify: JSON.stringify, hget: Headers.prototype.get, happend: Headers.prototype.append,
  rjson: Response.prototype.json, rtext: Response.prototype.text, fetch: window.fetch, xopen: XMLHttpRequest.prototype.open, xsend: XMLHttpRequest.prototype.send, XHR: window.XMLHttpRequest,
  push: Array.prototype.push, map: Array.prototype.map, forEach: Array.prototype.forEach, filter: Array.prototype.filter, call: Function.prototype.call, apply: Function.prototype.apply,
  bind: Function.prototype.bind, iter: Array.prototype[Symbol.iterator], mset: Map.prototype.set, replace: String.prototype.replace, split: String.prototype.split,
  exec: RegExp.prototype.exec, reflectApply: Reflect.apply, assign: Object.assign, keys: Object.keys, entries: Object.entries, fromEntries: Object.fromEntries,
  addEL: EventTarget.prototype.addEventListener, append: Node.prototype.appendChild, create: Document.prototype.createElement, attach: Element.prototype.attachShadow,
  setItem: Storage.prototype.setItem, getItem: Storage.prototype.getItem, dec: TextDecoder.prototype.decode, abuf: Blob.prototype.arrayBuffer, structuredClone: window.structuredClone,
  queueMicrotask: window.queueMicrotask, setTimeout: window.setTimeout, gcs: window.getComputedStyle, mm: window.matchMedia, open: window.open, raf: window.requestAnimationFrame, si: window.setInterval, ct: window.clearTimeout, pnow: performance.now, dcreate: document.createElement, dqs: document.querySelector, objToString: Object.prototype.toString, errName: Error.prototype.name,
};
const ArrayIteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
o.iterNext = ArrayIteratorPrototype.next;
const out = [];
const T = (name, set, intact) => { let threw = false; try { set(); } catch { threw = true; } let ok = false; try { ok = Boolean(intact()); } catch {} out.push({ name, threw, intact: ok }); };
T("Promise.prototype.then", () => { Promise.prototype.then = function (a, b) { rec("then"); return o.then.call(this, (v) => { note("then", JSON.stringify(v)); return a ? a(v) : v; }, b); }; }, () => Promise.prototype.then === o.then);
T("Promise.resolve (static)", () => { Promise.resolve = function (v) { note("resolve", v); return o.resolve.call(this, v); }; }, () => Promise.resolve === o.resolve);
T("JSON.parse", () => { JSON.parse = function (t, r) { note("parse", t); return o.parse.call(JSON, t, r); }; }, () => JSON.parse === o.parse);
T("JSON.stringify", () => { JSON.stringify = function (...a) { return o.stringify.apply(JSON, a); }; }, () => JSON.stringify === o.stringify);
T("defineProperty JSON.parse", () => Object.defineProperty(JSON, "parse", { value: (t, r) => o.reflectApply(o.parse, JSON, [t, r]) }), () => JSON.parse === o.parse);
T("Object.prototype setter (access_token)", () => Object.defineProperty(Object.prototype, "access_token", { set(v) { rec("setter:" + v); }, get() { return undefined; }, configurable: true }), () => !Object.getOwnPropertyDescriptor(Object.prototype, "access_token"));
T("Object.prototype getter (then)", () => Object.defineProperty(Object.prototype, "then", { get() { rec("thengetter"); return undefined; }, configurable: true }), () => !Object.getOwnPropertyDescriptor(Object.prototype, "then"));
T("Object.prototype.polluted = 1", () => { Object.prototype.polluted = 1; }, () => !("polluted" in {}));
T("Object.prototype.toString = f", () => { Object.prototype.toString = () => "x"; }, () => Object.prototype.toString === o.objToString);
T("Headers.prototype.get", () => { Headers.prototype.get = function (n) { rec("hget:" + n); return o.hget.call(this, n); }; }, () => Headers.prototype.get === o.hget);
T("Headers.prototype.append", () => { Headers.prototype.append = function (n, v) { rec("happend:" + n); return o.happend.call(this, n, v); }; }, () => Headers.prototype.append === o.happend);
T("Response.prototype.json", () => { Response.prototype.json = async function () { const v = await o.rjson.call(this); note("rjson", JSON.stringify(v)); return v; }; }, () => Response.prototype.json === o.rjson);
T("Response.prototype.text", () => { Response.prototype.text = async function () { const v = await o.rtext.call(this); note("rtext", v); return v; }; }, () => Response.prototype.text === o.rtext);
T("window.fetch = hook", () => { window.fetch = async function (...a) { const r = await o.fetch.apply(window, a); try { note("fetch", await r.clone().text()); } catch {} return r; }; }, () => window.fetch === o.fetch);
T("defineProperty(window, fetch)", () => Object.defineProperty(window, "fetch", { value: (...a) => o.reflectApply(o.fetch, window, a), configurable: true, writable: true }), () => window.fetch === o.fetch);
T("XMLHttpRequest.prototype.open", () => { XMLHttpRequest.prototype.open = function (...a) { rec("xopen"); return o.xopen.apply(this, a); }; }, () => XMLHttpRequest.prototype.open === o.xopen);
T("XMLHttpRequest.prototype.send", () => { XMLHttpRequest.prototype.send = function (...a) { rec("xsend"); return o.xsend.apply(this, a); }; }, () => XMLHttpRequest.prototype.send === o.xsend);
T("window.XMLHttpRequest = Fake", () => { window.XMLHttpRequest = function () { rec("xhr"); }; }, () => window.XMLHttpRequest === o.XHR);
T("Array.prototype.push", () => { Array.prototype.push = function (...a) { return o.push.apply(this, a); }; }, () => Array.prototype.push === o.push);
T("Array.prototype.map", () => { Array.prototype.map = function (...a) { return o.map.apply(this, a); }; }, () => Array.prototype.map === o.map);
T("Array.prototype.forEach", () => { Array.prototype.forEach = function (...a) { return o.forEach.apply(this, a); }; }, () => Array.prototype.forEach === o.forEach);
T("Array.prototype.filter", () => { Array.prototype.filter = function (...a) { return o.filter.apply(this, a); }; }, () => Array.prototype.filter === o.filter);
T("Function.prototype.call", () => { Function.prototype.call = function (...a) { return o.reflectApply(o.call, this, a); }; }, () => Function.prototype.call === o.call);
T("Function.prototype.apply", () => { Function.prototype.apply = function (...a) { return o.reflectApply(o.apply, this, a); }; }, () => Function.prototype.apply === o.apply);
T("Function.prototype.bind", () => { Function.prototype.bind = function (...a) { return o.reflectApply(o.bind, this, a); }; }, () => Function.prototype.bind === o.bind);
T("Array.prototype[Symbol.iterator]", () => { Array.prototype[Symbol.iterator] = function () { rec("iter"); return o.iter.call(this); }; }, () => Array.prototype[Symbol.iterator] === o.iter);
T("%ArrayIteratorPrototype%.next", () => { ArrayIteratorPrototype.next = function () { rec("iternext"); return o.iterNext.call(this); }; }, () => ArrayIteratorPrototype.next === o.iterNext);
T("Map.prototype.set", () => { Map.prototype.set = function (k, v) { return o.mset.call(this, k, v); }; }, () => Map.prototype.set === o.mset);
T("String.prototype.replace", () => { String.prototype.replace = function (...a) { return o.replace.apply(this, a); }; }, () => String.prototype.replace === o.replace);
T("String.prototype.split", () => { String.prototype.split = function (...a) { return o.split.apply(this, a); }; }, () => String.prototype.split === o.split);
T("RegExp.prototype.exec", () => { RegExp.prototype.exec = function (s) { return o.exec.call(this, s); }; }, () => RegExp.prototype.exec === o.exec);
T("Reflect.apply", () => { Reflect.apply = (f, t, a) => o.reflectApply(f, t, a); }, () => Reflect.apply === o.reflectApply);
T("Object.assign", () => { Object.assign = (...a) => o.assign(...a); }, () => Object.assign === o.assign);
T("Object.keys / entries / fromEntries", () => { Object.keys = (x) => o.keys(x); Object.entries = (x) => o.entries(x); Object.fromEntries = (x) => o.fromEntries(x); }, () => Object.keys === o.keys && Object.entries === o.entries && Object.fromEntries === o.fromEntries);
T("EventTarget.prototype.addEventListener", () => { EventTarget.prototype.addEventListener = function (...a) { rec("addEL"); return o.addEL.apply(this, a); }; }, () => EventTarget.prototype.addEventListener === o.addEL);
T("Node.prototype.appendChild", () => { Node.prototype.appendChild = function (n) { rec("append"); return o.append.call(this, n); }; }, () => Node.prototype.appendChild === o.append);
T("Document.prototype.createElement", () => { Document.prototype.createElement = function (...a) { rec("create"); return o.create.apply(this, a); }; }, () => Document.prototype.createElement === o.create);
T("Element.prototype.attachShadow", () => { Element.prototype.attachShadow = function (...a) { rec("attach"); return o.attach.apply(this, a); }; }, () => Element.prototype.attachShadow === o.attach);
T("Storage.prototype.setItem / getItem", () => { Storage.prototype.setItem = function (k, v) { rec("setItem:" + k); return o.setItem.call(this, k, v); }; Storage.prototype.getItem = function (k) { return o.getItem.call(this, k); }; }, () => Storage.prototype.setItem === o.setItem && Storage.prototype.getItem === o.getItem);
T("TextDecoder.prototype.decode", () => { TextDecoder.prototype.decode = function (b) { const s = o.dec.call(this, b); note("decode", s); return s; }; }, () => TextDecoder.prototype.decode === o.dec);
T("Blob.prototype.arrayBuffer", () => { Blob.prototype.arrayBuffer = function () { rec("abuf"); return o.abuf.call(this); }; }, () => Blob.prototype.arrayBuffer === o.abuf);
T("structuredClone / queueMicrotask / setTimeout", () => { window.structuredClone = (v) => o.reflectApply(o.structuredClone, window, [v]); window.queueMicrotask = (f) => o.reflectApply(o.queueMicrotask, window, [f]); window.setTimeout = (...a) => o.reflectApply(o.setTimeout, window, a); }, () => window.structuredClone === o.structuredClone && window.queueMicrotask === o.queueMicrotask && window.setTimeout === o.setTimeout);
T("Error.prototype.name = x", () => { Error.prototype.name = "Hacked"; }, () => Error.prototype.name === o.errName);
T("adoptedStyleSheets setter on the shadow-root prototype (it would receive the core's closed root)", () => Object.defineProperty(ShadowRoot.prototype, "adoptedStyleSheets", { set(v) { rec("adopted:tok-"); }, get() { return []; }, configurable: true }), () => { const d = Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "adoptedStyleSheets"); return d && d.configurable === false && !String(d.set).includes("rec("); });
T("window.getComputedStyle = f", () => { window.getComputedStyle = (...a) => o.reflectApply(o.gcs, window, a); }, () => String(window.getComputedStyle).includes("[native code]"));
T("window.matchMedia = f", () => { window.matchMedia = (...a) => o.reflectApply(o.mm, window, a); }, () => String(window.matchMedia).includes("[native code]"));
T("window.open = f", () => { window.open = (...a) => o.reflectApply(o.open, window, a); }, () => String(window.open).includes("[native code]"));
T("window.requestAnimationFrame / setInterval / clearTimeout = f", () => { window.requestAnimationFrame = (...a) => o.reflectApply(o.raf, window, a); window.setInterval = (...a) => o.reflectApply(o.si, window, a); window.clearTimeout = (...a) => o.reflectApply(o.ct, window, a); }, () => String(window.requestAnimationFrame).includes("[native code]") && String(window.setInterval).includes("[native code]") && String(window.clearTimeout).includes("[native code]"));
T("performance.now = f (instance)", () => { performance.now = () => o.reflectApply(o.pnow, performance, []); }, () => String(performance.now).includes("[native code]"));
T("defineProperty(performance, now)", () => Object.defineProperty(performance, "now", { value: () => o.reflectApply(o.pnow, performance, []) }), () => String(performance.now).includes("[native code]"));
T("document.createElement = f (instance)", () => { document.createElement = (...a) => o.reflectApply(o.dcreate, document, a); }, () => String(document.createElement).includes("[native code]"));
T("defineProperty(document, querySelector)", () => Object.defineProperty(document, "querySelector", { value: (...a) => o.reflectApply(o.dqs, document, a) }), () => String(document.querySelector).includes("[native code]"));
T("window.performance replaced", () => { Object.defineProperty(window, "performance", { value: performance, configurable: true }); }, () => Object.getOwnPropertyDescriptor(window, "performance").configurable === false);
T("window.performance = x (replaceable setter)", () => { window.performance = { now: () => 1e12 }; }, () => String(performance.now).includes("[native code]"));
T("Notification / PerformanceObserver / FileList / DataTransfer statics and prototypes", () => { Notification.requestPermission = () => 1; PerformanceObserver.prototype.observe = () => 1; FileList.prototype.item = () => null; DataTransfer.prototype.setData = () => 1; }, () => String(Notification.requestPermission).includes("[native code]") && String(PerformanceObserver.prototype.observe).includes("[native code]") && String(FileList.prototype.item).includes("[native code]") && String(DataTransfer.prototype.setData).includes("[native code]"));
T("defineProperty(window, innerWidth / innerHeight / devicePixelRatio)", () => { Object.defineProperty(window, "innerWidth", { value: 99999 }); Object.defineProperty(window, "innerHeight", { value: 99999 }); Object.defineProperty(window, "devicePixelRatio", { value: 7 }); }, () => window.innerWidth < 99999 && window.innerHeight < 99999 && window.devicePixelRatio !== 7);
T("defineProperty(window, visualViewport / name / sessionStorage / scrollX)", () => { Object.defineProperty(window, "visualViewport", { value: { width: 1 } }); Object.defineProperty(window, "name", { value: "x" }); Object.defineProperty(window, "sessionStorage", { value: {} }); Object.defineProperty(window, "scrollX", { value: 5 }); }, () => window.visualViewport && window.visualViewport.width !== 1 && typeof sessionStorage.getItem === "function");
T("window.onerror / onload = f (handler setters)", () => { window.onerror = () => 1; window.onload = () => 1; }, () => window.onerror === null && window.onload === null);
T("defineProperty(document, visibilityState / hidden / activeElement)", () => { Object.defineProperty(document, "visibilityState", { value: "hidden" }); Object.defineProperty(document, "hidden", { value: true }); Object.defineProperty(document, "activeElement", { value: null }); }, () => document.visibilityState === "visible" && document.hidden === false);
T("new property on a frozen prototype (Array.prototype.sneaky)", () => { Array.prototype.sneaky = () => 1; }, () => !("sneaky" in []));
T("Object.setPrototypeOf(Object.prototype, {})", () => Object.setPrototypeOf(Object.prototype, { evil: 1 }), () => !("evil" in {}));
export default out;
`;
MODULES["/hostile/audit.js"] = `
const ex = JSON.parse(window.__exceptions);
const off = []; let audited = 0;
const isCtor = (v) => typeof v === "function" && v.prototype !== null && typeof v.prototype === "object";
for (const name of Object.getOwnPropertyNames(globalThis)) {
  if (name.startsWith("__") || ex.includes(name)) continue;
  const d = Object.getOwnPropertyDescriptor(globalThis, name);
  if (!d) continue;
  if ("value" in d) {
    const v = d.value;
    if (isCtor(v)) { audited++; if (!Object.isFrozen(v) || !Object.isFrozen(v.prototype)) off.push("class " + name); }
    else if (v && typeof v === "object" && v !== globalThis) { audited++; if (!Object.isFrozen(v)) off.push("namespace " + name); }
    if ((typeof v === "function" || (v && typeof v === "object" && v !== globalThis)) && (d.writable || d.configurable)) off.push("binding " + name);
  }
}
for (const name of Object.getOwnPropertyNames(globalThis)) { if (ex.includes(name)) continue; const d = Object.getOwnPropertyDescriptor(globalThis, name); if (d && d.get) { audited++; if (d.configurable || (d.set && name !== "location")) off.push("accessor " + name); } }
for (const n of ["document", "performance", "navigator", "screen", "history", "crypto", "customElements"]) { try { const v = globalThis[n]; if (v && !Object.isFrozen(v)) off.push("instance " + n); audited++; } catch {} }
export default { off, audited, names: ["Temporal", "FileList", "DataTransfer", "ReadableStreamDefaultReader", "PerformanceObserver", "CustomElementRegistry", "Notification"].filter((n) => typeof globalThis[n] === "function") };
`;
MODULES["/hostile/clock.js"] = `
let n = 0;
try { performance.now = () => 1e12; n++; } catch {}
try { Object.defineProperty(performance, "now", { value: () => 1e12 }); n++; } catch {}
try { window.getComputedStyle = () => ({ getPropertyValue: () => "", display: "none", width: "1px", zoom: "1", transform: "none", opacity: "1", visibility: "visible" }); n++; } catch {}
try { window.matchMedia = () => ({ matches: true }); n++; } catch {}
try { Object.defineProperty(window, "innerWidth", { value: 50, configurable: true }); Object.defineProperty(window, "innerHeight", { value: 50, configurable: true }); n++; } catch {}
try { Object.defineProperty(window, "devicePixelRatio", { value: 9, configurable: true }); n++; } catch {}
export default { shadowed: n, now: performance.now() };
`;
MODULES["/hostile/heic.js"] = `
window.__heicEvil = 0;
window.heic2any = async () => { window.__heicEvil++; return new Blob([new Uint8Array(10)], { type: "image/jpeg" }); };
export default 1;
`;
import { EXCEPTIONS as EXC } from "../lib/lockdown.js";
const authedCount = () => S.log.filter((x) => x.auth && x.auth !== "Bearer ").length;

try {
  const mods = JSON.stringify(CORE_FILES);

  // ═══ 1. SEALED API CAPABILITY ═══
  console.log("sealed API capability");
  {
    const { ctx, pg } = await open("/design");
    await settle(pg);
    const tok = S.valid;
    check("the app works: the list is loaded with the issued token", (await pg.locator(T("dh-row")).count()) === 20 && tok.startsWith("tok-"));
    await pg.evaluate(([t, m]) => { window.__tok = t; window.__mods = m; }, [tok, mods]);
    await sleep(300);
    const before = authedCount(), rf = S.refreshCount, total = S.log.length;
    const out = await pg.evaluate(() => import("/hostile/seal.js").then((m) => JSON.parse(JSON.stringify(m.default))));
    await sleep(600);
    check("lib/api.js exports only ApiError, sealApi, takeApi (no tokens, api, apiRaw, refresh, login)", JSON.stringify(out.apiKeys) === JSON.stringify(["ApiError", "sealApi", "takeApi"]), JSON.stringify(out.apiKeys));
    check("takeApi() throws after boot", out.takeApi === "threw");
    check("no export of any core module is named like the client, a token or a refresh", out.suspect.length === 0, JSON.stringify(out.suspect));
    check("every core module could be imported (none is hidden), and none exports the token anywhere in its values", out.errors.length === 0 && out.leaks.length === 0 && Object.keys(out.exported).length >= 30, JSON.stringify([out.errors, out.leaks, Object.keys(out.exported).length]));
    check("the token is in no storage and no cookie", out.storageLeak === false);
    check("the fake API saw ZERO authenticated requests (and no request at all) from the test module", authedCount() === before && S.log.length === total && S.refreshCount === rf, `${authedCount() - before} authed, ${S.log.length - total} total`);
    await pg.reload(); await pg.waitForSelector(".shell", { timeout: 15000 }); await settle(pg);
    check("normal flow after the test module: a reload still restores the session and shows the list", (await pg.locator(T("dh-row")).count()) === 20);
    await ctx.close();
  }
  console.log("control run: with the seal switched off the same module gets the client (so the test can fail)");
  {
    APP_MODE = { noLockdown: false, noSeal: true, evalCsp: false };
    MODULES["/hostile/ctl-seal.js"] = `const { takeApi } = await import("/lib/api.js"); const c = takeApi(); await c.api("GET", "/admin/me"); export default 1;`;
    const { ctx, pg } = await open("/design");
    await settle(pg);
    const before = authedCount();
    await pg.evaluate(() => import("/hostile/ctl-seal.js"));
    check("control: without sealApi() a late module makes an authenticated request", authedCount() === before + 1);
    APP_MODE = { noLockdown: false, noSeal: false, evalCsp: false };
    await ctx.close();
  }

  // ═══ 2. FROZEN INTRINSICS ═══
  console.log("frozen intrinsics");
  async function poisonRun() {
    const { ctx, pg } = await open("/design");
    await settle(pg);
    const out = await pg.evaluate(() => import("/hostile/poison.js").then((m) => JSON.parse(JSON.stringify(m.default))));
    const rf = S.refreshCount;
    S.valid = "tok-invalidated"; // the next API call gets 401: the core refreshes (the response a hook would want to read) and retries
    await pg.locator(T("dh-site-admin")).click();
    await pg.waitForFunction(() => location.hash.includes("site=admin"));
    await settle(pg);
    await sleep(300);
    const cap = S.captured.slice();
    return { ctx, pg, out, cap, refreshed: S.refreshCount > rf, rows: await pg.locator(T("dh-row")).count() };
  }
  {
    const { ctx, out, cap, refreshed, rows } = await poisonRun();
    check(`all ${out.length} poisoning attempts left the intrinsic untouched`, out.every((x) => x.intact), JSON.stringify(out.filter((x) => !x.intact)));
    check("in strict mode every attempt THREW (none was silently accepted)", out.every((x) => x.threw), JSON.stringify(out.filter((x) => !x.threw).map((x) => x.name)));
    check("the core refreshed the token during the attempt and the screen still works", refreshed && rows >= 1, `refreshed=${refreshed} rows=${rows}`);
    check("nothing was captured: no hook ran, no refresh response was seen", cap.length === 0, JSON.stringify(cap.slice(0, 8)));
    await ctx.close();
  }
  console.log("control run: without the freeze the same module captures the refresh response");
  {
    APP_MODE = { noLockdown: true, noSeal: false, evalCsp: false };
    const { ctx, cap } = await poisonRun();
    APP_MODE = { noLockdown: false, noSeal: false, evalCsp: false };
    check("control: with the freeze off the hooks run and the refreshed token IS captured by the module", cap.length > 5 && cap.some((c) => /tok-/.test(c)), `captured ${cap.length}: ${JSON.stringify(cap.slice(0, 6))}`);
    await ctx.close();
  }

  console.log("every global constructor / namespace / binding is frozen (enumerated in the page, not from a list)");
  {
    const { ctx, pg } = await open("/design");
    await settle(pg);
    await pg.evaluate((e) => { window.__exceptions = e; }, JSON.stringify(EXC));
    const a = await pg.evaluate(() => import("/hostile/audit.js").then((m) => JSON.parse(JSON.stringify(m.default))));
    check(`the audit found ${a.audited} globals and every one of them is frozen / locked`, a.off.length === 0 && a.audited > 150, JSON.stringify(a.off.slice(0, 12)) + " audited=" + a.audited);
    check("newer platform classes that a fixed list would miss are among them (" + a.names.join(", ") + ")", a.names.length >= 3);
    await ctx.close();
  }
  console.log("a design module that shadows the clock and getComputedStyle cannot shorten the delay (control run: freeze off, so the shadowing SUCCEEDS)");
  {
    APP_MODE = { noLockdown: true, noSeal: false, evalCsp: false };
    const { ctx, pg } = await open(`/design/${RID}`);
    await pg.waitForSelector(T("dh-review"));
    const r = await pg.evaluate(() => import("/hostile/clock.js").then((m) => JSON.parse(JSON.stringify(m.default))));
    APP_MODE = { noLockdown: false, noSeal: false, evalCsp: false };
    check("control: the shadowing succeeded (the freeze is off in this run)", r.shadowed >= 4 && r.now > 1e11, JSON.stringify(r));
    await pg.locator(T("dh-review")).click();
    await pg.waitForSelector("dialog[open] .dlg-rv");
    await pg.locator(T("confirm-rv-ack")).click();
    const yes = pg.locator(`dialog ${T("confirm-yes")}`);
    const box = await yes.boundingBox();
    await pg.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(100);
    check("with performance.now / getComputedStyle / matchMedia shadowed, the core still uses its captured natives: the 1 s delay holds and a trusted early click sends nothing", S.approveCalls.length === 0 && (await yes.getAttribute("aria-disabled")) === "true");
    await pg.waitForFunction(() => { const b = __dq('[data-testid="confirm-yes"]'); return b && !b.disabled && b.getAttribute("aria-disabled") !== "true"; }, null, { timeout: 5000 });
    await yes.click();
    await pg.waitForFunction(() => !__dq("dialog[open]"), null, { timeout: 8000 });
    check("and after the delay the approval works (no display alarm from the shadowed getComputedStyle)", S.approveCalls.length === 1);
    await ctx.close();
  }

  console.log("preview banner geometry keeps working when a module redefines innerWidth / innerHeight (control run: freeze off)");
  {
    APP_MODE = { noLockdown: true, noSeal: false, evalCsp: false };
    const { ctx, pg } = await open("/design", { preview: "version" });
    await settle(pg);
    await pg.evaluate(() => import("/hostile/clock.js"));
    await sleep(1800); // the banner re-checks itself on a timer and on mutations
    check("the banner is still there and the app did not fail closed although the viewport size reads 50x50", (await pg.evaluate(() => Boolean(document.getElementById("core-preview-banner")))) && (await pg.locator(".shell").count()) === 1 && (await pg.evaluate(() => window.innerWidth)) === 50);
    APP_MODE = { noLockdown: false, noSeal: false, evalCsp: false };
    await ctx.close();
  }
  console.log("accessibility tree: the waiting approve button (Chromium AX tree)");
  {
    const { ctx, pg } = await open(`/design/${RID}`);
    await pg.waitForSelector(T("dh-review"));
    await pg.locator(T("dh-review")).click();
    await pg.waitForSelector("dialog[open] .dlg-rv");
    await pg.locator(T("confirm-rv-ack")).click();
    const cdp = await ctx.newCDPSession(pg);
    const approve = async () => { const { nodes } = await cdp.send("Accessibility.getFullAXTree"); const n = nodes.find((x) => !x.ignored && x.role && x.role.value === "button" && x.name && /核准並上線/.test(x.name.value || "")); if (!n) return null; const p = Object.fromEntries((n.properties || []).map((q) => [q.name, q.value && q.value.value])); return { name: n.name.value, desc: (n.description && n.description.value) || "", disabled: p.disabled === true, focusable: p.focusable === true }; };
    const during = await approve();
    check("AX tree, during the wait: a button named 核准並上線, exposed (not ignored), disabled, focusable, described by the countdown hint", Boolean(during) && during.disabled === true && during.focusable === true && /秒後才能使用/.test(during.desc), JSON.stringify(during));
    await pg.waitForFunction(() => { const b = __dq('[data-testid="confirm-yes"]'); return b && !b.disabled && b.getAttribute("aria-disabled") !== "true"; }, null, { timeout: 5000 });
    const after = await approve();
    check("AX tree, after the wait: the same button is enabled and its description no longer carries a countdown", Boolean(after) && after.disabled === false && !/秒後才能使用/.test(after.desc), JSON.stringify(after));
    await ctx.close();
  }

  // ═══ 3. HEIC / PNG through the core flow in the frozen realm (strict CSP) ═══
  console.log("image conversion in the locked page (the vendored decoder's worker needs 'unsafe-eval', which the shipped CSP does not allow: see D18; so this section serves the page with it, for the page under test only)");
  APP_MODE = { noLockdown: false, noSeal: false, evalCsp: true };
  {
    const { ctx, pg } = await open("/design");
    await settle(pg);
    const heic = (await readFile(join(ADMIN, "e2e/fixtures/sample.heic"))).toString("base64");
    const res = await pg.evaluate(async (b64) => {
      const m = await import("/lib/upload.js");
      const slow = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 25s")), 25000))]);
      const frozen = Object.isFrozen(m.heicHooks);
      const conv = m.heicHooks.convert;
      try { m.heicHooks.convert = () => null; } catch { /* strict code would throw; this evaluated code is sloppy */ }
      const swapThrew = m.heicHooks.convert === conv; // the swap had no effect
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const r = await slow(m.prepareImage(new File([bytes], "sample.heic", { type: "image/heic" }))).catch((e) => ({ type: "error:" + e.message, blob: { size: 0 } }));
      return { frozen, swapThrew, type: r.type, size: r.blob.size, global: typeof window.heic2any };
    }, heic);
    check("HEIC is converted to JPEG by the vendored decoder inside the frozen page", res.type === "image/jpeg" && res.size > 500, JSON.stringify(res));
    check("heicHooks is frozen and the decoder global is removed after it was taken", res.frozen && res.swapThrew && res.global === "undefined");
    const png = await pg.evaluate(async () => { const m = await import("/lib/upload.js"); const c = document.createElement("canvas"); c.width = 8; c.height = 8; const blob = await new Promise((r) => c.toBlob(r, "image/png")); const r = await m.prepareImage(new File([blob], "a.png", { type: "image/png" })); return { type: r.type, size: r.blob.size }; });
    check("a PNG passes the same core step unchanged", png.type === "image/png" && png.size > 0, JSON.stringify(png));
    await ctx.close();
  }
  {
    APP_MODE = { noLockdown: true, noSeal: true, evalCsp: true };
    const { ctx, pg } = await open("/design");
    await settle(pg);
    const heic = (await readFile(join(ADMIN, "e2e/fixtures/sample.heic"))).toString("base64");
    const r = await pg.evaluate(async (b64) => {
      const m = await import("/lib/upload.js");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return Promise.race([m.prepareImage(new File([bytes], "sample.heic", { type: "image/heic" })).then((x) => x.type, (e) => "error:" + e.message), new Promise((res) => setTimeout(() => res("timeout 25s"), 25000))]);
    }, heic);
    APP_MODE = { noLockdown: false, noSeal: false, evalCsp: true };
    console.log("  info  HEIC conversion with NO hardening (same relaxed CSP): " + r);
    check("control: the decoder works in this browser without the hardening (so a failure above would be the hardening)", r === "image/jpeg", r);
    await ctx.close();
  }
  {
    const { ctx, pg } = await open("/design");
    await settle(pg);
    const heic = (await readFile(join(ADMIN, "e2e/fixtures/sample.heic"))).toString("base64");
    const r = await pg.evaluate(async (b64) => {
      await import("/hostile/heic.js"); // a design module that pre-seeds window.heic2any to receive the user's files
      const m = await import("/lib/upload.js");
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const out = await m.prepareImage(new File([bytes], "sample.heic", { type: "image/heic" })).then((x) => x.type, (e) => "error:" + e.message);
      return { out, evil: window.__heicEvil };
    }, heic);
    check("a pre-seeded window.heic2any never receives the file (the real decoder converts)", r.evil === 0 && r.out === "image/jpeg", JSON.stringify(r));
    await ctx.close();
  }
  APP_MODE = { noLockdown: false, noSeal: false, evalCsp: false };

  // ═══ 4. real flows after boot: login, refresh at expiry, logout ═══
  console.log("flows after the lockdown: login, refresh at expiry, logout");
  {
    resetState({ refreshDenied: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pg = await ctx.newPage();
    pg.on("pageerror", (e) => problems.push("login flow: pageerror " + e.message));
    await pg.goto(URL0 + "#/design", { waitUntil: "load" });
    await pg.waitForSelector(T("login-email"), { timeout: 15000 });
    check("no session: the login screen shows", (await pg.locator(T("login-submit")).count()) === 1);
    S.refreshDenied = false;
    await pg.fill(T("login-email"), "owner@example.com");
    await pg.fill(T("login-password"), "correct horse battery");
    await pg.click(T("login-submit"));
    await pg.waitForSelector(".shell", { timeout: 15000 });
    await settle(pg);
    check("login works and lands on the requested screen with data", (await pg.locator(T("dh-row")).count()) === 20);
    check("the list request carried the token issued by login", S.log.filter((x) => x.a === "/admin/shops/1/design/requests").every((x) => x.auth === "Bearer " + S.valid));
    const rf = S.refreshCount;
    S.valid = "tok-expired";
    await pg.locator(T("dh-site-admin")).click();
    await pg.waitForFunction(() => location.hash.includes("site=admin"));
    await settle(pg);
    check("token expiry: the core refreshed once and retried (the user sees the admin list)", S.refreshCount === rf + 1 && (await pg.locator(T("dh-row")).count()) >= 1);
    await pg.locator(T("logout")).click();
    await pg.waitForSelector(T("login-submit"), { timeout: 8000 });
    check("logout: the server was told and the login screen is back", S.logoutCalls === 1);
    await ctx.close();
  }

  // ═══ 5. PREVIEW HOST ═══
  console.log("preview host");
  {
    const { ctx, pg } = await open("/design", { preview: "version" });
    await settle(pg);
    check("preview host: the session with scope preview_ro is accepted and the list shows", (await pg.locator(T("dh-row")).count()) >= 1 && S.log.every((x) => !(x.method !== "GET" && !x.a.startsWith("/admin/auth/"))));
    check("preview host: the core banner is there", (await pg.evaluate(() => Boolean(document.getElementById("core-preview-banner")))) === true);
    S.refreshDenied = true; S.valid = "tok-expired"; // the 30-minute absolute session ended: the refresh is refused
    await pg.locator(T("dh-site-admin")).click();
    await pg.waitForSelector(T("login-notice"), { timeout: 10000 });
    const note = await pg.locator(T("login-notice")).innerText();
    check("preview host: an expired preview session asks to log in again, with the preview wording", note.includes("30 分鐘") && note.includes("重新登入"), note);
    S.refreshDenied = false;
    await pg.fill(T("login-email"), "owner@example.com"); await pg.fill(T("login-password"), "correct horse battery");
    await pg.click(T("login-submit"));
    await pg.waitForSelector(".shell", { timeout: 15000 });
    check("preview host: logging in again works", true);
    await ctx.close();
  }
  {
    resetState({ preview: "version", noScope: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pg = await ctx.newPage();
    await pg.goto(URL0 + "#/design", { waitUntil: "load" });
    await pg.waitForSelector(T("login-email"), { timeout: 15000 });
    check("preview host: a refresh without the scope shows the 'not a preview host' notice (not 'expired')", /沒有設定成預覽主機/.test(await pg.locator(T("login-notice")).innerText().catch(() => "")) && !/已到期/.test(await pg.locator(T("login-notice")).innerText().catch(() => "")));
    check("preview host: a refresh WITHOUT scope preview_ro is dropped (no session, back at login, no shop request)", (await pg.locator(".shell").count()) === 0 && S.log.filter((x) => x.a.startsWith("/admin/shops")).length === 0);
    S.loginScope = "none";
    await pg.fill(T("login-email"), "owner@example.com"); await pg.fill(T("login-password"), "correct horse battery");
    await pg.click(T("login-submit"));
    await pg.waitForSelector(T("login-error"), { state: "visible", timeout: 8000 });
    const msg = await pg.locator(T("login-error")).innerText();
    check("preview host: a login without the read-only scope is refused with a calm explanation", msg.includes("預覽網域") && (await pg.locator(".shell").count()) === 0, msg);
    await ctx.close();
  }
  {
    // a NORMAL host (client flag off) whose origin the platform treats as a preview origin: 403 preview_read_only is a calm message, not a logout
    const { ctx, pg } = await open(`/design/${RID}`, { roServer: true });
    await pg.waitForSelector(T("dh-review"));
    await pg.locator(T("dh-review")).click();
    await pg.waitForSelector("dialog[open] .dlg-rv");
    await pg.locator(T("confirm-rv-ack")).click();
    await pg.waitForFunction(() => { const b = __dq('[data-testid="confirm-yes"]'); return b && !b.disabled && b.getAttribute("aria-disabled") !== "true"; });
    const meBefore = S.log.filter((x) => x.a === "/admin/me").length;
    await pg.locator(T("confirm-yes")).click();
    await pg.waitForSelector(T("confirm-rv-alert"), { state: "visible" });
    const alert = await pg.locator(T("confirm-rv-alert")).innerText();
    check("403 preview_read_only: 'please go back to the normal admin to edit' (calm, fixed text)", alert.includes("預覽") && alert.includes("正常的後台"), alert);
    check("403 preview_read_only: the session stays (no probe, no logout, still on the dialog)", S.log.filter((x) => x.a === "/admin/me").length === meBefore && (await pg.locator("dialog[open] .dlg-rv").count()) === 1 && (await pg.locator(T("login-submit")).count()) === 0);
    check("403 preview_read_only: nothing was approved", S.approveCalls.length === 0);
    await ctx.close();
  }

  {
    const { ctx, pg } = await open("/design", { preview: "version" });
    await settle(pg);
    S.refresh500 = true; S.valid = "tok-expired"; // the refresh FAILS (a server error): neither "expired" nor "not a preview host"
    await pg.locator(T("dh-site-admin")).click();
    await pg.waitForSelector(T("login-notice"), { timeout: 10000 });
    const g = await pg.locator(T("login-notice")).innerText();
    check("preview host: a refresh that FAILS (500) shows the generic notice, not the preview-expired or not-a-preview-host one", !/預覽/.test(g) && g.length > 0, g);
    await ctx.close();
  }

  // ═══ 6. APPROVE DELAY ═══
  console.log("approve delay (1 second)");
  {
    const { ctx, pg } = await open(`/design/${RID}`);
    await pg.waitForSelector(T("dh-review"));
    await pg.locator(T("dh-review")).click();
    await pg.waitForSelector("dialog[open] .dlg-rv");
    await pg.evaluate(() => { window.__muts = 0; const h = __dq('[data-testid="confirm-rv-delay"]'); new MutationObserver((m) => { window.__muts += m.length; }).observe(h, { childList: true, characterData: true, subtree: true }); });
    const t0 = await pg.evaluate(() => performance.now());
    await pg.locator(T("confirm-rv-ack")).click();
    const yes = pg.locator(`dialog ${T("confirm-yes")}`);
    const hint = pg.locator(T("confirm-rv-delay"));
    const box = await yes.boundingBox();
    const early = (await pg.evaluate(() => performance.now())) - t0;
    check("right after the dialog opened and the box was ticked, the approve button is still disabled", early < 900 && (await yes.isDisabled()), `early=${early}`);
    check("a countdown hint says when it will be available", /\d 秒後才能使用/.test(await hint.innerText()), await hint.innerText());
    await pg.mouse.click(box.x + box.width / 2, box.y + box.height / 2); // a real, trusted click on the disabled button
    await sleep(100);
    check("a trusted click before 1 s does nothing (no request)", S.approveCalls.length === 0 && (await pg.locator("dialog[open] .dlg-rv").count()) === 1);
    await pg.waitForFunction(() => { const b = __dq('[data-testid="confirm-yes"]'); return b && !b.disabled && b.getAttribute("aria-disabled") !== "true"; }, null, { timeout: 4000 });
    const late = (await pg.evaluate(() => performance.now())) - t0;
    check("the button became enabled no earlier than 1 s after the dialog appeared", late >= 900, `late=${late}`);
    check("the hint is gone once the button is usable", (await hint.innerText()).trim() === "");
    const a11y = await pg.evaluate(() => { const h = __dq('[data-testid="confirm-rv-delay"]'), r = __dq('[data-testid="confirm-rv-ready"]'), b = __dq('dialog [data-testid="confirm-yes"]'); return { muts: window.__muts, hintLive: h.getAttribute("aria-live"), hintRole: h.getAttribute("role"), readyRole: r.getAttribute("role"), readyLive: r.getAttribute("aria-live"), ready: r.textContent, dis: b.disabled, aria: b.getAttribute("aria-disabled"), desc: b.getAttribute("aria-describedby") }; });
    check("a11y: the countdown is NOT a live region and changed at most 3 times in about a second (not every 100 ms)", a11y.hintLive === null && a11y.hintRole === null && a11y.muts <= 3, JSON.stringify(a11y));
    check("a11y: one polite announcement says the button is usable now", a11y.readyRole === "status" && a11y.readyLive === "polite" && /現在可以按下按鈕/.test(a11y.ready), JSON.stringify(a11y));
    check("a11y: once usable the button is neither disabled nor aria-disabled, and it is described by the hints", a11y.dis === false && a11y.aria === "false" && /dlg-rv-delayhint/.test(a11y.desc), JSON.stringify(a11y));
    await yes.click();
    await pg.waitForFunction(() => !__dq("dialog[open]"), null, { timeout: 8000 });
    check("after the delay a trusted click approves (one request)", S.approveCalls.length === 1);
    await ctx.close();
  }
  {
    const { ctx, pg } = await open(`/design/${RID}`);
    await pg.waitForSelector(T("dh-review"));
    await pg.locator(T("dh-review")).focus();
    await pg.keyboard.press("Enter");
    await pg.waitForSelector("dialog[open] .dlg-rv");
    const t0 = await pg.evaluate(() => performance.now());
    const focusId = () => pg.evaluate(() => __active() && (__active().dataset.testid || __active().tagName));
    const tabTo = async (id) => { for (let i = 0; i < 60; i++) { if ((await focusId()) === id) return true; await pg.keyboard.press("Tab"); } return false; };
    await tabTo("confirm-rv-ack");
    await pg.keyboard.press("Space");
    // the approve button is only aria-disabled during the wait: reachable by Tab (assistive technology finds it and its hint) but it cannot act
    let reachedEarly = false;
    for (let i = 0; i < 12 && !reachedEarly; i++) { await pg.keyboard.press("Tab"); reachedEarly = (await focusId()) === "confirm-yes"; }
    const early = reachedEarly ? await pg.evaluate(() => { const b = __dq('[data-testid="confirm-yes"]'); return { dis: b.disabled, aria: b.getAttribute("aria-disabled"), desc: b.getAttribute("aria-describedby") }; }) : null;
    if (reachedEarly) await pg.keyboard.press("Enter");
    await sleep(100);
    const spent = (await pg.evaluate(() => performance.now())) - t0;
    check("keyboard: the waiting approve button is focusable (aria-disabled + described), and Enter on it sends nothing", (!reachedEarly ? spent >= 950 : early.dis === false && early.aria === "true" && /dlg-rv-delayhint/.test(early.desc)) && S.approveCalls.length === 0, JSON.stringify([reachedEarly, early, spent]));
    await pg.waitForFunction(() => { const b = __dq('[data-testid="confirm-yes"]'); return b && !b.disabled && b.getAttribute("aria-disabled") !== "true"; }, null, { timeout: 4000 });
    const reached = await tabTo("confirm-yes");
    await pg.keyboard.press("Enter");
    await pg.waitForFunction(() => !__dq("dialog[open]"), null, { timeout: 8000 });
    check("keyboard: after 1 s Tab reaches the approve button and Enter approves", reached && S.approveCalls.length === 1);
    await ctx.close();
  }
  {
    const { ctx, pg } = await open(`/design/${RID}`);
    await pg.waitForSelector(T("dh-review"));
    await pg.locator(T("dh-review")).click();
    await pg.waitForSelector("dialog[open] .dlg-rv");
    await pg.locator(T("confirm-rv-reject")).click();
    const yes = pg.locator(`dialog ${T("confirm-yes")}`);
    check("reject: the irreversible confirmation is also disabled at first, with a countdown", (await yes.isDisabled()) && /秒後才能使用/.test(await pg.locator(T("confirm-rv-delay")).innerText()));
    const box = await yes.boundingBox();
    await pg.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(80);
    check("reject: a trusted click before 1 s sends nothing", S.rejectCalls.length === 0);
    check("the back button is never delayed", await pg.locator(`dialog .dlg-rv__btns button`).first().isEnabled());
    await pg.waitForFunction(() => { const b = __dq('[data-testid="confirm-yes"]'); return b && !b.disabled && b.getAttribute("aria-disabled") !== "true"; }, null, { timeout: 4000 });
    await yes.click();
    await pg.waitForFunction(() => !__dq("dialog[open]"), null, { timeout: 8000 });
    check("reject: after the delay it works (one request)", S.rejectCalls.length === 1);
    await ctx.close();
  }
  {
    const { ctx, pg } = await open(`/design/${RID}`);
    await pg.waitForSelector(T("dh-review"));
    await pg.locator(T("dh-review")).click();
    await pg.waitForSelector("dialog[open] .dlg-rv");
    check("close is enabled from the first moment", await pg.locator(T("confirm-rv-close")).isEnabled());
    await pg.locator(T("confirm-rv-close")).click();
    await pg.waitForFunction(() => !__dq("dialog[open]"));
    check("close works at once and sends nothing", S.writes === 0);
    await ctx.close();
  }

  // ═══ 7. SCAN REPORT ═══
  console.log("scan report in the review dialog");
  {
    resetState({});
    const r = S.reqs.get(RID);
    r.guard = { passed: false, checked_sha: "b2".repeat(20), rule_ids: ["css/hides-dialog", "net/fetch"], violation_count: 3, guard_version: "0.4.2", checked_at: "2026-11-27T10:00:00Z" };
    r.diff_summary = { files_changed: 7, additions: 120, deletions: 30, files: ["admin/design/theme.css", "admin/design/tokens.css", "admin/design/copy.js", "admin/design/views/home.js", "x/y.css", "x/z.css"].map((p) => ({ path: p, status: "modified", additions: 17, deletions: 4 })) };
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const pg = await ctx.newPage();
    await pg.goto(URL0 + `#/design/${RID}`, { waitUntil: "load" });
    await pg.waitForSelector(T("dh-review"));
    await pg.locator(T("dh-review")).click();
    await pg.waitForSelector("dialog[open] .dlg-rv");
    const scan = pg.locator(T("confirm-rv-scan"));
    const txt = await scan.innerText();
    check("the scan report is in the dialog, inside the service-claims region", (await pg.locator(`.dlg-rv__facts ${T("confirm-rv-scan")}`).count()) === 1 && txt.includes("掃描報告"));
    check("the verdict is 'not passed' with the rule ids and the violation count", txt.includes("未通過") && txt.includes("css/hides-dialog, net/fetch") && txt.includes("3 個"), txt);
    check("the checked sha is shown in full", txt.includes("b2".repeat(20)) && (await pg.locator(T("confirm-rv-scan-sha")).innerText()).includes("b2".repeat(20)));
    check("the approver sees that the checked version differs from the one to approve", (await pg.locator(T("confirm-rv-scan-mismatch")).count()) === 1 && (await pg.locator(T("confirm-rv-scan-candidate")).innerText()).includes(SHA1));
    check("wording: run by the service, not verified by the platform", txt.includes("服務自己執行") && txt.includes("平台沒有驗證"));
    const cnt = await pg.locator(T("confirm-rv-scan-count")).innerText();
    check("the number of files is stated, and that only 6 of the 7 are listed", cnt.includes("7 個") && cnt.includes("前 6 個"), cnt);
    const det = pg.locator(T("confirm-rv-files"));
    check("the full list of changed paths is collapsed", (await det.getAttribute("open")) === null && !(await det.locator("li").first().isVisible()));
    await det.locator("summary").click();
    check("one click opens it: every path is listed", (await det.locator("li").count()) === 6 && (await det.innerText()).includes("admin/design/views/home.js"));
    check("the fixed warning is still there", (await pg.locator(T("confirm-warning")).count()) === 1);
    await pg.keyboard.press("Escape");
    await ctx.close();
  }
  {
    resetState({});
    S.reqs.get(RID).guard = { passed: true, checked_sha: SHA1, rule_ids: [], violation_count: 0, guard_version: "0.4.2", checked_at: "2026-11-27T10:00:00Z" };
    const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
    const pg = await ctx.newPage();
    await pg.goto(URL0 + `#/design/${RID}`, { waitUntil: "load" });
    await pg.waitForSelector(T("dh-review"));
    await pg.locator(T("dh-review")).click();
    await pg.waitForSelector("dialog[open] .dlg-rv");
    const txt = await pg.locator(T("confirm-rv-scan")).innerText();
    check("a passing run: 'passed' (service-reported), no rule, no mismatch warning", txt.includes("通過") && txt.includes("沒有觸發任何規則") && (await pg.locator(T("confirm-rv-scan-mismatch")).count()) === 0);
    check("at 390 px: no horizontal overflow", (await overflow(pg)) <= 0);
    await ctx.close();
  }
  {
    resetState({});
    S.reqs.get(RID).guard = null;
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pg = await ctx.newPage();
    await pg.goto(URL0 + `#/design/${RID}`, { waitUntil: "load" });
    await pg.waitForSelector(T("dh-review"));
    await pg.locator(T("dh-review")).click();
    await pg.waitForSelector("dialog[open] .dlg-rv");
    const txt = await pg.locator(T("confirm-rv-scan")).innerText();
    check("no guard result: it says so, and still states the service/platform wording", txt.includes("沒有結果") && txt.includes("平台沒有驗證"));
    await ctx.close();
  }

  const real = problems.filter((p) => !/status of (401|403|500)/.test(p)); // the deliberate 401 / 403 answers of the fake API are logged by the browser
  check("no console error, page error or CSP violation anywhere (except the deliberate 401 / 403 / 500 answers)", real.length === 0, JSON.stringify(real.slice(0, 6)));
  console.log("NOTE (found, D18): the vendored HEIC decoder's worker evaluates a string (new Function), which the shipped CSP (script-src 'self') forbids, so the HEIC fallback cannot run under it today (Safari converts natively); this test serves its HEIC pages with 'unsafe-eval' only to prove the freeze does not break the decoder.");
  console.log("NOTE (documented limit, D18): a module in the same origin can still call the platform's cookie refresh itself; the seal removes the CORE's client and token, it is not isolation.");
} catch (e) {
  failures++; console.error("  FAIL test crashed:", e && e.stack || e);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
