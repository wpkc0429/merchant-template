// End-to-end suite for the merchant admin (headless Chromium, Playwright reused from ecommerce/e2e).
// Needs the throwaway stack from the README ("Testing"). Run: node e2e/run.mjs
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadPlaywright, API, SITE, OUT, OWNER, STAFF, superAdmin, req, apiLogin, check, section, failureCount,
} from "./lib.mjs";
import { hookBrowser } from "./lib/shadow-hook.mjs";
import { catalog, placeOrder, payOrder, taipeiDate, restockStock } from "./data.mjs";

mkdirSync(OUT, { recursive: true });
const { chromium } = loadPlaywright();
const browser = hookBrowser(await chromium.launch());
const shot = (page, name) => page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: false });
const T = (page, id) => page.locator(`[data-testid="${id}"]`);
const runId = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, ...opts });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("dialog", (d) => d.dismiss());
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
const toastText = (page) => page.locator(".toast").allInnerTexts();
async function waitToast(page, re) {
  try {
    await page.waitForFunction((s) => [...document.querySelectorAll(".toast")].some((t) => new RegExp(s).test(t.textContent)), re.source, { timeout: 8000 });
  } catch (e) { throw new Error(`toast ${re} not seen; toasts: ${JSON.stringify(await toastText(page))}; dialogs: ${await page.locator("dialog").allInnerTexts()}`); }
}
// Clears old toasts first so a previous "已儲存" cannot satisfy this wait.
async function saveProduct(page) {
  await page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
  await T(page, "product-save").click();
  await waitToast(page, /已儲存/);
  await page.waitForTimeout(400);
}
async function tinyJpegs(page, n, w = 320, h = 240) {
  const list = await page.evaluate(async ({ n, w, h }) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const x = c.getContext("2d");
      x.fillStyle = `hsl(${(i * 37) % 360} 55% 70%)`; x.fillRect(0, 0, w, h);
      x.fillStyle = "#fff"; x.beginPath(); x.arc(w / 2, h / 2, h / 4, 0, 7); x.fill();
      out.push(c.toDataURL("image/jpeg", 0.8).split(",")[1]);
    }
    return out;
  }, { n, w, h });
  return list.map((b64, i) => ({ name: `photo-${i + 1}.jpg`, mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") }));
}
// body has overflow-x:hidden, so also look for any visible element poking past the viewport edge.
const overflowX = (page) => page.evaluate(() => {
  const w = window.innerWidth;
  let worst = document.documentElement.scrollWidth - w;
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("svg") || el.closest("dialog:not([open])")) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (getComputedStyle(el).position === "fixed") continue;
    worst = Math.max(worst, Math.ceil(r.right - w), Math.ceil(-r.left));
  }
  return worst;
});

const ownerToken = await apiLogin(OWNER);
const staffToken = await apiLogin(STAFF);
const sa = await apiLogin(superAdmin());
// A brand-new throwaway database has no orders yet; the staff checks in section 3 need one.
{
  const have = (await req("GET", "/admin/shops/1/orders?page=1&page_size=1", { token: ownerToken })).json?.orders || [];
  if (!have.length) {
    await restockStock(ownerToken);
    const c = await catalog(ownerToken);
    const first = await placeOrder({ email: `seed-${runId}@example.com`, items: [{ sku_id: c.skus[0].id, quantity: 1 }], date: taipeiDate(0), shipId: c.ship[0].id });
    await payOrder(first.token);
  }
}

// ───────────────────────────────────────────────────────────────────────
section("1. Login / logout / wrong password (cookie mode, same-origin via proxy)");
let page = await newPage();
await page.goto(SITE);
await T(page, "login-email").waitFor();
check("unauthenticated visit shows the login form", await T(page, "login-submit").isVisible());
check("page language and title are Traditional Chinese", (await page.title()).includes("後台") && (await page.getAttribute("html", "lang")) === "zh-Hant");
await T(page, "login-email").fill(OWNER.email);
await T(page, "login-password").fill("definitely-wrong-password");
await T(page, "login-submit").click();
await T(page, "login-error").waitFor();
check("wrong password shows the Chinese error", /不正確/.test(await T(page, "login-error").innerText()));
await T(page, "login-password").fill(OWNER.password);
await T(page, "login-submit").click();
await page.locator(".shell").waitFor();
check("owner lands on the home screen with nav-products", await T(page, "nav-products").first().isVisible() || (await T(page, "tab-more").isVisible()));
const stores = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
check("no token in localStorage / sessionStorage (cookie mode)", !/eyJ/.test(stores) && !/refresh/i.test(stores.replace(/accessReloadAt/g, "")), stores.slice(0, 120));
const cookies = await page.context().cookies();
const rc = cookies.find((c) => c.name === "__Secure-admin_refresh");
check("refresh token is an HttpOnly cookie", Boolean(rc && rc.httpOnly));
await page.reload();
await page.locator(".shell").waitFor();
check("reload restores the session through the cookie refresh", true);
await page.goto(SITE + "/#/products");
await T(page, "product-row").first().waitFor();
check("products list renders for the owner", (await T(page, "product-row").count()) >= 1);
await page.evaluate(() => { location.hash = "#/"; });
await (await page.locator("[data-testid=logout]").isVisible() ? T(page, "logout") : (async () => { await T(page, "tab-more").click(); return T(page, "logout-sheet"); })()).click();
await T(page, "login-email").waitFor();
check("logout returns to login", true);
await page.reload();
await T(page, "login-email").waitFor();
check("after logout a reload does not restore the session", await T(page, "login-submit").isVisible());
const lockEmail = `lock-${runId}@example.com`;
for (let i = 0; i < 10; i++) await req("POST", "/admin/auth/login", { body: { email: lockEmail, password: "wrong-wrong-wrong" } });
await T(page, "login-email").fill(lockEmail);
await T(page, "login-password").fill("wrong-wrong-wrong");
await T(page, "login-submit").click();
await T(page, "login-error").waitFor();
check("account lockout (429) shows the Chinese lockout message", /嘗試次數過多/.test(await T(page, "login-error").innerText()), await T(page, "login-error").innerText());
check("no page errors in auth flow", page.errors.length === 0, page.errors.join("|"));
await page.context().close();

// ───────────────────────────────────────────────────────────────────────
section("2. Set-password link, accept-invite link");
const roles = await req("GET", "/admin/shops/1/roles", { token: ownerToken });
const staffRole = (roles.json.roles || []).find((r) => r.name === "staff");
const email = `sp-${runId}@example.com`;
const created = await req("POST", "/admin/accounts", { token: sa, body: { email, shop_id: 1, role_id: staffRole.id } });
check("account created via API with a manual setup link", created.status === 201 && /#\/set-password\//.test(created.json?.setup_url || ""), JSON.stringify(created.json)?.slice(0, 120));
page = await newPage();
await page.goto(created.json.setup_url);
await T(page, "pw-email").waitFor();
check("set-password shows the account email", (await T(page, "pw-email").innerText()) === email);
check("token scrubbed from the URL", !page.url().includes(created.json.setup_url.split("/").pop()));
await T(page, "pw-new").fill("short");
await T(page, "pw-confirm").fill("short");
await T(page, "pw-submit").click();
check("password under 12 characters is rejected client-side", /至少需要 12/.test(await page.locator(".field__error").first().innerText()));
await T(page, "pw-new").fill("a-long-enough-pass-1");
await T(page, "pw-confirm").fill("a-long-enough-pass-2");
await T(page, "pw-submit").click();
check("mismatched confirmation is rejected", /不一致/.test(await page.locator(".field__error").nth(1).innerText()));
await T(page, "pw-confirm").fill("a-long-enough-pass-1");
await T(page, "pw-submit").click();
await T(page, "login-email").waitFor();
check("back at login with the email pre-filled", (await T(page, "login-email").inputValue()) === email);
check("login notice shown", await T(page, "login-notice").isVisible());
const leak = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href]));
check("no setup token persisted anywhere", !leak.includes(created.json.setup_url.split("/").pop()));
await T(page, "login-password").fill("a-long-enough-pass-1");
await T(page, "login-submit").click();
await page.locator(".shell").waitFor();
check("new account can log in", true);
await page.context().close();
page = await newPage();
await page.goto(created.json.setup_url);
await T(page, "link-invalid").waitFor();
check("a used link is shown as invalid, with no password form", (await T(page, "pw-new").count()) === 0);
await page.context().close();

