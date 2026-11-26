#!/usr/bin/env node
// Offline tests of the design history READ layer (D13, PR1): ctx.data.listDesignRequests / getDesignRequest / getDesignState and the
// not-yet-registered routes (no network, no browser, no dependencies). Run: node scripts/test-design-history.mjs
// (scripts/test-guard.mjs runs it too). It runs itself three times: as a normal page and as a PREVIEW host (DH_MODE=version / change).
//   permissions: owner and editor (design.view) may read, staff may not; checked BEFORE any request.
//   shape: ids and filters validated before any request; responses normalized to camelCase, unknown keys dropped; no signed URL,
//   token, shop id, ETag or email ever reaches the design layer; the ETag stays in lib/design-history.js; errors mapped to ActionError.
//   preview hosts: these GETs still work; every action is still read-only.
//   routing: design and designRequest are defined but not registered (no nav item, no dead route).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.env.DH_MODE || "";
const g = globalThis;

if (!MODE) {
  let bad = 0;
  for (const m of ["normal", "version", "change"]) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, DH_MODE: m }, encoding: "utf8" });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    if (r.status !== 0) bad++;
  }
  process.exit(bad ? 1 : 0);
}
const PREVIEW = MODE === "normal" ? "" : MODE;

// browser stubs
const store = new Map();
g.window = { ADMIN_CONFIG: PREVIEW ? { preview: { kind: PREVIEW, tag: "design-2026-11-01", expiresAt: "2999-01-01T00:00:00Z" } } : {}, scrollTo() {}, addEventListener() {}, open: () => null };
g.location = { hostname: "localhost", origin: "http://localhost:3001", hash: "", href: "http://localhost:3001/", reload() {} };
g.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
g.document = { createElement: () => ({ setAttribute() {}, style: { setProperty() {} } }), createComment: () => ({}), body: {}, head: {}, documentElement: {}, getElementById: () => null };
g.history = { replaceState() {} };
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.error(`  FAIL [${MODE}] ${name} ${extra}`); } };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

const calls = [];
let routes = [];
g.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ method: init.method || "GET", url: u });
  const r = routes.find((x) => (init.method || "GET") === x.method && u.includes(x.match));
  if (!r) return new Response(JSON.stringify({ error: { code: "not_found", message: "no stub" } }), { status: 404, headers: { "content-type": "application/json" } });
  return new Response(JSON.stringify(r.body), { status: r.status || 200, headers: { "content-type": "application/json", ...(r.headers || {}) } });
};
const on = (match, reply) => routes.unshift({ method: "GET", match, ...reply });
const reset = () => { calls.length = 0; routes = []; };

const logs = [];
for (const k of ["log", "warn", "error", "info", "debug"]) { const o = console[k]; console[k] = (...a) => { logs.push(a.map(String).join(" ")); if (k === "error") o(...a); }; }

const { tokens } = await imp("lib/api.js");
const { session } = await imp("lib/session.js");
const { setPermissions } = await imp("lib/perm.js");
const { loadDesign } = await imp("lib/design.js");
const { data } = await imp("core/data.js");
const { actions } = await imp("core/actions.js");
const { makeContext } = await imp("core/context.js");
const { ActionError } = await imp("core/errors.js");
const dh = await imp("lib/design-history.js");
const { ROUTES, NAV, DESIGN_HISTORY_ROUTES } = await imp("core/routes.js");
const { ROUTE_IDS } = await imp("lib/design-schema.js");
await loadDesign();
tokens.set({ access_token: "secret-access-token-123" });
session.shopID = 7;

const RID = "11111111-2222-4333-8444-555555555555";
const OTHER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SHA = "a".repeat(40), SHA2 = "b".repeat(40);
const SIGNED = "https://bucket.example.com/x.png?X-Amz-Signature=deadbeef";
const perms = { staff: ["order.view"], editor: ["design.view"], owner: ["design.view", "design.request", "design.approve", "design.revert"] };
const as = (who) => setPermissions(perms[who]);

