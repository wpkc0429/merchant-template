// Visual parity check. Throwaway stack only.
//   node e2e/parity.mjs capture <outDir>      screenshots of every main view at 390px and 1280px (owner + staff)
//   node e2e/parity.mjs compare <dirA> <dirB>  pixel-compares two captures (byte-equal files are identical)
// Run "capture" once against the OLD site and once against the NEW site while the database is unchanged.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadPlaywright, SITE, OWNER, STAFF, apiLogin, req } from "./lib.mjs";

const mode = process.argv[2];
const { chromium } = loadPlaywright();

if (mode === "capture") {
  const out = resolve(process.argv[3]);
  mkdirSync(out, { recursive: true });
  const ownerToken = await apiLogin(OWNER);
  const orders = (await req("GET", "/admin/shops/1/orders?page=1&page_size=5", { token: ownerToken })).json.orders;
  const detailOrder = orders.find((o) => (o.items || []).some((i) => i.gift_message)) || orders[0];
  const shippedOrder = (await req("GET", "/admin/shops/1/orders?page=1&page_size=50&fulfillment_status=1", { token: ownerToken })).json.orders[0];
  const members = (await req("GET", "/admin/shops/1/members?page=1&page_size=5", { token: ownerToken })).json.members;
  const prods = (await req("GET", "/admin/shops/1/products?page=1&page_size=5", { token: ownerToken })).json.products;
  const cats = (await req("GET", "/admin/shops/1/categories?flat=1", { token: ownerToken })).json.categories;
  const views = [
    ["home", "/"], ["orders", "/orders"], ["order-detail", `/orders/${detailOrder.id}`],
    ...(shippedOrder ? [["order-detail-shipped", `/orders/${shippedOrder.id}`]] : []),
    ["deliveries", "/deliveries"], ["deliveries-tomorrow", "/deliveries?day=tomorrow"],
    ["members", "/members"], ["member-detail", `/members/${members[0].id}`], ["tiers", "/members/tiers"], ["reports", "/reports"],
    ["team", "/team"], ["products", "/products"], ["product-new", "/products/new"], ["product-edit", `/products/${prods[0].id}`],
    ["categories", "/categories"], ["category-order", `/categories/${cats[0].id}/order`], ["shipping", "/shipping-methods"],
    ["not-found", "/nope"],
  ];
  const staffViews = [["home", "/"], ["orders", "/orders"], ["no-permission", "/products"]];
  const browser = await chromium.launch();
  const settle = async (page) => {
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForFunction(() => !document.querySelector(".spinner, .state--loading"), null, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); return document.fonts && document.fonts.ready; });
    await page.waitForTimeout(500);
  };
  for (const [vw, vh, tag] of [[390, 844, "m"], [1280, 860, "d"]]) {
    // login screen (logged out)
    let ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
    let page = await ctx.newPage();
    await page.goto(SITE + "/#/login");
    await page.locator('[data-testid="login-email"]').waitFor();
    await settle(page);
    await page.screenshot({ path: `${out}/${tag}-login.png`, fullPage: true });
    await ctx.close();
    for (const [who, creds, list] of [["owner", OWNER, views], ["staff", STAFF, staffViews]]) {
      ctx = await browser.newContext({ viewport: { width: vw, height: vh } });
      page = await ctx.newPage();
      await page.goto(SITE + "/#/login");
      await page.locator('[data-testid="login-email"]').fill(creds.email);
      await page.locator('[data-testid="login-password"]').fill(creds.password);
      await page.locator('[data-testid="login-submit"]').click();
      await page.locator(".shell").waitFor({ timeout: 15000 }).catch(async (e) => { console.log("LOGIN FAILED", who, await page.evaluate(() => document.body.innerText.slice(0, 200)), page.url()); throw e; });
      for (const [name, path] of list) {
        console.log("  ", tag, who, name);
        await page.goto(`${SITE}/#${path}`);
        if (name !== "not-found") await page.reload();
        await page.locator(".shell").waitFor();
        await settle(page);
        await page.screenshot({ path: `${out}/${tag}-${who}-${name}.png`, fullPage: true });
      }
      if (tag === "m" && who === "owner") {
        await page.goto(`${SITE}/#/`);
        await page.locator('[data-testid="tab-more"]').click();
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${out}/${tag}-${who}-more-sheet.png`, fullPage: false });
      }
      await ctx.close();
    }
  }
  await browser.close();
  console.log(`captured ${readdirSync(out).length} screenshots in ${out}`);
} else if (mode === "compare") {
  const [a, b] = [resolve(process.argv[3]), resolve(process.argv[4])];
  const names = [...new Set([...readdirSync(a), ...readdirSync(b)])].filter((n) => n.endsWith(".png")).sort();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let diffs = 0;
  for (const n of names) {
    let ba, bb;
    try { ba = readFileSync(`${a}/${n}`); bb = readFileSync(`${b}/${n}`); } catch { console.log(`  MISSING ${n}`); diffs++; continue; }
    if (ba.equals(bb)) { console.log(`  same      ${n}`); continue; }
    const r = await page.evaluate(async ([x, y]) => {
      const load = (b64) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = "data:image/png;base64," + b64; });
      const [ia, ib] = await Promise.all([load(x), load(y)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return { size: [ia.width, ia.height, ib.width, ib.height] };
      const get = (i) => { const c = document.createElement("canvas"); c.width = i.width; c.height = i.height; const g = c.getContext("2d"); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
      const da = get(ia), db = get(ib);
      let n = 0, minY = 1e9, maxY = -1;
      for (let p = 0; p < da.length; p += 4) {
        if (Math.abs(da[p] - db[p]) + Math.abs(da[p + 1] - db[p + 1]) + Math.abs(da[p + 2] - db[p + 2]) > 6) { n++; const y = Math.floor(p / 4 / ia.width); if (y < minY) minY = y; if (y > maxY) maxY = y; }
      }
      return { pixels: n, total: da.length / 4, minY, maxY };
    }, [ba.toString("base64"), bb.toString("base64")]);
    if (r.size) console.log(`  DIFF-SIZE ${n} ${JSON.stringify(r.size)}`);
    else if (r.pixels === 0) console.log(`  same(px)  ${n} (bytes differ, pixels identical)`);
    else console.log(`  DIFF      ${n} ${r.pixels} px (${((100 * r.pixels) / r.total).toFixed(3)}%) rows ${r.minY}-${r.maxY}`);
    if (r.size || r.pixels) diffs++;
  }
  await browser.close();
  console.log(diffs ? `\n${diffs} of ${names.length} screenshots differ` : `\nall ${names.length} screenshots are pixel-identical`);
  process.exit(diffs ? 1 : 0);
} else {
  console.error("usage: parity.mjs capture <dir> | compare <a> <b>");
  process.exit(2);
}
