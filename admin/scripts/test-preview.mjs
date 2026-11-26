#!/usr/bin/env node
// Offline tests of the version preview core and preview-mode read-only enforcement (no network, no browser, no dependencies).
// Run: node scripts/test-preview.mjs   (scripts/test-guard.mjs runs it too). It runs itself three times: as a normal page, and as a
// PREVIEW host (VP_MODE=version / change, which sets window.ADMIN_CONFIG.preview before the core loads, like deploy/preview-config.js does).
//   normal:  ctx.actions.requestVersionPreview / ctx.data.getVersionPreview check design.view inside the core, validate ids before
//            any request, map 409 (revert_below_core_floor, already_current, ...) and 429 (hourly/daily cap, Retry-After) to
//            ActionError, hand out no token / shop id, give `origin` only when the platform sent a plain one, expire by the clock;
//            the fixed limits text cannot be changed by copy; the core banner is rebuilt when removed, reworded or hidden.
//   preview: EVERY ctx.actions function throws ActionError reason "read_only" before any permission check, dialog or request;
//            lib/api.js refuses non-GET requests; reads still work; the banner is installed.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.env.VP_MODE || "";
const g = globalThis;

if (!MODE) {
  let bad = 0;
  for (const m of ["normal", "version", "change"]) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, VP_MODE: m }, encoding: "utf8" });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    if (r.status !== 0) bad++;
  }
  process.exit(bad ? 1 : 0);
}
const PREVIEW = MODE === "normal" ? "" : MODE;

// ── browser stubs ──
const store = new Map();
g.window = { ADMIN_CONFIG: PREVIEW ? { preview: { kind: PREVIEW, tag: "design-2026-11-01", expiresAt: "2999-01-01T00:00:00Z" } } : {}, scrollTo() {}, addEventListener() {}, open: () => null };
g.location = { hostname: "localhost", origin: "http://localhost:3001", hash: "", href: "http://localhost:3001/", reload() {} };
g.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
class FakeEl {
  constructor(tag) {
    this.tag = tag; this.attrs = new Map(); this.parentNode = null; this.children = []; this.textContent = ""; this.props = new Map();
    const self = this;
    this.style = {
      setProperty(k, v, p) { self.props.set(k, [v, p || ""]); },
      getPropertyValue: (k) => (self.props.get(k) || [""])[0],
      getPropertyPriority: (k) => (self.props.get(k) || ["", ""])[1],
    };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  replaceChildren(...c) { this.children = c; }
}
const body = new FakeEl("body");
body.prepend = (el) => { el.parentNode = body; body.children.unshift(el); };
body.removeChild = (el) => { body.children = body.children.filter((c) => c !== el); el.parentNode = null; };
const app = new FakeEl("div");
g.document = { createElement: (t) => new FakeEl(t), createComment: () => ({}), body, head: {}, documentElement: {}, getElementById: (id) => (id === "app" ? app : null) };
g.history = { replaceState() {} };
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.error(`  FAIL [${MODE}] ${name} ${extra}`); } };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const calls = [];
let routes = [];
g.fetch = async (url, init = {}) => {
  const u = String(url);
  const rec = { method: init.method || "GET", url: u, body: init.body };
  calls.push(rec);
  const r = routes.find((x) => x.method === rec.method && u.includes(x.match));
  if (!r) return new Response(JSON.stringify({ error: { code: "not_found", message: "no stub" } }), { status: 404, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { "content-type": "application/json", ...(r.headers || {}) } });
};
const on = (method, match, reply) => routes.unshift({ method, match, ...reply });
const reset = () => { calls.length = 0; routes = []; };

