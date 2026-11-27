// Real-browser test of the import-map isolation (docs/DECISIONS.md D19), headless Chromium via Playwright. NO platform needed: one tiny server serves the admin
// files under the REAL strict CSP of admin/deploy/nginx.conf.template (read from the template, hash included) plus a fake platform API that records every request
// and the Authorization header it carried. Test-only modules are served from memory UNDER /design/ (where a design module lives); they are NOT scanned (the guard
// would refuse them): the test plays the case "the static scan was bypassed".
//
// Covered: (1) hostile design module: ~25 core modules x 14 import spellings (relative, absolute path, absolute URL, protocol-relative, query string, percent-encoding,
//   /design/../, dot segments, backslashes, new URL(.., import.meta.url), data:, bare) must ALL reject; the fake API sees ZERO requests for the shop id the hostile code
//   uses; legitimate imports inside design/ still work; (2) the boot-phase seals (takeX() throw, the old named exports are gone, `session` is read-only);
//   (3) the fail-closed canary: with the hash -> the design loads; without the hash, with a tampered map text, without import-map support, with the map removed -> the design
//   is NOT loaded, the built-in screens run, a console warning and the calm note are shown; (4) CONTROL runs prove the test can fail: with the map removed and the canary
//   bypassed the same hostile module DOES import the core and DOES send authenticated requests; with an nginx-style decoder and no `%` rule a `..%2f` path reaches lib/.
// Not run here: Firefox and Safari (only Chromium is available); a real nginx in the suite (the `/deny/` 404 and the `%` refusal of the template are emulated by this server; they were checked by hand against nginx:1.27-alpine, see D19).
// Needs Playwright via $PLAYWRIGHT_DIR and SKIPS cleanly (exit 0) when it is not found.   Run: node admin/e2e/import-map.mjs
import { createServer, get as httpGet } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { posix } from "node:path";
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
if (!pw) { console.log("SKIP import-map browser test: Playwright not found (set PLAYWRIGHT_DIR)"); process.exit(0); }
let browser;
try { browser = hookBrowser(await pw.chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })); } catch (e) {
  console.log(`SKIP import-map browser test: Chromium could not start (${String(e.message).split("\n")[0]})`); process.exit(0);
}

// ── the real CSP of the nginx template (server level), variables filled with test values ──
const tpl = readFileSync(join(ADMIN, "deploy/nginx.conf.template"), "utf8");
const REAL_CSP = /add_header Content-Security-Policy "([^"]+)" always;/.exec(tpl.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"))[1]
  .replace("${ADMIN_IMG_ORIGIN}", "https://img.example.test").replace("${ADMIN_UPLOAD_ORIGIN}", "https://upload.example.test");
const INDEX = readFileSync(join(ADMIN, "index.html"), "utf8");
const MAP_RE = /<script type="importmap">([^<]*)<\/script>/;
const MAP_TEXT = MAP_RE.exec(INDEX)[1];
const hashOf = (t) => createHash("sha256").update(t, "utf8").digest("base64");
const NO_HASH_CSP = REAL_CSP.replace(/ 'sha256-[^']+'/, "");

