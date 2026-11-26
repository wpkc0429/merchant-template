#!/usr/bin/env node
// Storefront content-store test against the REAL throwaway stack (API :8180, storefront served by tests/e2e/serve-storefront.mjs on :8788,
// platform content already PUBLISHED for the demo shop: documents global, home, story, faq, product-info). Template-only.
//
//   E2E_OUT=<screenshot dir> node tests/e2e/content-stack.mjs
//
// Expected values are read from the platform's own public API at the start, so the test follows whatever content is published.
// Covers: platform content on first paint without a flash of the defaults, fallback to content.js when /shop/content is unavailable
// (route abort / 503 / 429, the API is not touched), If-None-Match -> real 304 and the real ETag exposure through CORS, preview with a
// real token (draft + banner, token out of the URL, never in a request URL, nothing in storage), screenshots at 390 and 1280.
// Writes ONLY a draft edit of the `home` document (and puts the previous draft back); it never publishes, registers or changes the schema.
// Credentials: the demo shop owner's documented demo account (override with E2E_OWNER_PASSWORD).
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SITE = process.env.E2E_STOREFRONT_URL || 'http://localhost:8788';
const API = process.env.E2E_API_BASE_URL || 'http://127.0.0.1:8180';
const KEY = process.env.E2E_PUBLISHABLE_KEY || 'pk_demoseedstorefrontkeynotsecret';
const OUT = process.env.E2E_OUT || resolve(tmpdir(), 'merchant-template-content-stack');
const ECOM = process.env.PLATFORM_DIR || resolve(import.meta.dirname, '../../../ecommerce');
mkdirSync(OUT, { recursive: true });
const { chromium } = createRequire(resolve(ECOM, 'e2e/package.json'))('playwright');

let failures = 0;
const check = (name, cond, extra = '') => { if (cond) console.log(`  ok  ${name}`); else { failures++; console.error(`  FAIL ${name} ${extra}`); } return Boolean(cond); };
const section = (t) => console.log(`\n${t}`);

/* ---- what the platform publishes (the expectations) ---- */
const pub = await (await fetch(`${API}/api/v1/shop/content?include=content`, { headers: { 'X-Publishable-Key': KEY } })).json();
const doc = (k) => (pub.documents.find((d) => d.key === k) || {}).content;
const G = doc('global'), H = doc('home'), ST = doc('story'), F = doc('faq');
if (!G || !H || !ST || !F) { console.error('the stack has no published global/home/story/faq documents'); process.exit(2); }
const firstLine = (s) => s.split('\n')[0];
console.log(`published: brand=${G.brand.name} hero=${firstLine(H.hero.title)} faq=${F.items.length} items`);

/* ---- admin API (owner), for the preview token and a DRAFT edit only ---- */
const adm = async (m, p, tok, body, headers = {}) => {
  const r = await fetch(`${API}/api/v1/admin${p}`, { method: m, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); return { status: r.status, etag: r.headers.get('etag'), json: t ? JSON.parse(t) : null };
};
const login = await adm('POST', '/auth/login', null, { email: 'demo-owner@example.com', password: process.env.E2E_OWNER_PASSWORD || 'demo-owner-change-me' });
const tok = login.json.access_token;
let before = await adm('GET', '/shops/1/content/documents/home', tok);
if (/^草稿標題 /.test(before.json.draft.hero.title) && before.json.published) {   // a draft left by an aborted run: put the published copy back first
  const fix = await adm('PUT', '/shops/1/content/documents/home', tok, { title: before.json.title, content: before.json.published }, { 'If-Match': before.etag });
  if (fix.status !== 200) { console.error('could not clean the leftover draft', fix.status); process.exit(2); }
  before = await adm('GET', '/shops/1/content/documents/home', tok);
}
const DRAFT_TITLE = `草稿標題 ${Date.now()}`;
const draftBody = (hero) => ({ title: before.json.title, content: { ...before.json.draft, hero: { ...before.json.draft.hero, ...hero } } });
let saved = await adm('PUT', '/shops/1/content/documents/home', tok, draftBody({ title: DRAFT_TITLE }), { 'If-Match': before.etag });
if (saved.status !== 200) { console.error('could not save the draft', saved.status, JSON.stringify(saved.json).slice(0, 200)); process.exit(2); }
const pt = (await adm('POST', '/shops/1/content/documents/home/preview-token', tok, { scope: 'shop' })).json.preview_token;
if (!pt) { console.error('no preview token'); process.exit(2); }

const browser = await chromium.launch();
async function open(width = 1280, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.errors = []; page.reqs = []; page.resps = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) page.errors.push(m.text()); });
  page.on('request', (r) => { if (/\/shop\/content/.test(r.url())) page.reqs.push({ url: r.url(), headers: r.headers() }); });
  page.on('response', (r) => { if (/\/shop\/content/.test(r.url())) page.resps.push({ url: r.url(), status: r.status() }); });
  await page.addInitScript(() => {
    window.__brands = [];
    new MutationObserver(() => { const b = document.querySelector('a.brand, .app-header__brand'); if (b && b.textContent && window.__brands[window.__brands.length - 1] !== b.textContent) window.__brands.push(b.textContent); }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  return { ctx, page };
}
const BRAND = 'a.brand, .app-header__brand';
const brand = (p) => p.evaluate((s) => (document.querySelector(s) || {}).textContent || '', BRAND);
const text = (p) => p.evaluate(() => document.body.innerText);
const overflow = (p) => p.evaluate(() => { const w = innerWidth; let worst = document.documentElement.scrollWidth - w; for (const el of document.querySelectorAll('body *')) { if (el.closest('svg')) continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(el).position === 'fixed') continue; worst = Math.max(worst, Math.ceil(r.right - w), Math.ceil(-r.left)); } return worst; });
const shot = async (p, name) => { await p.waitForTimeout(250); await p.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true }); };

