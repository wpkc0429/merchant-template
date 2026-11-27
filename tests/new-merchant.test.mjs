import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { V1, TEMPLATE, tmp, cleanup, node, git, read, write, makeMerchant } from './helpers.mjs';
import { createMerchant } from '../scripts/new-merchant.mjs';

after(cleanup);

test('the template itself passes every guard (placeholders enforced, manifests match)', () => {
  assert.equal(node(['scripts/check-layers.mjs', '--check'], TEMPLATE).status, 0);
  assert.equal(node(['scripts/check-design.mjs'], path.join(TEMPLATE, 'admin')).status, 0);
  assert.equal(node(['scripts/test-guard.mjs'], path.join(TEMPLATE, 'admin')).status, 0);
});

test('in the template, a real config.js value fails the guard (isTemplate placeholder rule)', () => {
  const m = makeMerchant();
  // same files, but flip the repo back to "template" mode: real values must now be refused
  const tj = JSON.parse(read(m.dir, 'template.json')); tj.isTemplate = true; write(m.dir, 'template.json', JSON.stringify(tj));
  const r = node(['scripts/check-layers.mjs', '--check'], m.dir);
  assert.equal(r.status, 1);
  assert.match(r.out, /must keep the REPLACE_WITH_\* placeholders/);
});

test('new-merchant: brand, config values, version records, no template-only files, manifests verify, initial commit', () => {
  const m = makeMerchant();
  const d = m.dir;
  assert.match(read(d, 'public/index.html'), /<title>測試商店<\/title>/);
  assert.match(read(d, 'public/index.html'), /og:url" content="https:\/\/shop\.example\.com\/"/);
  assert.match(read(d, 'public/content.js'), /brand: \{ name: "測試商店"/);
  assert.match(read(d, 'admin/design/copy.js'), /"app.name": "測試商店後台"/);
  assert.match(read(d, 'wrangler.jsonc'), /"name": "test-shop"/);
  assert.match(read(d, 'public/config.js'), /apiBase: "https:\/\/api\.example\.com"/);
  assert.match(read(d, 'public/config.js'), /publishableKey: "pk_testkey123456"/);
  const tj = JSON.parse(read(d, 'template.json'));
  assert.equal(tj.isTemplate, false);
  assert.equal(tj.version, V1);
  assert.equal(tj.merchant.slug, 'test-shop');
  assert.equal(read(d, '.template-version').split('\n')[0], V1);
  assert.match(read(d, '.template-version'), /# \d{4}-\d\d-\d\d created by new-merchant\.mjs from /);
  for (const f of ['scripts/new-merchant.mjs', 'scripts/gen-placeholders.mjs', 'tests', 'docs/TEMPLATE-NOTES.md']) {
    assert.equal(existsSync(path.join(d, f)), false, `${f} must not be copied`);
  }
  assert.ok(read(d, 'README.md').includes(`merchant-template v${V1}`));
  // brand-free: nothing of the template author's old site leaks into a merchant
  assert.equal(node(['scripts/check-layers.mjs', '--check'], d).status, 0);
  assert.equal(node(['scripts/check-design.mjs'], path.join(d, 'admin')).status, 0);
  const log = git(d, 'log', '--oneline');
  assert.ok(log.out.includes(`Initial commit from merchant-template v${V1}`));
  assert.equal(git(d, 'status', '--porcelain').out.trim(), '');
  assert.equal(git(d, 'remote').out.trim(), '', 'no remote may be set');
  assert.equal(git(d, 'tag').out.trim(), '', 'no tags are copied');
});

test('new-merchant without config values leaves marked placeholders; check-layers only warns', () => {
  const m = makeMerchant({ apiBase: undefined, publishableKey: undefined, siteUrl: undefined, adminOrigin: undefined, imageOrigin: undefined });
  assert.match(read(m.dir, 'public/config.js'), /REPLACE_WITH_PLATFORM_API_BASE/);
  assert.match(read(m.dir, 'public/config.js'), /REPLACE_WITH_PUBLISHABLE_KEY/);
  // config.js placeholders only warn; the headers config placeholders are an ERROR in a merchant repo (D20) unless explicitly allowed
  assert.equal(node(['scripts/check-layers.mjs', '--check'], m.dir).status, 1);
  const r = node(['scripts/check-layers.mjs', '--check', '--allow-placeholders'], m.dir);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /warning: public\/config\.js still holds REPLACE_WITH_/);
});

test('new-merchant escapes the shop name (quotes, angle brackets)', () => {
  const m = makeMerchant({ name: `A "B" <i>&</i>` });
  assert.match(read(m.dir, 'public/index.html'), /<title>A &quot;B&quot; &lt;i&gt;&amp;&lt;\/i&gt;<\/title>/);
  assert.equal(node(['scripts/check-layers.mjs', '--check'], m.dir).status, 0);
  assert.equal(node(['scripts/check-design.mjs'], path.join(m.dir, 'admin')).status, 0);
});

test('new-merchant refuses a non-empty target and leaves it untouched', () => {
  const d = path.join(tmp(), 'busy');
  write(d, 'keep.txt', 'mine');
  assert.throws(() => createMerchant({ target: d, name: 'X', slug: 'x-shop' }), /not empty/);
  assert.deepEqual(readdirSync(d), ['keep.txt']);
  // an existing EMPTY directory is fine
  const e = path.join(tmp(), 'empty'); mkdirSync(e);
  assert.doesNotThrow(() => createMerchant({ target: e, name: 'X', slug: 'x-shop' }));
});

test('new-merchant refuses bad input and a target inside the template', () => {
  const t = path.join(tmp(), 't');
  assert.throws(() => createMerchant({ target: t, name: '', slug: 'ok-slug' }), /--name/);
  assert.throws(() => createMerchant({ target: t, name: 'X', slug: 'Bad Slug' }), /--slug/);
  assert.throws(() => createMerchant({ target: t, name: 'X', slug: 'ok-slug', apiBase: 'http://api.example.com' }), /https/);
  assert.throws(() => createMerchant({ target: t, name: 'X', slug: 'ok-slug', apiBase: 'nonsense' }), /absolute URL/);
  assert.throws(() => createMerchant({ target: t, name: 'X', slug: 'ok-slug', publishableKey: 'sk_secret' }), /pk_/);
  assert.throws(() => createMerchant({ target: path.join(TEMPLATE, 'inside-template'), name: 'X', slug: 'ok-slug' }), /outside the template/);
  assert.equal(existsSync(t), false);
});

test('the CLI prints the next steps and creates nothing remote', () => {
  const d = path.join(tmp(), 'cli');
  const r = node(['scripts/new-merchant.mjs', d, '--name', 'CLI Shop', '--slug', 'cli-shop', '--no-git'], TEMPLATE);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Next steps/);
  assert.equal(existsSync(path.join(d, '.git')), false);
  const bad = node(['scripts/new-merchant.mjs', d, '--name', 'CLI Shop', '--slug', 'cli-shop'], TEMPLATE);
  assert.notEqual(bad.status, 0, 'second run into the now non-empty directory must fail');
});