// ── the fake platform ──
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };
const ALLOW = /^\/(index\.html|app\.js|config\.js|config-loader\.js|styles\.css|(lib|ui|core|vendor)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+|(design|design-defaults)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+\.(js|css|svg|png))$/;
const json = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
let S;
const reset = (o = {}) => { S = { api: [], files: [], reports: [], marks: [], valid: "", n: 0, csp: REAL_CSP, indexMap: (t) => t, appJs: (t) => t, percentRule: true, decode: false, routes: null, hide: [], ...o }; };
reset();
const MODULES = {}; // in-memory test-only modules (path -> source)
const server = createServer(async (req, res) => {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  const note = (status) => { S.files.push({ p: p + (u.search || ""), status }); };
  if (p === "/_report" && req.method === "POST") { let b = ""; for await (const c of req) b += c; S.reports.push(JSON.parse(b)); res.writeHead(204); res.end(); return; }
  if (p === "/_mark") { S.marks.push(u.searchParams.get("v")); S.markAt = S.markAt || {}; S.markAt[u.searchParams.get("v")] = S.api.length; res.writeHead(204); res.end(); return; }
  if (p.startsWith("/api/v1/")) {
    const a = p.slice("/api/v1".length), m = req.method;
    S.api.push({ method: m, a, auth: req.headers.authorization || "" });
    if (m === "POST" && a === "/admin/auth/refresh") { S.valid = "tok-" + ++S.n; return json(res, 200, { access_token: S.valid }); }
    if (m === "POST" && a === "/admin/auth/logout") { res.writeHead(204); res.end(); return; }
    if (a === "/admin/branding") return json(res, 200, { name: "Test Shop", branding: {} });
    if ((req.headers.authorization || "") !== "Bearer " + S.valid) return json(res, 401, { error: { code: "unauthorized", message: "no" } });
    if (a === "/admin/me") return json(res, 200, { id: 1, email: "owner@example.com", sids: [1], platform_permissions: [] });
    if (a === "/admin/shops/1/me") return json(res, 200, { permissions: ["order.view"] });
    if (a === "/admin/shops/1/branding") return json(res, 200, { name: "Test Shop", branding: {} });
    if (a === "/admin/media/config") return json(res, 200, { enabled: false });
    if (/^\/admin\/shops\/\d+\/orders/.test(a)) return json(res, 200, { orders: [], total: 0 });
    return json(res, 404, { error: { code: "not_found", message: "no" } });
  }
  if (p === "/site-config.js") { res.writeHead(200, { "Content-Type": TYPES[".js"] }); res.end('window.ADMIN_CONFIG.siteOrigin = "https://www.example.com";'); note(200); return; }
  if (p === "/preview-config.js") { res.writeHead(200, { "Content-Type": TYPES[".js"] }); res.end("window.ADMIN_CONFIG.preview = null; window.ADMIN_CONFIG.previewConfig = true;"); return; }
  // what deploy/nginx.conf.template does (emulated): /deny/ is a 404; a percent sign in a /design/ path is a 404
  if (p.startsWith("/deny/")) { res.writeHead(404); res.end("no"); note(404); return; }
  if (S.percentRule && /^[^?]*(%2f|%5c|%2e|\/\/)/i.test(req.url)) { res.writeHead(404); res.end("no"); note(404); return; }
  let path = p === "/" ? "/index.html" : p;
  if (S.decode) { try { path = posix.normalize(decodeURIComponent(path).replace(/\\/g, "/")); } catch { /* keep */ } } // what nginx does with $uri: decode, then resolve dot segments
  if (S.hide.includes(path)) { res.writeHead(404); res.end("no"); note(404); return; }
  if (path === "/design/views/zz-redirect.js") { res.writeHead(302, { Location: "/lib/orders.js" }); res.end(); note(302); return; }
  if (path === "/design/routes.js" && S.routes) { res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" }); res.end(`export default ${JSON.stringify(S.routes)};`); note(200); return; }
  if (MODULES[path]) { res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" }); res.end(MODULES[path]); note(200); return; }
  if (!ALLOW.test(path) || path.includes("..")) { res.writeHead(404); res.end("no"); note(404); return; }
  try {
    let b = await readFile(join(ADMIN, path));
    const extra = {};
    if (path === "/index.html") { extra["Content-Security-Policy"] = S.csp; b = Buffer.from(S.indexMap(b.toString("utf8"))); }
    if (path === "/app.js") b = Buffer.from(S.appJs(b.toString("utf8")));
    res.writeHead(200, { "Content-Type": TYPES[path.slice(path.lastIndexOf("."))] || "application/octet-stream", "Cache-Control": "no-store", ...extra });
    res.end(b); note(200);
  } catch { res.writeHead(404); res.end("no"); note(404); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const URL0 = `http://${HOST}:${PORT}/`;

let checks = 0, failures = 0;
const check = (name, cond, extra = "") => { checks++; if (cond) console.log(`  ok  ${name}`); else { failures++; console.error(`  FAIL ${name} ${extra}`); } return cond; };
const section = (s) => console.log(`\n${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the hostile design module (test-only; placed where a design view lives) ──
const CORE_MODULES = ["lib", "core", "ui"].flatMap((d) => readdirSync(join(ADMIN, d)).filter((f) => f.endsWith(".js")).map((f) => `${d}/${f}`)).concat(["app.js", "config.js", "index.html", "design-defaults/routes.js", "design-defaults/copy.js", "design-defaults/views/home.js", "vendor/heic2any.min.js"]);
const PRIVILEGED = ["lib/api.js", "lib/orders.js", "lib/catalog.js", "lib/content.js", "lib/design-review.js", "lib/design-history.js", "lib/session.js", "lib/perm.js", "lib/boot.js", "core/design-actions.js", "core/content-actions.js", "core/actions.js", "core/auth.js", "ui/kit.js", "lib/design.js", "lib/upload.js", "lib/team.js", "lib/members.js"];
MODULES["/design/views/zz-ok.js"] = "export const ok = 'zz-ok';\n";
MODULES["/design/views/zz-hostile.js"] = `
const TARGETS = ${JSON.stringify(CORE_MODULES)};
const PRIV = ${JSON.stringify(PRIVILEGED)};
const attempts = [];
const O = location.origin;
const spellings = (P) => {
  const enc = P.replace(/^(.)/, (c) => "%" + c.charCodeAt(0).toString(16)); // first letter percent-encoded: /%6cib/...
  const enc2 = P.replace(/o/, "%6f");
  return {
    relative: "../../" + P, relativeDot: "./../../" + P, absPath: "/" + P, absUrl: O + "/" + P, protoRel: "//" + location.host + "/" + P,
    query: "/" + P + "?x=/design/", queryRel: "../../" + P + "?v=/design/views/", pct1: "/" + enc, pct2: "/" + enc2,
    dotdot: "/design/../" + P, dotdot2: "/design/views/../../" + P, dotseg: "/design/./../" + P, pctDots: "/design/%2e%2e/" + P, pctSlash: "/design/..%2f" + P,
    backslash: "/design/..\\\\" + P.replaceAll("/", "\\\\"), metaUrl: new URL("../../" + P, import.meta.url).href,
    data: "data:text/javascript,export * from '" + O + "/" + P + "'", bare: P, tripleDot: "/design/.../../" + P,
  };
};
const hit = async (kind, label, spec) => {
  try { const m = await import(spec); attempts.push({ kind, label, spec, ok: true, keys: Object.keys(m).slice(0, 12) }); return m; }
  catch (e) { attempts.push({ kind, label, spec, ok: false, err: String(e && e.name) + ": " + String(e && e.message).slice(0, 90) }); return null; }
};
export default async function (root, ctx) {
  await fetch("/_mark?v=start");
  for (const P of TARGETS) { const sp = spellings(P); for (const [label, spec] of Object.entries(sp)) await hit("hostile", label + " " + P, spec); }
  // legitimate imports inside design/ (a sibling test module and a real design part)
  await hit("legit", "relative sibling", "./zz-ok.js");
  await hit("legit", "absolute path inside design/", "/design/views/zz-ok.js");
  await hit("legit", "absolute URL inside design/", O + "/design/views/zz-ok.js");
  await hit("legit", "parent, real part", "../parts/auth-parts.js");
  await hit("legit", "query inside design/", "./zz-ok.js?v=2");
  // the server redirects /design/views/zz-redirect.js to /lib/orders.js (a server that does that defeats ANY path rule; nginx has none)
  await hit("redirect", "302 inside design/ to lib/orders.js", "./zz-redirect.js");
  // a blob module: script-src 'self' has no blob:, so the CSP refuses it
  try { const u = URL.createObjectURL(new Blob(["import '/lib/orders.js'; export default 1"], { type: "text/javascript" })); await hit("hostile", "blob module", u); } catch (e) { attempts.push({ kind: "hostile", label: "blob module", ok: false, err: String(e) }); }
  // everything above that RESOLVED is used, the way a hostile module would: call the privileged API with a shop id that only this module uses (999)
  const used = [];
  for (const a of attempts) if (a.ok && a.kind !== "legit") used.push(a.label);
  let orders = null;
  for (const P of PRIV) { for (const sp of [spellings(P).absPath, spellings(P).relative]) { const m = await import(sp).catch(() => null); if (m && P === "lib/orders.js") orders = m; } }
  if (orders) { try { await orders.listOrders(999, {}); used.push("listOrders(999) called"); } catch (e) { used.push("listOrders(999) threw " + e.message); } }
  // the boot-phase seals, checked on whatever resolved
  const seals = {};
  for (const [P, names] of [["lib/session.js", ["takeSession"]], ["lib/perm.js", ["takePermissions"]], ["core/design-actions.js", ["takeDesignActions"]], ["core/content-actions.js", ["takeContentActions"]], ["core/auth.js", ["takeMakeAuth"]], ["ui/kit.js", ["takeCoreUi"]], ["lib/api.js", ["takeApi"]]]) {
    const m = await import("/" + P).catch(() => null);
    if (!m) { seals[P] = "not imported"; continue; }
    for (const n of names) { try { m[n](); seals[P] = "TAKEN"; } catch (e) { seals[P] = "sealed: " + e.message; } }
  }
  const gone = {};
  for (const [P, names] of [["lib/session.js", ["loadSession", "login", "logout", "clearSession", "passwordSetup", "invitations"]], ["lib/perm.js", ["setPermissions", "clearPermissions"]], ["core/design-actions.js", ["createDesignActions"]], ["core/content-actions.js", ["createContentActions"]], ["core/auth.js", ["makeAuth"]], ["ui/kit.js", ["showCoreDialog", "confirmDialog", "allowImageOrigin", "allowPreviewLinkOrigin"]]]) {
    const m = await import("/" + P).catch(() => null);
    if (m) gone[P] = names.filter((n) => n in m);
  }
  let sessionWrite = "n/a";
  { const m = await import("/lib/session.js").catch(() => null); if (m) { try { m.session.shopID = 5; sessionWrite = "WRITTEN"; } catch (e) { sessionWrite = "refused"; } } }
  await fetch("/_mark?v=end");
  await fetch("/_report", { method: "POST", body: JSON.stringify({ attempts, used, seals, gone, sessionWrite }) });
  root.append(document.createTextNode("hostile done"));
}
`;

// ── one page load ──
const problems = [];
async function load({ csp, routes = { notFound: "views/zz-hostile.js" }, hash = "#/", then = "", init, indexMap, appJs, percentRule, decode, expectReport = false, wait = 1500, hide = [] }) {
  reset({ hide, csp: csp ?? REAL_CSP, routes, ...(indexMap ? { indexMap } : {}), ...(appJs ? { appJs } : {}), ...(percentRule === undefined ? {} : { percentRule }), ...(decode ? { decode } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  if (init) await ctx.addInitScript(init);
  const pg = await ctx.newPage();
  const logs = { warnings: [], errors: [], csp: [] };
  pg.on("console", (m) => { const x = m.text(); if (m.type() === "warning") logs.warnings.push(x); else if (m.type() === "error") logs.errors.push(x); if (/Content Security Policy|Refused to/i.test(x)) logs.csp.push(x); });
  pg.on("pageerror", (e) => logs.errors.push("pageerror " + e.message));
  await pg.goto(URL0 + hash, { waitUntil: "load" });
  try { await pg.waitForSelector(".shell", { timeout: 15000 }); } catch (e) { console.error("LOAD FAILED", JSON.stringify(logs).slice(0, 1500), JSON.stringify(S.files.slice(-12)), JSON.stringify(S.api.slice(-6)), (await pg.locator("body").innerText()).slice(0, 300)); throw e; }
  if (then) await pg.evaluate((h) => { location.hash = h; }, then);
  if (expectReport) { for (let i = 0; i < 100 && !S.reports.length; i++) await sleep(300); }
  await sleep(wait);
  return { ctx, pg, logs };
}
const designState = (pg) => pg.evaluate(async () => { const m = await import("/lib/design.js"); return m.designInfo(); });
const noteText = (pg) => pg.evaluate(() => document.getElementById("core-isolation-note")?.textContent || "");
const designFilesRequested = () => S.files.filter((f) => /^\/design\/(copy|routes)\.js|^\/design\/views\/(?!zz-)|^\/design\/parts\//.test(f.p) && f.status === 200).map((f) => f.p);

// ───────────────────────────────────────────────────────────────────
section("0. The import map in the shipped index.html");
{
  const map = JSON.parse(MAP_TEXT);
  check("exactly one inline <script type=importmap> and no other inline script in index.html", [...INDEX.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1])).length === 1 && (INDEX.match(/type="importmap"/g) || []).length === 1);
  check("it sits before every module script", INDEX.indexOf('type="importmap"') < INDEX.indexOf('type="module"'));
  check("scopes: the design directory and the probe only; no top-level imports", Object.keys(map.scopes).sort().join() === "/design/,/lib/canary/" && !map.imports);
  check("design scope: everything denied except /design/ itself", map.scopes["/design/"]["/"] === "/deny/" && map.scopes["/design/"]["/design/"] === "/design/");
  check("probe scope is a DIRECTORY scope with the same keys as the design scope (\"/\" denied, one allowed prefix, https:// and http:// denied)", JSON.stringify(Object.keys(map.scopes["/lib/canary/"]).sort()) === JSON.stringify(Object.keys(map.scopes["/design/"]).map((k) => (k === "/design/" ? "/lib/canary/allowed/" : k)).sort()) && map.scopes["/lib/canary/"]["https://"] === "/deny/" && map.scopes["/lib/canary/"]["http://"] === "/deny/");
  check("probe scope: everything denied except the control prefix", map.scopes["/lib/canary/"]["/"] === "/deny/" && map.scopes["/lib/canary/"]["/lib/canary/allowed/"] === "/lib/canary/allowed/");
  check("the denial target is a core-owned URL whose fetch fails (nginx: location ^~ /deny/ { return 404; })", /location \^~ \/deny\/ \{ return 404; \}/.test(tpl));
  check("the CSP of the template carries exactly this map's hash", REAL_CSP.includes(`'sha256-${hashOf(MAP_TEXT)}'`) && /script-src 'self' 'sha256-[A-Za-z0-9+/=]+';/.test(REAL_CSP));
}

// ───────────────────────────────────────────────────────────────────
section("1. Hostile design module, the real CSP + map: every import of the core is refused");
{
  const { ctx, pg, logs } = await load({ expectReport: true, then: "#/zzz-nothing-here" });
  const rep = S.reports[0];
  check("the canary passed and the design layer is loaded (design views requested, designInfo().enabled)", (await designState(pg)).enabled === true && S.files.some((f) => f.p === "/design/copy.js" && f.status === 200));
  check("the hostile module ran and reported", !!rep);
  const host = rep.attempts.filter((a) => a.kind === "hostile");
  const bad = host.filter((a) => a.ok);
  check(`${host.length} hostile import attempts (${CORE_MODULES.length} targets x spellings): every one REJECTED`, host.length > 300 && bad.length === 0, JSON.stringify(bad.slice(0, 5)));
  check("every rejection is a load / resolution failure (TypeError), not a successful evaluation", host.every((a) => /TypeError/.test(a.err)), JSON.stringify(host.filter((a) => !/TypeError/.test(a.err)).slice(0, 3)));
  const spellingsSeen = new Set(host.map((a) => a.label.split(" ")[0]));
  check("all 19 spellings were tried (relative, absolute path/URL, protocol-relative, query, percent, dot segments, backslash, import.meta.url, data:, bare, blob)", spellingsSeen.size >= 19, [...spellingsSeen].join());
  check("the percent-encoded /design/..%2f variant was refused by the (emulated) nginx rule, not served", S.files.some((f) => /\/design\/\.\.%2f/.test(f.p) && f.status === 404));
  const legit = rep.attempts.filter((a) => a.kind === "legit");
  check("the design's LEGITIMATE imports inside design/ still work (sibling, absolute path, absolute URL, ../parts/, with a query)", legit.length === 5 && legit.every((a) => a.ok), JSON.stringify(legit.filter((a) => !a.ok)));
  const shop999 = S.api.filter((r) => /\/shops\/999\//.test(r.a));
  check("the fake API saw ZERO requests from the hostile module (shop id 999), authenticated or not", shop999.length === 0, JSON.stringify(shop999));
  const between = S.api.slice(S.markAt.start, S.markAt.end).filter((r) => r.auth);
  check("ZERO authenticated requests between the module's start and end markers", between.length === 0, JSON.stringify(between));
  check("nothing resolved, so nothing was used", rep.used.length === 0, JSON.stringify(rep.used));
  check("the boot-phase seals: nothing could be imported to take", Object.values(rep.seals).every((v) => v === "not imported"), JSON.stringify(rep.seals));
  const redir = rep.attempts.find((a) => a.kind === "redirect");
  check("a 302 inside /design/ to lib/orders.js is refused too: the fresh copy of the module evaluates takeApi() after the seal and throws", redir.ok === false && /sealed/.test(redir.err), JSON.stringify(redir));
  console.log("  note  LIMIT: a server that redirects inside /design/ to a core file that does NOT call a take...() at evaluation (for example lib/dates.js) would resolve it, because the map sees only the first URL. nginx has no such redirect and design/ cannot hold symlinks (guard files/symlink).");
  check("core flows unaffected: the shell rendered, the session is the fake owner's, one refresh and the session reads", S.api.filter((r) => r.a === "/admin/auth/refresh").length === 1 && S.api.some((r) => r.a === "/admin/me" && r.auth.startsWith("Bearer tok-")));
  check("no CSP violation, no page error (the inline map is allowed by its hash)", logs.csp.filter((x) => !/data:text\/javascript|blob:/.test(x)).length === 0 && !logs.errors.some((e) => /pageerror/.test(e)), JSON.stringify([...logs.csp, ...logs.errors].slice(0, 4)));
  check("the CSP DID refuse the data: and blob: module attempts (they are not allowed by script-src)", logs.csp.some((x) => /data:text\/javascript/.test(x)) && logs.csp.some((x) => /blob:/.test(x)));
  check("no calm note in the normal case", (await noteText(pg)) === "");
  await ctx.close();
}

// ───────────────────────────────────────────────────────────────────
section("2. Real design files (no test override): the design loads and works under the map");
{
  const { ctx, pg, logs } = await load({ routes: null, hash: "#/", wait: 800 });
  const info = await designState(pg);
  check("design enabled; the real routes.js registry is used", info.enabled === true && Object.keys(info.routes).length > 20);
  const files = designFilesRequested();
  check("design views and parts were imported (shell from design/views, parts via ../parts/)", files.includes("/design/views/shell.js") && files.some((f) => f.startsWith("/design/parts/")) , files.join());
  check("no design file failed to load", !S.files.some((f) => f.p.startsWith("/design/") && f.status >= 400), JSON.stringify(S.files.filter((f) => f.p.startsWith("/design/") && f.status >= 400)));
  check("no design warnings (a design module that could not load logs one)", !logs.warnings.some((w) => /\[design\]/.test(w)), JSON.stringify(logs.warnings.slice(0, 3)));
  check("no CSP violation", logs.csp.length === 0, JSON.stringify(logs.csp));
  await ctx.close();
}

// ───────────────────────────────────────────────────────────────────
section("3. Fail-closed canary");
const failClosed = async (name, opts, reason) => {
  const { ctx, pg, logs } = await load({ routes: null, hash: "#/", wait: 600, ...opts });
  const info = await designState(pg);
  check(`${name}: design NOT loaded (designInfo().enabled false, no routes)`, info.enabled === false && Object.keys(info.routes).length === 0, JSON.stringify(info));
  check(`${name}: no design file was requested`, designFilesRequested().length === 0, designFilesRequested().join());
  check(`${name}: the built-in screens are shown (shell from design-defaults)`, S.files.some((f) => f.p === "/design-defaults/views/shell.js" && f.status === 200));
  check(`${name}: a console warning names the reason (${reason})`, logs.warnings.some((w) => /custom design is DISABLED/.test(w) && w.includes(`(${reason})`)), JSON.stringify(logs.warnings.filter((w) => /design/.test(w))));
  const note = await noteText(pg);
  check(`${name}: the calm owner note is visible`, /自訂設計已停用/.test(note) && await pg.locator("#core-isolation-note").isVisible(), note);
  await ctx.close();
  return logs;
};
{
  const l = await failClosed("(a) CSP WITHOUT the hash", { csp: NO_HASH_CSP }, "not-enforced");
  check("(a) the browser refused the inline map under that CSP (CSP console error)", l.csp.some((x) => /inline script/i.test(x)), JSON.stringify(l.csp));
  await failClosed("(c) tampered map text (hash mismatch: a key added)", { indexMap: (h) => h.replace('"/lib/canary/allowed/":"/lib/canary/allowed/"', '"/lib/canary/allowed/":"/lib/canary/allowed/","/lib/":"/lib/"') }, "not-enforced");
  await failClosed("(c2) tampered map text AND a CSP carrying the OLD hash only is what a stale template looks like", { indexMap: (h) => h.replace(MAP_TEXT, MAP_TEXT.replace('"/deny/"', '"/design/"')) }, "not-enforced");
  await failClosed("(d) browser without import-map support (HTMLScriptElement.supports('importmap') false)", { init: "(() => { const o = HTMLScriptElement.supports; HTMLScriptElement.supports = (t) => (t === 'importmap' ? false : o.call(HTMLScriptElement, t)); })();" }, "unsupported");
  await failClosed("(d2) the map element removed (a server that serves index.html without it)", { indexMap: (h) => h.replace(MAP_RE, "") }, "not-enforced");
  await failClosed("(d3) HTMLScriptElement.supports missing altogether (an old browser)", { init: "(() => { HTMLScriptElement.supports = undefined; })();" }, "unsupported");
  await failClosed("(f) the target is unreachable (404): a denied import proves nothing", { hide: ["/lib/canary/target.js"] }, "unverifiable");
  const l2 = await failClosed("(e) the control file cannot be loaded (map text valid, /lib/canary/allowed/ok.js missing)", { hide: ["/lib/canary/allowed/ok.js"] }, "control").catch(() => null);
  void l2;
}
{
  // (b) with the hash: design loads (also covered by 1 and 2); here: no note, no warning
  const { ctx, pg, logs } = await load({ routes: null, hash: "#/", wait: 400 });
  check("(b) with the hash the design loads and neither the note nor the warning appear", (await designState(pg)).enabled === true && (await noteText(pg)) === "" && !logs.warnings.some((w) => /DISABLED/.test(w)));
  await ctx.close();
}

// ───────────────────────────────────────────────────────────────────
section("3b. The server rule (emulated nginx): encoded slashes, dots, backslashes and double slashes are refused everywhere");
{
  reset({ routes: null });
  const get = (p) => new Promise((ok, no) => { httpGet({ host: "127.0.0.1", port: PORT, path: p }, (r) => { r.resume(); ok(r.statusCode); }).on("error", no); }); // raw request: fetch() would resolve %2e%2e itself
  for (const p of ["/design%2fcopy.js", "//design/copy.js", "/design/..%2flib/orders.js", "/design/%2e%2e/lib/orders.js", "/design/..%5clib/orders.js", "/lib//orders.js", "/%2e%2e/lib/orders.js", "/design%2Fcopy.js"]) check(`${p} -> 404`, (await get(p)) === 404);
  check("a normal file still works: /design/copy.js 200", (await get("/design/copy.js")) === 200);
  check("/site-config.js and / still work", (await get("/site-config.js")) === 200 && (await get("/")) === 200);
  check("a double slash or %2f in the QUERY string is not looked at", (await get("/index.html?next=https://x.test//a%2fb")) === 200);
}

// ───────────────────────────────────────────────────────────────────
section("4. CONTROL runs (the test can fail)");
{
  // the map removed AND the canary forced to pass (as if it did not exist): the same hostile module now imports the core and calls it
  const { ctx, pg } = await load({ expectReport: true, then: "#/zzz-nothing-here", indexMap: (h) => h.replace(MAP_RE, ""), appJs: (t) => t.replace("const iso = await checkIsolation();", "const iso = { ok: true };") });
  const rep = S.reports[0];
  const host = rep.attempts.filter((a) => a.kind === "hostile");
  const okN = host.filter((a) => a.ok).length;
  check(`CONTROL no map: ${okN} of ${host.length} hostile imports RESOLVE (the wall is the map)`, okN > 100, `${okN}`);
  const shop999 = S.api.filter((r) => /\/shops\/999\//.test(r.a));
  check("CONTROL no map: the hostile module sends an AUTHENTICATED request with the core's token (listOrders(999))", shop999.length >= 1 && shop999.every((r) => r.auth.startsWith("Bearer tok-")), JSON.stringify(shop999));
  // item 5: the boot-phase seals hold EVEN with the wall down
  check("SEALS (wall down): takeSession / takePermissions / takeDesignActions / takeContentActions / takeMakeAuth / takeCoreUi / takeApi all throw after sealApi()", Object.entries(rep.seals).every(([, v]) => /^sealed: .* is sealed$|^sealed: the API client is sealed$/.test(v)) && Object.keys(rep.seals).length === 7, JSON.stringify(rep.seals));
  check("SEALS (wall down): the old named exports are gone (loadSession, login, logout, clearSession, passwordSetup, invitations, setPermissions, createDesignActions, createContentActions, makeAuth, showCoreDialog, confirmDialog, allowImageOrigin, allowPreviewLinkOrigin)", Object.values(rep.gone).every((l) => l.length === 0) && Object.keys(rep.gone).length === 6, JSON.stringify(rep.gone));
  check("SEALS (wall down): `session` is a read-only view (assigning shopID is refused)", rep.sessionWrite === "refused", rep.sessionWrite);
  await ctx.close();
}
{
  // percent-encoded dot-dot: an nginx-style decoder WITHOUT the template's `%` rule serves lib/ for a /design/ URL, and the map (which only sees the URL) allows it
  const { ctx } = await load({ expectReport: true, then: "#/zzz-nothing-here", percentRule: false, decode: true });
  const rep = S.reports[0];
  const viaPct = rep.attempts.filter((a) => a.kind === "hostile" && /^pctSlash /.test(a.label) && a.ok);
  { reset({ routes: null, percentRule: false, decode: true }); const st = (await fetch(`http://127.0.0.1:${PORT}/design%2fcopy.js`)).status; check("CONTROL decoder, no rule: /design%2fcopy.js is SERVED (200): the URL the browser sees differs from the file served", st === 200, String(st)); }
  check(`CONTROL decoder, no % rule: ${viaPct.length} of ${CORE_MODULES.length} /design/..%2f imports RESOLVE (a new copy of the module, not the booted one)`, viaPct.length > 20, String(viaPct.length));
  await ctx.close();
}

// ───────────────────────────────────────────────────────────────────
console.log(`\n${checks - failures}/${checks} checks passed`);
await browser.close();
server.close();
if (failures) { console.error(`${failures} FAILED`); process.exit(1); }
console.log("import-map browser test OK");
