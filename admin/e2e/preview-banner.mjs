// Real-browser test of the preview-mode core banner (headless Chromium via Playwright). NO platform needed: the admin files are served
// by a tiny stub server (any /api/ call gets 401, so the app lands on the login screen) under a NON-local host name
// (admin.example.test, mapped to 127.0.0.1 by Chromium), so the production path is exercised: config-loader.js loads
// site-config.js and preview-config.js exactly as the nginx host serves them.
//
// Run:   node admin/e2e/preview-banner.mjs            (from the repo root; or `node e2e/preview-banner.mjs` from admin/)
// Needs Playwright with a Chromium. It is NOT a dependency of the template: the test looks for it in
//   $PLAYWRIGHT_DIR (a directory with node_modules/playwright, e.g. the e2e folder of a platform checkout)
// and SKIPS cleanly (exit 0, "SKIP ...") when it is not found. Screenshots go to $BANNER_SHOTS (default admin/e2e/out/banner).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hookBrowser } from "./lib/shadow-hook.mjs";

const ADMIN = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SHOTS = process.env.BANNER_SHOTS || resolve(ADMIN, "e2e/out/banner");
const HOST = "admin.example.test";

function loadPlaywright() {
  const dirs = [process.env.PLAYWRIGHT_DIR].filter(Boolean);
  for (const d of dirs) {
    try { return createRequire(join(d, "package.json"))("playwright"); } catch { /* try the next */ }
  }
  return null;
}
const pw = loadPlaywright();
if (!pw) { console.log("SKIP preview-banner browser test: Playwright not found (set PLAYWRIGHT_DIR)"); process.exit(0); }
let browser;
try { browser = hookBrowser(await pw.chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })); } catch (e) {
  console.log(`SKIP preview-banner browser test: Chromium could not start (${String(e.message).split("\n")[0]})`); process.exit(0);
}
mkdirSync(SHOTS, { recursive: true });

// ── stub host ──
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
const ALLOW = /^\/(index\.html|app\.js|config\.js|config-loader\.js|styles\.css|(lib|ui|core|vendor)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+|(design|design-defaults)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+\.(js|css|svg|png))$/;
let previewConfig = ""; // body of /preview-config.js, "" = 404
const server = createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p.startsWith("/api/")) { res.writeHead(401, { "Content-Type": "application/json" }); res.end('{"error":{"code":"unauthorized","message":"no"}}'); return; }
  if (p === "/site-config.js") { res.writeHead(200, { "Content-Type": TYPES[".js"] }); res.end('window.ADMIN_CONFIG.siteOrigin = "https://www.example.com";'); return; }
  if (p === "/preview-config.js") { if (!previewConfig) { res.writeHead(404); res.end("no"); return; } res.writeHead(200, { "Content-Type": TYPES[".js"] }); res.end(previewConfig); return; }
  const path = p === "/" ? "/index.html" : p;
  if (!ALLOW.test(path) || path.includes("..")) { res.writeHead(404); res.end("no"); return; }
  try { const b = await readFile(join(ADMIN, path)); res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" }); res.end(b); } catch { res.writeHead(404); res.end("no"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const URL0 = `http://${HOST}:${server.address().port}/`;

const MARK = "window.ADMIN_CONFIG.previewConfig = true;";
const CONFIG = {
  preview: `window.ADMIN_CONFIG.preview = {"kind":"version","tag":"design-2026-10-01","expiresAt":"2999-01-01T00:00:00Z"};\n${MARK}\n`,
  normal: `window.ADMIN_CONFIG.preview = null;\n${MARK}\n`,
  none: "",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => { if (cond) console.log(`  ok  ${name}`); else { failures++; console.error(`  FAIL ${name} ${extra}`); } return cond; };

async function open(cfg, { width = 1280, height = 800, noPopover = false } = {}) {
  previewConfig = CONFIG[cfg];
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const state = { crashed: false, errors: [] };
  page.on("crash", () => { state.crashed = true; });
  page.on("pageerror", (e) => state.errors.push(String(e.message)));
  if (noPopover) await page.addInitScript(() => { delete HTMLElement.prototype.showPopover; delete HTMLElement.prototype.hidePopover; }); // browsers without the Popover API
  await page.addInitScript(() => { // counts how many times a banner element is ADDED to <body> (a rebuild loop shows up here)
    window.__adds = 0;
    new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.id === "core-preview-banner") window.__adds++; }).observe(document, { childList: true, subtree: true });
  });
  await page.goto(URL0, { waitUntil: "load" });
  await page.waitForSelector("#app, [data-testid=preview-failed-closed]", { state: "attached" });
  await sleep(1200);
  return { ctx, page, state };
}
const facts = (page) => page.evaluate(() => {
  const b = document.getElementById("core-preview-banner");
  const r = b ? b.getBoundingClientRect() : null;
  return {
    banner: Boolean(b), text: b ? b.textContent : "", rect: r ? { w: r.width, h: r.height, top: r.top } : null,
    failed: document.documentElement.getAttribute("data-preview-failed-closed") === "1",
    failMsgs: document.querySelectorAll("[data-testid=preview-failed-closed]").length,
    app: Boolean(document.getElementById("app") && document.getElementById("app").isConnected), adds: window.__adds,
    top: b ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === b || b.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)) : false,
    popoverOpen: b ? (() => { try { return b.matches(":popover-open"); } catch { return false; } })() : false,
    allImportant: b ? [...b.style].every((k) => b.style.getPropertyPriority(k) === "important") : false,
  };
});