const { tokens, ApiError } = await imp("lib/api.js");
const { session } = await imp("lib/session.js");
const { setPermissions } = await imp("lib/perm.js");
const { loadDesign, t } = await imp("lib/design.js");
const { actions } = await imp("core/actions.js");
const { data } = await imp("core/data.js");
const { makeContext } = await imp("core/context.js");
const { previewMode, isReadOnly } = await imp("lib/preview.js");
const { FIXED_COPY } = await imp("lib/fixed-text.js");
const { ActionError } = await imp("core/errors.js");
const banner = await imp("ui/preview-banner.js");
const defaults = (await imp("design-defaults/copy.js")).default;
await loadDesign();
tokens.set({ access_token: "test-token" });
session.shopID = 7;
const RID = "11111111-2222-4333-8444-555555555555";
const PID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const apiPreview = (o = {}) => ({ id: PID, site: "admin", target_request_id: RID, target_tag: "design-2026-10-01", status: "queued", failure_code: null, failure_detail: null, failure_rule_ids: [], core_version: "0.4.0", design_floor_version: "0.3.0", created_at: "2026-11-26T10:00:00Z", ready_at: null, expires_at: "2999-01-01T00:00:00Z", read_only: true, ...o });
const perms = { staff: ["order.view"], editor: ["design.view"], owner: ["design.view", "design.revert"] };
const as = (who) => setPermissions(perms[who]);

// ── mode ──
ok("preview mode matches the host config", PREVIEW ? (isReadOnly() && previewMode.kind === PREVIEW && previewMode.tag === "design-2026-11-01") : (!isReadOnly() && previewMode === null));
ok("fixed limits text: built-in copy equals the fixed text, t() answers it from the core", defaults["vp.limits"] === FIXED_COPY["vp.limits"] && t("vp.limits") === FIXED_COPY["vp.limits"]);
{
  const copySrc = (await import("node:fs")).readFileSync(path.join(ROOT, "design/copy.js"), "utf8");
  ok("design/copy.js does not mention vp.limits", !copySrc.includes("vp.limits"));
  const warns = []; const w0 = console.warn; console.warn = (...a) => warns.push(a.join(" ")); await loadDesign(); console.warn = w0;
  ok("loading the default design prints no console warning", warns.length === 0, warns.join(" | "));
}
{
  const ctx = makeContext({ routeId: "home" });
  ok("ctx exposes the two new functions", typeof ctx.actions.requestVersionPreview === "function" && typeof ctx.data.getVersionPreview === "function");
}

