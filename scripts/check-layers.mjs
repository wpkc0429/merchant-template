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
     5d. (D12, v0.4.2) No dialog tag, popover/inert attribute, dialog/popover/fullscreen/pointer-lock
        method, programmatic click/submit/dispatchEvent or synthetic Event in the design layer.
     5e. (D20, v0.5.0) public/_headers is DERIVED: it must be byte-identical to scripts/render-headers.mjs applied to the core template
        (scripts/headers.core.txt) and the merchant's own origins (merchant.headers.json, strict: https origins only, no wildcard, no
        `https:` / `*` / `data:` scheme source in connect-src). connect-src / img-src may not carry a bare scheme or wildcard.
        Leftover replace-with-* placeholders in merchant.headers.json: a warning in the template, an ERROR in a merchant repo
        (--allow-placeholders turns that into a warning; new-merchant.mjs uses it for its own scripted verification only).
     5f. (D20) Storefront network scan: fetch, sendBeacon, WebSocket, EventSource, XMLHttpRequest, new Image / Audio, dynamic
        import(), RTCPeerConnection and window.open are refused in the design layer as identifiers and as exact string values
        (window['fetch'], 'fe' + 'tch'), including aliases such as (0, fetch)(x) and var f = fetch.
     6. Prints a sha256 manifest of public/commerce/ and public/config.js (public/_headers is verified by 5e, not hashed).
   ============================================================ */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { validateConfig, renderForRoot, parseConfigText, CONFIG_FILE, OUT_FILE } from './render-headers.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// HTML comments the way the browser ends them (D23): <!--> and <!---> are empty comments, and a comment ends at --> OR --!> (the tokenizer's "comment end bang" state)
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|--!>))/g;
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

