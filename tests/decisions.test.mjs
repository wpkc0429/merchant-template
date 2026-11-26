// Tests for the decisions of 2026-11-25 (docs/DECISIONS.md): tag-only sync source, the content schema file, the strict
// CSP deployment requirement and the fixed confirmation warnings. Template-only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { V1, V2, V3, TEMPLATE, cleanup, node, git, read, write, makeMerchant, makeTemplateCopy, sync } from './helpers.mjs';
import { lintSchema, main as checkSchemaMain } from '../scripts/check-content-schema.mjs';

after(cleanup);
const tplFile = (f) => readFileSync(path.join(TEMPLATE, f), 'utf8');

// ───────────── 5. the sync source is a tag only ─────────────
const clean = (m) => assert.equal(git(m.dir, 'status', '--porcelain', '--untracked-files=all').out.trim(), '', 'nothing may change when the sync is refused');

test('sync-core: a template checkout at the annotated tag is accepted and the source is logged', () => {
  const m = makeMerchant();
  const tpl = makeTemplateCopy(V2);
  const r = sync(m.dir, tpl, '--dry-run');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /source: tag v/);
  assert.doesNotMatch(r.out, /allow-untagged/);
});

test('sync-core: an untagged checkout is refused (exit 2) and nothing changes', () => {
  const m = makeMerchant();
  const tpl = makeTemplateCopy(V2, () => {}, { tag: false });
  for (const flags of [['--yes'], ['--dry-run']]) {
    const r = sync(m.dir, tpl, ...flags);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /not at a release tag/);
    assert.match(r.out, /not at any release tag/);
    assert.match(r.out, /--allow-untagged/);
  }
  clean(m);
  assert.equal(read(m.dir, '.template-version').split('\n')[0], V1);
});

test('sync-core: a LIGHTWEIGHT tag, a tag that disagrees with template.json, a dirty tree and a plain copy (no .git) are all refused', () => {
  const m = makeMerchant();
  let r = sync(m.dir, makeTemplateCopy(V2, () => {}, { tag: 'light' }), '--yes');
  assert.equal(r.status, 2); assert.match(r.out, /none is an annotated/);
  // annotated tag of ANOTHER version at HEAD
  const wrong = makeTemplateCopy(V2, () => {}, { tag: false });
  git(wrong, 'tag', '-a', `v${V3}`, '-m', 'wrong');
  r = sync(m.dir, wrong, '--yes');
  assert.equal(r.status, 2); assert.match(r.out, /disagree/);
  r = sync(m.dir, makeTemplateCopy(V2, () => {}, { dirty: true }), '--yes');
  assert.equal(r.status, 2); assert.match(r.out, /uncommitted changes/);
  const noGit = makeTemplateCopy(V2);
  // an exported copy: same files, no .git
  const plain = path.join(path.dirname(noGit), 'exported');
  node(['-e', `require('fs').cpSync(${JSON.stringify(noGit)}, ${JSON.stringify(plain)}, { recursive: true, filter: (s) => !/[\\\\/]\\.git([\\\\/]|$)/.test(s) })`], TEMPLATE);
  r = sync(m.dir, plain, '--yes');
  assert.equal(r.status, 2); assert.match(r.out, /not a git checkout/);
  clean(m);
});

test('sync-core --allow-untagged: works, is loud in the output and is recorded in .template-version', () => {
  const m = makeMerchant();
  const tpl = makeTemplateCopy(V2, () => {}, { tag: false });
  const r = sync(m.dir, tpl, '--yes', '--allow-untagged');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /allow-untagged: syncing from an UNTAGGED template checkout/);
  assert.match(r.out, /source: UNTAGGED checkout via --allow-untagged/);
  const tv = read(m.dir, '.template-version');
  assert.equal(tv.split('\n')[0], V2);
  assert.match(tv, new RegExp(`# \\d{4}-\\d\\d-\\d\\d sync ${V1.replaceAll('.', '\\.')} -> ${V2.replaceAll('.', '\\.')} from UNTAGGED checkout via --allow-untagged`));
  assert.match(tv, /created by new-merchant\.mjs/, 'the earlier history line stays');
});

test('sync-core: the history accumulates over two syncs (tagged, then an override)', () => {
  const m = makeMerchant();
  assert.equal(sync(m.dir, makeTemplateCopy(V2), '--yes').status, 0);
  git(m.dir, 'add', '-A'); git(m.dir, 'commit', '-q', '-m', 'sync');
  assert.equal(sync(m.dir, makeTemplateCopy(V3, () => {}, { tag: false }), '--yes', '--allow-untagged').status, 0);
  const lines = read(m.dir, '.template-version').trim().split('\n');
  assert.equal(lines[0], V3);
  assert.match(lines[2], /UNTAGGED/); assert.match(lines[3], /from tag v/); assert.match(lines[4], /created by new-merchant/);
});

