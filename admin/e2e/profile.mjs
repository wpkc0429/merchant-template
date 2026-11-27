// Real-browser test of the personal profile page and the one-time hint (docs/DECISIONS.md D21), headless Chromium via Playwright.
// NO platform needed: one tiny server serves the admin files AND a fake platform API (GET / PATCH /admin/me with display_name, the design history reads the hint
// sits above), under the REAL strict CSP of admin/deploy/nginx.conf.template. The shipped design/ files are used (no test view). It also proves the design layer
// cannot take the page over: no request for a design view named after the profile is ever made.
// Covered: owner / editor / staff reach the page (staff has no design.view and still gets it), the navigation entry (sidebar foot at 1280, "more" sheet at 390),
// the field with label, helper text, counter and aria wiring, client validation (email, phone, card-like number, too long, newline) with focus on the field and NOTHING sent,
// save and clear (one PATCH each, the cleaned value), the 422, 500 and network failures and a failed load with retry, preview hosts (read-only, nothing sent), the hint
// (shows only for design.view without a name, dismiss, stays dismissed, gone after saving, never on a preview host or for an unknown name), keyboard use, 44px tap targets,
// no horizontal overflow, 390 and 1280 screenshots, no console error, no CSP violation, no personal data in the console.
// Needs Playwright via $PLAYWRIGHT_DIR and SKIPS cleanly (exit 0) when it is not found.  Screenshots go to $PROFILE_SHOTS (default admin/e2e/out/profile).
// Run: node admin/e2e/profile.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hookBrowser } from "./lib/shadow-hook.mjs";
import { skipOrFail } from "./lib/require-browser.mjs";
import { SCRIPT_SRC } from "./lib/csp.mjs";
import { canaryNoise, isHttpFailure } from "./lib/expected-noise.mjs";

const ADMIN = resolve(fileURLToPath(new URL("..", import.meta.url)));
const csp = (connect) => "default-src 'self'; " + SCRIPT_SRC + "; style-src 'self'; font-src 'self'; img-src 'self' data: blob:; connect-src " + connect + "; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
const SHOTS = process.env.PROFILE_SHOTS || resolve(ADMIN, "e2e/out/profile");
const HOST = "admin.example.test";
function loadPlaywright() {
  for (const d of [process.env.PLAYWRIGHT_DIR].filter(Boolean)) {
    try { return createRequire(join(d, "package.json"))("playwright"); } catch { /* try the next */ }
  }
  return null;
}
const pw = loadPlaywright();
if (!pw) { skipOrFail("profile browser test: Playwright not found (set PLAYWRIGHT_DIR)"); }
let browser;
try { browser = hookBrowser(await pw.chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })); } catch (e) {
  skipOrFail(`profile browser test: Chromium could not start (${String(e.message).split("\n")[0]})`);
}
mkdirSync(SHOTS, { recursive: true });

