// Real-browser test of the core-drawn DESIGN REVIEW dialog (T1-T4 PR2, docs/DECISIONS.md D14), headless Chromium via Playwright.
// NO platform needed: one tiny server serves the admin files AND a fake platform API (admin/me, design requests, screenshots with
// signed URLs, approve / reject / request-changes with If-Match and head_sha checks). A tiny test view (served instead of design/ for the
// home route) has buttons that call ctx.actions.openDesignReview / requestDesignRevert / cancelDesignRequest like a design layer would.
// Covered: owner approve (checkbox required, button disabled until ticked, synthetic input never approves, exact sha + ETag sent),
// disabled at once after the press, reject, request changes, head_moved (reload, look again, never auto-retried), expired screenshot
// URL (one retry, then "expired, retry"), no signed URL in DOM / console / storage, 390 and 1280 screenshots, editor and staff see no
// buttons, preview hosts show none, keyboard-only operation.
// Needs Playwright via $PLAYWRIGHT_DIR (a folder with node_modules/playwright) and SKIPS cleanly (exit 0) when it is not found.
// Screenshots go to $REVIEW_SHOTS (default admin/e2e/out/review-ui).   Run: node admin/e2e/design-review.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { deflateSync } from "node:zlib";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ADMIN = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SHOTS = process.env.REVIEW_SHOTS || resolve(ADMIN, "e2e/out/review-ui");
const HOST = "admin.example.test";
function loadPlaywright() {
  for (const d of [process.env.PLAYWRIGHT_DIR].filter(Boolean)) {
    try { return createRequire(join(d, "package.json"))("playwright"); } catch { /* try the next */ }
  }
  return null;
}
const pw = loadPlaywright();
if (!pw) { console.log("SKIP design-review browser test: Playwright not found (set PLAYWRIGHT_DIR)"); process.exit(0); }
let browser;
try { browser = await pw.chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] }); } catch (e) {
  console.log(`SKIP design-review browser test: Chromium could not start (${String(e.message).split("\n")[0]})`); process.exit(0);
}
mkdirSync(SHOTS, { recursive: true });

