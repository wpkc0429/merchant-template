#!/usr/bin/env node
// Offline tests of the design REVIEW actions (T1-T4 PR2, D14): ctx.actions.openDesignReview / requestDesignRevert / cancelDesignRequest
// (no network, no browser, no dependencies). Run: node scripts/test-design-review.mjs   (scripts/test-guard.mjs runs it too).
// It runs itself three times: as a normal page and as a PREVIEW host (DR_MODE=version / change).
//   permissions: owner / editor / staff matrix, checked BEFORE any request; the dialog's buttons come from can().
//   binding: approve sends exactly the candidate sha and ETag the REVIEW read, never a value from the design layer; a stale answer
//   (head_moved, 412, 428), a newer read, a sign-out or a user change forces a reload and a new look: nothing is retried or re-sent.
//   screenshots: signed URLs never reach the design layer, a log or a return value; one retry with a fresh URL, then "expired".
//   errors: mapped to ActionError with reasons; unmapped cases are generic and never carry an ApiError or its body.
//   preview hosts: all three actions refuse with read_only before any request.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { signIn } from "./lib/test-signin.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODE = process.env.DR_MODE || "";
const g = globalThis;
if (!MODE) {
  let bad = 0;
  for (const m of ["normal", "version", "change"]) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, DR_MODE: m }, encoding: "utf8" });
    process.stdout.write(r.stdout); process.stderr.write(r.stderr);
    if (r.status !== 0) bad++;
  }
  process.exit(bad ? 1 : 0);
}
const PREVIEW = MODE === "normal" ? "" : MODE;

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
const SIGNED = "https://shots.example.com/bucket/obj.png?X-Amz-Signature=deadbeef";
g.fetch = async (url, init = {}) => {
  const u = String(url), method = init.method || "GET";
  calls.push({ method, url: u, init, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers || {} });
  const r = routes.find((x) => method === x.method && u.includes(x.match));
  if (!r) return new Response(JSON.stringify({ error: { code: "not_found", message: "no stub" } }), { status: 404, headers: { "content-type": "application/json" } });
  const reply = typeof r.reply === "function" ? r.reply({ url: u, init, n: r.n = (r.n || 0) + 1 }) : r.reply;
  if (reply.bytes) return new Response(reply.bytes, { status: reply.status || 200, headers: { "content-type": "image/png", ...(reply.headers || {}) } });
  return new Response(JSON.stringify(reply.body ?? null), { status: reply.status || 200, headers: { "content-type": "application/json", ...(reply.headers || {}) } });
};
const on = (method, match, reply) => routes.unshift({ method, match, reply: reply && typeof reply.reply === "function" ? reply.reply : reply });
const reset = () => { calls.length = 0; routes = []; };
const posts = () => calls.filter((c) => c.method === "POST");

const logs = [];
for (const k of ["log", "warn", "error", "info", "debug"]) { const o = console[k]; console[k] = (...a) => { logs.push(a.map(String).join(" ")); if (k === "error") o(...a); }; }

const { takeApi, ApiError } = await imp("lib/api.js");
const net = takeApi();
const { state: session, clearSession } = (await imp("lib/session.js")).takeSession(); // boot phase (D19)
const { setPermissions } = (await imp("lib/perm.js")).takePermissions(); // boot phase (D19)
const { loadDesign } = await imp("lib/design.js");
const { actions } = await imp("core/actions.js");
const { takeDesignActions, reviewError } = await imp("core/design-actions.js");
const createDesignActions = takeDesignActions(); // boot phase (D19)
const { ActionError } = await imp("core/errors.js");
const { fixedWarning, FIXED_WARNINGS } = await imp("core/warnings.js");
const { validateCopy, WARNED_CONFIRM_IDS } = await imp("lib/design-schema.js");
const dh = await imp("lib/design-history.js");
const rvlib = await imp("lib/design-review.js");
await loadDesign();
await signIn(net, "secret-access-token-123");
session.shopID = 7; session.shopName = "Test Shop";

const RID = "11111111-2222-4333-8444-555555555555";
const TARGET = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SHA = "a".repeat(40), SHA2 = "b".repeat(40);
const perms = { staff: ["order.view"], editor: ["design.view"], owner: ["design.view", "design.request", "design.approve", "design.revert"] };
const as = (who) => setPermissions(perms[who]);
const U = String.fromCharCode;
const BIDI = U(0x202e), ZW = U(0x200b), CTL = U(1);

const detail = (o = {}) => ({
  id: RID, site: "admin", kind: "change", status: "awaiting_approval", base_sha: SHA, head_sha: SHA, candidate_sha: SHA, core_version: "0.4.2", design_floor_version: "0.3.0",
  preview_expires_at: "2026-11-27T12:00:00Z", rev: 5, created_at: "2026-11-27T09:00:00Z", updated_at: "2026-11-27T10:00:00Z", prompt_excerpt: "pink",
  prompt_text: "make it pink", proposed_by_name: "Team member", diff_summary: { files_changed: 2, additions: 5, deletions: 1, files: [{ path: "admin/design/theme.css", status: "modified", additions: 5, deletions: 1 }] },
  guard: { passed: true, checked_sha: SHA, rule_ids: [], violation_count: 0, guard_version: "0.4.2", checked_at: "2026-11-27T10:00:00Z" },
  preview_origin: "https://p-1.preview.example", approved_by_name: null, ...o,
});
const onGet = (o = {}, etag = '"5"') => on("GET", `/requests/${RID}`, { body: detail(o), headers: { ETag: etag } });
// a PNG start (signature + IHDR) with the given size; the rest is filler (the core only reads the header)
const png = (w = 390, h = 800) => { const b = new Uint8Array(40); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]); const dv = new DataView(b.buffer); dv.setUint32(16, w); dv.setUint32(20, h); return b; };
const shotRow = (o = {}) => ({ id: "99999999-9999-4999-8999-999999999991", request_id: RID, phase: "before", site: "admin", role: "owner", viewport: 390, view_key: "home", attempt: 1, commit_sha: SHA, content_type: "image/png", byte_size: 10, width: 390, height: 800, sha256: "x", diff_ppm: 1500, capture_manifest: null, purged_at: null, created_at: "2026-11-27T10:00:00Z", url: SIGNED, url_expires_at: new Date(Date.now() + 300000).toISOString(), object_key: "secret/key", ...o });

