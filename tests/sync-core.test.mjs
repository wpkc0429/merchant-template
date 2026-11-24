import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { TEMPLATE, cleanup, node, git, read, write, makeMerchant, makeTemplateCopy, sync, snap } from './helpers.mjs';
import { designActions, parseChangelog, plan } from '../scripts/sync-core.mjs';

after(cleanup);

const DESIGN_FILES = ['public/app.js', 'public/content.js', 'public/styles.css', 'public/index.html', 'public/assets/og-cover.png', 'admin/design/copy.js', 'admin/design/tokens.css', 'admin/design/theme.css', 'admin/design/views/home.js'];
const KEEP_FILES = ['public/config.js', 'wrangler.jsonc', '.gitignore', '.gitattributes', 'catalog/catalog.sample.json'];

/** A merchant whose design layer was edited (and committed), plus a custom extra skill and a custom workflow. */
function editedMerchant() {
  const m = makeMerchant();
  write(m.dir, 'public/styles.css', read(m.dir, 'public/styles.css') + '\n/* merchant restyle */\n:root { --accent: #aa3355; }\n');
  write(m.dir, 'public/content.js', read(m.dir, 'public/content.js').replace('簡單，<br>剛剛好', '我們的故事<br>從這裡開始'));
  write(m.dir, 'public/app.js', read(m.dir, 'public/app.js') + '\n// merchant design tweak\n');
  write(m.dir, 'admin/design/tokens.css', read(m.dir, 'admin/design/tokens.css').replace('#2f5d8a', '#aa3355'));
  write(m.dir, 'admin/design/copy.js', read(m.dir, 'admin/design/copy.js').replace('"login.title"', '"login.title"'));
  write(m.dir, '.claude/skills/my-custom/SKILL.md', '# merchant specific skill\n');
  write(m.dir, '.github/workflows/mine.yml', 'name: mine\non: push\njobs: {}\n');
  write(m.dir, 'catalog/catalog.json', '{"products":[]}\n');
  assert.equal(node(['scripts/check-layers.mjs', '--check'], m.dir).status, 0);
  git(m.dir, 'add', '-A'); git(m.dir, 'commit', '-q', '-m', 'design edits');
  return m;
}

function newTemplate(version = '0.2.0', extraMutate = () => {}) {
  return makeTemplateCopy(version, (d) => {
    write(d, 'public/commerce/cart.js', read(d, 'public/commerce/cart.js') + '\n// core change in ' + version + '\n');
    write(d, 'admin/core/errors.js', read(d, 'admin/core/errors.js') + '\n// core change in ' + version + '\n');
    write(d, 'scripts/lib/extra.mjs', '// new locked helper\nexport const x = 1;\n');
    write(d, '.claude/skills/storefront-design/references/new-note.md', 'new locked note\n');
    // the template's own design files and config.js change too: a sync must NOT carry any of that over
    write(d, 'public/app.js', read(d, 'public/app.js') + '\n// template design change\n');
    write(d, 'public/styles.css', read(d, 'public/styles.css') + '\n/* template design change */\n');
    write(d, 'public/config.js', read(d, 'public/config.js').replace('showPrices: true,', 'showPrices: false,'));
    write(d, 'admin/design/tokens.css', read(d, 'admin/design/tokens.css').replace('#2f5d8a', '#112233'));
    write(d, 'wrangler.jsonc', read(d, 'wrangler.jsonc').replace('merchant-template', 'changed-template'));
    write(d, 'docs/CORE-CHANGELOG.md', read(d, 'docs/CORE-CHANGELOG.md').replace('## v0.1.0', `## v${version}\n\nDesign-layer action: none\n\n* test change\n\n## v0.1.0`));
    extraMutate(d);
  });
}