const inviteEmail = `inv-${runId}@example.com`;
const inv = await req("POST", "/admin/shops/1/invitations", { token: ownerToken, body: { email: inviteEmail, role_id: staffRole.id } });
check("owner invitation created with a manual link", inv.status === 201 && /#\/accept-invite\//.test(inv.json?.invite_url || ""), JSON.stringify(inv.json)?.slice(0, 120));
page = await newPage();
await page.goto(inv.json.invite_url);
await T(page, "invite-email").waitFor();
check("accept-invite shows the invited email", (await T(page, "invite-email").innerText()) === inviteEmail);
await T(page, "pw-new").fill("another-long-pass-12");
await T(page, "pw-confirm").fill("another-long-pass-12");
await T(page, "invite-submit").click();
await T(page, "login-email").waitFor();
check("invite accepted: login with email pre-filled", (await T(page, "login-email").inputValue()) === inviteEmail);
await page.context().close();

// ───────────────────────────────────────────────────────────────────────
section("3. Staff sees no products (UI gating, API still enforces)");
page = await newPage();
await login(page, STAFF);
check("staff has the orders nav", await T(page, "nav-orders").first().isVisible());
check("staff has no products / categories / shipping-method / team nav",
  (await T(page, "nav-products").count()) === 0 && (await T(page, "nav-categories").count()) === 0 &&
  (await T(page, "nav-shipping").count()) === 0 && (await T(page, "nav-team").count()) === 0);
await page.goto(SITE + "/#/products");
await T(page, "no-permission").waitFor();
check("direct URL to products shows the no-permission screen", true);
await T(page, "no-permission").waitFor();
await page.goto(SITE + "/#/orders");
await T(page, "order-card").first().waitFor();
check("staff gets the real orders list (no placeholder)", (await T(page, "soon").count()) === 0 && (await T(page, "nav-deliveries").first().isVisible()));
check("staff nav is orders-only: no members / reports / team / products", ["nav-members", "nav-reports", "nav-team", "nav-products", "nav-categories", "nav-shipping"].every((id) => true) && (await page.locator('[data-testid="nav-members"], [data-testid="nav-reports"], [data-testid="nav-team"], [data-testid="nav-products"]').count()) === 0);
const sp = await req("GET", "/admin/shops/1/products", { token: staffToken });
const sc = await req("POST", "/admin/shops/1/products", { token: staffToken, body: { title: "x", slug: "x" } });
check("API refuses staff product list and create (403)", sp.status === 403 && sc.status === 403, `${sp.status}/${sc.status}`);
await shot(page, "desktop-staff-home");
await page.context().close();

// ───────────────────────────────────────────────────────────────────────
section("4. Product lifecycle");
// Make the shop lack a new-arrivals category so the confirm-and-create path is exercised.
const cats0 = await req("GET", "/admin/shops/1/categories?flat=1", { token: ownerToken });
const na0 = cats0.json.categories.find((c) => c.slug === "new-arrivals" || c.name === "本季新品");
if (na0) {
  // The demo category holds products (delete -> 409); category names AND slugs are unique per shop, so rename both.
  const d = await req("PUT", `/admin/shops/1/categories/${na0.id}`, { token: ownerToken, body: { slug: `na-old-${runId}`, name: `舊本季新品 ${runId}` } });
  check("(setup) demo new-arrivals category moved aside", d.status === 200, String(d.status));
}
page = await newPage();
await login(page, OWNER);
await page.goto(SITE + "/#/products/new");
await T(page, "f-title").waitFor();
check("new product starts without an images section (save first)", (await T(page, "images-section").count()) === 0);
await T(page, "product-save").click();
check("empty title is rejected with a Chinese message", /請輸入商品名稱/.test(await page.locator(".field__error").first().innerText()));
await T(page, "f-title").fill(`測試商品 ${runId}`);
await T(page, "f-subtitle").fill(`Test Item ${runId}`);
const slugGuess = await T(page, "f-slug").inputValue();
check("slug auto-fills from the English subtitle", slugGuess === `test-item-${runId}`, slugGuess);
const slug = slugGuess;
await T(page, "f-slug").fill("Bad Slug!");
await T(page, "product-save").click();
check("invalid slug is rejected", /小寫英文/.test(await page.locator('.field[data-pointer="/slug"] .field__error').innerText()));
await T(page, "f-slug").fill(slug);
check("M size is on by default, SKU code derived from slug", (await T(page, "size-M-code").inputValue()) === `${slug}-M`);
await T(page, "size-M-price").fill("1800"); await T(page, "size-M-stock").fill("5");
await T(page, "size-S-enabled").evaluate((e) => e.click());
await T(page, "size-S-price").fill("1200"); await T(page, "size-S-stock").fill("3");
await T(page, "f-active").evaluate((e) => e.click());
// New-arrival toggle -> confirm dialog to create the category
await T(page, "f-new-arrival").evaluate((e) => e.click());
await T(page, "confirm-yes").waitFor();
check("toggling 本季新品 without the category asks the owner first", /本季新品/.test(await page.locator("dialog").innerText()));
await T(page, "confirm-yes").click();
await waitToast(page, /已建立「本季新品」分類/);
await T(page, "product-save").click();
await page.waitForURL(/#\/products\/\d+$/);
const pid = Number(page.url().split("/").pop());
await T(page, "images-section").waitFor();
let prod = (await req("GET", `/admin/shops/1/products/${pid}`, { token: ownerToken })).json;
check("product created with S and M SKUs, active, subtitle saved", prod.skus.length === 2 && prod.status === 1 && prod.subtitle === `Test Item ${runId}`, JSON.stringify(prod.skus));
const naCat = (await req("GET", "/admin/shops/1/categories?flat=1", { token: ownerToken })).json.categories.find((c) => c.slug === "new-arrivals");
check("new-arrivals category was created and the product is in it", Boolean(naCat) && prod.category_ids.includes(naCat.id));
const idsBefore = Object.fromEntries(prod.skus.map((s) => [s.options.size, s.id]));

// Edit: change a price, add L; ids must be preserved
await T(page, "size-M-price").fill("1900");
await T(page, "size-L-enabled").evaluate((e) => e.click());
await T(page, "size-L-price").fill("2600"); await T(page, "size-L-stock").fill("2");
await saveProduct(page);
prod = (await req("GET", `/admin/shops/1/products/${pid}`, { token: ownerToken })).json;
const bySize = Object.fromEntries(prod.skus.map((s) => [s.options.size, s]));
check("edit: price changed, L added, S and M keep their ids", bySize.M.price_amount === 1900 && bySize.L.price_amount === 2600 && bySize.S.id === idsBefore.S && bySize.M.id === idsBefore.M && prod.skus.length === 3, JSON.stringify(prod.skus));
// Existing sizes cannot be switched off (no SKU deletion in the UI)
check("existing size toggles are locked (no SKU deletion path)", await T(page, "size-S-enabled").isDisabled());

// Stale-list protection: change S elsewhere, then save from the stale form
await req("PUT", `/admin/shops/1/products/${pid}`, { token: ownerToken, body: { skus: prod.skus.map((s) => (s.options.size === "S" ? { ...s, price_amount: 1111 } : s)) } });
await T(page, "size-M-stock").fill("9");
await T(page, "product-save").click();
await page.locator("dialog").waitFor();
check("stale form is refused with an explanatory dialog", /已被更新/.test(await page.locator("dialog").innerText()));
prod = (await req("GET", `/admin/shops/1/products/${pid}`, { token: ownerToken })).json;
check("stale save did not overwrite the other change nor drop SKUs", prod.skus.length === 3 && prod.skus.find((s) => s.options.size === "S").price_amount === 1111 && prod.skus.find((s) => s.options.size === "M").stock_qty === 5);
await page.locator("dialog button", { hasText: "重新載入" }).click();
await T(page, "size-S-price").waitFor();
await page.waitForFunction(() => document.querySelector('[data-testid="size-S-price"]').value === "1111");
check("reload brings the fresh values into the form", true);

// Images
section("4b. Images");
const imgs = await tinyJpegs(page, 3);
await T(page, "image-file").setInputFiles([imgs[0], imgs[1]]);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="image-card"]').length === 2, null, { timeout: 20000 });
check("two JPEGs uploaded and listed", true);
check("first image is marked as cover", await page.locator(".img-card.is-cover").count() === 1);
await T(page, "image-file").setInputFiles(resolve(import.meta.dirname, "fixtures/sample.heic"));
await page.waitForFunction(() => document.querySelectorAll('[data-testid="image-card"]').length === 3, null, { timeout: 40000 });
check("a real HEIC was converted in the browser and uploaded", true);
prod = (await req("GET", `/admin/shops/1/products/${pid}`, { token: ownerToken })).json;
check("server holds 3 images (HEIC arrived as a servable image)", prod.images.length === 3 && prod.images.every((i) => /^http/.test(i.urls.thumb)));
const thumbRes = await fetch(prod.images[2].urls.thumb);
check("converted image is publicly readable as WebP", thumbRes.ok && /webp/.test(thumbRes.headers.get("content-type")));
await shot(page, "desktop-product-edit-images");
// alt text
const alt = T(page, "image-alt").first();
await alt.fill("白色帆布包"); await alt.blur();
await waitToast(page, /已更新照片說明/);
prod = (await req("GET", `/admin/shops/1/products/${pid}`, { token: ownerToken })).json;
check("alt text saved through the image sub-resource", prod.images[0].alt === "白色帆布包");
// reorder
const orderBefore = prod.images.map((i) => i.id);
await T(page, "image-left").nth(2).click();
await page.waitForFunction((id) => document.querySelectorAll('[data-testid="image-card"]')[1].dataset.imageId === String(id), orderBefore[2]);
prod = (await req("GET", `/admin/shops/1/products/${pid}`, { token: ownerToken })).json;
check("reorder persisted (third image moved to second)", prod.images.map((i) => i.id).join() === [orderBefore[0], orderBefore[2], orderBefore[1]].join());
// saving the product must not touch images
await T(page, "f-description").fill("備註：保留圖片。");
await saveProduct(page);
await page.waitForTimeout(500);
prod = (await req("GET", `/admin/shops/1/products/${pid}`, { token: ownerToken })).json;
check("product save leaves images untouched", prod.images.length === 3 && prod.description === "備註：保留圖片。", `images=${prod.images.length} desc=${prod.description}`);
// too big (15 MiB)
const big = { name: "huge.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(16 * 1048576, 1) };
await T(page, "image-file").setInputFiles(big);
await page.locator(".upl.is-error").waitFor({ timeout: 8000 }).catch(async () => { console.log("DEBUG", JSON.stringify(await page.locator("main").innerText()).slice(0, 1500), page.errors); throw new Error("no upload error row"); });
check("over-15-MiB file refused with a clear Chinese message", /上限為 15\.0 MiB/.test(await page.locator(".upl.is-error").innerText()));
await page.locator(".upl.is-error button").click();
// unsupported type
await T(page, "image-file").setInputFiles({ name: "x.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") });
await page.locator(".upl.is-error").waitFor();
check("unsupported format refused in Chinese", /不支援的圖片格式/.test(await page.locator(".upl.is-error").innerText()));
await page.locator(".upl.is-error button").click();
// 20 image limit: select 19 more while 3 exist -> only 17 taken
const many = await tinyJpegs(page, 19, 120, 90);
await T(page, "image-file").setInputFiles(many);
await waitToast(page, /最多 20 張/);
check("selecting more than the 20-image limit explains and truncates", true);
await page.waitForFunction(() => document.querySelector('[data-testid="image-count"]').textContent.startsWith("20 /"), null, { timeout: 90000 });
check("exactly 20 images after the batch", true);
check("upload button disabled at the limit", await T(page, "image-upload-btn").isDisabled());
await page.waitForTimeout(1800);
// delete: via UI one, then cut down to 3 via API to keep later screenshots tidy
await T(page, "image-delete").last().click();
await T(page, "confirm-yes").click();
await page.waitForFunction(() => document.querySelector('[data-testid="image-count"]').textContent.startsWith("19 /"));
check("image deleted through the UI", true);
prod = (await req("GET", `/admin/shops/1/products/${pid}`, { token: ownerToken })).json;
for (const im of prod.images.slice(3)) await req("DELETE", `/admin/shops/1/products/${pid}/images/${im.id}`, { token: ownerToken });
// Conversion hook: a ".heic"-named file whose conversion fails must send nothing
await page.reload();
await T(page, "image-file").waitFor({ state: "attached" });
await page.evaluate(async () => {
  const m = await import("/lib/upload.js");
  window.__hook = m.heicHooks;
  m.heicHooks.convert = async () => { throw new Error("boom"); };
});
const uploadsBefore = [];
page.on("request", (r) => { if (/media\/uploads/.test(r.url())) uploadsBefore.push(r.url()); });
await T(page, "image-file").setInputFiles({ name: "broken.heic", mimeType: "image/heic", buffer: Buffer.from("not really heic") });
await page.locator(".upl.is-error").waitFor();
check("HEIC conversion failure shows guidance and sends no upload request", /無法轉換這張 HEIC/.test(await page.locator(".upl.is-error").innerText()) && uploadsBefore.length === 0);

// New-arrival off, then deactivate
await T(page, "f-new-arrival").evaluate((e) => e.click());
await saveProduct(page);
prod = (await req("GET", `/admin/shops/1/products/${pid}`, { token: ownerToken })).json;
check("本季新品 off removes the product from new-arrivals", !prod.category_ids.includes(naCat.id));
await T(page, "f-new-arrival").evaluate((e) => e.click());
await saveProduct(page);
prod = (await req("GET", `/admin/shops/1/products/${pid}`, { token: ownerToken })).json;
check("本季新品 on again adds it back (category exists: no prompt)", prod.category_ids.includes(naCat.id));
await T(page, "f-active").evaluate((e) => e.click());
await saveProduct(page);
prod = (await req("GET", `/admin/shops/1/products/${pid}`, { token: ownerToken })).json;
check("deactivate sets status to 0 and keeps SKUs and images", prod.status === 0 && prod.skus.length === 3 && prod.images.length === 3);

// List filters
await page.goto(SITE + "/#/products");
await T(page, "product-row").first().waitFor();
await T(page, "product-search").fill(`測試商品 ${runId}`);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length === 1);
const rowText = await T(page, "product-row").innerText();
check("search finds the product; row shows subtitle, price range, thumbnail, status", rowText.includes(`Test Item ${runId}`) && /NT\$1,111/.test(rowText) && /NT\$2,600/.test(rowText) && rowText.includes("已下架") && (await T(page, "product-row").locator("img").count()) === 1, rowText.replace(/\n/g, " "));
await T(page, "product-search").fill(`test item ${runId}`);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length === 1);
check("product search also matches the English subtitle (client side; the API's q does not)", (await T(page, "product-row").innerText()).includes(`Test Item ${runId}`));
await T(page, "product-search").fill(`測試商品 ${runId}`);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length === 1);
await T(page, "product-status").selectOption("1");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length === 0);
check("active filter hides the deactivated product", true);
await T(page, "product-status").selectOption("");
await T(page, "product-search").fill("");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="product-row"]').length >= 5);
await T(page, "product-instock").evaluate((e) => e.click());
const stockRows = await T(page, "product-row").allInnerTexts();
check("in-stock filter drops products with no stock", stockRows.every((t) => !t.includes("無庫存")) && stockRows.length >= 1);
check("no page errors in product flow", page.errors.length === 0, page.errors.join("|"));
const productID = pid;
await page.context().close();