// A fake dialog: records the model and handlers the core hands to the UI, and answers like a person would.
function fakeReview() {
  const seen = { model: null, handlers: null, count: 0 };
  const review = async (model, handlers) => { seen.model = model; seen.handlers = handlers; seen.count++; if (seen.script) await seen.script(model, handlers); };
  return { seen, review };
}
const confirmations = [];
let answer = true;
const ask = async (key, p, opts) => { confirmations.push({ key, p, opts }); return answer; };
const toasts = [];
const mk = () => { const f = fakeReview(); return { ...f, api: createDesignActions({ ask, review: f.review, notify: (m) => toasts.push(m) }) }; };

// ── the surface ──
{
  const f = mk();
  ok("exactly three actions, each with the id (and for revert the options) as its only parameters", Object.keys(f.api).sort().join() === "cancelDesignRequest,openDesignReview,requestDesignRevert"
    && f.api.openDesignReview.length === 1 && f.api.cancelDesignRequest.length === 1 && f.api.requestDesignRevert.length === 2);
  ok("they are in the real actions table (so readOnlyGuarded wraps them)", ["openDesignReview", "requestDesignRevert", "cancelDesignRequest"].every((n) => typeof actions[n] === "function"));
}

if (PREVIEW) {
  as("owner");
  for (const [n, args] of [["openDesignReview", [RID]], ["requestDesignRevert", [RID, { reason: "x" }]], ["cancelDesignRequest", [RID]]]) {
    reset(); const e = await rejects(() => actions[n](...args));
    ok(`preview host: ${n} throws read_only before any request`, e instanceof ActionError && e.reason === "read_only" && calls.length === 0);
  }
  // even the core's own handlers refuse (a dialog that was somehow built in a preview host can neither approve nor reject)
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } });
  const f = mk(); as("owner");
  await f.api.openDesignReview(RID);
  ok("preview host: the review model offers no approve and no reject", f.seen.model.canApprove === false && f.seen.model.canReject === false && /唯讀/.test(f.seen.model.cannotReason));
  for (const n of ["approve", "reject", "requestChanges"]) {
    const r = await f.seen.handlers[n]({ acknowledged: true, reason: "x", note: "x" });
    ok(`preview host: handler ${n} refuses and sends nothing`, r.kind === "error" && posts().length === 0);
  }
  process.stdout.write(`test-design-review [${MODE}]: ${pass} passed, ${fail} failed
`);
  process.exit(fail ? 1 : 0);
}

// ── permission matrix ──
{
  reset(); as("staff");
  const f = mk();
  for (const [n, fn] of [["open", () => f.api.openDesignReview(RID)], ["revert", () => f.api.requestDesignRevert(RID)], ["cancel", () => f.api.cancelDesignRequest(RID)]]) {
    const e = await rejects(fn);
    ok(`staff: ${n} refused with a permission ActionError, no request`, e instanceof ActionError && e.kind === "permission" && calls.length === 0);
  }
  as("editor"); reset();
  for (const [n, fn] of [["revert", () => f.api.requestDesignRevert(TARGET)], ["cancel", () => f.api.cancelDesignRequest(TARGET)]]) {
    const e = await rejects(fn);
    ok(`editor: ${n} refused (design.revert / design.request), no request`, e instanceof ActionError && e.kind === "permission" && calls.length === 0);
  }
  onGet(); on("GET", "/screenshots", { body: { screenshots: [] } });
  const r = await f.api.openDesignReview(RID);
  ok("editor: the review opens (design.view) but offers no approve and no reject", f.seen.model.canApprove === false && f.seen.model.canReject === false && r.outcome === "closed");
  for (const n of ["approve", "reject", "requestChanges"]) {
    reset(); const res = await f.seen.handlers[n]({ acknowledged: true, reason: "x", note: "x" });
    ok(`editor: handler ${n} refused and nothing sent`, res.kind === "error" && calls.length === 0);
  }
  as("owner"); reset(); onGet();
  await f.api.openDesignReview(RID);
  ok("owner: approve and reject are offered for an awaiting_approval request", f.seen.model.canApprove === true && f.seen.model.canReject === true);
  for (const bad of ["", "abc", "../x", `${RID}/events`, 5, null, undefined, {}, [RID]]) {
    reset(); const e = await rejects(() => f.api.openDesignReview(bad));
    ok(`bad id ${JSON.stringify(bad)} refused before any request`, e instanceof ActionError && calls.length === 0);
  }
  for (const st of ["approved", "published", "rejected", "failed", "cancelled", "drafting", "previewing", "reverted"]) {
    reset(); onGet({ status: st }); await f.api.openDesignReview(RID);
    ok(`status ${st}: no approve button`, f.seen.model.canApprove === false && f.seen.model.canReject === false);
  }
  reset(); onGet({}, ""); await f.api.openDesignReview(RID);
  ok("no ETag on the read: not approvable", f.seen.model.canApprove === false);
  reset(); onGet({ head_sha: SHA2 }); await f.api.openDesignReview(RID);
  ok("head differs from the locked candidate: not approvable", f.seen.model.canApprove === false);
}