test('sync-core: copies only locked files; design files, config.js and merchant extras are preserved; manifests verify', () => {
  const m = editedMerchant();
  const tpl = newTemplate();
  const designBefore = snap(m.dir, DESIGN_FILES);
  const keepBefore = snap(m.dir, KEEP_FILES);
  const r = sync(m.dir, tpl, '--yes');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /core sync: 0\.1\.0 -> 0\.2\.0/);
  assert.match(r.out, /~ public\/commerce\/cart\.js/);
  assert.match(r.out, /\+ scripts\/lib\/extra\.mjs/);
  assert.match(r.out, /verified: storefront/);

  // locked files updated
  assert.match(read(m.dir, 'public/commerce/cart.js'), /core change in 0\.2\.0/);
  assert.match(read(m.dir, 'admin/core/errors.js'), /core change in 0\.2\.0/);
  assert.equal(read(m.dir, 'scripts/lib/extra.mjs').includes('new locked helper'), true);
  assert.equal(existsSync(path.join(m.dir, '.claude/skills/storefront-design/references/new-note.md')), true);
  // design layer, config.js and merchant-owned files byte-identical to before
  assert.deepEqual(snap(m.dir, DESIGN_FILES), designBefore);
  assert.deepEqual(snap(m.dir, KEEP_FILES), keepBefore);
  assert.match(read(m.dir, 'public/config.js'), /pk_testkey123456/);
  assert.match(read(m.dir, 'public/config.js'), /showPrices: true/);
  // merchant extras in keepExtraPaths survive
  assert.equal(existsSync(path.join(m.dir, '.claude/skills/my-custom/SKILL.md')), true);
  assert.equal(existsSync(path.join(m.dir, '.github/workflows/mine.yml')), true);
  // version records
  assert.equal(read(m.dir, '.template-version').trim(), '0.2.0');
  const tj = JSON.parse(read(m.dir, 'template.json'));
  assert.equal(tj.version, '0.2.0'); assert.equal(tj.isTemplate, false); assert.equal(tj.merchant.slug, 'test-shop');
  // only expected paths changed in git
  const changed = git(m.dir, 'status', '--porcelain', '--untracked-files=all').out.split('\n').filter(Boolean).map((l) => l.slice(3));
  for (const f of changed) {
    assert.equal(DESIGN_FILES.includes(f) || KEEP_FILES.includes(f), false, `${f} must not change`);
    assert.match(f, /^(public\/commerce\/|admin\/core\/|admin\/scripts\/core\.manifest\.json|scripts\/(lib\/|commerce\.manifest\.json)|\.claude\/|docs\/CORE-CHANGELOG\.md|template\.json|\.template-version|admin\/docs\/)/, f);
  }
  // the manifests verify with the merchant's own guards (also after a fresh process)
  assert.equal(node(['scripts/check-layers.mjs', '--check'], m.dir).status, 0);
  assert.equal(node(['scripts/check-design.mjs'], path.join(m.dir, 'admin')).status, 0);
  // the merchant's config.js hash entry is unchanged (the template's different config.js never entered the manifest)
  const man = JSON.parse(read(m.dir, 'scripts/commerce.manifest.json'));
  const old = JSON.parse(git(m.dir, 'show', 'HEAD:scripts/commerce.manifest.json').out);
  assert.equal(man['public/config.js'], old['public/config.js']);
  assert.notEqual(man['public/commerce/cart.js'], old['public/commerce/cart.js']);
});

test('sync-core: --dry-run changes nothing and reports the plan', () => {
  const m = editedMerchant();
  const tpl = newTemplate();
  const before = git(m.dir, 'rev-parse', 'HEAD').out;
  const r = sync(m.dir, tpl, '--dry-run');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /\[dry-run\] nothing changed/);
  assert.match(r.out, /~ public\/commerce\/cart\.js/);
  assert.equal(git(m.dir, 'status', '--porcelain').out.trim(), '');
  assert.equal(read(m.dir, '.template-version').trim(), '0.1.0');
  assert.equal(git(m.dir, 'rev-parse', 'HEAD').out, before);
});

test('sync-core: files the template removed are removed, merchant extras in .claude/ are kept', () => {
  const m = editedMerchant();
  const tpl = newTemplate('0.2.0', (d) => rmSync(path.join(d, 'admin/docs/AI-EDIT-SERVICE-NOTES.md'), { force: true }));
  const r = sync(m.dir, tpl, '--yes');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /- admin\/docs\/AI-EDIT-SERVICE-NOTES\.md/);
  assert.equal(existsSync(path.join(m.dir, 'admin/docs/AI-EDIT-SERVICE-NOTES.md')), false);
  assert.equal(existsSync(path.join(m.dir, '.claude/skills/my-custom/SKILL.md')), true);
});

test('sync-core refuses a dirty working tree (modified or untracked) and changes nothing', () => {
  const m = editedMerchant();
  const tpl = newTemplate();
  write(m.dir, 'public/app.js', read(m.dir, 'public/app.js') + '\n// uncommitted\n');
  let r = sync(m.dir, tpl, '--yes');
  assert.equal(r.status, 2); assert.match(r.out, /working tree is not clean/);
  git(m.dir, 'checkout', '--', 'public/app.js');
  write(m.dir, 'scratch.txt', 'x');
  r = sync(m.dir, tpl, '--yes');
  assert.equal(r.status, 2); assert.match(r.out, /scratch\.txt/);
  assert.doesNotMatch(read(m.dir, 'public/commerce/cart.js'), /core change/);
});