const summary = (o = {}) => ({
  id: RID, site: "admin", kind: "change", status: "awaiting_approval", requested_by_user_id: 12, prompt_sha256: "x", prompt_flags: ["email", "weird"],
  base_sha: SHA, head_sha: SHA, candidate_sha: SHA, published_sha: null, branch: "ai/secret-branch", core_version: "0.4.2", design_floor_version: "0.3.0",
  preview_registered_at: "2026-11-27T10:00:00Z", preview_expires_at: "2026-11-27T12:00:00Z", approved_by_user_id: null, approved_at: null, approved_head_sha: null,
  approval_expires_at: null, publish_tag: null, published_at: null, published_tag: null, deployment_id: "dep-1", restores_request_id: null, reverted_by_request_id: null,
  failure_code: null, rev: 5, created_at: "2026-11-27T09:00:00Z", updated_at: "2026-11-27T10:00:00Z", prompt_excerpt: "make the banner pink",
  proposed_by_name: "Team member", approved_by_name: null, rejected_by_name: null, is_current: false, revert_target_tag: null,
  future_field: "must not leak", signed_url: SIGNED, ...o,
});
const detail = (o = {}) => ({
  ...summary(), prompt_text: "<b>make</b> the banner pink", diff_summary: { files_changed: 2, additions: 5, deletions: 1, files: [{ path: "admin/design/theme.css", status: "modified", additions: 5, deletions: 1, blob_url: SIGNED }, { path: "" }], extra: 1 },
  guard: { passed: true, checked_sha: SHA, rule_ids: ["css/x", "bad id"], violation_count: 0, guard_version: "0.4.2", checked_at: "2026-11-27T10:00:00Z", secret: "s" },
  preview_origin: "https://p-1.preview.example", rejected_by_user_id: null, rejected_at: null, reject_reason: null, change_note: null, failure_detail: null, preview_read_only: true, ...o,
});
const ev = (o = {}) => ({ seq: 1, kind: "created", from_status: "", to_status: "drafting", actor_type: "user", actor_user_id: 12, actor_name: "Team member", actor_credential_id: null, head_sha: SHA, detail: { secret: 1 }, hash: "h", created_at: "2026-11-27T09:00:00Z", ...o });

// the three names are on the real ctx
ok("ctx.data exposes exactly the three new functions", ["listDesignRequests", "getDesignRequest", "getDesignState"].every((n) => typeof makeContext({ routeId: "home" }).data[n] === "function"));
ok("the three design actions exist (PR2, D14) and nothing else design-related was added", ["openDesignReview", "requestDesignRevert", "cancelDesignRequest"].every((n) => typeof actions[n] === "function") && Object.keys(actions).filter((n) => /design/i.test(n)).length === 3);

// routing groundwork: defined, but not registered and no nav entry
ok("routes design and designRequest are defined with design.view", DESIGN_HISTORY_ROUTES.map((r) => `${r.id}${r.pattern}${r.perm}`).join() === "design/designdesign.view,designRequest/design/:iddesign.view");
ok("...but not registered, not in ROUTES, NAV or ROUTE_IDS (no dead nav item, no view-less route)", DESIGN_HISTORY_ROUTES.every((r) => !ROUTES.some((x) => x.id === r.id) && !NAV.some((n) => n.key === r.nav || n.href === `#${r.pattern}`) && !ROUTE_IDS.includes(r.id) && r.ready === false));
ok("every registered route still has a view id the design layer can map", ROUTES.filter((r) => !r.public).every((r) => ROUTE_IDS.includes(r.id)));