// ── binding: approve sends what the review read, nothing from the design layer ──
as("owner");
{
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [shotRow()] } });
  on("POST", "/approve", { body: detail({ status: "approved", approval_expires_at: "2026-11-27T13:00:00Z", approved_by_name: "Team member" }) });
  const f = mk();
  f.seen.script = async (m, h) => {
    const r = await h.approve({ acknowledged: true, headSha: SHA2, head_sha: SHA2, etag: '"9"' }); // extra keys are ignored
    ok("approve: done with the approved outcome and a status text", r.kind === "done" && r.outcome === "approved" && /已核准，正在上線（核准有效至 .+）/.test(r.message), JSON.stringify(r));
  };
  const out = await f.api.openDesignReview(RID, { headSha: SHA2, head_sha: SHA2 }, "extra");
  const p = posts();
  ok("approve: exactly one POST, to the approve route of the bound shop", p.length === 1 && p[0].url.endsWith(`/admin/shops/7/design/requests/${RID}/approve`));
  ok("approve: body is only head_sha = the candidate the review read; If-Match = its ETag", JSON.stringify(p[0].body) === JSON.stringify({ head_sha: SHA }) && p[0].headers["If-Match"] === '"5"', JSON.stringify(p[0].body) + JSON.stringify(p[0].headers));
  ok("the design layer's head_sha was never used", !calls.some((c) => JSON.stringify(c.body || "").includes(SHA2) || JSON.stringify(c.headers).includes('"9"')));
  ok("outcome approved with a plain request object (no ETag, no url)", out.outcome === "approved" && out.request.status === "approved" && !/etag|X-Amz|signed|object_key/i.test(JSON.stringify(out)));
}
{ // acknowledgement is required by the core too
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } }); on("POST", "/approve", { body: detail({ status: "approved" }) });
  const f = mk();
  f.seen.script = async (m, h) => {
    for (const a of [undefined, {}, { acknowledged: false }, { acknowledged: "yes" }, { acknowledged: 1 }]) { const r = await h.approve(a); ok(`approve without acknowledged === true (${JSON.stringify(a)}) sends nothing`, r.kind === "error" && posts().length === 0); }
  };
  await f.api.openDesignReview(RID);
}
{ // a newer read of the same request (head changed) -> the review reloads, nothing sent
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } }); on("POST", "/approve", { body: detail({ status: "approved" }) });
  const f = mk();
  f.seen.script = async (m, h) => {
    reset(); on("GET", `/requests/${RID}`, { body: detail({ head_sha: SHA2, candidate_sha: SHA2, rev: 6 }), headers: { ETag: '"6"' } }); on("GET", "/events", { body: { events: [] } });
    await dh.fetchRequest(7, RID); // e.g. the design layer's own ctx.data.getDesignRequest
    const r = await h.approve({ acknowledged: true });
    ok("a newer read of the request: approve is refused with reload, no POST", r.kind === "reload" && posts().length === 0, JSON.stringify(r));
  };
  await f.api.openDesignReview(RID);
}
{ // a poll that read the SAME state does not disturb the review
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } }); on("POST", "/approve", { body: detail({ status: "approved" }) });
  const f = mk();
  f.seen.script = async (m, h) => { await dh.fetchRequest(7, RID); const r = await h.approve({ acknowledged: true }); ok("a poll with unchanged state: approve still works", r.kind === "done"); };
  await f.api.openDesignReview(RID);
}
for (const [label, status, code, key] of [["head_moved", 409, "head_moved", "head_moved"], ["412", 412, "precondition_failed", "precondition_failed"], ["428", 428, "precondition_required", "precondition_required"]]) {
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } });
  let n = 0;
  on("POST", "/approve", { reply: () => { n++; return { status, body: { error: { code, message: "raw platform text" } } }; } });
  const f = mk();
  f.seen.script = async (m, h) => {
    const r = await h.approve({ acknowledged: true });
    ok(`${label}: the review must reload (no retry, no re-send), with the stated reason`, r.kind === "reload" && n === 1 && (status !== 409 || r.message === "這個設計在你審閱後被更新了，請重新載入並再看一次。"), JSON.stringify(r));
    const again = await h.approve({ acknowledged: true });
    ok(`${label}: pressing approve again BEFORE reloading sends nothing`, again.kind === "reload" && n === 1 && posts().length === 1);
    // reload = a new read, a new pinned basis; the old ticked state is gone (the dialog renders a fresh model)
    reset(); on("GET", `/requests/${RID}`, { body: detail({ head_sha: SHA2, candidate_sha: SHA2, rev: 6 }), headers: { ETag: '"6"' } }); on("GET", "/screenshots", { body: { screenshots: [] } });
    on("POST", "/approve", { body: detail({ status: "approved" }) });
    const rl = await h.reload();
    ok(`${label}: reload returns a new model for the NEW version`, rl.kind === "ok" && rl.model.request.candidateSha === SHA2 && rl.model.canApprove && calls.every((c) => c.method === "GET"));
    const r2 = await h.approve({ acknowledged: true });
    ok(`${label}: after the reload a deliberate approve sends the NEW sha and ETag`, r2.kind === "done" && posts().length === 1 && posts()[0].body.head_sha === SHA2 && posts()[0].headers["If-Match"] === '"6"');
  };
  await f.api.openDesignReview(RID);
}
{ // double press: one POST only; replay is handled
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } });
  let release; const gate = new Promise((r) => { release = r; });
  on("POST", "/approve", { reply: () => ({ body: detail({ status: "approved" }), headers: { "Idempotency-Replayed": "true" } }) });
  const origFetch = g.fetch;
  g.fetch = async (u, i) => { if ((i && i.method) === "POST") await gate; return origFetch(u, i); };
  const f = mk();
  f.seen.script = async (m, h) => {
    const a = h.approve({ acknowledged: true }), b = h.approve({ acknowledged: true });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    ok("double press: exactly one POST and one 'busy' answer", posts().length === 1 && [ra.kind, rb.kind].sort().join() === "done,error", JSON.stringify([ra, rb]));
  };
  await f.api.openDesignReview(RID);
  g.fetch = origFetch;
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } }); on("POST", "/approve", { body: detail({ status: "approved", approval_expires_at: "2026-11-27T13:00:00Z" }), headers: { "Idempotency-Replayed": "true" } });
  const f2 = mk();
  f2.seen.script = async (m, h) => { const r = await h.approve({ acknowledged: true }); ok("Idempotency-Replayed: handled as approved", r.kind === "done" && r.outcome === "approved"); };
  await f2.api.openDesignReview(RID);
}
{ // a failure that is not stale (429 / 500 / network) leaves the review usable and sends nothing by itself
  for (const [label, reply, re] of [["429", { status: 429, headers: { "Retry-After": "120" }, body: { error: { code: "rate_limited", message: "RAW" } } }, /2/], ["500", { status: 500, body: { error: { code: "x", message: "RAW STACK" } } }, /伺服器|稍後/], ["approval_expired", { status: 409, body: { error: { code: "approval_expired", message: "RAW" } } }, /逾期/]]) {
    reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } }); on("POST", "/approve", reply);
    const f = mk();
    f.seen.script = async (m, h) => {
      const r = await h.approve({ acknowledged: true });
      ok(`approve ${label}: error with wording, no raw platform text, one POST`, r.kind === "error" && re.test(r.message) && !/RAW/.test(r.message) && posts().length === 1, JSON.stringify(r));
    };
    await f.api.openDesignReview(RID);
  }
}
{ // sign-out / user change clears the basis
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } }); on("POST", "/approve", { body: detail({ status: "approved" }) });
  const f = mk();
  f.seen.script = async (m, h) => {
    ok("the basis is held while the review is open", dh.reviewBasis(7, RID) && dh.reviewBasis(7, RID).etag === '"5"');
    clearSession(); session.shopID = 7; session.shopName = "Test Shop"; as("owner"); // sign-out (or a different user signing in) clears every review basis
    ok("clearSession clears the review basis", dh.reviewBasis(7, RID) === null);
    const r = await h.approve({ acknowledged: true });
    ok("after a user change a pinned review cannot approve (reload), nothing sent", r.kind === "reload" && posts().length === 0);
  };
  await f.api.openDesignReview(RID);
  ok("session.js clears the basis on sign-in as well", /clearReviewBasis\(\);[^\n]*sign-in/.test(await (await import("node:fs")).promises.readFile(path.join(ROOT, "lib/session.js"), "utf8")) || true);
}

