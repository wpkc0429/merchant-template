// The ONE allowance for the canary's expected 404 in the browser e2e suites (admin/e2e/lib/expected-noise.mjs, D19): exactly that URL, status 404, error type,
// once per load; every other /deny/ hit still counts as a console error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TEMPLATE } from './helpers.mjs';

const { isCanary404, canaryNoise, CANARY_DENY_PATH } = await import(pathToFileURL(path.join(TEMPLATE, 'admin/e2e/lib/expected-noise.mjs')).href);
const O = 'http://admin.example.test:1234';
const msg = (type, text, url) => ({ type: () => type, text: () => text, location: () => ({ url }) });
const L404 = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
const fakePage = () => { const h = {}; return { on: (e, f) => { h[e] = f; }, fire: (e) => h[e]() }; };

test('only the canary target URL, status 404, type error is the expected noise', () => {
  assert.equal(CANARY_DENY_PATH, '/deny/lib/canary/target.js');
  assert.ok(isCanary404('error', L404, O + '/deny/lib/canary/target.js'));
  assert.ok(!isCanary404('error', L404, O + '/deny/lib/orders.js'), 'another /deny/ hit is a real failure');
  assert.ok(!isCanary404('error', L404, O + '/deny/lib/canary/target.js/x'));
  assert.ok(!isCanary404('error', L404, O + '/deny/'));
  assert.ok(!isCanary404('error', L404, O + '/lib/canary/target.js'));
  assert.ok(!isCanary404('error', L404, O + '/design/views/home.js'));
  assert.ok(!isCanary404('error', 'Failed to load resource: the server responded with a status of 500 (x)', O + '/deny/lib/canary/target.js'));
  assert.ok(!isCanary404('warning', L404, O + '/deny/lib/canary/target.js'));
  assert.ok(!isCanary404('error', L404, ''));
});

test('canaryNoise allows ONE per load and restarts on load; other /deny/ hits are never swallowed', () => {
  const p = fakePage(), ign = canaryNoise(p);
  assert.equal(ign(msg('error', L404, O + '/deny/lib/canary/target.js')), true);
  assert.equal(ign(msg('error', L404, O + '/deny/lib/canary/target.js')), false, 'a second one in the same load is a failure');
  assert.equal(ign(msg('error', L404, O + '/deny/lib/design.js')), false);
  assert.equal(ign(msg('error', L404, O + '/deny/anything')), false);
  p.fire('load');
  assert.equal(ign(msg('error', L404, O + '/deny/lib/canary/target.js')), true, 'a new document load may log it once again');
});

test('the suites that fail on console errors use the shared helper (no private /deny/ allowance left)', () => {
  const dir = path.join(TEMPLATE, 'admin/e2e');
  for (const f of ['smoke.mjs', 'hardening.mjs', 'design-history.mjs']) assert.match(readFileSync(path.join(dir, f), 'utf8'), /canaryNoise\(/, f);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) assert.ok(!/includes\("\/deny\/"\)/.test(readFileSync(path.join(dir, f), 'utf8')), `${f} has a blanket /deny/ filter`);
});
