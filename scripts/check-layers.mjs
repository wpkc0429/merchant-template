#!/usr/bin/env node
/* ============================================================
   check-layers.mjs — layer guard, no dependencies (Node 18+).

   Usage
     node scripts/check-layers.mjs            run the guard, print the hash manifest
     node scripts/check-layers.mjs --check    also compare the manifest with
                                              scripts/commerce.manifest.json
                                              (fails if commerce/ or config.js changed)
     node scripts/check-layers.mjs --update   rewrite scripts/commerce.manifest.json
                                              (only for an intentional commerce-layer change)

   What it enforces
     1. The design layer (every .js under public/ except public/commerce/ and
        config.js / config.local.js) reaches the commerce layer ONLY through
        window.ShopCommerce, and only the names listed in
        public/commerce/public-api.json. It may read only the listed
        window.SHOP_CONFIG keys.
     2. The design layer never touches the API or storage directly (fetch,
        XHR, localStorage, sessionStorage, "/api/v1", apiBase,
        publishableKey, the private _internal handle).
     3. public-api.json matches what the commerce scripts really export
        (they are executed in a stubbed sandbox).
     4. Template repo only (template.json "isTemplate": true): public/config.js
        still holds the REPLACE_WITH_* placeholders (local values belong in the
        gitignored config.local.js). In a MERCHANT repo ("isTemplate": false)
        config.js holds the real apiBase / publishableKey, is protected only by
        its hash in the manifest, and leftover placeholders are just a warning.
     5. Strict CSP: public/_headers must exist and carry a strict Content-Security-Policy (script-src 'self' only, object-src/base-uri/frame-ancestors locked down); an inline <script>/on*= in index.html is an error in the template, a warning in a merchant repo.
     6. Prints a sha256 manifest of public/commerce/, public/config.js and public/_headers.
   ============================================================ */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const MANIFEST = path.join(ROOT, 'scripts', 'commerce.manifest.json');
const TEMPLATE_JSON = path.join(ROOT, 'template.json');
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : [f];
  });
}

const api = JSON.parse(readFileSync(path.join(PUB, 'commerce', 'public-api.json'), 'utf8'));
const errors = [];
const fail = (m) => errors.push(m);
const warnings = [];

// template.json decides whether this repo is the template (placeholder rule) or a merchant repo.
let isTemplate = true;
if (!existsSync(TEMPLATE_JSON)) fail('template.json is missing');
else {
  try { isTemplate = JSON.parse(readFileSync(TEMPLATE_JSON, 'utf8')).isTemplate !== false; }
  catch (e) { fail('template.json is not valid JSON: ' + e.message); }
}

/* ---------- 1 + 2: design layer scan ---------- */

const isCommerce = (f) => rel(f).startsWith('public/commerce/');
const isConfig = (f) => /^public\/config(\.local)?\.js$/.test(rel(f));
const designFiles = walk(PUB).filter((f) => f.endsWith('.js') && !isCommerce(f) && !isConfig(f));

// Strip comments (good enough for a guard: keeps string contents, drops // and /* */).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}(),])\/\/[^\n]*/g, '$1');
}