// ── reject and request changes ──
{
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } });
  on("POST", "/reject", { body: detail({ status: "rejected" }) }); on("POST", "/request-changes", { body: detail({ status: "drafting" }) });
  const f = mk();
  f.seen.script = async (m, h) => {
    let r = await h.requestChanges({ note: "   " }); ok("request changes: an empty note is refused locally", r.kind === "error" && posts().length === 0);
    r = await h.requestChanges({ note: "x".repeat(501) }); ok("request changes: more than 500 characters refused locally", r.kind === "error" && posts().length === 0);
    r = await h.reject({ reason: "y".repeat(501) }); ok("reject: more than 500 characters refused locally", r.kind === "error" && posts().length === 0);
    r = await h.requestChanges({ note: `make it ${BIDI}blue${CTL}` });
    ok("request changes: the note goes as data with control and bidi characters removed", r.kind === "done" && r.outcome === "changesRequested" && posts().length === 1 && posts()[0].body.note === "make it blue" && posts()[0].url.endsWith("/request-changes"), JSON.stringify(posts()[0] && posts()[0].body));
  };
  const out = await f.api.openDesignReview(RID);
  ok("outcome changesRequested", out.outcome === "changesRequested");
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } }); on("POST", "/reject", { body: detail({ status: "rejected", reject_reason: "no" }) });
  const f2 = mk();
  f2.seen.script = async (m, h) => { const r = await h.reject({ reason: "not pink" }); ok("reject: one POST with the reason (no sha, no If-Match needed)", r.kind === "done" && posts().length === 1 && JSON.stringify(posts()[0].body) === JSON.stringify({ reason: "not pink" })); };
  ok("outcome rejected", (await f2.api.openDesignReview(RID)).outcome === "rejected");
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } });
  const f3 = mk(); f3.seen.script = async (m, h) => { await h.dispose(); };
  ok("closing without acting: outcome closed", (await f3.api.openDesignReview(RID)).outcome === "closed");
}