// ── fake platform ──
const uid = (n) => `${String(n).padStart(8, "0")}-1111-4222-8333-${String(n).padStart(12, "0")}`;
const RID = uid(1), CUR = uid(2);
const SHA1 = "a1".repeat(20);
const PERMS = { owner: ["design.view", "design.request", "design.approve", "design.revert"], editor: ["design.view"], staff: ["order.view"] };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const ALLOW = /^\/(index\.html|app\.js|config\.js|config-loader\.js|styles\.css|(lib|ui|core|vendor)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+|(design|design-defaults)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+\.(js|css|svg|png))$/;
let PORT = 0;
let S;
const mk = (id, o) => ({
  id, site: "storefront", kind: "change", status: "published", base_sha: SHA1, head_sha: SHA1, candidate_sha: null, core_version: "0.4.2", design_floor_version: "0.3.0",
  rev: 5, created_at: "2026-11-26T09:00:00Z", updated_at: "2026-11-26T10:00:00Z", prompt_excerpt: "excerpt", prompt_text: "full prompt",
  proposed_by_name: "Team member", approved_by_name: null, is_current: false, revert_target_tag: null, published_tag: null, publish_tag: null,
  diff_summary: { files_changed: 1, additions: 2, deletions: 1, files: [{ path: "admin/design/theme.css", status: "modified", additions: 2, deletions: 1 }] },
  guard: { passed: true, checked_sha: SHA1, rule_ids: [], violation_count: 0, guard_version: "0.4.2", checked_at: "2026-11-26T10:00:00Z" },
  preview_origin: null, preview_read_only: true, ...o,
});
const resetState = (o = {}) => {
  const reqs = new Map();
  reqs.set(RID, mk(RID, { status: "awaiting_approval", candidate_sha: SHA1, prompt_excerpt: "make the banner pink" }));
  reqs.set(CUR, mk(CUR, { is_current: true, published_tag: "design-2026-11-25-1", approved_by_name: "Shop owner", prompt_excerpt: "current design" }));
  // display: the stored name (null = none, undefined = the platform does not send the field). patch: "ok" | "422" | "500" | "drop" (the connection is cut).
  S = { role: "owner", preview: "", display: null, patch: "ok", meFailFrom: 0, meGets: 0, reqs, patches: [], writes: 0, ...o };
};
resetState();
const json = (res, status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const requested = []; // every path the browser asked for (to prove no design view for the profile is ever fetched)
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  requested.push(p);
  if (p.startsWith("/api/v1/")) {
    const a = p.slice("/api/v1".length), m = req.method;
    if (m !== "GET" && a !== "/admin/auth/refresh") S.writes++;
    if (m === "POST" && a === "/admin/auth/refresh") return json(res, 200, { access_token: "tok-" + Math.random().toString(36).slice(2), ...(S.preview ? { scope: "preview_ro" } : {}) });
    if (a === "/admin/me" && m === "GET") {
      S.meGets++;
      if (S.meFailFrom && S.meGets >= S.meFailFrom) return json(res, 500, { error: { code: "boom", message: "RAW" } });
      const me = { id: S.role === "owner" ? 1 : S.role === "editor" ? 2 : 3, email: `${S.role}@example.com`, sids: [1], platform_permissions: [] };
      if (S.display !== undefined) me.display_name = S.display;
      return json(res, 200, me);
    }
    if (a === "/admin/me" && m === "PATCH") {
      const body = await readBody(req);
      S.patches.push(body);
      if (S.patch === "drop") { req.socket.destroy(); return; }
      if (S.patch === "422") return json(res, 422, { error: { code: "validation_failed", message: "display_name must not contain an email address, phone number or card number" } });
      if (S.patch === "500") return json(res, 500, { error: { code: "boom", message: "RAW" } });
      const v = String(body.display_name ?? "").trim();
      S.display = v === "" ? null : v;
      return json(res, 200, { id: 1, display_name: S.display });
    }
    if (a === "/admin/shops/1/me") return json(res, 200, { permissions: PERMS[S.role] });
    if (a === "/admin/branding" || a === "/admin/shops/1/branding") return json(res, 200, { name: "Test Shop", branding: {} });
    if (a === "/admin/media/config") return json(res, 200, { enabled: false });
    if (m === "GET" && a === "/admin/shops/1/design/requests") {
      const page = Number(u.searchParams.get("page") || 1), size = Number(u.searchParams.get("page_size") || 20);
      const all = [...S.reqs.values()].filter((r) => !u.searchParams.get("site") || r.site === u.searchParams.get("site"));
      return json(res, 200, { requests: all.slice((page - 1) * size, page * size), page, page_size: size, total: all.length });
    }
    if (m === "GET" && a === "/admin/shops/1/design/state") {
      return json(res, 200, { sites: [{ site: "storefront", untracked_changes: 0, current_request_id: CUR, current_tag: "design-2026-11-25-1", core_version: "0.4.2", pending_approval_count: 1 },
        { site: "admin", untracked_changes: 0, current_request_id: null, current_tag: null, core_version: "0.4.2", pending_approval_count: 0 }], pending_approval_count: 1, design_enabled: true });
    }
    const mm = /^\/admin\/shops\/1\/design\/requests\/([0-9a-f-]+)(\/[a-z-]+)?$/.exec(a);
    if (mm && m === "GET") {
      const r = S.reqs.get(mm[1]);
      if (!r) return json(res, 404, { error: { code: "not_found", message: "no" } });
      if (!mm[2]) return json(res, 200, r, { ETag: `"${r.rev}"` });
      if (mm[2] === "/events") return json(res, 200, { events: [] });
      if (mm[2] === "/screenshots") return json(res, 200, { screenshots: [] });
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
const consoleText = []; // everything the console said (no personal data may be in it)

// expect: [{path, status}] failures this scenario provokes on purpose (isHttpFailure in e2e/lib/expected-noise.mjs); anything else is a problem
async function open(hash, { width = 1280, height = 900, expect = [], ...state } = {}) {
  resetState(state);
  const ctx = await browser.newContext({ viewport: { width, height } });
  const pg = await ctx.newPage();
  const tag = `${state.role || "owner"}@${width} ${hash}`;
  const canary = canaryNoise(pg);
  pg.on("console", (m) => {
    consoleText.push(m.text());
    if (canary(m)) return;
    const x = m.text();
    if (expect.some((e) => isHttpFailure(m.type(), x, (m.location() || {}).url || "", e.path, e.status))) return;
    if (/Failed to load resource: net::ERR_(EMPTY_RESPONSE|CONNECTION_RESET|CONNECTION_CLOSED)/.test(x) && state.patch === "drop") return;
    if (m.type() === "error" || /Content Security Policy|Refused to/i.test(x)) problems.push(`${tag}: ${x}`);
  });
  pg.on("pageerror", (e) => problems.push(`${tag}: pageerror ${e.message}`));
  await pg.goto(URL0 + "#" + hash, { waitUntil: "load" });
  await pg.waitForSelector(".shell", { timeout: 15000 });
  return { ctx, pg };
}
const form = (pg) => pg.waitForSelector(T("profile-form"), { timeout: 10000 });
const overflow = (pg) => pg.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth);
const small = (pg, sel) => pg.evaluate((s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent !== null).map((e) => Math.round(e.getBoundingClientRect().height * 10) / 10).filter((h) => h < 43.9), sel);
const shot = (pg, name) => pg.screenshot({ path: join(SHOTS, name + ".png"), fullPage: true });
const type = async (pg, text) => { await pg.fill(T("profile-name"), text); };
const errText = (pg) => pg.locator(T("profile-error")).innerText();
const activeTid = (pg) => pg.evaluate(() => { const a = __active(); return a ? a.getAttribute("data-testid") || a.tagName : ""; });

try {
  // ── 1. owner at 1280: entry point, page, validation, save, clear ──
  console.log("owner: the page at 1280");
  {
    const { ctx, pg } = await open("/", { width: 1280 });
    check("the sidebar foot has the profile link, under the email and above logout, and it is not in the main list", await pg.evaluate(() => {
      const foot = document.querySelector(".sidebar__foot"), list = document.querySelector(".sidebar__list");
      const link = foot.querySelector('[data-testid="nav-profile"]');
      return !!link && !list.querySelector('[data-testid="nav-profile"]') && link.innerText.trim() === "個人資料" && link.getAttribute("href") === "#/profile"
        && foot.children[0].className === "who" && foot.children[1] === link && foot.children[2].getAttribute("data-testid") === "logout";
    }));
    await pg.locator(`.sidebar ${T("nav-profile")}`).click();
    await form(pg);
    check("the route is /profile, the link is marked active and the title is the core's", (await pg.evaluate(() => location.hash)) === "#/profile" && (await pg.locator(`.sidebar ${T("nav-profile")}.is-on`).count()) === 1 && (await pg.locator("h1").innerText()) === "個人資料");
    check("one label bound to the field, the helper text is the owner's wording", (await pg.evaluate(() => { const l = document.querySelector('label[for="pf-name"]'); return l && l.innerText === "顯示名稱" && document.getElementById("pf-name") === document.querySelector('[data-testid="profile-name"]'); }))
      && (await pg.locator(T("profile-help")).innerText()) === "隊友會在設計歷史中看到這個名稱；請不要填 email 或電話。");
    check("aria-describedby points at the helper text and the counter (and nothing else yet)", (await pg.getAttribute(T("profile-name"), "aria-describedby")) === "pf-help pf-count" && !(await pg.getAttribute(T("profile-name"), "aria-invalid")));
    check("empty at first: counter 0 / 80, clear is disabled", (await pg.locator(T("profile-count")).innerText()) === "0 / 80" && await pg.locator(T("profile-clear")).isDisabled());
    check("the page is core text only (no design view was requested for it)", !requested.some((r) => /profile/.test(r) && /^\/design\//.test(r)));
    check("no horizontal overflow", (await overflow(pg)) <= 0);
    check("tap targets are at least 44px (field, save, clear, sidebar link)", (await small(pg, ".profile .input, .profile .btn, .sidebar__foot .navlink")).length === 0, JSON.stringify(await small(pg, ".profile .input, .profile .btn, .sidebar__foot .navlink")));
    await shot(pg, "owner-profile-empty-1280");

    // client validation: nothing is sent, the field gets the focus, the error is announced and wired
    const cases = [["sam@example.com", "email"], ["0912345678", "電話"], ["4242 4242 4242 4242", "卡號"], ["a".repeat(81), "81"]];
    for (const [v, word] of cases) {
      await type(pg, v);
      await pg.locator(T("profile-save")).click();
      const e = await errText(pg);
      check(`"${v.slice(0, 14)}": refused with a calm message, focus on the field, aria-invalid and describedby, nothing sent`, e.includes(word) && (await activeTid(pg)) === "profile-name" && (await pg.getAttribute(T("profile-name"), "aria-invalid")) === "true"
        && (await pg.getAttribute(T("profile-name"), "aria-describedby")).includes("pf-error") && S.patches.length === 0 && (await pg.locator(T("profile-error")).getAttribute("role")) === "alert", e);
    }
    check("the counter turns into a text warning past 80 (not colour only)", (await pg.locator(T("profile-count")).innerText()) === "81 / 80" && await pg.locator(`${T("profile-count")}.is-over`).count() === 1);
    await shot(pg, "owner-profile-error-1280");
    await type(pg, "Sam");
    check("fixing the text clears the error at once", (await errText(pg)) === "" && !(await pg.getAttribute(T("profile-name"), "aria-invalid")) && (await pg.getAttribute(T("profile-name"), "aria-describedby")) === "pf-help pf-count");
    // save
    await type(pg, "  Sam Lee  ");
    await pg.locator(T("profile-save")).click();
    await pg.waitForFunction(() => document.querySelector('[data-testid="profile-status"]').innerText.includes("已儲存"));
    check("one PATCH with the trimmed name", S.patches.length === 1 && S.patches[0].display_name === "Sam Lee" && S.display === "Sam Lee", JSON.stringify(S.patches));
    check("success is said in the page (role=status) and in a toast; the field shows what the platform kept", (await pg.locator(T("profile-status")).innerText()).includes("Sam Lee") && (await pg.locator("#toasts .toast").count()) >= 1 && (await pg.inputValue(T("profile-name"))) === "Sam Lee" && await pg.locator(T("profile-clear")).isEnabled());
    await shot(pg, "owner-profile-saved-1280");
    await pg.reload(); await form(pg);
    check("after a reload the saved name is read back", (await pg.inputValue(T("profile-name"))) === "Sam Lee" && (await pg.locator(T("profile-count")).innerText()) === "7 / 80");
    // clear
    await pg.locator(T("profile-clear")).click();
    await pg.waitForFunction(() => document.querySelector('[data-testid="profile-status"]').innerText.includes("已清除"));
    check("clear: one PATCH with an empty name, the field is empty and clear is disabled again", S.patches.length === 2 && S.patches[1].display_name === "" && S.display === null && (await pg.inputValue(T("profile-name"))) === "" && await pg.locator(T("profile-clear")).isDisabled());
    // saving an empty field when a name exists is a clear, too
    await type(pg, "Pat"); await pg.locator(T("profile-save")).click();
    await pg.waitForFunction(() => document.querySelector('[data-testid="profile-status"]').innerText.includes("Pat"));
    await type(pg, "   "); await pg.locator(T("profile-save")).click();
    await pg.waitForFunction(() => document.querySelector('[data-testid="profile-status"]').innerText.includes("已清除"));
    check("an empty (or blank) field saved over a name clears it", S.display === null && S.patches[S.patches.length - 1].display_name === "");
    await ctx.close();
  }

  // ── 2. keyboard ──
  console.log("keyboard");
  {
    const { ctx, pg } = await open("/profile");
    await form(pg);
    await pg.locator(T("profile-name")).focus();
    await pg.keyboard.type("Kim");
    await pg.keyboard.press("Enter");
    await pg.waitForFunction(() => document.querySelector('[data-testid="profile-status"]').innerText.includes("Kim"));
    check("Enter in the field saves", S.patches.length === 1 && S.patches[0].display_name === "Kim");
    await pg.locator(T("profile-name")).focus();
    await pg.keyboard.press("Tab");
    check("Tab goes from the field to Save, then to Clear", (await activeTid(pg)) === "profile-save");
    await pg.keyboard.press("Tab");
    check("...then Clear", (await activeTid(pg)) === "profile-clear");
    await pg.keyboard.press("Enter");
    await pg.waitForFunction(() => document.querySelector('[data-testid="profile-status"]').innerText.includes("已清除"));
    check("Enter on Clear clears and puts the focus back on the field", S.display === null && (await activeTid(pg)) === "profile-name");
    await pg.keyboard.type("0912345678");
    await pg.keyboard.press("Enter");
    check("an invalid value via the keyboard: error shown, focus stays on the field", (await errText(pg)).includes("電話") && (await activeTid(pg)) === "profile-name");
    await ctx.close();
  }

  // ── 3. editor and staff ──
  for (const role of ["editor", "staff"]) {
    console.log(`${role}: reaches the page`);
    const { ctx, pg } = await open("/profile", { role, display: "Existing" });
    await form(pg);
    check(`${role}: the page opens (no "no permission") with the stored name`, (await pg.inputValue(T("profile-name"))) === "Existing" && (await pg.locator(T("profile-page")).count()) === 1);
    check(`${role}: the profile link is in the account area`, (await pg.locator(`.sidebar__foot ${T("nav-profile")}`).count()) === 1);
    await type(pg, "Lee");
    await pg.locator(T("profile-save")).click();
    await pg.waitForFunction(() => document.querySelector('[data-testid="profile-status"]').innerText.includes("Lee"));
    check(`${role}: can save`, S.display === "Lee" && S.patches.length === 1);
    await ctx.close();
  }

  // ── 4. 390 ──
  console.log("owner: 390");
  {
    const { ctx, pg } = await open("/", { width: 390, height: 844 });
    check("the phone tab bar is unchanged (no profile tab)", (await pg.locator(`.tabbar ${T("nav-profile")}`).count()) === 0);
    await pg.locator(T("tab-more")).click();
    await pg.waitForSelector(`dialog[open] ${T("nav-profile")}`);
    check("the 'more' sheet has the profile link above the email and logout", await pg.evaluate(() => { const l = [...document.querySelectorAll('dialog[open] .sheet-list > *')].map((e) => e.getAttribute("data-testid") || e.className); const i = l.indexOf("nav-profile"); return i > 0 && l.indexOf("sheet-who") === i + 1 && l[l.length - 1] === "logout-sheet"; }));
    check("the sheet link is at least 44px", (await small(pg, `dialog[open] ${T("nav-profile")}`)).length === 0);
    await shot(pg, "owner-more-sheet-390");
    await pg.locator(`dialog[open] ${T("nav-profile")}`).click();
    await form(pg);
    check("the sheet closes and the page opens; 'more' is marked as the active tab", (await pg.evaluate(() => location.hash)) === "#/profile" && (await pg.locator("dialog[open]").count()) === 0 && (await pg.locator(`${T("tab-more")}.is-on`).count()) === 1);
    check("no horizontal overflow at 390", (await overflow(pg)) <= 0, String(await overflow(pg)));
    check("tap targets at least 44px on a phone", (await small(pg, ".profile .input, .profile .btn")).length === 0, JSON.stringify(await small(pg, ".profile .input, .profile .btn")));
    await shot(pg, "owner-profile-empty-390");
    await type(pg, "x@y.co");
    await pg.locator(T("profile-save")).click();
    check("the error fits the phone without overflow", (await overflow(pg)) <= 0 && (await errText(pg)).includes("email"));
    await shot(pg, "owner-profile-error-390");
    await type(pg, "王小明");
    await pg.locator(T("profile-save")).click();
    await pg.waitForFunction(() => document.querySelector('[data-testid="profile-status"]').innerText.includes("王小明"));
    await shot(pg, "owner-profile-saved-390");
    await ctx.close();
  }

  // ── 5. failures ──
  console.log("failures");
  {
    let o = await open("/profile", { patch: "422", expect: [{ path: "/api/v1/admin/me", status: 422 }] });
    await form(o.pg); await type(o.pg, "Sam"); await o.pg.locator(T("profile-save")).click();
    await o.pg.waitForFunction(() => document.querySelector('[data-testid="profile-error"]').innerText.length > 0);
    check("a 422 from the platform: the calm fixed message (not the platform's text), focus on the field, the name stays in the field", (await errText(o.pg)).includes("平台沒有接受這個名稱") && !(await errText(o.pg)).includes("display_name") && (await activeTid(o.pg)) === "profile-name" && (await o.pg.inputValue(T("profile-name"))) === "Sam" && S.patches.length === 1);
    await shot(o.pg, "owner-profile-422-1280");
    await o.ctx.close();
    o = await open("/profile", { patch: "500", expect: [{ path: "/api/v1/admin/me", status: 500 }] });
    await form(o.pg); await type(o.pg, "Sam"); await o.pg.locator(T("profile-save")).click();
    await o.pg.waitForFunction(() => document.querySelector('[data-testid="profile-error"]').innerText.length > 0);
    check("a 500: the 'not saved, try later' message, no raw text, the button works again", (await errText(o.pg)).includes("還沒有儲存") && !(await errText(o.pg)).includes("RAW") && await o.pg.locator(T("profile-save")).isEnabled());
    await o.ctx.close();
    o = await open("/profile", { patch: "drop" });
    await form(o.pg); await type(o.pg, "Sam"); await o.pg.locator(T("profile-save")).click();
    // On a real (same-origin) host the FIRST failed fetch is taken for an expired Access session and reloads the page once (lib/api.js, 30 s guard): that is the core's existing behaviour.
    await o.pg.waitForNavigation({ waitUntil: "load", timeout: 15000 }).catch(() => {});
    await form(o.pg); await type(o.pg, "Sam"); await o.pg.locator(T("profile-save")).click();
    await o.pg.waitForFunction(() => (document.querySelector('[data-testid="profile-error"]') || { innerText: "" }).innerText.length > 0, null, { timeout: 15000 });
    check("a dropped connection: the connection message, nothing claimed as saved", (await errText(o.pg)).includes("連線失敗") && (await o.pg.locator(T("profile-status")).innerText()) === "");
    await o.ctx.close();
    // the load fails (the first GET /admin/me is the sign-in's), then works after a retry
    o = await open("/profile", { meFailFrom: 2, expect: [{ path: "/api/v1/admin/me", status: 500 }] });
    await o.pg.waitForSelector(T("profile-load-error"), { timeout: 10000 });
    check("a failed load: an error state with a retry button, no form, no raw text", (await o.pg.locator(T("profile-form")).count()) === 0 && !(await o.pg.locator(T("profile-load-error")).innerText()).includes("RAW") && (await o.pg.locator(T("profile-retry")).count()) === 1);
    await shot(o.pg, "owner-profile-load-error-1280");
    S.meFailFrom = 0;
    await o.pg.locator(T("profile-retry")).click();
    await form(o.pg);
    check("retry loads the form", (await o.pg.locator(T("profile-name")).count()) === 1);
    await o.ctx.close();
  }

  // ── 6. preview hosts ──
  for (const kind of ["version", "change"]) {
    console.log(`preview host (${kind}): read only`);
    const { ctx, pg } = await open("/profile", { preview: kind, display: "Sam" });
    await form(pg);
    check(`${kind}: the field is read-only with the stored name, save and clear are disabled, the calm note is there`, (await pg.getAttribute(T("profile-name"), "readonly")) !== null && (await pg.getAttribute(T("profile-name"), "aria-readonly")) === "true" && (await pg.inputValue(T("profile-name"))) === "Sam"
      && await pg.locator(T("profile-save")).isDisabled() && await pg.locator(T("profile-clear")).isDisabled() && (await pg.locator(T("profile-readonly")).innerText()).includes("預覽"));
    await pg.locator(T("profile-name")).focus(); await pg.keyboard.type("zzz"); await pg.keyboard.press("Enter");
    await sleep(300);
    check(`${kind}: typing and Enter change nothing and send nothing`, (await pg.inputValue(T("profile-name"))) === "Sam" && S.patches.length === 0 && S.writes === 0);
    if (kind === "version") await shot(pg, "preview-profile-1280");
    await ctx.close();
  }

  // ── 7. the hint on the design history ──
  console.log("the one-time hint");
  {
    let o = await open("/design", { display: null });
    await o.pg.waitForSelector(T("dh-area"));
    check("owner without a name: the hint is above the history with the owner's wording and a link", (await o.pg.locator(T("profile-hint")).count()) === 1 && (await o.pg.locator(T("profile-hint")).innerText()).includes("設定你的名稱，隊友才看得到是誰提出或核准了改版。") && (await o.pg.getAttribute(T("profile-hint-go"), "href")) === "#/profile"
      && await o.pg.evaluate(() => { const m = document.querySelector("main"); return m.firstElementChild.getAttribute("data-testid") === "profile-hint"; }));
    check("the hint is a labelled region and its two controls are at least 44px", (await o.pg.getAttribute(T("profile-hint"), "aria-label")) === "個人資料提示" && (await small(o.pg, `${T("profile-hint")} .btn`)).length === 0);
    await shot(o.pg, "hint-history-1280");
    await o.pg.locator(T("profile-hint-dismiss")).click();
    check("dismiss removes it and moves the focus to the page title", (await o.pg.locator(T("profile-hint")).count()) === 0 && (await o.pg.evaluate(() => __active() && __active().tagName)) === "H1");
    await o.pg.goto(URL0 + "#/design/" + RID); await o.pg.waitForSelector(T("dh-detail"));
    check("it stays gone on the request screen", (await o.pg.locator(T("profile-hint")).count()) === 0);
    await o.pg.reload(); await o.pg.waitForSelector(T("dh-detail"));
    check("...and after a reload in the same browser session (a bare marker in sessionStorage)", (await o.pg.locator(T("profile-hint")).count()) === 0 && await o.pg.evaluate(() => { const v = []; for (let i = 0; i < sessionStorage.length; i++) v.push(sessionStorage.getItem(sessionStorage.key(i))); return !v.some((x) => /Sam|@|example/.test(x)); }));
    await o.ctx.close();

    o = await open("/design/" + RID, { display: null, width: 390, height: 844 });
    await o.pg.waitForSelector(T("dh-detail"));
    check("the hint also shows above the request screen, at 390 without overflow", (await o.pg.locator(T("profile-hint")).count()) === 1 && (await overflow(o.pg)) <= 0);
    await shot(o.pg, "hint-request-390");
    await o.pg.locator(T("profile-hint-go")).click();
    await form(o.pg);
    await type(o.pg, "Sam"); await o.pg.locator(T("profile-save")).click();
    await o.pg.waitForFunction(() => document.querySelector('[data-testid="profile-status"]').innerText.includes("Sam"));
    await o.pg.goto(URL0 + "#/design"); await o.pg.waitForSelector(T("dh-area"));
    check("the link leads to the page; after saving a name the hint is gone (without being dismissed)", (await o.pg.locator(T("profile-hint")).count()) === 0);
    await o.ctx.close();

    o = await open("/design", { display: "Has Name" }); await o.pg.waitForSelector(T("dh-area"));
    check("a person who already has a name never sees it", (await o.pg.locator(T("profile-hint")).count()) === 0); await o.ctx.close();
    o = await open("/design", { display: undefined }); await o.pg.waitForSelector(T("dh-area"));
    check("a platform that does not send display_name: no hint (unknown is not 'no name')", (await o.pg.locator(T("profile-hint")).count()) === 0); await o.ctx.close();
    o = await open("/design", { role: "editor", display: null }); await o.pg.waitForSelector(T("dh-area"));
    check("an editor (design.view) without a name sees it", (await o.pg.locator(T("profile-hint")).count()) === 1); await o.ctx.close();
    o = await open("/design", { role: "staff", display: null }); await o.pg.waitForSelector(".view");
    check("staff (no design.view): the history is the no-permission screen and there is no hint", (await o.pg.locator(T("profile-hint")).count()) === 0 && (await o.pg.locator(T("dh-area")).count()) === 0); await o.ctx.close();
    o = await open("/design", { preview: "version", display: null }); await o.pg.waitForSelector(T("dh-area"));
    check("a preview host never shows it (nothing can be saved there)", (await o.pg.locator(T("profile-hint")).count()) === 0); await o.ctx.close();
    o = await open("/orders", { display: null }); await o.pg.waitForSelector(".view");
    check("it shows on the design history screens only (not on other pages)", (await o.pg.locator(T("profile-hint")).count()) === 0); await o.ctx.close();
  }

  // ── 8. the design layer cannot take the page over ──
  console.log("design layer");
  {
    const { ctx, pg } = await open("/profile");
    await form(pg);
    check("no module for a profile view was requested from design/ or design-defaults/", !requested.some((r) => /^\/design(-defaults)?\/views\/.*profile/.test(r)));
    check("the page is marked as core-owned and sits outside the design query helpers", await pg.evaluate(() => !!document.querySelector('[data-core="profile"]')));
    await ctx.close();
  }

  check("no console error, page error or CSP violation anywhere", problems.length === 0, JSON.stringify(problems.slice(0, 5)));
  check("no personal data in the console (names, addresses, numbers typed in the tests)", !consoleText.some((x) => /Sam|Kim|Pat|Lee|example\.com|0912|4242/.test(x)), JSON.stringify(consoleText.filter((x) => /Sam|Kim|Pat|Lee|example\.com|0912|4242/.test(x)).slice(0, 3)));
} catch (e) {
  failures++; console.error("  FAIL test crashed:", e && e.stack || e);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