// ───────────── B. the content schema file ─────────────
test('public/content.schema.json: valid per the offline lint, listed as a storefront DESIGN path, not a locked path', () => {
  const tj = JSON.parse(tplFile('template.json'));
  assert.ok(tj.sites.storefront.designPaths.includes('public/content.schema.json'));
  assert.ok(!tj.lockedPaths.includes('public/content.schema.json'));
  assert.ok(!tj.sites.admin.designPaths.includes('public/content.schema.json'));
  assert.deepEqual(lintSchema(JSON.parse(tplFile('public/content.schema.json'))), []);
  assert.equal(node(['scripts/check-content-schema.mjs', '--lint'], TEMPLATE).status, 0);
});

test('content schema lint rejects what the platform would reject', () => {
  const base = JSON.parse(tplFile('public/content.schema.json'));
  const mut = (fn) => { const d = structuredClone(base); fn(d); return lintSchema(d); };
  assert.ok(mut((d) => { delete d.types.story.schema.properties.eyebrow.maxLength; }).some((p) => /maxLength/.test(p)));
  assert.ok(mut((d) => { delete d.types.story.schema.properties.eyebrow.default; }).some((p) => /default/.test(p)));
  assert.ok(mut((d) => { d.types.global.schema.properties.brand.additionalProperties = true; }).some((p) => /additionalProperties/.test(p)));
  assert.ok(mut((d) => { delete d.types.faq.schema.properties.items.maxItems; }).some((p) => /maxItems/.test(p)));
  assert.ok(mut((d) => { d.types.home.schema.allOf = []; }).some((p) => /allOf/.test(p)));
  assert.ok(mut((d) => { d.types.home.title = 'x'; d.documents.home.type = 'nope'; }).some((p) => /unknown type/.test(p)));
  assert.ok(mut((d) => { d.format = 1; }).some((p) => /format/.test(p)));
});

test('the content.js defaults and the content schema defaults agree (every content.js value that is merchant content has a schema field)', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(tplFile('public/content.js'), sandbox);
  const C = JSON.parse(JSON.stringify(sandbox.window.SHOP_CONTENT));
  const schema = JSON.parse(tplFile('public/content.schema.json'));
  const T = (k) => schema.types[k].schema.properties;
  const def = (p) => p.default;
  const walkEq = (props, val, where) => {
    for (const [k, p] of Object.entries(props)) {
      assert.ok(k in val, `${where}.${k} is in the schema but not in content.js`);
      if (p.type === 'object') walkEq(p.properties, val[k], `${where}.${k}`);
      else assert.deepEqual(def(p), val[k], `${where}.${k}: schema default differs from content.js`);
    }
    for (const k of Object.keys(val)) assert.ok(k in props, `${where}.${k} is in content.js but has no schema field`);
  };
  const globalMap = { accent: C.accent, brand: C.brand, searchPlaceholder: C.searchPlaceholder, noteLabel: C.noteLabel, featuredTitle: C.featuredTitle, instagram: C.instagram, store: C.store, newsletter: C.newsletter, promo: C.promo };
  walkEq(T('global'), globalMap, 'global');
  walkEq(T('home'), { hero: C.hero, storyTeaser: C.storyTeaser }, 'home');
  walkEq(T('story'), C.story, 'story');
  assert.deepEqual(T('faq').items.default, C.faq);
  assert.deepEqual(T('product_info').items.default, C.pinfo);
  assert.ok(!('titleHtml' in C.hero) && !('titleHtml' in C.story), 'titles are plain text; the design layer renders newlines as <br>');
  // design constants stay out of the schema on purpose
  for (const k of ['storyImage', 'navPages', 'sorts']) assert.ok(k in C && !JSON.stringify(schema).includes(`"${k}"`), k);
});