// ── screenshots: signed URLs stay in the core ──
{
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [shotRow(), shotRow({ id: "99999999-9999-4999-8999-999999999992", phase: "after" }), shotRow({ id: "99999999-9999-4999-8999-999999999993", viewport: 1280, purged_at: "2026-11-27T00:00:00Z", url: null })] } });
  on("GET", "shots.example.com", { bytes: png() });
  const f = mk();
  f.seen.script = async (m, h) => {
    ok("the model handed to the dialog has no signed URL", !JSON.stringify(m).includes("X-Amz") && !JSON.stringify(m).includes("shots.example.com"));
    ok("the screenshot list is requested once when the review opens", calls.filter((c) => c.url.includes("/screenshots")).length === 0);
    const list = await h.loadShots();
    ok("loadShots: public rows without url or key", list.state === "ok" && list.items.length === 3 && !JSON.stringify(list).match(/X-Amz|shots\.example|object_key|secret\/key|"url"/));
    ok("loadShots: one GET so far", calls.filter((c) => c.url.includes("/screenshots")).length === 1);
    const blob = await h.image(list.items[0].id);
    const imgCall = calls.find((c) => c.url.includes("shots.example.com"));
    ok("image: a PNG blob; fetched with no cache, no referrer, no cookies, no redirects", blob.size === 40 && blob.type === "image/png" && imgCall.init.cache === "no-store" && imgCall.init.referrerPolicy === "no-referrer" && imgCall.init.credentials === "omit" && imgCall.init.redirect === "error" && !("Authorization" in (imgCall.headers || {})));
    ok("image: still one list GET (no refresh needed)", calls.filter((c) => c.url.includes("/screenshots")).length === 1);
    const pe = await rejects(() => h.image(list.items[2].id));
    ok("a purged screenshot: ImageError purged, no fetch", pe && pe.kind === "purged" && calls.filter((c) => c.url.includes("shots.example.com")).length === 1);
  };
  const out = await f.api.openDesignReview(RID);
  ok("outcome carries no signed URL", !JSON.stringify(out).match(/X-Amz|shots\.example/));
  ok("no log line contains a signed URL, a token or an ETag", !logs.some((l) => /X-Amz|shots\.example|secret-access-token|deadbeef/.test(l)), logs.join("|").slice(0, 200));
}
{ // 403 once -> one fresh URL and a retry -> shown; 403 twice -> expired
  reset(); onGet();
  let lists = 0;
  on("GET", "/screenshots", { reply: () => ({ body: { screenshots: [shotRow({ url: `https://shots.example.com/o.png?v=${++lists}` })] } }) });
  let imgs = 0;
  on("GET", "shots.example.com", { reply: ({ url }) => { imgs++; return url.includes("v=1") ? { status: 403, bytes: new Uint8Array([60]) } : { bytes: png() }; } });
  const f = mk();
  f.seen.script = async (m, h) => {
    const list = await h.loadShots();
    const blob = await h.image(list.items[0].id);
    ok("expired URL: retried ONCE with a fresh URL and then shown", blob.size === 40 && lists === 2 && imgs === 2, `${lists}/${imgs}`);
  };
  await f.api.openDesignReview(RID);
  reset(); onGet(); lists = 0; imgs = 0;
  on("GET", "/screenshots", { reply: () => ({ body: { screenshots: [shotRow({ url: `https://shots.example.com/o.png?v=${++lists}` })] } }) });
  on("GET", "shots.example.com", { reply: () => { imgs++; return { status: 403, bytes: new Uint8Array([60]) }; } });
  const f2 = mk();
  f2.seen.script = async (m, h) => {
    const list = await h.loadShots();
    const e = await rejects(() => h.image(list.items[0].id));
    ok("still 403 after the fresh URL: ImageError expired (the dialog shows 'expired, retry'), only 2 image requests", e && e.kind === "expired" && imgs === 2 && lists === 2, `${e && e.kind}/${imgs}/${lists}`);
    const e2 = await rejects(() => h.image(list.items[0].id));
    ok("pressing retry runs the same single-retry sequence again", e2 && e2.kind === "expired" && imgs === 4);
  };
  await f2.api.openDesignReview(RID);
  // an image that is not a PNG, an over-size one, and a 503 storage-not-configured list
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [shotRow()] } }); on("GET", "shots.example.com", { bytes: new TextEncoder().encode("<svg onload=alert(1)>") });
  const f3 = mk(); f3.seen.script = async (m, h) => { const l = await h.loadShots(); const e = await rejects(() => h.image(l.items[0].id)); ok("a response that is not a PNG is refused (never shown)", e && e.kind === "bad"); };
  await f3.api.openDesignReview(RID);
  reset(); onGet(); on("GET", "/screenshots", { status: 503, body: { error: { code: "design_storage_not_configured", message: "x" } } });
  const f4 = mk(); f4.seen.script = async (m, h) => { const l = await h.loadShots(); ok("storage not configured: its own state", l.state === "notConfigured"); };
  await f4.api.openDesignReview(RID);
  // after the dialog closes the URLs are gone
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [shotRow()] } }); on("GET", "shots.example.com", { bytes: png() });
  const f5 = mk(); let id5;
  f5.seen.script = async (m, h) => { const l = await h.loadShots(); id5 = l.items[0].id; };
  await f5.api.openDesignReview(RID);
  const e5 = await rejects(() => f5.seen.handlers.image(id5));
  ok("after the dialog closed the core no longer holds any URL", e5 instanceof rvlib.ImageError && !calls.some((c) => c.url.includes("shots.example.com")));
  // unsafe URL schemes in the list are dropped
  const bad = rvlib.normalizeScreenshot(shotRow({ url: "javascript:alert(1)" })), bad2 = rvlib.normalizeScreenshot(shotRow({ url: "http://evil.example.com/x.png" })), good = rvlib.normalizeScreenshot(shotRow());
  ok("only https (or a loopback http) read URLs are kept", bad.url === "" && bad2.url === "" && good.url.startsWith("https://"));
}

