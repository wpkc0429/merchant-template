// Simulates what .github/workflows/guards.yml runs on design branches, using a merchant repo built by new-merchant.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TEMPLATE, cleanup, node, git, read, write, makeMerchant } from './helpers.mjs';

after(cleanup);

const scope = (d, site, base) => node(['scripts/check-scope.mjs', site, '--base', base], d);
const locked = (d, base, head) => node(['scripts/check-locked.mjs', '--base', base, ...(head ? ['--head', head] : [])], d);
const commitAll = (d, msg) => { git(d, 'add', '-A'); git(d, 'commit', '-q', '-m', msg); };

test('workflow file: pure node, no installs, runs every guard, has the branch-protection note', () => {
  const y = readFileSync(path.join(TEMPLATE, '.github/workflows/guards.yml'), 'utf8');
  for (const needle of ['node scripts/check-content-schema.mjs --lint', 'node scripts/check-layers.mjs --check', 'admin/scripts/check-design.mjs', 'admin/scripts/test-guard.mjs', 'scripts/check-scope.mjs', 'scripts/check-locked.mjs', 'design/storefront-*', 'design/admin-*', 'branch protection', 'block direct pushes', 'pull_request', 'push:']) {
    assert.ok(y.includes(needle), needle);
  }
  assert.doesNotMatch(y, /npm (ci|install)|yarn|pnpm|pip install/);
});

test('storefront design branch: design edits pass; locked, config, other-site and root edits fail', () => {
  const m = makeMerchant(); const d = m.dir;
  const base = git(d, 'rev-parse', 'HEAD').out.trim();
  git(d, 'switch', '-c', 'design/storefront-warm');
  write(d, 'public/styles.css', read(d, 'public/styles.css') + '\n/* warm */\n');
  write(d, 'public/assets/new.png', 'x');
  write(d, 'public/content.schema.json', read(d, 'public/content.schema.json').replace('你的商店', '我的店'));
  assert.equal(scope(d, 'storefront', base).status, 0);
  assert.equal(locked(d, base).status, 0);
  commitAll(d, 'design');
  assert.equal(locked(d, base, 'HEAD').status, 0);
  for (const f of ['public/commerce/cart.js', 'public/config.js', 'admin/design/copy.js', 'wrangler.jsonc', 'scripts/check-layers.mjs', 'README.md', 'public/_headers', 'scripts/check-content-schema.mjs']) {
    git(d, 'checkout', '-q', '.');
    write(d, f, read(d, f) + '\n// edit\n');
    const s = scope(d, 'storefront', base);
    assert.equal(s.status, 1, `${f}: ${s.out}`);
    git(d, 'checkout', '--', f);
  }
});

test('admin design branch: only admin/design/** passes', () => {
  const m = makeMerchant(); const d = m.dir;
  const base = git(d, 'rev-parse', 'HEAD').out.trim();
  git(d, 'switch', '-c', 'design/admin-tone');
  write(d, 'admin/design/theme.css', '/* tone */\n.btn { letter-spacing: .02em; }\n');
  assert.equal(scope(d, 'admin', base).status, 0, scope(d, 'admin', base).out);
  write(d, 'public/app.js', read(d, 'public/app.js') + '\n// storefront edit from an admin session\n');
  assert.equal(scope(d, 'admin', base).status, 1);
  git(d, 'checkout', '--', 'public/app.js');
  write(d, 'public/content.schema.json', read(d, 'public/content.schema.json') + ' ');
  assert.equal(scope(d, 'admin', base).status, 1, 'the storefront content schema is not an admin design path');
  git(d, 'checkout', '--', 'public/content.schema.json');
  write(d, 'admin/core/errors.js', read(d, 'admin/core/errors.js') + '\n// core edit\n');
  const r = scope(d, 'admin', base);
  assert.equal(r.status, 1);
});

test('check-locked fails any design/* diff that touches locked paths, manifests, config or template.json', () => {
  const m = makeMerchant(); const d = m.dir;
  const base = git(d, 'rev-parse', 'HEAD').out.trim();
  git(d, 'switch', '-c', 'design/anything');
  for (const f of ['public/commerce/api.js', 'public/config.js', 'admin/lib/api.js', 'admin/design-defaults/copy.js', 'scripts/commerce.manifest.json', 'admin/scripts/core.manifest.json', 'template.json', '.template-version', '.github/workflows/guards.yml', 'CLAUDE.md', '.claude/skills/storefront-design/SKILL.md', 'wrangler.jsonc', 'admin/deploy/Dockerfile', 'public/_headers', 'scripts/check-content-schema.mjs', 'docs/DECISIONS.md', 'admin/core/warnings.js']) {
    write(d, f, read(d, f) + '\n');
    commitAll(d, 'touch ' + f);
    const r = locked(d, base, 'HEAD');
    assert.equal(r.status, 1, `${f}: ${r.out}`);
    assert.ok(r.out.includes(f), f);
    git(d, 'reset', '-q', '--hard', base);
  }
});

test('a branch cannot widen its own scope or shrink the lock list by editing template.json', () => {
  const m = makeMerchant(); const d = m.dir;
  const base = git(d, 'rev-parse', 'HEAD').out.trim();
  git(d, 'switch', '-c', 'design/storefront-sneaky');
  const tj = JSON.parse(read(d, 'template.json'));
  tj.sites.storefront.designPaths.push('public/commerce/'); tj.lockedPaths = [];
  write(d, 'template.json', JSON.stringify(tj, null, 2));
  write(d, 'public/commerce/cart.js', read(d, 'public/commerce/cart.js') + '\n// sneaky\n');
  commitAll(d, 'sneaky');
  assert.equal(scope(d, 'storefront', base).status, 1);
  assert.equal(locked(d, base, 'HEAD').status, 1);
});

test('exit 2 on a bad base ref', () => {
  const m = makeMerchant();
  assert.equal(scope(m.dir, 'storefront', 'no-such-ref').status, 2);
  assert.equal(locked(m.dir, 'no-such-ref', 'HEAD').status, 2);
});