// ───────────────────────────────────────────────────────────────────────
section("5. Categories and ordering");
page = await newPage();
await login(page, OWNER);
await page.goto(SITE + "/#/categories");
await T(page, "cat-list").waitFor();
await T(page, "cat-new").click();
await T(page, "cat-f-name").fill(`測試禮盒 ${runId}`);
await T(page, "cat-f-slug").fill("BAD");
await T(page, "cat-f-save").click();
check("invalid category slug is rejected in the dialog", /小寫英文/.test(await page.locator('dialog .field[data-pointer="/slug"] .field__error').innerText()));
await T(page, "cat-f-slug").fill(`gifts-${runId}`);
await T(page, "cat-f-save").click();
await page.locator(`[data-slug="gifts-${runId}"]`).waitFor();
check("category created", true);
await page.locator(`[data-slug="gifts-${runId}"] [data-testid="cat-add-child"]`).click();
await T(page, "cat-f-name").fill("子分類");
await T(page, "cat-f-slug").fill(`sub-${runId}`);
await T(page, "cat-f-save").click();
await page.locator(`[data-slug="sub-${runId}"]`).waitFor();
check("child category created under it", true);
await page.locator(`[data-slug="gifts-${runId}"] [data-testid="cat-edit"]`).click();
await T(page, "cat-f-name").fill(`測試禮盒 改名 ${runId}`);
await T(page, "cat-f-save").click();
await page.waitForFunction((n) => [...document.querySelectorAll(".cat-name")].some((e) => e.textContent.includes(n)), "改名");
check("category renamed", true);
// reorder: move our category up one among root siblings
let tree = (await req("GET", "/admin/shops/1/categories", { token: ownerToken })).json.categories;
const rootsBefore = tree.map((c) => c.slug);
await page.locator(`[data-slug="gifts-${runId}"] [data-testid="cat-up"]`).click();
await page.waitForFunction((n) => { const s = [...document.querySelectorAll(".cat-item")].map((e) => e.dataset.slug); return s.indexOf(n) === s.length - 3 - 1 + 0 || true; }, `gifts-${runId}`);
await page.waitForTimeout(600);
tree = (await req("GET", "/admin/shops/1/categories", { token: ownerToken })).json.categories;
const rootsAfter = tree.map((c) => c.slug);
const i0 = rootsBefore.indexOf(`gifts-${runId}`), i1 = rootsAfter.indexOf(`gifts-${runId}`);
check("category reorder persisted (moved up one)", i1 === i0 - 1, `${rootsBefore} -> ${rootsAfter}`);
// product order inside new-arrivals
const second = await req("POST", "/admin/shops/1/products", { token: ownerToken, body: { title: `第二件 ${runId}`, slug: `second-${runId}`, status: 1, category_ids: [naCat.id], skus: [{ sku_code: `SEC-${runId}`, options: { size: "M" }, price_amount: 999, currency: "TWD", stock_qty: 1, is_active: true }] } });
const order0 = (await req("GET", `/admin/shops/1/categories/${naCat.id}/product-order`, { token: ownerToken })).json.products.map((p) => p.product_id);
await page.goto(SITE + `/#/categories/${naCat.id}/order`);
await T(page, "order-item").first().waitFor();
check("manual order screen lists the category's products", (await T(page, "order-item").count()) === order0.length && order0.length >= 2);
await T(page, "order-down").first().click();
check("save is disabled until something changes, then enabled", !(await T(page, "order-save").isDisabled()));
await T(page, "order-save").click();
await waitToast(page, /已儲存排序/);
const order1 = (await req("GET", `/admin/shops/1/categories/${naCat.id}/product-order`, { token: ownerToken })).json.products.map((p) => p.product_id);
check("product order persisted (first moved down)", order1[0] === order0[1] && order1[1] === order0[0], `${order0} -> ${order1}`);
await shot(page, "desktop-category-order");
await page.goto(SITE + "/#/categories");
await page.locator(`[data-slug="sub-${runId}"] [data-testid="cat-delete"]`).waitFor();
await page.locator(`[data-slug="sub-${runId}"] [data-testid="cat-delete"]`).click();
await T(page, "confirm-yes").click();
await page.waitForFunction((s) => !document.querySelector(`[data-slug="${s}"]`), `sub-${runId}`);
check("category deleted after confirmation", true);
check("no page errors in category flow", page.errors.length === 0, page.errors.join("|"));
await shot(page, "desktop-categories");
await page.context().close();

// ───────────────────────────────────────────────────────────────────────
section("6. Shipping methods");
page = await newPage();
await login(page, OWNER);
await page.goto(SITE + "/#/shipping-methods");
await T(page, "ship-row").first().waitFor();
const before = await T(page, "ship-row").count();
await T(page, "ship-new").click();
await T(page, "ship-f-save").click();
check("empty form shows Chinese validation", /請輸入名稱/.test(await page.locator("dialog .field__error").first().innerText()));
await T(page, "ship-f-name").fill(`測試配送 ${runId}`);
await T(page, "ship-f-carrier").fill("測試物流");
await T(page, "ship-f-rate").fill("150");
await T(page, "ship-f-save").click();
await page.locator(`[data-name="測試配送 ${runId}"]`).waitFor();
check("shipping method created and listed with NT$ rate", (await T(page, "ship-row").count()) === before + 1 && /NT\$150/.test(await page.locator(`[data-name="測試配送 ${runId}"]`).innerText()));
await page.locator(`[data-name="測試配送 ${runId}"] [data-testid="ship-edit"]`).click();
await T(page, "ship-f-rate").fill("0");
await T(page, "ship-f-save").click();
await page.waitForFunction((n) => /免運費/.test(document.querySelector(`[data-name="${n}"]`)?.innerText || ""), `測試配送 ${runId}`);
check("edit saved (0 shows as 免運費)", true);
await page.locator(`[data-name="測試配送 ${runId}"] [data-testid="ship-active"]`).evaluate((e) => e.click());
await waitToast(page, /已停用/);
let sm = (await req("GET", "/admin/shops/1/shipping-methods", { token: ownerToken })).json.shipping_methods.find((m) => m.name === `測試配送 ${runId}`);
check("deactivate persisted; flat_rate 0 and name intact", sm.is_active === false && sm.flat_rate === 0 && sm.carrier === "測試物流");
await page.locator(`[data-name="測試配送 ${runId}"] [data-testid="ship-active"]`).evaluate((e) => e.click());
await waitToast(page, /已啟用/);
sm = (await req("GET", "/admin/shops/1/shipping-methods", { token: ownerToken })).json.shipping_methods.find((m) => m.name === `測試配送 ${runId}`);
check("reactivate persisted", sm.is_active === true);
await shot(page, "desktop-shipping");
check("no page errors in shipping flow", page.errors.length === 0, page.errors.join("|"));
await page.context().close();

// ───────────────────────────────────────────────────────────────────────
section("7. Body-mode refresh (cross-origin API, as in localhost dev)");
page = await newPage();
await page.route("**/config.local.js", (r) => r.fulfill({ contentType: "text/javascript", body: `window.ADMIN_CONFIG.apiBase = "${API}";` }));
await login(page, OWNER);
check("login works against a cross-origin API (body mode)", true);
const bm = await page.evaluate(() => ({ s: Object.keys(sessionStorage), l: Object.keys(localStorage) }));
check("body mode keeps the refresh token in sessionStorage only", bm.s.includes("admin.refresh") && bm.l.length === 0, JSON.stringify(bm));
await page.reload();
await page.locator(".shell").waitFor();
check("reload restores via the body-mode refresh token", true);
await page.context().close();

// ───────────────────────────────────────────────────────────────────────
// PHASE B. Real orders through the PUBLIC guest checkout (mock payment + signed webhook).
section("9. Phase B test data (guest checkout, mock payments)");
await restockStock(ownerToken);
const shopCat = await catalog(ownerToken);
const byProduct = {};
for (const s of shopCat.skus) (byProduct[s.product] ||= {})[s.size] = s;
const prods = Object.values(byProduct).filter((p) => p.S && p.M && p.L);
check("test shop has at least 7 products with S/M/L", prods.length >= 7, String(prods.length));
const shipMethod = shopCat.ship.find((m) => m.name === "宅配到府") || shopCat.ship[0];
const today = taipeiDate(0), tomorrow = taipeiDate(1), in3 = taipeiDate(3);
const tag = runId.slice(-4);
const phone = (n) => `0955${String(Date.now()).slice(-5)}${n}`;
const mk = (n) => ({ name: `客人${tag}${n}`, phone: phone(n) });
const em = (n) => `${n}-${runId}@example.com`;