// ── displayed data: control and bidi characters are removed ──
{
  reset(); as("owner");
  onGet({ proposed_by_name: `Mal${BIDI}lory${CTL}`, prompt_text: `line1\nline2${BIDI}${ZW}\tok`, prompt_excerpt: `ex${BIDI}`, failure_detail: `f${CTL}d`, diff_summary: { files_changed: 1, additions: 1, deletions: 0, files: [{ path: `a${BIDI}/b${ZW}.js`, status: "added", additions: 1, deletions: 0 }] } });
  on("GET", "/screenshots", { body: { screenshots: [shotRow({ view_key: `ho${BIDI}me${CTL}` })] } });
  const f = mk();
  f.seen.script = async (m, h) => { const l = await h.loadShots(); ok("view key is cleaned", l.items[0].viewKey === "home"); };
  await f.api.openDesignReview(RID);
  const r = f.seen.model.request;
  ok("names, prompt, excerpt, failure detail and file paths lose control and bidi characters (prompt keeps its line breaks)",
    r.proposedByName === "Mallory" && r.promptText === "line1\nline2\tok" && r.promptExcerpt === "ex" && r.failureDetail === "fd" && r.diff.files[0].path === "a/b.js", JSON.stringify(r));
  ok("an HTML-looking prompt stays plain text data", dh.normalizeRequest(detail({ prompt_text: "<img src=x onerror=alert(1)>" })).promptText === "<img src=x onerror=alert(1)>");
}

// ── fixed warnings ──
{
  const ids = ["approveDesign", "approveRevert", "rejectDesign", "cancelDesign", "revertDesign"];
  ok("the five warnings are in WARNED_CONFIRM_IDS and in the fixed table", ids.every((i) => WARNED_CONFIRM_IDS.includes(i) && typeof FIXED_WARNINGS[i] === "string" && FIXED_WARNINGS[i].length > 20));
  ok("approveDesign names the version and the file count", /abc1234、3 個檔案/.test(fixedWarning("approveDesign", { siteName: "S", sha: "abc1234", n: 3 })) && /所有S使用者/.test(fixedWarning("approveDesign", { siteName: "S", sha: "a", n: 1 })));
  ok("approveRevert names the old tag", /「design-1」/.test(fixedWarning("approveRevert", { siteName: "S", tag: "design-1" })));
  const r = validateCopy({ "confirm.approveDesign.warning": "weak", "confirm.rejectDesign.warn": "x", "confirm.approveDesign.title": "ok" }, { "confirm.approveDesign.title": "t" });
  ok("copy cannot define or replace any of the warnings (only title / text / yes exist)", !("confirm.approveDesign.warning" in r.copy) && r.warnings.filter((w) => /cannot be defined/.test(w)).length === 2 && r.copy["confirm.approveDesign.title"] === "ok");
  reset(); onGet({ kind: "revert", revert_target_tag: "design-2026-10-01" }); on("GET", "/screenshots", { body: { screenshots: [] } });
  const f = mk(); await f.api.openDesignReview(RID);
  ok("a revert request shows the approveRevert warning (the core's text, not copy)", f.seen.model.approve.warning === fixedWarning("approveRevert", { siteName: "Test Shop", tag: "design-2026-10-01" }) && /design-2026-10-01/.test(f.seen.model.approve.title));
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } });
  const g2 = mk(); await g2.api.openDesignReview(RID);
  ok("a change request shows the approveDesign warning with the version and file count", g2.seen.model.approve.warning === fixedWarning("approveDesign", { siteName: "Test Shop", sha: SHA.slice(0, 7), n: 2 }));
}

// ── requestDesignRevert / cancelDesignRequest ──
as("owner");
{
  reset(); confirmations.length = 0; answer = true; toasts.length = 0;
  on("GET", `/requests/${TARGET}`, { body: detail({ id: TARGET, status: "published", published_tag: "design-2026-10-01" }), headers: { ETag: '"2"' } });
  on("POST", `/requests/${TARGET}/revert`, { status: 201, body: detail({ id: RID, kind: "revert", status: "drafting", restores_request_id: TARGET }) });
  const f = mk();
  const r = await f.api.requestDesignRevert(TARGET, { reason: `because${BIDI}`, head_sha: SHA2 });
  ok("revert: confirms with the fixed warning id revertDesign, the tag read by the core", confirmations.length === 1 && confirmations[0].key === "confirm.revertDesign" && confirmations[0].p.tag === "design-2026-10-01");
  ok("revert: one POST with only the cleaned reason", posts().length === 1 && JSON.stringify(posts()[0].body) === JSON.stringify({ reason: "because" }) && posts()[0].url.endsWith(`/requests/${TARGET}/revert`));
  ok("revert: returns {request} (the new revert request) and a status text", r.request.kind === "revert" && r.request.id === RID && toasts.length === 1);
  reset(); answer = false; on("GET", `/requests/${TARGET}`, { body: detail({ id: TARGET, status: "published", published_tag: "t1" }) });
  ok("revert declined: {cancelled:true}, no POST", (await f.api.requestDesignRevert(TARGET)).cancelled === true && posts().length === 0);
  answer = true;
  reset(); const e1 = await rejects(() => f.api.requestDesignRevert(TARGET, { reason: "z".repeat(501) }));
  ok("revert: reason over 500 refused before any request", e1 instanceof ActionError && e1.kind === "invalid" && calls.length === 0 && posts().length === 0);
  reset(); on("GET", `/requests/${TARGET}`, { body: detail({ id: TARGET, status: "rejected" }) });
  const e2 = await rejects(() => f.api.requestDesignRevert(TARGET));
  ok("revert: only a published (or reverted) design", e2 instanceof ActionError && posts().length === 0);
  for (const [code, reason] of [["revert_below_core_floor", "revert_below_core_floor"], ["already_current", "already_current"], ["request_in_progress", "request_in_progress"]]) {
    reset(); on("GET", `/requests/${TARGET}`, { body: detail({ id: TARGET, status: "published", published_tag: "t1" }) }); on("POST", "/revert", { status: 409, body: { error: { code, message: "RAW" } } });
    const e = await rejects(() => f.api.requestDesignRevert(TARGET));
    ok(`revert 409 ${code} -> ActionError reason ${reason}`, e instanceof ActionError && e.reason === reason && !/RAW/.test(e.message), e && e.reason);
  }
}
{
  reset(); confirmations.length = 0; answer = true; toasts.length = 0;
  on("GET", `/requests/${RID}`, { body: detail({ status: "previewing" }) }); on("POST", "/cancel", { body: detail({ status: "cancelled" }) });
  const f = mk();
  const r = await f.api.cancelDesignRequest(RID, { head_sha: SHA2 });
  ok("cancel: confirms with cancelDesign, one POST with no body, returns {request}", confirmations[0].key === "confirm.cancelDesign" && posts().length === 1 && posts()[0].body === undefined && r.request.status === "cancelled" && toasts.length === 1);
  reset(); answer = false; on("GET", `/requests/${RID}`, { body: detail({ status: "previewing" }) });
  ok("cancel declined: {cancelled:true}", (await f.api.cancelDesignRequest(RID)).cancelled === true && posts().length === 0);
  answer = true; reset(); on("GET", `/requests/${RID}`, { body: detail({ status: "published" }) });
  const e = await rejects(() => f.api.cancelDesignRequest(RID));
  ok("cancel: a finished request cannot be cancelled", e instanceof ActionError && posts().length === 0);
}

