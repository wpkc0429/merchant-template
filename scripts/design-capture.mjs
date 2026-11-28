#!/usr/bin/env node
/* design-capture.mjs: the screenshot tool of the AI edit service (design-history task T6). LOCKED core file.

   Captures the FIXED view set (set_version 1) of a branch preview from a SANDBOX stack and uploads the PNGs, through the
   service-credential API, into the platform's private design-history slots. It is the generalisation of
   admin/e2e/parity.mjs `capture` (same settle, same views, same pixel function); parity.mjs itself is untouched.

     node scripts/design-capture.mjs capture --site admin|storefront --phase before|after --out <dir>
            --sandbox-env <file> [--storefront-origin <origin>] [--shop 1] [--diff-against <before dir>]
     node scripts/design-capture.mjs upload  --dir <dir> --api <platform api origin> --shop <id> --request <uuid>
     node scripts/design-capture.mjs views   [--site admin|storefront]      (prints the view set, no browser)
     node scripts/design-capture.mjs selftest                               (unit tests of the pure parts: tests/design-capture.test.mjs)

   <file> is the output of `make sandbox-env` in the platform repo (JSON: origins, synthetic demo logins, publishable key).
   Safety rules (docs/design-service-contract.md section 6, platform docs/deploy/sandbox-stack.md):
     * `capture`: every origin the script talks to (admin, API, storefront) must be in the sandbox allowlist (design_sandbox_origins /
       allowed_api_origins of the file, plus DESIGN_CAPTURE_ALLOWED_ORIGINS). No allowlist = refuse. Not on it = exit 2, nothing started.
     * The browser itself is fenced: a request to any origin outside the allowlist (and the sandbox media origin) is aborted.
     * Logins must be synthetic (@example.com). The owner's real credentials are never read; there is no flag to pass them.
     * The service key (dsk_...) comes ONLY from the environment (DESIGN_SERVICE_KEY), never from argv, and is never printed;
       every message goes through a scrubber that removes known secret values.
     * Playwright is borrowed (not a dependency): DESIGN_CAPTURE_PLAYWRIGHT_DIR, else `playwright` from here, else ../ecommerce/e2e.
   `upload` talks to the platform design-service API named by --api (https, or loopback http): that origin is NOT checked against the sandbox
   allowlist (the platform may be the real one; the platform refuses live-data captures itself). Redirects are refused and every request has a timeout.
   The browser fence covers requests and WebSockets seen by Playwright; it is not a network-level egress control.
   Exit codes: 0 ok | 1 failure | 2 refused / usage | 3 upload must be abandoned (caps, quota, live-data refusal, no storage) |
               4 upload gave up after retries (network / 5xx / 429) | 5 head moved: recapture "after" and upload again.
   Dependencies: Node 18+. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TOOL = 'design-capture';
export const TOOL_VERSION = '1';
export const SET_VERSION = 1;
export const VIEWPORTS = { 390: 844, 1280: 860 };
export const MAX_HEIGHT = 10000;
export const SLOT_CAP = 80;
export const ATTEMPT_CAP = 240;
export const MAX_PNG_BYTES = 20 * 1024 * 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const FIXED_TIME = '2026-06-15T04:00:00.000Z';
const MAIN_STACK_PORTS = new Set(['8080', '3001', '4010', '8081']); // the owner's main stack and mock servers: never a capture target

export class Refusal extends Error { constructor(m, code = 2) { super(m); this.exitCode = code; } }

// ---------------------------------------------------------------- origins
/** "https://Host:443/" -> canonical "scheme://host[:port]"; anything with a path, query, fragment or userinfo is refused. */
export function parseOrigin(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Refusal(`not a URL: ${String(raw).slice(0, 60)}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Refusal(`origin must be http(s): ${u.protocol}`);
  if (u.username || u.password) throw new Refusal('an origin must not carry credentials');
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) throw new Refusal('an origin must be scheme://host[:port] with no path, query or fragment');
  return u.origin;
}
const isLoopback = (o) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(o).hostname);

export function buildAllowlist({ env = {}, process_env = {} } = {}) {
  const list = new Set();
  const add = (v) => { if (v) list.add(parseOrigin(v)); };
  (env.design_sandbox_origins || []).forEach(add);
  (env.allowed_api_origins || []).forEach(add);
  String(process_env.DESIGN_CAPTURE_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean).forEach(add);
  return list;
}

/** The one gate: refuse unless the origin is exactly on the sandbox allowlist. */
export function assertSandboxOrigin(label, raw, allowlist) {
  if (!allowlist || allowlist.size === 0) throw new Refusal('no sandbox allowlist: pass --sandbox-env <make sandbox-env output> (or DESIGN_CAPTURE_ALLOWED_ORIGINS)');
  const o = parseOrigin(raw);
  if (MAIN_STACK_PORTS.has(new URL(o).port) && isLoopback(o)) throw new Refusal(`${label} ${o} is a main-stack port: refused`);
  if (!allowlist.has(o)) throw new Refusal(`${label} ${o} is not a sandbox origin: refused (allowed: ${[...allowlist].join(', ')})`);
  if (o.startsWith('http:') && !isLoopback(o)) throw new Refusal(`${label} ${o}: cleartext http is only allowed on loopback`);
  return o;
}

// ---------------------------------------------------------------- secrets
export function makeScrubber(secrets) {
  const values = () => [...secrets].filter((s) => typeof s === 'string' && s.length >= 2).sort((a, b) => b.length - a.length);
  const scrub = (text) => {
    let t = String(text);
    for (const s of values()) t = t.split(s).join('***');
    t = t.replace(/dsk_[A-Za-z0-9_-]{8,}/g, 'dsk_***').replace(/X-Amz-Signature=[0-9a-f]+/gi, 'X-Amz-Signature=***').replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, 'Bearer ***');
    // untrusted text (page text, server codes) must not carry control characters or unbounded length into the terminal
    t = t.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '?');
    return t.length > 4000 ? t.slice(0, 4000) + '...' : t;
  };
  scrub.add = (s) => {
    if (typeof s !== 'string' || !s) return;
    secrets.add(s); secrets.add(encodeURIComponent(s)); secrets.add(JSON.stringify(s).slice(1, -1));
  };
  return scrub;
}
export function assertSyntheticLogin(label, login) {
  if (!login || typeof login.email !== 'string' || typeof login.password !== 'string') throw new Refusal(`${label} login missing in the sandbox env file`);
  if (!/^[^@\s]+@example\.com$/i.test(login.email)) throw new Refusal(`${label} login must be a synthetic @example.com account: refused`);
  return login;
}

// ---------------------------------------------------------------- the fixed view set (set_version 1)
export function viewSet(site) {
  if (site === 'admin') {
    return [
      ['owner', ['login', 'home', 'orders', 'order-detail', 'products', 'product-edit', 'members', 'reports']],
      ['staff', ['home', 'orders']],
    ].flatMap(([role, keys]) => keys.map((view_key) => ({ role, view_key })));
  }
  if (site === 'storefront') return ['home', 'shop', 'product', 'cart', 'story', 'checkout'].map((view_key) => ({ role: 'anon', view_key }));
  throw new Refusal(`unknown site "${site}" (admin | storefront)`);
}
export const shotName = (phase, role, viewport, viewKey) => `${phase}-${role}-${viewport}-${viewKey}.png`;
const KEY_RE = /^[a-z0-9-]{1,40}$/;
export function parseShotName(name) {
  const m = /^(before|after)-(owner|staff|anon)-(390|1280)-([a-z0-9-]{1,40})\.png$/.exec(name);
  return m ? { phase: m[1], role: m[2], viewport: Number(m[3]), view_key: m[4] } : null;
}

export function captureManifestHeader({ site, origin, capturedAt = new Date() }) {
  const m = { tool: TOOL, tool_version: TOOL_VERSION, dataset: 'sandbox-v1', api_origin_class: 'sandbox', captured_at: capturedAt.toISOString(), set_version: SET_VERSION, origin };
  const b64 = Buffer.from(JSON.stringify(m)).toString('base64');
  if (b64.length > 2048) throw new Error('capture manifest over 2 KiB');
  return b64;
}

// ---------------------------------------------------------------- pixel difference (same rule as parity.mjs compare)
/** per-channel absolute differences summed > 6 count as a differing pixel; result is parts per million of all pixels. */
export function pixelDiffPpm(a, b) {
  if (a.length !== b.length || a.length % 4) return null;
  let n = 0;
  for (let p = 0; p < a.length; p += 4) if (Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]) > 6) n++;
  return Math.round((n / (a.length / 4)) * 1e6);
}

// ---------------------------------------------------------------- upload rules
export function slotKey(s) { return `${s.phase}/${s.role}/${s.viewport}/${s.view_key}`; }
/** Refuses before any request when the plan breaks a cap. `ledger` remembers earlier attempts of the same request. */
export function planUpload(shots, ledger, { slotCap = SLOT_CAP, attemptCap = ATTEMPT_CAP } = {}) {
  const slots = new Set([...Object.keys(ledger.slots || {}), ...shots.map(slotKey)]);
  if (slots.size > slotCap) throw new Refusal(`this request would hold ${slots.size} slots, the platform cap is ${slotCap}: abandon the request`, 3);
  const used = Object.values(ledger.slots || {}).reduce((n, s) => n + (s.attempts || 0), 0);
  const todo = shots.filter((s) => (ledger.slots?.[slotKey(s)]?.sha256 !== s.sha256));
  if (used + todo.length > attemptCap) throw new Refusal(`${used} attempts used and ${todo.length} more planned exceed the cap of ${attemptCap}: abandon the request (a capture loop?)`, 3);
  return { todo, skipped: shots.length - todo.length, used };
}
/** What to do with a response (docs/design-service-contract.md section 4). */
export function classifyUpload(status, code) {
  if (status === 201 || status === 200) return { action: 'ok' };
  if (status === 429 || status === 502 || status >= 500 && status !== 503) return { action: 'retry' };
  if (status === 503 && code === 'design_storage_not_configured') return { action: 'abandon', why: 'the platform has no screenshot storage' };
  if (status === 503) return { action: 'retry' };
  if (status === 409 && code === 'head_moved') return { action: 'recapture', why: 'the head moved during the upload' };
  if (status === 409 && ['slot_cap_exceeded', 'attempt_cap_exceeded', 'quota_exceeded'].includes(code)) return { action: 'abandon', why: code };
  if (status === 409 && code === 'invalid_state') return { action: 'abandon', why: 'the request is no longer in drafting/previewing' };
  if (status === 409 && code === 'head_not_set') return { action: 'abandon', why: 'report the head (PUT head) before uploading after screenshots' };
  if (status === 422 && code === 'live_data_capture_refused') return { action: 'abandon', why: 'live_data_capture_refused: the capture environment is misconfigured, tell the operator' };
  if (status === 422 && code === 'invalid_screenshot') return { action: 'hash', why: 'invalid_screenshot' };
  return { action: 'abandon', why: `HTTP ${status}${code ? ' ' + code : ''}` };
}
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

export async function uploadOne({ fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), api, shop, request, key, shot, bytes, manifestB64, log = () => {} }) {
  const url = `${api}/api/v1/design-service/shops/${shop}/requests/${request}/screenshots/${shot.phase}/${shot.role}/${shot.viewport}/${shot.view_key}`;
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'image/png', 'X-Capture-Manifest': manifestB64, 'X-Content-SHA256': shot.sha256 };
  if (Number.isInteger(shot.diff_ppm)) headers['X-Diff-Ppm'] = String(shot.diff_ppm);
  let hashRetried = false;
  for (let attempt = 0; ; attempt++) {
    let res, code = '', body = null;
    try {
      res = await fetchImpl(url, { method: 'PUT', headers, body: bytes, redirect: 'error', signal: AbortSignal.timeout(60000) });
      const text = await res.text();
      try { body = JSON.parse(text); code = String(body?.error?.code || ''); if (!/^[a-z_]{1,40}$/.test(code)) code = code ? 'unknown_code' : ''; } catch { body = null; }
    } catch { res = { status: 0 }; }
    const c = res.status === 0 ? { action: 'retry' } : classifyUpload(res.status, code);
    if (c.action === 'ok') return { ok: true, status: res.status, attempt: body?.attempt };
    if (c.action === 'hash' && !hashRetried) { hashRetried = true; log(`  ${basename(shot.file)}: checksum or format refused, one resend`); continue; }
    if (c.action === 'retry') {
      if (attempt >= BACKOFF_MS.length) return { ok: false, action: 'gaveup', status: res.status };
      const ra = Number(res.headers?.get?.('retry-after'));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : BACKOFF_MS[attempt] * (0.75 + Math.random() * 0.5));
      continue;
    }
    return { ok: false, action: c.action === 'hash' ? 'abandon' : c.action, status: res.status, why: c.why || `invalid_screenshot (do not retry)` };
  }
}

// ---------------------------------------------------------------- argv
export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Refusal(`unexpected argument ${a}`);
    const k = a.slice(2);
    if (['service-key', 'key', 'password', 'owner-password', 'staff-password', 'token'].includes(k)) throw new Refusal(`--${k} is not accepted: secrets only come from the environment, never from argv`);
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Refusal(`--${k} needs a value`);
    opts[k] = v; i++;
  }
  return { cmd, opts };
}
export function loadSandboxEnv(file) {
  const text = readFileSync(resolve(file), 'utf8');
  const start = text.indexOf('{');
  let env;
  try { env = JSON.parse(text.slice(start)); } catch { throw new Refusal('the sandbox env file is not valid JSON'); }
  if (env.sandbox !== true || env.dataset !== 'sandbox-v1') throw new Refusal('the env file is not a sandbox env (sandbox:true, dataset sandbox-v1)');
  return env;
}

// ---------------------------------------------------------------- capture (needs a browser)
function loadPlaywright() {
  const tries = [];
  if (process.env.DESIGN_CAPTURE_PLAYWRIGHT_DIR) tries.push(resolve(process.env.DESIGN_CAPTURE_PLAYWRIGHT_DIR, 'package.json'));
  tries.push(resolve(import.meta.dirname, '../package.json'), resolve(import.meta.dirname, '../../ecommerce/e2e/package.json'));
  for (const t of tries) { try { return createRequire(t)('playwright'); } catch { /* next */ } }
  throw new Refusal('playwright not found: set DESIGN_CAPTURE_PLAYWRIGHT_DIR to a directory whose node_modules has it');
}

const LOGIN_EMAIL = '[data-testid="login-email"], #login-email';
const LOGIN_PASSWORD = '[data-testid="login-password"], #login-password';
const LOGIN_SUBMIT = '[data-testid="login-submit"], #login-form button[type=submit]';
const DISABLE_MOTION = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';

/** Nothing in a capture may hang: every view gets a hard deadline and names itself when it misses it. */
export async function withDeadline(label, ms, fn) {
  let t;
  try { return await Promise.race([fn(), new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} did not finish within ${ms / 1000}s`)), ms); })]); } finally { clearTimeout(t); }
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForFunction(() => !document.querySelector('.spinner, .state--loading'), null, { timeout: 10000 }).catch(() => {});
  await page.evaluate(() => { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); return document.fonts && document.fonts.ready; });
  await page.waitForTimeout(500);
}

