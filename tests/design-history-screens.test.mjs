// D15 (PR3 of the T1-T4 design history, v0.5.0 unreleased): the default screens exist and everything that makes them reachable is present
// TOGETHER (routes ready, ROUTE_IDS, NAV, view files in both registries, routes.js entries, copy keys), the two registries are identical
// copies, nothing was added to ctx or the guard rules, the release (version, tag) did not happen, and the real-browser e2e runs
// (it skips cleanly without Playwright). Template-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TEMPLATE } from './helpers.mjs';

const f = (p) => readFileSync(path.join(TEMPLATE, p), 'utf8').replace(/\r\n/g, '\n');
const VIEWS = ['views/design-history.js', 'views/design-request.js', 'parts/design-history-parts.js'];

test('D15 is recorded in docs/DECISIONS.md (newest first) and names what is and is not in PR3', () => {
  const lines = f('docs/DECISIONS.md').split('\n');
  const ids = lines.map((l) => /^### (D\d+)\./.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.equal(ids[8], 'D15'); assert.equal(ids[7], 'D16'); assert.equal(ids[6], 'D17'); assert.equal(ids[5], 'D18'); assert.equal(ids[4], 'D19'); assert.equal(ids[3], 'D20'); assert.equal(ids[2], 'D21');
  const start = lines.findIndex((l) => l.startsWith('### D15. T1-T4 PR3'));
  let end = lines.findIndex((l, i) => i > start && /^##/.test(l)); if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n');
  for (const n of ['design-history.js', 'design-request.js', 'ROUTE_IDS', 'allowPreviewLinkOrigin', 'readOnly', 'no new ctx function', 'separate PRs']) assert.ok(body.includes(n), n);
  assert.match(body.trim(), /\.$/);
});

test('routes, ROUTE_IDS, NAV, views, routes.js and copy keys are all present together (all or nothing)', async () => {
  const r = f('admin/core/routes.js');
  const ready = [...r.matchAll(/id: "(design|designRequest)", pattern: "[^"]+", perm: \["design\.view"\], nav: "design", ready: (true|false)/g)];
  assert.equal(ready.length, 2);
  const all = ready.every((m) => m[2] === 'true');
  assert.ok(all || ready.every((m) => m[2] === 'false'), 'both routes flip together');
  const hasNav = /\{ key: "design", icon: "image", href: "#\/design", perm: \["design\.view"\] \}/.test(r);
  const { ROUTE_IDS, ICON_NAMES } = await import('../admin/lib/design-schema.js');
  const inIds = ROUTE_IDS.includes('design') && ROUTE_IDS.includes('designRequest');
  assert.equal(all, hasNav); assert.equal(all, inIds);
  assert.ok(ICON_NAMES.includes('image'));
  for (const dir of ['design', 'design-defaults']) {
    const routes = (await import(`../admin/${dir}/routes.js`)).default;
    assert.equal(all, routes.design === 'views/design-history.js' && routes.designRequest === 'views/design-request.js', dir);
    for (const v of VIEWS) assert.ok(existsSync(path.join(TEMPLATE, 'admin', dir, v)), `${dir}/${v}`);
  }
  const copy = (await import('../admin/design-defaults/copy.js')).default;
  const design = (await import('../admin/design/copy.js')).default;
  for (const k of ['nav.design', 'dh.title', 'dh.claims.title', 'dh.record.title', 'dh.empty.none.title', 'dh.empty.noShots.title', 'dh.empty.storage.title', 'dh.act.review', 'dh.act.cancel', 'dh.nav.pending']) {
    assert.equal(typeof copy[k], 'string', k); assert.equal(design[k], copy[k], k);
  }
  assert.match(copy['dh.claims.title'], /平台未驗證/);
});

test('design and design-defaults are identical copies (the history views, the routes, the shell, theme.css)', () => {
  for (const v of [...VIEWS, 'routes.js', 'views/shell.js', 'theme.css', 'parts/version-preview-section.js']) assert.equal(f(`admin/design/${v}`), f(`admin/design-defaults/${v}`), v);
});

test('the screens use only the safe helpers: no innerHTML / HTML strings, no dialog, no traversal, no storage or fetch; links are plain https or hash', () => {
  for (const v of VIEWS) {
    const code = f(`admin/design-defaults/${v}`).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.|\.closest\(|parentNode|parentElement|childNodes|dispatchEvent|fetch\(|localStorage|sessionStorage|eval\(|new Function/.test(code), v);
    assert.ok(!/h\("dialog"|showModal|popover/.test(code), v);
  }
  const req = f('admin/design-defaults/views/design-request.js');
  assert.match(req, /openDesignReview\(id\)/); assert.match(req, /cancelDesignRequest\(id\)/); assert.match(req, /requestDesignRevert\(id\)/);
  assert.match(req, /rel: "noopener noreferrer"/);
  assert.match(req, /ctx\.route\.state\.readOnly === true/);
  // approve / reject are never drawn by a design view
  assert.ok(!/approveDesign|rejectDesign|head_sha|headSha:/.test(req));
});

test('core additions are data only: route state readOnly and the single preview link slot; no ctx function, no release', () => {
  const app = f('admin/app.js');
  assert.match(app, /state: \{ readOnly: isReadOnly\(\) \}/);
  const dh = f('admin/core/design-history.js');
  assert.match(dh, /allowPreviewLinkOrigin\(request\.previewOrigin \|\| ""\)/);
  const api = JSON.parse(f('admin/lib/public-api.json'));
  assert.equal(api['ctx.data'].filter((n) => /Design/.test(n)).length, 3);
  assert.equal(api['ctx.actions'].filter((n) => /Design/.test(n)).length, 3);
  assert.equal(JSON.parse(f('template.json')).version, '0.5.0');
  const log = f('docs/CORE-CHANGELOG.md');
  assert.match(log, /^## v0\.5\.0 \(2026-11-28\)$/m);
  assert.match(log, /^Design-layer action: adopt the new default history views/m);
});

test('design history screens in a real Chromium (skips cleanly without Playwright)', { timeout: 290000 }, () => {
  const r = spawnSync(process.execPath, [path.join(TEMPLATE, 'admin', 'e2e', 'design-history.mjs')], { encoding: 'utf8', timeout: 280000 });
  process.stdout.write(r.stdout || '');
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
});

test('D16 is recorded (newest first) with the four owner approvals, and the design_enabled gating is in the code, the e2e and both registries', async () => {
  const lines = f('docs/DECISIONS.md').split('\n');
  const start = lines.findIndex((l) => l.startsWith('### D16.'));
  assert.ok(start > 0);
  let end = lines.findIndex((l, i) => i > start && /^##/.test(l)); if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n');
  for (const n of ['ctx.route.state.readOnly', 'designEnabled', 'design_enabled', 'D10', 'lexer escape fix', 'frozen intrinsics', '_headers', '1-second delayed enable', 'separate preview origin', 'scan report', 'check-design', 'FUTURE PRs', 'every screen is AI-redesignable', 'option D', 'no new ctx function', 'out-of-range']) assert.ok(body.includes(n), n);
  assert.match(body.trim(), /\.$/);
  // the field is normalized in the read layer (literal true only) and documented
  assert.match(f('admin/lib/design-history.js'), /designEnabled: own\("design_enabled"\) === true/);
  assert.match(f('admin/docs/DESIGN-LAYER.md'), /designEnabled/);
  assert.match(f('docs/CORE-CHANGELOG.md'), /decision D16/);
  // the shell gates the item on it and the history view shows the calm disabled state; both registries are identical
  const shell = f('admin/design-defaults/views/shell.js');
  assert.match(shell, /st\.designEnabled === true/);
  assert.match(shell, /let designOn = false/);
  const view = f('admin/design-defaults/views/design-history.js');
  assert.match(view, /state\.designEnabled === false/);
  assert.match(view, /dh\.empty\.disabled\.title/);
  assert.match(view, /Math\.ceil\(list\.total/);
  for (const v of ['views/shell.js', 'views/design-history.js', 'copy.js']) assert.equal(f(`admin/design/${v}`), f(`admin/design-defaults/${v}`).replace(/\n  "vp\.limits".*\n/, '\n').replace(/\n  "nav\.profile".*\n/, '\n'), v);
  const e2e = f('admin/e2e/design-history.mjs');
  for (const n of ['design_enabled: nav gating', 'page=99999999999', 'three rapid next-page clicks']) assert.ok(e2e.includes(n), n);
  assert.match(f('admin/design-defaults/theme.css'), /^\.dh-area \.pager \.btn \{/m);
  assert.ok(!/^\.pager \.btn/m.test(f('admin/design-defaults/theme.css')), 'no global pager rule');
  assert.match(f('admin/lib/design-history.js'), /Object\.hasOwn\(d, k\)/);
  assert.match(shell, /const ordered = /);
  assert.match(view, /last < page/);
  // still no new ctx function, no release
  const api = JSON.parse(f('admin/lib/public-api.json'));
  assert.equal(api['ctx.data'].filter((n) => /Design/.test(n)).length, 3);
  assert.equal(JSON.parse(f('template.json')).version, '0.5.0');
});
