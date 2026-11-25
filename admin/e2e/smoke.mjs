// Quick admin smoke test (a minute, not the 40+ minute full suite). THROWAWAY stack only (see README "測試").
//   E2E_OUT=<dir> node e2e/smoke.mjs        (needs: node e2e/setup.mjs done, node scripts/serve.mjs --proxy <API>,
//                                            gitignored config.local.js with apiBase = location.origin, sample catalogue imported)
// Checks: login (owner), home, products list (sample catalogue, S/M/L editor), orders list, 390px overflow, no console errors;
// staff sees no products. Screenshots at 390px and 1280px go to E2E_OUT.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadPlaywright, SITE, OUT, OWNER, STAFF, check, section, failureCount } from "./lib.mjs";

mkdirSync(OUT, { recursive: true });
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const T = (page, id) => page.locator(`[data-testid="${id}"]`);
const overflow = (page) => page.evaluate(() => { const w = window.innerWidth; let worst = document.documentElement.scrollWidth - w; for (const el of document.querySelectorAll("body *")) { if (el.closest("svg") || el.closest("dialog:not([open])")) continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(el).position === "fixed") continue; worst = Math.max(worst, Math.ceil(r.right - w), Math.ceil(-r.left)); } return worst; });
async function session(width, height, who = OWNER) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/status of 401/.test(m.text())) page.errors.push(m.text()); /* the 401 is the expected unauthenticated session probe before login */ });
  await page.goto(SITE + "/#/login");
  await T(page, "login-email").fill(who.email);
  await T(page, "login-password").fill(who.password);
  await T(page, "login-submit").click();
  await page.locator(".shell").waitFor();
  return page;
}
const shot = async (page, name) => { await page.waitForTimeout(300); await page.screenshot({ path: resolve(OUT, `admin-${name}.png`), fullPage: true }); };

for (const [label, w, h] of [["desktop", 1280, 860], ["phone", 390, 844]]) {
  section(`${label} ${w}px: login, home, products, product editor, orders`);
  const page = await session(w, h);
  check("login lands on the home screen, Traditional Chinese title", (await page.title()).includes("後台"), await page.title());
  check("no template leftovers in the page chrome (no flower wording)", !/花/.test(await page.locator("body").innerText()));
  await shot(page, `${label}-1-home`);
  await page.goto(SITE + "/#/products");
  await T(page, "product-row").first().waitFor();
  const rows = await T(page, "product-row").allInnerTexts();
  check("products list shows the 8 sample-catalogue products", ["MINIMAL TOTE", "DAILY MUG", "PURE CANDLE", "LIGHT NOTEBOOK", "BASIC TEE", "SLOW BOTTLE", "QUIET POUCH", "PLAIN CAP"].every((n) => rows.some((r) => r.includes(n))), String(rows.length));
  await shot(page, `${label}-2-products`);
  await T(page, "product-row").first().click();
  await T(page, "f-title").waitFor();
  check("product editor opens with S / M / L size rows", (await page.locator("body").innerText()).includes("S · 小") && (await page.locator("body").innerText()).includes("L · 加大"));
  await shot(page, `${label}-3-product-edit`);
  await page.goto(SITE + "/#/orders");
  await page.waitForTimeout(800);
  await shot(page, `${label}-4-orders`);
  const o = await overflow(page);
  check(`orders list: no horizontal overflow at ${w}px`, o <= 0, String(o));
  await page.goto(SITE + "/#/content");
  await page.locator('[data-testid="content-list"]').waitFor();
  await shot(page, `${label}-5-content`);
  const oc = await overflow(page);
  check(`content list: no horizontal overflow at ${w}px`, oc <= 0, String(oc));
  check(`no console errors (${label})`, page.errors.length === 0, page.errors.join(" | "));
  await page.context().close();
}

section("staff: no products entry");
{
  const page = await session(1280, 860, STAFF);
  check("staff has no products nav", (await T(page, "nav-products").count()) === 0);
  check("staff has no content nav (content.view is not granted)", (await T(page, "nav-content").count()) === 0);
  await page.context().close();
}

await browser.close();
console.log(failureCount() ? `\n${failureCount()} check(s) FAILED` : "\nadmin smoke: all checks passed");
process.exit(failureCount() ? 1 : 0);