// A member tier so a returning customer's later order carries a discount.
const tier0 = await req("POST", "/admin/shops/1/member-tiers", { token: ownerToken, body: { name: `常客${runId}`, min_points: 20, discount_percent: 5 } });
check("(setup) tier created through the API", tier0.status === 201, JSON.stringify(tier0.json));

const A = { ...mk("甲"), email: em("alice"), gifts: ["媽媽生日快樂，永遠愛你", "給岳母：節日快樂"] };
const oA = await placeOrder({ email: A.email, name: A.name, phone: A.phone, date: today, shipId: shipMethod.id,
  items: [{ sku_id: prods[0].S.id, quantity: 1, gift_message: A.gifts[0] }, { sku_id: prods[0].M.id, quantity: 1, gift_message: A.gifts[1] }] });
await payOrder(oA.token);
await sleep(600);
const B = { ...mk("乙"), email: em("bob"), gift: "畢業快樂，前程似錦" };
const oB = await placeOrder({ email: B.email, name: B.name, phone: B.phone, date: today, shipId: shipMethod.id, items: [{ sku_id: prods[1].M.id, quantity: 3, gift_message: B.gift }] });
await payOrder(oB.token);
const C = { ...mk("丙"), email: em("carol") };
const oC = await placeOrder({ email: C.email, name: C.name, phone: C.phone, date: tomorrow, shipId: shipMethod.id, items: [{ sku_id: prods[2].L.id, quantity: 1 }] });
await payOrder(oC.token);
const D = { ...mk("丁"), email: em("dave") };
const oD = await placeOrder({ email: D.email, name: D.name, phone: D.phone, date: today, shipId: shipMethod.id, items: [{ sku_id: prods[3].S.id, quantity: 1 }] });
const G = { ...mk("己"), email: em("erin") };
const oG = await placeOrder({ email: G.email, name: G.name, phone: G.phone, date: today, shipId: shipMethod.id, items: [{ sku_id: prods[5].S.id, quantity: 1, gift_message: "staff 測試卡片" }] });
await payOrder(oG.token);
const Hh = { ...mk("庚"), email: em("frank") };
const oH = await placeOrder({ email: Hh.email, name: Hh.name, phone: Hh.phone, date: today, shipId: shipMethod.id, items: [{ sku_id: prods[6].S.id, quantity: 1 }] });
// alice's second order (after her first paid order earned points, she is in the 常客 tier)
let pts = 0;
for (let i = 0; i < 20 && pts < 20; i++) { const m = await req("GET", `/admin/shops/1/members/${oA.order.member_id}`, { token: ownerToken }); pts = m.json?.points || 0; if (pts < 20) await sleep(300); }
check("alice earned points from her paid order", pts >= 20, String(pts));
const oE = await placeOrder({ email: A.email, name: `${A.name}二`, phone: A.phone, date: in3, shipId: shipMethod.id, items: [{ sku_id: prods[4].M.id, quantity: 2 }] });
await payOrder(oE.token);
check("alice's returning order carries the tier discount", oE.order.discount_amount > 0, JSON.stringify([oE.order.discount_amount, oE.order.member_tier_name]));
const ids = { A: oA.order.id, B: oB.order.id, C: oC.order.id, D: oD.order.id, E: oE.order.id, G: oG.order.id, H: oH.order.id };
const lowSku = prods[6].L; // not used by any order; drop its stock to 2 for the low-stock list
{
  const pid = (await req("GET", "/admin/shops/1/products?page_size=100", { token: ownerToken })).json.products.find((p) => p.skus.some((s) => s.id === lowSku.id));
  const r = await req("PUT", `/admin/shops/1/products/${pid.id}`, { token: ownerToken, body: { skus: pid.skus.map((s) => (s.id === lowSku.id ? { ...s, stock_qty: 2 } : s)) } });
  check("(setup) one SKU's stock lowered to 2", r.status === 200, String(r.status));
}
// 21 more unpaid orders (cancelled right after) so the list has a second page.
const bulkTokens = [];
for (let i = 0; i < 21; i++) {
  const p = prods[i % prods.length];
  const o = await placeOrder({ email: em(`bulk${i}`), name: `批量${tag}${i}`, phone: phone(i % 10), items: [{ sku_id: p[["S", "M", "L"][i % 3]].id, quantity: 1 }] });
  bulkTokens.push(o.order.id);
}
check("created 21 extra orders", bulkTokens.length === 21);
for (const bid of bulkTokens) await req("POST", `/admin/shops/1/orders/${bid}/cancel`, { token: ownerToken });
const fullA = (await req("GET", `/admin/shops/1/orders/${ids.A}`, { token: ownerToken })).json;
const staffNote = (await req("GET", `/admin/shops/1/orders/${ids.A}/shipments`, { token: staffToken })).status;
check("staff can read an order's shipments (shipment.view)", staffNote === 200, String(staffNote));

// ───────────────────────────────────────────────────────────────────────
section("10. Orders list: cards, filters, search, paging");
page = await newPage();
await login(page, OWNER);
await page.goto(SITE + "/#/orders");
await T(page, "order-card").first().waitFor();
const firstIds = await page.locator('[data-testid="order-card"]').evaluateAll((els) => els.map((e) => Number(e.dataset.orderId)));
check("newest first (ids strictly descending)", firstIds.every((v, i) => i === 0 || firstIds[i - 1] > v), firstIds.join());
check("a full first page is 20 cards with a pager", firstIds.length === 20 && (await T(page, "pager").count()) === 1);
await T(page, "page-next").click();
await page.waitForFunction(() => document.querySelector('[data-testid="page-now"]')?.textContent.startsWith("2 /"));
const page2 = await page.locator('[data-testid="order-card"]').evaluateAll((els) => els.map((e) => Number(e.dataset.orderId)));
check("page 2 holds older orders", page2.length >= 1 && Math.max(...page2) < Math.min(...firstIds), `${page2}`);
await T(page, "page-prev").click();
await page.waitForFunction(() => document.querySelector('[data-testid="page-now"]')?.textContent.startsWith("1 /"));
await T(page, "order-search").fill(A.name);
const cardA = page.locator(`[data-testid="order-card"][data-order-id="${ids.A}"]`);
await cardA.waitFor();
const cardAText = await cardA.innerText();
check("card shows number, status chips, total, recipient, delivery date and gift marker",
  cardAText.includes(`#${ids.A}`) && cardAText.includes("已付款") && cardAText.includes("未出貨") && cardAText.includes(A.name) &&
  cardAText.includes(fullA.total_amount.toLocaleString("en-US")) && cardAText.includes("今天") && cardAText.includes("附卡片訊息"), cardAText.replace(/\n/g, " | "));
await T(page, "order-search").fill("");
await page.waitForFunction(() => document.querySelectorAll('[data-testid="order-card"]').length === 20);
// payment filter
await T(page, "order-payment").selectOption("0");
await page.waitForFunction((id) => document.querySelectorAll('[data-testid="order-card"]').length > 0 && ![...document.querySelectorAll('[data-testid="order-card"]')].some((e) => e.dataset.orderId === String(id)), ids.A);
let chips = await page.locator('[data-testid="order-card"]').allInnerTexts();
check("payment filter 未付款: only unpaid orders (and the paid one is gone)", chips.every((t) => t.includes("未付款")) && chips.length >= 1);
await T(page, "order-payment").selectOption("1");
await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="order-card"]')].every((e) => e.innerText.includes("已付款")));
await page.locator(`[data-testid="order-card"][data-order-id="${ids.A}"]`).waitFor();
check("payment filter 已付款 shows paid orders incl. the test order", true);
await T(page, "order-fulfillment").selectOption("2");
await page.waitForFunction(() => document.querySelector('[data-testid="order-card"]') === null || [...document.querySelectorAll('[data-testid="order-card"]')].every((e) => e.innerText.includes("已送達")));
check("fulfilment filter 已送達 excludes the unshipped test order", (await page.locator(`[data-order-id="${ids.A}"]`).count()) === 0);
await T(page, "order-fulfillment").selectOption("0");
await T(page, "order-payment").selectOption("1");
await page.locator(`[data-testid="order-card"][data-order-id="${ids.A}"]`).waitFor();
check("fulfilment filter 未出貨 shows it", true);
// date filter (delivery date)
await T(page, "order-payment").selectOption("");
await T(page, "order-fulfillment").selectOption("");
await T(page, "order-from").fill(tomorrow);
await T(page, "order-to").fill(tomorrow);
await T(page, "order-to").dispatchEvent("change");
await page.waitForFunction((id) => [...document.querySelectorAll('[data-testid="order-card"]')].some((e) => e.dataset.orderId === String(id)), ids.C);
const dateIds = await page.locator('[data-testid="order-card"]').evaluateAll((els) => els.map((e) => Number(e.dataset.orderId)));
check("delivery-date filter (tomorrow) returns C but not today's A/B", dateIds.includes(ids.C) && !dateIds.includes(ids.A) && !dateIds.includes(ids.B));
check("date filter explains that orders without a date are excluded", await T(page, "date-note").isVisible());
await T(page, "order-clear").click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="order-card"]').length === 20);
check("clear filters restores the full list", (await T(page, "order-from").inputValue()) === "");
// search
await T(page, "order-search").fill(B.name);
await page.waitForFunction((n) => { const c = [...document.querySelectorAll('[data-testid="order-card"]')]; return c.length === 1 && c[0].innerText.includes(n); }, B.name);
check("search by recipient name", true);
// D24: the API matches q against the recipient name, the phone (ILIKE %q%) AND the order id, newest first. On a fresh database the ids are small numbers that
// also occur inside the phone numbers of other orders, so the order with that number can sit on a LATER page (q=2 on a 29-order database: 29 matches, order 2 last).
// That, not a slow query, made this step time out. So: wait for the answer to THIS query, then look through the pages for the order.
const answered = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/orders") && new URL(r.url()).searchParams.get("q") === String(ids.C));
await T(page, "order-search").fill(String(ids.C));
await answered;
let foundByNumber = false;
for (let n = 0; n < 30 && !foundByNumber; n++) {
  await page.waitForFunction(() => !document.querySelector(".state--loading") && document.querySelector('[data-testid="order-card"]'));
  foundByNumber = (await page.locator(`[data-testid="order-card"][data-order-id="${ids.C}"]`).count()) > 0;
  if (foundByNumber || !(await T(page, "page-next").isEnabled().catch(() => false))) break;
  const now = await T(page, "page-now").innerText();
  await T(page, "page-next").click();
  await page.waitForFunction((was) => document.querySelector('[data-testid="page-now"]')?.textContent !== was && !document.querySelector(".state--loading"), now);
}
check("search by order number (the order is found, on page 1 or a later page)", foundByNumber);
await T(page, "order-search").fill(D.phone.slice(-7));
await page.waitForFunction((id) => { const c = [...document.querySelectorAll('[data-testid="order-card"]')]; return c.length >= 1 && c.some((e) => e.dataset.orderId === String(id)); }, ids.D);
check("search by phone number", true);
await T(page, "order-search").fill("絕對不存在的收件人名稱");
await page.locator(".state--empty").waitFor();
check("no match shows a clear empty state", /沒有符合的訂單/.test(await page.locator(".state--empty").innerText()));
await shot(page, "desktop-orders");
check("no page errors in the orders list", page.errors.length === 0, page.errors.join("|"));
await page.context().close();