test('app.js renders title newlines as <br> and escapes them (no raw HTML from content)', () => {
  const app = tplFile('public/app.js');
  assert.match(app, /function lines\(s\) \{\s*return esc\(s\)\.replace\(\/\\r\?\\n\/g, '<br>'\);/);
  assert.doesNotMatch(app, /titleHtml/);
  assert.equal([...app.matchAll(/lines\(CONTENT\.(hero|storyTeaser|story)\.title\)/g)].length, 5);
});

test('check-content-schema.mjs: only ever sends a dry run (fake platform), never registers, never prints credentials', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, bytes: body.length });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/v1/admin/auth/login') return res.end(JSON.stringify({ access_token: 'tok-secret-123' }));
      if (req.method === 'PUT' && req.url === '/api/v1/admin/shops/7/content/schema?dry_run=true') return res.end(JSON.stringify({ version: 0, would_register_version: 1, changed: true, dry_run: true, report: { documents: [] } }));
      res.statusCode = 500; res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const logs = [];
  const orig = [console.log, console.error];
  console.log = (...a) => logs.push(a.join(' ')); console.error = (...a) => logs.push(a.join(' '));
  let code;
  try {
    code = await checkSchemaMain([], { CONTENT_API_BASE: `http://127.0.0.1:${srv.address().port}`, CONTENT_SHOP_ID: '7', CONTENT_ADMIN_EMAIL: 'owner@example.com', CONTENT_ADMIN_PASSWORD: 'pw-should-never-print' });
  } finally { [console.log, console.error] = orig; srv.close(); }
  assert.equal(code, 0, logs.join('\n'));
  assert.deepEqual(seen.map((s) => `${s.method} ${s.url}`), ['POST /api/v1/admin/auth/login', 'PUT /api/v1/admin/shops/7/content/schema?dry_run=true']);
  assert.ok(seen[1].bytes > 1000, 'the schema was sent');
  assert.match(logs.join('\n'), /Nothing was registered/);
  assert.doesNotMatch(logs.join('\n'), /pw-should-never-print|tok-secret-123|owner@example\.com/);
  // static: the script contains no registration path
  const src = tplFile('scripts/check-content-schema.mjs');
  const puts = [...src.matchAll(/call\('PUT'[^\n]*/g)].map((m) => m[0]);
  assert.equal(puts.length, 1); assert.match(puts[0], /dry_run=true/);
  assert.deepEqual([...src.matchAll(/call\('([A-Z]+)'/g)].map((m) => m[1]).sort(), ['POST', 'PUT'], 'only the login POST and the dry-run PUT exist');
  // credentials are not accepted as arguments, and missing env is a usage error
  assert.equal(await checkSchemaMain(['--password=x'], {}), 2);
  const orig2 = console.error; console.error = () => {};
  try { assert.equal(await checkSchemaMain([], {}), 2); } finally { console.error = orig2; }
});

test('new-merchant prints the human content-schema registration steps and the CSP note', () => {
  const dir = path.join(path.dirname(makeMerchant().dir), 'cli-shop');
  const r = node(['scripts/new-merchant.mjs', dir, '--name', 'CLI Shop', '--slug', 'cli-shop', '--no-git'], TEMPLATE);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /CONTENT SCHEMA \(HUMAN ONLY/);
  assert.match(r.out, /dry run \(writes nothing\)/);
  assert.match(r.out, /confirm_removals=true/);
  assert.match(r.out, /never CI/);
  assert.match(r.out, /strict CSP/i);
  assert.match(read(dir, 'README.md'), /HUMAN step/);
});

// ───────────── 1. strict CSP is a deployment requirement ─────────────
const layers = (d) => node(['scripts/check-layers.mjs', '--check'], d);
const relock = (d) => node(['scripts/check-layers.mjs', '--update'], d);

test('storefront CSP: the template ships public/_headers (locked, hash-protected) and passes; index.html has no inline script', () => {
  assert.equal(layers(TEMPLATE).status, 0);
  const h = tplFile('public/_headers');
  assert.match(h, /^\/\*\s*$/m);
  assert.match(h, /Content-Security-Policy: default-src 'self'; script-src 'self';/);
  assert.doesNotMatch(h.split('\n').filter((l) => /Content-Security-Policy:/.test(l)).join(''), /unsafe-eval|script-src[^;]*unsafe-inline/);
  const tj = JSON.parse(tplFile('template.json'));
  assert.ok(tj.lockedPaths.includes('public/_headers'));
  assert.ok(!tj.merchantOwnedPaths.includes('public/_headers'), 'synced like the rest of the core so CSP upgrades reach every merchant');
  assert.ok('public/_headers' in JSON.parse(tplFile('scripts/commerce.manifest.json')));
  const idx = tplFile('public/index.html').replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(idx, /<script(?![^>]*\bsrc=)/);
});

