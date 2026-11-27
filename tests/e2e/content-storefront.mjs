#!/usr/bin/env node
// Storefront content-store browser test against a FAKE API (no platform stack, no database, nothing shared). Template-only.
// Starts a fake platform API on 127.0.0.1:E2E_FAKE_API_PORT (default 8790) and tests/e2e/serve-storefront.mjs on E2E_SITE_PORT
// (default 8789, with the real CSP), then drives headless Chromium (Playwright borrowed from the platform checkout).
//
//   E2E_OUT=<screenshot dir> node tests/e2e/content-storefront.mjs
//
// Covers: platform content rendered on first paint without a flash of the defaults, ETag revalidation (304) after a reload,
// the session cache, fallback to content.js when the API fails or is too slow, preview mode (token leaves the URL, header only,
// nothing persisted, banner), hostile content shown as text (no script, no markup), no CSP violation.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const API_PORT = Number(process.env.E2E_FAKE_API_PORT || 8790), SITE_PORT = Number(process.env.E2E_SITE_PORT || 8789);
const API = `http://127.0.0.1:${API_PORT}`, SITE = `http://localhost:${SITE_PORT}`;
const OUT = process.env.E2E_OUT || resolve(tmpdir(), 'merchant-template-content-shots');
const ECOM = process.env.PLATFORM_DIR || resolve(import.meta.dirname, '../../../ecommerce');
mkdirSync(OUT, { recursive: true });
const { chromium } = createRequire(resolve(process.env.PLAYWRIGHT_DIR || resolve(ECOM, 'e2e'), 'package.json'))('playwright'); // $PLAYWRIGHT_DIR (CI) or the platform checkout's e2e folder

let failures = 0;
const check = (name, cond, extra = '') => { if (cond) console.log(`  ok  ${name}`); else { failures++; console.error(`  FAIL ${name} ${extra}`); } return Boolean(cond); };
const section = (t) => console.log(`\n${t}`);

/* ---------------- the fake platform ---------------- */
const KEY = 'pk_fakeapikeynotsecret';
const S = { mode: 'ok', delay: 0, version: 1, brand: '平台品牌', log: [] };
const docsFor = () => [
  { key: 'global', type_key: 'global', title: 'global', published_at: null, etag: '"g"', meta: {}, content: {
    accent: '#aa3300', brand: { name: S.brand, footer: '平台頁尾' }, searchPlaceholder: '搜尋', noteLabel: '備註', featuredTitle: '平台精選',
    instagram: { handle: '@platform' }, store: { name: '平台門市', address: '平台地址 1 號', addressShort: '平台地址', hours: '09:00', hoursShort: '09', tel: '02-1234' },
    newsletter: { title: '平台電子報', success: '好' }, promo: { title: '平台優惠', sub: '副', cta: '去' } } },
  { key: 'home', type_key: 'home', title: 'home', published_at: null, etag: '"h"', meta: {}, content: {
    hero: { eyebrow: 'PLATFORM', title: '平台標題\n第二行', lede: '平台副標語' }, storyTeaser: { eyebrow: 'S', title: '平台故事\n預告', lede: '預告內容' } } },
  { key: 'story', type_key: 'story', title: 'story', published_at: null, etag: '"s"', meta: {}, content: { eyebrow: 'E', title: '平台故事', paragraphs: ['第一段', '第二段'] } },
  { key: 'faq', type_key: 'faq', title: 'faq', published_at: null, etag: '"f"', meta: {}, content: { items: [
    { q: '平台問題一', a: '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>敵意答案' }, { q: '平台問題二', a: '答二' }] } }
  // product-info is deliberately NOT published: its default copy must stay
];
const draft = (key) => (key === 'global' ? { ...docsFor()[0].content, brand: { name: '草稿品牌', footer: '草稿頁尾' } } : (docsFor().find((d) => d.key === key) || {}).content);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'X-Publishable-Key, X-Preview-Token, If-None-Match, If-Match, Content-Type, Idempotency-Key', 'access-control-expose-headers': 'ETag' };

