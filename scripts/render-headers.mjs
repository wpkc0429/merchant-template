#!/usr/bin/env node
/* ============================================================
   render-headers.mjs: renders public/_headers (Cloudflare reads it from the assets directory) from
     scripts/headers.core.txt   the CORE template (locked, synced by sync-core, identical in every repo), and
     merchant.headers.json      the MERCHANT's own origins (human-owned: never touched by a sync, never by an AI session).
   No dependencies (Node 18+). Decision D20 (docs/DECISIONS.md).

     node scripts/render-headers.mjs             write public/_headers
     node scripts/render-headers.mjs --check     exit 1 when public/_headers differs from the rendering
     node scripts/render-headers.mjs --print     print the rendering
     options: --root <dir>  repo root (default: this repo)   --core <file>  core template (default: <root>/scripts/headers.core.txt)

   merchant.headers.json (strict; unknown keys are refused):
     {
       "apiOrigin":    "https://api.<platform-domain>",      required: the platform API (connect-src)
       "imageOrigin":  "https://images.<platform-domain>",   required: product photos (img-src)
       "extraConnect": [],  "extraImg": [],  "extraFont": [],  "extraStyle": [],  "extraFrame": []   optional, https origins
     }
   Every value is a bare https origin (https://host[:port], lower case, no path, query, userinfo, wildcard or IP address).
   No http:, no localhost (a dev server passes dev:true to the renderer in code; the config file never may), at most 5
   (connect, img) or 3 (font, style, frame) extras. script-src stays 'self' and form-action stays 'self' + the two ECPay hosts:
   neither can be configured.

   Rendered:  connect-src 'self' <apiOrigin> <extraConnect>      img-src 'self' data: <imageOrigin> <extraImg>
              font-src 'self' <extraFont>   style-src 'self' <extraStyle>   frame-src 'none' | <extraFrame>
   ============================================================ */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_FILE = 'merchant.headers.json';
export const CORE_FILE = 'scripts/headers.core.txt';
export const OUT_FILE = 'public/_headers';