test('storefront CSP: form-action allows the ECPay payment hosts only, no inline-script allowance, and the extra security headers are present', () => {
  const h = tplFile('public/_headers');
  const csp = h.split(/\r?\n/).find((l) => /^\s+Content-Security-Policy:/.test(l));
  const dirs = Object.fromEntries(csp.replace(/^\s+Content-Security-Policy:\s*/, '').split(';').map((p) => p.trim().split(/\s+/)).filter((a) => a[0]).map(([n, ...v]) => [n, v]));
  assert.deepEqual(dirs['form-action'], ["'self'", 'https://payment.ecpay.com.tw', 'https://payment-stage.ecpay.com.tw']);
  assert.deepEqual(dirs['script-src'], ["'self'"]);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline|style-src 'self'[^;]*unsafe-inline/);
  assert.match(h, /^\s+Strict-Transport-Security: max-age=\d{8,}/m);
  assert.match(h, /^\s+Permissions-Policy: .*camera=\(\)/m);
  assert.match(h, /^\s+Cross-Origin-Opener-Policy: same-origin/m);
  const ng = tplFile('admin/deploy/nginx.conf.template');
  for (const n of ['Strict-Transport-Security', 'Permissions-Policy', 'Cross-Origin-Opener-Policy']) assert.match(ng, new RegExp(`^\\s+add_header ${n} ".*" always;`, 'm'));
});

test('storefront CSP guard: a missing, CSP-less or weakened _headers fails check-layers; an inline script fails in the template and warns in a merchant repo', () => {
  const m = makeMerchant(); const d = m.dir;
  const orig = read(d, 'public/_headers');
  const csp = (mutate) => { write(d, 'public/_headers', mutate(orig)); relock(d); return layers(d); };
  assert.equal(layers(d).status, 0);
  const cspIn = (a, b) => csp((x) => x.replace(/^( {2}Content-Security-Policy:.*)$/m, (l) => l.replace(a, b)));
  let r = csp((x) => x.replace(/^ {2}Content-Security-Policy:.*\n/m, ''));
  assert.equal(r.status, 1); assert.match(r.out, /no Content-Security-Policy/);
  r = cspIn("script-src 'self'", "script-src 'self' 'unsafe-inline'");
  assert.equal(r.status, 1); assert.match(r.out, /script-src must be 'self' only/);
  r = cspIn("script-src 'self'", "script-src 'self' 'unsafe-eval'");
  assert.equal(r.status, 1);
  r = cspIn("script-src 'self'", "script-src 'self' https://cdn.example.com");
  assert.equal(r.status, 1);
  r = cspIn("style-src 'self';", "style-src 'self' 'unsafe-inline';");
  assert.equal(r.status, 1); assert.match(r.out, /style-src must not allow/);
  r = cspIn("object-src 'none'", "object-src 'self'");
  assert.equal(r.status, 1);
  r = cspIn("frame-ancestors 'none'; ", '');
  assert.equal(r.status, 1); assert.match(r.out, /frame-ancestors/);
  r = cspIn("base-uri 'none'; ", '');
  assert.equal(r.status, 1);
  // a commented-out CSP does not count
  r = csp((t) => t.replace(/^ {2}Content-Security-Policy:/m, '  # Content-Security-Policy:'));
  assert.equal(r.status, 1);
  // missing file
  git(d, 'checkout', '--', 'public/_headers'); relock(d);
  const { rmSync } = await_fs();
  rmSync(path.join(d, 'public/_headers'));
  r = layers(d);
  assert.equal(r.status, 1); assert.match(r.out, /public\/_headers is missing/);
  git(d, 'checkout', '--', 'public/_headers'); relock(d);
  assert.equal(layers(d).status, 0);
  // inline script: warning in a merchant repo ...
  write(d, 'public/index.html', read(d, 'public/index.html').replace('</body>', '<script>window.x = 1;</script></body>'));
  r = layers(d);
  assert.equal(r.status, 0, r.out); assert.match(r.out, /warning: public\/index\.html has an inline <script>/);
  // ... an error in the template
  const tj = JSON.parse(read(d, 'template.json')); tj.isTemplate = true; write(d, 'template.json', JSON.stringify(tj));
  write(d, 'public/config.js', read(d, 'public/config.js').replace(/apiBase: "[^"]*"/, "apiBase: 'REPLACE_WITH_PLATFORM_API_BASE'").replace(/publishableKey: "[^"]*"/, "publishableKey: 'REPLACE_WITH_PUBLISHABLE_KEY'"));
  r = layers(d);
  assert.equal(r.status, 1); assert.match(r.out, /inline <script>/);
});
function await_fs() { return { rmSync: (p) => node(['-e', `require('fs').rmSync(${JSON.stringify(p)})`], TEMPLATE) }; }

test('admin CSP guard: the shipped deploy files pass check-design; the check is part of the guard CLI', () => {
  const r = node(['scripts/check-design.mjs'], path.join(TEMPLATE, 'admin'));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /deploy \(strict CSP is on by default in deploy\/\)/);
  const nginx = tplFile('admin/deploy/nginx.conf.template');
  assert.match(nginx, /REQUIRED, NOT OPTIONAL/i);
  assert.match(tplFile('admin/deploy/Dockerfile'), /REQUIRED, NOT OPTIONAL/i);
});