// What a person SEES at the middle of the bar: read back from a real screenshot (a pointer-events:none overlay is invisible to elementFromPoint).
const seenColor = async (page) => {
  const png = (await page.screenshot({ clip: { x: 0, y: 0, width: 40, height: 20 } })).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    const g = c.getContext("2d"); g.drawImage(img, 0, 0);
    return Array.from(g.getImageData(2, 2, 1, 1).data).slice(0, 3).join(",");
  }, png);
};
const BAR_RGB = "255,243,196";

try {
  // 1. preview page: the real browser normalizes values; the banner must still be intact, no loop, no fail-closed
  console.log("preview page");
  for (const [w, h] of [[390, 780], [1280, 800]]) {
    const { ctx, page, state } = await open("preview", { width: w, height: h });
    await sleep(2500);
    const f = await facts(page);
    check(`[${w}] does not fail closed`, !f.failed && f.failMsgs === 0 && f.app);
    check(`[${w}] banner present, visible, on top, full width`, f.banner && f.top && f.rect.h >= 16 && f.rect.w >= w * 0.9, JSON.stringify(f.rect));
    check(`[${w}] banner text is complete`, /^版本預覽（非正式版本，唯讀）｜版本：design-2026-10-01｜到期時間：/.test(f.text), f.text);
    check(`[${w}] every inline style is !important`, f.allImportant);
    check(`[${w}] banner is in the top layer (popover open) when the browser supports it`, f.popoverOpen);
    check(`[${w}] bar is a normal bar: top 0, height under 120px, page content starts below it`, f.rect.top === 0 && f.rect.h < 120 && (await page.evaluate(() => document.getElementById("core-preview-banner-spacer").getBoundingClientRect().height)) > 0);
    check(`[${w}] built once, no rebuild loop`, f.adds === 1, `adds=${f.adds}`);
    check(`[${w}] page did not crash, no script error`, !state.crashed && state.errors.length === 0, state.errors.join("|"));
    await page.screenshot({ path: join(SHOTS, `banner-${w}.png`) });
    check(`[${w}] the bar colour is what is painted at the top-left`, (await seenColor(page)) === BAR_RGB);
    console.log(`  screenshot ${join(SHOTS, `banner-${w}.png`)}`);
    await ctx.close();
  }

  // 2. a normal host: never a banner, never fail closed
  console.log("normal host");
  { const { ctx, page, state } = await open("normal"); await sleep(2000); const f = await facts(page);
    check("no banner, not failed closed, app present", !f.banner && !f.failed && f.app && f.adds === 0);
    check("no crash", !state.crashed && state.errors.length === 0, state.errors.join("|")); await ctx.close(); }

  // 3. the config script did not load on a non-local host: fail closed (once)
  console.log("preview host whose config did not load");
  { const { ctx, page, state } = await open("none"); await sleep(2000); const f = await facts(page);
    check("fails closed exactly once", f.failed && f.failMsgs === 1 && !f.app, JSON.stringify(f));
    check("no crash", !state.crashed, ""); await ctx.close(); }

  // 4. self-healing: tampering the banner itself is repaired, no fail-closed
  console.log("tampering that is repaired");
  const REPAIR = {
    "inline opacity 0": (b) => b.style.setProperty("opacity", "0", "important"),
    "inline display none": (b) => b.style.setProperty("display", "none", "important"),
    "text changed": (b) => { b.textContent = "ok"; },
    "removed": (b) => b.remove(),
    "font-size 0": (b) => b.style.setProperty("font-size", "0", "important"),
    "text-indent": (b) => b.style.setProperty("text-indent", "-9999px", "important"),
    "text-fill transparent": (b) => b.style.setProperty("-webkit-text-fill-color", "transparent", "important"),
    "moved into #app": (b) => document.getElementById("app").append(b),
    "hidePopover()": (b) => b.hidePopover(),
    "popover attribute removed": (b) => b.removeAttribute("popover"),
    "popover attribute changed to auto": (b) => b.setAttribute("popover", "auto"),
  };
  for (const [name, fn] of Object.entries(REPAIR)) {
    const { ctx, page, state } = await open("preview");
    if (/popover/i.test(name) && !(await facts(page)).popoverOpen) { await ctx.close(); continue; } // no Popover API in this browser
    await page.evaluate(`(${fn.toString()})(document.getElementById("core-preview-banner"))`);
    await sleep(1800);
    const f = await facts(page);
    check(`${name}: repaired, not failed closed`, f.banner && f.top && !f.failed && (f.popoverOpen || !/popover/i.test(name)) && f.text.startsWith("版本預覽") && !state.crashed, JSON.stringify(f));
    await ctx.close();
  }

  // 4b. top layer: overlays that elementFromPoint cannot see must not cover the banner (Popover API) -- banner stays what is painted on top
  console.log("top layer vs. pointer-events:none overlays");
  const OVERLAY = {
    "full-screen overlay (clickable)": () => { const o = document.createElement("div"); o.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#fff"; document.body.append(o); },
    "overlay on top of the bar only (clickable)": () => { const o = document.createElement("div"); o.style.cssText = "position:fixed;left:0;right:0;top:0;height:60px;z-index:2147483647;background:#fff"; document.getElementById("app").append(o); },
    "div: fixed, max z-index, opaque, pointer-events:none": () => { const o = document.createElement("div"); o.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000;pointer-events:none"; document.body.append(o); },
    "div on the bar only, appended to #app": () => { const o = document.createElement("div"); o.style.cssText = "position:fixed;left:0;right:0;top:0;height:80px;z-index:2147483647;background:#000;pointer-events:none"; document.getElementById("app").append(o); },
    "body::after: fixed, opaque, pointer-events:none": () => { const s = document.createElement("style"); s.textContent = 'body::after{content:"";position:fixed;inset:0;z-index:2147483647;background:#000;pointer-events:none}'; document.head.append(s); },
    "modal dialog opened later": () => { const d = document.createElement("dialog"); d.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;border:0;margin:0;background:#000;pointer-events:none"; document.body.append(d); d.showModal(); },
  };
  for (const [name, fn] of Object.entries(OVERLAY)) {
    const { ctx, page, state } = await open("preview");
    if (!(await facts(page)).popoverOpen) { await ctx.close(); continue; }
    await page.evaluate(`(${fn.toString()})()`);
    await sleep(2500);
    const f = await facts(page);
    check(`${name}: banner stays on top (painted), not failed closed`, f.banner && f.popoverOpen && !f.failed && (await seenColor(page)) === BAR_RGB && !state.crashed && f.adds <= 2, JSON.stringify(f));
    await ctx.close();
  }
  // 4c. WITHOUT the Popover API the same overlays must be detected: the app fails closed exactly once
  console.log("no Popover API: fallback scan");
  for (const [name, fn] of Object.entries(OVERLAY)) {
    if (/dialog/.test(name)) continue;
    const { ctx, page, state } = await open("preview", { noPopover: true });
    await page.evaluate(`(${fn.toString()})()`);
    await sleep(2500);
    const f = await facts(page);
    check(`${name} (no popover): fails closed exactly once`, f.failed && f.failMsgs === 1 && !f.app && !state.crashed, JSON.stringify(f));
    await ctx.close();
  }
  { const { ctx, page, state } = await open("preview", { noPopover: true }); await sleep(1500); const f = await facts(page);
    check("no popover: plain preview page still works (sticky bar, on top, no fail-closed)", f.banner && f.top && !f.failed && !f.popoverOpen && f.adds === 1 && !state.crashed, JSON.stringify(f));
    await page.screenshot({ path: join(SHOTS, "banner-nopopover-1280.png") }); await ctx.close(); }
  // 4e. dialogs: legitimate confirms (ui/kit.js style: opaque backdrop, opened a few times) keep the app; loops of modals / popovers fail closed once
  console.log("modal dialogs and top-layer rotation");
  const DLG = `(() => { const d = document.createElement("dialog"); d.textContent = "confirm"; d.style.cssText = "border:1px solid #000;padding:2rem"; document.body.append(d); d.showModal(); window.__d = d; })()`;
  { const { ctx, page, state } = await open("preview");
    if ((await facts(page)).popoverOpen) {
      for (let i = 0; i < 3; i++) {
        await page.evaluate(DLG); await sleep(700);
        const f = await facts(page);
        check(`confirm dialog #${i + 1} open: banner still top-most, not failed closed`, f.popoverOpen && !f.failed && f.app && (await seenColor(page)) === BAR_RGB, JSON.stringify(f));
        await page.evaluate(() => { window.__d.close(); window.__d.remove(); }); await sleep(700);
      }
      const f = await facts(page);
      check("after three confirms: no fail-closed, no crash", !f.failed && f.app && !state.crashed, JSON.stringify(f));
      // a dialog that stays open must not make the banner churn (no raise loop): count toggle events of the banner over 3 s
      await page.evaluate(DLG);
      await page.evaluate(() => { window.__tg = 0; document.getElementById("core-preview-banner").addEventListener("toggle", () => window.__tg++); });
      await sleep(3000);
      check("a dialog that stays open: banner is not re-raised over and over", (await page.evaluate(() => window.__tg)) === 0 && !(await facts(page)).failed);
    }
    await ctx.close(); }
  for (const [name, fn] of Object.entries({
    "fight: opaque showModal() closed and re-opened every 40 ms": () => { const d = document.createElement("dialog"); d.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;border:0;margin:0;background:#000;pointer-events:none"; document.body.append(d); setInterval(() => { d.close(); try { d.showModal(); } catch {} }, 40); d.showModal(); },
    "fight: a NEW opaque modal every 40 ms": () => { setInterval(() => { document.querySelectorAll("dialog").forEach((x) => x.remove()); const d = document.createElement("dialog"); d.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;border:0;margin:0;background:#000"; document.body.append(d); d.showModal(); }, 40); },
    "fight: popover=manual rotation every 40 ms": () => { setInterval(() => { document.querySelectorAll("[data-rot]").forEach((x) => x.remove()); const d = document.createElement("div"); d.setAttribute("data-rot", ""); d.setAttribute("popover", "manual"); d.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;margin:0;border:0;background:#000;pointer-events:none"; document.body.append(d); d.showPopover(); }, 40); },
  })) {
    const { ctx, page, state } = await open("preview");
    if (!(await facts(page)).popoverOpen) { await ctx.close(); continue; }
    await page.evaluate(`(${fn.toString()})()`);
    await sleep(3500);
    const f = await facts(page);
    check(`${name}: fails closed exactly once, no crash`, f.failed && f.failMsgs === 1 && !f.app && !state.crashed, JSON.stringify(f));
    await sleep(1000);
    check(`${name}: nothing changes afterwards`, (await facts(page)).failMsgs === 1);
    await ctx.close();
  }
  // 4d. a design layer that keeps closing the popover: bounded, one fail-closed
  { const { ctx, page, state } = await open("preview");
    if ((await facts(page)).popoverOpen) {
      await page.evaluate(() => { const hide = () => { try { document.getElementById("core-preview-banner")?.hidePopover(); } catch {} }; setInterval(hide, 30); });
      await sleep(4000); const f = await facts(page);
      check("fight: hidePopover() in a loop fails closed exactly once, no crash", f.failed && f.failMsgs === 1 && !f.app && !state.crashed, JSON.stringify(f));
    }
    await ctx.close(); }

  // 5. things the core cannot repair: fail closed exactly once, no crash, no loop
  console.log("attacks that make the app fail closed");
  const ATTACK = {
    "stylesheet: body opacity 0": () => { const s = document.createElement("style"); s.textContent = "body{opacity:0 !important}"; document.head.append(s); },
    "stylesheet: body filter": () => { const s = document.createElement("style"); s.textContent = "body{filter:opacity(0) !important}"; document.head.append(s); },
    "stylesheet: body transform away": () => { const s = document.createElement("style"); s.textContent = "body{transform:translateY(-500px) !important}"; document.head.append(s); },
    "stylesheet: banner first-line transparent": () => { const s = document.createElement("style"); s.textContent = "#core-preview-banner::first-line{color:transparent !important}"; document.head.append(s); },
    "fight: remove it after every rebuild": () => { new MutationObserver(() => document.getElementById("core-preview-banner")?.remove()).observe(document.body, { childList: true }); document.getElementById("core-preview-banner")?.remove(); },
    "fight: hide it after every rebuild": () => { const hide = () => { const b = document.getElementById("core-preview-banner"); if (b) b.setAttribute("hidden", ""); b?.style.setProperty("display", "none", "important"); }; new MutationObserver(hide).observe(document.documentElement, { childList: true, subtree: true }); hide(); },
  };
  for (const [name, fn] of Object.entries(ATTACK)) {
    const { ctx, page, state } = await open("preview");
    await page.evaluate(`(${fn.toString()})()`);
    await sleep(2500);
    const f = await facts(page);
    const snap = await page.evaluate(() => document.body.innerHTML.length);
    await sleep(1500);
    const snap2 = await page.evaluate(() => document.body.innerHTML.length);
    check(`${name}: fails closed exactly once`, f.failed && f.failMsgs === 1 && !f.app, JSON.stringify(f));
    check(`${name}: no crash, page still responsive, nothing changes after`, !state.crashed && snap === snap2 && (await page.evaluate(() => 1 + 1)) === 2);
    await ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  await new Promise((r) => server.close(r));
}
console.log(failures ? `\npreview-banner browser test: ${failures} FAILED` : "\npreview-banner browser test: all passed");
process.exit(failures ? 1 : 0);