const SINGLE = ['apiOrigin', 'imageOrigin'];
const LISTS = { extraConnect: 5, extraImg: 5, extraFont: 3, extraStyle: 3, extraFrame: 3 };
const KEYS = new Set([...SINGLE, ...Object.keys(LISTS), '_comment']);
const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Why `v` is not an acceptable origin, or '' when it is. dev:true additionally accepts http://localhost and http://127.0.0.1[:port]. */
export function originProblem(v, { dev = false } = {}) {
  if (typeof v !== 'string' || !v) return 'must be a non-empty string';
  if (v.length > 200 || /[\s\u0000-\u001f"'`;,\\<>]/.test(v)) return 'contains forbidden characters';
  if (v.includes('*')) return 'wildcards are not allowed';
  let u;
  try { u = new URL(v); } catch { return 'is not an absolute URL'; }
  if (dev && u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname) && u.origin === v) return '';
  if (u.protocol !== 'https:') return 'must be an https origin';
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return 'must be a bare origin (no path, query, fragment or userinfo)';
  if (u.origin !== v) return `must be written exactly as ${u.origin} (lower case, no trailing slash, no default port)`;
  if (!HOST.test(u.hostname)) return 'needs a domain name with a letter-only top-level domain (no IP address, no single-label host)';
  return '';
}

/** Placeholders from the template are recognisable by name. */
export const isPlaceholder = (v) => typeof v === 'string' && /replace-with/i.test(v);

/** Validates a parsed merchant.headers.json. Returns { errors: [...], placeholders: [...] } */
export function validateConfig(cfg, opts = {}) {
  const errors = [], placeholders = [];
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { errors: [`${CONFIG_FILE} must be a JSON object`], placeholders };
  for (const k of Object.keys(cfg)) if (!KEYS.has(k)) errors.push(`${CONFIG_FILE}: unknown key "${k}" (allowed: ${[...KEYS].filter((x) => x !== '_comment').join(', ')})`);
  if ('_comment' in cfg && (typeof cfg._comment !== 'string' || cfg._comment.length > 600)) errors.push(`${CONFIG_FILE}: _comment must be a string of at most 600 characters`);
  const seen = new Set();
  const check = (key, v) => {
    const p = originProblem(v, opts);
    if (p) errors.push(`${CONFIG_FILE}: ${key} ${JSON.stringify(typeof v === 'string' ? v.slice(0, 80) : v)} ${p}`);
    else if (isPlaceholder(v)) placeholders.push(`${key} ${v}`);
    else if (seen.has(`${key}|${v}`)) errors.push(`${CONFIG_FILE}: ${key} lists ${v} twice`);
    seen.add(`${key}|${v}`);
  };
  for (const k of SINGLE) { if (!(k in cfg)) errors.push(`${CONFIG_FILE}: ${k} is required`); else check(k, cfg[k]); }
  for (const [k, max] of Object.entries(LISTS)) {
    if (!(k in cfg)) continue;
    if (!Array.isArray(cfg[k])) { errors.push(`${CONFIG_FILE}: ${k} must be an array`); continue; }
    if (cfg[k].length > max) errors.push(`${CONFIG_FILE}: ${k} has ${cfg[k].length} entries (at most ${max})`);
    cfg[k].forEach((v) => check(k, v));
  }
  return { errors, placeholders };
}

const uniq = (a) => [...new Set(a)];
/** The directive values for a VALID config. */
export function directives(cfg) {
  const x = (k) => (Array.isArray(cfg[k]) ? cfg[k] : []);
  return {
    STYLE_SRC: uniq(["'self'", ...x('extraStyle')]).join(' '),
    IMG_SRC: uniq(["'self'", 'data:', cfg.imageOrigin, ...x('extraImg')]).join(' '),
    FONT_SRC: uniq(["'self'", ...x('extraFont')]).join(' '),
    CONNECT_SRC: uniq(["'self'", cfg.apiOrigin, ...x('extraConnect')]).join(' '),
    FRAME_SRC: x('extraFrame').length ? uniq(x('extraFrame')).join(' ') : "'none'"
  };
}

/** Pure: core template text + parsed config -> the exact text of public/_headers (LF line endings). Throws on an invalid config. */
export function renderHeaders(coreText, cfg, opts = {}) {
  const v = validateConfig(cfg, opts);
  if (v.errors.length) throw new Error(v.errors.join('\n'));
  const d = directives(cfg);
  const core = String(coreText).replace(/\r\n/g, '\n');
  const used = new Set();
  const out = core.replace(/\{\{([A-Z_]+)\}\}/g, (m, n) => { if (!(n in d)) throw new Error(`unknown token ${m} in ${CORE_FILE}`); used.add(n); return d[n]; });
  for (const n of Object.keys(d)) if (!used.has(n)) throw new Error(`${CORE_FILE} does not use the token {{${n}}}`);
  return out;
}

/** Reads <root>/merchant.headers.json and the core template; returns { text, cfg, placeholders } or throws. */
export function renderForRoot(root, { core, dev = false } = {}) {
  const cf = path.join(root, CONFIG_FILE);
  if (!existsSync(cf)) throw new Error(`${CONFIG_FILE} is missing (the merchant's own origins; copy it from the template and fill it in, see docs/DECISIONS.md D20)`);
  let cfg;
  try { cfg = JSON.parse(readFileSync(cf, 'utf8')); } catch (e) { throw new Error(`${CONFIG_FILE} is not valid JSON: ${e.message}`); }
  const corePath = core || path.join(root, CORE_FILE);
  if (!existsSync(corePath)) throw new Error(`${path.relative(root, corePath) || corePath} is missing`);
  const text = renderHeaders(readFileSync(corePath, 'utf8'), cfg, { dev });
  return { text, cfg, placeholders: validateConfig(cfg, { dev }).placeholders };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const root = path.resolve(val('--root') || path.join(HERE, '..'));
  try {
    const { text, placeholders } = renderForRoot(root, { core: val('--core') ? path.resolve(val('--core')) : undefined });
    const outFile = path.join(root, OUT_FILE);
    if (argv.includes('--print')) process.stdout.write(text);
    else if (argv.includes('--check')) {
      const cur = existsSync(outFile) ? readFileSync(outFile, 'utf8').replace(/\r\n/g, '\n') : null;
      if (cur !== text) { console.error(`${OUT_FILE} is ${cur === null ? 'missing' : 'stale'}: run  node scripts/render-headers.mjs`); process.exit(1); }
      console.log(`ok  ${OUT_FILE} matches the rendering`);
    } else {
      writeFileSync(outFile, text);
      console.log(`wrote ${OUT_FILE}`);
    }
    if (placeholders.length) console.warn(`warning: ${CONFIG_FILE} still holds template placeholders: ${placeholders.join(', ')}`);
  } catch (e) { console.error('render-headers: ' + e.message); process.exit(1); }
}
