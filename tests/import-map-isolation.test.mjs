// D19 (hardening PR 3, v0.5.0 unreleased): the decision is recorded, the import map, the CSP hash and the canary are wired the way the decision says, the boot-phase
// seals leave no named export of the privileged functions, and the real-browser suite (admin/e2e/import-map.mjs) runs. Template-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TEMPLATE } from './helpers.mjs';

const f = (p) => readFileSync(path.join(TEMPLATE, p), 'utf8').replace(/\r\n/g, '\n');
const MAP_RE = /<script type="importmap">([^<]*)<\/script>/;

test('D19 is recorded (newest first) with the owner approval, the guard rule change, the limits and the unverified browsers', () => {
  const lines = f('docs/DECISIONS.md').split('\n');
  const ids = lines.map((l) => /^### (D\d+)\./.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.equal(ids[0], 'D20'); assert.equal(ids[1], 'D19'); assert.equal(ids[2], 'D18');
  const start = lines.findIndex((l) => l.startsWith('### D19.'));
  let end = lines.findIndex((l, i) => i > start && /^##/.test(l)); if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n');
  for (const n of ['2026-11-28', 'GUARD RULE', 'D10', 'script-src', 'sha256', 'No new ctx function', '/deny/', 'canary', 'lib/canary/probe.js', 'takeApi()', 'lib/boot.js',
    'takePermissions', 'takeSession', 'takeMakeAuth', 'takeDesignActions', 'takeContentActions', 'takeCoreUi', 'not isolation', 'Firefox and Safari are NOT verified', 'POSTPONED',
    'deploy/importmap', 'check-design.mjs --update', 'Preview hosts', 'import-map.mjs', '%2f']) assert.ok(body.includes(n), n);
  assert.match(body.trim(), /\.$/);
  const cl = f('docs/CORE-CHANGELOG.md');
  assert.match(cl, /decision D19/);
  assert.match(cl, /UNRELEASED/);
  assert.match(cl, /Design-layer action: none; no design file in this template imports outside/);
  assert.equal(JSON.parse(f('template.json')).version, '0.4.2', 'template.json is bumped only by the release PR');
  assert.match(f('admin/docs/DESIGN-LAYER.md'), /Import-map isolation \(decision D19/);
  assert.match(f('admin/docs/AI-EDIT-SERVICE-NOTES.md'), /decision D19/);
  assert.match(f('admin/README.md'), /Firefox 與 Safari \*\*未驗證/);
});

test('index.html: ONE inline script, the import map, before the module script; the shipped scopes are exactly the designed ones', () => {
  const html = f('admin/index.html');
  const inline = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/\bsrc=/.test(m[1]));
  assert.equal(inline.length, 1);
  assert.match(inline[0][1], /type="importmap"/);
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'));
  const text = MAP_RE.exec(html)[1];
  assert.ok(!/[\r\n]/.test(text), 'the map is one line so CRLF checkouts hash the same');
  assert.deepEqual(JSON.parse(text), { scopes: {
    '/design/': { '/': '/deny/', '/design/': '/design/', 'https://': '/deny/', 'http://': '/deny/' },
    '/lib/canary/': { '/': '/deny/', '/lib/canary/allowed/': '/lib/canary/allowed/', 'https://': '/deny/', 'http://': '/deny/' } } });
});

test('the CSP hash in nginx.conf.template is the hash of the map text, in the server CSP and in /site-config.js; /deny/ and the percent rule exist', () => {
  const text = MAP_RE.exec(f('admin/index.html'))[1];
  const h = createHash('sha256').update(text, 'utf8').digest('base64');
  const ng = f('admin/deploy/nginx.conf.template').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const csps = [...ng.matchAll(/Content-Security-Policy "([^"]+)"/g)].map((m) => m[1]).filter((c) => c.includes('script-src'));
  assert.equal(csps.length, 2);
  for (const c of csps) assert.ok(c.includes(`script-src 'self' 'sha256-${h}';`), c);
  assert.match(ng, /location \^~ \/deny\/ \{ return 404; \}/);
  assert.ok(ng.includes('if ($request_uri ~* "^[^?]*(%2f|%5c|%2e|//)") { return 404; }'));
  assert.doesNotMatch(ng, /unsafe-inline|unsafe-eval/);
});

test('app.js runs the canary after the seal and the freeze and before the design layer; the design layer is told whether it may load', () => {
  const app = f('admin/app.js');
  const i = (s) => app.indexOf(s);
  assert.ok(i('sealApi()') > 0 && i('lockdownIntrinsics()') > i('sealApi()') && i('await checkIsolation()') > i('lockdownIntrinsics()') && i('await loadDesign({ enabled: iso.ok })') > i('await checkIsolation()'));
  assert.match(app, /showIsolationNotice\(\)/);
  const probe = f('admin/lib/canary/probe.js');
  assert.match(probe, /HTMLScriptElement\.supports\("importmap"\)/);
  assert.match(probe, /import\("\.\/allowed\/ok\.js"\)/);
  assert.match(probe, /import\("\.\/target\.js"\)/);
  assert.match(probe, /fetch\(/, 'the target is fetched first: a denied import of an unreachable file proves nothing');
  assert.match(probe, /reason: "unverifiable"/);
  assert.ok(probe.indexOf('fetch(') < probe.indexOf('import("./target.js")'));
  assert.match(f('admin/lib/design.js'), /switchedOff/);
});

test('boot-phase seals: the privileged factories and mutators are reachable only through take...(), none is exported by name; sealApi() closes lib/boot.js', () => {
  const named = (p) => [...f(p).matchAll(/^export (?:async )?(?:function|const|class|let) (\w+)/gm)].map((m) => m[1]);
  const banned = { 'admin/lib/perm.js': ['setPermissions', 'clearPermissions'], 'admin/lib/session.js': ['loadSession', 'login', 'logout', 'clearSession', 'passwordSetup', 'invitations'],
    'admin/core/auth.js': ['makeAuth'], 'admin/core/design-actions.js': ['createDesignActions'], 'admin/core/content-actions.js': ['createContentActions'],
    'admin/ui/kit.js': ['showCoreDialog', 'confirmDialog', 'allowImageOrigin', 'allowPreviewLinkOrigin'] };
  for (const [p, names] of Object.entries(banned)) for (const n of names) assert.ok(!named(p).includes(n), `${p} must not export ${n}`);
  for (const [p, n] of [['admin/lib/perm.js', 'takePermissions'], ['admin/lib/session.js', 'takeSession'], ['admin/core/auth.js', 'takeMakeAuth'], ['admin/core/design-actions.js', 'takeDesignActions'],
    ['admin/core/content-actions.js', 'takeContentActions'], ['admin/ui/kit.js', 'takeCoreUi']]) assert.ok(named(p).includes(n), `${p} exports ${n}`);
  assert.match(f('admin/lib/api.js'), /export function sealApi\(\) \{ open = false; sealBoot\(\); \}/);
  assert.deepEqual(named('admin/lib/boot.js').sort(), ['capability', 'sealBoot']);
  assert.ok(!/^export (const|let) session = \{/m.test(f('admin/lib/session.js')), 'session is a read-only view, not the mutable object');
});

test('real browser: admin/e2e/import-map.mjs (hostile module, canary, controls) passes (skipped without Playwright)', () => {
  if (!process.env.PLAYWRIGHT_DIR) return;
  const r = spawnSync(process.execPath, [path.join(TEMPLATE, 'admin', 'e2e', 'import-map.mjs')], { encoding: 'utf8', timeout: 580000 });
  assert.equal(r.status, 0, (r.stdout || '').slice(-3000) + (r.stderr || '').slice(-1500));
  assert.match(r.stdout, /import-map browser test OK|SKIP/);
});