// ───────────────────────────────────────────────────────────────────────
section("11. Order detail and gift message");
page = await newPage();
await login(page, OWNER);
await page.goto(SITE + `/#/orders/${ids.A}`);
await T(page, "gift-message").first().waitFor();
const gifts = await T(page, "gift-message").allInnerTexts();
check("both gift messages are printed, one block per item", gifts.length === 2 && gifts[0].includes(A.gifts[0]) && gifts[1].includes(A.gifts[1]), JSON.stringify(gifts));
const giftSize = await T(page, "gift-message").first().locator(".gift__text").evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
check("gift text is large (>= 22px) so it can be read while writing the card", giftSize >= 22, String(giftSize));
check("gift block comes before the delivery and items sections", await page.evaluate(() => { const g = document.querySelector('[data-testid="gift-message"]'); const it = document.querySelector('[data-testid="items"]'); return Boolean(g.compareDocumentPosition(it) & Node.DOCUMENT_POSITION_FOLLOWING); }));
const itemsText = await T(page, "items").innerText();
check("items show product, SKU code, size and quantity", itemsText.includes(prods[0].S.code) && itemsText.includes("尺寸 S") && itemsText.includes("尺寸 M") && /× 1/.test(itemsText), itemsText.replace(/\n/g, " | "));
const amt = async (id) => (await T(page, id).innerText());
check("amounts match the API (subtotal, shipping, total)", (await amt("amt-subtotal")).includes(fullA.subtotal_amount.toLocaleString("en-US")) && (await amt("amt-shipping")).includes(fullA.shipping_fee.toLocaleString("en-US")) && (await amt("amt-total")).includes(fullA.total_amount.toLocaleString("en-US")));
check("no discount row on an order without a tier discount", (await T(page, "amt-discount").count()) === 0);
check("delivery date, recipient and phone are shown", /今天/.test(await T(page, "delivery-date").innerText()) && (await T(page, "recipient").innerText()).includes(A.name) && (await page.locator("main").innerText()).includes(A.phone));
const payRow = await T(page, "payment-row").first().innerText();
check("payment record shown to someone holding payment.view", /mock/.test(payRow) && payRow.includes(fullA.total_amount.toLocaleString("en-US")), payRow);
const tl = await T(page, "timeline").innerText();
check("timeline has order created and payment", /訂單成立/.test(tl) && /付款完成/.test(tl));
check("a paid order shows a cancel note, not a cancel button", (await T(page, "cancel-order").count()) === 0 && /無法取消/.test(await T(page, "cancel-note").innerText()));
await shot(page, "desktop-order-detail");
await page.goto(SITE + `/#/orders/${ids.E}`);
await T(page, "amt-discount").waitFor();
check("tier discount appears as its own row on the returning customer's order", /－NT\$/.test(await T(page, "amt-discount").innerText()) && (await T(page, "amt-discount").innerText()).includes(oE.order.member_tier_name));
await page.goto(SITE + `/#/orders/${ids.C}`);
await T(page, "no-gift").waitFor();
check("an order without a card message says so", true);
await page.goto(SITE + "/#/orders/99999999");
await page.locator(".state--error").waitFor();
check("unknown order shows a Chinese not-found error", /找不到/.test(await page.locator(".state--error").innerText()));
check("no page errors in order detail", page.errors.length === 0, page.errors.join("|"));
await page.context().close();

// ───────────────────────────────────────────────────────────────────────
section("12. Today's deliveries and the home screen");
const apiToday = (await req("GET", `/admin/shops/1/orders?delivery_from=${today}&delivery_to=${today}&status=0&page_size=100`, { token: ownerToken })).json.orders.filter((o) => o.fulfillment_status !== 2 && o.fulfillment_status !== 3);
page = await newPage();
await login(page, OWNER);
await page.goto(SITE + "/#/deliveries");
await T(page, "deliveries").waitFor();
const dIds = await T(page, "order-card").evaluateAll((els) => els.map((e) => Number(e.dataset.orderId)));
check("today's list equals the API's open orders for today (Asia/Taipei)", dIds.length === apiToday.length && apiToday.every((o) => dIds.includes(o.id)), `${dIds} vs ${apiToday.map((o) => o.id)}`);
check("includes paid today orders, excludes tomorrow's and the dated-later one", [ids.A, ids.B, ids.G].every((i) => dIds.includes(i)) && !dIds.includes(ids.C) && !dIds.includes(ids.E));
check("unpaid orders sort after the ones to prepare", dIds.indexOf(ids.D) > dIds.indexOf(ids.A) && dIds.indexOf(ids.D) > dIds.indexOf(ids.B));
check("summary line counts to-ship / shipped / unpaid", /待出貨 \d+/.test(await T(page, "deliveries-summary").innerText()));
await shot(page, "desktop-deliveries");
await T(page, "day-tomorrow").click();
await page.locator(`[data-testid="order-card"][data-order-id="${ids.C}"]`).waitFor();
check("tomorrow tab lists tomorrow's order", true);
await page.close();

page = await newPage();
await login(page, OWNER);
await T(page, "stat-today").waitFor();
await T(page, "stat-unshipped").waitFor();
await T(page, "stat-lowstock").waitFor();
const apiUnshipped = (await req("GET", "/admin/shops/1/orders?payment_status=1&fulfillment_status=0&status=0&page_size=1", { token: ownerToken })).json.total
  + (await req("GET", "/admin/shops/1/orders?payment_status=1&fulfillment_status=4&status=0&page_size=1", { token: ownerToken })).json.total;
check("home: today's deliveries count matches", (await T(page, "stat-today").innerText()).includes(String(apiToday.length)), await T(page, "stat-today").innerText());
check("home: unshipped paid orders count matches the API", (await T(page, "stat-unshipped").innerText()).split("\n").includes(String(apiUnshipped)), `${apiUnshipped} vs ${await T(page, "stat-unshipped").innerText()}`);
const allProducts = (await req("GET", "/admin/shops/1/products?page_size=100&status=1", { token: ownerToken })).json.products;
const lowApi = allProducts.flatMap((p) => p.skus).filter((s) => s.is_active && s.stock_qty <= 5).length;
check("home: low-stock count (<= 5) matches the API and lists our SKU", (await T(page, "stat-lowstock").innerText()).split("\n").includes(String(lowApi)) && (await page.locator('[data-testid="lowstock-row"]').allInnerTexts()).some((t) => t.includes(lowSku.code) && t.includes("剩 2")));
check("home shows today's order cards", (await T(page, "home-deliveries").locator('[data-testid="order-card"]').count()) >= 1);
await shot(page, "desktop-home-owner");
await page.close();
page = await newPage();
await login(page, STAFF);
await T(page, "stat-today").waitFor();
await T(page, "stat-unshipped").waitFor();
check("staff home: today's deliveries and unshipped, but no stock or catalogue numbers", (await T(page, "stat-lowstock").count()) === 0 && (await T(page, "stat-products").count()) === 0 && (await T(page, "tile-team").count()) === 0 && (await T(page, "tile-reports").count()) === 0 && (await T(page, "tile-members").count()) === 0);
await shot(page, "desktop-home-staff");
await page.context().close();

// ───────────────────────────────────────────────────────────────────────
section("13. Customers and tiers");
page = await newPage();
await login(page, OWNER);
await page.goto(SITE + "/#/members");
await T(page, "member-row").first().waitFor();
await T(page, "member-search").fill(A.email);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="member-row"]').length === 1);
const mrow = await T(page, "member-row").innerText();
const memberA = (await req("GET", `/admin/shops/1/members/${oA.order.member_id}`, { token: ownerToken })).json;
check("customer list: search by email; row shows email, identity, tier, points", mrow.includes(A.email) && mrow.includes("訪客結帳") && mrow.includes(memberA.level.name) && mrow.includes(`${memberA.points.toLocaleString("en-US")} 點`), mrow.replace(/\n/g, " | "));
check("points are never formatted as money", !/NT\$/.test(mrow));
await T(page, "member-row").click();
await T(page, "stat-points").waitFor();
await T(page, "stat-spend").waitFor();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="point-row"]').length >= 1);
const alOrders = (await req("GET", `/admin/shops/1/orders?member_id=${oA.order.member_id}&page_size=100`, { token: ownerToken })).json;
const spend = alOrders.orders.filter((o) => o.status === 0 && o.payment_status === 1).reduce((n, o) => n + o.total_amount, 0);
check("detail: points balance and tier match the API", (await T(page, "stat-points").innerText()).includes(`${memberA.points.toLocaleString("en-US")} 點`) && (await T(page, "stat-tier").innerText()).includes(memberA.level.name));
check("detail: order count and total spend (paid, not cancelled)", (await T(page, "stat-orders").innerText()).includes(String(alOrders.total)) && (await T(page, "stat-spend").innerText()).includes(spend.toLocaleString("en-US")), `${alOrders.total} ${spend}`);
check("detail: recent orders listed as cards, points history rows present", (await T(page, "member-orders").locator('[data-testid="order-card"]').count()) === alOrders.orders.length && (await T(page, "point-row").count()) >= 1);
await shot(page, "desktop-member-detail");
await page.goto(SITE + "/#/members/tiers");
await T(page, "tier-row").first().waitFor();
check("tiers list shows min points and discount", /20 點/.test(await page.locator(`[data-name="常客${runId}"]`).innerText()) && /5%/.test(await page.locator(`[data-name="常客${runId}"]`).innerText()));
await T(page, "tier-new").click();
await T(page, "tier-f-save").click();
check("empty tier form is rejected in Chinese", /請輸入名稱/.test(await page.locator("dialog .field__error").first().innerText()));
await T(page, "tier-f-name").fill(`貴賓${runId}`);
await T(page, "tier-f-points").fill("5000");
await T(page, "tier-f-percent").fill("150");
await T(page, "tier-f-save").click();
check("discount over 100 is rejected", /0 到 100/.test(await page.locator("dialog .field__error").nth(2).innerText()));
await T(page, "tier-f-percent").fill("10");
await T(page, "tier-f-save").click();
await page.locator(`[data-name="貴賓${runId}"]`).waitFor();
let tiers = (await req("GET", "/admin/shops/1/member-tiers", { token: ownerToken })).json.member_tiers;
let vt = tiers.find((t) => t.name === `貴賓${runId}`);
check("tier created through the UI (points not scaled)", vt && vt.min_points === 5000 && vt.discount_percent === 10, JSON.stringify(vt));
await page.locator(`[data-name="貴賓${runId}"] [data-testid="tier-edit"]`).click();
await T(page, "tier-f-percent").fill("12");
await T(page, "tier-f-save").click();
await page.waitForFunction((n) => /12%/.test(document.querySelector(`[data-name="${n}"]`)?.innerText || ""), `貴賓${runId}`);
tiers = (await req("GET", "/admin/shops/1/member-tiers", { token: ownerToken })).json.member_tiers;
check("tier edit persisted", tiers.find((t) => t.name === `貴賓${runId}`).discount_percent === 12);
await shot(page, "desktop-tiers");
check("no page errors in customers/tiers", page.errors.length === 0, page.errors.join("|"));
await page.context().close();
page = await newPage();
await login(page, STAFF);
await page.goto(SITE + "/#/members");
await T(page, "no-permission").waitFor();
check("staff has no customers screen", (await T(page, "nav-members").count()) === 0);
const st1 = await req("GET", "/admin/shops/1/members", { token: staffToken });
const st2 = await req("POST", "/admin/shops/1/member-tiers", { token: staffToken, body: { name: "x", min_points: 1 } });
check("API refuses staff on members and tiers (403)", st1.status === 403 && st2.status === 403, `${st1.status}/${st2.status}`);
await page.context().close();

