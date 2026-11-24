import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { TEMPLATE, tmp, cleanup, node, write } from './helpers.mjs';
import { validateCatalog, sortCategories } from '../scripts/import-catalog.mjs';

after(cleanup);

const SAMPLE = path.join(TEMPLATE, 'catalog', 'catalog.sample.json');
const sample = () => JSON.parse(readFileSync(SAMPLE, 'utf8'));

test('the sample catalogue is valid: 8 products, generic, includes new-arrivals, placeholder images exist', () => {
  const c = sample();
  assert.deepEqual(validateCatalog(c, path.dirname(SAMPLE)), []);
  assert.equal(c.products.length, 8);
  assert.ok(c.categories.some((x) => x.slug === 'new-arrivals'));
  assert.ok(c.shipping_methods.length >= 2);
  assert.ok(c.products.every((p) => p.title.includes('｜') && p.skus.length === 3 && p.images.length === 1));
});

test('validateCatalog catches the usual mistakes', () => {
  const base = path.dirname(SAMPLE);
  const mut = (fn) => { const c = sample(); fn(c); return validateCatalog(c, base).join('\n'); };
  assert.match(mut((c) => { c.products[1].slug = c.products[0].slug; }), /duplicate product slug/);
  assert.match(mut((c) => { c.products[0].skus[0].price_amount = 12.5; }), /price_amount must be a whole number/);
  assert.match(mut((c) => { c.products[0].skus[1].sku_code = c.products[0].skus[0].sku_code; }), /duplicate sku_code/);
  assert.match(mut((c) => { c.products[0].categories = ['nope']; }), /unknown category nope/);
  assert.match(mut((c) => { c.products[0].images = ['images/missing.png']; }), /image file not found/);
  assert.match(mut((c) => { c.products[0].images = ['images/product-01.gif']; }), /png, jpg or webp/);
  assert.match(mut((c) => { c.shipping_methods[0].flat_rate = -1; }), /flat_rate/);
  assert.match(mut((c) => { c.category_orders['new-arrivals'].push('ghost'); }), /unknown product ghost/);
  assert.match(mut((c) => { delete c.products[0].skus[0].size; }), /needs "size"/);
  assert.match(mut((c) => { c.products[0].slug = 'Bad Slug'; }), /slug must be/);
  assert.deepEqual(sortCategories([{ slug: 'b', parent: 'a' }, { slug: 'a' }]).map((x) => x.slug), ['a', 'b']);
});

test('CLI: --dry-run validates without credentials and makes no network call; a real run needs the env; bad file exits 2', () => {
  let r = node(['scripts/import-catalog.mjs', 'catalog/catalog.sample.json', '--dry-run'], TEMPLATE);
  assert.equal(r.status, 0, r.out); assert.match(r.out, /no network call made/);
  r = node(['scripts/import-catalog.mjs', 'catalog/catalog.sample.json'], TEMPLATE);
  assert.equal(r.status, 2); assert.match(r.out, /IMPORT_API_BASE/);
  // credentials are never read from arguments
  r = node(['scripts/import-catalog.mjs', 'catalog/catalog.sample.json', '--email', 'a@b.c', '--password', 'x', '--api-base', 'http://127.0.0.1:1'], TEMPLATE);
  assert.equal(r.status, 2);
  const bad = path.join(tmp(), 'bad.json'); write(path.dirname(bad), 'bad.json', '{"products":[{"slug":"X"}]}');
  r = node(['scripts/import-catalog.mjs', bad, '--dry-run'], TEMPLATE);
  assert.equal(r.status, 2); assert.match(r.out, /INVALID CATALOGUE/);
});