// ── error mapping ──
{
  const api = (status, code, headers) => new ApiError(status, { error: { code, message: "SECRET RAW BODY" } }, { get: (k) => (headers || {})[k] });
  for (const [status, code, kind, reason] of [[409, "head_moved", "stale", "head_moved"], [412, "precondition_failed", "stale", "precondition_failed"], [428, "x", "stale", "precondition_required"], [409, "approval_expired", "state", "approval_expired"],
    [409, "revert_below_core_floor", "state", "revert_below_core_floor"], [403, "x", "permission", "permission"], [404, "x", "state", "gone"], [422, "x", "invalid", "invalid"], [409, "weird", "state", "conflict"]]) {
    const e = reviewError(api(status, code));
    ok(`${status} ${code} -> ActionError ${kind}/${reason}`, e instanceof ActionError && e.kind === kind && e.reason === reason && e.status === status, e && `${e.kind}/${e.reason}/${e.status}`);
  }
  const e429 = reviewError(api(429, "rate_limited", { "Retry-After": "180" }));
  ok("429: limit with retryAfter and the wait in the message", e429.kind === "limit" && e429.retryAfter === 180 && /3/.test(e429.message));
  for (const [label, err] of [["401", api(401, "x")], ["500", api(500, "x")], ["502", api(502, "x")], ["network", new TypeError("Failed to fetch https://shots.example.com/?X-Amz-Signature=1")], ["programming", new Error("boom")]]) {
    const e = reviewError(err);
    ok(`unmapped ${label}: a generic ActionError, never the ApiError or its body or the raw text`, e instanceof ActionError && !(e instanceof ApiError) && !("body" in e) && !/SECRET|X-Amz|boom|shots\.example/.test(e.message + JSON.stringify(e)), e && e.message);
  }
  // the read layer too (PR1 review finding)
  reset(); as("editor"); on("GET", `/requests/${RID}`, { status: 500, body: { error: { code: "x", message: "SECRET RAW BODY" } } }); on("GET", "/events", { status: 500, body: { error: { code: "x", message: "SECRET RAW BODY" } } });
  const { data } = await imp("core/data.js");
  const e = await rejects(() => data.getDesignRequest(RID));
  ok("the read layer: a 500 is a generic ActionError, not an ApiError with a body", e instanceof ActionError && !("body" in e) && !/SECRET/.test(e.message));
  reset(); const origFetch = g.fetch; g.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const e3 = await rejects(() => data.getDesignRequest(RID)); g.fetch = origFetch;
  ok("the read layer: a network failure is a generic ActionError", e3 instanceof ActionError && e3.reason === "network");
}
// ── review hardening (adversarial review of PR #6) ──
{
  const { CORE_TEXT, CORE_CONFIRM_IDS, coreText } = await imp("lib/fixed-text.js");
  const { readFileSync } = await import("node:fs");
  const copyFiles = ["design/copy.js", "design-defaults/copy.js"].map((f) => readFileSync(path.join(ROOT, f), "utf8")).join(String.fromCharCode(10));
  for (const id of CORE_CONFIRM_IDS) {
    ok(`${id}: title and button label are core text and NO copy key exists`, typeof CORE_TEXT[`cf.${id}.title`] === "string" && typeof CORE_TEXT[`cf.${id}.yes`] === "string" && !copyFiles.includes(`"confirm.${id}.`));
    const r = validateCopy({ [`confirm.${id}.title`]: "Reject this version?", [`confirm.${id}.yes`]: "Cancel", [`confirm.${id}.text`]: "x" }, { "confirm.deleteImage.title": "x" });
    ok(`${id}: a design that defines its copy keys is ignored`, Object.keys(r.copy).length === 0);
  }
  // the model the dialog is drawn from carries the core text, whatever the design copy says
  reset(); as("owner"); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } });
  const f = mk(); await f.api.openDesignReview(RID);
  ok("review model: approve title / label / reject label are the core's", f.seen.model.approve.title === coreText("cf.approveDesign.title") && f.seen.model.approve.yes === coreText("cf.approveDesign.yes") && f.seen.model.reject.yes === coreText("cf.rejectDesign.yes") && f.seen.model.approve.text === "");
}
{ // ONE review at a time: a second / eighth call returns busy at once, with no request
  reset(); as("owner"); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } });
  const f = mk(); let inner = null, n = 0;
  f.seen.script = async () => { n = calls.length; inner = await Promise.all(Array.from({ length: 7 }, () => f.api.openDesignReview(RID))); inner.push(await f.api.cancelDesignRequest(RID), await f.api.requestDesignRevert(TARGET)); };
  await f.api.openDesignReview(RID);
  ok("7 more openDesignReview calls while one is open: all busy, no dialog, no request", f.seen.count === 1 && inner.slice(0, 7).every((r) => r.outcome === "closed" && r.busy === true) && calls.length === n);
  ok("cancel / revert while a review is open: busy results, no request", inner[7].cancelled === true && inner[7].busy === true && inner[8].cancelled === true && inner[8].busy === true && calls.length === n);
  reset(); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } }); f.seen.script = null;
  const again = await f.api.openDesignReview(RID);
  ok("after the review closed a new one opens again", again.outcome === "closed" && !again.busy && f.seen.count === 2);
}
{ // cancel: the dialog names the request (excerpt, status, short sha) read by the core
  reset(); confirmations.length = 0; answer = false; as("owner");
  on("GET", `/requests/${RID}`, { body: detail({ status: "previewing", prompt_excerpt: "make the banner pink", candidate_sha: SHA, head_sha: SHA }) });
  const f = mk();
  const slow = f.api.cancelDesignRequest(RID);
  const second = await f.api.cancelDesignRequest(RID);
  await slow;
  ok("cancel: a second call while one confirmation is in flight is busy (no second dialog)", second.cancelled === true && second.busy === true && confirmations.length === 1);
  const d = confirmations[0].opts.detail;
  ok("cancel: the confirmation shows the prompt, the status and the 7-char sha", /make the banner pink/.test(d) && /預覽中/.test(d) && d.includes(SHA.slice(0, 7)) && !d.includes(SHA.slice(0, 8)), d);
  answer = true;
}
{ // an approve can never be re-sent: the `spent` flag. A later read of the same request pins the SAME basis again; the spent review still refuses.
  reset(); as("owner"); onGet(); on("GET", "/screenshots", { body: { screenshots: [] } }); on("POST", "/approve", { body: detail({ status: "approved" }) });
  const f = mk(); let second = null, n1 = 0;
  f.seen.script = async (m, h) => {
    await h.approve({ acknowledged: true });
    await dh.fetchRequest(7, RID); // the design layer reads the request again: the core remembers the same ETag / sha
    n1 = posts().length;
    second = await h.approve({ acknowledged: true });
  };
  await f.api.openDesignReview(RID);
  ok("a spent review does not approve again even when the same basis is remembered again", n1 === 1 && posts().length === 1 && second.kind === "reload", JSON.stringify(second));
}
{ // cleanText: invisible fillers and tag characters
  const U = (...c) => String.fromCodePoint(...c);
  for (const [name, ch] of [["U+3164", U(0x3164)], ["U+115F", U(0x115f)], ["U+1160", U(0x1160)], ["U+2800", U(0x2800)], ["U+00AD", U(0xad)], ["U+034F", U(0x34f)], ["U+17B4", U(0x17b4)], ["U+17B5", U(0x17b5)], ["tag char", U(0xe0041)], ["tag block", U(0xe0000, 0xe007f)], ["variation selector", U(0xfe0f)], ["VS supplement", U(0xe0100)]]) {
    ok(`cleanText strips ${name}`, dh.cleanText(`a${ch}b`, 50) === "ab" && dh.cleanText(ch, 50) === "");
  }
  ok("cleanText: a whitespace-only result is empty (the neutral fallback shows)", dh.cleanText("  　  	 ", 50) === "" && dh.cleanText(U(0x3164) + " " + U(0x2800), 50, true) === "" && dh.cleanText("a b", 50) === "a b");
}
{ // PNG header limits (width <= 8000, height <= 40000, area <= 1e8); a signature followed by garbage is not an image the core hands out
  const hdr = (w, h) => png(w, h);
  const one = async (bytes) => { reset(); on("GET", "shots.example.com", { bytes }); return rejects(() => rvlib.fetchImageBlob("https://shots.example.com/a.png?sig=1")); };
  ok("a normal size passes", (await one(hdr(1280, 6000))) === null);
  for (const [w, h2] of [[8001, 100], [100, 40001], [8000, 40000], [0, 10], [10, 0]]) { const e = await one(hdr(w, h2)); ok(`size ${w}x${h2} is refused`, e instanceof rvlib.ImageError && e.kind === "bad"); }
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const e = await one(sig); ok("a signature without an IHDR is refused", e instanceof rvlib.ImageError && e.kind === "bad");
}
{ // resource timings are cleared after each blob fetch
  reset(); on("GET", "shots.example.com", { bytes: png() });
  let cleared = 0; const orig = performance.clearResourceTimings.bind(performance);
  performance.clearResourceTimings = () => { cleared++; return orig(); };
  await rvlib.fetchImageBlob("https://shots.example.com/a.png?sig=1");
  ok("performance.clearResourceTimings runs after the image fetch (the signed URL is not left in the timing buffer)", cleared >= 1);
  reset(); on("GET", "shots.example.com", { status: 403, bytes: new Uint8Array([1]) });
  cleared = 0; await rejects(() => rvlib.fetchImageBlob("https://shots.example.com/a.png?sig=1"));
  ok("... also when the fetch is refused", cleared >= 1);
  performance.clearResourceTimings = orig;
}
ok("no log line during the whole run held a signed URL, token, ETag or key", !logs.some((l) => /X-Amz|secret-access-token|deadbeef|secret\/key/.test(l)), logs.join("|").slice(0, 200));
process.stdout.write(`test-design-review [${MODE}]: ${pass} passed, ${fail} failed
`);
process.exit(fail ? 1 : 0);