// Canonical source for the regex rules below (decision D17). A real (small) scanner, not a regex: it walks strings, templates
// (with nested ${}), regex literals and comments, and returns the source with
//  * every comment blanked (spaces; line terminators kept, so line numbers stay true): // ends at \n, \r, U+2028 or U+2029;
//  * Unicode escapes decoded where JavaScript decodes them: \uXXXX and \u{...} in identifiers (a `fetch(` IS `fetch(`), and \u, \x
//    and octal escapes inside string and template literals (a '\x73hopcommerce:' IS 'shopcommerce:'); an escape that would decode to a quote,
//    a backslash, a backtick, a `$` or a line terminator stays as written.
// The contract (identifier names and property names by escape-decoded value, string / template values by cooked value) is the one of
// admin/scripts/lib/design-scan.mjs. Where a `/` could start a regex or divide, a regex is read only when it closes on the same line (any length); nothing is
// blanked inside it, and its text still gets its Unicode escapes decoded (the text may really be code: `{} / \u0066etch('/x') / 2` is a division), so a
// wrong guess can only keep a comment or decode an escape that was regex text (over-report), never hide code.
function canonicalSource(src, mask = 0) {
  // mask: the text of string and template literals (outside ${...}) becomes spaces (line breaks kept), so a rule on identifiers does
  // not fire on copy text such as 'we fetch your order'. Used by the storefront network scan (5f).
  // mask 1: string / template text and regex literals blanked; mask 2: regex literals only (strings kept, for exact-value rules).
  const blank = (s) => s.replace(/[^\r\n\u2028\u2029]/g, ' ');
  const lit = (mask === true || mask === 1) ? blank : (s) => s;
  const lastSig = () => { for (let q = out.length - 1; q >= 0; q--) { const k = out[q].search(/\S\s*$/); if (k >= 0) return out[q][k]; } return ''; };
  const n = src.length, out = [], braces = [], parens = [];
  const LT = (c) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029';
  const KW = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await', 'instanceof']);
  const STMT = new Set(['if', 'while', 'for', 'with']);
  const IDP = /[\p{ID_Continue}$\u200c\u200d]/u;
  let i = 0, regexOk = true, word = '', afterDot = false;
  const esc = (j) => { // the decoded escape at src[j] (a backslash) as [text, next], or null when it is kept as written
    const d = src[j + 1];
    let m;
    if (d === 'u') { m = /^\\u(?:([0-9a-fA-F]{4})|\{([0-9a-fA-F]{1,6})\})/.exec(src.slice(j, j + 12)); if (m && parseInt(m[1] || m[2], 16) <= 0x10ffff) return [String.fromCodePoint(parseInt(m[1] || m[2], 16)), j + m[0].length]; }
    else if (d === 'x') { m = /^\\x([0-9a-fA-F]{2})/.exec(src.slice(j, j + 4)); if (m) return [String.fromCharCode(parseInt(m[1], 16)), j + 4]; }
    else if (d >= '0' && d <= '7') { m = /^\\([0-3][0-7]{0,2}|[4-7][0-7]?)/.exec(src.slice(j, j + 5)); return [String.fromCharCode(parseInt(m[1], 8)), j + 1 + m[1].length]; }
    return null;
  };
  const decodeRange = (a, b) => { // src[a..b) with unicode and hex escapes decoded (the same rule as in a string), used for text that may be a regex or code
    let r = '';
    for (let j = a; j < b;) {
      if (src[j] === '\\' && (src[j + 1] === 'u' || src[j + 1] === 'x')) { const e = esc(j); if (e && e[1] <= b && !keepEsc(e[0])) { r += e[0]; j = e[1]; continue; } }
      if (src[j] === '\\') { r += src.slice(j, j + 2); j += 2; continue; }
      r += src[j]; j++;
    }
    return r;
  };
  // regexClose(p): the "/" that closes a regex body starting at p on this line, or -1. One backward pass (on the first attempt) makes every attempt O(1)
  // whatever the literal's length (no cap); the same rules as the admin lexer: no line break in a regex, a backslash before one ends it, "/" in [ ] does not close.
  let afterClass = null, inClassTbl = null;
  const regexClose = (p) => {
    if (afterClass === null) {
      afterClass = new Int32Array(n + 3).fill(-1); inClassTbl = new Int32Array(n + 3).fill(-1);
      for (let q = n - 1; q >= 0; q--) {
        const ch = src[q];
        if (LT(ch)) continue;
        if (ch === '\\') { const nx = src[q + 1]; if (nx !== undefined && !LT(nx)) { afterClass[q] = afterClass[q + 2]; inClassTbl[q] = inClassTbl[q + 2]; } continue; }
        afterClass[q] = ch === '/' ? q : ch === '[' ? inClassTbl[q + 1] : afterClass[q + 1];
        inClassTbl[q] = ch === ']' ? afterClass[q + 1] : inClassTbl[q + 1];
      }
    }
    return p < n ? afterClass[p] : -1;
  };
  const keepEsc = (s) => '"\'`\\$'.includes(s) || LT(s);
  const escape = () => { // inside a string or template, at a backslash
    const e = esc(i);
    if (e && !keepEsc(e[0])) { out.push(lit(e[0])); i = e[1]; return; }
    const adv = src[i + 1] === '\r' && src[i + 2] === '\n' ? 3 : 2;
    out.push(lit(src.slice(i, i + adv))); i += adv;
  };
  const template = () => { // after a backtick or the "}" that closes a ${...}
    while (i < n) {
      const c = src[i];
      if (c === '\\') { escape(); continue; }
      if (c === '`') { out.push(c); i++; regexOk = false; return; }
      if (c === '$' && src[i + 1] === '{') { out.push('${'); i += 2; braces.push('tpl'); regexOk = true; return; }
      out.push(lit(c)); i++;
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && !LT(src[i])) { out.push(' '); i++; } continue; }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2), stop = e < 0 ? n : e + 2;
      for (; i < stop; i++) out.push(LT(src[i]) ? src[i] : ' ');
      continue;
    }
    if (c === '"' || c === "'") {
      out.push(c); i++;
      while (i < n && src[i] !== c && src[i] !== '\n' && src[i] !== '\r') { if (src[i] === '\\') escape(); else { out.push(lit(src[i])); i++; } }
      if (src[i] === c) { out.push(c); i++; }
      regexOk = false; word = ''; afterDot = false; continue;
    }
    if (c === '`') { out.push(c); i++; template(); word = ''; afterDot = false; continue; }
    if (/\s/.test(c)) { out.push(c); i++; continue; }
    if (/[0-9]/.test(c)) { let j = i + 1; while (j < n && /[0-9a-zA-Z_.]/.test(src[j])) j++; out.push(src.slice(i, j)); i = j; regexOk = false; word = ''; afterDot = false; continue; }
    if (c === '\\' || IDP.test(String.fromCodePoint(src.codePointAt(i)))) { // identifier (with escapes)
      let w = '';
      while (i < n) {
        if (src[i] === '\\' && src[i + 1] === 'u') { const e = esc(i); if (!e) break; w += e[0]; i = e[1]; continue; }
        const ch = String.fromCodePoint(src.codePointAt(i));
        if (!IDP.test(ch)) break;
        w += ch; i += ch.length;
      }
      if (!w) { out.push(c); i++; continue; } // a lone backslash
      out.push(w);
      regexOk = !afterDot && KW.has(w); word = afterDot ? '' : w; afterDot = false; continue;
    }
    if (c === '/' && regexOk) {
      const close = regexClose(i + 1);
      let j = close + 1;
      const closed = close >= 0;
      if (closed) { j++; while (j < n && IDP.test(src[j])) j++; const sure = mask && (KW.has(word) || /^[(,=:\[!&|?;{]?$/.test(lastSig()));   // blank a regex literal only where it cannot be a division
      out.push(sure ? blank(src.slice(i, j)) : decodeRange(i, j)); i = j; regexOk = false; word = ''; afterDot = false; continue; }
    }
    if (c === '?' && src[i + 1] === '.' && !/[0-9]/.test(src[i + 2] || '')) { out.push('?.'); i += 2; regexOk = true; word = ''; afterDot = true; continue; }
    // punctuator
    if (c === '(') { parens.push(STMT.has(word)); regexOk = true; }
    else if (c === ')') { regexOk = Boolean(parens.pop()); }
    else if (c === ']') regexOk = false;
    else if (c === '{') { braces.push('{'); regexOk = true; }
    else if (c === '}') {
      if (braces.pop() === 'tpl') { out.push(c); i++; template(); word = ''; afterDot = false; continue; }
      regexOk = true; // a block end or an object end: a regex is read only if it closes on the line (see above)
    } else regexOk = true;
    afterDot = c === '.';
    word = '';
    out.push(c); i++;
  }
  return out.join('');
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
  const src = canonicalSource(readFileSync(f, 'utf8'));
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
      for (const n of ['connect-src', 'img-src', 'font-src', 'style-src', 'frame-src']) {
        const bad = (dirs.get(n) || []).filter((v) => /^(https?|wss?|ftp|blob|filesystem):?$/i.test(v) || v.includes('*') || (n !== 'img-src' && /^data:$/i.test(v)) || /^'unsafe-/.test(v));
        if (bad.length) errors.push(`CSP ${n} must list explicit origins only (found: ${bad.join(' ')}); declare the merchant's origins in merchant.headers.json`);
      }
      if (!dirs.has('connect-src')) errors.push('CSP lacks connect-src (it must pin the platform API origin)');
      if (!dirs.has('default-src')) errors.push('CSP lacks default-src');
      if (!dirs.has('form-action')) errors.push('CSP lacks form-action');
      else if ((dirs.get('form-action') || []).some((v) => /^\*$|^https?:$|^data:$/i.test(v))) errors.push('CSP form-action must list explicit hosts (no wildcard or bare scheme)');
    }
  }
  const html = String(indexHtml || '').replace(HTML_COMMENT, '');
  const inline = /<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(html) || /\son[a-z]+\s*=\s*["']/i.test(html);
  if (inline) (tpl ? errors : warnings).push('public/index.html has an inline <script> or an on*= handler: the strict CSP in public/_headers blocks it. Use an external file (see commerce/local-config.js); a merchant repo made from v0.1.0 must replace its inline localhost-override script with <script src="commerce/local-config.js"></script>');
  return { errors, warnings };
}
{
  const hp = path.join(PUB, '_headers'), ip = path.join(PUB, 'index.html');
  const r = checkCsp(existsSync(hp) ? readFileSync(hp, 'utf8') : null, existsSync(ip) ? readFileSync(ip, 'utf8') : '', isTemplate);
  r.errors.forEach(fail); warnings.push(...r.warnings);
}

/* ---------- 5e: public/_headers is DERIVED from the core template + the merchant's own origins (D20) ---------- */

{
  const allowPlaceholders = process.argv.includes('--allow-placeholders');
  const cfgPath = path.join(ROOT, CONFIG_FILE);
  let cfg = null;
  if (!existsSync(cfgPath)) fail(`${CONFIG_FILE} is missing: it holds the merchant's own API / image origins for the storefront CSP (copy it from the template checkout, set apiOrigin and imageOrigin, then run \`node <template checkout>/scripts/render-headers.mjs --root . --core <template checkout>/scripts/headers.core.txt\`; see docs/CORE-CHANGELOG.md v0.5.0 MIGRATION and docs/DECISIONS.md D20)`);
  else {
    try { cfg = parseConfigText(readFileSync(cfgPath, 'utf8')); } catch (e) { fail(`${CONFIG_FILE} is not valid JSON: ${e.message}`); }
  }
  if (cfg) {
    const v = validateConfig(cfg);
    v.errors.forEach(fail);
    if (v.placeholders.length) {
      const msg = `${CONFIG_FILE} still holds template placeholders (${v.placeholders.join(', ')}): set the real origins (a human edit), then run \`node scripts/render-headers.mjs\``;
      if (isTemplate || allowPlaceholders) warnings.push(msg); else fail(msg);
    }
    if (!v.errors.length) {
      try {
        const { text } = renderForRoot(ROOT);
        const hp = path.join(PUB, '_headers');
        const cur = existsSync(hp) ? readFileSync(hp, 'utf8').replace(/\r\n/g, '\n') : null;
        if (cur !== text) fail(`${OUT_FILE} is not the rendering of scripts/headers.core.txt + ${CONFIG_FILE} (hand edit or stale file): run \`node scripts/render-headers.mjs\` and commit the result`);
      } catch (e) { fail('cannot render ' + OUT_FILE + ': ' + e.message); }
      // the config must agree with config.js: the API origin the storefront really calls has to be allowed by connect-src
      const cj = canonicalSource(readFileSync(path.join(PUB, 'config.js'), 'utf8'));   // comments blanked: the header shows an example apiBase
      const m = /\bapiBase\s*:\s*(['"])(.*?)\1/.exec(cj);
      if (m && !/REPLACE_WITH_/.test(m[2])) {
        let o = null; try { o = new URL(m[2]).origin; } catch { /* not a URL */ }
        const allowed = [cfg.apiOrigin, ...(cfg.extraConnect || [])];
        if (!o) fail(`public/config.js apiBase is not a URL: ${m[2]}`);
        else if (!allowed.includes(o)) (isTemplate ? warnings : errors).push(`public/config.js apiBase origin ${o} is not allowed by ${CONFIG_FILE} (apiOrigin / extraConnect): the browser would block every API call`);
      }
    }
  }
}

/* ---------- 5b: script load order in index.html (content-allowlist.js and content.js before the design layer) ---------- */

{
  const ip = path.join(PUB, 'index.html');
  if (existsSync(ip)) {
    const srcs = [...readFileSync(ip, 'utf8').replace(HTML_COMMENT, '').matchAll(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
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
  const src = canonicalSource(readFileSync(f, 'utf8'));
  if (/\b(eval|Function)\s*\(|\bdocument\.write(ln)?\s*\(|\bcreateContextualFragment\b/.test(src)) fail(`${rel(f)}: eval / new Function / document.write / createContextualFragment are forbidden in the design layer`);
  if (/(innerHTML|outerHTML)\s*[+]?=[^;\n]*\bcontent\.(get|all)\(|insertAdjacentHTML\([^;\n]*\bcontent\.(get|all)\(/.test(src)) fail(`${rel(f)}: content values must not be assigned to innerHTML; use ShopCommerce.content.text/richText/link/image or esc()`);
}

/* ---------- 5d: no dialogs, popovers, fullscreen or synthetic input in the design layer (D12, v0.4.2) ---------- */

// The storefront design layer builds its screens as strings and uses querySelector / closest on its own #app (its event
// delegation depends on them), so DOM traversal is NOT scanned here (the admin scan, which has an own-element rule, does).
// What no storefront screen needs: the dialog tag, the popover / inert attributes, the dialog / popover / fullscreen /
// pointer-lock methods, and programmatic clicks, events or submits. Comments are stripped; strings are scanned on purpose.
// A tag carrying one of the attributes below (a "<" ... ">" run). Linear: a "<" inside an unfinished tag starts nothing new, so a line of
// 200k "<" costs one pass (the regex <[^>]*\s(...) it replaces rescanned to the end of the line from every "<").
function tagHasDesignAttr(text) {
  const re = /^<[^>]*\s(popover|inert|popovertarget|popovertargetaction|commandfor|command)(\s|=|>|\/)/i;
  let pos = 0;
  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    if (lt < 0) return false;
    const gt = text.indexOf('>', lt);
    if (re.test(gt < 0 ? text.slice(lt) : text.slice(lt, gt + 1))) return true;
    if (gt < 0) return false;
    pos = gt + 1;
  }
  return false;
}
const D12_RULES = [
  [/\b(showModal|showPopover|hidePopover|togglePopover|requestFullscreen|requestPointerLock|exitFullscreen|exitPointerLock)\b/, 'dialog/popover/fullscreen/pointer-lock API (D12)'],
  [/<\s*dialog\b|createElement\(\s*['"]dialog['"]/i, 'the dialog tag (D12)'],
  // attribute / property forms only (a tag attribute, .popover, { popover: ... }, setAttribute('popover')), not the word inside copy text
  [{ test: (ln) => tagHasDesignAttr(ln) || /\.\s*(popover|inert|popoverTargetElement)\b|['"]?\b(popover|inert|popovertarget|popoverTargetElement)['"]?\s*:|setAttribute\(\s*['"](popover|inert|popovertarget|commandfor)/i.test(ln) }, 'the popover / inert attribute (D12)'],
  [/\.\s*(click|submit|requestSubmit|dispatchEvent)\s*\(/, 'programmatic click / submit / dispatchEvent (D12)', true],
  [/\bnew\s+(Mouse|Keyboard|Pointer|Input|Focus|Touch|Wheel|Custom|UI|Submit)?Event\b/, 'constructing a synthetic event (D12)', true],
  [/confirm-(yes|no|ok|cancel|warning|detail)\b/i, 'a core confirmation control id (D12)']
];
for (const f of designFiles) {
  // comments blanked with their newlines kept and escapes decoded (canonicalSource), so the reported line numbers are the real ones.
  // The call and constructor rules are matched on the whole text (x.click\n() and new\nMouseEvent are the same code as on one line); the
  // attribute rules stay per line (their [^>]* would otherwise run across unrelated lines).
  const text = canonicalSource(readFileSync(f, 'utf8')), lines = text.split('\n');
  for (const [re, label, whole] of D12_RULES) {
    if (whole) { const m = re.exec(text); if (m) fail(`${rel(f)}:${text.slice(0, m.index).split('\n').length}: forbidden in design layer: ${label}`); }
    else lines.forEach((ln, i) => { if (re.test(ln)) fail(`${rel(f)}:${i + 1}: forbidden in design layer: ${label}`); });
  }
}

/* ---------- 5f: storefront network egress scan (D20, v0.5.0) ---------- */

// The strict CSP (connect-src pinned to the merchant's API origin, 5e) is the real fence; this scan is the cheap early warning that a design
// change tried to talk to the network itself. The design layer never needs any of these: every request goes through ShopCommerce.
// Works on the canonical source (D17) in three views: MASKED (comments, string and template text and regex literals blanked: identifiers only),
// REGEX-MASKED (strings kept, regex literals blanked: exact string values) and the plain canonical text (string values for the navigation rule).
//  * identifiers fetch, sendBeacon, WebSocket, EventSource, XMLHttpRequest: refused when used bare ((0, fetch)(x), var f = fetch, fetch(x)), and as a
//    property ONLY when the receiver is a global object (window, globalThis, self, top, parent, frames, navigator): window.fetch, self?.fetch,
//    (window).fetch, navigator.sendBeacon. A property of anything else (o.fetch, api?.fetch), an object key ({ fetch: 1 }, { "fetch": 1 }),
//    a case label, and a destructuring from a non-global object (const { fetch: f } = api) are data, not a reference. const { fetch: f } = window is refused.
//  * exact string values, after joining 'fe' + 'tch': window['fetch'], self["sendBeacon"], Reflect.get(window, 'fetch') (escapes are decoded by canonicalSource);
//  * new Image / Audio / Worker / SharedWorker (also new window.Image), RTCPeerConnection, navigator.serviceWorker, window.open / window?.open / (window).open /
//    a bare open(...) call (unless a function open is declared), open / location / history destructured, aliased or read by string out of a global object (D23), dynamic import() / import.meta, createElement of script / link / iframe / meta / object / embed / base, an a/area ping attribute;
//  * aliasing a global object (const w = window; g = globalThis; ...): the alias creation is refused, because everything after it is invisible to a lexical scan;
//  * navigation: location = ..., location.href = ..., location.assign(...) / replace(...) (also window. / document. / top. prefixed) unless every string literal
//    in the target starts with '#' (an in-page hash route, which the storefront uses).
// NOT detected (residual, the CSP is the fence): a global reached through a function result or a parameter ((function (w) {...})(window)), computed names built from
// non-literals, a.b.c chains such as document.defaultView.fetch, <meta http-equiv=refresh> or <a href> built as text, bracket access whose name is built from a non-literal.
// Core files (public/commerce/**, config.js) are not design files and are exempt, exactly as for the rules above.
const NET_NAMES = 'fetch|sendBeacon|WebSocket|EventSource|XMLHttpRequest';
const GLOBAL_OBJECTS = new Set(['window', 'globalThis', 'self', 'top', 'parent', 'frames']);
const NET_RECEIVERS = new Set([...GLOBAL_OBJECTS, 'navigator']);
const GLOBAL_RE = 'window|globalThis|self|top|parent|frames';
function joinStringConcats(text) { // 'a' + 'b' -> 'ab' (repeated; each pass shortens the text, so it ends)
  const re = new RegExp(String.raw`(["'\x60])((?:[^"'\x60\\\r\n]|\\.)*)\1\s*\+\s*(["'\x60])((?:[^"'\x60\\\r\n]|\\.)*)\3`, 'g');
  for (let k = 0; k < 64; k++) {
    const next = text.replace(re, (m, q, a, q2, b) => q + a + b + q);
    if (next === text) break;
    text = next;
  }
  return text;
}
// the closer that ends the bracket group which contains position i (scanning forward), or -1
function groupEnd(s, i, limit = 4000) {
  let d = 0;
  for (let k = i; k < s.length && k < i + limit; k++) {
    const c = s[k];
    if (c === '{' || c === '[' || c === '(') d++;
    else if (c === '}' || c === ']' || c === ')') { if (d === 0) return k; d--; }
  }
  return -1;
}
// For a name sitting in a key position ({ name: v }, { name }, { "name": v }): 'literal' (object data), or 'pattern' + the identifier on the right of the
// `=` ({ name: f } = window), so that only a pattern taken from a global object counts as a reference.
function keyContext(text, end) {
  const close = groupEnd(text, end);
  const rest = close >= 0 ? text.slice(close + 1, close + 160) : '';
  const pm = /^\s*=(?![=>])\s*\(?\s*([\w$]+)/.exec(rest);
  return pm ? { pattern: true, from: pm[1] } : { pattern: false };
}
// an argument or assignment value: the text from `from` to the end of the call (')') or the statement (';' or a line break)
function valueText(s, from, call) {
  if (call) { const e = groupEnd(s, from); return s.slice(from, e < 0 ? from + 300 : e); }
  const m = /[;\r\n]/.exec(s.slice(from, from + 400));
  return s.slice(from, m ? from + m.index : from + 400);
}
// Names the file itself declares (variables, destructured names, functions, classes, parameters, catch bindings, arrow parameters): a local
// "parent", "top" or "self" is not the browser global (for "open" only a function declaration counts, D23). Conservative: any declaration anywhere in the file exempts the name in the whole file.
function declaredNames(masked) {
  const names = new Set();
  const add = (s) => { for (const m of String(s).matchAll(/[\w$]+/g)) names.add(m[0]); };
  for (const m of masked.matchAll(/(?<![\w$.])(?:var|let|const|function\*?|class)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of masked.matchAll(/(?<![\w$.])(?:var|let|const)\s*[{\[]([^}\]]*)[}\]]/g)) add(m[1]);
  for (const m of masked.matchAll(/(?<![\w$.])(?:var|let|const)\s+[\w$]+\s*=[^;\n]*?,\s*([\w$]+)\s*=(?!=)/g)) names.add(m[1]);
  for (const m of masked.matchAll(/(?<![\w$.])function\*?\s*[\w$]*\s*\(([^)]*)\)/g)) add(m[1]);
  for (const m of masked.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1]);
  for (const m of masked.matchAll(/(?<![\w$.])([\w$]+)\s*=>/g)) names.add(m[1]);
  for (const m of masked.matchAll(/(?<![\w$.])catch\s*\(\s*([\w$]+)/g)) names.add(m[1]);
  // method parameters (D23: not the head of an if / for / while / switch / with block, whose condition would otherwise "declare" every name written in it)
  for (const m of masked.matchAll(/(?<![\w$.])(?!(?:if|for|while|switch|catch|with|return|typeof|else|do|function|await|yield|void|delete|new|throw|case)(?![\w$]))(?:async\s+|static\s+|get\s+|set\s+)*[\w$]+\s*\(([^()]*)\)\s*\{/g)) add(m[1]);
  return names;
}
function storefrontNetworkFindings(source) {
  const found = [];
  const masked = canonicalSource(source, 1);
  const withStrings = canonicalSource(source, 2);
  const plain = canonicalSource(source);
  const idRe = new RegExp(String.raw`(?<![\w$])(` + NET_NAMES + String.raw`)(?![\w$])`, 'g');
  const why = 'network access; every request goes through ShopCommerce';
  const declared = declaredNames(masked);
  for (const m of masked.matchAll(idRe)) {
    const idx = m.index, end = idx + m[0].length, name = m[1];
    const before = masked.slice(Math.max(0, idx - 80), idx);
    const after = masked.slice(end, end + 80);
    if (/(?:\?\.|\.)\s*$/.test(before) && !/\.\.\.\s*$/.test(before)) { // a property: only on a global receiver
      const r = /([\w$]+)\s*\)?\s*(?:\?\.|\.)\s*$/.exec(before);
      if (r && NET_RECEIVERS.has(r[1])) found.push([idx, `${r[1]}.${name} (${why})`]);
      continue;
    }
    const bt = before.trimEnd();
    if (/[{,]$/.test(bt) && /^\s*(?::(?!:)|[,}])/.test(after)) {      // an object key or a destructuring name
      const ctx = keyContext(masked, end);
      const keyed = /^\s*:/.test(after);
      if (ctx.pattern) { if (GLOBAL_OBJECTS.has(ctx.from)) found.push([idx, `${name} taken from ${ctx.from} (${why})`]); continue; }
      if (keyed) continue;                                              // { fetch: 1 }: data
    }
    found.push([idx, `${name} (${why})`]);
  }
  const strRe = new RegExp(String.raw`(["'\x60])(` + NET_NAMES + String.raw`)\1`, 'g');
  const joined = joinStringConcats(withStrings);
  for (const m of joined.matchAll(strRe)) {
    const idx = m.index, end = idx + m[0].length;
    const bt = joined.slice(Math.max(0, idx - 80), idx).trimEnd(), after = joined.slice(end, end + 80);
    if (/^\s*:(?!:)/.test(after) && /\bcase$/.test(bt)) continue;       // case "fetch":
    if (/[{,]$/.test(bt) && /^\s*(?::(?!:)|[,}])/.test(after)) {         // { "fetch": 1 } / const { "fetch": f } = api
      const ctx = keyContext(joined, end);
      if (ctx.pattern) { if (GLOBAL_OBJECTS.has(ctx.from)) found.push([idx, `the string "${m[2]}" taken from ${ctx.from}`]); continue; }
      if (/^\s*:/.test(after)) continue;
    }
    found.push([idx, `the string "${m[2]}" (a computed property name for a network API)`]);
  }
  const rules = [
    [new RegExp(String.raw`(?<![\w$.])new\s+(?:\(?\s*(?:` + GLOBAL_RE + String.raw`)\s*\)?\s*\.\s*)?(?:Image|Audio|Worker|SharedWorker)\b`), 'new Image / Audio / Worker (a script-created element or worker is a request to any allowed origin)'],
    [/(?<![\w$])(?:RTCPeerConnection|webkitRTCPeerConnection)\b/, 'RTCPeerConnection (WebRTC is not limited by connect-src)'],
    [/(?<![\w$])navigator\s*(?:\?\.|\.)\s*serviceWorker\b/, 'navigator.serviceWorker'],
    [new RegExp(String.raw`(?<![\w$])(?:` + GLOBAL_RE + String.raw`)\s*\)?\s*(?:\?\.|\.)\s*open\b`), 'window.open'],
    [/(?<![\w$.])import\s*\(|(?<![\w$.])import\s*\.\s*meta\b/, 'dynamic import() / import.meta'],
  ];
  for (const [re, label] of rules) { const m = re.exec(masked); if (m) found.push([m.index, label]); }
  // aliasing a global object (const w = window): refused unless the name on the right is declared in this file (a local "parent", "top" or "self")
  const aliasRe = new RegExp('(?<![\\w$.])[\\w$]+\\s*=(?!=)\\s*\\(?\\s*(' + GLOBAL_RE + ')\\s*\\)?\\s*(?:[;,)\\r\\n]|$)', 'gm');
  for (const m of masked.matchAll(aliasRe)) if (!declared.has(m[1])) { found.push([m.index, 'aliasing a global object (const w = window): the alias hides every later use from a lexical scan']); break; }
  // a bare open(...) call is window.open, unless this file declares a genuine FUNCTION named open (function open() {...}) or the call is a method
  // definition ({ open() { ... } }). D23: a variable, parameter, destructured or arrow-valued binding named open no longer exempts the file
  // (const open = window['op' + 'en'] used to).
  if (!/(?<![\w$.])function\*?\s+open\s*\(/.test(masked)) {
    for (const m of masked.matchAll(/(?<![\w$.])open\s*\(/g)) {
      const close = groupEnd(masked, m.index + m[0].length);
      if (close >= 0 && /^\s*\{/.test(masked.slice(close + 1, close + 40))) continue;   // method definition
      found.push([m.index, 'a bare open(...) call (window.open)']); break;
    }
  }
  // D23: open / location / history taken OUT of a global object. Destructuring ({ open } = window, { open: o, ...rest } = self, { ["op" + "en"]: o } = top),
  // an alias of window.location / window.history / location / history, and a bracket or Reflect.get access with the exact string.
  const joinedStr = joinStringConcats(withStrings);
  const KEYS = 'open|location|history';
  const patternRe = new RegExp(String.raw`(?<![\w$.])(?:${KEYS})(?![\w$])|["'\x60](?:${KEYS})["'\x60]|\[|\.\.\.`);
  const destructRe = new RegExp(String.raw`\}\s*=(?!=)\s*\(?\s*(${GLOBAL_RE})\s*\)?\s*(?:[;,)\r\n]|$)`, 'g');
  for (const m of joinedStr.matchAll(destructRe)) {
    if (declared.has(m[1])) continue;
    let d = 0, k = m.index;
    for (; k >= 0 && m.index - k < 2000; k--) { const c = joinedStr[k]; if (c === '}') d++; else if (c === '{') { d--; if (d === 0) break; } }
    const pattern = k >= 0 && d === 0 ? joinedStr.slice(k, m.index + 1) : '';
    if (patternRe.test(pattern)) { found.push([m.index, `destructuring open / location / history (or a computed or rest pattern) out of ${m[1]} (use the property directly)`]); break; }
  }
  const aliasKeyRe = new RegExp(String.raw`(?<![\w$.])[\w$]+\s*=(?!=)\s*\(?\s*(?:(?:${GLOBAL_RE}|document)\s*\)?\s*(?:\?\.|\.)\s*)?(location|history)\s*\)?\s*(?:[;,)\r\n]|$)`, 'gm');
  for (const m of masked.matchAll(aliasKeyRe)) {
    if (declared.has(m[1]) && !/(?:window|globalThis|self|top|parent|frames|document)\s*\)?\s*(?:\?\.|\.)/.test(m[0])) continue;
    found.push([m.index, `aliasing ${m[1]} (const l = window.${m[1]}): the alias hides every later use from a lexical scan`]); break;
  }
  const brRe = new RegExp(String.raw`(?<![\w$.])(?:${GLOBAL_RE})\s*\)?\s*(?:\?\.)?\s*\[\s*(["'\x60])(?:${KEYS})\1\s*\]|(?<![\w$.])Reflect\s*\.\s*get\s*\(\s*(?:${GLOBAL_RE})\s*,\s*(["'\x60])(?:${KEYS})\2`, 'g');
  for (const m of joinedStr.matchAll(brRe)) { found.push([m.index, 'window["open"] / ["location"] / ["history"] (computed access to a navigation API)']); break; }
  const textRules = [
    [/\bcreateElement\s*\(\s*(["'`])(?:script|link|iframe|meta|object|embed|base)\1/i, 'createElement of script / link / iframe / meta / object / embed / base'],
    [/<(?:a|area)\b[^>]*\sping\s*=|setAttribute\(\s*["']ping["']/i, 'the ping attribute (a request to any origin when the link is followed)'],
    [/\[\s*(["'`])serviceWorker\1\s*\]/, "navigator['serviceWorker']"]
  ];
  for (const [re, label] of textRules) { const m = re.exec(withStrings); if (m) found.push([m.index, label]); }
  // an element's .ping = ... (the anchor attribute); custom data on a dataset / style / props / state / data / options object is not
  for (const m of withStrings.matchAll(/(?<![\w$])([\w$]+)\s*\.\s*ping\s*=(?!=)/g)) {
    if (!/^(dataset|style|props|state|data|options|opts|config|settings)$/.test(m[1])) { found.push([m.index, 'the ping attribute (a request to any origin when the link is followed)']); break; }
  }
  // navigation: a location write or assign / replace whose target is not an in-page hash route
  const navRe = new RegExp(String.raw`(?<![\w$.])(?:(?:window|self|top|parent|document|globalThis)\s*\.\s*)?location\s*(?:=(?!=)|\.\s*(?:href|assign|replace)\s*(?:=(?!=)|\())`, 'g');
  for (const m of plain.matchAll(navRe)) {
    const call = m[0].endsWith('(');
    const target = valueText(plain, m.index + m[0].length, call);
    const lits = [...target.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((x) => x[2]);
    if (!(lits.length && lits.every((x) => x.startsWith('#')))) found.push([m.index, 'navigation: a location assignment / assign / replace whose target is not an in-page "#..." route']);
  }
  return found.sort((a, b) => a[0] - b[0]);
}
for (const f of designFiles) {
  const raw = readFileSync(f, 'utf8');
  const seen = new Set();
  for (const [idx, label] of storefrontNetworkFindings(raw)) {
    if (seen.has(label)) continue; seen.add(label);
    fail(`${rel(f)}: forbidden in design layer (storefront network scan, D20): ${label}`);
  }
}

/* ---------- 6: hash manifest ---------- */

const locked = [...walk(path.join(PUB, 'commerce')), path.join(PUB, 'config.js')].sort();   // public/_headers is DERIVED (5e), not hashed
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
      if (f === 'public/_headers') continue;   // manifests written before v0.5.0 carry a hash of it; 5e verifies the file now
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