async function shoot(page, file, { fixed = true } = {}) {
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
  const width = page.viewportSize().width;
  const truncated = height > MAX_HEIGHT;
  const opts = { path: file, fullPage: true, animations: 'disabled', caret: 'hide', mask: [page.locator('[data-pii], input[type=password]')], maskColor: '#000000' };
  if (truncated) opts.clip = { x: 0, y: 0, width, height: MAX_HEIGHT };
  await page.screenshot(opts);
  const bytes = readFileSync(file);
  void fixed;
  return { bytes, truncated, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function ownerApiToken({ api, adminOrigin, login }) {
  const r = await fetch(`${api}/api/v1/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: adminOrigin }, body: JSON.stringify({ email: login.email, password: login.password }), redirect: 'error', signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (r.status !== 200 || !j.access_token) throw new Error(`sandbox owner login failed (HTTP ${r.status})`);
  return j.access_token;
}

export async function runCapture(opts, { log = console.log, scrub }) {
  if (!['before', 'after'].includes(opts.phase)) throw new Refusal('--phase before|after');
  const site = opts.site;
  const views = viewSet(site);
  if (!opts.out) throw new Refusal('--out <dir>');
  if (!opts['sandbox-env']) throw new Refusal('--sandbox-env <file> (the output of `make sandbox-env`)');
  const env = loadSandboxEnv(opts['sandbox-env']);
  const allow = buildAllowlist({ env, process_env: process.env });
  const api = assertSandboxOrigin('api origin', opts.api || env.api_origin, allow);
  const adminOrigin = site === 'admin' ? assertSandboxOrigin('admin origin', opts['admin-origin'] || env.admin_origin, allow) : null;
  const sfOrigin = site === 'storefront' ? assertSandboxOrigin('storefront origin', opts['storefront-origin'] || '', allow) : null;
  const origin = adminOrigin || sfOrigin;
  const shop = Number(opts.shop || 1);
  const owner = site === 'admin' ? assertSyntheticLogin('owner', { email: process.env.DESIGN_CAPTURE_OWNER_EMAIL || env.logins?.owner?.email, password: process.env.DESIGN_CAPTURE_OWNER_PASSWORD || env.logins?.owner?.password }) : null;
  const staff = site === 'admin' ? assertSyntheticLogin('staff', { email: process.env.DESIGN_CAPTURE_STAFF_EMAIL || env.logins?.staff?.email, password: process.env.DESIGN_CAPTURE_STAFF_PASSWORD || env.logins?.staff?.password }) : null;
  for (const l of [owner, staff]) if (l) scrub.add(l.password);
  const pk = env.publishable_key;
  const fence = new Set([...[...allow].filter((o) => !(MAIN_STACK_PORTS.has(new URL(o).port) && isLoopback(o))), ...(env.media_origin ? [assertSandboxOrigin('media origin', env.media_origin, allow)] : [])]);

  const out = resolve(opts.out);
  mkdirSync(out, { recursive: true });
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const shots = [], skipped = [];
  let blocked = 0;

  const newContext = async (vw, vh) => {
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1, locale: 'zh-TW', timezoneId: 'Asia/Taipei', reducedMotion: 'reduce', serviceWorkers: 'block' });
    ctx.setDefaultTimeout(30000);
    // route() does not see WebSockets: refuse every one (the page under test is branch code and holds the session)
    if (typeof ctx.routeWebSocket !== 'function') throw new Refusal('this Playwright has no routeWebSocket (needs 1.48+): the browser fence cannot block WebSockets, refused');
    await ctx.routeWebSocket(/.*/, (ws) => { blocked++; ws.close(); });
    await ctx.route('**/*', (route) => {
      const u = route.request().url();
      if (/^(data|blob|about):/.test(u)) return route.continue();
      let o = ''; try { o = new URL(u).origin; } catch { /* fall through */ }
      if (fence.has(o)) return route.continue();
      blocked++; return route.abort('blockedbyclient');
    });
    await ctx.route('**/config.local.js', (route) => route.fulfill({ contentType: 'application/javascript', body: site === 'admin'
      ? `window.ADMIN_CONFIG = Object.assign(window.ADMIN_CONFIG || {}, { apiBase: ${JSON.stringify(api)} });`
      : `Object.assign(window.SHOP_CONFIG || (window.SHOP_CONFIG = {}), { apiBase: ${JSON.stringify(api)}, publishableKey: ${JSON.stringify(pk)} });` }));
    await ctx.addInitScript(({ style, base }) => {
      try { localStorage.setItem('apiBase', base); } catch { /* storage unavailable */ }
      const add = () => { const s = document.createElement('style'); s.textContent = style; (document.head || document.documentElement).appendChild(s); };
      if (document.head) add(); else document.addEventListener('DOMContentLoaded', add);
    }, { style: DISABLE_MOTION, base: api });
    return ctx;
  };
  // The hardened admin freezes the JS intrinsics at boot (D18) and a patched Date breaks it, so the fixed clock is storefront-only;
  // the admin is deterministic through the fixed sandbox dataset (docs: design notes of the design-history change).
  const withClock = async (page) => { if (site === "storefront" && page.clock && page.clock.setFixedTime) await page.clock.setFixedTime(FIXED_TIME).catch(() => {}); };
  const record = (page, role, vw, key) => withDeadline(`${role} ${vw} ${key}`, 90000, () => record1(page, role, vw, key));
  const record1 = async (page, role, vw, key) => {
    const file = join(out, shotName(opts.phase, role, vw, key));
    const s = await shoot(page, file);
    shots.push({ file: basename(file), phase: opts.phase, role, viewport: vw, view_key: key, width: s.width, height: s.height, bytes: s.bytes.length, sha256: createHash('sha256').update(s.bytes).digest('hex'), truncated: s.truncated || undefined });
    log(`  ${opts.phase} ${role} ${vw} ${key}`);
  };

  try {
    if (site === 'admin') {
      const ownerToken = await ownerApiToken({ api, adminOrigin, login: owner });
      scrub.add(ownerToken);
      const get = async (p) => (await (await fetch(`${api}/api/v1${p}`, { headers: { Authorization: `Bearer ${ownerToken}` }, redirect: "error", signal: AbortSignal.timeout(30000) })).json());
      const orders = (await get(`/admin/shops/${shop}/orders?page=1&page_size=5`)).orders || [];
      const prods = (await get(`/admin/shops/${shop}/products?page=1&page_size=5`)).products || [];
      const paths = { home: '/', orders: '/orders', 'order-detail': orders[0] ? `/orders/${orders[0].id}` : null, products: '/products', 'product-edit': prods[0] ? `/products/${prods[0].id}` : null, members: '/members', reports: '/reports' };
      const vps = Object.entries(VIEWPORTS).map(([w, h]) => [Number(w), h]);
      // logged out: the login screen
      for (const [vw, vh] of vps) {
        const ctx = await newContext(vw, vh), page = await ctx.newPage(); await withClock(page);
        await page.goto(`${adminOrigin}/#/login`);
        await page.locator(LOGIN_EMAIL).waitFor({ timeout: 20000 });
        await settle(page);
        await record(page, "owner", vw, "login");
        await ctx.close();
      }
      // one sign-in per role (the platform rate-limits sign-ins); the viewport changes inside the session
      for (const [who, creds] of [["owner", owner], ["staff", staff]]) {
        const ctx = await newContext(vps[0][0], vps[0][1]), page = await ctx.newPage(); await withClock(page);
        await page.goto(`${adminOrigin}/#/login`);
        await page.locator(LOGIN_EMAIL).fill(creds.email);
        await page.locator(LOGIN_PASSWORD).fill(creds.password);
        await page.locator(LOGIN_SUBMIT).click();
        await page.locator(".shell").waitFor({ timeout: 20000 }).catch(async () => {
          const hint = await page.locator("[role=alert], .error, .form-error, .alert").first().innerText({ timeout: 1000 }).catch(() => "no error text on the page");
          throw new Error(`${who} sign-in did not reach the app (${hint.slice(0, 120)})`);
        });
        for (const [vw, vh] of vps) {
          await page.setViewportSize({ width: vw, height: vh });
          for (const { role, view_key } of views.filter((v) => v.role === who && v.view_key !== "login")) {
            if (!paths[view_key]) { skipped.push({ role, viewport: vw, view_key, reason: "no demo data for this view" }); continue; }
            await page.goto(`${adminOrigin}/#${paths[view_key]}`);
            await page.waitForLoadState("domcontentloaded");
            await page.locator(".shell").waitFor({ timeout: 20000 });
            await settle(page);
            await record(page, role, vw, view_key);
          }
        }
        await ctx.close();
      }
    } else {
      const products = (await (await fetch(`${api}/api/v1/shop/products?page=1&page_size=20`, { headers: { "X-Publishable-Key": pk }, redirect: "error", signal: AbortSignal.timeout(30000) })).json()).products || [];
      const prod = products.find((p) => (p.skus || []).some((s) => s.is_active !== false && !(typeof s.stock_qty === 'number' && s.stock_qty <= 0)));
      for (const [vw, vh] of Object.entries(VIEWPORTS).map(([w, h]) => [Number(w), h])) {
        const ctx = await newContext(vw, vh), page = await ctx.newPage(); await withClock(page);
        const go = async (hash) => { await page.goto(`${sfOrigin}/#${hash}`); await page.reload(); await page.waitForLoadState('domcontentloaded'); await settle(page); };
        await go('/'); await record(page, 'anon', vw, 'home');
        const hasStory = (await page.locator('a[href="#/story"]').count()) > 0;
        await go('/shop'); await record(page, 'anon', vw, 'shop');
        if (prod) { await go(`/product/${encodeURIComponent(prod.slug)}`); await record(page, 'anon', vw, 'product'); } else skipped.push({ role: 'anon', viewport: vw, view_key: 'product', reason: 'no sellable product' });
        if (hasStory) { await go('/story'); await record(page, 'anon', vw, 'story'); } else skipped.push({ role: 'anon', viewport: vw, view_key: 'story', reason: 'the site has no story page' });
        if (prod) {
          // a synthetic cart: one unit of the first sellable SKU through the locked commerce layer (no account, no order)
          await page.evaluate(async (slug) => {
            const cat = await window.ShopCommerce.loadCatalog();
            const p = cat.products.find((x) => x.slug === slug);
            const sku = p.skus.find((s) => window.ShopCommerce.isSkuSellable(s));
            window.ShopCommerce.cart.add(p, sku, Object.keys(sku.options || {}).length ? String(Object.values(sku.options)[0]) : (sku.code || ''), 1, '', null);
          }, prod.slug);
          await go('/cart');
          if (vw >= 1000 && (await page.locator('[data-act="openCart"]').count())) { await page.locator('[data-act="openCart"]').first().click(); await page.waitForTimeout(400); }
          await record(page, 'anon', vw, 'cart');
          await go('/checkout'); await record(page, 'anon', vw, 'checkout'); // the first step only: nothing is typed or submitted
        } else { skipped.push({ role: 'anon', viewport: vw, view_key: 'cart', reason: 'no sellable product' }, { role: 'anon', viewport: vw, view_key: 'checkout', reason: 'no sellable product' }); }
        await ctx.close();
      }
    }
  } finally { await browser.close(); }

  if (opts['diff-against']) await addDiffs(browser, shots, out, resolve(opts['diff-against']), opts.phase, chromium);
  const manifest = { tool: TOOL, tool_version: TOOL_VERSION, set_version: SET_VERSION, site, phase: opts.phase, dataset: 'sandbox-v1', api_origin_class: 'sandbox', origin, captured_at: new Date().toISOString(), blocked_requests: blocked, shots, skipped };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  log(`captured ${shots.length} screenshots (${skipped.length} skipped, ${blocked} foreign requests blocked) in ${out}`);
  return manifest;
}