/** A tiny in-memory stand-in for the platform endpoints the importer uses. */
function mockPlatform() {
  const db = { cats: [], prods: [], ships: [], origins: [], orders: {}, uploads: {}, nextId: 1, calls: [], puts: 0, log: [] };
  const id = () => db.nextId++;
  const tree = () => db.cats.map((c) => ({ ...c, children: [] }));
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      const p = url.pathname.replace('/api/v1/admin', '');
      const body = raw.length && req.headers['content-type'] === 'application/json' ? JSON.parse(raw) : null;
      db.calls.push(`${req.method} ${p}`);
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      const m = (re) => re.exec(p);
      let x;
      if (req.method === 'POST' && p === '/auth/login') return send(200, { access_token: 'tok' });
      if (req.headers.authorization !== 'Bearer tok' && !p.startsWith('/__upload')) return send(401, { error: 'no' });
      if (req.method === 'GET' && p === '/shops/1/categories') return send(200, { categories: tree() });
      if (req.method === 'POST' && p === '/shops/1/categories') { const c = { id: id(), ...body, parent_id: body.parent_id ?? null }; db.cats.push(c); return send(201, c); }
      if ((x = m(/^\/shops\/1\/categories\/(\d+)$/)) && req.method === 'PUT') { Object.assign(db.cats.find((c) => c.id === +x[1]), body); return send(200, {}); }
      if (req.method === 'GET' && p === '/shops/1/products') return send(200, { products: db.prods, page: 1, page_size: 100, total: db.prods.length });
      if (req.method === 'POST' && p === '/shops/1/products') {
        const prod = { id: id(), ...body, images: [], skus: body.skus.map((s) => ({ ...s, id: id() })) };
        db.prods.push(prod); return send(201, prod);
      }
      if ((x = m(/^\/shops\/1\/products\/(\d+)$/)) && req.method === 'PUT') {
        const prod = db.prods.find((q) => q.id === +x[1]); db.puts++;
        const skus = body.skus.map((s) => ({ ...s, id: s.id || id() }));
        Object.assign(prod, body, { skus }); return send(200, prod);
      }
      if ((x = m(/^\/shops\/1\/categories\/(\d+)\/product-order$/))) {
        const cid = +x[1];
        const members = db.prods.filter((q) => (q.category_ids || []).includes(cid)).map((q) => q.id);
        const order = db.orders[cid] || members;
        if (req.method === 'GET') return send(200, { products: order.map((pid) => ({ product_id: pid })) });
        db.orders[cid] = body.product_ids; return send(200, {});
      }
      if (req.method === 'GET' && p === '/media/config') return send(200, { enabled: true });
      if (req.method === 'POST' && p === '/shops/1/media/uploads') { const uid = 'u' + id(); db.uploads[uid] = body; return send(200, { upload_id: uid, upload_url: `http://127.0.0.1:${server.address().port}/api/v1/admin/__upload/${uid}`, headers: { 'content-type': body.content_type } }); }
      if (req.method === 'PUT' && p.startsWith('/__upload/')) { db.log.push(`PUT ${p} ${raw.length}B ${req.headers['content-type']}`); res.writeHead(200); return res.end(); }
      if ((x = m(/^\/shops\/1\/products\/(\d+)\/images$/)) && req.method === 'POST') { const prod = db.prods.find((q) => q.id === +x[1]); prod.images.push({ id: id(), alt: body.alt }); return send(201, {}); }
      if (req.method === 'GET' && p === '/shops/1/shipping-methods') return send(200, { shipping_methods: db.ships });
      if (req.method === 'POST' && p === '/shops/1/shipping-methods') { db.ships.push({ id: id(), ...body }); return send(201, {}); }
      if ((x = m(/^\/shops\/1\/shipping-methods\/(\d+)$/)) && req.method === 'PUT') { Object.assign(db.ships.find((s) => s.id === +x[1]), body); return send(200, {}); }
      if (req.method === 'GET' && p === '/shops/1/allowed-origins') return send(200, { origins: db.origins });
      if (req.method === 'POST' && p === '/shops/1/allowed-origins') { db.origins.push(body); return send(201, {}); }
      send(404, { error: 'unmocked ' + req.method + ' ' + p });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ db, server, base: `http://127.0.0.1:${server.address().port}` })));
}

function runImport(base, args = [], env = {}) {
  return new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const c = spawn(process.execPath, ['scripts/import-catalog.mjs', 'catalog/catalog.sample.json', ...args], { cwd: TEMPLATE, env: { ...process.env, IMPORT_API_BASE: base, IMPORT_ADMIN_EMAIL: 'owner@example.com', IMPORT_ADMIN_PASSWORD: 'pw-not-real', ...env } });
      let out = '';
      c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
      c.on('close', (status) => resolve({ status, out }));
    });
  });
}

