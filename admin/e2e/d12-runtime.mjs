// Real-browser test of the RUNTIME half of decision D12 (docs/DECISIONS.md): what the core enforces even if the static scan is bypassed.
//   * a core confirmation dialog (the kind that carries a FIXED warning) cannot be confirmed by synthetic input: .click(), dispatchEvent
//     (click, keydown, submit) and even a full page-level script do nothing; a REAL click still confirms, and Cancel / Escape still cancel
//   * h() throws for the dialog tag and for popover / inert / command attributes (any case, computed strings, non-string tags)
//   * ctx.ui.$ / $$ are scoped: no document, no body, no container of core UI, never a node of a core dialog; the computed ["$"] form is the same function
//   * ctx.ui.showDialog hands the design layer only { close }, and a design dialog's buttons ignore untrusted clicks too
// NO platform needed (same stub host as e2e/preview-banner.mjs; any /api/ call gets 401). Needs Playwright via $PLAYWRIGHT_DIR and SKIPS
// cleanly (exit 0) when it is not found.   Run: node admin/e2e/d12-runtime.mjs   (or `node e2e/d12-runtime.mjs` from admin/)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hookBrowser } from "./lib/shadow-hook.mjs";

const ADMIN = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HOST = "admin.example.test";
function loadPlaywright() {
  for (const d of [process.env.PLAYWRIGHT_DIR].filter(Boolean)) {
    try { return createRequire(join(d, "package.json"))("playwright"); } catch { /* try the next */ }
  }
  return null;
}
const pw = loadPlaywright();
if (!pw) { console.log("SKIP d12-runtime browser test: Playwright not found (set PLAYWRIGHT_DIR)"); process.exit(0); }
let browser;
try { browser = hookBrowser(await pw.chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })); } catch (e) {
  console.log(`SKIP d12-runtime browser test: Chromium could not start (${String(e.message).split("\n")[0]})`); process.exit(0);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const ALLOW = /^\/(index\.html|app\.js|config\.js|config-loader\.js|styles\.css|(lib|ui|core|vendor)\/[^/]+|(design|design-defaults)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+\.(js|css|svg|png))$/;
const server = createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p.startsWith("/api/")) { res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":{"code":"unauthorized","message":"no"}}'); return; }
  if (p === "/site-config.js") { res.writeHead(200, { "Content-Type": TYPES[".js"] }); res.end('window.ADMIN_CONFIG.siteOrigin = "https://www.example.com";'); return; }
  if (p === "/preview-config.js") { res.writeHead(200, { "Content-Type": TYPES[".js"] }); res.end(["window.ADMIN_CONFIG.preview = null;", "window.ADMIN_CONFIG.previewConfig = true;", ""].join(String.fromCharCode(10))); return; }
  const path = p === "/" ? "/index.html" : p;
  if (!ALLOW.test(path) || path.includes("..")) { res.writeHead(404); res.end("no"); return; }
  try { const b = await readFile(join(ADMIN, path)); res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" }); res.end(b); } catch { res.writeHead(404); res.end("no"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL0 = `http://${HOST}:${server.address().port}/`;

let failures = 0;
const check = (name, cond, extra = "") => { if (cond) console.log(`  ok  ${name}`); else { failures++; console.error(`  FAIL ${name} ${extra}`); } return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const bctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await bctx.newPage();
  // core dialogs live in CLOSED shadow roots; hookBrowser (e2e/lib/shadow-hook.mjs) opens them in THIS test browser only
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));
  await page.goto(URL0, { waitUntil: "load" });
  await page.waitForSelector("#app", { state: "attached" });
  await sleep(800);

  // ── 1. a delete-style confirmation (core, fixed warning) cannot be confirmed programmatically ──
  console.log("core confirmation vs synthetic input");
  await page.evaluate(async () => {
    const kit = await import("/ui/kit.js");
    window.__kit = kit;
    window.__answer = "pending";
    kit.confirmDialog({ title: "刪除商品", message: "確定要刪除？", warning: "此動作無法復原。", confirmText: "刪除", cancelText: "取消", danger: true }).then((a) => { window.__answer = a; });
  });
  await page.waitForSelector("dialog[open] [data-testid=confirm-yes]");
  check("the fixed warning is shown", (await page.locator("[data-testid=confirm-warning]").textContent()).includes("無法復原"));
  // the worst case: a script with FULL page access (more than any design layer has) fires every synthetic event it can
  const attempts = await page.evaluate(async () => {
    const yes = __dq("[data-testid=confirm-yes]");
    const log = [];
    const tryIt = (name, f) => { try { f(); log.push(`${name}: no error`); } catch (e) { log.push(`${name}: ${e.name}`); } };
    tryIt("click()", () => yes.click());
    tryIt("dispatchEvent(MouseEvent click)", () => yes.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    tryIt("dispatchEvent(PointerEvent click)", () => yes.dispatchEvent(new PointerEvent("click", { bubbles: true })));
    tryIt("dispatchEvent(Event click)", () => yes.dispatchEvent(new Event("click", { bubbles: true })));
    tryIt("dispatchEvent(KeyboardEvent Enter)", () => yes.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    tryIt("dispatchEvent(KeyboardEvent Space keyup)", () => yes.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true })));
    tryIt("dispatchEvent(submit)", () => yes.dispatchEvent(new Event("submit", { bubbles: true })));
    tryIt("el.onclick call", () => yes.onclick && yes.onclick(new MouseEvent("click")));
    await new Promise((r) => setTimeout(r, 400));
    return { log, answer: window.__answer, open: Boolean(__dq("dialog[open]")) };
  });
  check("no synthetic input confirms it (answer is still pending)", attempts.answer === "pending", JSON.stringify(attempts));
  check("the dialog is still open after every attempt", attempts.open);
  await page.locator("[data-testid=confirm-yes]").click(); // a REAL click (trusted)
  await page.waitForFunction(() => window.__answer !== "pending");
  check("a real click confirms", (await page.evaluate(() => window.__answer)) === true);

  await page.evaluate(() => { window.__answer = "pending"; window.__kit.confirmDialog({ title: "刪除商品", message: "確定要刪除？", warning: "此動作無法復原。", confirmText: "刪除", cancelText: "取消" }).then((a) => { window.__answer = a; }); });
  await page.waitForSelector("dialog[open]");
  await page.getByRole("button", { name: "取消" }).click();
  await page.waitForFunction(() => window.__answer !== "pending");
  check("a real click on Cancel answers false", (await page.evaluate(() => window.__answer)) === false);

  await page.evaluate(() => { window.__answer = "pending"; window.__kit.confirmDialog({ title: "刪除商品", message: "確定要刪除？", warning: "此動作無法復原。", confirmText: "刪除", cancelText: "取消" }).then((a) => { window.__answer = a; }); });
  await page.waitForSelector("dialog[open]");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__answer !== "pending");
  check("Escape answers false", (await page.evaluate(() => window.__answer)) === false);

  // keyboard: focus the confirm button and press Enter (a trusted key press activates it)
  await page.evaluate(() => { window.__answer = "pending"; window.__kit.confirmDialog({ title: "刪除商品", message: "確定要刪除？", warning: "此動作無法復原。", confirmText: "刪除", cancelText: "取消" }).then((a) => { window.__answer = a; }); });
  await page.waitForSelector("dialog[open]");
  await page.locator("[data-testid=confirm-yes]").focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__answer !== "pending");
  check("a real Enter key on the focused confirm button confirms", (await page.evaluate(() => window.__answer)) === true);

  // ── 2. h(): dialog tag and popover / inert / command attributes throw ──
  console.log("h() refusals");
  const refusals = await page.evaluate(() => {
    const { h, button } = window.__kit;
    const out = {};
    const t = (name, f) => { try { f(); out[name] = "no error"; } catch (e) { out[name] = e.name; } };
    t("h('dialog')", () => h("dialog"));
    t("h('DIALOG')", () => h("DIALOG"));
    t("h(' Dialog ')", () => h(" Dialog "));
    t("h(['dialog'])", () => h(["dialog"]));
    t("h({toString})", () => h({ toString: () => "dialog" }));
    t("h('di' + 'alog')", () => h(["di", "alog"].join("")));
    for (const a of ["popover", "POPOVER", "popovertarget", "popoverTargetAction", "inert", "commandfor", "command", "interestfor"]) t(`h('div', { ${a} })`, () => h("div", { [a]: "x" }));
    t("button(x, { popover })", () => button("x", { popover: "auto" }));
    t("button(x, { inert })", () => button("x", { inert: true }));
    t("h('div', { onclick: 'string' }) is only dropped", () => h("div", { onclick: "x()" }));
    t("h('script') is dropped, not thrown", () => h("script"));
    out.fine = (() => { try { const d = h("div", { class: "a", role: "dialog", "aria-modal": "true", "data-popover": "x", inert: false }, "ok"); return d.tagName + "|" + d.getAttribute("role") + "|" + d.hasAttribute("inert"); } catch (e) { return e.name; } })();
    return out;
  });
  for (const k of ["h('dialog')", "h('DIALOG')", "h(' Dialog ')", "h(['dialog'])", "h({toString})", "h('di' + 'alog')", "button(x, { popover })", "button(x, { inert })"]) check(`${k} throws DesignError`, refusals[k] === "DesignError", refusals[k]);
  for (const a of ["popover", "POPOVER", "popovertarget", "popoverTargetAction", "inert", "commandfor", "command", "interestfor"]) check(`attribute ${a} throws DesignError`, refusals[`h('div', { ${a} })`] === "DesignError", refusals[`h('div', { ${a} })`]);
  check("string handlers and script tags are still dropped, not thrown", refusals["h('div', { onclick: 'string' }) is only dropped"] === "no error" && refusals["h('script') is dropped, not thrown"] === "no error");
  check("legitimate attributes (role=dialog, aria-modal, data-popover, inert:false) still work", refusals.fine === "DIV|dialog|false", refusals.fine);

  // ── 3. ctx.ui.$ / $$ and showDialog as the design layer gets them ──
  console.log("ctx.ui as the design layer sees it");
  // a design dialog (ctx.ui.showDialog, light DOM) while NO core dialog is open: only { close }, and its buttons ignore synthetic clicks
  const designPart = await page.evaluate(async () => {
    const { makeContext } = await import("/core/context.js");
    const ctx = makeContext({ routeId: "home", nav: [], auth: undefined });
    const { h } = ctx.ui;
    const handle = ctx.ui.showDialog({ title: "設計層的對話框", content: h("p", {}, "x"), actions: [{ label: "按鈕一", kind: "primary", onClick: () => { window.__designClicked = (window.__designClicked || 0) + 1; } }] });
    await new Promise((r) => setTimeout(r, 100));
    const designBtn = [...document.querySelectorAll("dialog[open] button")].find((b) => b.textContent === "按鈕一");
    designBtn.click();
    designBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return { handleKeys: Object.keys(handle).join(","), designClicksFromSynthetic: window.__designClicked || 0 };
  });
  check("ctx.ui.showDialog returns only { close }", designPart.handleKeys === "close", designPart.handleKeys);
  check("a design dialog's buttons ignore synthetic clicks", designPart.designClicksFromSynthetic === 0, String(designPart.designClicksFromSynthetic));
  await page.getByRole("button", { name: "按鈕一" }).click(); // a real click works
  check("a real click on a design dialog button runs its action", (await page.evaluate(() => window.__designClicked)) === 1);
  await page.waitForFunction(() => !document.querySelector("dialog[open]"));
  const scoped = await page.evaluate(async () => {
    const { makeContext } = await import("/core/context.js");
    const ctx = makeContext({ routeId: "home", nav: [], auth: undefined });
    const { h } = ctx.ui;
    window.__ctx = ctx;
    const out = {};
    window.__answer = "pending";
    window.__kit.confirmDialog({ title: "刪除商品", message: "確定要刪除？", warning: "此動作無法復原。", confirmText: "刪除", cancelText: "取消" }).then((a) => { window.__answer = a; });
    await new Promise((r) => setTimeout(r, 200));
    const quiet = (f) => { const w = console.warn; console.warn = () => {}; try { return f(); } finally { console.warn = w; } };
    out.noRoot = quiet(() => ctx.ui.$("[data-testid=confirm-yes]"));
    out.documentRoot = quiet(() => ctx.ui.$("[data-testid=confirm-yes]", document));
    out.bodyRoot = quiet(() => ctx.ui.$("[data-testid=confirm-yes]", document.body));
    out.htmlRoot = quiet(() => ctx.ui.$("[data-testid=confirm-warning]", document.documentElement));
    out.allBody = quiet(() => ctx.ui.$$("button", document.body)).length;
    out.computed = quiet(() => ctx.ui["$"]("[data-testid=confirm-yes]"));
    out.viaValues = quiet(() => Object.values(ctx.ui).filter((f) => typeof f === "function" && /^designQuery/.test(f.name)).map((f) => f("[data-testid=confirm-yes]", document)).filter((x) => x && (x.nodeType === 1 || x.length)).length);
    const dlg = __dq("dialog[open]");
    out.insideDialog = quiet(() => ctx.ui.$("[data-testid=confirm-yes]", dlg));
    const wrap = h("div", {}, h("p", { class: "mine" }, "x"), h("span", { class: "mine2" }, "y"));
    out.ownOk = Boolean(ctx.ui.$(".mine", wrap)) && ctx.ui.$$("span, p", wrap).length === 2;
    document.body.append(wrap);
    out.attachedOwnOk = Boolean(ctx.ui.$(".mine", wrap));
    const holder = h("div", {}, h("div", { id: "toasts" }, h("p", { class: "mine" }, "z")));
    out.toastContainer = quiet(() => ctx.ui.$(".mine", holder));
    wrap.remove();
    out.refusedDecoy = (() => { const hh = ctx.ui.showDialog({ title: "decoy", content: h("p", {}, "x"), actions: [] }); return Object.keys(hh).join(",") + "|" + document.querySelectorAll("dialog").length + "|" + Boolean(window.__dq("dialog[open]")); })();
    out.answerStill = window.__answer;
    return out;
  });
  check("ctx.ui.$ without a root finds nothing", scoped.noRoot === null);
  check("ctx.ui.$ with document, body or html as root finds nothing", scoped.documentRoot === null && scoped.bodyRoot === null && scoped.htmlRoot === null);
  check("ctx.ui.$$ over body returns nothing", scoped.allBody === 0, String(scoped.allBody));
  check('the computed form ctx.ui["$"] is the same scoped function', scoped.computed === null);
  check("the query functions found through Object.values(ctx.ui) reach no core node with (selector, document)", scoped.viaValues === 0, String(scoped.viaValues));
  check("a root inside a dialog finds nothing", scoped.insideDialog === null);
  check("a container of toast / core nodes is refused", scoped.toastContainer === null);
  check("$ / $$ still work on an element the design built (detached and attached)", scoped.ownOk === true && scoped.attachedOwnOk === true);
  check("ctx.ui.showDialog is refused while a core confirmation is open (a no-op { close }, no dialog in the page)", scoped.refusedDecoy === "close|0|true", scoped.refusedDecoy);
  check("and the core confirmation behind it is still unanswered", scoped.answerStill === "pending");
  await page.keyboard.press("Escape"); // closes the core confirmation

  check("no uncaught page errors", errors.length === 0, errors.join(" | "));
  await bctx.close();
} finally {
  await browser.close();
  server.close();
}
if (failures) { console.error(`\nd12-runtime browser test: ${failures} FAILED`); process.exit(1); }
console.log("\nd12-runtime browser test: all passed");
