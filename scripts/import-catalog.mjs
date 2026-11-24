#!/usr/bin/env node
/* ============================================================
   import-catalog.mjs: generic, idempotent catalogue importer for a merchant shop.
   No dependencies (Node 18+, global fetch). Replaces the "fork the seed script" pattern.

     node scripts/import-catalog.mjs <catalog.json> [--dry-run] [--no-images]

   Input: a JSON file (format: catalog/catalog.sample.json) with
     shipping_methods[]   { name, carrier?, flat_rate, is_active? }                       matched by name
     categories[]         { slug, name, position?, parent? (slug) }                      matched by slug
     products[]           { slug, title, subtitle?, description?, status?, categories[] (slugs),
                            skus[] { sku_code, size | options{}, price_amount, stock_qty?, is_active?, currency? },
                            images[] (paths relative to the catalogue file) }              matched by slug / sku_code
     category_orders      { "<category slug>": ["<product slug>", ...] }                   manual order, e.g. new-arrivals
   Image files (png, jpg, webp) go through the REAL upload flow: presign -> PUT -> attach.
   An image already attached (same file name stored as its alt text) is skipped.
   CSV is not supported (JSON only).

   Credentials and the API base come ONLY from environment variables (never arguments or files):
     IMPORT_API_BASE        required for a real run, e.g. https://api.<platform-domain>
     IMPORT_ADMIN_EMAIL     required  merchant admin (or platform super admin) account
     IMPORT_ADMIN_PASSWORD  required
     IMPORT_SHOP_ID         default 1
     IMPORT_ORIGIN          optional  storefront origin to register (needs shop.manage_client_origins)
   Nothing is ever deleted: products absent from the file are left alone. SKUs of an existing product
   that are absent from the file are kept as they are (the platform's product PUT replaces the SKU list
   wholesale, so existing SKUs are always re-sent).

   --dry-run  validates the file and prints the plan. Without credentials it makes no network call at all;
              with credentials it logs in and READS the shop, and still writes nothing.
   --no-images  skip the image upload step.
   Exit: 0 ok, 1 failure, 2 usage / invalid input.
   ============================================================ */
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/* ---------------- validation (exported for tests) ---------------- */

export function validateCatalog(cat, baseDir) {
  const errs = [];
  const e = (m) => errs.push(m);
  const isInt = (n) => Number.isInteger(n) && n >= 0;
  if (!cat || typeof cat !== 'object' || Array.isArray(cat)) return ['the catalogue must be a JSON object'];
  const cats = cat.categories || [], prods = cat.products || [], ships = cat.shipping_methods || [];
  if (!Array.isArray(cats) || !Array.isArray(prods) || !Array.isArray(ships)) e('categories, products and shipping_methods must be arrays');
  if (errs.length) return errs;

  const catSlugs = new Set();
  cats.forEach((c, i) => {
    if (!c.slug || !SLUG_RE.test(c.slug)) e(`categories[${i}].slug "${c.slug}" must be lowercase letters, digits and hyphens`);
    if (!c.name) e(`categories[${i}] (${c.slug}) needs a name`);
    if (catSlugs.has(c.slug)) e(`duplicate category slug ${c.slug}`);
    catSlugs.add(c.slug);
  });
  cats.forEach((c) => { if (c.parent && !catSlugs.has(c.parent)) e(`category ${c.slug}: unknown parent ${c.parent}`); });

  const slugs = new Set(), codes = new Set();
  prods.forEach((p, i) => {
    const w = `products[${i}] (${p.slug})`;
    if (!p.slug || !SLUG_RE.test(p.slug)) e(`${w}: slug must be lowercase letters, digits and hyphens`);
    if (!p.title) e(`${w}: title is required`);
    if (slugs.has(p.slug)) e(`${w}: duplicate product slug`);
    slugs.add(p.slug);
    if (p.status !== undefined && ![0, 1].includes(p.status)) e(`${w}: status must be 0 (hidden) or 1 (published)`);
    for (const c of p.categories || []) if (!catSlugs.has(c)) e(`${w}: unknown category ${c}`);
    if (!Array.isArray(p.skus) || p.skus.length === 0) e(`${w}: at least one sku is required`);
    for (const s of p.skus || []) {
      if (!s.sku_code) e(`${w}: every sku needs a sku_code`);
      else if (codes.has(s.sku_code)) e(`${w}: duplicate sku_code ${s.sku_code}`);
      codes.add(s.sku_code);
      if (!isInt(s.price_amount)) e(`${w}: sku ${s.sku_code} price_amount must be a whole number >= 0`);
      if (s.stock_qty !== undefined && !isInt(s.stock_qty)) e(`${w}: sku ${s.sku_code} stock_qty must be a whole number >= 0`);
      if (!s.options && !s.size) e(`${w}: sku ${s.sku_code} needs "size" (or an "options" object); the storefront reads options.size`);
    }
    for (const f of p.images || []) {
      const abs = path.resolve(baseDir, f);
      if (!MIME[path.extname(f).toLowerCase()]) e(`${w}: image ${f} must be png, jpg or webp`);
      else if (!existsSync(abs)) e(`${w}: image file not found: ${f}`);
      else if (statSync(abs).size > MAX_IMAGE_BYTES) e(`${w}: image ${f} is larger than 10 MiB`);
    }
  });
  ships.forEach((s, i) => {
    if (!s.name) e(`shipping_methods[${i}] needs a name`);
    if (!isInt(s.flat_rate)) e(`shipping_methods[${i}] (${s.name}) flat_rate must be a whole number >= 0`);
  });
  for (const [c, list] of Object.entries(cat.category_orders || {})) {
    if (!catSlugs.has(c)) e(`category_orders: unknown category ${c}`);
    for (const s of list) if (!slugs.has(s)) e(`category_orders.${c}: unknown product ${s}`);
  }
  return errs;
}

