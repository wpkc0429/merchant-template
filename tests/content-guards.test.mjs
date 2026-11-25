// Guard tests for the storefront content surface (ShopCommerce.content, v0.3.0): what scripts/check-layers.mjs enforces about it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TEMPLATE, tmp, cleanup, node, read, write } from './helpers.mjs';

after(cleanup);
const layers = (d) => node(['scripts/check-layers.mjs', '--check'], d);
// A storefront-only scratch copy (public/, check-layers, template.json as a merchant repo), re-locked, so these tests need neither the
// admin nor a fresh manifest. config.js gets real values like a merchant repo's.
const fresh = () => {
  const dir = tmp('mt-layers-');
  cpSync(path.join(TEMPLATE, 'public'), path.join(dir, 'public'), { recursive: true });
  mkdirSync(path.join(dir, 'scripts'));
  cpSync(path.join(TEMPLATE, 'scripts/check-layers.mjs'), path.join(dir, 'scripts/check-layers.mjs'));
  const tj = JSON.parse(readFileSync(path.join(TEMPLATE, 'template.json'), 'utf8')); tj.isTemplate = false;
  writeFileSync(path.join(dir, 'template.json'), JSON.stringify(tj));
  writeFileSync(path.join(dir, 'public/config.js'), readFileSync(path.join(dir, 'public/config.js'), 'utf8').replace('REPLACE_WITH_PLATFORM_API_BASE', 'https://api.example.com').replace('REPLACE_WITH_PUBLISHABLE_KEY', 'pk_test123456'));
  node(['scripts/check-layers.mjs', '--update'], dir);
  return { dir };
};
const withApp = (d, extra) => write(d, 'public/app.js', read(d, 'public/app.js') + '\n' + extra + '\n');

test('check-layers: a design layer using only the documented ShopCommerce.content functions passes; undocumented or bare use fails', () => {
  const m = fresh(); const d = m.dir;
  assert.equal(layers(d).status, 0);
  const orig = read(d, 'public/app.js');
  const tries = [
    ["Commerce.content.get('global');", 0],
    ["Commerce.content.safeHref('/x');", 0],
    ["Commerce.content.nope();", 1, /Commerce\.content\.nope is not in commerce\/public-api\.json/],
    ["Commerce.content._internal;", 1],
    ["var c = Commerce.content;", 1, /bare .*content/],
    ["Commerce.sneaky();", 1]
  ];
  for (const [code, want, re] of tries) {
    write(d, 'public/app.js', orig); withApp(d, code);
    const r = layers(d);
    assert.equal(r.status, want, `${code}\n${r.out}`);
    if (re) assert.match(r.out, re);
  }
  write(d, 'public/app.js', orig);
});

test('check-layers: design code may not fetch content itself, nor hand content values to innerHTML, eval or document.write', () => {
  const m = fresh(); const d = m.dir;
  const orig = read(d, 'public/app.js');
  for (const code of [
    "fetch('/api/v1/shop/content');",
    "var p = '/api/v1/shop/content';",
    "document.getElementById('app').innerHTML = Commerce.content.get('faq').items[0].a;",
    "eval('1');",
    "new Function('return 1')();",
    "document.write('x');",
    "sessionStorage.setItem('shopcommerce:content:x', '1');"
  ]) {
    write(d, 'public/app.js', orig); withApp(d, code);
    assert.equal(layers(d).status, 1, code);
  }
});

test('check-layers: index.html must load content-allowlist.js and content.js, in order, before checkout.js (which freezes ShopCommerce) and the design layer', () => {
  const m = fresh(); const d = m.dir;
  const orig = read(d, 'public/index.html');
  const drop = (name) => orig.replace(new RegExp(`<script src="${name.replace('.', '\\.')}"></script>\\n`), '');
  let r;
  write(d, 'public/index.html', drop('commerce/content.js')); r = layers(d);
  assert.equal(r.status, 1); assert.match(r.out, /does not load commerce\/content\.js/);
  write(d, 'public/index.html', drop('commerce/content-allowlist.js')); r = layers(d);
  assert.equal(r.status, 1); assert.match(r.out, /does not load commerce\/content-allowlist\.js/);
  // content.js after checkout.js
  write(d, 'public/index.html', drop('commerce/content.js').replace('<script src="commerce/checkout.js"></script>', '<script src="commerce/checkout.js"></script>\n<script src="commerce/content.js"></script>')); r = layers(d);
  assert.equal(r.status, 1); assert.match(r.out, /out of order/);
  write(d, 'public/index.html', orig);
  assert.equal(layers(d).status, 0);
});

test('check-layers: public-api.json must list exactly what ShopCommerce.content exports', () => {
  const m = fresh(); const d = m.dir;
  const api = JSON.parse(read(d, 'public/commerce/public-api.json'));
  assert.deepEqual(api['ShopCommerce.content'].slice().sort(), ['all', 'get', 'image', 'isPreview', 'link', 'onChange', 'ready', 'richText', 'safeHref', 'safeImageSrc', 'text']);
  api['ShopCommerce.content'].push('hidden');
  write(d, 'public/commerce/public-api.json', JSON.stringify(api, null, 2));
  const r = layers(d);
  assert.equal(r.status, 1); assert.match(r.out, /public-api\.json content != exports/);
});