// ── PNG fixtures (valid PNGs built here, no dependencies) ──
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); }
function png(w, h, px) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { const o = y * (w * 3 + 1); raw[o] = 0; for (let x = 0; x < w; x++) { const [r, g, b] = px(x, y); raw[o + 1 + x * 3] = r; raw[o + 2 + x * 3] = g; raw[o + 3 + x * 3] = b; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const page = (after, h) => (x, y) => (y < 90 ? (after ? [230, 120, 165] : [70, 70, 80]) : Math.floor(y / 250) % 2 ? [236, 236, 232] : [250, 250, 248]);
// the shot table: [view, viewport, height]; 'home' at 390 is TALL (6000px) on purpose
const SHOT_DEFS = [["home", 390, 6000], ["home", 1280, 1400], ["orders", 390, 1200], ["orders", 1280, 1000]];
const PNGS = new Map(); // "<n>" -> Buffer
const shotId = (n) => `99999999-9999-4999-8999-${String(n).padStart(12, "0")}`;
let n = 0;
const SHOT_ROWS = [];
for (const [view, vp, h] of SHOT_DEFS) for (const phase of ["before", "after"]) { n++; PNGS.set(String(n), png(vp, h, page(phase === "after", h))); SHOT_ROWS.push({ n, view, vp, h, phase }); }

// ── fake platform ──
const RID = "11111111-2222-4333-8444-555555555555", TARGET = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", RID2 = "22222222-3333-4444-8555-666666666666";
const SHA1 = "a1".repeat(20), SHA2 = "b2".repeat(20);
const PERMS = { owner: ["design.view", "design.request", "design.approve", "design.revert"], editor: ["design.view"], staff: ["order.view"] };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const ALLOW = /^\/(index\.html|app\.js|config\.js|config-loader\.js|styles\.css|(lib|ui|core|vendor)\/[^/]+|(design|design-defaults)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+\.(js|css|svg|png))$/;
let PORT = 0;
let S; // per-scenario state
const resetState = (o = {}) => {
  S = { role: "owner", preview: "", rev: 5, head: SHA1, status: "awaiting_approval", approveCalls: [], rejectCalls: [], changeCalls: [], revertCalls: [], cancelCalls: [], listCalls: 0, imageCalls: [], approveDelay: 0,
    headMovedOnce: false, expireSig: new Set(), expireAll: false, sigSeq: 0, prompt: "make the banner pink <b>bold</b> \u202Edrow", kind: "change", purgeSecond: false, noShots: false, referers: [], detailCalls: 0, ...o };
};
resetState();
const requestJson = () => ({
  id: RID, site: "admin", kind: S.kind, status: S.status, base_sha: SHA1, head_sha: S.head, candidate_sha: S.status === "awaiting_approval" ? S.head : null, core_version: "0.4.2", design_floor_version: "0.3.0",
  preview_registered_at: "2026-11-27T10:00:00Z", preview_expires_at: "2026-11-27T12:00:00Z", approval_expires_at: S.status === "approved" ? "2026-11-27T13:00:00Z" : null,
  rev: S.rev, created_at: "2026-11-27T09:00:00Z", updated_at: "2026-11-27T10:00:00Z", prompt_excerpt: "make the banner pink", prompt_text: S.prompt, proposed_by_name: "Team\u202E member",
  approved_by_name: null, revert_target_tag: S.kind === "revert" ? "design-2026-10-01" : null, published_tag: null,
  diff_summary: { files_changed: 7, additions: 120, deletions: 30, files: ["admin/design/theme.css", "admin/design/tokens.css", "admin/design/copy.js", "admin/design/views/home.js", "a\u202E/b.js", "x/y.css", "x/z.css"].map((p) => ({ path: p, status: "modified", additions: 17, deletions: 4 })) },
  guard: { passed: true, checked_sha: S.head, rule_ids: [], violation_count: 0, guard_version: "0.4.2", checked_at: "2026-11-27T10:00:00Z" },
  preview_origin: "https://p-1.preview.example", preview_read_only: true, future: "x",
});
function shotList() {
  const rows = SHOT_ROWS.map(({ n: k, view, vp, h, phase }) => {
    const sig = ++S.sigSeq;
    return { id: shotId(k), request_id: RID, phase, site: "admin", role: "owner", viewport: vp, view_key: view, attempt: 1, commit_sha: SHA1, content_type: "image/png", byte_size: 1000, width: vp, height: h, sha256: "x",
      diff_ppm: phase === "after" ? 123400 : null, capture_manifest: null, purged_at: S.purgeSecond && k === 4 ? "2026-11-26T00:00:00Z" : null, created_at: "2026-11-27T10:00:00Z",
      url: S.purgeSecond && k === 4 ? null : `http://127.0.0.1:${PORT}/_shots/${k}.png?sig=${sig}&X-Amz-Signature=deadbeef`, url_expires_at: new Date(Date.now() + 300000).toISOString(), object_key: "secret/key" };
  });
  return { screenshots: S.noShots ? [] : rows };
}
const json = (res, status, body, headers = {}) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const view = () => `export default function (root, ctx) {
  const { h, button } = ctx.ui;
  const out = h("pre", { "data-testid": "out" });
  const run = (name, fn) => button(name, { "data-testid": "go-" + name, onClick: async () => { out.textContent = "..."; try { out.textContent = JSON.stringify(await fn()); } catch (e) { out.textContent = "ERR " + (e.reason || "") + " " + ctx.errorMessage(e); } } });
  root.append(h("div", { class: "view" }, h("h1", {}, "host"), h("div", { style: { display: "flex", gap: "8px" } },
    run("review", () => ctx.actions.openDesignReview("${RID}", { head_sha: "${"f".repeat(40)}" })),
    run("revert", () => ctx.actions.requestDesignRevert("${TARGET}", { reason: "go back" })),
    run("cancel", () => ctx.actions.cancelDesignRequest("${RID2}"))), out));
}
`;
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  if (p.startsWith("/_shots/")) {
    S.imageCalls.push({ url: req.url, referer: req.headers.referer || "", cookie: req.headers.cookie || "", auth: req.headers.authorization || "" });
    const sig = new URL(req.url, "http://x").searchParams.get("sig");
    const cors = { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
    if (S.expireAll || S.expireSig.has(sig)) { res.writeHead(403, { ...cors, "Content-Type": "application/xml" }); res.end("<Error>expired</Error>"); return; }
    res.writeHead(200, { ...cors, "Content-Type": "image/png" }); res.end(PNGS.get(p.split("/").pop().replace(".png", ""))); return;
  }
  if (p.startsWith("/api/v1/")) {
    const a = p.slice("/api/v1".length), m = req.method;
    if (m === "POST" && a === "/admin/auth/refresh") return json(res, 200, { access_token: "tok-" + Math.random().toString(36).slice(2) });
    if (a === "/admin/me") return json(res, 200, { id: S.role === "owner" ? 1 : S.role === "editor" ? 2 : 3, email: `${S.role}@example.com`, sids: [1], platform_permissions: [] });
    if (a === "/admin/shops/1/me") return json(res, 200, { permissions: PERMS[S.role] });
    if (a === "/admin/shops/1/branding") return json(res, 200, { name: "Test Shop", branding: {} });
    const mm = /^\/admin\/shops\/1\/design\/requests\/([0-9a-f-]+)(\/[a-z-]+)?$/.exec(a);
    if (mm) {
      const id = mm[1], sub = mm[2] || "";
      if (m === "GET" && !sub) { S.detailCalls++; return json(res, 200, id === RID ? requestJson() : id === RID2 ? { ...requestJson(), id, status: "previewing" } : { ...requestJson(), id, status: "published", published_tag: "design-2026-10-01" }, { ETag: `"${S.rev}"` }); }
      if (m === "GET" && sub === "/screenshots") { S.listCalls++; return json(res, 200, shotList()); }
      if (m === "GET" && sub === "/events") return json(res, 200, { events: [] });
      const body = await readBody(req);
      if (m === "POST" && sub === "/approve") {
        S.approveCalls.push({ ifMatch: req.headers["if-match"], body });
        if (S.approveDelay) await new Promise((r) => setTimeout(r, S.approveDelay));
        if (S.headMovedOnce) { S.headMovedOnce = false; S.head = SHA2; S.rev++; return json(res, 409, { error: { code: "head_moved", message: "RAW head moved" } }); }
        if (req.headers["if-match"] !== `"${S.rev}"`) return json(res, 412, { error: { code: "precondition_failed", message: "RAW" } });
        if (body.head_sha !== S.head) return json(res, 409, { error: { code: "head_moved", message: "RAW" } });
        S.status = "approved"; S.rev++;
        return json(res, 200, requestJson());
      }
      if (m === "POST" && sub === "/reject") { S.rejectCalls.push(body); S.status = "rejected"; S.rev++; return json(res, 200, requestJson()); }
      if (m === "POST" && sub === "/request-changes") { S.changeCalls.push(body); S.status = "drafting"; S.rev++; return json(res, 200, requestJson()); }
      if (m === "POST" && sub === "/revert") { S.revertCalls.push({ id, body }); return json(res, 201, { ...requestJson(), kind: "revert", status: "drafting" }); }
      if (m === "POST" && sub === "/cancel") { S.cancelCalls.push(id); return json(res, 200, { ...requestJson(), id, status: "cancelled" }); }
    }
    return json(res, 404, { error: { code: "not_found", message: "no" } });
  }
  if (p === "/site-config.js") { res.writeHead(200, { "Content-Type": TYPES[".js"] }); res.end('window.ADMIN_CONFIG.siteOrigin = "https://www.example.com";'); return; }
  if (p === "/preview-config.js") {
    res.writeHead(200, { "Content-Type": TYPES[".js"] });
    res.end(`window.ADMIN_CONFIG.preview = ${S.preview ? `{"kind":"${S.preview}","tag":"design-2026-10-01","expiresAt":"2999-01-01T00:00:00Z"}` : "null"};\nwindow.ADMIN_CONFIG.previewConfig = true;\n`); return;
  }
  if (p === "/design/routes.js") { res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" }); res.end('export default { home: "views/review-host.js" };'); return; }
  if (p === "/design/views/review-host.js") { res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" }); res.end(view()); return; }
  const path = p === "/" ? "/index.html" : p;
  if (!ALLOW.test(path) || path.includes("..")) { res.writeHead(404); res.end("no"); return; }
  try { const b = await readFile(join(ADMIN, path)); res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" }); res.end(b); } catch { res.writeHead(404); res.end("no"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
PORT = server.address().port;
const URL0 = `http://${HOST}:${PORT}/`;

let failures = 0;
const check = (name, cond, extra = "") => { if (cond) console.log(`  ok  ${name}`); else { failures++; console.error(`  FAIL ${name} ${extra}`); } return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (id) => `[data-testid="${id}"]`;
const consoleLines = [];

async function open({ width = 1280, height = 900, ...state } = {}) {
  resetState(state);
  const ctx = await browser.newContext({ viewport: { width, height } });
  const pg = await ctx.newPage();
  const errors = [];
  pg.on("pageerror", (e) => errors.push(String(e.message)));
  pg.on("console", (m) => consoleLines.push(m.text()));
  await pg.goto(URL0, { waitUntil: "load" });
  await pg.waitForSelector(T("go-review"), { timeout: 15000 });
  return { ctx, pg, errors };
}
const clickReview = async (pg) => { await pg.click(T("go-review")); await pg.waitForSelector("dialog[open] .dlg-rv"); await sleep(450); }; // the bottom sheet animates in for 200 ms
const images = (pg) => pg.evaluate(() => [...document.querySelectorAll("dialog .dlg-rv__pic")].map((i) => ({ w: i.naturalWidth, h: i.naturalHeight, blob: i.src.startsWith("blob:") })));
const waitImages = (pg, n) => pg.waitForFunction((k) => [...document.querySelectorAll("dialog .dlg-rv__pic")].filter((i) => i.naturalWidth > 0).length >= k, n, { timeout: 15000 });
const outText = async (pg) => { await pg.waitForFunction(() => { const t = document.querySelector('[data-testid="out"]').textContent; return t && t !== "..."; }, null, { timeout: 8000 }).catch(() => {}); return pg.locator(T("out")).textContent(); };
const noPost = () => S.approveCalls.length === 0 && S.rejectCalls.length === 0 && S.changeCalls.length === 0;

try {
  // ── 1. owner approve, 1280 ──
  console.log("owner approves at 1280");
  {
    const { ctx, pg, errors } = await open({ width: 1280, height: 900 });
    await clickReview(pg);
    await waitImages(pg, 2);
    const txt = await pg.locator("dialog[open]").innerText();
    check("title and the version / file count are shown", /核准這個設計/.test(txt) && /版本 a1a1a1a（7 個檔案）/.test(txt), txt.slice(0, 300));
    check("the fixed warning is shown (core text)", (await pg.locator(T("confirm-warning")).textContent()).includes("核准後，這次的設計改動會在數分鐘內對所有Test Shop使用者上線"));
    check("the warning names the version and the file count", (await pg.locator(T("confirm-warning")).textContent()).includes("（a1a1a1a、7 個檔案）"));
    check("the note that screenshots are captured by the service and are not proof", (await pg.locator(T("confirm-rv-shots-note")).textContent()).includes("截圖由服務擷取，不是證明"));
    check("the guard result and the diff percentage are shown", /守門員：通過/.test(txt) && (await pg.locator(T("confirm-rv-diff")).textContent()).includes("12.34%"));
    check("the preview link is a safe https origin opened without opener", await pg.evaluate(() => { const a = document.querySelector('[data-testid="confirm-rv-preview"]'); return a && a.href === "https://p-1.preview.example/" && a.rel.includes("noopener") && a.target === "_blank"; }));
    check("the prompt is plain text (no element was created from its HTML) and bidi marks are gone", await pg.evaluate(() => { const p = document.querySelector('[data-testid="confirm-rv-prompt"]'); return p.querySelector("b") === null && p.textContent.includes("<b>bold</b>") && !p.textContent.includes("\u202E"); }));
    check("file paths and names lose bidi controls", !/\u202E/.test(txt));
    const imgs = await images(pg);
    check("images are blob: object URLs that decoded (no signed URL in the DOM)", imgs.length >= 2 && imgs.every((i) => i.blob && i.w > 0), JSON.stringify(imgs));
    { const m = (await pg.content()).match(/.{30}(X-Amz|[/]_shots[/]|deadbeef).{30}/); check("no signed URL anywhere in the document", !m, m && m[0]); }
    const ack = pg.locator(T("confirm-rv-ack")), yes = pg.locator(`dialog ${T("confirm-yes")}`);
    check("the approve button is disabled until the checkbox is ticked", await yes.isDisabled() && !(await ack.isChecked()));
    // synthetic input
    await pg.evaluate(() => { const c = document.querySelector('[data-testid="confirm-rv-ack"]'); c.click(); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); });
    check("a scripted tick is undone and does not enable approve", !(await ack.isChecked()) && (await yes.isDisabled()));
    await pg.evaluate(() => { const b = document.querySelector('dialog [data-testid="confirm-yes"]'); b.disabled = false; b.click(); b.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await sleep(500);
    check("synthetic clicks on approve send nothing", S.approveCalls.length === 0 && (await pg.locator("dialog[open]").count()) === 1);
    await pg.screenshot({ path: join(SHOTS, "desktop-1280-before-ack.png") });
    await ack.click();
    check("a real tick enables the approve button", await ack.isChecked() && !(await yes.isDisabled()));
    await pg.evaluate(() => { document.querySelector("dialog .dlg-rv__main").scrollTop = 0; });
    await pg.screenshot({ path: join(SHOTS, "desktop-1280-ack-ticked.png") });
    await yes.click();
    await pg.waitForFunction(() => !document.querySelector("dialog[open]"), null, { timeout: 8000 });
    check("exactly one approve POST", S.approveCalls.length === 1);
    check("it carries the sha and ETag the REVIEW read (not the design layer's)", S.approveCalls[0].body.head_sha === SHA1 && Object.keys(S.approveCalls[0].body).join() === "head_sha" && S.approveCalls[0].ifMatch === '"5"', JSON.stringify(S.approveCalls[0]));
    const o = await outText(pg);
    check("the design layer gets {outcome:'approved', request} with no URL or ETag", /"outcome":"approved"/.test(o) && !/X-Amz|_shots|ETag|etag|object_key/.test(o), o.slice(0, 200));
    check("a status text (toast) says it is going live with the expiry", /已核准，正在上線（核准有效至/.test(await pg.locator("#toasts").innerText()));
    check("image requests: no referrer, no cookie, no auth header", S.imageCalls.length > 0 && S.imageCalls.every((c) => !c.referer && !c.cookie && !c.auth), JSON.stringify(S.imageCalls[0]));
    check("no page error", errors.length === 0, errors.join("|"));
    check("nothing in sessionStorage / localStorage mentions a screenshot URL", await pg.evaluate(() => !JSON.stringify([{ ...sessionStorage }, { ...localStorage }]).match(/_shots|X-Amz|sig=/)));
    await ctx.close();
  }

  // ── 2. the button disables the instant it is pressed (slow server) ──
  console.log("double press");
  {
    const { ctx, pg } = await open({ approveDelay: 900 });
    await clickReview(pg); await waitImages(pg, 2);
    await pg.locator(T("confirm-rv-ack")).click();
    const yes = pg.locator(`dialog ${T("confirm-yes")}`);
    await yes.click();
    check("the approve button is disabled right after the press", await yes.isDisabled());
    await yes.click({ force: true, timeout: 500 }).catch(() => {});
    await pg.keyboard.press("Escape");
    await pg.waitForFunction(() => !document.querySelector("dialog[open]"), null, { timeout: 8000 });
    check("a second press and Escape while waiting sent / cancelled nothing: one POST", S.approveCalls.length === 1);
    await ctx.close();
  }

  // ── 3. reject ──
  console.log("reject");
  {
    const { ctx, pg } = await open();
    await clickReview(pg); await waitImages(pg, 2);
    await pg.locator(T("confirm-rv-reject")).click();
    check("reject shows its own fixed warning", (await pg.locator(T("confirm-warning")).textContent()).includes("拒絕後這次改版就結束"));
    await pg.fill(T("confirm-rv-reason"), "not pink enough\u202E");
    await pg.locator(`dialog ${T("confirm-yes")}`).click();
    await pg.waitForFunction(() => !document.querySelector("dialog[open]"));
    check("one reject POST with the reason (bidi removed by the core)", S.rejectCalls.length === 1 && S.rejectCalls[0].reason === "not pink enough", JSON.stringify(S.rejectCalls));
    check("outcome rejected", /"outcome":"rejected"/.test(await outText(pg)));
    await ctx.close();
  }

  // ── 4. request changes (a plain confirm with a note) ──
  console.log("request changes");
  {
    const { ctx, pg } = await open();
    await clickReview(pg); await waitImages(pg, 2);
    await pg.locator(T("confirm-rv-changes")).click();
    check("request changes has NO fixed warning (a plain confirm)", (await pg.locator(T("confirm-warning")).count()) === 0);
    await pg.locator(`dialog ${T("confirm-yes")}`).click();
    check("an empty note is refused with a message and nothing is sent", (await pg.locator(T("confirm-rv-alert")).isVisible()) && S.changeCalls.length === 0);
    await pg.fill(T("confirm-rv-note"), "make the banner blue");
    check("the note field is limited to 500", (await pg.locator(T("confirm-rv-note")).getAttribute("maxlength")) === "500");
    await pg.locator(`dialog ${T("confirm-yes")}`).click();
    await pg.waitForFunction(() => !document.querySelector("dialog[open]"));
    check("one request-changes POST with the note", S.changeCalls.length === 1 && S.changeCalls[0].note === "make the banner blue");
    check("outcome changesRequested", /"outcome":"changesRequested"/.test(await outText(pg)));
    await ctx.close();
  }

  // ── 5. head_moved: reload, look again, never auto-retried ──
  console.log("head_moved");
  {
    const { ctx, pg } = await open({ headMovedOnce: true });
    await clickReview(pg); await waitImages(pg, 2);
    await pg.locator(T("confirm-rv-ack")).click();
    await pg.locator(`dialog ${T("confirm-yes")}`).click();
    await pg.waitForSelector(T("confirm-rv-reload"));
    await sleep(700);
    check("the stated message is shown", (await pg.locator(T("confirm-rv-alert")).innerText()).includes("這個設計在你審閱後被更新了，請重新載入並再看一次"));
    check("nothing was retried or re-sent automatically", S.approveCalls.length === 1);
    check("there is no approve button until the person reloads", (await pg.locator(`dialog ${T("confirm-yes")}`).count()) === 0 && (await pg.locator(T("confirm-rv-ack")).count()) === 0);
    await pg.screenshot({ path: join(SHOTS, "desktop-1280-head-moved.png") });
    await pg.locator(T("confirm-rv-reload")).click();
    await pg.waitForSelector(T("confirm-rv-ack"));
    check("after the reload the new version is shown and the checkbox is UNTICKED and approve disabled", /版本 b2b2b2b/.test(await pg.locator(T("confirm-rv-version")).innerText()) && !(await pg.locator(T("confirm-rv-ack")).isChecked()) && (await pg.locator(`dialog ${T("confirm-yes")}`).isDisabled()));
    check("the reload itself sent no approve", S.approveCalls.length === 1);
    await pg.locator(T("confirm-rv-ack")).click();
    await pg.locator(`dialog ${T("confirm-yes")}`).click();
    await pg.waitForFunction(() => !document.querySelector("dialog[open]"));
    check("the deliberate second approve carries the NEW sha and ETag", S.approveCalls.length === 2 && S.approveCalls[1].body.head_sha === SHA2 && S.approveCalls[1].ifMatch === `"6"`, JSON.stringify(S.approveCalls[1]));
    await ctx.close();
  }

  // ── 6. expired screenshot URL ──
  console.log("expired screenshot URLs");
  {
    const { ctx, pg } = await open({ expireSig: new Set(["1", "2", "3", "4", "5", "6", "7", "8"]) });
    await clickReview(pg); await waitImages(pg, 2);
    check("a 403 on the first URL: refreshed ONCE and then shown", S.listCalls === 2, `list calls ${S.listCalls}`);
    await ctx.close();
  }
  {
    const { ctx, pg } = await open({ expireAll: true });
    await clickReview(pg);
    await pg.waitForSelector(T("confirm-rv-imgerr"));
    check("a persistent 403 shows 'image expired, retry'", (await pg.locator(T("confirm-rv-imgerr")).first().innerText()).includes("圖片已過期，按重試"));
    const before = S.listCalls;
    S.expireAll = false;
    await pg.locator(T("confirm-rv-retry")).first().click();
    await waitImages(pg, 1);
    check("the retry button works once the URL is valid", (await images(pg)).length >= 1 && before >= 1);
    await ctx.close();
  }
  {
    const { ctx, pg } = await open({ purgeSecond: true });
    await clickReview(pg);
    await pg.waitForSelector(T("confirm-rv-purged"));
    check("a purged screenshot shows the retention message", (await pg.locator(T("confirm-rv-purged")).first().innerText()).includes("此截圖已依保存期限清除"));
    await ctx.close();
  }
  {
    const { ctx, pg } = await open({ noShots: true });
    await clickReview(pg);
    await pg.waitForSelector(T("confirm-rv-shots"));
    await pg.waitForFunction(() => /還沒有可看的截圖/.test(document.querySelector('[data-testid="confirm-rv-shots"]').textContent));
    check("no screenshots: an explicit empty state, approve still needs the checkbox", (await pg.locator(`dialog ${T("confirm-yes")}`).isDisabled()));
    await ctx.close();
  }

  // ── 7. 1280 modes ──
  console.log("modes at 1280");
  {
    const { ctx, pg } = await open({ width: 1280, height: 900 });
    await clickReview(pg); await waitImages(pg, 2);
    check("side by side by default on a wide screen (two images)", (await images(pg)).length === 2);
    await pg.locator(T("confirm-rv-vp-390")).click(); await waitImages(pg, 2);
    await pg.screenshot({ path: join(SHOTS, "desktop-1280-side-390.png") });
    await pg.locator(T("confirm-rv-mode-slider")).click(); await waitImages(pg, 2);
    const range = pg.locator(T("confirm-rv-slider"));
    await range.focus();
    const v0 = await range.inputValue();
    await pg.keyboard.press("ArrowRight"); await pg.keyboard.press("ArrowRight");
    check("the slider is keyboard operable", (await range.inputValue()) !== v0, v0);
    await pg.screenshot({ path: join(SHOTS, "desktop-1280-slider.png") });
    await pg.selectOption(T("confirm-rv-view"), { label: "orders · 店主帳號" }); await waitImages(pg, 2);
    check("the view can be switched", /orders/.test(await pg.locator(T("confirm-rv-view")).evaluate((s) => s.selectedOptions[0].textContent)));
    await ctx.close();
  }

  // ── 8. 390 phone ──
  console.log("phone 390");
  {
    const { ctx, pg } = await open({ width: 390, height: 844 });
    await clickReview(pg); await waitImages(pg, 1);
    check("a single image by default with a before/after toggle", (await images(pg)).length === 1 && (await pg.locator(T("confirm-rv-phase-before")).count()) === 1);
    const geo = await pg.evaluate(() => {
      const d = document.querySelector("dialog[open]"), r = (e) => e.getBoundingClientRect();
      const stage = document.querySelector(".dlg-rv__stage"), main = document.querySelector(".dlg-rv__main"), warn = document.querySelector('[data-testid="confirm-warning"]'), yes = document.querySelector('dialog [data-testid="confirm-yes"]');
      return { dlgW: r(d).width, dlgScrollW: d.scrollWidth, docScrollW: document.documentElement.scrollWidth, vw: innerWidth, vh: innerHeight, stageH: r(stage).height, imgH: stage.scrollHeight, mainScrolls: main.scrollHeight > main.clientHeight,
        warnBottom: r(warn).bottom, warnTop: r(warn).top, yesTop: r(yes).top, yesBottom: r(yes).bottom, dlgBottom: r(d).bottom };
    });
    check("no horizontal overflow at 390", geo.dlgScrollW <= geo.dlgW + 1 && geo.docScrollW <= geo.vw + 1, JSON.stringify(geo));
    check("a 6000px screenshot sits in a bounded, scrollable container", geo.imgH > geo.stageH && geo.stageH <= geo.vh * 0.6, JSON.stringify(geo));
    check("the dialog body scrolls", geo.mainScrolls, JSON.stringify(geo));
    check("the warning is fully visible and the approve button sits BELOW it, inside the screen", geo.warnTop >= 0 && geo.warnBottom <= geo.yesTop && geo.yesBottom <= geo.vh, JSON.stringify(geo));
    await pg.screenshot({ path: join(SHOTS, "phone-390-review.png") });
    await pg.locator(T("confirm-rv-phase-before")).click(); await waitImages(pg, 1);
    await pg.locator(T("confirm-rv-mode-slider")).click(); await waitImages(pg, 2);
    await pg.screenshot({ path: join(SHOTS, "phone-390-slider.png") });
    await pg.locator(T("confirm-rv-mode-single")).click();
    await pg.locator(T("confirm-rv-ack")).click();
    await pg.evaluate(() => { document.querySelector(".dlg-rv__main").scrollTop = 400; });
    await pg.screenshot({ path: join(SHOTS, "phone-390-ack-ticked-scrolled.png") });
    const after = await pg.evaluate(() => { const w = document.querySelector('[data-testid="confirm-warning"]').getBoundingClientRect(), y = document.querySelector('dialog [data-testid="confirm-yes"]').getBoundingClientRect(); return { wb: w.bottom, yt: y.top, vh: innerHeight, yb: y.bottom }; });
    check("scrolling the content never moves the warning under the button", after.wb <= after.yt && after.yb <= after.vh, JSON.stringify(after));
    await ctx.close();
  }

  // ── 9. editor and staff ──
  console.log("editor and staff");
  {
    const { ctx, pg } = await open({ role: "editor" });
    await clickReview(pg); await waitImages(pg, 1);
    check("editor: the review shows the data but no approve, reject or request-changes button", (await pg.locator(`dialog ${T("confirm-yes")}`).count()) === 0 && (await pg.locator(T("confirm-rv-reject")).count()) === 0 && (await pg.locator(T("confirm-rv-changes")).count()) === 0 && (await pg.locator(T("confirm-rv-ack")).count()) === 0);
    check("editor: says why (no permission)", (await pg.locator(T("confirm-rv-cannot")).innerText()).includes("沒有核准的權限"));
    await pg.screenshot({ path: join(SHOTS, "desktop-1280-editor.png") });
    await pg.locator(T("confirm-rv-close")).click();
    await pg.waitForFunction(() => !document.querySelector("dialog[open]"));
    check("editor: outcome closed, nothing sent", /"outcome":"closed"/.test(await outText(pg)) && noPost());
    await pg.click(T("go-revert")); await sleep(500);
    check("editor: revert is refused (design.revert) before any dialog or request", /ERR permission/.test(await outText(pg)) && S.revertCalls.length === 0 && (await pg.locator("dialog[open]").count()) === 0);
    await ctx.close();
  }
  {
    const { ctx, pg } = await open({ role: "staff" });
    await pg.click(T("go-review")); await sleep(600);
    check("staff: openDesignReview is refused, no dialog, no request for the design", /ERR permission/.test(await outText(pg)) && (await pg.locator("dialog[open]").count()) === 0 && S.detailCalls === 0 && S.listCalls === 0);
    await ctx.close();
  }

  // ── 10. revert and cancel with their fixed warnings ──
  console.log("revert and cancel");
  {
    const { ctx, pg } = await open();
    await pg.click(T("go-revert"));
    await pg.waitForSelector(`dialog[open] ${T("confirm-yes")}`);
    check("revert: the fixed warning says it only creates a request", (await pg.locator(T("confirm-warning")).textContent()).includes("這只會建立一個新的還原請求"));
    check("revert: the title names the old version read by the core", (await pg.locator(".dlg__title").innerText()).includes("design-2026-10-01"));
    await pg.locator(`dialog ${T("confirm-yes")}`).click();
    await pg.waitForFunction(() => /"request"/.test(document.querySelector('[data-testid="out"]').textContent));
    check("revert: one POST with the reason; returns the new request", S.revertCalls.length === 1 && S.revertCalls[0].body.reason === "go back" && S.revertCalls[0].id === TARGET);
    await pg.click(T("go-cancel"));
    await pg.waitForSelector(`dialog[open] ${T("confirm-yes")}`);
    check("cancel: its fixed warning", (await pg.locator(T("confirm-warning")).textContent()).includes("取消後這次改版就結束"));
    await pg.getByRole("button", { name: "取消", exact: true }).click();
    await pg.waitForFunction(() => /cancelled/.test(document.querySelector('[data-testid="out"]').textContent));
    check("cancel declined: {cancelled:true} and no POST", S.cancelCalls.length === 0);
    await ctx.close();
  }

  // ── 11. preview hosts ──
  for (const kind of ["version", "change"]) {
    console.log(`preview host (${kind})`);
    const { ctx, pg } = await open({ preview: kind });
    await pg.click(T("go-review")); await sleep(600);
    check(`${kind} preview: openDesignReview throws read_only, no dialog, no request`, /ERR read_only/.test(await outText(pg)) && (await pg.locator("dialog[open]").count()) === 0 && S.detailCalls === 0);
    for (const b of ["go-revert", "go-cancel"]) { await pg.click(T(b)); await sleep(300); check(`${kind} preview: ${b} throws read_only`, /ERR read_only/.test(await outText(pg))); }
    check(`${kind} preview: no approve / reject control exists on the page`, (await pg.locator(`${T("confirm-yes")}, ${T("confirm-rv-ack")}, ${T("confirm-rv-reject")}`).count()) === 0);
    check(`${kind} preview: nothing was posted`, noPost() && S.revertCalls.length === 0 && S.cancelCalls.length === 0);
    await ctx.close();
  }

  // ── 12. keyboard only ──
  console.log("keyboard only");
  {
    const { ctx, pg } = await open();
    await pg.locator(T("go-review")).focus();
    await pg.keyboard.press("Enter");
    await pg.waitForSelector("dialog[open] .dlg-rv"); await waitImages(pg, 2);
    const focusId = () => pg.evaluate(() => document.activeElement && (document.activeElement.dataset.testid || document.activeElement.tagName));
    const tabTo = async (id) => { for (let i = 0; i < 60; i++) { if ((await focusId()) === id) return true; await pg.keyboard.press("Tab"); } return false; };
    check("Tab reaches the checkbox", await tabTo("confirm-rv-ack"));
    await pg.keyboard.press("Space");
    check("Space ticks it", await pg.locator(T("confirm-rv-ack")).isChecked());
    check("Tab reaches the approve button", await tabTo("confirm-yes"));
    await pg.keyboard.press("Enter");
    await pg.waitForFunction(() => !document.querySelector("dialog[open]"), null, { timeout: 8000 });
    check("Enter on the focused approve button approves (keyboard-only)", S.approveCalls.length === 1);
    await ctx.close();
  }
  {
    const { ctx, pg } = await open();
    await clickReview(pg);
    await pg.keyboard.press("Escape");
    await pg.waitForFunction(() => !document.querySelector("dialog[open]"));
    check("Escape closes the dialog without approving", noPost() && /"outcome":"closed"/.test(await outText(pg)));
    await ctx.close();
  }

  check("no console line ever held a signed URL, token or key", !consoleLines.some((l) => /_shots|X-Amz|deadbeef|tok-|secret\/key/.test(l)), consoleLines.filter((l) => /_shots|X-Amz|tok-/.test(l)).join("|").slice(0, 200));
} catch (e) {
  failures++; console.error("  FAIL test crashed:", e && e.stack || e);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
process.exit(failures ? 1 : 0);