/** diff_ppm of each "after" shot against the same slot of a "before" directory (optional; the platform stores it, never trusts it). */
async function addDiffs(_closed, shots, out, beforeDir, phase, chromium) {
  if (phase !== 'after') return;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const s of shots) {
      const other = join(beforeDir, s.file.replace(/^after-/, 'before-'));
      if (!existsSync(other)) continue;
      const ppm = await page.evaluate(async ([x, y, fnSrc]) => {
        const diff = new Function(`return (${fnSrc})`)();
        const load = (b64) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = 'data:image/png;base64,' + b64; });
        const [ia, ib] = await Promise.all([load(x), load(y)]);
        if (ia.width !== ib.width || ia.height !== ib.height) return null;
        const get = (i) => { const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return g.getImageData(0, 0, i.width, i.height).data; };
        return diff(get(ia), get(ib));
      }, [readFileSync(join(out, s.file)).toString('base64'), readFileSync(other).toString('base64'), pixelDiffPpm.toString()]);
      if (Number.isInteger(ppm)) s.diff_ppm = ppm;
    }
  } finally { await browser.close(); }
}

// ---------------------------------------------------------------- upload command
export async function runUpload(opts, { log = console.log, scrub, fetchImpl = fetch, sleep }) {
  const key = process.env.DESIGN_SERVICE_KEY || '';
  if (!/^dsk_[A-Za-z0-9_-]{8,}$/.test(key)) throw new Refusal('DESIGN_SERVICE_KEY (a dsk_ service credential) must be set in the environment');
  scrub.add(key);
  for (const k of ['dir', 'api', 'shop', 'request']) if (!opts[k]) throw new Refusal(`--${k} is required`);
  if (!/^\d+$/.test(opts.shop)) throw new Refusal('--shop must be a number');
  if (!/^[0-9a-f-]{36}$/i.test(opts.request)) throw new Refusal('--request must be the request uuid');
  const api = parseOrigin(opts.api);
  if (api.startsWith('http:') && !isLoopback(api)) throw new Refusal('the platform API must be https (or loopback http for a local stack)');
  const dir = resolve(opts.dir);
  let m;
  try { m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); } catch { throw new Refusal('manifest.json is missing or not valid JSON'); }
  if (m.tool !== TOOL || m.dataset !== 'sandbox-v1' || m.api_origin_class !== 'sandbox') throw new Refusal('manifest.json is not a sandbox design-capture manifest: refused');
  if (m.site === 'admin' && !m.origin) throw new Refusal('an admin manifest must carry the capture origin');
  if (m.origin !== undefined && m.origin !== null) { if (typeof m.origin !== 'string' || m.origin.length > 200) throw new Refusal('manifest origin is malformed'); m.origin = parseOrigin(m.origin); }
  if (!Array.isArray(m.shots) || m.shots.length === 0 || m.shots.length > 1000) throw new Refusal('manifest.json has no usable shots list');
  if (Number.isNaN(new Date(m.captured_at).getTime())) throw new Refusal('manifest captured_at is not a date');
  const seen = new Set();
  const readShot = (s) => {
    const f = join(dir, basename(s.file));
    const st = lstatSync(f);
    if (!st.isFile() || st.isSymbolicLink()) throw new Refusal(`${s.file} is not a regular file: refused`);
    if (st.size > MAX_PNG_BYTES) throw new Refusal(`${s.file} is larger than ${MAX_PNG_BYTES} bytes: refused`);
    const b = readFileSync(f);
    if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIG)) throw new Refusal(`${s.file} is not a PNG: refused`);
    return b;
  };
  const shots = m.shots.map((s) => {
    if (!s || typeof s.file !== 'string') throw new Refusal('manifest entry without a file name');
    const p = parseShotName(s.file);
    if (!p || p.phase !== s.phase || p.role !== s.role || p.viewport !== s.viewport || p.view_key !== s.view_key || !KEY_RE.test(s.view_key)) throw new Refusal(`manifest entry ${s.file} does not match its file name`);
    if (seen.has(s.file)) throw new Refusal(`duplicate manifest entry ${s.file}`);
    seen.add(s.file);
    const bytes = readShot(s);
    if (createHash('sha256').update(bytes).digest('hex') !== s.sha256) throw new Refusal(`${s.file} changed after capture (sha256 mismatch)`);
    return s;
  });
  const ledgerFile = join(dir, '.upload-ledger.json');
  let ledger = { request: opts.request, slots: {} };
  if (existsSync(ledgerFile)) { ledger = JSON.parse(readFileSync(ledgerFile, 'utf8')); if (ledger.request !== opts.request) ledger = { request: opts.request, slots: {} }; }
  const cap = (name, max) => { if (opts[name] === undefined) return max; const n = Number(opts[name]); if (!Number.isInteger(n) || n < 1 || n > max) throw new Refusal(`--${name} must be an integer from 1 to ${max}`); return n; };
  const plan = planUpload(shots, ledger, { slotCap: cap('slot-cap', SLOT_CAP), attemptCap: cap('attempt-cap', ATTEMPT_CAP) });
  log(`uploading ${plan.todo.length} screenshot(s), ${plan.skipped} already stored`);
  const manifestB64 = captureManifestHeader({ site: m.site, origin: m.origin, capturedAt: new Date(m.captured_at) });
  let done = 0;
  for (const s of plan.todo) {
    const r = await uploadOne({ fetchImpl, sleep, api, shop: opts.shop, request: opts.request, key, shot: s, bytes: (() => { const b = readShot(s); if (createHash('sha256').update(b).digest('hex') !== s.sha256) throw new Refusal(`${s.file} changed during the upload (sha256 mismatch)`); return b; })(), manifestB64, log });
    const k = slotKey(s);
    ledger.slots[k] = { sha256: r.ok ? s.sha256 : ledger.slots[k]?.sha256, attempts: (ledger.slots[k]?.attempts || 0) + 1 };
    writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
    if (!r.ok) {
      if (r.action === 'recapture') {
        for (const k2 of Object.keys(ledger.slots)) if (k2.startsWith('after/')) ledger.slots[k2].sha256 = undefined;
        writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
      }
      if (r.action === 'recapture') throw new Refusal(`${s.file}: ${r.why}: recapture "after" at the new head, then upload again`, 5);
      if (r.action === 'gaveup') throw new Refusal(`${s.file}: gave up after ${BACKOFF_MS.length} retries (HTTP ${r.status}); the ledger remembers what is stored`, 4);
      throw new Refusal(`${s.file}: ${r.why}: abandon the request (failed(screenshot_upload_failed))`, 3);
    }
    done++; log(`  stored ${s.file} (attempt ${r.attempt ?? '?'})`);
  }
  log(`done: ${done} uploaded`);
  return { uploaded: done, skipped: plan.skipped };
}

// ---------------------------------------------------------------- main
export async function main(argv) {
  const secrets = new Set();
  const scrub = makeScrubber(secrets);
  const log = (...a) => console.log(scrub(a.join(' ')));
  try {
    const { cmd, opts } = parseArgs(argv);
    if (cmd === 'views') { for (const site of opts.site ? [opts.site] : ['admin', 'storefront']) for (const v of viewSet(site)) for (const vp of Object.keys(VIEWPORTS)) log(`${site} ${v.role} ${vp} ${v.view_key}`); return 0; }
    if (cmd === 'capture') { await runCapture(opts, { log, scrub }); return 0; }
    if (cmd === 'upload') { await runUpload(opts, { log, scrub }); return 0; }
    if (cmd === 'selftest') { const { spawnSync } = await import('node:child_process'); return spawnSync(process.execPath, ['--test', resolve(import.meta.dirname, '../tests/design-capture.test.mjs')], { stdio: 'inherit' }).status ?? 1; }
    throw new Refusal('usage: design-capture.mjs capture|upload|views|selftest (see the header of this file)');
  } catch (e) {
    console.error(scrub(`design-capture: ${e && e.message ? e.message : e}`));
    return e && e.exitCode ? e.exitCode : 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
void readdirSync;
