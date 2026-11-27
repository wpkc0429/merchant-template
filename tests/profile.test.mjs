// D21 (personal profile): the decision record, what the design layer did NOT get, and the real-browser suite (skips cleanly without Playwright).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TEMPLATE } from './helpers.mjs';

const f = (p) => readFileSync(path.join(TEMPLATE, p), 'utf8').replace(/\r\n/g, '\n');

test('D21 is recorded (newest first) with the owner approval, the validation, the sealed API, the light-DOM decision, the entry points and what the design layer gets', () => {
  const lines = f('docs/DECISIONS.md').split('\n');
  const ids = lines.map((l) => /^### (D\d+)\./.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.equal(ids[0], 'D23'); assert.equal(ids[1], 'D22'); assert.equal(ids[2], 'D21'); assert.equal(ids[3], 'D20');
  const start = lines.findIndex((l) => l.startsWith('### D21.'));
  let end = lines.findIndex((l, i) => i > start && /^##/.test(l)); if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n');
  for (const n of ['2026-11-27', 'all as recommended', 'No new `ctx` function', 'ROUTE_IDS', 'core/profile.js', 'ui/profile.js', 'lib/profile.js', 'CleanDisplayName', 'Luhn', 'takeProfileApi', 'sealApi()',
    'Light DOM or closed shadow root', 'styles.css', 'nav.profile', 'sessionStorage', 'design.view', 'preview host', 'ctx.nav.items', 'test-profile.mjs', 'e2e/profile.mjs', 'no copy key']) assert.ok(body.includes(n), n);
  assert.match(body.trim(), /\.$/);
  for (const l of body.split('\n')) assert.ok(l === '' || /^[A-Z0-9*\-|`#>(\[]/.test(l), 'a line starts mid-sentence: ' + l.slice(0, 50));
  const cl = f('docs/CORE-CHANGELOG.md');
  assert.ok(/Personal profile \(decision D21/.test(cl) && /core\/profile-display-name/.test(cl));
  assert.ok(cl.indexOf('Personal profile (decision D21') < cl.indexOf('\n## v0.4.2\n'), 'the entry belongs to the unreleased v0.5.0 section');
  assert.match(f('admin/docs/DESIGN-LAYER.md'), /personal profile page \(decision D21/);
  assert.match(f('README.md'), /D21/);
  assert.equal(JSON.parse(f('template.json')).version, '0.4.2', 'no version bump before the release PR');
});

test('the design layer gained nothing: public-api.json, the route ids and the copy files carry no profile function or key', async () => {
  const api = f('admin/lib/public-api.json');
  assert.doesNotMatch(api, /profile|displayName|display_name/i);
  const { ROUTE_IDS, ICON_NAMES } = await import(pathToFileURL(path.join(TEMPLATE, 'admin/lib/design-schema.js')).href);
  assert.ok(!ROUTE_IDS.includes('profile'));
  assert.ok(ICON_NAMES.includes('profile'));
  for (const file of ['admin/design/copy.js', 'admin/design-defaults/copy.js']) assert.doesNotMatch(f(file), /"pf\./, `${file} has no pf.* key`);
  assert.match(f('admin/design-defaults/copy.js'), /"nav\.profile": "個人資料"/);
  assert.doesNotMatch(f('admin/design/copy.js'), /"nav\.profile"/, 'nav.profile is a FIXED text, like vp.limits');
  const shell = f('admin/design-defaults/views/shell.js');
  assert.equal(shell, f('admin/design/views/shell.js'), 'the shipped design shell is the default shell');
  assert.match(shell, /profileItem/);
});

test('the profile page and its API stay out of reach: no export by name, no design import, no storage or network in core/ui', () => {
  const lib = f('admin/lib/profile.js');
  assert.match(lib, /export const takeProfileApi = capability\(/);
  assert.doesNotMatch(lib, /export (async )?function (loadMe|saveName)/);
  for (const file of ['admin/core/profile.js', 'admin/ui/profile.js']) assert.doesNotMatch(f(file), /fetch\s*\(|sessionStorage|localStorage|\/api\/v1|console\./, file);
  assert.match(f('admin/app.js'), /def\.core === true && def\.id === "profile"/);
});

test('real Chromium: the profile page, the navigation entry and the hint (skips cleanly without Playwright)', { timeout: 280000 }, () => {
  const r = spawnSync(process.execPath, [path.join(TEMPLATE, 'admin', 'e2e', 'profile.mjs')], { encoding: 'utf8', timeout: 270000 });
  process.stdout.write(r.stdout || '');
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
});