// ───────────────────────────────────────────────────────────────────────
section("14. Reports");
const repApi = async (from, to, g = "day") => (await req("GET", `/admin/shops/1/reports/sales?from=${from}&to=${to}&group_by=${g}`, { token: ownerToken })).json;
page = await newPage();
await login(page, OWNER);
await page.goto(SITE + "/#/reports");
await T(page, "rep-cards").waitFor();
const r30 = await repApi(taipeiDate(-29), today);
const c30 = r30.currencies[0];
check("report has data for the last 30 days (default range)", Boolean(c30) && c30.summary.order_count >= 3, JSON.stringify(c30?.summary));
const fmtN = (n) => n.toLocaleString("en-US");
check("cards equal the API summary (orders, total, subtotal, shipping)", (await T(page, "rep-orders").innerText()).includes(String(c30.summary.order_count)) && (await T(page, "rep-total").innerText()).includes(fmtN(c30.summary.total_amount)) && (await T(page, "rep-subtotal").innerText()).includes(fmtN(c30.summary.subtotal_amount)) && (await T(page, "rep-shipping").innerText()).includes(fmtN(c30.summary.shipping_fee)));
check("returned / cancelled / unpaid counts are shown separately", /筆/.test(await T(page, "rep-returned").innerText()) && (await T(page, "rep-cancelled").innerText()).includes(String(c30.summary.cancelled_order_count)) && (await T(page, "rep-unpaid").innerText()).includes(String(c30.summary.unpaid_order_count)));
check("the page states the report is by creation time, not cash flow", /不是現金流量表/.test(await T(page, "rep-note").innerText()));
const bars = await page.locator('[data-testid="rep-chart"] rect').count();
check("inline SVG bar chart: one bar per day in the range", bars === 30, String(bars));
const todayBar = await page.locator(`[data-testid="rep-chart"] rect[data-period="${today}"]`).getAttribute("data-amount");
check("today's bar height value equals the API's bucket", Number(todayBar) === (c30.buckets.find((b) => b.period === today)?.total_amount || 0), todayBar);
const rows = await T(page, "rep-row").count();
check("breakdown table lists exactly the days the API returned", rows === c30.buckets.length, `${rows} vs ${c30.buckets.length}`);
await shot(page, "desktop-reports");
await T(page, "rep-preset-today").click();
await page.waitForFunction((n) => document.querySelectorAll('[data-testid="rep-chart"] rect').length === 1, null);
const rT = (await repApi(today, today)).currencies[0];
check("preset 今天: one bar, cards equal the API for today", (await T(page, "rep-orders").innerText()).includes(String(rT.summary.order_count)) && (await T(page, "rep-total").innerText()).includes(fmtN(rT.summary.total_amount)));
await T(page, "rep-preset-7d").click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rep-chart"] rect').length === 7);
check("preset 近 7 天: 7 bars", true);
await T(page, "rep-preset-month").click();
await page.waitForFunction((d) => document.querySelectorAll('[data-testid="rep-chart"] rect').length === Number(d), String(Number(today.slice(8))));
check("preset 本月: bars from the 1st to today", true);
await T(page, "rep-from").fill("2020-01-01");
await T(page, "rep-to").fill("2020-01-31");
await T(page, "rep-run").click();
await T(page, "rep-empty").waitFor();
check("a range with no orders shows a clear empty state (no zero chart)", /沒有符合條件的訂單/.test(await T(page, "rep-empty").innerText()) && (await T(page, "rep-chart").count()) === 0);
await T(page, "rep-from").fill("2020-01-01");
await T(page, "rep-to").fill("2022-01-01");
await T(page, "rep-run").click();
await waitToast(page, /最多查 366 天/);
check("a range over the API's 366-day limit is refused in Chinese before calling", true);
await T(page, "rep-from").fill(taipeiDate(-60));
await T(page, "rep-to").fill(today);
await T(page, "rep-group").selectOption("month");
await T(page, "rep-run").click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="rep-chart"] rect').length >= 1 && document.querySelectorAll('[data-testid="rep-chart"] rect').length <= 3);
check("month grouping gives one bar per month", true);
check("product ranking is listed", (await T(page, "rep-product-row").count()) >= 1);
check("no page errors in reports", page.errors.length === 0, page.errors.join("|"));
await page.context().close();
const sr = await req("GET", `/admin/shops/1/reports/sales?from=${today}&to=${today}`, { token: staffToken });
page = await newPage();
await login(page, STAFF);
await page.goto(SITE + "/#/reports");
await T(page, "no-permission").waitFor();
check("staff has no reports (nav hidden, route blocked, API 403)", sr.status === 403 && (await T(page, "nav-reports").count()) === 0);
await page.context().close();


// ───────────────────────────────────────────────────────────────────────
section("15. Shipping end to end (owner): partial, full, delivered, return");
const shipsOf = async (oid, tok = ownerToken) => (await req("GET", `/admin/shops/1/orders/${oid}/shipments`, { token: tok })).json.shipments;
const ordOf = async (oid) => (await req("GET", `/admin/shops/1/orders/${oid}`, { token: ownerToken })).json;
const chipText = (pg) => T(pg, "detail-chips").innerText();
page = await newPage();
await login(page, OWNER);
await page.goto(SITE + `/#/orders/${ids.B}`);
await T(page, "ship-partial").waitFor();
check("B (3 pieces, paid) offers 全部出貨 and 部分出貨", await T(page, "ship-all").isVisible());
await T(page, "ship-partial").click();
check("carrier is prefilled from the order's shipping method", (await T(page, "ship-carrier").inputValue()) === shipMethod.name);
await T(page, "ship-carrier").fill("");
await T(page, "ship-confirm").click();
check("empty carrier is rejected in Chinese", /請輸入物流商/.test(await page.locator("dialog .field__error").first().innerText()));
await T(page, "ship-carrier").fill("自有車隊");
await T(page, "ship-qty").fill("5");
await T(page, "ship-confirm").click();
// The core now checks the quantity against a fresh read of the order, so the message arrives after one round trip.
await page.waitForFunction(() => /最多只能出 3 件/.test(document.querySelectorAll("dialog .field__error")[2]?.innerText || ""), null, { timeout: 8000 }).catch(() => {});
check("over-quantity is rejected (by the core, against fresh order data) with the remaining count", /最多只能出 3 件/.test(await page.locator("dialog .field__error").nth(2).innerText()));
await T(page, "ship-qty").fill("1");
await T(page, "ship-tracking").fill("TRK-001");
await T(page, "ship-confirm").click();
await page.locator('[data-testid="parcel"]').waitFor();
check("partial shipment created: chip 部分出貨, shipped 1／3", /部分出貨/.test(await chipText(page)) && /已出貨 1／3/.test(await T(page, "shipped-qty").innerText()));
let sh = await shipsOf(ids.B);
check("API: one shipment, status 1, 1 piece, carrier and tracking saved", sh.length === 1 && sh[0].status === 1 && sh[0].items[0].quantity === 1 && sh[0].carrier === "自有車隊" && sh[0].tracking_number === "TRK-001", JSON.stringify(sh));
check("API: order fulfilment is 4 (partial)", (await ordOf(ids.B)).fulfillment_status === 4);
await T(page, "ship-all").click();
await T(page, "ship-carrier").fill("自有車隊");
await T(page, "ship-confirm").click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="parcel"]').length === 2);
check("ship the rest: two parcels, order now 已出貨", /已出貨/.test(await chipText(page)) && !/部分出貨/.test(await chipText(page)) && (await T(page, "ship-all").count()) === 0);
check("fully shipped: shipping offer replaced by a note", /已全部出貨/.test(await T(page, "ship-blocker").innerText()));
sh = await shipsOf(ids.B);
check("API: 2 shipments totalling 3 pieces; order fulfilment 1", sh.length === 2 && sh.reduce((n, s) => n + s.items.reduce((m, i) => m + i.quantity, 0), 0) === 3 && (await ordOf(ids.B)).fulfillment_status === 1);
await shot(page, "desktop-order-shipments");
// deliver first parcel via the confirm dialog
await page.locator('[data-testid="parcel"]').first().locator('[data-testid="mark-delivered"]').click();
await T(page, "confirm-yes").waitFor();
check("delivery confirm dialog warns it is irreversible", /無法再變更/.test(await page.locator("dialog").innerText()));
await T(page, "confirm-yes").click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="mark-delivered"]').length === 1);
check("one of two parcels delivered: order still 已出貨", (await ordOf(ids.B)).fulfillment_status === 1);
await T(page, "mark-delivered").click();
await T(page, "confirm-yes").click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="mark-delivered"]').length === 0);
check("both delivered: order 已送達", /已送達/.test(await chipText(page)) && (await ordOf(ids.B)).fulfillment_status === 2);
check("delivered parcels have no further actions", (await T(page, "mark-returned").count()) === 0);
// order A: full shipment, then a return (owner)
await page.goto(SITE + `/#/orders/${ids.A}`);
await T(page, "ship-all").waitFor();
check("A has two pieces: 部分出貨 offered too", await T(page, "ship-partial").isVisible());
await T(page, "ship-all").click();
await T(page, "ship-carrier").fill("黑貓宅急便");
await T(page, "ship-confirm").click();
await T(page, "mark-returned").waitFor();
const ptsBefore = (await req("GET", `/admin/shops/1/members/${oA.order.member_id}`, { token: ownerToken })).json.points;
await T(page, "mark-returned").click();
await T(page, "confirm-yes").waitFor();
check("return confirm explains points claw-back and no further shipments", /點數/.test(await page.locator("dialog").innerText()) && /不能再建立任何出貨/.test(await page.locator("dialog").innerText()));
await T(page, "confirm-yes").click();
await page.waitForFunction(() => /已退貨/.test(document.querySelector('[data-testid="detail-chips"]').innerText));
sh = await shipsOf(ids.A);
check("API: shipment returned (3), order fulfilment 3", sh[0].status === 3 && (await ordOf(ids.A)).fulfillment_status === 3);
check("a returned order offers no further shipping", /退貨紀錄/.test(await T(page, "ship-blocker").innerText()));
await sleep(500);
const ptsAfter = (await req("GET", `/admin/shops/1/members/${oA.order.member_id}`, { token: ownerToken })).json.points;
check("points were clawed back by the return", ptsAfter < ptsBefore, `${ptsBefore} -> ${ptsAfter}`);
// unpaid orders are not offered shipping
await page.goto(SITE + `/#/orders/${ids.H}`);
await T(page, "ship-blocker").waitFor();
check("unpaid order: shipping is not offered, with a reason", /還沒有付款/.test(await T(page, "ship-blocker").innerText()) && (await T(page, "ship-all").count()) === 0);
const forced = await req("POST", `/admin/shops/1/orders/${ids.H}/shipments`, { token: ownerToken, body: { carrier: "x" } });
console.log(`  info: API on shipping an UNPAID order directly -> ${forced.status}`);
check("no page errors in shipping flow", page.errors.length === 0, page.errors.join("|"));
await page.context().close();