try {
  section('1. Platform content on the real stack, first paint without a flash of the defaults');
  let { ctx, page } = await open();
  await page.goto(SITE + '/'); await page.waitForSelector(BRAND); await page.waitForTimeout(1200);
  check('header brand is the published brand', (await brand(page)) === G.brand.name, await brand(page));
  check('the default brand was never painted (brand history)', JSON.stringify(await page.evaluate(() => window.__brands)) === JSON.stringify([G.brand.name]), JSON.stringify(await page.evaluate(() => window.__brands)));
  check('hero title is the published one', (await text(page)).includes(firstLine(H.hero.title)), firstLine(H.hero.title));
  check('featured title is the published one', (await text(page)).includes(G.featuredTitle));
  check('the FAQ comes from the faq document', F.items.every((i) => true) && (await text(page)).includes(F.items[0].q));
  check('footer brand is the published footer', (await text(page)).includes(G.brand.footer));
  check('exactly one published-content request on first load, with the publishable key and without If-None-Match', page.reqs.length === 1 && !page.reqs[0].headers['if-none-match'] && page.reqs[0].headers['x-publishable-key'] === KEY, JSON.stringify(page.reqs.map((r) => r.url)));
  check('no page or CSP errors', page.errors.length === 0, page.errors.join(' | '));
  await shot(page, 'stack-home-1280');
  await page.goto(SITE + '/#/story'); await page.waitForTimeout(400);
  check('story page: platform title and paragraphs', (await text(page)).includes(ST.paragraphs[0]) && (await text(page)).includes(firstLine(ST.title)));
  await shot(page, 'stack-story-1280');
  await page.goto(SITE + '/#/store'); await page.waitForTimeout(400);
  check('store page: platform address and hours', (await text(page)).includes(G.store.address) && (await text(page)).includes(G.store.hours));
  await shot(page, 'stack-store-1280');

  section('2. Repeat load: If-None-Match -> a real 304, and the ETag is readable cross-origin');
  page.reqs.length = 0; page.resps.length = 0;
  await page.goto(SITE + '/'); await page.reload(); await page.waitForSelector(BRAND); await page.waitForTimeout(1200);
  const inm = page.reqs.filter((r) => r.headers['if-none-match']);
  check('the reload sent If-None-Match with the ETag of the first answer', inm.length >= 1 && /^"[0-9a-f]+"$/.test(inm[0].headers['if-none-match']), JSON.stringify(page.reqs.map((r) => r.headers['if-none-match'])));
  check('the platform answered 304', page.resps.some((r) => r.status === 304), JSON.stringify(page.resps));
  check('the brand is already the published one right after the reload (session cache)', (await brand(page)) === G.brand.name);
  const exposed = await page.evaluate(async ([api, key]) => { const r = await fetch(api + '/api/v1/shop/content?include=content', { headers: { 'X-Publishable-Key': key } }); return { status: r.status, etag: r.headers.get('etag') }; }, [API, KEY]);
  check('CORS exposes ETag to the storefront origin', exposed.status === 200 && /^"[0-9a-f]+"$/.test(exposed.etag || ''), JSON.stringify(exposed));
  check('no page errors', page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();

  section('3. /shop/content unavailable: the content.js defaults, the page keeps working');
  for (const mode of ['abort', '503', '429']) {
    ({ ctx, page } = await open(390, 800));
    await page.route('**/api/v1/shop/content**', (route) => (mode === 'abort' ? route.abort() : route.fulfill({ status: Number(mode), contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"x"}' })));
    await page.goto(SITE + '/'); await page.waitForSelector(BRAND); await page.waitForTimeout(900);
    check(`${mode}: default brand from content.js`, (await brand(page)) === '你的商店', await brand(page));
    check(`${mode}: the catalogue still renders (products listed)`, (await page.locator('a[href^="#/product/"]').count()) > 0);
    check(`${mode}: no page errors`, page.errors.length === 0, page.errors.join(' | '));
    if (mode === 'abort') await shot(page, 'stack-fallback-390');
    await ctx.close();
  }

  section('4. Preview with a real token');
  ({ ctx, page } = await open());
  await page.goto(`${SITE}/?content_preview=${pt}&x=1#/`); await page.waitForSelector(BRAND); await page.waitForTimeout(1500);
  check('the token is gone from the URL (other params and the hash stay)', page.url() === `${SITE}/?x=1#/`, page.url());
  check('the DRAFT hero title is shown', (await text(page)).includes(DRAFT_TITLE), (await text(page)).slice(0, 80));
  check('the preview banner is visible', await page.isVisible('#shop-preview-banner'));
  check('the token went in the X-Preview-Token header only, never in a URL', page.reqs.filter((r) => /\/preview$/.test(r.url)).length >= 1 && page.reqs.filter((r) => /\/preview$/.test(r.url)).every((r) => r.headers['x-preview-token'] === pt) && !page.reqs.some((r) => r.url.includes(pt)), JSON.stringify(page.reqs.map((r) => r.url)));
  check('no If-None-Match on preview requests', page.reqs.filter((r) => /\/preview$/.test(r.url)).every((r) => !r.headers['if-none-match']));
  check('nothing about the token or the draft in sessionStorage or localStorage', await page.evaluate(([t, d]) => { const all = JSON.stringify([{ ...sessionStorage }, { ...localStorage }]); return !all.includes(t) && !all.includes(d); }, [pt, DRAFT_TITLE]));
  check('no page errors', page.errors.length === 0, page.errors.join(' | '));
  await shot(page, 'stack-preview-1280');
  await ctx.close();
  ({ ctx, page } = await open());
  await page.goto(SITE + '/'); await page.waitForSelector(BRAND); await page.waitForTimeout(1000);
  check('a normal visit still shows the PUBLISHED hero (the draft never leaks) and no banner', !(await text(page)).includes(DRAFT_TITLE) && (await text(page)).includes(firstLine(H.hero.title)) && !(await page.$('#shop-preview-banner')));
  await ctx.close();
  ({ ctx, page } = await open());
  await page.goto(`${SITE}/?content_preview=not-a-valid-token-xyz`); await page.waitForSelector(BRAND); await page.waitForTimeout(1200);
  check('an invalid token: published content and an "invalid" banner', (await brand(page)) === G.brand.name && /失效/.test(await page.textContent('#shop-preview-banner')), await brand(page));
  await ctx.close();

  section('5. Phone layout (390px) with platform content');
  ({ ctx, page } = await open(390, 800));
  await page.goto(SITE + '/'); await page.waitForSelector(BRAND); await page.waitForTimeout(1200);
  check('mobile header brand is the published one', (await brand(page)) === G.brand.name, await brand(page));
  check('mobile promo is the published one', (await text(page)).includes(G.promo.title));
  check('no horizontal overflow (home)', (await overflow(page)) <= 0, String(await overflow(page)));
  await shot(page, 'stack-home-390');
  await page.goto(SITE + '/#/story'); await page.waitForTimeout(500);
  check('mobile story from the platform', (await text(page)).includes(ST.paragraphs[0]));
  check('no horizontal overflow (story)', (await overflow(page)) <= 0, String(await overflow(page)));
  await shot(page, 'stack-story-390');
  await page.goto(SITE + '/#/store'); await page.waitForTimeout(500);
  check('mobile store info and FAQ from the platform', (await text(page)).includes(G.store.address) && (await text(page)).includes(F.items[0].q));
  check('no horizontal overflow (store)', (await overflow(page)) <= 0, String(await overflow(page)));
  await shot(page, 'stack-store-390');
  check('no page errors', page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();
} finally {
  await browser.close();
  // put the previous DRAFT back (the published content was never touched)
  const now = await adm('GET', '/shops/1/content/documents/home', tok);
  const back = await adm('PUT', '/shops/1/content/documents/home', tok, { title: before.json.title, content: before.json.draft }, { 'If-Match': now.etag });
  check('the previous home draft is restored', back.status === 200 && JSON.stringify(back.json.draft.hero) === JSON.stringify(before.json.draft.hero), String(back.status));
  const after = await (await fetch(`${API}/api/v1/shop/content?include=content`, { headers: { 'X-Publishable-Key': KEY } })).json();
  check('published content is unchanged', JSON.stringify(after.documents.map((d) => [d.key, d.content])) === JSON.stringify(pub.documents.map((d) => [d.key, d.content])));
}
console.log(failures ? `\n${failures} FAILED` : '\nall content-stack checks passed');
process.exit(failures ? 1 : 0);
