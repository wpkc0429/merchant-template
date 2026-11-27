#!/usr/bin/env node
// Offline tests of the personal profile (D21): the validation table (a mirror of the platform's CleanDisplayName), the sealed API capability,
// the controller with a mock API (load, save, clear, 422 and network failures, nothing sent from a preview host), the hint state, the route and
// the navigation item, and that the design layer gained nothing (ctx, public-api.json, route ids). Run: node scripts/test-profile.mjs
// (scripts/test-guard.mjs runs it too). It runs itself twice: as a normal page and as a PREVIEW host (PF_MODE=preview).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { signIn } from "./lib/test-signin.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.env.PF_MODE || "";
const g = globalThis;
if (!MODE) {
  let bad = 0;
  for (const m of ["normal", "preview"]) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, PF_MODE: m }, encoding: "utf8" });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    if (r.status !== 0) bad++;
  }
  process.exit(bad ? 1 : 0);
}
const PREVIEW = MODE === "preview";
const store = new Map();
g.window = { ADMIN_CONFIG: PREVIEW ? { preview: { kind: "version", tag: "design-2026-11-01", expiresAt: "2999-01-01T00:00:00Z" } } : {}, scrollTo() {}, addEventListener() {}, open: () => null };
g.location = { hostname: "localhost", origin: "http://localhost:3001", hash: "", href: "http://localhost:3001/", reload() {} };
g.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
g.document = { createElement: () => ({ setAttribute() {}, style: { setProperty() {} } }), createComment: () => ({}), body: {}, head: {}, documentElement: {}, getElementById: () => null };
g.history = { replaceState() {} };
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.error(`  FAIL [${MODE}] ${name} ${extra}`); } };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const cc = (...codes) => String.fromCharCode(...codes);

const calls = [];
let reply = () => ({ status: 200, body: {} });
g.fetch = async (url, init = {}) => {
  const m = init.method || "GET";
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: m, url: String(url), body });
  const r = reply(m, String(url), body);
  if (r instanceof Error) throw r;
  return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { "content-type": "application/json" } });
};
const logs = [];
for (const k of ["log", "warn", "error", "info", "debug"]) { const o = console[k]; console[k] = (...a) => { logs.push(a.map(String).join(" ")); if (k === "error") o(...a); }; }

const net = (await imp("lib/api.js")).takeApi();
const lib = await imp("lib/profile.js");
const core = await imp("core/profile.js");
const { setPermissions } = (await imp("lib/perm.js")).takePermissions();
const { ApiError } = await imp("lib/api.js");
const { NAV, ROUTES } = await imp("core/routes.js");
const { ROUTE_IDS, validateRoutes } = await imp("lib/design-schema.js");
const { loadDesign, t } = await imp("lib/design.js");
const { coreText, FIXED_COPY } = await imp("lib/fixed-text.js");
const { makeContext } = await imp("core/context.js");
await loadDesign();
await signIn(net, "secret-access-token-123");
const { saveName } = lib.takeProfileApi();

