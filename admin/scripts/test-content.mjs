#!/usr/bin/env node
// Offline tests of the content-store core (no network, no browser, no dependencies). Run: node scripts/test-content.mjs
// (scripts/test-guard.mjs runs it too). A stubbed fetch records every request, so the tests prove:
//   * exact request headers (If-Match quoting, If-None-Match: *), 412 / 428 / 422 mapping, ETag parsing;
//   * permission gating inside every function (staff and editor), before any request;
//   * the dry run only ever sends ?dry_run=true;
//   * registerContentSchema sends NO registering request unless the (injected) human confirmation resolved true, ignores
//     any argument, and needs a second confirmation before confirm_removals;
//   * the locked validation (required, link scheme, image domain, color, array limits, block unions) and its use before a save.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const g = globalThis;
const store = new Map();
g.window = { ADMIN_CONFIG: { siteOrigin: "http://localhost:8788" }, scrollTo() {}, addEventListener() {}, open: () => null };
g.location = { hostname: "localhost", origin: "http://localhost:3001", hash: "", href: "http://localhost:3001/", reload() {} };
g.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
g.document = { createElement: () => ({}), body: {}, head: {} };
g.history = { replaceState() {} };
const imp = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) pass++; else { fail++; console.error(`  FAIL ${name} ${extra}`); } };
const rejects = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ── fetch stub ──
const calls = [];
let routes = [];
g.fetch = async (url, init = {}) => {
  const u = String(url);
  const rec = { method: init.method || "GET", url: u, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
  calls.push(rec);
  const r = routes.find((x) => x.method === rec.method && (x.match instanceof RegExp ? x.match.test(u) : u.includes(x.match)));
  if (!r) return new Response(JSON.stringify({ error: { code: "not_found", message: `no stub for ${rec.method} ${u}` } }), { status: 404, headers: { "content-type": "application/json" } });
  const out = typeof r.reply === "function" ? r.reply(rec) : r.reply;
  return new Response(out.status === 204 ? null : (out.body === undefined ? "" : JSON.stringify(out.body)), { status: out.status || 200, headers: { "content-type": "application/json", ...(out.headers || {}) } });
};
const on = (method, match, reply) => routes.unshift({ method, match, reply });
const reset = () => { calls.length = 0; routes = []; };
const puts = () => calls.filter((c) => c.method === "PUT" && /\/content\/schema/.test(c.url));

// ── load the real modules ──
const { tokens } = await imp("lib/api.js");
const { session } = await imp("lib/session.js");
const { setPermissions } = await imp("lib/perm.js");
const { loadDesign } = await imp("lib/design.js");
const C = await imp("lib/content.js");
const S = await imp("lib/content-schema.js");
const CA = await imp("core/content-actions.js");
const { data } = await imp("core/data.js");
const { NAV, ROUTES } = await imp("core/routes.js");
const { WARNED_CONFIRM_IDS } = await imp("lib/design-schema.js");
const { fixedWarning } = await imp("core/warnings.js");
const defaults = (await imp("design-defaults/copy.js")).default;
const origWarn = console.warn;
console.warn = () => {};
await loadDesign();
console.warn = origWarn;
tokens.set({ access_token: "test-token" });
session.shopID = 1;

const asked = [];
let answers = [];
const actions = CA.createContentActions({ ask: async (key, params, opts) => { asked.push({ key, params, opts }); return answers.length ? answers.shift() : true; } });
const perms = { staff: [], editor: ["content.view", "content.edit"], owner: ["content.view", "content.edit", "content.publish", "content.manage"] };
const as = (who) => setPermissions(perms[who]);

const schemaNode = {
  type: "object", additionalProperties: false, required: ["title", "sections"],
  properties: {
    title: { type: "string", maxLength: 20, minLength: 1, default: "x", "x-editor-order": 0 },
    link: { type: "string", maxLength: 200, default: "", "x-editor": "link" },
    img: { type: "string", maxLength: 200, default: "", "x-editor": "image" },
    color: { type: "string", maxLength: 7, default: "#000000", "x-editor": "color" },
    tag: { type: "string", maxLength: 10, default: "a", enum: ["a", "b"], "x-editor": "select" },
    items: { type: "array", maxItems: 2, items: { type: "string", maxLength: 5, default: "" }, default: [] },
    sections: { type: "array", maxItems: 3, default: [], "x-editor": "sections", items: { oneOf: [
      { type: "object", additionalProperties: false, required: ["type", "text"], properties: { type: { const: "hero" }, text: { type: "string", maxLength: 10, default: "" } } },
    ] } },
  },
};
const goodContent = { title: "Hi", link: "/a", img: "", color: "#aabbcc", tag: "a", items: ["x"], sections: [{ type: "hero", text: "t" }] };
const docBody = (over = {}) => ({ key: "home", type_key: "home", title: "Home", status: 0, needs_attention: false, declared: true, draft_rev: 4, published_rev: 0, schema_version: 1, published_schema_version: 0, updated_at: "2026-11-25T00:00:00Z", published_at: null, updated_by_user_id: 1, draft: goodContent, published: null, meta: {}, schema_node: schemaNode, type_title: "Home", ...over });

// ── 1. ETag helpers ──
ok("parseEtag handles quoted and weak tags", C.parseEtag('"7"') === 7 && C.parseEtag('W/"12"') === 12 && C.parseEtag("7") === null && C.parseEtag("") === null && C.parseEtag(null) === null);
ok("etagOf quotes the revision", C.etagOf(3) === '"3"');

// ── 2. request shape ──
as("owner");
reset();
on("GET", "/content/documents/home", { body: docBody() });
on("PUT", "/content/documents/home", (r) => ({ status: 200, headers: { ETag: '"5"' }, body: docBody({ draft_rev: 5 }) }));
let res = await actions.saveContentDocument("home", goodContent, { rev: 4 });
ok("update sends If-Match with the quoted loaded revision", calls.find((c) => c.method === "PUT")?.headers["If-Match"] === '"4"' && !("If-None-Match" in calls.find((c) => c.method === "PUT").headers), JSON.stringify(calls.map((c) => c.headers)));
ok("the stored document comes back (rev from the ETag header), ready to rebuild the form", res.ok && res.doc.rev === 5 && res.doc.draft.title === "Hi");
ok("the body carries only content (no title, no meta unless given)", JSON.stringify(Object.keys(calls.find((c) => c.method === "PUT").body)) === '["content"]');
reset();
on("GET", "/content/schema", { body: { version: 1, format: 2, sha256: "x", source: "api", created_at: "2026-11-25T00:00:00Z", schema: { types: { campaign: { title: "C", schema: schemaNode } } } } });
on("PUT", "/content/documents/campaign-a", { status: 201, headers: { ETag: '"1"' }, body: docBody({ key: "campaign-a", draft_rev: 1 }) });
res = await actions.saveContentDocument("campaign-a", goodContent, { create: true, typeKey: "campaign" });
const cput = calls.find((c) => c.method === "PUT");
ok("create sends If-None-Match: * and no If-Match, and the type key", cput.headers["If-None-Match"] === "*" && !("If-Match" in cput.headers) && cput.body.type_key === "campaign");
reset();
let e = await rejects(() => actions.saveContentDocument("home", goodContent, {}));
ok("an update without a revision is refused before any request (428 can never be our doing)", e && e.kind === "internal" && calls.length === 0);
e = await rejects(() => C.saveDocument(1, "home", { content: {} }, {}));
ok("lib refuses to PUT without a precondition", e && /revision is required/.test(e.message) && calls.length === 0);
reset();
e = await rejects(() => actions.saveContentDocument("../x", goodContent, { rev: 1 }));
ok("an invalid key never reaches the network", e && e.status === 404 && calls.length === 0);

// ── 3. error mapping ──
reset();
on("GET", "/content/documents/home", { headers: { ETag: '"4"' }, body: docBody() });
on("PUT", "/content/documents/home", { status: 412, body: { error: { code: "precondition_failed", message: "stale", details: { current_rev: 9 } } } });
e = await rejects(() => actions.saveContentDocument("home", goodContent, { rev: 4 }));
ok("412 -> ActionError kind stale (with the current revision), status 412", e && e.isActionError && e.kind === "stale" && e.status === 412 && e.currentRev === 9 && /重新載入/.test(e.message), JSON.stringify(e));
reset();
on("GET", "/content/documents/home", { body: docBody() });
on("PUT", "/content/documents/home", { status: 428, body: { error: { code: "precondition_required", message: "need If-Match" } } });
const origErr = console.error; console.error = () => {};
e = await rejects(() => actions.saveContentDocument("home", goodContent, { rev: 4 }));
console.error = origErr;
ok("428 -> kind internal (never shown as a user error)", e && e.kind === "internal" && e.status === 500);
reset();
on("GET", "/content/documents/home", { body: docBody() });
on("PUT", "/content/documents/home", { status: 422, body: { error: { code: "validation_failed", message: "invalid", details: [{ pointer: "/title", message: "too long" }, { pointer: "/sections/0/text", message: "bad" }] } } });
e = await rejects(() => actions.saveContentDocument("home", goodContent, { rev: 4 }));
ok("422 -> kind invalid with JSON-pointer fields", e && e.kind === "invalid" && e.fields["/title"] && e.fields["/sections/0/text"], JSON.stringify(e?.fields));
ok("a leading /content in a pointer is tolerated", S.mapServerDetails([{ pointer: "/content/title", message: "x" }], schemaNode)["/title"] !== undefined);
ok("a field called content is not stripped", S.mapServerDetails([{ pointer: "/content/title", message: "x" }], { properties: { content: {} } })["/content/title"] !== undefined);
reset();
on("GET", "/content/documents/home", { body: docBody() });
on("PUT", "/content/documents/home", { status: 403, body: { error: { code: "forbidden", message: "no" } } });
e = await rejects(() => actions.saveContentDocument("home", goodContent, { rev: 4 }));
ok("403 -> permission ActionError", e && e.kind === "permission");

// ── 4. validation runs in the core before any save ──
reset();
on("GET", "/content/documents/home", { body: docBody() });
on("PUT", "/content/documents/home", { status: 200, body: docBody() });
const bad = { ...goodContent, title: "", link: "javascript:alert(1)", img: "http://evil.example/x.png", color: "red", tag: "z", items: ["a", "b", "c"], sections: [{ type: "nope" }] };
e = await rejects(() => actions.saveContentDocument("home", bad, { rev: 4 }));
ok("invalid values are refused locally with every field named, and nothing is PUT", e && e.kind === "invalid" && calls.every((c) => c.method !== "PUT")
  && ["/title", "/link", "/img", "/color", "/tag", "/items", "/sections/0"].every((p) => e.fields[p]), JSON.stringify(e?.fields));
const missing = { ...goodContent }; delete missing.title;
e = await rejects(() => actions.saveContentDocument("home", missing, { rev: 4 }));
ok("a required field cannot be omitted from the saved content", e && e.kind === "invalid" && e.fields["/title"] && calls.every((c) => c.method !== "PUT"));
ok("validate: good content passes", Object.keys(S.validate(schemaNode, goodContent, { root: schemaNode })).length === 0);
ok("link: https, http, mailto, tel, /path and #anchor pass; javascript:, data:, //host and spaces fail", ["https://a.b/c", "http://a.b", "mailto:a@b.c", "tel:+886", "/x", "#y", ""].every(S.linkOK) && ["javascript:x", "data:text/html,x", "//evil.example", "https:// a", "ftp://a.b"].every((v) => !S.linkOK(v)));
ok("link: no backslash anywhere, no /\host, no leading backslash, no protocol-relative (same as the storefront safeHref)", ["/\\evil.example", "\\evil", "/a\\b", "https://a.b/c\\d", "//x", "a\\b", "#a\\b"].every((v) => !S.linkOK(v)));
ok("image without a configured image domain accepts only the empty value (the storefront only trusts catalogue/imageOrigin hosts)", S.imageOK("", "") && !S.imageOK("https://anything.example/a.webp", "") && !S.imageOK("https://anything.example/a.webp"));
ok("image: no credentials, no http, no whitespace/backslash even under the prefix", !S.imageOK("https://u:p@img.example.com/a", "https://img.example.com") && !S.imageOK("https://img.example.com/a\\b", "https://img.example.com"));
ok("image: only under the configured image domain (with the trailing slash), or empty", S.imageOK("https://img.example.com/a.webp", "https://img.example.com") && !S.imageOK("https://img.example.com.evil.test/a.webp", "https://img.example.com") && S.imageOK("", "https://img.example.com") && !S.imageOK("http://img.example.com/a", "https://img.example.com"));
ok("color: #RRGGBB only", S.colorOK("#a1B2c3") && !S.colorOK("#abc") && !S.colorOK("blue"));
ok("requiredPointers lists required properties, recursively through required objects", JSON.stringify(S.requiredPointers({ type: "object", required: ["a"], properties: { a: { type: "object", required: ["b"], properties: { b: { type: "string" }, c: { type: "string" } } }, d: { type: "string" } } })) === '["/a","/a/b"]');
ok("nodeAt resolves nested pointers and $ref", S.nodeAt({ type: "object", $defs: { x: { type: "string", title: "T" } }, properties: { a: { $ref: "#/$defs/x" } } }, "/a")?.title === "T");
ok("hydrate fills missing required properties with defaults", S.hydrate(schemaNode, { title: "k" }).sections.length === 0 && S.hydrate(schemaNode, {}).title === "x");

ok("hydrate drops keys the schema does not declare (a legacy draft stays savable)", !("legacy" in S.hydrate(schemaNode, { title: "k", legacy: [1] })) && S.hydrate({ type: "object", properties: { a: { type: "object", properties: { b: { type: "string", default: "" } } } } }, { a: { b: "1", c: 2 } }).a.c === undefined);

// ── 5. permission gating (inside every function, before any request) ──
const gated = [
  ["data.getContentSchema", () => data.getContentSchema(), "staff"],
  ["data.listContentDocuments", () => data.listContentDocuments(), "staff"],
  ["data.getContentDocument", () => data.getContentDocument("home"), "staff"],
  ["data.listContentRevisions", () => data.listContentRevisions("home"), "staff"],
  ["data.getContentRevision", () => data.getContentRevision("home", 1), "staff"],
  ["data.dryRunContentSchema (editor)", () => data.dryRunContentSchema(), "editor"],
  ["data.dryRunContentSchema (staff)", () => data.dryRunContentSchema(), "staff"],
  ["actions.saveContentDocument (staff)", () => actions.saveContentDocument("home", goodContent, { rev: 1 }), "staff"],
  ["actions.publishContentDocument (editor)", () => actions.publishContentDocument("home", { rev: 1 }), "editor"],
  ["actions.unpublishContentDocument (editor)", () => actions.unpublishContentDocument("home"), "editor"],
  ["actions.deleteContentDocument (editor)", () => actions.deleteContentDocument("home"), "editor"],
  ["actions.restoreContentRevision (staff)", () => actions.restoreContentRevision("home", 1), "staff"],
  ["actions.uploadContentImage (staff)", () => actions.uploadContentImage({}), "staff"],
  ["actions.previewContentDocument (staff)", () => actions.previewContentDocument("home"), "staff"],
  ["actions.registerContentSchema (editor)", () => actions.registerContentSchema(), "editor"],
  ["actions.registerContentSchema (staff)", () => actions.registerContentSchema(), "staff"],
];
for (const [name, fn, who] of gated) {
  reset(); asked.length = 0; as(who);
  const err = await rejects(fn);
  ok(`gated: ${name} is refused for ${who} before any request or dialog`, err && err.isActionError && err.kind === "permission" && calls.length === 0 && asked.length === 0, err ? `${err.kind} calls=${calls.length}` : "no error");
}
as("editor");
reset();
on("GET", "/content/documents/home", { body: docBody() });
on("PUT", "/content/documents/home", { body: docBody() });
res = await actions.saveContentDocument("home", goodContent, { rev: 4 });
ok("an editor (content.edit) can save", res.ok);
ok("the saved doc carries the schema node (the PUT response has none) so the form can be rebuilt", res.doc.schemaNode && res.doc.schemaNode.properties.title);
ok("nav: the content entry shows only with content.view; staff sees none", NAV.find((n) => n.key === "content").perm.join() === "content.view" && !NAV.filter((n) => n.perm.every((p) => perms.staff.includes(p))).some((n) => n.key === "content") && NAV.filter((n) => n.perm.every((p) => perms.editor.includes(p))).some((n) => n.key === "content"));
const rp = Object.fromEntries(ROUTES.filter((r) => r.id.startsWith("content")).map((r) => [r.id, r.perm.join()]));
ok("routes: view for list/document/revisions, manage for the schema screen; /content-schema is distinct from /content/:key", rp.content === "content.view" && rp.contentDocument === "content.view" && rp.contentRevisions === "content.view" && rp.contentSchema === "content.manage" && ROUTES.find((r) => r.id === "contentSchema").pattern === "/content-schema");

// ── 6. publish / unpublish / delete / restore ──
as("owner");
reset();
on("GET", "/content/documents/home", { body: docBody({ needs_attention: true }) });
e = await rejects(() => actions.publishContentDocument("home", { rev: 4 }));
ok("a document that needs attention cannot be published (no dialog, no request but the read)", e && e.kind === "state" && calls.every((c) => c.method === "GET"));
reset(); asked.length = 0;
on("GET", "/content/documents/home", { body: docBody() });
on("POST", "/content/documents/home/publish", (r) => ({ body: docBody({ status: 1 }) }));
res = await actions.publishContentDocument("home", { rev: 4 });
const pub = calls.find((c) => c.method === "POST");
ok("publish asks for the irreversible-style confirmation and sends If-Match with the reviewed revision", asked[0].key === "confirm.publishContent" && pub.headers["If-Match"] === '"4"' && res.ok);
reset(); asked.length = 0; answers = [false];
on("GET", "/content/documents/home", { body: docBody() });
res = await actions.publishContentDocument("home", { rev: 4 });
ok("a declined publish sends nothing", res.cancelled && calls.every((c) => c.method === "GET"));
reset(); asked.length = 0; answers = [true];
on("GET", "/content/documents/home", { body: docBody() });
on("DELETE", "/content/documents/home", { status: 204 });
res = await actions.deleteContentDocument("home");
ok("delete asks first, then DELETEs", res.ok && asked[0].key === "confirm.deleteContent" && calls.some((c) => c.method === "DELETE"));
reset(); asked.length = 0; answers = [false];
on("GET", "/content/documents/home", { body: docBody() });
res = await actions.unpublishContentDocument("home");
ok("a declined unpublish sends nothing", res.cancelled && calls.every((c) => c.method === "GET"));
reset(); asked.length = 0; answers = [];
on("GET", "/content/documents/home", { headers: { ETag: '"6"' }, body: docBody({ draft_rev: 6 }) });
on("POST", "/revisions/3/restore", { headers: { ETag: '"6"' }, body: docBody({ draft_rev: 6, restored_valid: false, schema_node: undefined }) });
res = await actions.restoreContentRevision("home", 3, { rev: 5 });
const rc = calls.find((c) => c.method === "POST");
ok("restore: confirmation first; it only restores to the draft (nothing is published); If-Match is the screen's revision; restored_valid:false is reported", asked[0].key === "confirm.restoreContent" && res.restoredToDraft === true && res.restoredValid === false && rc.headers["If-Match"] === '"5"' && !calls.some((c) => /publish/.test(c.url)), JSON.stringify(res));
ok("the restore warning says it is only a draft", /草稿/.test(fixedWarning("restoreContent")) && /不會發佈/.test(fixedWarning("restoreContent")));

// restore / publish must carry the revision the person SAW (If-Match); nothing is defaulted
reset(); asked.length = 0; answers = [];
e = await rejects(() => actions.restoreContentRevision("home", 3));
ok("restore without rev fails with an internal error before any dialog or request", e && e.kind === "internal" && asked.length === 0 && calls.length === 0, JSON.stringify(e));
e = await rejects(() => actions.restoreContentRevision("home", 3, { rev: 0 }));
ok("restore with a non-positive rev fails the same way", e && e.kind === "internal" && calls.length === 0);
reset(); asked.length = 0;
e = await rejects(() => actions.publishContentDocument("home", {}));
ok("publish without rev fails with an internal error before any request (no default to a rev read later)", e && e.kind === "internal" && asked.length === 0 && calls.length === 0);
reset(); asked.length = 0; answers = [];
on("GET", "/content/documents/home", { body: docBody({ draft_rev: 9 }) });
on("POST", "/content/documents/home/publish", { status: 200, body: docBody({ status: 1 }) });
await actions.publishContentDocument("home", { rev: 4 });
ok("publish sends the rev the person saw (4), never the one read after the dialog (9)", calls.find((c) => c.method === "POST").headers["If-Match"] === '"4"');
reset(); asked.length = 0; answers = [];
on("GET", "/content/documents/home", { body: docBody({ draft_rev: 9 }) });
on("POST", "/revisions/3/restore", { status: 412, body: { error: { code: "precondition_failed", message: "stale", details: { current_rev: 9 } } } });
e = await rejects(() => actions.restoreContentRevision("home", 3, { rev: 5 }));
ok("restore with a stale rev -> 412 -> kind stale (the screen reloads), If-Match was sent", e && e.kind === "stale" && e.currentRev === 9 && calls.find((c) => c.method === "POST").headers["If-Match"] === '"5"', JSON.stringify(e));

// ── 7. dry run is read-only; registration needs the human ──
const schemaFile = { format: 2, types: { global: { title: "G", schema: { type: "object" } } } };
const stubSchemaRoutes = ({ removals = false } = {}) => {
  on("GET", "/content.schema.json", { body: schemaFile });
  on("PUT", /\/content\/schema(\?|$)/, (r) => {
    if (r.url.includes("dry_run=true")) return { body: { version: 1, changed: true, dry_run: true, would_register_version: 2, report: { documents: [{ kind: "global", key: "global", status: "ok", removed_paths: removals ? ["/old"] : [], invalid: [], published_invalid: false }] } } };
    if (removals && !r.url.includes("confirm_removals=true")) return { status: 409, body: { error: { code: "removals_require_confirmation", message: "confirm", details: { report: { documents: [{ kind: "global", key: "global", status: "ok", removed_paths: ["/old"], invalid: [], published_invalid: false }] } } } } };
    return { body: { version: 2, changed: true, dry_run: false, report: { documents: [] } } };
  });
};
as("owner"); reset(); stubSchemaRoutes({ removals: true });
const dry = await data.dryRunContentSchema();
ok("dry run: every schema PUT carries dry_run=true and nothing else is written", puts().length === 1 && puts().every((c) => /dry_run=true/.test(c.url) && !/confirm_removals/.test(c.url)) && calls.every((c) => c.method !== "POST" && c.method !== "DELETE"), JSON.stringify(calls.map((c) => c.url)));
ok("dry run reports the removals as plain text lines", dry.changed && dry.hasRemovals && dry.lines.some((l) => l.includes("/old")) && dry.wouldRegisterVersion === 2);
ok("the schema file is read from a same-origin relative path", calls[0].url === "/content.schema.json" && C.schemaUrl() === "/content.schema.json");
g.window.ADMIN_CONFIG.contentSchemaUrl = "//evil.example/x.json";
ok("a protocol-relative schema URL in the config is ignored", C.schemaUrl() === "/content.schema.json");
delete g.window.ADMIN_CONFIG.contentSchemaUrl;
e = await rejects(() => C.readSchemaFile("https://evil.example/x.json"));
ok("readSchemaFile refuses an absolute URL", e && e.code === "bad_url");

reset(); asked.length = 0; answers = [false]; stubSchemaRoutes();
res = await actions.registerContentSchema();
ok("registration: a declined confirmation sends NO registering request (only the dry run)", res.cancelled && puts().length === 1 && /dry_run=true/.test(puts()[0].url) && asked.length === 1 && asked[0].key === "confirm.registerContentSchema");
ok("the confirmation shows the report as detail text", typeof asked[0].opts.detail === "string" && asked[0].opts.detail.length > 0);
reset(); asked.length = 0; answers = [false]; stubSchemaRoutes();
res = await actions.registerContentSchema({ confirm: true, confirmRemovals: true, skipDialog: true, yes: true }, true, { force: true });
ok("registration ignores every argument: flags cannot skip the dialog", res.cancelled && puts().every((c) => /dry_run=true/.test(c.url)) && asked.length === 1 && actions.registerContentSchema.length === 0);
reset(); asked.length = 0; answers = [true]; stubSchemaRoutes();
res = await actions.registerContentSchema();
ok("a confirmed registration sends one real PUT (no confirm_removals)", res.ok && res.version === 2 && puts().length === 2 && !/dry_run/.test(puts()[1].url) && !/confirm_removals/.test(puts()[1].url));
reset(); asked.length = 0; answers = [true, false]; stubSchemaRoutes({ removals: true });
res = await actions.registerContentSchema();
ok("removals: the platform's 409 needs a SECOND explicit confirmation; declining it sends no confirm_removals", res.cancelled && asked.map((a) => a.key).join() === "confirm.registerContentSchema,confirm.registerContentSchemaRemovals" && !calls.some((c) => /confirm_removals=true/.test(c.url)));
reset(); asked.length = 0; answers = [true, true]; stubSchemaRoutes({ removals: true });
res = await actions.registerContentSchema();
ok("removals: after both confirmations confirm_removals=true is sent", res.ok && calls.some((c) => /confirm_removals=true/.test(c.url)));
reset(); asked.length = 0; answers = []; on("GET", "/content.schema.json", { status: 404, body: {} });
e = await rejects(() => actions.registerContentSchema());
ok("a missing schema file is a clear ActionError and asks nothing", e && e.isActionError && /content\.schema\.json/.test(e.message) && asked.length === 0 && puts().length === 0);
reset(); asked.length = 0; answers = []; on("GET", "/content.schema.json", { body: schemaFile });
on("PUT", /\/content\/schema/, { body: { version: 3, changed: false, dry_run: true, would_register_version: 0, report: { documents: [] } } });
res = await actions.registerContentSchema();
ok("an unchanged schema is not registered and asks nothing", res.unchanged === true && asked.length === 0 && puts().length === 1);
// the dry run helper itself cannot register
const src = readFileSync(path.join(ROOT, "core/content-actions.js"), "utf8");
const dryFn = src.slice(src.indexOf("export async function dryRunContentSchema"), src.indexOf("const summarizeRegister"));
ok("dryRunContentSchema's source only calls putSchema with dryRun: true", /dryRun: true/.test(dryFn) && !/confirmRemovals/.test(dryFn));

// ── 8. preview / site origin ──
as("owner"); reset();
g.window.ADMIN_CONFIG.siteOrigin = "javascript:alert(1)";
ok("a non-http(s) siteOrigin is ignored", C.siteOrigin() === "");
e = await rejects(() => actions.previewContentDocument("home"));
ok("preview without a valid siteOrigin is refused before any request", e && e.isActionError && calls.length === 0);
g.window.ADMIN_CONFIG.siteOrigin = "http://localhost:8788/path?x=1";
ok("siteOrigin is normalised to an origin", C.siteOrigin() === "http://localhost:8788");
const opened = [];
g.window.open = (u) => { const w = { opener: 1, location: { set href(v) { opened.push(v); } } }; return w; };
on("POST", "/preview-token", { body: { preview_token: "tok/1", expires_in: 600, scope: "document", key: "home" } });
res = await actions.previewContentDocument("home");
ok("preview opens {siteOrigin}/?content_preview=<token> (token in the query of the new tab only)", res.opened && opened[0] === "http://localhost:8788/?content_preview=tok%2F1" && calls[0].body.scope === "document");

// ── 9. copy and warnings coverage ──
ok("every content confirmation id has a fixed warning and the copy keys title/text/yes", ["publishContent", "unpublishContent", "deleteContent", "restoreContent", "registerContentSchema", "registerContentSchemaRemovals"].every((id) => WARNED_CONFIRM_IDS.includes(id) && fixedWarning(id, { version: 2 }).length > 10 && `confirm.${id}.title` in defaults && `confirm.${id}.text` in defaults && `confirm.${id}.yes` in defaults));
ok("the registration warning states it cannot be automated", /不能由 AI 或自動化/.test(fixedWarning("registerContentSchema")));

console.log(`\ncontent core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