test('a merchant admin whose deploy config has lost its CSP fails the admin guard', () => {
  const m = makeMerchant(); const d = m.dir;
  write(d, 'admin/deploy/nginx.conf.template', read(d, 'admin/deploy/nginx.conf.template').replace(/^\s*add_header Content-Security-Policy.*$/gm, ''));
  const r = node(['scripts/check-design.mjs'], path.join(d, 'admin'));
  assert.equal(r.status, 1);
  assert.match(r.out, /\[deploy\/csp-missing\]/);
});

// ───────────── 3. fixed confirmation warnings ─────────────
test('fixed warnings: every irreversible confirm in core/actions.js goes through ask() with a core warning; no copy key can carry one', async () => {
  const actions = tplFile('admin/core/actions.js');
  const { WARNED_CONFIRM_IDS, fixedWarning } = await import('../admin/core/warnings.js').then(async (w) => ({ ...w, ...(await import('../admin/lib/design-schema.js')) }));
  // the only direct confirmDialog call is inside ask()
  assert.equal([...actions.matchAll(/confirmDialog\(\{/g)].length, 1, 'actions.js must not open its own confirmDialog; use ask()');
  const used = [...actions.matchAll(/ask\(\s*(?:target === "returned" \? "confirm\.shipReturned" : "confirm\.shipDelivered"|active \? "confirm\.enableMember" : "confirm\.disableMember"|"(confirm\.\w+)")/g)];
  assert.ok(used.length >= 6);
  const ids = new Set([...actions.matchAll(/confirm\.([A-Za-z]+)/g)].map((m) => m[1]).filter((i) => !['yes', 'no', 'title'].includes(i)));
  const defaults = (await import('../admin/design-defaults/copy.js')).default;
  for (const id of ids) {
    const warned = WARNED_CONFIRM_IDS.includes(id);
    assert.equal(`confirm.${id}.text` in defaults, warned, `${id}: .text exists exactly for warned confirms`);
    assert.equal(`confirm.${id}.message` in defaults, !warned, `${id}: .message exists exactly for plain confirms`);
    assert.ok(!Object.keys(defaults).some((k) => k.startsWith(`confirm.${id}.`) && /warn/i.test(k)), `${id}: no warning key in copy`);
  }
  for (const id of ['cancelOrder', 'shipDelivered', 'shipReturned', 'deleteProduct', 'deleteImage', 'deleteCategory', 'disableMember', 'revokeInvite']) assert.ok(WARNED_CONFIRM_IDS.includes(id), id);
  assert.match(fixedWarning('cancelOrder'), /無法復原/);
  assert.match(fixedWarning('shipDelivered', { id: 12 }), /出貨 #12/);
  assert.throws(() => fixedWarning('nope'));
  // the default design's copy equals the built-in copy except for the FIXED core texts (lib/fixed-text.js), which design/copy.js must not carry
  const noFixed = (t) => t.replace(/\r\n/g, '\n').split('\n').filter((l) => !/^\s*"vp\.limits":/.test(l)).join('\n');
  assert.equal(noFixed(readFileSync(path.join(TEMPLATE, 'admin/design/copy.js'), 'utf8')), noFixed(readFileSync(path.join(TEMPLATE, 'admin/design-defaults/copy.js'), 'utf8')));
  assert.ok(!readFileSync(path.join(TEMPLATE, 'admin/design/copy.js'), 'utf8').includes('"vp.limits"'), 'design/copy.js must not define the fixed vp.limits');
  assert.match(tplFile('admin/ui/kit.js'), /data-testid": "confirm-warning"/);
  assert.equal(existsSync(path.join(TEMPLATE, 'admin/core/warnings.js')), true);
});

test('check-content-schema --lint passes in a merchant repo that has not adopted the schema file yet (CI stays green), a dry run does not', () => {
  const m = makeMerchant();
  const { unlinkSync } = require_fs();
  unlinkSync(path.join(m.dir, 'public/content.schema.json'));
  let r = node(['scripts/check-content-schema.mjs', '--lint'], m.dir);
  assert.equal(r.status, 0, r.out); assert.match(r.out, /nothing to lint/);
  r = node(['scripts/check-content-schema.mjs'], m.dir);
  assert.equal(r.status, 2);
});
function require_fs() { return { unlinkSync: (p) => node(['-e', `require('fs').unlinkSync(${JSON.stringify(p)})`], TEMPLATE) }; }