// ── the validation table (the platform's rules: design.CleanDisplayName) ──
const bidi = cc(0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f, 0x61c);
const table = [
  ["plain name", "Sam Lee", true, "Sam Lee"],
  ["Chinese name", "王小明", true, "王小明"],
  ["trimmed", "  Sam  ", true, "Sam"],
  ["ideographic space trimmed", cc(0x3000) + "Sam" + cc(0x3000), true, "Sam"],
  ["empty clears", "", true, ""],
  ["only spaces clears", "   ", true, ""],
  ["null clears", null, true, ""],
  ["undefined clears", undefined, true, ""],
  ["exactly 80", "a".repeat(80), true, "a".repeat(80)],
  ["81 is too long", "a".repeat(81), false, "too_long"],
  ["80 emoji (code points, not UTF-16 units)", "😀".repeat(80), true, "😀".repeat(80)],
  ["81 emoji", "😀".repeat(81), false, "too_long"],
  ["81 only before trimming counts 80", " " + "a".repeat(80) + " ", true, "a".repeat(80)],
  ["newline inside", "Sam\nLee", false, "multiline"],
  ["CRLF inside (CR is dropped, LF stays)", "Sam\r\nLee", false, "multiline"],
  ["tab inside", "Sam\tLee", false, "multiline"],
  ["trailing newline is trimmed", "Sam\n", true, "Sam"],
  ["CR alone is dropped", "Sam\rLee", true, "SamLee"],
  ["control characters are dropped", "Sa" + cc(0) + "m" + cc(7) + " L" + cc(0x7f) + "ee" + cc(0x9f), true, "Sam Lee"],
  ["bidi and direction marks are dropped", "S" + bidi + "am", true, "Sam"],
  ["zero width space is kept (the platform keeps it)", "Sa" + cc(0x200b) + "m", true, "Sa" + cc(0x200b) + "m"],
  ["email", "sam@example.com", false, "email"],
  ["email inside text", "Sam (sam.lee+x@shop.example.co)", false, "email"],
  ["not an email: no dot in the domain", "sam@home", true, "sam@home"],
  ["mobile number", "0912345678", false, "phone"],
  ["mobile with dashes", "0912-345-678", false, "phone"],
  ["mobile with spaces", "0912 345 678", false, "phone"],
  ["+886 mobile", "+886912345678", false, "phone"],
  ["886 mobile", "886912345678", false, "phone"],
  ["phone inside text", "call 0912345678 now", false, "phone"],
  ["a landline is not flagged by the platform", "02-2345-6789", true, "02-2345-6789"],
  ["card-like (Luhn ok, 16 digits)", "4242424242424242", false, "card_like"],
  ["card-like with spaces", "4242 4242 4242 4242", false, "card_like"],
  ["card-like with dashes", "4242-4242-4242-4242", false, "card_like"],
  ["13 digits Luhn ok", "4222222222222", false, "card_like"],
  ["16 digits failing Luhn is allowed", "4242424242424241", true, "4242424242424241"],
  ["12 digits is allowed", "424242424242", true, "424242424242"],
  ["short numbers are allowed", "Store 12", true, "Store 12"],
  ["a mobile number next to a card number", "0987654321 4242424242424242", false, "phone"],
  ["too long wins over email (the platform's order)", "a".repeat(80) + "@x.com", false, "too_long"],
  ["a non-string is refused", 12345, false, "type"],
  ["an object is refused", { a: 1 }, false, "type"],
];
for (const [name, input, good, expect] of table) {
  const r = lib.validateDisplayName(input);
  ok(`validate: ${name}`, r.ok === good && (good ? r.value === expect : r.code === expect), JSON.stringify(r));
}
ok("NAME_MAX is 80", lib.NAME_MAX === 80);
ok("piiFlags names every class once, in order", JSON.stringify(lib.piiFlags("a@b.co 0912345678 4242424242424242")) === JSON.stringify(["email", "phone", "card_like"]));
ok("every validation failure has a calm core message (no key leaks)", ["too_long", "multiline", "email", "phone", "card_like", "type"].every((c) => { const m = core.validationMessage({ code: c, length: 90 }); return m && !m.startsWith("pf.") && !/\{/.test(m); }));

// ── the controller with a mock API ──
setPermissions(["order.view"]); // staff: no design.view; the profile needs nothing
const ctl = core.controller(() => true);
ok("controller: readOnly follows the preview mode", ctl.readOnly === PREVIEW);
calls.length = 0;
reply = () => ({ body: { id: 3, email: "x@example.com", display_name: "Sam", sids: [1], platform_permissions: [] } });
ok("load: returns the stored name and asks GET /admin/me only", (await ctl.load()) === "Sam" && calls.length === 1 && calls[0].method === "GET" && calls[0].url.endsWith("/api/v1/admin/me"));
ok("load: the name is now known (no hint)", lib.hasDisplayName() && !lib.lacksDisplayName());
reply = () => ({ body: { id: 3, email: "x@example.com", display_name: null } });
ok("load: null means no name", (await ctl.load()) === "" && lib.lacksDisplayName());
reply = () => ({ body: { id: 3, email: "x@example.com" } });
await ctl.load();
ok("load: a platform without the field leaves it unknown (no hint)", !lib.lacksDisplayName() && !lib.hasDisplayName());

calls.length = 0;
reply = (m, u, b) => ({ body: { id: 3, display_name: b.display_name === "" ? null : b.display_name } });
if (PREVIEW) {
  const e = await rejects(() => ctl.save("Sam"));
  ok("preview: save is refused and NOTHING is sent", e && e.isActionError && e.reason === "read_only" && calls.length === 0);
  const e2 = await rejects(() => saveName("Sam"));
  ok("preview: even the raw API call is refused by the client", e2 instanceof ApiError && e2.status === 403 && calls.length === 0);
} else {
  ok("save: PATCH /admin/me with the cleaned value only", (await ctl.save("  Sam Lee ")) === "Sam Lee" && calls.length === 1 && calls[0].method === "PATCH" && calls[0].url.endsWith("/api/v1/admin/me") && JSON.stringify(calls[0].body) === '{"display_name":"Sam Lee"}');
  ok("save: the hint state follows", lib.hasDisplayName());
  calls.length = 0;
  ok("clear: sends an empty string and the name is gone", (await ctl.save("")) === "" && calls[0].body.display_name === "" && lib.lacksDisplayName());
  calls.length = 0;
  for (const bad of ["a@b.co", "0912345678", "x\ny", "a".repeat(81)]) { const e = await rejects(() => ctl.save(bad)); ok(`save: ${JSON.stringify(bad.slice(0, 12))} refused before any request`, e && e.isActionError && e.reason === "invalid" && calls.length === 0); }
  const cases = [
    [() => ({ status: 422, body: { error: { code: "validation_failed", message: "RAW display_name sam@example.com" } } }), "invalid", "pf.err.rejected"],
    [() => ({ status: 500, body: { error: { code: "boom", message: "RAW" } } }), "server_error", "pf.err.server"],
    [() => ({ status: 503, body: { error: { code: "x", message: "RAW" } } }), "server_error", "pf.err.server"],
    [() => ({ status: 403, body: { error: { code: "forbidden", message: "RAW" } } }), "denied", null],
    [() => ({ status: 403, body: { error: { code: "preview_read_only", message: "RAW" } } }), "denied", "pv.readOnly"],
    [() => ({ status: 418, body: { error: { message: "RAW" } } }), "error", "pf.err.generic"],
    [() => new TypeError("Failed to fetch RAW"), "network", "pf.err.network"],
  ];
  for (const [r, reason, key] of cases) {
    reply = r; calls.length = 0;
    const e = await rejects(() => ctl.save("Sam"));
    ok(`save failure ${reason}${key ? " " + key : ""}: an ActionError with fixed wording`, e && e.isActionError && e.reason === reason && !/RAW/.test(e.message) && (!key || e.message === coreText(key)), e && e.message);
  }
  reply = () => ({ status: 500, body: {} });
  const el = await rejects(() => ctl.load());
  ok("load failure: calm wording, no raw text", el && el.isActionError && el.message === coreText("pf.err.load"));
}

// ── privacy: nothing about the name in logs or storage ──
ok("no console output carries a name or an address", !logs.some((l) => /Sam|example\.com|0912/.test(l)), logs.join("|"));
lib.dismissHint();
ok("the hint dismissal stores a bare marker, nothing else", [...store.entries()].filter(([k]) => /hint/.test(k)).every(([, v]) => v === "1") && [...store.values()].every((v) => !/Sam|@|0912/.test(v)));
ok("hintDismissed is true after dismissHint", lib.hintDismissed());
lib.clearProfile();
ok("clearProfile forgets name, knowledge and the dismissal", !lib.hasDisplayName() && !lib.lacksDisplayName() && !lib.hintDismissed() && ![...store.keys()].some((k) => /hint/.test(k)));
lib.noteDisplayName(undefined);
ok("noteDisplayName(undefined) is unknown", !lib.lacksDisplayName());
const keep = g.sessionStorage;
g.sessionStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
lib.dismissHint();
ok("blocked storage: the dismissal still holds in memory and nothing throws", lib.hintDismissed());
lib.clearProfile();
g.sessionStorage = keep;

// ── the design layer gained nothing ──
const ctx = makeContext({ routeId: "home" });
const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) ? [`${p}${k}`, ...flat(v, `${p}${k}.`)] : [`${p}${k}`]));
ok("ctx has nothing about the profile or the display name", !flat(ctx).some((k) => /profile|displayName|display_name/i.test(k)));
ok("public-api.json mentions no profile function", !/profile|displayName|display_name/i.test(readFileSync(path.join(ROOT, "lib/public-api.json"), "utf8")));
ok("route 'profile' exists for EVERY role (no permission) and is core-owned", (() => { const r = ROUTES.find((x) => x.id === "profile"); return r && r.pattern === "/profile" && r.perm.length === 0 && r.core === true && r.nav === "profile" && !r.public; })());
ok("'profile' is not a route id the design layer can map", !ROUTE_IDS.includes("profile") && validateRoutes({ profile: "views/profile.js" }).warnings.length === 1 && !("profile" in validateRoutes({ profile: "views/profile.js" }).routes));
ok("the nav item is listed for a person with no permission at all, and is last", NAV.filter((n) => n.perm.length === 0).some((n) => n.key === "profile") && NAV[NAV.length - 1].key === "profile");
ok("the nav label is FIXED core copy (a design copy cannot change it)", FIXED_COPY["nav.profile"] === "個人資料" && t("nav.profile") === "個人資料");
ok("no pf.* copy keys exist: the page wording is core text only", !("pf.title" in (await imp("design-defaults/copy.js")).default) && !("pf.title" in (await imp("design/copy.js")).default));

// ── sealing: nothing is reachable after the boot phase (last, it closes the capabilities) ──
ok("lib/profile.js does not export the API functions by name", !("loadMe" in lib) && !("saveName" in lib) && typeof lib.takeProfileApi === "function");
(await imp("lib/boot.js")).sealBoot();
ok("takeProfileApi throws after the seal", (() => { try { lib.takeProfileApi(); return false; } catch { return true; } })());

process.stdout.write(`test-profile [${MODE}]: ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