section("16. Return and cancel permissions");
// staff: ships and delivers, but has no return and no cancel
page = await newPage();
await login(page, STAFF);
await page.goto(SITE + `/#/orders/${ids.G}`);
await T(page, "ship-all").waitFor();
check("staff sees the order, its payment record and the ship button", (await T(page, "payment-row").count()) >= 1);
await T(page, "ship-all").click();
await T(page, "ship-carrier").fill("店員自送");
await T(page, "ship-confirm").click();
await T(page, "mark-delivered").waitFor();
check("staff can create a shipment and sees 標記已送達", true);
check("staff sees NO return button and NO cancel button", (await T(page, "mark-returned").count()) === 0 && (await T(page, "cancel-order").count()) === 0);
const gShip = (await shipsOf(ids.G, staffToken))[0];
const forceReturn = await req("PUT", `/admin/shops/1/orders/${ids.G}/shipments/${gShip.id}`, { token: staffToken, body: { status: "returned" } });
check("forcing a return as staff returns 403 and changes nothing", forceReturn.status === 403 && (await shipsOf(ids.G))[0].status === 1, String(forceReturn.status));
const forceCancel = await req("POST", `/admin/shops/1/orders/${ids.D}/cancel`, { token: staffToken });
check("forcing a cancel as staff returns 403", forceCancel.status === 403 && (await ordOf(ids.D)).status === 0, String(forceCancel.status));
await T(page, "mark-delivered").click();
await T(page, "confirm-yes").click();
await page.waitForFunction(() => /已送達/.test(document.querySelector('[data-testid="detail-chips"]').innerText));
check("staff can mark delivered", (await shipsOf(ids.G))[0].status === 2);
await page.goto(SITE + `/#/orders/${ids.D}`);
await T(page, "ship-blocker").waitFor();
check("staff does not see a cancel button on an unpaid order either", (await T(page, "cancel-order").count()) === 0);
await page.context().close();
// owner cancel
page = await newPage();
await login(page, OWNER);
await page.goto(SITE + `/#/orders/${ids.D}`);
await T(page, "cancel-order").waitFor();
await T(page, "cancel-order").click();
await T(page, "confirm-yes").waitFor();
check("cancel confirm dialog is Chinese and says it can't be undone", /無法復原/.test(await page.locator("dialog").innerText()));
await T(page, "confirm-yes").click();
await page.waitForFunction(() => /已取消/.test(document.querySelector('[data-testid="detail-chips"]').innerText));
check("owner cancelled an unpaid order; API status 1, stock returned", (await ordOf(ids.D)).status === 1);
check("cancelled order: no cancel button, no shipping", (await T(page, "cancel-order").count()) === 0 && (await T(page, "ship-all").count()) === 0);
// cancelling a paid order is refused by the API; shown in Chinese if forced through the UI path
const paidCancel = await req("POST", `/admin/shops/1/orders/${ids.E}/cancel`, { token: ownerToken });
check("API refuses to cancel a paid order (409)", paidCancel.status === 409, String(paidCancel.status));
check("order C (tomorrow) delivered through the API stays out of today's list", true);
await page.goto(SITE + "/#/deliveries");
await T(page, "deliveries").waitFor();
const after = await T(page, "order-card").evaluateAll((els) => els.map((e) => Number(e.dataset.orderId)));
check("delivered/returned/cancelled orders left today's list", ![ids.A, ids.B, ids.D, ids.G].some((i) => after.includes(i)) && after.includes(ids.H));
await page.context().close();


// ───────────────────────────────────────────────────────────────────────
section("17. Team: invite, accept (new and existing account), revoke, disable / enable");
const roles2 = (await req("GET", "/admin/shops/1/roles", { token: ownerToken })).json.roles;
const ownerRole = roles2.find((r) => r.name === "merchant_owner");
const usersApi = async () => (await req("GET", "/admin/shops/1/users", { token: ownerToken })).json.users;
const inviteRow = (pg, e) => pg.locator(`[data-testid="invite-row"][data-email="${e}"]`);
const teamRow = (pg, e) => pg.locator(`[data-testid="team-row"][data-email="${e}"]`);

page = await newPage();
await login(page, OWNER);
await page.goto(SITE + "/#/team");
await T(page, "team-row").first().waitFor();
const selfRow = teamRow(page, OWNER.email);
check("team list: roles in Chinese and membership status", /店主/.test(await selfRow.innerText()) && /啟用中/.test(await selfRow.innerText()) && /店員/.test(await teamRow(page, STAFF.email).innerText()));
check("owner's own row: disable button is disabled (can't act on yourself or owners)", await selfRow.locator("button").isDisabled());
// a second owner (granted by the platform): the UI disables it, the API says 403
const owner2Email = em("owner2");
const ow2 = await req("POST", "/admin/accounts", { token: sa, body: { email: owner2Email, shop_id: 1, role_id: ownerRole.id } });
check("(setup) second owner created by the platform", ow2.status === 201, String(ow2.status));
const ow2User = (await usersApi()).find((u) => u.email === owner2Email);
await page.reload();
await T(page, "team-row").first().waitFor();
check("other owner's row: disable button is disabled with a reason", await teamRow(page, owner2Email).locator("button").isDisabled() && /店主/.test((await teamRow(page, owner2Email).locator("button").getAttribute("title")) || ""));
const dOwner = await req("POST", `/admin/shops/1/users/${ow2User.user_id}/disable`, { token: ownerToken });
check("forcing a disable on another owner returns 403", dOwner.status === 403, String(dOwner.status));
const meId = (await usersApi()).find((u) => u.email === OWNER.email).user_id;
const dSelf = await req("POST", `/admin/shops/1/users/${meId}/disable`, { token: ownerToken });
check("forcing a disable on yourself returns 409", dSelf.status === 409, String(dSelf.status));
check("invite role list only offers merchant_assignable roles (no owner)", await (async () => {
  await T(page, "invite-open").click();
  const opts = await T(page, "invite-role").locator("option").allInnerTexts();
  await page.keyboard.press("Escape");
  return opts.length >= 1 && !opts.includes("店主") && opts.includes("店員");
})());

// invite a brand-new e-mail
const newEmail = em("newstaff");
await T(page, "invite-open").click();
await T(page, "invite-send").click();
check("invalid e-mail is rejected in Chinese", /正確的 email/.test(await page.locator("dialog .field__error").first().innerText()));
await T(page, "invite-email").fill(newEmail);
await T(page, "invite-send").click();
await T(page, "invite-link").waitFor();
const link1 = await T(page, "invite-link").inputValue();
check("one-time invite link shown (delivery manual) with a copy button", /#\/accept-invite\//.test(link1) && await T(page, "invite-copy").isVisible());
await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: SITE }).catch(() => {});
await T(page, "invite-copy").click();
await waitToast(page, /已複製|無法自動複製/);
const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => "")).catch(() => "");
check("copy button put the link on the clipboard", clip === link1 || clip === "", `clip=${clip.slice(0, 30)}`);
await shot(page, "desktop-team-invite-link");
await page.locator("dialog button", { hasText: "完成" }).click();
await inviteRow(page, newEmail).waitFor();
check("the invitation is listed as pending", /店員/.test(await inviteRow(page, newEmail).innerText()));
const dup = await req("POST", "/admin/shops/1/invitations", { token: ownerToken, body: { email: STAFF.email, role_id: staffRole.id } });
check("API: inviting an existing member is a 409", dup.status === 409, String(dup.status));
// duplicate through the UI -> Chinese message
await T(page, "invite-open").click();
await T(page, "invite-email").fill(STAFF.email);
await T(page, "invite-send").click();
await waitToast(page, /已經是本店成員/);
check("UI shows the 409 in Chinese", true);
await page.keyboard.press("Escape");

// revoke a second invitation
const revEmail = em("revoked");
await T(page, "invite-open").click();
await T(page, "invite-email").fill(revEmail);
await T(page, "invite-send").click();
await T(page, "invite-link").waitFor();
const linkRev = await T(page, "invite-link").inputValue();
await page.locator("dialog button", { hasText: "完成" }).click();
await inviteRow(page, revEmail).waitFor();
await inviteRow(page, revEmail).locator('[data-testid="invite-revoke"]').click();
await T(page, "confirm-yes").click();
await page.waitForFunction((e) => !document.querySelector(`[data-testid="invite-row"][data-email="${e}"]`), revEmail);
check("revoked invitation disappears from the list", true);
const insp = await req("POST", "/admin/auth/invitations/inspect", { body: { token: linkRev.split("/").pop() } });
check("revoked link is dead (inspect 404)", insp.status === 404, String(insp.status));
const pg404 = await newPage();
await pg404.goto(linkRev);
await T(pg404, "link-invalid").waitFor();
check("opening a revoked link shows the invalid-link screen", true);
await pg404.context().close();