if (!PREVIEW) {
  // ── permission gating, before any request ──
  as("staff"); reset();
  {
    const a = await rejects(() => actions.requestVersionPreview(RID));
    const b = await rejects(() => data.getVersionPreview(PID));
    ok("staff: requestVersionPreview refused with a permission ActionError", a instanceof ActionError && a.kind === "permission" && a.status === 403);
    ok("staff: getVersionPreview refused with a permission ActionError", b instanceof ActionError && b.kind === "permission");
    ok("staff: no request went out", calls.length === 0);
  }
  as("editor"); reset();
  for (const bad of ["", "abc", "../../x", `${RID}/x`, 5, null, undefined]) {
    const a = await rejects(() => actions.requestVersionPreview(bad));
    const b = await rejects(() => data.getVersionPreview(bad));
    ok(`bad id ${JSON.stringify(bad)} refused before any request`, a instanceof ActionError && b instanceof ActionError && calls.length === 0);
  }
  // ── an unmapped failure is the generic ActionError: no ApiError, no response body, no raw network text ──
  as("editor");
  for (const [label, reply] of [["500", { status: 500, body: { error: { code: "x", message: "SECRET RAW BODY" } } }], ["418", { status: 418, body: { error: { code: "x", message: "SECRET RAW BODY" } } }]]) {
    reset(); on("GET", `/design/version-previews/${PID}`, reply); on("POST", "/version-preview", reply);
    for (const [n, fn] of [["getVersionPreview", () => data.getVersionPreview(PID)], ["requestVersionPreview", () => actions.requestVersionPreview(RID)]]) {
      const e = await rejects(fn);
      ok(`${n} ${label}: a generic ActionError with fixed wording (no ApiError, no body)`, e instanceof ActionError && !(e instanceof ApiError) && !("body" in e) && !/SECRET/.test(e.message + JSON.stringify(e)), e && e.message);
    }
  }
  reset(); { const o = g.fetch; g.fetch = async () => { throw new TypeError("Failed to fetch https://x.example/?sig=SECRET"); }; const e = await rejects(() => data.getVersionPreview(PID)); g.fetch = o;
    ok("a network failure is generic too (no raw message)", e instanceof ActionError && e.reason === "network" && !/SECRET/.test(e.message)); }
  // ── request + read ──
  reset(); on("POST", `/admin/shops/7/design/requests/${RID}/version-preview`, { status: 202, body: apiPreview() });
  const p = await actions.requestVersionPreview(RID);
  ok("request: POST to the right route, shop bound by the core", calls.length === 1 && calls[0].method === "POST" && calls[0].url.endsWith(`/api/v1/admin/shops/7/design/requests/${RID}/version-preview`));
  ok("request: normalized, waiting", p.state === "waiting" && p.id === PID && p.tag === "design-2026-10-01" && p.readOnly === true && p.origin === "");
  const dump = JSON.stringify(p);
  ok("no token, no shop id, no raw field in what the design layer gets", !/test-token|shop|requested_by|preview_origin/i.test(dump) && !("target_tag" in p));
  reset(); on("GET", `/design/version-previews/${PID}`, { body: apiPreview({ status: "ready", ready_at: "2026-11-26T10:01:00Z", origin: "https://p-1.preview.example" }) });
  const r = await data.getVersionPreview(PID);
  ok("ready with a plain https origin: origin handed over", r.state === "ready" && r.origin === "https://p-1.preview.example");
  for (const o of ["https://p.example/path", "https://p.example/?q=1", "https://p.example/#x", "http://p.example", "http://localhost:3000", "http://127.0.0.1", "http://[::1]", "https://localhost.", "https://p.example.", "https://localhost", "https://127.0.0.1", "https://[::1]", "javascript:alert(1)", "https://u:p@p.example", "ftp://p.example", "not a url"]) {
    reset(); on("GET", "/version-previews/", { body: apiPreview({ status: "ready", origin: o }) });
    ok(`origin ${o} dropped`, (await data.getVersionPreview(PID)).origin === "");
  }
  {
  // the preview link may be opened without widening the global image allowlist
  const kit = await imp("ui/kit.js");
  const mkEl = () => g.document.createElement("a");
  g.document.createElement = (t) => { const e = new FakeEl(t); e.addEventListener = () => {}; e.append = (...c) => { e.children.push(...c); }; return e; };
  g.location.href = "http://localhost:3001/";
  kit.allowPreviewLinkOrigin("https://p-9.preview.example");
  const link = (u) => kit.h("a", { href: u }); const img = (u) => kit.h("img", { src: u });
  const w0 = console.warn; console.warn = () => {};
  ok("preview origin works as a link href", link("https://p-9.preview.example/x").attrs.has("href"));
  ok("preview origin is NOT an image source", !img("https://p-9.preview.example/x.png").attrs.has("src"));
  ok("another https origin is still refused as a link", !link("https://other.example/").attrs.has("href"));
  kit.allowPreviewLinkOrigin("https://p-10.preview.example");
  ok("a newer preview replaces the old one (single slot)", !link("https://p-9.preview.example/").attrs.has("href") && link("https://p-10.preview.example/").attrs.has("href"));
  console.warn = w0; void mkEl;
  }
  {
  // the "改成這個版本" button: implemented, but only rendered when the caller passes onRevert; the default view does not (no target route yet)
  const { versionPreviewSection } = await imp("design/parts/version-preview-section.js");
  const node = (tag, attrs, ...kids) => { const n = { tag, attrs: attrs || {}, kids: kids.flat(Infinity), append(...c) { n.kids.push(...c.flat(Infinity)); } }; return n; };
  const find = (n, id) => (n && typeof n === "object" ? (n.attrs && n.attrs["data-testid"] === id ? n : (n.kids || []).map((k) => find(k, id)).find(Boolean)) : null);
  const mkctx = () => ({ ui: { h: node, clear: (b) => { b.kids = []; }, button: (label, o) => node("button", o, label), busy() {}, toast() {}, badge: (x) => node("span", {}, x), loading: (x) => node("div", {}, x) },
    t: (k) => k, data: {}, actions: {}, can: () => true, format: { dateTime: String }, errorMessage: String, alive: () => true });
  const body = (box) => { const b = find(box, "vp-body"); return b; };
  const withoutCb = versionPreviewSection(mkctx(), { requestId: RID });
  const calls2 = []; const withCb = versionPreviewSection(mkctx(), { requestId: RID, onRevert: (id) => calls2.push(id) });
  ok("no onRevert (default view): the revert CTA is not rendered", !find(withoutCb, "vp-revert") && !!find(withoutCb, "vp-limits"));
  ok("with onRevert: the CTA renders and calls it with the request id", (() => { const b = find(withCb, "vp-revert"); if (!b) return false; b.attrs.onClick(); return calls2.join() === RID; })());
  const noPerm = mkctx(); noPerm.can = () => false;
  ok("with onRevert but without design.revert: not rendered", !find(versionPreviewSection(noPerm, { requestId: RID, onRevert() {} }), "vp-revert"));
  const viewSrc = (await import("node:fs")).readFileSync(path.join(ROOT, "design/views/design-version-preview.js"), "utf8");
  const viewSrc2 = (await import("node:fs")).readFileSync(path.join(ROOT, "design-defaults/views/design-version-preview.js"), "utf8");
  ok("the default views do not pass onRevert (target route does not exist yet)", !/onRevert/.test(viewSrc) && !/onRevert/.test(viewSrc2)); void body;
  }
  reset(); on("GET", "/version-previews/", { body: apiPreview({ status: "queued" }) });
  ok("another member (no origin key): waiting, origin empty", (await data.getVersionPreview(PID)).origin === "");
  reset(); on("GET", "/version-previews/", { body: apiPreview({ status: "ready", origin: "https://p.example", expires_at: "2000-01-01T00:00:00Z" }) });
  const ex = await data.getVersionPreview(PID);
  ok("past expires_at: expired by the clock, no origin", ex.state === "expired" && ex.origin === "");
  reset(); on("GET", "/version-previews/", { body: apiPreview({ status: "superseded" }) });
  ok("superseded shows as expired", (await data.getVersionPreview(PID)).state === "expired");
  reset(); on("GET", "/version-previews/", { body: apiPreview({ status: "failed", failure_code: "guard_failed", failure_detail: "<b>no</b>", failure_rule_ids: ["css/hides-dialog", "bad id with spaces", "js/eval"] }) });
  const f = await data.getVersionPreview(PID);
  ok("failed: code, detail as plain data, only well-formed rule ids", f.state === "failed" && f.failureCode === "guard_failed" && f.failureDetail === "<b>no</b>" && f.failureRuleIds.join() === "css/hides-dialog,js/eval");
  // ── error mapping ──
  const err = (status, code, headers) => ({ status, headers, body: { error: { code, message: "platform says why" } } });
  const cases = [
    [409, "revert_below_core_floor", "state", "revert_below_core_floor"], [409, "already_current", "state", "already_current"],
    [409, "invalid_state", "state", "invalid_state"], [409, "site_state_unknown", "state", "site_state_unknown"],
    [429, "hourly_cap_reached", "limit", "hourly_cap_reached"], [429, "daily_cap_reached", "limit", "daily_cap_reached"],
    [403, "forbidden", "permission", "permission"], [404, "not_found", "state", "gone"],
  ];
  for (const [st, code, kind, reason] of cases) {
    reset(); on("POST", "/version-preview", err(st, code, st === 429 ? { "Retry-After": "1800" } : {}));
    const e = await rejects(() => actions.requestVersionPreview(RID));
    ok(`${st} ${code} -> ActionError ${kind}/${reason}`, e instanceof ActionError && e.kind === kind && e.reason === reason, String(e && e.message));
    if (st === 429) ok(`${code}: retryAfter 1800 and the wait in the message`, e.retryAfter === 1800 && /30/.test(e.message), e.message);
    if (st === 409) ok(`${code}: platform reason kept as detail`, e.detail === "platform says why");
  }
  // ── the banner (only on a preview host) ──
  ok("normal host: no banner is installed", banner.installPreviewBanner() === false && body.children.length === 0);
  const mode = { kind: "version", tag: "design-2026-10-01", expiresAt: "2999-01-01T00:00:00Z" };
  ok("banner text: label, tag, expiry", /版本預覽/.test(banner.bannerText(mode)) && /design-2026-10-01/.test(banner.bannerText(mode)) && /到期時間/.test(banner.bannerText(mode)));
  ok("banner text: expired", /已到期/.test(banner.bannerText({ ...mode, expiresAt: "2000-01-01T00:00:00Z" })));
  ok("banner: first check builds it in body", banner.verifyBanner(mode) === true && body.children.length === 1 && body.children[0].getAttribute("id") === banner.BANNER_ID);
  const first = body.children[0];
  body.removeChild(first);
  ok("removed -> rebuilt", banner.verifyBanner(mode) === true && body.children.length === 1 && body.children[0] !== first);
  body.children[0].textContent = "";
  ok("reworded -> rebuilt with the fixed text", banner.verifyBanner(mode) === true && body.children[0].textContent === banner.bannerText(mode));
  body.children[0].style.setProperty("display", "none", "important");
  ok("hidden by style -> rebuilt", banner.verifyBanner(mode) === true && body.children[0].style.getPropertyValue("display") === "block");
  ok("banner styles are all !important", [...body.children[0].props.values()].every(([, p]) => p === "important"));
  ok("banner is outside #app (a child of body)", body.children[0].parentNode === body && app.children.length === 0);
} else {
  // ── preview host: read-only ──
  as("owner");
  const names = Object.keys(actions);
  ok("the action table includes the new action and the content preview", names.length > 25 && names.includes("requestVersionPreview") && names.includes("previewContentDocument"));
  for (const n of names) {
    reset();
    const e = await rejects(() => actions[n]({}, {}, {}));
    ok(`${n}: refused as read-only before anything else`, e instanceof ActionError && e.reason === "read_only" && e.kind === "state" && /唯讀/.test(e.message) && calls.length === 0, String(e && e.message));
  }
  as("staff"); reset();
  const e0 = await rejects(() => actions.saveProduct(null, {}));
  ok("read-only error also for someone without the permission", e0 && e0.reason === "read_only" && calls.length === 0);
  as("owner");
  // lib/api.js backstop
  const { api } = await imp("lib/api.js");
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    reset();
    const e = await rejects(() => api(m, "/admin/shops/7/products", {}));
    ok(`api ${m} refused in preview mode`, e && e.status === 403 && e.code === "read_only" && calls.length === 0);
  }
  reset(); on("GET", "/design/version-previews/", { body: apiPreview({ status: "ready", origin: "https://p.example" }) });
  ok("reads still work (getVersionPreview)", (await data.getVersionPreview(PID)).state === "ready" && calls[0].method === "GET");
  reset(); on("GET", "/admin/shops/7/products", { body: [] });
  ok("a plain GET still goes out", (await rejects(() => api("GET", "/admin/shops/7/products"))) === null && calls.length === 1);
  // the banner
  ok("banner installs on a preview host", banner.installPreviewBanner() === true && body.children.length === 1 && body.children[0].getAttribute("data-kind") === PREVIEW);
  ok("banner shows the tag and the preview kind", body.children[0].textContent.includes("design-2026-11-01") && body.children[0].textContent.includes(PREVIEW === "change" ? "改版預覽" : "版本預覽"));
  body.removeChild(body.children[0]);
  ok("removed by something else -> rebuilt by the check", banner.verifyBanner(previewMode) === true && body.children.length === 1);
  g.window.ADMIN_CONFIG.preview = null;
  ok("changing window.ADMIN_CONFIG later does not switch read-only off", isReadOnly() === true && Object.isFrozen(previewMode));
}

console.log(`test-preview [${MODE}]: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
