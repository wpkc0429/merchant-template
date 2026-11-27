// Real-browser test of the DEFAULT design history screens (T1-T4 PR3, docs/DECISIONS.md D15), headless Chromium via Playwright.
// NO platform needed: one tiny server serves the admin files AND a fake platform API (admin/me, design requests, state, events, screenshots with
// signed URLs, approve / reject / request-changes / revert / cancel, version previews), under the REAL strict CSP of admin/deploy/nginx.conf.template.
// The screens under test are the shipped design/ files (no test view). The shared test hook (e2e/lib/shadow-hook.mjs) opens the closed core dialogs.
// Covered: owner flow (list -> detail -> review -> approve with the checkbox, reject, request changes, cancel, revert request from a published row),
// editor read-only, staff (no nav item, noPermission), preview hosts (no action buttons, nothing sent), pagination, filter, site tabs, the three empty
// states + the error state, the nav badge, plain-text rendering, 390 and 1280 screenshots, no console error, no CSP violation, no horizontal overflow.
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
import { skipOrFail } from "./lib/require-browser.mjs";
import { SCRIPT_SRC } from "./lib/csp.mjs";
import { canaryNoise } from "./lib/expected-noise.mjs";

const ADMIN = resolve(fileURLToPath(new URL("..", import.meta.url)));
const csp = (connect) => "default-src 'self'; " + SCRIPT_SRC + "; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src " + connect + "; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const SHOTS = process.env.HISTORY_SHOTS || resolve(ADMIN, "e2e/out/design-history");
const HOST = "admin.example.test";
function loadPlaywright() {
  for (const d of [process.env.PLAYWRIGHT_DIR].filter(Boolean)) {
    try { return createRequire(join(d, "package.json"))("playwright"); } catch { /* try the next */ }
  }
  return null;
}
const pw = loadPlaywright();
if (!pw) { skipOrFail("design-history browser test: Playwright not found (set PLAYWRIGHT_DIR)"); }
let browser;
try { browser = hookBrowser(await pw.chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })); } catch (e) {
  skipOrFail(`design-history browser test: Chromium could not start (${String(e.message).split("\n")[0]})`);
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
const ALLOW = /^\/(index\.html|app\.js|config\.js|config-loader\.js|styles\.css|(lib|ui|core|vendor)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+|(design|design-defaults)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+\.(js|css|svg|png))$/;
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
  S = { role: "owner", preview: "", reqs, approveCalls: [], rejectCalls: [], changeCalls: [], revertCalls: [], cancelCalls: [], writes: 0, listCalls: 0, stateFail: false,
    storage503: false, listError: false, empty: false, untracked: 2, ...o };
};
resetState();
const order = (a, b) => (a.created_at < b.created_at ? 1 : -1);
const json = (res, status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  if (p.startsWith("/_shots/")) { res.writeHead(200, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store", "Content-Type": "image/png" }); res.end(PNGS[Number(p.split("/").pop().replace(".png", ""))]); return; }
  if (p.startsWith("/api/v1/")) {
    const a = p.slice("/api/v1".length), m = req.method;
    if (m !== "GET" && a !== "/admin/auth/refresh") S.writes++;
    if (m === "POST" && a === "/admin/auth/refresh") return json(res, 200, { access_token: "tok-" + Math.random().toString(36).slice(2), ...(S.preview ? { scope: "preview_ro" } : {}) });
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
  const extra = path === "/index.html" ? { "Content-Security-Policy": csp("'self' http://127.0.0.1:" + PORT) } : {};
  try { const b = await readFile(join(ADMIN, path)); res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream", "Cache-Control": "no-store", ...extra }); res.end(b); } catch { res.writeHead(404); res.end("no"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
PORT = server.address().port;
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
  const canary = canaryNoise(pg);
  pg.on("console", (m) => {
    if (canary(m)) return; // the canary's ONE expected /deny/lib/canary/target.js 404 (e2e/lib/expected-noise.mjs, D19); any other /deny/ hit is a problem
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

try {
  // ── 1. owner list at 1280 ──
  console.log("owner: list at 1280");
  {
    const { ctx, pg } = await open("/design", { width: 1280 });
    await settle(pg);
    check("nav item 'Design history' is there and active", (await pg.locator(`.sidebar ${T("nav-design")}`).innerText()).includes("設計歷史") && await pg.locator(`.sidebar ${T("nav-design")}.is-on`).count() === 1);
    await pg.waitForSelector(`.sidebar ${T("nav-design-badge")}`);
    check("nav badge shows the pending approval count (2 across both sites)", (await pg.locator(`.sidebar ${T("nav-design-badge")}`).innerText()) === "2");
    check("20 rows on page 1 (storefront)", (await pg.locator(T("dh-row")).count()) === 20);
    check("the count line says 25 in total", (await pg.locator(T("dh-count")).innerText()).includes("25"));
    check("the awaiting row has its status chip", (await pg.locator(`${T("dh-row")}[data-status="awaiting_approval"]`).first().innerText()).includes("待你核准"));
    check("exactly the current design has the 'currently in use' marker", (await pg.locator(`${T("dh-row")}[data-current="1"]`).count()) === 1 && (await pg.locator(`${T("dh-row")}[data-current="1"]`).innerText()).includes("目前使用中"));
    check("the state line names the current design and the untracked changes", (await pg.locator(T("dh-current")).innerText()).includes("design-2026-11-25-1") && (await pg.locator(T("dh-untracked")).innerText()).includes("2"));
    check("no horizontal overflow at 1280", (await overflow(pg)) <= 0);
    await shot(pg, "owner-list-1280");
    // pagination
    await pg.locator(T("page-next")).click();
    await pg.waitForFunction(() => location.hash.includes("page=2"));
    await settle(pg);
    check("page 2 has the other 5 rows and says 2 / 2", (await pg.locator(T("dh-row")).count()) === 5 && (await pg.locator(T("page-now")).innerText()).replace(/\s/g, "") === "2/2");
    check("the page is in the URL (back button works)", /page=2/.test(await pg.evaluate(() => location.hash)));
    await pg.goBack(); await settle(pg);
    check("back returns to page 1", (await pg.locator(T("dh-row")).count()) === 20);
    // filter
    await pg.selectOption(T("dh-status"), "awaiting_approval");
    await pg.waitForFunction(() => location.hash.includes("status=awaiting_approval"));
    await settle(pg);
    check("the status filter narrows the list to the one awaiting request", (await pg.locator(T("dh-row")).count()) === 1);
    await pg.selectOption(T("dh-status"), "reverted");
    await settle(pg);
    check("a filter with no match shows its own empty text (not the 'no history' one)", (await pg.locator(T("dh-area")).innerText()).includes("這個條件下沒有紀錄"));
    await pg.selectOption(T("dh-status"), "");
    await settle(pg);
    // site tabs
    await pg.locator(T("dh-site-admin")).click();
    await pg.waitForFunction(() => location.hash.includes("site=admin"));
    await settle(pg);
    check("the admin tab lists the two admin requests and its own current tag", (await pg.locator(T("dh-row")).count()) === 2 && (await pg.locator(T("dh-current")).innerText()).includes("design-admin-1"));
    await ctx.close();
  }

  // ── 2. owner list at 390 ──
  console.log("owner: list at 390");
  {
    const { ctx, pg } = await open("/design", { width: 390, height: 844 });
    await settle(pg);
    check("cards on a phone: no horizontal overflow", (await overflow(pg)) <= 0, String(await overflow(pg)));
    check("a phone shows the table header hidden (stacked cards)", await pg.evaluate(() => getComputedStyle(document.querySelector(".rt thead")).display === "none"));
    check("tap targets are at least 44px (open links, site tabs, filter, pager)", (await small(pg, ".dh-open, .dh-tools .seg__item, .dh-tools select, .pager .btn")).length === 0, JSON.stringify(await small(pg, ".dh-open, .dh-tools .seg__item, .dh-tools select, .pager .btn")));
    await shot(pg, "owner-list-390");
    await pg.locator(T("tab-more")).click();
    await pg.waitForSelector(`dialog[open] ${T("nav-design")}`);
    check("the history item is in the 'more' sheet with the badge on a phone", (await pg.locator(`dialog[open] ${T("nav-design-badge")}`).count()) === 1);
    await ctx.close();
  }

  // ── 3. owner detail: claims vs record, plain text, review / approve ──
  console.log("owner: detail, review, approve");
  {
    const { ctx, pg } = await open(`/design/${RID}`, { width: 1280 });
    await pg.waitForSelector(T("dh-detail") + " " + T("dh-claims"));
    const claims = await pg.locator(T("dh-claims")).innerText(), record = await pg.locator(T("dh-record")).innerText();
    check("two separate regions with their labels", claims.includes("服務聲稱的內容（平台未驗證）") && record.includes("平台記錄") && (await pg.locator(T("dh-claims")).count()) === 1 && (await pg.locator(T("dh-record")).count()) === 1);
    check("the prompt is in the claims region, the proposer and state in the record region", claims.includes("make the banner pink") && !record.includes("make the banner pink") && record.includes("待你核准") && record.includes("Team member"));
    check("the prompt is plain text (no element made from its HTML) and bidi marks are gone", await pg.evaluate(() => { const p = document.querySelector('[data-testid="dh-prompt-text"]'); return p.querySelector("b") === null && p.textContent.includes("<b>bold</b>") && !p.textContent.includes("‮"); }));
    const shortLen = (await pg.locator(T("dh-prompt-text")).innerText()).length;
    check("a long prompt is truncated with an expand button", shortLen < 400 && (await pg.locator(T("dh-prompt-text-toggle")).count()) === 1);
    await pg.locator(T("dh-prompt-text-toggle")).click();
    check("expand shows the full text, collapse shortens it again", (await pg.locator(T("dh-prompt-text")).innerText()).length > 1000);
    await pg.locator(T("dh-prompt-text-toggle")).click();
    check("collapsed again", (await pg.locator(T("dh-prompt-text")).innerText()).length < 400);
    check("guard report and diff summary are shown in the claims region", /通過/.test(await pg.locator(T("dh-guard")).innerText()) && /2 個檔案，\+12 -3/.test(await pg.locator(T("dh-diff")).innerText()) && (await pg.locator(T("dh-diff")).innerText()).includes("admin/design/theme.css"));
    check("the preview link is a plain https link without opener (single slot)", await pg.evaluate(() => { const a = document.querySelector('[data-testid="dh-preview-link"]'); return a && a.tagName === "A" && a.href === "https://p-1.preview.example/" && a.rel.includes("noopener") && a.target === "_blank"; }));
    check("proposer name lost its bidi mark", !(await pg.locator(T("dh-rec-proposer")).innerText()).includes("‮"));
    check("the timeline lists the events", (await pg.locator(T("dh-event")).count()) === 2);
    check("owner sees review and cancel", (await pg.locator(T("dh-review")).count()) === 1 && (await pg.locator(T("dh-cancel")).count()) === 1);
    check("no horizontal overflow", (await overflow(pg)) <= 0);
    await shot(pg, "owner-detail-1280");
    await pg.locator(T("dh-review")).click();
    await pg.waitForSelector("dialog[open] .dlg-rv"); await sleep(450);
    await pg.waitForFunction(() => __dqa("dialog .dlg-rv__pic").filter((i) => i.naturalWidth > 0).length >= 1, null, { timeout: 15000 });
    const yes = pg.locator(`dialog ${T("confirm-yes")}`);
    check("the core review opens (fixed warning, approve disabled until the checkbox)", (await pg.locator(T("confirm-warning")).count()) === 1 && await yes.isDisabled());
    await pg.locator(T("confirm-rv-ack")).click();
    await yes.click();
    await dialogGone(pg);
    check("one approve with the sha and ETag the review read", S.approveCalls.length === 1 && S.approveCalls[0].body.head_sha === SHA1 && S.approveCalls[0].ifMatch === '"5"', JSON.stringify(S.approveCalls));
    await pg.waitForFunction(() => document.querySelector('[data-testid="dh-rec-state"]') && (document.querySelector('[data-testid="dh-rec-state"]') || { innerText: "" }).innerText.includes("已核准"), null, { timeout: 8000 });
    check("the screen reloaded: record shows approved with the approver", (await pg.locator(T("dh-rec-approver")).innerText()).includes("Shop owner") && (await pg.locator(T("dh-review")).count()) === 0);
    await ctx.close();
  }

  // ── 4. reject, request changes, cancel ──
  console.log("owner: reject, request changes, cancel");
  {
    const go = async (pg) => { await pg.locator(T("dh-review")).click(); await pg.waitForSelector("dialog[open] .dlg-rv"); await sleep(450); await pg.waitForSelector(T("confirm-rv-reject")); };
    let o = await open(`/design/${RID}`);
    await o.pg.waitForSelector(T("dh-review")); await go(o.pg);
    await o.pg.locator(T("confirm-rv-reject")).click();
    await o.pg.fill(T("confirm-rv-reason"), "not pink enough");
    await o.pg.locator(`dialog ${T("confirm-yes")}`).click();
    await dialogGone(o.pg);
    await o.pg.waitForFunction(() => (document.querySelector('[data-testid="dh-rec-state"]') || { innerText: "" }).innerText.includes("已拒絕"), null, { timeout: 8000 });
    check("reject: one POST with the reason, screen shows rejected", S.rejectCalls.length === 1 && S.rejectCalls[0].reason === "not pink enough");
    await o.ctx.close();
    o = await open(`/design/${RID}`);
    await o.pg.waitForSelector(T("dh-review")); await go(o.pg);
    await o.pg.locator(T("confirm-rv-changes")).click();
    await o.pg.fill(T("confirm-rv-note"), "make the banner blue");
    await o.pg.locator(`dialog ${T("confirm-yes")}`).click();
    await dialogGone(o.pg);
    await o.pg.waitForFunction(() => (document.querySelector('[data-testid="dh-rec-state"]') || { innerText: "" }).innerText.includes("草稿中"), null, { timeout: 8000 });
    check("request changes: one POST with the note, screen shows drafting", S.changeCalls.length === 1 && S.changeCalls[0].note === "make the banner blue");
    check("a drafting request with no screenshots yet says so (its own empty text)", (await o.pg.locator(T("dh-no-shots")).innerText()).includes("還沒有前後截圖"));
    await o.ctx.close();
    o = await open(`/design/${RID}`);
    await o.pg.waitForSelector(T("dh-cancel"));
    await o.pg.locator(T("dh-cancel")).click();
    await o.pg.waitForSelector(`dialog[open] ${T("confirm-yes")}`);
    check("cancel asks first in a core confirmation with a fixed warning", (await o.pg.locator(T("confirm-warning")).count()) === 1 && S.cancelCalls.length === 0);
    await o.pg.locator(`dialog[open] ${T("confirm-yes")}`).click();
    await dialogGone(o.pg);
    await o.pg.waitForFunction(() => (document.querySelector('[data-testid="dh-rec-state"]') || { innerText: "" }).innerText.includes("已取消"), null, { timeout: 8000 });
    check("cancel: one POST, screen shows cancelled and no action buttons", S.cancelCalls.length === 1 && (await o.pg.locator(T("dh-actions")).count()) === 0);
    await o.ctx.close();
  }

  // ── 5. published rows: preview this version, revert request ──
  console.log("owner: published row, preview and revert");
  {
    let o = await open(`/design/${PUB}`);
    await o.pg.waitForSelector(T("vp-section"));
    check("a published row has 'preview this version' and the fixed limits text", (await o.pg.locator(T("vp-request")).count()) === 1 && (await o.pg.locator(T("vp-limits")).innerText()).includes("不是那一版當時被核准內容的紀錄"));
    check("the record region shows the tag and approver", (await o.pg.locator(T("dh-rec-tag")).innerText()).includes("design-2026-10-01") && (await o.pg.locator(T("dh-rec-approver")).innerText()).includes("Shop owner"));
    check("an unnamed proposer gets the neutral fallback", (await o.pg.locator(T("dh-rec-proposer")).innerText()).includes("（未知）"));
    await o.pg.locator(T("vp-request")).click();
    await o.pg.waitForSelector(T("vp-open"));
    check("the version preview link is shown", (await o.pg.locator(T("vp-open")).evaluate((a) => a.href)) === "https://v-1.preview.example/");
    check("'change to this version' is there for the owner", (await o.pg.locator(T("vp-revert")).count()) === 1);
    await shot(o.pg, "owner-detail-published-1280");
    await o.pg.locator(T("vp-revert")).click();
    await o.pg.waitForSelector(`dialog[open] ${T("confirm-yes")}`);
    check("the core asks first (fixed warning), nothing was created yet", (await o.pg.locator(T("confirm-warning")).count()) === 1 && S.revertCalls.length === 0);
    await o.pg.locator(`dialog[open] ${T("confirm-yes")}`).click();
    await dialogGone(o.pg);
    await o.pg.waitForFunction((id) => location.hash === "#/design/" + id, NEWREV, { timeout: 8000 });
    check("one revert POST for the published row and the screen moved to the new request", S.revertCalls.length === 1 && S.revertCalls[0].id === PUB);
    await o.pg.waitForSelector(T("dh-record"));
    check("the new request is a drafting revert with its target tag", (await o.pg.locator(T("dh-record")).innerText()).includes("design-2026-10-01") && (await o.pg.locator(T("dh-record")).innerText()).includes("還原"));
    await o.ctx.close();
    o = await open(`/design/${CUR}`);
    await o.pg.waitForSelector(T("vp-section"));
    check("the design in use shows no 'change to this version' button and says it is in use", (await o.pg.locator(T("vp-revert")).count()) === 0 && (await o.pg.locator(T("dh-published")).innerText()).includes("這是目前使用中的設計"));
    await o.ctx.close();
  }

  // ── 6. 390 detail for the owner ──
  console.log("owner: detail at 390");
  {
    const { ctx, pg } = await open(`/design/${RID}`, { width: 390, height: 844 });
    await pg.waitForSelector(T("dh-claims"));
    check("no horizontal overflow at 390", (await overflow(pg)) <= 0, String(await overflow(pg)));
    check("tap targets are at least 44px (buttons, expand, back)", (await small(pg, ".dh-actions .btn, .dh-more, .dh-long .btn, .dh-back")).length === 0, JSON.stringify(await small(pg, ".dh-actions .btn, .dh-long .btn, .dh-back")));
    await shot(pg, "owner-detail-390");
    await ctx.close();
  }

  // ── 7. editor: read only ──
  console.log("editor: read only");
  {
    let o = await open("/design", { role: "editor" });
    await settle(o.pg);
    check("editor sees the nav item and the list", (await o.pg.locator(T("nav-design")).count()) >= 1 && (await o.pg.locator(T("dh-row")).count()) === 20);
    await shot(o.pg, "editor-list-1280");
    await o.ctx.close();
    o = await open(`/design/${RID}`, { role: "editor" });
    await o.pg.waitForSelector(T("dh-claims"));
    check("editor: no cancel; the hint says viewing only", (await o.pg.locator(T("dh-cancel")).count()) === 0 && (await o.pg.locator(T("dh-act-hint")).innerText()).includes("沒有核准的權限"));
    await shot(o.pg, "editor-detail-1280");
    await o.pg.locator(T("dh-review")).click();
    await o.pg.waitForSelector("dialog[open] .dlg-rv"); await sleep(450);
    check("editor: the core review has no approve, reject or changes button", (await o.pg.locator(`dialog ${T("confirm-yes")}`).count()) === 0 && (await o.pg.locator(T("confirm-rv-reject")).count()) === 0 && (await o.pg.locator(T("confirm-rv-changes")).count()) === 0);
    await o.pg.keyboard.press("Escape");
    await o.ctx.close();
    o = await open(`/design/${PUB}`, { role: "editor" });
    await o.pg.waitForSelector(T("vp-section"));
    check("editor: preview this version yes, change to this version no", (await o.pg.locator(T("vp-request")).count()) === 1 && (await o.pg.locator(T("vp-revert")).count()) === 0);
    check("editor sent no write", S.writes === 0, String(S.writes));
    await o.ctx.close();
    o = await open(`/design/${RID}`, { role: "editor", width: 390, height: 844 });
    await o.pg.waitForSelector(T("dh-claims"));
    await shot(o.pg, "editor-detail-390");
    o.ctx.close();
    o = await open("/design", { role: "editor", width: 390, height: 844 });
    await settle(o.pg);
    await shot(o.pg, "editor-list-390");
    await o.ctx.close();
  }

  // ── 8. staff: nothing ──
  console.log("staff: no nav, noPermission");
  {
    let o = await open("/design", { role: "staff", width: 1280 });
    await o.pg.waitForSelector(T("no-permission"));
    check("staff: no nav item (sidebar, tab bar), no badge", (await o.pg.locator(T("nav-design")).count()) === 0 && (await o.pg.locator(T("nav-design-badge")).count()) === 0);
    check("staff: the direct URL shows noPermission and the list was never asked for", S.listCalls === 0);
    await shot(o.pg, "staff-direct-url-1280");
    await o.pg.goto(URL0 + "#/design/" + RID);
    await o.pg.waitForSelector(T("no-permission"));
    check("staff: a request URL is noPermission too", (await o.pg.locator(T("dh-claims")).count()) === 0);
    await o.ctx.close();
    o = await open("/design", { role: "staff", width: 390, height: 844 });
    await o.pg.waitForSelector(T("no-permission"));
    await shot(o.pg, "staff-direct-url-390");
    await o.ctx.close();
  }

  // ── 9. preview hosts ──
  for (const kind of ["version", "change"]) {
    console.log(`preview host (${kind}): read only`);
    let o = await open(`/design/${RID}`, { preview: kind });
    await o.pg.waitForSelector(T("dh-claims"));
    check(`${kind}: the detail renders, the action bar is replaced by the read-only note`, (await o.pg.locator(T("dh-actions")).count()) === 0 && (await o.pg.locator(T("dh-review")).count()) === 0 && (await o.pg.locator(T("dh-cancel")).count()) === 0 && (await o.pg.locator(T("dh-readonly")).count()) === 1);
    await o.ctx.close();
    o = await open(`/design/${PUB}`, { preview: kind });
    await o.pg.waitForSelector(T("dh-record"));
    check(`${kind}: a published row offers no preview or change button`, (await o.pg.locator(T("vp-request")).count()) === 0 && (await o.pg.locator(T("vp-revert")).count()) === 0 && (await o.pg.locator(T("dh-vp-off")).count()) === 1);
    check(`${kind}: nothing was sent`, S.writes === 0);
    await o.ctx.close();
    o = await open("/design", { preview: kind });
    await settle(o.pg);
    check(`${kind}: the list renders`, (await o.pg.locator(T("dh-row")).count()) === 20);
    if (kind === "version") await shot(o.pg, "preview-mode-list-1280");
    await o.ctx.close();
  }

  // ── 10. empty and error states ──
  console.log("empty and error states");
  {
    let o = await open("/design", { empty: true });
    await settle(o.pg);
    check("no history: its own text", (await o.pg.locator(T("dh-area")).innerText()).includes("還沒有任何 AI 改版紀錄"));
    await shot(o.pg, "empty-none-1280");
    await o.ctx.close();
    o = await open("/design", { storage503: true, expectHttp: true });
    await settle(o.pg);
    const t503 = await o.pg.locator(T("dh-area")).innerText();
    check("storage not configured (503 design_storage_not_configured): a different text", t503.includes("尚未設定設計截圖儲存") && !t503.includes("RAW") && !t503.includes("還沒有任何 AI 改版紀錄"));
    await shot(o.pg, "empty-storage-1280");
    await o.ctx.close();
    o = await open(`/design/${DRAFT}`);
    await o.pg.waitForSelector(T("dh-no-shots"));
    check("no screenshots yet: its own text on a request without them", (await o.pg.locator(T("dh-no-shots")).innerText()).includes("還沒有前後截圖") && !(await o.pg.locator(T("dh-no-shots")).innerText()).includes("儲存"));
    await o.ctx.close();
    o = await open("/design", { listError: true, expectHttp: true, width: 390, height: 844 });
    await settle(o.pg);
    check("a server error shows the error state with a retry button", (await o.pg.locator(".state--error").count()) === 1 && (await o.pg.locator(T("dh-area") + " .btn").count()) === 1);
    check("the raw error text is not shown", !(await o.pg.locator(T("dh-area")).innerText()).includes("RAW"));
    await shot(o.pg, "error-390");
    S.listError = false;
    await o.pg.locator(T("dh-area") + " .btn").click();
    await settle(o.pg);
    check("retry recovers", (await o.pg.locator(T("dh-row")).count()) === 20);
    await o.ctx.close();
    o = await open("/design", { stateFail: true, expectHttp: true });
    await settle(o.pg);
    check("a failing state call is ignored (list and nav still work, no badge)", (await o.pg.locator(T("dh-row")).count()) === 20 && (await o.pg.locator(T("nav-design-badge")).count()) === 0);
    await o.ctx.close();
    o = await open(`/design/${uid(4242)}`, { expectHttp: true });
    await o.pg.waitForSelector(".state--error");
    check("an unknown request id shows a not-found message with retry", (await o.pg.locator(T("dh-detail")).innerText()).length > 0 && !(await o.pg.locator(T("dh-detail")).innerText()).includes("RAW"));
    await o.ctx.close();
  }

  // ── 10b. design_enabled gates the nav item, never the direct routes (D16) ──
  console.log("design_enabled: nav gating, direct routes, badge");
  {
    const navCount = async (pg) => (await pg.locator(T("nav-design")).count()) + (await pg.locator(T("nav-design-badge")).count());
    let o = await open("/", { designEnabled: false });
    await settle(o.pg, ".main"); await sleep(600);
    check("design_enabled=false: no nav item and no badge on the home screen (sidebar identical to a shop without the feature)", (await navCount(o.pg)) === 0);
    await o.ctx.close();
    o = await open("/", { designEnabled: false });
    await sleep(600);
    const teamY = await o.pg.locator(`.sidebar__list [data-nav]:not([data-nav="design"])`).last().evaluate((e) => e.getBoundingClientRect().top);
    await o.ctx.close();
    o = await open("/", { designEnabled: true });
    await o.pg.waitForSelector(`.sidebar ${T("nav-design")}`);
    check("enabling the item moves no existing item (Team link at the same place; the item is last)", (await o.pg.locator(`.sidebar__list [data-nav]:not([data-nav="design"])`).last().evaluate((e) => e.getBoundingClientRect().top)) === teamY && (await o.pg.locator(`.sidebar__list [data-nav]`).last().getAttribute("data-nav")) === "design");
    check("design_enabled=true: the item appears (sidebar) with the pending badge", (await o.pg.locator(`.sidebar ${T("nav-design")}`).count()) === 1 && (await o.pg.locator(`.sidebar ${T("nav-design-badge")}`).innerText()) === "2");
    await o.ctx.close();
    for (const [label, st] of [["state call failing", { stateFail: true, expectHttp: true }], ["field absent", { noDesignEnabledField: true }], ["field malformed (string)", { designEnabledRaw: "true" }]]) {
      o = await open("/", st);
      await settle(o.pg, ".main"); await sleep(600);
      check(`${label}: the nav item stays hidden, no badge`, (await navCount(o.pg)) === 0);
      await o.ctx.close();
    }
    o = await open("/", { designEnabled: false, width: 390, height: 844 });
    await sleep(600);
    await o.pg.locator(T("tab-more")).click();
    await o.pg.waitForSelector("dialog[open]");
    check("design_enabled=false on a phone: not in the 'more' sheet either", (await o.pg.locator(`dialog ${T("nav-design")}`).count()) === 0);
    await o.ctx.close();
    o = await open("/", { role: "staff", designEnabled: true, expectHttp: true });
    await sleep(600);
    check("staff: no nav item even when design_enabled=true", (await navCount(o.pg)) === 0);
    await o.ctx.close();
    o = await open("/", { role: "editor", designEnabled: true, expectHttp: true });
    await o.pg.waitForSelector(`.sidebar ${T("nav-design")}`);
    check("editor (design.view) sees the item when enabled", true);
    await o.ctx.close();
    // direct routes stay reachable
    o = await open("/design", { designEnabled: false, empty: true });
    await settle(o.pg);
    const dis = await o.pg.locator(T("dh-area")).innerText();
    check("direct /design, disabled and no history: calm 'AI edit is not enabled' state, no error styling", dis.includes("尚未開啟 AI 改版") && (await o.pg.locator(T("dh-disabled")).count()) === 1 && (await o.pg.locator(".state--error").count()) === 0 && !dis.includes("還沒有任何 AI 改版紀錄"));
    check("direct /design, disabled: the nav item stays hidden", (await navCount(o.pg)) === 0);
    await shot(o.pg, "disabled-empty-1280");
    await o.ctx.close();
    o = await open("/design", { designEnabled: false });
    await settle(o.pg);
    check("direct /design, disabled but with history: the list is shown", (await o.pg.locator(T("dh-row")).count()) === 20 && (await o.pg.locator(T("dh-disabled")).count()) === 0);
    await o.ctx.close();
    o = await open(`/design/${RID}`, { designEnabled: false });
    await o.pg.waitForSelector(T("dh-claims"));
    check("direct /design/:id, disabled: a request that exists still opens", true);
    await o.ctx.close();
    o = await open("/design", { role: "staff", designEnabled: false });
    await o.pg.waitForSelector(T("no-permission"));
    check("staff on /design: noPermission whatever design_enabled says", S.listCalls === 0);
    await o.ctx.close();
    o = await open("/design", { designEnabled: true, empty: true });
    await settle(o.pg);
    check("enabled and no history: the usual 'no history yet' text", (await o.pg.locator(T("dh-area")).innerText()).includes("還沒有任何 AI 改版紀錄"));
    await o.ctx.close();
  }

  // ── 10c. out-of-range page and rapid next-page clicks ──
  console.log("paging: out of range, rapid clicks");
  {
    let o = await open("/design?page=99999999999");
    await settle(o.pg); await sleep(300);
    check("page far out of range: jumps to the last page (2) with its rows", /page=2/.test(await o.pg.evaluate(() => location.hash)) && (await o.pg.locator(T("dh-row")).count()) === 5 && (await o.pg.locator(T("dh-count")).innerText()).includes("25"));
    await o.ctx.close();
    for (const pageNo of [3, 5]) {
      o = await open(`/design?page=${pageNo}`, { inconsistent: true });
      await settle(o.pg); await sleep(1500);
      check(`inconsistent API (total 50, no rows) at page ${pageNo}: bounded requests (${S.listCalls}) and a normal empty state`, S.listCalls <= 3 && (await o.pg.locator(T("dh-area")).innerText()).length > 0 && (await o.pg.locator(T("dh-row")).count()) === 0);
      await o.ctx.close();
    }
    o = await open("/design");
    await settle(o.pg);
    const before = S.listCalls;
    await o.pg.evaluate(() => { const b = document.querySelector('[data-testid="page-next"]'); b.click(); b.click(); b.click(); });
    await settle(o.pg); await sleep(400);
    check("three rapid next-page clicks ask the list once", S.listCalls === before + 1, `${S.listCalls - before} requests`);
    check("and land on page 2", /page=2/.test(await o.pg.evaluate(() => location.hash)));
    await o.ctx.close();
  }

  // ── 11. keyboard ──
  console.log("keyboard");
  {
    const { ctx, pg } = await open("/design");
    await settle(pg);
    await pg.locator(`${T("dh-row")}[data-status="awaiting_approval"] ${T("dh-open")}`).focus();
    await pg.keyboard.press("Enter");
    await pg.waitForSelector(T("dh-claims"));
    check("Enter on a row's detail link opens the request", (await pg.evaluate(() => location.hash)) === `#/design/${RID}`);
    await pg.locator(T("dh-review")).focus();
    await pg.keyboard.press("Enter");
    await pg.waitForSelector("dialog[open] .dlg-rv");
    check("Enter on the review button opens the core review", true);
    await pg.keyboard.press("Escape");
    await ctx.close();
  }

  check("no console error, page error or CSP violation anywhere", problems.length === 0, JSON.stringify(problems.slice(0, 5)));
  const sane = warnings.filter((w) => !/Failed to load resource/.test(w));
  check("no design warning (a refused attribute or link would be logged)", sane.length === 0, JSON.stringify(sane.slice(0, 5)));
} catch (e) {
  failures++; console.error("  FAIL test crashed:", e && e.stack || e);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