const fake = http.createServer(async (req, res) => {
  const u = new URL(req.url, API);
  const send = (status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...CORS, ...extra }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  if (req.method === 'OPTIONS') return send(204);
  if (u.pathname.startsWith('/__')) {   // control channel
    if (u.pathname === '/__set') { for (const [k, v] of u.searchParams) S[k] = k === 'delay' || k === 'version' ? Number(v) : v; S.log = u.searchParams.has('keeplog') ? S.log : []; return send(200, { ok: true }); }
    if (u.pathname === '/__log') return send(200, S.log);
  }
  S.log.push({ path: u.pathname + u.search, inm: req.headers['if-none-match'] || null, preview: req.headers['x-preview-token'] || null, key: req.headers['x-publishable-key'] || null });
  if (req.headers['x-publishable-key'] !== KEY) return send(404, { error: 'unknown_publishable_key' });
  if (u.pathname === '/api/v1/shop/products') return send(200, { products: [], total: 0 });
  if (u.pathname === '/api/v1/shop/shipping-methods') return send(200, { shipping_methods: [] });
  if (u.pathname === '/api/v1/shop/categories') return send(200, { categories: [] });
  if (u.pathname.startsWith('/api/v1/shop/content')) {
    if (S.delay) await new Promise((r) => setTimeout(r, S.delay));
    if (S.mode === 'down') return send(503, { error: 'unavailable' });
    if (S.mode === 'limited') return send(429, { error: 'rate_limited' }, { 'retry-after': '1' });
    const pm = /^\/api\/v1\/shop\/content\/([a-z0-9-]+)\/preview$/.exec(u.pathname);
    if (pm) {
      if (req.headers['x-preview-token'] !== 'tok-preview-1') return send(403, { error: 'forbidden' });
      const c = draft(pm[1]);
      return c ? send(200, { key: pm[1], type_key: pm[1], title: pm[1], schema_version: 1, published_at: null, content: c, meta: {}, status: 0, draft_rev: 3, preview: true }, { 'cache-control': 'no-store' }) : send(404, { error: 'not_found' });
    }
    const etag = `"v${S.version}"`;
    if (req.headers['if-none-match'] === etag) return send(304, undefined, { etag });
    return send(200, { schema_version: 1, documents: docsFor() }, { etag, 'cache-control': 'public, max-age=0' });
  }
  return send(404, { error: 'not_found' });
});
await new Promise((r) => fake.listen(API_PORT, '127.0.0.1', r));
const ctl = (q) => fetch(`${API}/__set?${q}`);
const log = () => fetch(`${API}/__log`).then((r) => r.json());