// permission matrix, before any request
as("staff"); reset();
for (const [n, fn] of [["list", () => data.listDesignRequests({ page: 1, pageSize: 20 })], ["get", () => data.getDesignRequest(RID)], ["state", () => data.getDesignState({})]]) {
  const e = await rejects(fn);
  ok(`staff: ${n} refused with a permission ActionError`, e instanceof ActionError && e.kind === "permission" && e.status === 403);
}
ok("staff: no request went out", calls.length === 0);
for (const who of ["editor", "owner"]) {
  as(who); reset();
  on("/design/requests?", { body: { requests: [summary()], page: 1, page_size: 20, total: 1 } });
  const r = await data.listDesignRequests({ page: 1, pageSize: 20 });
  ok(`${who}: list works`, r.total === 1 && r.requests.length === 1 && calls.length === 1 && calls[0].method === "GET");
}

as("editor");
// id and filter validation
reset();
for (const bad of ["", "abc", "../../x", `${RID}/events`, `${RID}?x=1`, 5, null, undefined, {}, [RID]]) {
  const e = await rejects(() => data.getDesignRequest(bad));
  ok(`bad id ${JSON.stringify(bad)} refused before any request`, e instanceof ActionError && calls.length === 0);
}
for (const bad of [{ page: 0 }, { page: 1.5 }, { page: "1" }, { pageSize: 0 }, { pageSize: 101 }, { site: "evil" }, { status: "x" }, { kind: "x" }, { status: ["published"] }, { site: "admin&x=1" }]) {
  const e = await rejects(() => data.listDesignRequests(bad));
  ok(`bad filter ${JSON.stringify(bad)} refused before any request`, e instanceof ActionError && e.kind === "invalid" && calls.length === 0);
}
{
  const e = await rejects(() => data.getDesignState({ site: "nope" }));
  ok("bad state site refused before any request", e instanceof ActionError && calls.length === 0);
}
// list: query built from known keys only, shop bound by the core
reset(); on("/design/requests?", { body: { requests: [summary(), summary({ id: "not-a-uuid" })], page: 2, page_size: 10, total: 31 } });
const page = await data.listDesignRequests({ site: "admin", status: "published", kind: "revert", page: 2, pageSize: 10, shopId: 99, evil: "1" });
const u = new URL(calls[0].url);
ok("list: right route, shop bound by the core, only known filters sent", u.pathname.endsWith("/api/v1/admin/shops/7/design/requests") && u.searchParams.get("site") === "admin" && u.searchParams.get("status") === "published" && u.searchParams.get("kind") === "revert" && u.searchParams.get("page") === "2" && u.searchParams.get("page_size") === "10" && ![...u.searchParams.keys()].some((k) => /shop|evil/.test(k)));
ok("list: page fields camelCase, a row without a valid id dropped", page.page === 2 && page.pageSize === 10 && page.total === 31 && page.requests.length === 1);
const row = page.requests[0];
ok("list: normalized row (names, excerpt, flags filtered, is_current, no prompt text)", row.promptExcerpt === "make the banner pink" && row.proposedByName === "Team member" && row.isCurrent === false && row.promptFlags.join() === "email" && row.site === "admin" && !("promptText" in row));
const dump = JSON.stringify(page);
ok("list: unknown and internal keys dropped (future_field, branch, deployment id, user ids, rev, signed url)", !/future_field|signed_url|secret-branch|dep-1|requested_by|rev\b|X-Amz|bucket\.example|ai\//.test(dump) && !("branch" in row) && !("rev" in row) && !("requestedByUserId" in row));
reset(); on("/design/requests?", { body: { requests: [] } });
{ const e = await data.listDesignRequests({}); ok("list: defaults page 1, pageSize 20; empty body is an empty page", new URL(calls[0].url).searchParams.get("page_size") === "20" && e.requests.length === 0 && e.page === 1); }

// detail
reset();
on(`/design/requests/${RID}`, { body: detail(), headers: { ETag: '"5"' } });
on(`/design/requests/${RID}/events`, { body: { events: [ev(), ev({ seq: 2, kind: "x", actor_type: "bogus", actor_name: null })], page: 1, page_size: 100, total: 2 } });
const d = await data.getDesignRequest(RID);
ok("detail: two GETs (request, events up to 100), shop bound by the core", calls.length === 2 && calls.every((c) => c.method === "GET" && c.url.includes("/admin/shops/7/design/requests/")) && calls.some((c) => c.url.includes("page_size=100")));
ok("detail: claimed and recorded fields normalized", d.promptText === "<b>make</b> the banner pink" && d.diff.filesChanged === 2 && d.diff.files.length === 1 && d.diff.files[0].path === "admin/design/theme.css" && d.guard.passed === true && d.guard.ruleIds.join() === "css/x" && d.previewOrigin === "https://p-1.preview.example" && d.previewReadOnly === true);
ok("detail: events normalized, unknown actor type becomes system, detail and hash dropped", d.events.length === 2 && d.events[1].actorType === "system" && d.events[0].actorName === "Team member" && !("detail" in d.events[0]) && !("hash" in d.events[0]) && !("actorUserId" in d.events[0]));
const dd = JSON.stringify(d);
ok("detail: no signed URL, token, shop id, ETag, extra key or email in what the design layer gets", !/X-Amz|bucket\.example|blob_url|signed_url|secret-access-token|future_field|secret|"5"|shop|etag|ai\/secret|dep-1/i.test(dd), dd.slice(0, 300));
ok("detail: no key that looks like an etag, rev, token or url", !Object.keys(d).some((k) => /etag|rev$|token|url$|sha256|branch/i.test(k)));
const basis = dh.reviewBasis(7, RID);
ok("the ETag and shas stay INSIDE the core module (reviewBasis), not on the object", basis && basis.etag === '"5"' && basis.headSha === SHA && basis.candidateSha === SHA && !dd.includes(basis.etag));
ok("the ctx never exposes reviewBasis", !JSON.stringify(Object.keys(makeContext({ routeId: "home" }).data)).includes("eviewBasis") && !("reviewBasis" in data));
for (const o of ["https://p.example/path", "http://p.example", "https://localhost", "javascript:alert(1)", "https://u:p@p.example", "https://127.0.0.1", "not a url", null]) {
  reset(); on(`/requests/${RID}`, { body: detail({ preview_origin: o }) }); on("/events", { body: { events: [] } });
  ok(`previewOrigin ${o} dropped`, (await data.getDesignRequest(RID)).previewOrigin === "");
}
reset(); on(`/requests/${RID}`, { body: detail({ prompt_text: null, guard: null, preview_origin: null, status: "bogus", site: "x" }) }); on("/events", { body: { events: new Array(150).fill(ev()) } });
{ const x = await data.getDesignRequest(RID); ok("detail: null prompt after retention, null guard, unknown status/site fall back, events capped at 100", x.promptText === null && x.guard === null && x.previewOrigin === "" && x.status === "failed" && x.site === "storefront" && x.events.length === 100); }

// state
reset(); on("/design/state", { body: { sites: [
  { site: "storefront", untracked_changes: 2, current_request_id: RID, current_tag: "design-2026-11-25-1", current_sha: SHA, core_version: "0.4.2", design_floor_version: "0.3.0", last_seen_main_sha: SHA2, updated_at: "2026-11-25T10:00:00Z", pending_approval_count: 1, junk: 1 },
  { site: "admin", untracked_changes: 0, current_request_id: null, current_tag: "", current_sha: "", core_version: "0.4.2", design_floor_version: "0.3.0", last_seen_main_sha: "", updated_at: null, pending_approval_count: 2 },
], pending_approval_count: 3 } });
const st = await data.getDesignState();
ok("state: both sites, current {requestId, tag, coreVersion}, untracked, pending, total", st.sites.length === 2 && st.sites[0].current.requestId === RID && st.sites[0].current.tag === "design-2026-11-25-1" && st.sites[0].current.coreVersion === "0.4.2" && st.sites[0].untracked === 2 && st.pendingApproval === 3 && st.sites[1].current.requestId === null);
ok("state: no sha, no raw keys", !/junk|last_seen|current_sha|lastSeen/.test(JSON.stringify(st)) && calls.length === 1 && calls[0].url.endsWith("/admin/shops/7/design/state"));
const one = await data.getDesignState({ site: "admin" });
ok("state: site filter narrows to one site", one.sites.length === 1 && one.sites[0].site === "admin" && one.pendingApproval === 2);

// error mapping (never a raw ApiError at the design layer for the known statuses)
const err = (status, code, headers) => ({ status, headers, body: { error: { code, message: "platform says why" } } });
for (const [st2, kind, reason] of [[403, "permission", "permission"], [404, "state", "gone"], [422, "invalid", "invalid"], [429, "limit", "rate_limited"], [503, "state", "design_storage_not_configured"]]) {
  for (const [n, fn, match] of [["list", () => data.listDesignRequests({}), "/design/requests?"], ["get", () => data.getDesignRequest(RID), `/requests/${RID}`], ["state", () => data.getDesignState(), "/design/state"]]) {
    reset(); on(match, err(st2, st2 === 503 ? "design_storage_not_configured" : "x", st2 === 429 ? { "Retry-After": "120" } : {})); on("/events", err(st2, "x"));
    const e = await rejects(fn);
    ok(`${n} ${st2} -> ActionError ${kind}/${reason}`, e instanceof ActionError && e.kind === kind && e.reason === reason && e.status === st2, e && `${e.kind}/${e.reason}/${e.status}`);
    if (st2 === 429 && n === "list") ok("429: retryAfter kept, wait in the message", e.retryAfter === 120 && /2/.test(e.message));
  }
}
ok("no log line ever contained the access token, a signed URL or an ETag", !logs.some((l) => /secret-access-token|X-Amz|Signature/.test(l)), logs.join("|").slice(0, 200));

// read-only preview hosts: these GETs still work, every write is still refused
if (PREVIEW) {
  as("owner"); reset(); on("/design/state", { body: { sites: [] } });
  ok("preview host: getDesignState still works", (await data.getDesignState()).sites.length === 0 && calls[0].method === "GET");
  reset(); on("/design/requests?", { body: { requests: [summary()], total: 1 } });
  ok("preview host: listDesignRequests still works", (await data.listDesignRequests({})).total === 1);
  reset(); on(`/requests/${RID}`, { body: detail() }); on("/events", { body: { events: [] } });
  ok("preview host: getDesignRequest still works", (await data.getDesignRequest(RID)).id === RID);
  const { api } = await imp("lib/api.js");
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) { reset(); const e = await rejects(() => api(m, `/admin/shops/7/design/requests/${RID}/approve`, {})); ok(`preview host: ${m} to a design route still refused`, e && e.status === 403 && e.code === "read_only" && calls.length === 0); }
  for (const n of Object.keys(actions)) { reset(); const e = await rejects(() => actions[n]({}, {}, {})); ok(`preview host: action ${n} still read_only`, e instanceof ActionError && e.reason === "read_only" && calls.length === 0); }
} else {
  // the default views do not pass onRevert (the version preview CTA stays hidden), and no default view exists for the new routes yet
  const v1 = readFileSync(path.join(ROOT, "design/views/design-version-preview.js"), "utf8"), v2 = readFileSync(path.join(ROOT, "design-defaults/views/design-version-preview.js"), "utf8");
  ok("version preview CTA onRevert stays hidden in the default views", !/onRevert/.test(v1) && !/onRevert/.test(v2));
  const dr = (await imp("design-defaults/routes.js")).default;
  ok("no default view is registered for design / designRequest yet", !("design" in dr) && !("designRequest" in dr));
}

process.stdout.write(`test-design-history [${MODE}]: ${pass} passed, ${fail} failed
`);
process.exit(fail ? 1 : 0);