test('sync-core refuses an equal or older template version', () => {
  const m = editedMerchant();
  for (const v of ['0.1.0', '0.0.9']) {
    const tpl = makeTemplateCopy(v);
    const r = sync(m.dir, tpl, '--yes');
    assert.equal(r.status, 2, v); assert.match(r.out, /not newer/);
  }
  assert.equal(git(m.dir, 'status', '--porcelain').out.trim(), '');
});

test('sync-core refuses a template whose locked paths reach into the design layer or outside the repo', () => {
  const m = editedMerchant();
  for (const [bad, msg] of [['public/app.js', /overlaps the design-layer path/], ['public/assets/', /overlaps the design-layer path/], ['admin/design/', /overlaps the design-layer path/], ['../outside', /unsafe path/], ['.git/hooks/', /unsafe path/], ['.gitignore', /locked paths include/]]) {
    const tpl = newTemplate('0.3.0', (d) => {
      const tj = JSON.parse(read(d, 'template.json')); tj.lockedPaths.push(bad); write(d, 'template.json', JSON.stringify(tj, null, 2));
    });
    const r = sync(m.dir, tpl, '--yes');
    assert.equal(r.status, 2, `${bad}: ${r.out}`); assert.match(r.out, msg, bad);
  }
  assert.equal(git(m.dir, 'status', '--porcelain').out.trim(), '');
});

test('sync-core refuses to run in the template, from a different template name, and from a non-template', () => {
  const tpl = newTemplate();
  let r = node(['scripts/sync-core.mjs', '--from', tpl, '--yes'], TEMPLATE);
  assert.equal(r.status, 2); assert.match(r.out, /template repo itself/);
  const m = editedMerchant();
  const other = newTemplate('0.2.0', (d) => { const tj = JSON.parse(read(d, 'template.json')); tj.name = 'other-template'; write(d, 'template.json', JSON.stringify(tj, null, 2)); });
  r = sync(m.dir, other, '--yes');
  assert.equal(r.status, 2); assert.match(r.out, /name mismatch/);
  const nonTpl = newTemplate('0.2.0', (d) => { const tj = JSON.parse(read(d, 'template.json')); tj.isTemplate = false; write(d, 'template.json', JSON.stringify(tj, null, 2)); });
  r = sync(m.dir, nonTpl, '--yes');
  assert.equal(r.status, 2);
  r = sync(m.dir, path.join(m.dir, 'nonexistent'), '--yes');
  assert.equal(r.status, 2);
  r = sync(m.dir, m.dir, '--yes');
  assert.equal(r.status, 2);
});

test('sync-core refuses a template that fails its own guards', () => {
  const m = editedMerchant();
  const tpl = newTemplate();
  write(tpl, 'public/commerce/api.js', read(tpl, 'public/commerce/api.js') + '\n// tampered after the manifest\n');
  const r = sync(m.dir, tpl, '--yes');
  assert.equal(r.status, 2); assert.match(r.out, /failed inside the template checkout/);
  assert.equal(git(m.dir, 'status', '--porcelain').out.trim(), '');
});

test('sync-core without --yes does not apply on a non-terminal', () => {
  const m = editedMerchant();
  const tpl = newTemplate();
  const r = sync(m.dir, tpl);
  assert.equal(r.status, 2); assert.match(r.out, /pass --yes/);
  assert.equal(git(m.dir, 'status', '--porcelain').out.trim(), '');
});

test('sync-core: a "Design-layer action:" changelog entry blocks until --ack-design-actions, then applies and repeats the notice', () => {
  const m = editedMerchant();
  const tpl = newTemplate('0.2.0', (d) => {
    write(d, 'docs/CORE-CHANGELOG.md', read(d, 'docs/CORE-CHANGELOG.md').replace('Design-layer action: none\n\n* test change', 'Design-layer action: the checkout page should show the new ShopCommerce.checkout.foo() result\n\n* test change'));
  });
  let r = sync(m.dir, tpl, '--yes');
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /DESIGN-LAYER ACTION NEEDED/);
  assert.match(r.out, /v0\.2\.0: the checkout page should show/);
  assert.equal(git(m.dir, 'status', '--porcelain').out.trim(), '', 'nothing may change without the acknowledgement');
  r = sync(m.dir, tpl, '--dry-run');
  assert.equal(r.status, 3); assert.match(r.out, /DESIGN-LAYER ACTION NEEDED/);
  r = sync(m.dir, tpl, '--yes', '--ack-design-actions');
  assert.equal(r.status, 0, r.out);
  assert.equal((r.out.match(/DESIGN-LAYER ACTION NEEDED/g) || []).length, 2, 'the notice is printed before and after');
  assert.equal(read(m.dir, '.template-version').trim(), '0.2.0');
});