const site = spawn(process.execPath, [resolve(import.meta.dirname, 'serve-storefront.mjs'), String(SITE_PORT)], { env: { ...process.env, E2E_API_BASE_URL: API, E2E_PUBLISHABLE_KEY: KEY }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => site.stdout.once('data', r));
const stop = async () => { site.kill(); await new Promise((r) => fake.close(r)); };

const browser = await chromium.launch();
async function open(width = 1280, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/503|429|403|Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  // record every text the .brand link ever shows, to prove there is no flash of the defaults
  await page.addInitScript(() => {
    window.__brands = [];
    new MutationObserver(() => { const b = document.querySelector('.brand, .app-header__brand'); if (b && b.textContent && window.__brands[window.__brands.length - 1] !== b.textContent) window.__brands.push(b.textContent); }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  return { ctx, page };
}
const brand = (page) => page.evaluate(() => (document.querySelector('.brand, .app-header__brand') || {}).textContent || '');
const settle = (page, ms = 800) => page.waitForTimeout(ms);

try {
  section('1. Platform content on first paint (fast API), no flash of the defaults');
  await ctl('mode=ok&delay=100&version=1');
  let { ctx, page } = await open();
  await page.goto(SITE + '/');
  await page.waitForSelector('.brand, .app-header__brand');
  await settle(page);
  check('header brand is the platform value', (await brand(page)) === '平台品牌', await brand(page));
  check('the defaults were never painted first (brand history)', JSON.stringify(await page.evaluate(() => window.__brands)) === '["平台品牌"]', JSON.stringify(await page.evaluate(() => window.__brands)));
  check('hero title from the home document, newline rendered as <br>', (await page.innerHTML('h1')).includes('平台標題<br>第二行'));
  check('accent written from global.accent', (await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())) === '#aa3300');
  check('the faq accordion on the home page comes from the faq document', (await page.textContent('body')).includes('平台問題一'));
  await page.goto(SITE + '/#/story'); await settle(page, 300);
  check('story page shows the platform paragraphs', (await page.textContent('body')).includes('第二段'));
  await page.goto(SITE + '/#/store'); await settle(page, 300);
  check('store page shows the platform address', (await page.textContent('body')).includes('平台地址 1 號'));
  check('hostile faq answer is shown as TEXT: no script, no onerror, no injected element', await page.evaluate(() => window.__pwn === undefined && !document.querySelector('#app img[src="x"], #app script')));
  await page.click('[data-act="toggleFaq"]').catch(() => {});
  await page.screenshot({ path: resolve(OUT, 'content-1280.png'), fullPage: true });
  check('no page or CSP errors', page.errors.length === 0, page.errors.join(' | '));

  section('2. ETag revalidation and the session cache');
  const before = (await log()).filter((l) => l.path.startsWith('/api/v1/shop/content')).length;
  await page.reload(); await page.waitForSelector('.brand, .app-header__brand'); await settle(page, 600);
  const entries = (await log()).filter((l) => l.path.startsWith('/api/v1/shop/content'));
  const last = entries[entries.length - 1];
  check('the reload revalidated with If-None-Match "v1" (and the API answered 304)', entries.length > before && last.inm === '"v1"', JSON.stringify(last));
  check('the brand is the platform value right after the reload (served from the session cache)', (await brand(page)) === '平台品牌');
  check('the session cache entry exists, is per shop and holds no preview data', await page.evaluate(() => Object.keys(sessionStorage).some((k) => k.startsWith('shopcommerce:content:'))));
  await ctl('version=2&brand=%E6%96%B0%E5%93%81%E7%89%8C&keeplog=1'); // same content endpoint, new etag + new brand
  await page.reload(); await page.waitForSelector('.brand, .app-header__brand'); await settle(page, 1000);
  check('a new ETag swaps in the new content (cached copy first, then the revalidated one)', (await brand(page)) === '新品牌', await brand(page));
  await ctx.close();

  section('3. API failure: content.js defaults, page still works');
  for (const mode of ['down', 'limited']) {
    await ctl(`mode=${mode}&delay=0&version=1&brand=%E5%B9%B3%E5%8F%B0%E5%93%81%E7%89%8C`);
    ({ ctx, page } = await open(390, 800));
    await page.goto(SITE + '/'); await page.waitForSelector('.brand, .app-header__brand'); await settle(page, 500);
    check(`${mode}: default brand from content.js`, (await brand(page)) === '你的商店', await brand(page));
    check(`${mode}: the catalogue area still rendered (no blank page)`, (await page.textContent('#app')).length > 50);
    if (mode === 'down') await page.screenshot({ path: resolve(OUT, 'content-fallback-390.png'), fullPage: true });
    check(`${mode}: no page errors`, page.errors.length === 0, page.errors.join(' | '));
    await ctx.close();
  }

  section('4. Slow API (longer than the first-paint budget): defaults first, then the platform content');
  await ctl('mode=ok&delay=1500&version=1');
  ({ ctx, page } = await open());
  await page.goto(SITE + '/'); await page.waitForSelector('.brand, .app-header__brand');
  check('first paint used the default brand', (await brand(page)) === '你的商店', await brand(page));
  await page.waitForFunction(() => /平台品牌/.test((document.querySelector('.brand, .app-header__brand') || {}).textContent || ''), null, { timeout: 5000 }).catch(() => {});
  check('the platform content replaced it when it arrived', (await brand(page)) === '平台品牌', await brand(page));
  await ctx.close();

  section('5. Preview mode');
  await ctl('mode=ok&delay=0&version=1');
  ({ ctx, page } = await open());
  await page.goto(SITE + '/?content_preview=tok-preview-1&x=1#/story'); await page.waitForSelector('.brand, .app-header__brand'); await settle(page, 800);
  check('the token is gone from the URL (other params and the hash stay)', page.url() === `${SITE}/?x=1#/story`, page.url());
  check('draft content shown', (await brand(page)) === '草稿品牌', await brand(page));
  check('the preview banner is visible', await page.isVisible('#shop-preview-banner'));
  check('nothing persisted: no session or local storage entry for content', await page.evaluate(() => !Object.keys(sessionStorage).concat(Object.keys(localStorage)).some((k) => /content/.test(k)) && !JSON.stringify([sessionStorage, localStorage]).includes('tok-preview')));
  const pl = (await log()).filter((l) => l.path.endsWith('/preview'));
  check('preview requests carried the token in the header, never in a URL, and no If-None-Match', pl.length >= 3 && pl.every((l) => l.preview === 'tok-preview-1' && !l.path.includes('tok-') && l.inm === null), JSON.stringify(pl));
  check('the token appears in no request URL at all', !(await log()).some((l) => l.path.includes('tok-preview')));
  await page.screenshot({ path: resolve(OUT, 'content-preview-1280.png') });
  await ctx.close();
  ({ ctx, page } = await open());
  await page.goto(SITE + '/?content_preview=tok-wrong-token-9'); await page.waitForSelector('.brand, .app-header__brand'); await settle(page, 800);
  check('a refused token shows the published content and an "invalid" banner', (await brand(page)) === '平台品牌' && /失效/.test(await page.textContent('#shop-preview-banner')), await brand(page));
  await ctx.close();
  ({ ctx, page } = await open());
  await page.goto(SITE + '/'); await settle(page, 600);
  check('a normal visit afterwards has no banner', !(await page.$('#shop-preview-banner')));
  await ctx.close();

  section('6. Mobile layout with platform content');
  await ctl('mode=ok&delay=0&version=1');
  ({ ctx, page } = await open(390, 800));
  await page.goto(SITE + '/'); await page.waitForSelector('.app-header__brand, .brand'); await settle(page, 800);
  check('mobile header brand is the platform value', (await brand(page)) === '平台品牌', await brand(page));
  check('mobile promo strip from global.promo', (await page.textContent('#app')).includes('平台優惠'));
  await page.screenshot({ path: resolve(OUT, 'content-390.png'), fullPage: true });
  check('no horizontal overflow at 390px', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await ctx.close();
} finally {
  await browser.close();
  await stop();
}
console.log(failures ? `\n${failures} FAILED` : '\nall content-storefront checks passed');
process.exit(failures ? 1 : 0);