/** Orders categories so parents come before children. */
export function sortCategories(cats) {
  const out = [], seen = new Set(), by = Object.fromEntries(cats.map((c) => [c.slug, c]));
  const visit = (c) => { if (seen.has(c.slug)) return; seen.add(c.slug); if (c.parent && by[c.parent]) visit(by[c.parent]); out.push(c); };
  cats.forEach(visit);
  return out;
}

/* ---------------- main ---------------- */

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry-run');
  const noImages = argv.includes('--no-images');
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node scripts/import-catalog.mjs <catalog.json> [--dry-run] [--no-images]\n(credentials: env IMPORT_API_BASE, IMPORT_ADMIN_EMAIL, IMPORT_ADMIN_PASSWORD)'); return 2; }
  let cat;
  try { cat = JSON.parse(readFileSync(file, 'utf8')); } catch (err) { console.error(`cannot read ${file}: ${err.message}`); return 2; }
  const baseDir = path.dirname(path.resolve(file));
  const errs = validateCatalog(cat, baseDir);
  if (errs.length) { console.error(`INVALID CATALOGUE (${errs.length}):`); errs.forEach((m) => console.error('  - ' + m)); return 2; }

  const cats = sortCategories(cat.categories || []), prods = cat.products || [], ships = cat.shipping_methods || [];
  console.log(`${dry ? '[dry-run] ' : ''}catalogue ok: ${cats.length} categories, ${prods.length} products, ${prods.reduce((n, p) => n + p.skus.length, 0)} skus, ${prods.reduce((n, p) => n + (p.images || []).length, 0)} images, ${ships.length} shipping methods`);

  const API = (process.env.IMPORT_API_BASE || '').replace(/\/+$/, '');
  const EMAIL = process.env.IMPORT_ADMIN_EMAIL, PASSWORD = process.env.IMPORT_ADMIN_PASSWORD;
  const SHOP = process.env.IMPORT_SHOP_ID || '1';
  if (!API || !EMAIL || !PASSWORD) {
    if (dry) { console.log('[dry-run] no credentials in the environment: validated only, no network call made'); return 0; }
    console.error('missing env: IMPORT_API_BASE, IMPORT_ADMIN_EMAIL and IMPORT_ADMIN_PASSWORD are required (never pass credentials as arguments)');
    return 2;
  }
  let token = '';
  const log = (...a) => console.log(dry ? '[dry-run]' : '', ...a);

  async function call(method, p, body, { write = method !== 'GET' } = {}) {
    if (dry && write) return null;
    const res = await fetch(API + p, {
      method,
      headers: Object.assign(token ? { Authorization: 'Bearer ' + token } : {}, body !== undefined ? { 'content-type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 300)}`);
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  }
  const shop = (p) => `/api/v1/admin/shops/${SHOP}${p}`;
  const flatten = (nodes, out = []) => { nodes.forEach((n) => { out.push(n); flatten(n.children || [], out); }); return out; };

  console.log(`target: ${new URL(API).host}, shop ${SHOP}`);
  const login = await call('POST', '/api/v1/admin/auth/login', { email: EMAIL, password: PASSWORD }, { write: false });
  token = login && login.access_token;
  if (!token) throw new Error('login returned no access_token');

  // categories
  const catBySlug = {};
  flatten((await call('GET', shop('/categories'))).categories).forEach((c) => { catBySlug[c.slug] = c; });
  for (let i = 0; i < cats.length; i++) {
    const c = cats[i], have = catBySlug[c.slug];
    if (have) {
      if (have.name !== c.name) { await call('PUT', shop('/categories/' + have.id), { name: c.name }); log('category updated:', c.slug); } else log('category unchanged:', c.slug);
    } else {
      const body = { name: c.name, slug: c.slug, position: c.position ?? i };
      if (c.parent && catBySlug[c.parent]) body.parent_id = catBySlug[c.parent].id;
      catBySlug[c.slug] = (await call('POST', shop('/categories'), body)) || { id: -1, slug: c.slug };
      log('category created:', c.slug);
    }
  }

  // products: existing ones are fully re-sent (the platform's PUT replaces the SKU list), matched by slug / sku_code
  const existing = {};
  for (let page = 1; ; page++) {
    const r = await call('GET', shop('/products?page_size=100&page=' + page));
    r.products.forEach((p) => { existing[p.slug] = p; });
    if (page * r.page_size >= r.total) break;
  }
  const productBySlug = {};
  for (const def of prods) {
    const prev = existing[def.slug];
    const skus = def.skus.map((s) => {
      const sku = { sku_code: s.sku_code, options: s.options || { size: s.size }, price_amount: s.price_amount, currency: s.currency || 'TWD', stock_qty: s.stock_qty ?? 0, is_active: s.is_active !== false };
      const old = prev && (prev.skus || []).find((x) => x.sku_code === s.sku_code);
      if (old) sku.id = old.id;
      return sku;
    });
    if (prev) for (const old of prev.skus || []) if (!skus.some((s) => s.sku_code === old.sku_code)) skus.push(old);   // never drop an existing SKU
    const body = { title: def.title, slug: def.slug, subtitle: def.subtitle || '', description: def.description || '', status: def.status ?? 1, category_ids: (def.categories || []).map((c) => catBySlug[c].id), skus };
    if (prev) { productBySlug[def.slug] = (await call('PUT', shop('/products/' + prev.id), body)) || prev; log('product updated:', def.slug); }
    else { productBySlug[def.slug] = (await call('POST', shop('/products'), body)) || { id: -1, images: [] }; log('product created:', def.slug); }
  }

  // manual category orders (must be an exact permutation of the category's direct members)
  for (const [slug, order] of Object.entries(cat.category_orders || {})) {
    const id = catBySlug[slug].id;
    if (id < 0) { log('category order skipped (category not created yet):', slug); continue; }
    const direct = await call('GET', shop(`/categories/${id}/product-order`));
    const have = direct.products.map((p) => p.product_id);
    const wanted = order.map((s) => productBySlug[s].id);
    const next = wanted.filter((x) => have.includes(x)).concat(have.filter((x) => !wanted.includes(x)));
    if (next.join() !== have.join()) { await call('PUT', shop(`/categories/${id}/product-order`), { product_ids: next }); log('category order set:', slug); } else log('category order unchanged:', slug);
  }

  // images through the real upload flow; skipped per file when already attached (alt = file name)
  if (noImages) log('images skipped (--no-images)');
  else {
    const cfg = await call('GET', '/api/v1/admin/media/config');
    if (!cfg.enabled) log('media storage is not enabled on this API: skipping images');
    else for (const def of prods) {
      const p = productBySlug[def.slug];
      const attached = (p.images || []).map((im) => im.alt);
      for (const f of def.images || []) {
        const name = path.basename(f);
        if (attached.includes(name)) { log('image already attached:', def.slug, name); continue; }
        if (dry) { log('would upload:', def.slug, name); continue; }
        const buf = await readFile(path.resolve(baseDir, f));
        const up = await call('POST', shop('/media/uploads'), { content_type: MIME[path.extname(f).toLowerCase()], size_bytes: buf.length, purpose: 'product_image' });
        const put = await fetch(up.upload_url, { method: 'PUT', headers: up.headers, body: buf });
        if (!put.ok) throw new Error('PUT upload failed ' + put.status);
        await call('POST', shop(`/products/${p.id}/images`), { upload_id: up.upload_id, alt: name });
        log('image attached:', def.slug, name);
      }
    }
  }

  // shipping methods (matched by name)
  const have = (await call('GET', shop('/shipping-methods'))).shipping_methods;
  for (const s of ships) {
    const old = have.find((x) => x.name === s.name);
    const body = Object.assign({ is_active: true }, s);
    if (old) await call('PUT', shop('/shipping-methods/' + old.id), body); else await call('POST', shop('/shipping-methods'), body);
    log(old ? 'shipping method updated:' : 'shipping method created:', s.name);
  }

  // optional storefront origin
  if (process.env.IMPORT_ORIGIN) {
    const o = await call('GET', shop('/allowed-origins'));
    if (o.origins.some((x) => x.origin === process.env.IMPORT_ORIGIN)) log('origin exists:', process.env.IMPORT_ORIGIN);
    else { await call('POST', shop('/allowed-origins'), { origin: process.env.IMPORT_ORIGIN, purpose: 'storefront' }); log('origin registered:', process.env.IMPORT_ORIGIN); }
  }
  console.log(dry ? '[dry-run] done, nothing was written' : 'done');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((c) => process.exit(c), (err) => { console.error(err.message); process.exit(1); });
}