test('designActions: changelog lines in (from, to] and public-api diffs (added and removed names)', () => {
  const changelog = '# x\n\n## v0.3.0\n\n- Design-layer action: adopt ctx.ui.newThing\n\n## v0.2.0\n\nDesign-layer action: none\n\n## v0.1.0\n\nDesign-layer action: ancient\n';
  assert.deepEqual(parseChangelog(changelog).map((s) => s.version), ['0.3.0', '0.2.0', '0.1.0']);
  const a = designActions({ fromVersion: '0.1.0', toVersion: '0.3.0', changelogText: changelog, apiPairs: [] });
  assert.deepEqual(a, ['v0.3.0: adopt ctx.ui.newThing']);
  const b = designActions({
    fromVersion: '0.1.0', toVersion: '0.2.0', changelogText: '',
    apiPairs: [{ label: 'storefront', before: { ShopCommerce: ['a', 'b'], config: ['showPrices'] }, after: { ShopCommerce: ['a', 'c'], config: ['showPrices', 'newKey'] } }]
  });
  assert.ok(b.some((x) => /NEW ShopCommerce\.c/.test(x)));
  assert.ok(b.some((x) => /NEW config\.newKey/.test(x)));
  assert.ok(b.some((x) => /REMOVED ShopCommerce\.b/.test(x)));
  assert.deepEqual(designActions({ fromVersion: '0.1.0', toVersion: '0.2.0', changelogText: '', apiPairs: [{ label: 'x', before: { a: [1] }, after: { a: [1] } }] }), []);
});

test('plan(): merchant-owned and design files never appear, even if the template changed them', () => {
  const m = editedMerchant();
  const tpl = newTemplate();
  const mine = JSON.parse(read(m.dir, 'template.json'));
  const theirs = JSON.parse(read(tpl, 'template.json'));
  const files = ['public/config.js', 'public/app.js', 'admin/design/tokens.css', 'wrangler.jsonc', 'public/commerce/cart.js'];
  const p = plan({ mine, theirs, fromRoot: tpl, root: m.dir, mineTracked: files, theirsFiles: files });
  assert.deepEqual([...p.add, ...p.change], ['public/commerce/cart.js']);
  assert.deepEqual(p.remove, []);
});

test('sync-core rolls everything back when the merchant\'s own guards fail after the sync', () => {
  const m = editedMerchant();
  // a design file that breaks the admin design guard (committed by the merchant on purpose)
  write(m.dir, 'admin/design/parts/bad.js', 'export default function bad() { return fetch("/x"); }\n');
  git(m.dir, 'add', '-A'); git(m.dir, 'commit', '-q', '-m', 'bad design');
  const tpl = newTemplate();
  const before = git(m.dir, 'rev-parse', 'HEAD').out;
  const r = sync(m.dir, tpl, '--yes');
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /SYNC FAILED, every file was restored/);
  assert.equal(git(m.dir, 'status', '--porcelain', '--untracked-files=all').out.trim(), '', 'working tree must be exactly as before');
  assert.equal(git(m.dir, 'rev-parse', 'HEAD').out, before);
  assert.equal(read(m.dir, '.template-version').trim(), '0.1.0');
  assert.doesNotMatch(read(m.dir, 'public/commerce/cart.js'), /core change/);
  assert.equal(existsSync(path.join(m.dir, 'scripts/lib/extra.mjs')), false);
});

test('a second sync to the same version is refused; a further newer one works (chain 0.1 -> 0.2 -> 0.3)', () => {
  const m = editedMerchant();
  const t2 = newTemplate('0.2.0');
  assert.equal(sync(m.dir, t2, '--yes').status, 0);
  git(m.dir, 'add', '-A'); git(m.dir, 'commit', '-q', '-m', 'sync 0.2.0');
  assert.equal(sync(m.dir, t2, '--yes').status, 2);
  const t3 = newTemplate('0.3.0', (d) => write(d, 'public/commerce/cart.js', read(d, 'public/commerce/cart.js') + '\n// v3 only\n'));
  const r = sync(m.dir, t3, '--yes');
  assert.equal(r.status, 0, r.out);
  assert.match(read(m.dir, 'public/commerce/cart.js'), /v3 only/);
  assert.equal(read(m.dir, '.template-version').trim(), '0.3.0');
});