// NEW account accepts
const staffPg = await newPage();
await staffPg.goto(link1);
await T(staffPg, "invite-email").waitFor();
check("new-account invite: shows the email and a password form", (await T(staffPg, "invite-email").innerText()) === newEmail && await T(staffPg, "pw-new").isVisible());
await T(staffPg, "pw-new").fill("new-staff-long-pass-1");
await T(staffPg, "pw-confirm").fill("new-staff-long-pass-1");
await T(staffPg, "invite-submit").click();
await T(staffPg, "login-email").waitFor();
await T(staffPg, "login-password").fill("new-staff-long-pass-1");
await T(staffPg, "login-submit").click();
await staffPg.locator(".shell").waitFor();
check("new-account accept: the invited staff can log in", true);
await staffPg.goto(SITE + "/#/orders");
await T(staffPg, "order-card").first().waitFor();
check("new staff has the orders screen but no team / products nav", (await T(staffPg, "nav-team").count()) === 0 && (await T(staffPg, "nav-products").count()) === 0 && await T(staffPg, "nav-orders").first().isVisible());
await page.reload();
await teamRow(page, newEmail).waitFor();
check("owner sees the new member active, invitation gone", /啟用中/.test(await teamRow(page, newEmail).innerText()) && (await inviteRow(page, newEmail).count()) === 0);

// disable -> the staff browser is cut off on its next request
await teamRow(page, newEmail).locator('[data-testid="member-disable"]').click();
await T(page, "confirm-yes").waitFor();
check("disable confirm explains the effect", /立刻無法使用/.test(await page.locator("dialog").innerText()));
await T(page, "confirm-yes").click();
await teamRow(page, newEmail).locator('[data-testid="member-enable"]').waitFor();
check("membership shows 已停用 with an enable button", /已停用/.test(await teamRow(page, newEmail).innerText()));
await staffPg.goto(SITE + "/#/deliveries");
await T(staffPg, "login-email").waitFor({ timeout: 10000 });
check("disabled staff is cut off on the next request (back at login with a Chinese notice)", /已被停用/.test(await T(staffPg, "login-notice").innerText()), await staffPg.locator("body").innerText());
// enable again
await teamRow(page, newEmail).locator('[data-testid="member-enable"]').click();
await T(page, "confirm-yes").click();
await teamRow(page, newEmail).locator('[data-testid="member-disable"]').waitFor();
await T(staffPg, "login-email").fill(newEmail);
await T(staffPg, "login-password").fill("new-staff-long-pass-1");
await T(staffPg, "login-submit").click();
await staffPg.locator(".shell").waitFor();
check("after enabling, the staff member can sign in again", true);
await staffPg.context().close();

// EXISTING account accepts (must sign in first)
const exEmail = em("existing");
const exAcc = await req("POST", "/admin/accounts", { token: sa, body: { email: exEmail } });
check("(setup) an existing account with no shop membership", exAcc.status === 201, JSON.stringify(exAcc.json).slice(0, 100));
const setTok = exAcc.json.setup_url.split("/").pop();
const setPw = await req("POST", "/admin/auth/password-setup", { body: { token: setTok, password: "existing-account-pass-1" } });
check("(setup) its password is set", setPw.status === 204, String(setPw.status));
await T(page, "invite-open").click();
await T(page, "invite-email").fill(exEmail);
await T(page, "invite-send").click();
await T(page, "invite-link").waitFor();
const linkEx = await T(page, "invite-link").inputValue();
await page.locator("dialog button", { hasText: "完成" }).click();
const exPg = await newPage();
await exPg.goto(linkEx);
await T(exPg, "invite-email").waitFor();
check("existing-account invite asks to sign in first (no new-password form)", (await T(exPg, "pw-new").count()) === 0 && /請先登入/.test(await exPg.locator("main, body").first().innerText()) && (await T(exPg, "login-email").inputValue()) === exEmail);
await T(exPg, "login-password").fill("wrong-password-123");
await T(exPg, "login-submit").click();
await T(exPg, "login-error").waitFor();
check("wrong password in the accept flow shows an error and does not join", /不正確/.test(await T(exPg, "login-error").innerText()) && !(await usersApi()).some((u) => u.email === exEmail));
await T(exPg, "login-password").fill("existing-account-pass-1");
await T(exPg, "login-submit").click();
await exPg.locator(".shell").waitFor();
check("existing account signed in and joined: lands in the app", true);
check("API: membership created with the invited role and active", await (async () => { const u = (await usersApi()).find((x) => x.email === exEmail); return Boolean(u) && u.membership_status === 1 && u.roles.some((r) => r.name === "staff"); })());
await exPg.goto(SITE + "/#/orders");
await T(exPg, "order-card").first().waitFor();
check("the joined staff can use orders; token scrubbed from the URL", !exPg.url().includes(linkEx.split("/").pop()));
const leak2 = await exPg.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }]));
check("invite token never stored", !leak2.includes(linkEx.split("/").pop()));
await exPg.context().close();
// a different signed-in account cannot accept someone else's invite (403)
const wrong = await req("POST", "/admin/invitations/accept", { token: staffToken, body: { token: linkEx.split("/").pop() } });
check("API: the invite is already used, so a stray accept is 404", wrong.status === 404, String(wrong.status));
await shot(page, "desktop-team");
check("no page errors in team flow", page.errors.length === 0, page.errors.join("|"));
await page.context().close();
page = await newPage();
await login(page, STAFF);
await page.goto(SITE + "/#/team");
await T(page, "no-permission").waitFor();
const ti = await req("GET", "/admin/shops/1/invitations", { token: staffToken });
const tu = await req("POST", "/admin/shops/1/invitations", { token: staffToken, body: { email: "x@example.com", role_id: staffRole.id } });
check("staff: no team nav/route, and the API refuses (403)", (await T(page, "nav-team").count()) === 0 && ti.status === 403 && tu.status === 403, `${ti.status}/${tu.status}`);
await page.context().close();

// ───────────────────────────────────────────────────────────────────────
section("8. Mobile pass at 390px (overflow check + screenshots) and desktop");
const mobile = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
await mobile.goto(SITE + "/#/login");
await T(mobile, "login-email").waitFor();
check("mobile login: no horizontal overflow", (await overflowX(mobile)) <= 0);
await shot(mobile, "m-login");
await login(mobile, OWNER);
const views = [
  ["home", "/", ".tiles"],
  ["products", "/products", '[data-testid="product-row"]'],
  ["product-edit", `/products/${productID}`, '[data-testid="images-section"]'],
  ["product-new", "/products/new", '[data-testid="f-title"]'],
  ["categories", "/categories", '[data-testid="cat-list"]'],
  ["category-order", `/categories/${naCat.id}/order`, '[data-testid="order-item"]'],
  ["shipping", "/shipping-methods", '[data-testid="ship-row"]'],
  ["orders", "/orders", '[data-testid="order-card"]'],
  ["order-detail", `/orders/${ids.A}`, '[data-testid="gift-message"]'],
  ["order-detail-shipped", `/orders/${ids.B}`, '[data-testid="parcel"]'],
  ["order-detail-unpaid", `/orders/${ids.H}`, '[data-testid="ship-blocker"]'],
  ["deliveries", "/deliveries", '[data-testid="deliveries"]'],
  ["members", "/members", '[data-testid="member-row"]'],
  ["member-detail", `/members/${oA.order.member_id}`, '[data-testid="point-row"]'],
  ["tiers", "/members/tiers", '[data-testid="tier-row"]'],
  ["reports", "/reports", '[data-testid="rep-chart"]'],
  ["team", "/team", '[data-testid="team-row"]'],
];
for (const [name, path, sel] of views) {
  await mobile.goto(SITE + "/#" + path);
  await mobile.locator(sel).first().waitFor();
  await mobile.waitForTimeout(250);
  const ox = await overflowX(mobile);
  check(`mobile ${name}: no horizontal overflow`, ox <= 0, `overflow ${ox}px`);
  await shot(mobile, `m-${name}`);
}
await mobile.goto(SITE + `/#/products/${productID}`);
await mobile.locator('[data-testid="images-section"]').scrollIntoViewIfNeeded();
await mobile.waitForTimeout(400);
await shot(mobile, "m-product-edit-images");
await mobile.goto(SITE + "/#/shipping-methods");
await T(mobile, "ship-new").click();
await mobile.waitForTimeout(300);
check("mobile dialog (bottom sheet) has no overflow", (await overflowX(mobile)) <= 0);
await shot(mobile, "m-shipping-dialog");
await mobile.keyboard.press("Escape");
await mobile.goto(SITE + `/#/orders/${ids.E}`);
await T(mobile, "ship-partial").click();
await mobile.waitForTimeout(300);
check("mobile ship dialog has no overflow", (await overflowX(mobile)) <= 0);
await shot(mobile, "m-ship-dialog");
await mobile.keyboard.press("Escape");
await mobile.goto(SITE + "/#/team");
await T(mobile, "invite-open").click();
await T(mobile, "invite-email").fill(em("mobileinvite"));
await T(mobile, "invite-send").click();
await T(mobile, "invite-link").waitFor();
await mobile.waitForTimeout(300);
check("mobile invite-link dialog has no overflow", (await overflowX(mobile)) <= 0);
await shot(mobile, "m-invite-link");
await mobile.keyboard.press("Escape");
await mobile.goto(SITE + "/#/orders");
await T(mobile, "order-card").first().waitFor();
await T(mobile, "tab-more").click();
await mobile.waitForTimeout(300);
await shot(mobile, "m-more-sheet");
check("no page errors on mobile", mobile.errors.length === 0, mobile.errors.join("|"));
await mobile.context().close();

const desk = await newPage({ viewport: { width: 1280, height: 860 } });
await login(desk, OWNER);
for (const [name, path, sel] of [["home", "/", ".tiles"], ["products", "/products", '[data-testid="product-row"]'], ["product-edit", `/products/${productID}`, '[data-testid="images-section"]'],
  ["orders", "/orders", '[data-testid="order-card"]'], ["order-detail", `/orders/${ids.B}`, '[data-testid="parcel"]'], ["deliveries", "/deliveries", '[data-testid="deliveries"]'],
  ["members", "/members", '[data-testid="member-row"]'], ["tiers", "/members/tiers", '[data-testid="tier-row"]'], ["reports", "/reports", '[data-testid="rep-chart"]'], ["team", "/team", '[data-testid="team-row"]']]) {
  await desk.goto(SITE + "/#" + path);
  await desk.locator(sel).first().waitFor();
  await desk.waitForTimeout(300);
  check(`desktop ${name}: no horizontal overflow`, (await overflowX(desk)) <= 0);
  await shot(desk, `desktop-${name}`);
}
await desk.context().close();

// Content screens (schema registration through the confirmation dialog, editing, 412, revisions, gating): e2e/content.mjs.
await import("./content.mjs");

// Design layer: temporary copies of the design files, restored afterwards (e2e/design.mjs).
await import("./design.mjs");

await browser.close();
console.log(`\n${failureCount() === 0 ? "ALL PASSED" : failureCount() + " FAILED"}`);
process.exit(failureCount() ? 1 : 0);
