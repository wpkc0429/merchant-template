// D18 (hardening PR 2, v0.5.0 unreleased): the decision is recorded, the sealed API capability and the freeze are wired in the right ORDER, nothing re-exports the
// client or a token, the intrinsic freeze behaves in a plain Node realm, and the real-browser suite (admin/e2e/hardening.mjs) runs. Template-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TEMPLATE } from './helpers.mjs';

const f = (p) => readFileSync(path.join(TEMPLATE, p), 'utf8').replace(/\r\n/g, '\n');
const js = (dir) => readdirSync(path.join(TEMPLATE, 'admin', dir)).filter((x) => x.endsWith('.js')).map((x) => `${dir}/${x}`);

test('D18 is recorded (newest first) with the owner approval, the five items, the residual risks and what is postponed', () => {
  const lines = f('docs/DECISIONS.md').split('\n');
  const ids = lines.map((l) => /^### (D\d+)\./.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.equal(ids[1], 'D21'); assert.equal(ids[2], 'D20'); assert.equal(ids[3], 'D19'); assert.equal(ids[4], 'D18'); assert.equal(ids[5], 'D17');
  const start = lines.findIndex((l) => l.startsWith('### D18.'));
  let end = lines.findIndex((l, i) => i > start && /^##/.test(l)); if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n');
  for (const n of ['2026-11-27', 'D16', 'D10', 'no new ctx function', 'no guard script rule change', 'takeApi()', 'sealApi()', 'lib/lockdown.js', 'override mistake', 'preview_ro',
    'preview_read_only', '__Secure-admin_preview_refresh', 'ADMIN_PREVIEW_ORIGINS', '1 second', 'scan report', 'not verified by the platform', 'not isolation', 'Browser extensions',
    'Options B, C and D', 'postponed', 'hardening.mjs', 'unsafe-eval']) assert.ok(body.includes(n), n);
  assert.match(body.trim(), /\.$/);
  const cl = f('docs/CORE-CHANGELOG.md');
  assert.match(cl, /decision D18/);
  assert.match(cl, /UNRELEASED/);
  assert.equal(JSON.parse(f('template.json')).version, '0.4.2', 'template.json is bumped only by the release PR');
  assert.match(f('admin/docs/DESIGN-LAYER.md'), /Runtime hardening \(decision D18/);
  assert.match(f('admin/docs/DESIGN-LAYER.md'), /Preview hosts: what the operator sets/);
  assert.match(f('admin/README.md'), /ADMIN_PREVIEW_ORIGINS/);
});

test('lib/api.js exports only ApiError, takeApi and sealApi; nothing imports or re-exports a token or the client outside the boot phase', () => {
  const api = f('admin/lib/api.js');
  const exported = [...api.matchAll(/^export (?:async )?(?:function|class|const|let) (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(exported, ['ApiError', 'sealApi', 'takeApi']);
  assert.ok(!/^export \{/m.test(api) && !/export default/.test(api));
  assert.ok(!/get access\(/.test(api), 'no .access getter');
  const all = ['app.js', ...js('lib'), ...js('core'), ...js('ui')];
  const users = all.filter((p) => /takeApi\(\)/.test(f(`admin/${p}`)) && p !== 'lib/api.js').sort();
  assert.deepEqual(users, ['app.js', 'core/auth.js', 'lib/catalog.js', 'lib/content.js', 'lib/design-history.js', 'lib/design-review.js', 'lib/members.js', 'lib/orders.js', 'lib/profile.js', 'lib/reports.js', 'lib/session.js', 'lib/team.js', 'lib/upload.js', 'lib/versionpreview.js']);
  // every call happens at module level, never inside a function (that would run after the seal)
  for (const p of users) for (const l of f(`admin/${p}`).split('\n')) if (/takeApi\(\)/.test(l) && !/^\s*\/\//.test(l)) assert.match(l, /^(const|import) /, `${p}: takeApi() must be called at module level: ${l}`);
  for (const p of all) {
    const s = f(`admin/${p}`).replace(/\/\/.*$/gm, '');
    assert.ok(!/import\s*\{[^}]*\btokens\b/.test(s), `${p} imports tokens`);
    assert.ok(!/export\s*\{[^}]*\b(api|apiRaw|publicApi|refreshTokens|restoreSession)\b/.test(s), `${p} re-exports the client`);
    assert.ok(!/export (?:const|function|async function) (api|apiRaw|publicApi|refreshTokens|restoreSession|tokens)\b/.test(s), `${p} exports the client`);
    if (p !== 'lib/design.js' && p !== 'lib/canary/probe.js') assert.ok(!/\bimport\s*\(/.test(s), `${p} has a dynamic import (it could evaluate after the seal)`);
  }
});

test('app.js seals the API, then freezes the intrinsics, then loads the design layer (in that order)', () => {
  const app = f('admin/app.js');
  const boot = app.slice(app.indexOf('async function boot()'));
  const i = (s) => boot.indexOf(s);
  assert.ok(i('sealApi()') > 0 && i('sealUpload()') > i('sealApi()') && i('lockdownIntrinsics()') > i('sealUpload()') && i('await loadDesign({ enabled: iso.ok })') > i('lockdownIntrinsics()'));
  assert.equal([...app.matchAll(/loadDesign\(/g)].length, 1);
});

test('lockdownIntrinsics() in a plain realm: poisoning throws, instance assignment of name / toString still works, the report is sane', () => {
  const url = 'file:///' + path.join(TEMPLATE, 'admin/lib/lockdown.js').replace(/\\/g, '/');
  const code = [
    `import { lockdownIntrinsics } from ${JSON.stringify(url)};`,
    'const before = { then: Promise.prototype.then, parse: JSON.parse, push: Array.prototype.push, call: Function.prototype.call };',
    'const r = lockdownIntrinsics(); lockdownIntrinsics();',
    'const out = {};',
    "const t = (n, f) => { try { f(); out[n] = 'no throw'; } catch { out[n] = 'throws'; } };",
    "t('then', () => { Promise.prototype.then = () => 1; });",
    "t('parse', () => { JSON.parse = () => 1; });",
    "t('push', () => { Array.prototype.push = () => 1; });",
    "t('call', () => { Function.prototype.call = () => 1; });",
    "t('getter', () => Object.defineProperty(Object.prototype, 'x', { get() { return 1; } }));",
    "t('pollute', () => { Object.prototype.polluted = 1; });",
    "t('proto toString', () => { Object.prototype.toString = () => 'x'; });",
    "t('iterator', () => { Object.getPrototypeOf([][Symbol.iterator]()).next = () => 1; });",
    "t('error name on the prototype', () => { Error.prototype.name = 'x'; });",
    "class MyErr extends Error { constructor(m) { super(m); this.name = 'MyErr'; } }",
    "const e = new MyErr('boom'); const plain = {}; plain.toString = () => 'mine'; plain.valueOf = () => 7; plain.constructor = 'c';",
    "const te = new TypeError('t'); te.name = 'Renamed'; te.message = 'again';",
    "out.ok = e.name === 'MyErr' && e.message === 'boom' && String(plain) === 'mine' && +plain === 7 && plain.constructor === 'c' && te.name === 'Renamed' && te.message === 'again';",
    'out.intact = before.then === Promise.prototype.then && before.parse === JSON.parse && before.push === Array.prototype.push && before.call === Function.prototype.call;',
    'out.frozen = [Object.prototype, Function.prototype, Array.prototype, Promise.prototype, Promise, JSON, Reflect, Map.prototype, Object.getPrototypeOf([][Symbol.iterator]())].every(Object.isFrozen);',
    "out.report = typeof r.frozen === 'number' && r.frozen > 20 && Array.isArray(r.locked);",
    "out.arrays = [1, 2, 3].map((x) => x * 2).join() === '2,4,6' && [...new Set([1, 1, 2])].length === 2 && JSON.stringify(JSON.parse('{\"a\":[1]}')) === '{\"a\":[1]}' && (await Promise.all([1, Promise.resolve(2)])).join() === '1,2';",
    'console.log(JSON.stringify(out));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  for (const k of ['then', 'parse', 'push', 'call', 'getter', 'pollute', 'proto toString', 'iterator', 'error name on the prototype']) assert.equal(out[k], 'throws', k);
  assert.deepEqual([out.ok, out.intact, out.frozen, out.report, out.arrays], [true, true, true, true, true]);
});

test('the review dialog: the approve delay is 1000 ms and the scan report uses core text only', () => {
  const ui = f('admin/ui/design-review.js');
  assert.match(ui, /export const DELAY_MS = 1000;/);
  assert.match(ui, /waiting\(\)/);
  const ft = f('admin/lib/fixed-text.js');
  for (const k of ['rv.scan.heading', 'rv.scan.unverified', 'rv.scan.rules', 'rv.scan.sha', 'rv.scan.shaMismatch', 'rv.scan.fileList', 'rv.delay', 'pv.readOnly', 'pv.expired', 'pv.scopeMissing']) assert.ok(ft.includes(`"${k}"`), k);
  for (const c of [f('admin/design/copy.js'), f('admin/design-defaults/copy.js')]) for (const k of ['rv.scan', 'rv.delay', 'pv.readOnly', 'pv.expired', 'pv.scopeMissing']) assert.ok(!c.includes(`"${k}`), k);
});

test('hardening in a real Chromium: sealed API, frozen intrinsics, preview host, approve delay, scan report (skips cleanly without Playwright)', { timeout: 590000 }, () => {
  const r = spawnSync(process.execPath, [path.join(TEMPLATE, 'admin', 'e2e', 'hardening.mjs')], { encoding: 'utf8', timeout: 580000 });
  process.stdout.write(r.stdout || '');
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
});

test('review follow-up: enumeration freeze, captured natives, aria-disabled countdown, distinct preview messages, display-only guard (D18 item 6)', () => {
  const lock = f('admin/lib/lockdown.js');
  assert.match(lock, /Object\.getOwnPropertyNames\(g\)/, 'the global object is enumerated');
  assert.ok(!/const CLASSES = \[/.test(lock), 'no hand-written class list');
  assert.match(lock, /export const EXCEPTIONS = Object\.freeze\(\["heic2any"\]\)/);
  // the core's own checks use the captured natives, never a live global lookup
  for (const p of ['ui/design-review.js', 'ui/kit.js', 'ui/preview-banner.js']) {
    const s = f(`admin/${p}`).replace(/\/\/.*$/gm, '');
    assert.ok(!/\bperformance\.now\b/.test(s) && !/\bgetComputedStyle\(/.test(s) && !/\bwindow\.matchMedia\b/.test(s) && !/[^.\w]requestAnimationFrame\(/.test(s), `${p} uses a live global`);
    assert.match(s, /lib\/natives\.js/, p);
  }
  const ui = f('admin/ui/design-review.js');
  assert.match(ui, /"aria-disabled": "true"/);
  assert.ok(!/aria-live": "polite", "data-testid": "confirm-rv-delay"/.test(ui), 'the countdown is not a live region');
  const api = f('admin/lib/api.js');
  assert.match(api, /"preview_scope"/);
  assert.match(f('admin/lib/fixed-text.js'), /"rv\.delay\.over"/);
  const d = f('docs/DECISIONS.md');
  for (const n of ['enumerates every own property', 'does not block approval', 'lib/natives.js', 'aria-disabled', 'EXCEPTIONS']) assert.ok(d.includes(n), n);
  assert.match(f('admin/docs/DESIGN-LAYER.md'), /does not block the person from approving/);
});

test('window accessors: the viewport is read through getters captured at boot, and the lockdown makes every window accessor read-only (D18 item 6g)', () => {
  const nat = f('admin/lib/natives.js');
  assert.match(nat, /export const viewport/);
  for (const p of ['ui/kit.js', 'ui/preview-banner.js']) {
    const s = f(`admin/${p}`).replace(/\/\/.*$/gm, '');
    assert.ok(!/\binnerWidth\b|\binnerHeight\b/.test(s), `${p} reads the viewport through a live global`);
    assert.match(s, /viewport\(\)/, p);
  }
  assert.match(f('admin/lib/lockdown.js'), /set: undefined, enumerable: d\.enumerable, configurable: false/);
  assert.match(f('docs/DECISIONS.md'), /WindowProperties/);
  assert.match(f('admin/docs/DESIGN-LAYER.md'), /named-properties object/);
});