const FORBIDDEN = [
  [/\bapiBase\b/, 'apiBase'],
  [/\bpublishableKey\b/, 'publishableKey'],
  [/\b_internal\b/, '_internal'],
  [/\blocalStorage\b/, 'localStorage'],
  [/\bsessionStorage\b/, 'sessionStorage'],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bfetch\s*\(/, 'fetch('],
  [/\/api\/v1/, '"/api/v1"'],
  [/['"]shopcommerce:/, 'a storage key ("shopcommerce:...")'],
  [/^\s*import\s/m, 'import (design code must not import commerce modules)']
];

for (const f of designFiles) {
  const src = stripComments(readFileSync(f, 'utf8'));
  for (const [re, label] of FORBIDDEN) if (re.test(src)) fail(`${rel(f)}: forbidden in design layer: ${label}`);

  // aliases of window.ShopCommerce
  const aliases = new Set(['ShopCommerce']);
  for (const m of src.matchAll(/\b(?:var|let|const)\s+(\w+)\s*=\s*window\.ShopCommerce\b\s*;/g)) aliases.add(m[1]);
  for (const a of aliases) {
    const re = new RegExp(`(?<![\\w.])${a}\\b(?!\\s*=)(\\.(\\w+))?(\\.(\\w+))?`, 'g');
    for (const m of src.matchAll(re)) {
      const first = m[2], second = m[4];
      const before = src.slice(Math.max(0, m.index - 20), m.index);
      if (/window\.$/.test(before)) continue;                      // the declaration itself
      if (first === undefined) { fail(`${rel(f)}: bare "${a}" (use only documented members)`); continue; }
      if (first === 'cart' || first === 'checkout' || first === 'content') {
        const allowed = api[`ShopCommerce.${first}`];
        if (second === undefined) fail(`${rel(f)}: bare ${a}.${first} (call a documented function)`);
        else if (!allowed.includes(second)) fail(`${rel(f)}: ${a}.${first}.${second} is not in commerce/public-api.json`);
      } else if (!api.ShopCommerce.includes(first)) {
        fail(`${rel(f)}: ${a}.${first} is not in commerce/public-api.json`);
      }
    }
  }
  for (const m of src.matchAll(/\bSHOP_CONFIG\b(?!\s*=)(\.(\w+))?/g)) {
    if (!m[2]) fail(`${rel(f)}: bare SHOP_CONFIG (read documented keys only: ${api.config.join(', ')})`);
    else if (!api.config.includes(m[2])) fail(`${rel(f)}: SHOP_CONFIG.${m[2]} is not readable from the design layer`);
  }
}

/* ---------- 3: documented surface == real exports ---------- */

{
  const sandbox = {
    console, setTimeout, clearTimeout, URL, JSON, Promise,
    fetch: () => Promise.reject(new Error('no network in guard')),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { createElement: () => ({ appendChild() {} }), body: { appendChild() {} } },
    crypto: {}, Date, Math, Object, Array, String, Number, RegExp, encodeURIComponent,
    location: { href: 'http://localhost/' }, history: { state: null, replaceState() {} },
    DOMParser: class { parseFromString() { return { body: { childNodes: [] } }; } }
  };
  sandbox.window = sandbox;
  sandbox.SHOP_CONFIG = { apiBase: 'x', publishableKey: 'k', showPrices: true, featuredCategory: 'f' };
  vm.createContext(sandbox);
  try {
    for (const n of ['api.js', 'cart.js', 'content-allowlist.js', 'content.js', 'checkout.js']) {
      vm.runInContext(readFileSync(path.join(PUB, 'commerce', n), 'utf8'), sandbox, { filename: n });
    }
    const C = sandbox.ShopCommerce;
    const pub = (obj) => Object.keys(obj).filter((k) => !k.startsWith('_')).sort();
    const top = pub(C).filter((k) => k !== 'cart' && k !== 'checkout' && k !== 'content');
    const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    if (!same(top, api.ShopCommerce)) fail(`public-api.json ShopCommerce [${api.ShopCommerce}] != exports [${top}]`);
    if (!same(pub(C.cart), api['ShopCommerce.cart'])) fail(`public-api.json cart != exports [${pub(C.cart)}]`);
    if (!same(pub(C.checkout), api['ShopCommerce.checkout'])) fail(`public-api.json checkout != exports [${pub(C.checkout)}]`);
    if (!same(pub(C.content || {}), api['ShopCommerce.content'] || [])) fail(`public-api.json content != exports [${pub(C.content || {})}]`);
  } catch (e) {
    fail('could not load commerce scripts in the sandbox: ' + e.message);
  }
}

/* ---------- 4: config.js: placeholders in the template, real values (hash-locked) in a merchant repo ---------- */

{
  const cfg = readFileSync(path.join(PUB, 'config.js'), 'utf8');
  const hasPlaceholders = /REPLACE_WITH_PLATFORM_API_BASE/.test(cfg) && /REPLACE_WITH_PUBLISHABLE_KEY/.test(cfg);
  const anyPlaceholder = /REPLACE_WITH_(PLATFORM_API_BASE|PUBLISHABLE_KEY)/.test(cfg);
  if (isTemplate) {
    if (!hasPlaceholders) fail('public/config.js must keep the REPLACE_WITH_* placeholders in the template (use gitignored public/config.local.js for local values; real values belong in merchant repos, see scripts/new-merchant.mjs)');
  } else if (anyPlaceholder) {
    warnings.push('public/config.js still holds REPLACE_WITH_* placeholders: set apiBase and publishableKey (a human edit, then `node scripts/check-layers.mjs --update`) before deploying');
  }
}

/* ---------- 5: strict CSP is a deployment requirement (public/_headers) ---------- */

/** Pure check of a Cloudflare `_headers` text and of index.html; returns {errors, warnings}. */
function checkCsp(headersText, indexHtml, tpl = true) {
  const errors = [], warnings = [];
  if (headersText == null) {
    errors.push('public/_headers is missing: a strict Content-Security-Policy is a deployment requirement (see docs/DECISIONS.md); restore the template file');
  } else {
    const m = /^[ \t]+Content-Security-Policy:[ \t]*(.+)$/im.exec(headersText.replace(/\r\n/g, '\n'));
    if (!m) errors.push('public/_headers has no Content-Security-Policy line');
    else {
      const dirs = new Map();
      for (const part of m[1].split(';')) { const [n, ...v] = part.trim().split(/\s+/); if (n) dirs.set(n.toLowerCase(), v); }
      const need = (n, ok, msg) => { if (!dirs.has(n)) errors.push(`CSP lacks ${n}`); else if (!ok(dirs.get(n))) errors.push(`CSP ${n} ${msg}`); };
      const script = dirs.get('script-src') || dirs.get('default-src') || [];
      if (!dirs.has('script-src') && !dirs.has('default-src')) errors.push('CSP lacks script-src');
      if (script.some((v) => /^'unsafe-(inline|eval)'$|^\*$|^https?:$|^data:$|^blob:$|^'strict-dynamic'$/i.test(v)) || script.some((v) => /^https?:\/\//i.test(v))) errors.push(`CSP script-src must be 'self' only (found: ${script.join(' ')})`);
      if (dirs.has('style-src') && (dirs.get('style-src') || []).some((v) => /^'unsafe-inline'$|^\*$/.test(v))) errors.push("CSP style-src must not allow 'unsafe-inline' (only style-src-attr may)");
      need('object-src', (v) => v.join(' ') === "'none'", "must be 'none'");
      need('base-uri', (v) => v.join(' ') === "'none'" || v.join(' ') === "'self'", "must be 'none' or 'self'");
      need('frame-ancestors', (v) => v.join(' ') === "'none'" || v.join(' ') === "'self'", "must be 'none' or 'self'");
      if (!dirs.has('default-src')) errors.push('CSP lacks default-src');
      if (!dirs.has('form-action')) errors.push('CSP lacks form-action');
      else if ((dirs.get('form-action') || []).some((v) => /^\*$|^https?:$|^data:$/i.test(v))) errors.push('CSP form-action must list explicit hosts (no wildcard or bare scheme)');
    }
  }
  const html = String(indexHtml || '').replace(/<!--[\s\S]*?-->/g, '');
  const inline = /<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(html) || /\son[a-z]+\s*=\s*["']/i.test(html);
  if (inline) (tpl ? errors : warnings).push('public/index.html has an inline <script> or an on*= handler: the strict CSP in public/_headers blocks it. Use an external file (see commerce/local-config.js); a merchant repo made from v0.1.0 must replace its inline localhost-override script with <script src="commerce/local-config.js"></script>');
  return { errors, warnings };
}
{
  const hp = path.join(PUB, '_headers'), ip = path.join(PUB, 'index.html');
  const r = checkCsp(existsSync(hp) ? readFileSync(hp, 'utf8') : null, existsSync(ip) ? readFileSync(ip, 'utf8') : '', isTemplate);
  r.errors.forEach(fail); warnings.push(...r.warnings);
}

/* ---------- 5b: script load order in index.html (content-allowlist.js and content.js before the design layer) ---------- */

{
  const ip = path.join(PUB, 'index.html');
  if (existsSync(ip)) {
    const srcs = [...readFileSync(ip, 'utf8').replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
    const order = ['commerce/api.js', 'commerce/cart.js', 'commerce/content-allowlist.js', 'commerce/content.js', 'commerce/checkout.js', 'content.js', 'app.js'];
    let last = -1;
    for (const s of order) {
      const i = srcs.indexOf(s);
      if (i < 0) { (isTemplate ? fail : (m) => warnings.push(m))(`public/index.html does not load ${s} (v0.3.0 content store, an error in the template and a warning in a merchant repo until its design layer adopts it: load commerce/api.js, cart.js, content-allowlist.js, content.js and checkout.js (checkout.js freezes ShopCommerce, so it comes last), then content.js and app.js)`); continue; }
      if (i < last) fail(`public/index.html loads ${s} out of order (expected: ${order.join(', ')})`);
      last = Math.max(last, i);
    }
  }
}

/* ---------- 5c: content values reach the page only through the safe helpers ---------- */

// The design layer may not hand a platform content VALUE to innerHTML/outerHTML/insertAdjacentHTML, nor use eval,
// new Function, document.write or createContextualFragment. Everything it renders from ShopCommerce.content goes
// through esc() (text), content.text/richText/link/image. A heuristic scan, not a proof: the server sanitiser and the
// CSP are the other lines of defence.
for (const f of designFiles) {
  const src = stripComments(readFileSync(f, 'utf8'));
  if (/\b(eval|Function)\s*\(|\bdocument\.write(ln)?\s*\(|\bcreateContextualFragment\b/.test(src)) fail(`${rel(f)}: eval / new Function / document.write / createContextualFragment are forbidden in the design layer`);
  if (/(innerHTML|outerHTML)\s*[+]?=[^;\n]*\bcontent\.(get|all)\(|insertAdjacentHTML\([^;\n]*\bcontent\.(get|all)\(/.test(src)) fail(`${rel(f)}: content values must not be assigned to innerHTML; use ShopCommerce.content.text/richText/link/image or esc()`);
}

/* ---------- 6: hash manifest ---------- */

const locked = [...walk(path.join(PUB, 'commerce')), path.join(PUB, 'config.js'), ...(existsSync(path.join(PUB, '_headers')) ? [path.join(PUB, '_headers')] : [])].sort();
const manifest = {};
for (const f of locked) {
  // normalise line endings so CRLF checkouts hash the same as LF
  const text = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  manifest[rel(f)] = createHash('sha256').update(text).digest('hex');
}
console.log('Locked-layer manifest (sha256):');
for (const [f, h] of Object.entries(manifest)) console.log(`  ${h}  ${f}`);

if (process.argv.includes('--update')) {
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log('wrote ' + rel(MANIFEST));
}
if (process.argv.includes('--check')) {
  if (!existsSync(MANIFEST)) fail('scripts/commerce.manifest.json is missing (run with --update)');
  else {
    const saved = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    for (const f of new Set([...Object.keys(saved), ...Object.keys(manifest)])) {
      if (saved[f] !== manifest[f]) fail(`locked file changed: ${f} (${saved[f] ? (manifest[f] ? 'modified' : 'removed') : 'added'})`);
    }
  }
}

for (const w of warnings) console.warn('warning: ' + w);
if (errors.length) {
  console.error('\nLAYER CHECK FAILED');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}
console.log(`\nlayer check OK (${designFiles.length} design file(s): ${designFiles.map(rel).join(', ')})`);
