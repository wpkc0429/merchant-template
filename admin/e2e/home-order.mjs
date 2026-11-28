// D24: the home screen puts its stat cards in a FIXED order (today, unshipped, low stock, products) however the requests finish.
// Throwaway stack only (README "Testing"). Run: node e2e/home-order.mjs
// The owner's four card requests are delayed in every permutation of the finishing order (Playwright routes); the order of the cards must not change.
import { loadPlaywright, SITE, OWNER, check, section, failureCount } from "./lib.mjs";
import { hookBrowser } from "./lib/shadow-hook.mjs";

const { chromium } = loadPlaywright();
const browser = hookBrowser(await chromium.launch());
const WANT = ["stat-today", "stat-unshipped", "stat-lowstock", "stat-products"];
// the requests behind the four cards (lib/orders.js deliveriesOn / unshippedPaidCount, lib/catalog.js productCount, lib/dashboard.js lowStockSkus), told apart by URL
function which(url) {
  const u = new URL(url), q = u.searchParams;
  if (u.pathname.endsWith("/orders")) return q.has("fulfillment_status") ? "unshipped" : q.has("delivery_from") ? "today" : null;
  if (u.pathname.endsWith("/products") && q.get("status") === "1") return q.get("page_size") === "1" ? "products" : "lowstock";
  return null;
}
function permutations(a) { return a.length <= 1 ? [a] : a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p])); }

section("home: stat cards keep their order for every finishing order of the requests");
for (const order of permutations(["today", "unshipped", "lowstock", "products"])) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  let n = 0;
  await page.route("**/api/v1/admin/shops/*/**", async (route) => {
    const hit = route.request().method() === "GET" ? which(route.request().url()) : null;
    const rank = hit ? order.indexOf(hit) : -1;
    if (rank > 0) { n++; await new Promise((r) => setTimeout(r, 400 * rank)); }
    await route.continue();
  });
  await page.goto(SITE + "/#/login");
  await page.locator('[data-testid="login-email"]').fill(OWNER.email);
  await page.locator('[data-testid="login-password"]').fill(OWNER.password);
  await page.locator('[data-testid="login-submit"]').click();
  await page.locator(".shell").waitFor();
  await page.locator('[data-testid="stat-products"]').waitFor({ timeout: 15000 });
  await page.waitForFunction((w) => w.every((id) => document.querySelector(`[data-testid="${id}"]`)), WANT, { timeout: 15000 });
  const got = await page.locator('[data-testid="home-stats"] > a').evaluateAll((els) => els.map((e) => e.dataset.testid));
  check(`finishing order ${order.join(" < ")}: cards ${got.join(", ")}`, JSON.stringify(got) === JSON.stringify(WANT), `delayed requests: ${n}`);
  await ctx.close();
}
await browser.close();
process.exit(failureCount() ? 1 : 0);