test('import-catalog against a mock platform: creates everything, is idempotent, upserts changes, --dry-run writes nothing', async () => {
  const { db, server, base } = await mockPlatform();
  try {
    // dry run with credentials: reads only
    let r = await runImport(base, ['--dry-run']);
    assert.equal(r.status, 0, r.out);
    assert.equal(db.calls.some((c) => c.startsWith('POST /shops') || c.startsWith('PUT')), false, 'dry run must not write');
    assert.equal(db.prods.length, 0);

    // real run
    r = await runImport(base, [], { IMPORT_ORIGIN: 'http://localhost:8788' });
    assert.equal(r.status, 0, r.out);
    assert.equal(db.cats.length, 5);
    assert.equal(db.prods.length, 8);
    assert.equal(db.prods.reduce((n, q) => n + q.skus.length, 0), 24);
    assert.ok(db.prods.every((q) => q.images.length === 1 && /^product-0\d\.png$/.test(q.images[0].alt)));
    assert.equal(db.ships.length, 2);
    assert.deepEqual(db.origins, [{ origin: 'http://localhost:8788', purpose: 'storefront' }]);
    const na = db.cats.find((c) => c.slug === 'new-arrivals').id;
    assert.deepEqual(db.orders[na], ['slow-bottle', 'daily-mug', 'light-notebook'].map((sl) => db.prods.find((q) => q.slug === sl).id));
    assert.ok(db.log.every((l) => /image\/png/.test(l)) && db.log.length === 8, db.log.join('\n'));
    const mug = db.prods.find((q) => q.slug === 'daily-mug');
    assert.deepEqual(mug.category_ids.length, 2);
    assert.equal(mug.skus.find((s) => s.options.size === 'M').price_amount, 680);

    // second run: nothing duplicated, no new uploads, same ids
    const idsBefore = db.prods.map((q) => [q.id, q.skus.map((s) => s.id)]);
    const uploadsBefore = db.log.length;
    r = await runImport(base, [], { IMPORT_ORIGIN: 'http://localhost:8788' });
    assert.equal(r.status, 0, r.out);
    assert.equal(db.prods.length, 8); assert.equal(db.cats.length, 5); assert.equal(db.ships.length, 2); assert.equal(db.origins.length, 1);
    assert.equal(db.log.length, uploadsBefore);
    assert.deepEqual(db.prods.map((q) => [q.id, q.skus.map((s) => s.id)]), idsBefore);
    assert.match(r.out, /image already attached/);

    // an existing SKU that the file no longer lists is kept (never dropped), and an edited price is upserted by sku_code
    db.prods[0].skus.push({ id: 9999, sku_code: 'LEGACY-1', options: { size: 'XL' }, price_amount: 1, currency: 'TWD', stock_qty: 1, is_active: true });
    const edited = sample(); edited.products[0].skus[0].price_amount = 777;
    const f = path.join(tmp(), 'catalog.json'); write(path.dirname(f), 'catalog.json', JSON.stringify(edited));
    // images resolve relative to the file: point at the template's images
    edited.products.forEach((q) => { q.images = q.images.map((i) => path.join(TEMPLATE, 'catalog', i)); });
    write(path.dirname(f), 'catalog.json', JSON.stringify(edited));
    const c = await new Promise((resolve) => import('node:child_process').then(({ spawn }) => {
      const p = spawn(process.execPath, ['scripts/import-catalog.mjs', f], { cwd: TEMPLATE, env: { ...process.env, IMPORT_API_BASE: base, IMPORT_ADMIN_EMAIL: 'o@example.com', IMPORT_ADMIN_PASSWORD: 'x' } });
      let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; }); p.on('close', (status) => resolve({ status, out }));
    }));
    assert.equal(c.status, 0, c.out);
    assert.equal(db.prods[0].skus.find((s) => s.sku_code === edited.products[0].skus[0].sku_code).price_amount, 777);
    assert.ok(db.prods[0].skus.some((s) => s.sku_code === 'LEGACY-1'), 'existing SKUs are never dropped');
  } finally { server.close(); }
});

test('import-catalog never prints credentials and fails clearly on a rejected login', async () => {
  const { server, base } = await mockPlatform();
  try {
    const r = await runImport(base + '/wrong', []);
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.out, /pw-not-real/);
  } finally { server.close(); }
});
