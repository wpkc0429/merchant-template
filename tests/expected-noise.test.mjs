// The ONE allowance for the canary's expected 404 in the browser e2e suites (admin/e2e/lib/expected-noise.mjs, D19): exactly that URL, status 404, error type,
// once per load; every other /deny/ hit still counts as a console error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TEMPLATE } from './helpers.mjs';

const { isCanary404, canaryNoise, CANARY_DENY_PATH, isHttpFailure } = await import(pathToFileURL(path.join(TEMPLATE, 'admin/e2e/lib/expected-noise.mjs')).href);
const O = 'http://admin.example.test:1234';
const msg = (type, text, url) => ({ type: () => type, text: () => text, location: () => ({ url }) });
const L404 = 'Failed to load resource: the server responded with a status of 404 (Not Found)';
const MAIN = { main: true };
const navReq = (over = {}) => ({ isNavigationRequest: () => true, frame: () => MAIN, redirectedFrom: () => null, ...over });
const fakePage = () => { const h = {}; return { on: (e, f) => { h[e] = f; }, mainFrame: () => MAIN, load: () => h.load && h.load(), nav: (r = navReq()) => h.request(r) }; };

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

test('canaryNoise allows ONE per main-frame document load; other /deny/ hits are never swallowed', () => {
  const p = fakePage(), ign = canaryNoise(p);
  const c = () => msg('error', L404, O + '/deny/lib/canary/target.js');
  p.nav();
  assert.equal(ign(c()), true);
  assert.equal(ign(c()), false, 'a second one in the same load is a failure');
  assert.equal(ign(msg('error', L404, O + '/deny/lib/design.js')), false);
  assert.equal(ign(msg('error', L404, O + '/deny/anything')), false);
  p.nav();
  assert.equal(ign(c()), true, 'a new document load may log it once again');
  assert.equal(ign(c()), false);
  const q = fakePage(), ign2 = canaryNoise(q);
  assert.equal(ign2(c()), true, 'a page that was already loaded gets one allowance');
  assert.equal(ign2(c()), false);
});

test('canaryNoise does not depend on the order of the load event and the canary message (the race found in bouquet-next)', () => {
  const c = () => msg('error', L404, O + '/deny/lib/canary/target.js');
  // the old implementation restarted its allowance on "load": document 1 loads, ITS canary 404 is logged after that load event, document 2's canary 404 is
  // logged before document 2's load event: the old code counted the second one as an error.
  const oldImpl = () => { let seen = false; return { onLoad: () => { seen = false; }, ign: (m) => { if (seen) return false; seen = true; return true; } }; };
  const o = oldImpl();
  o.onLoad(); assert.equal(o.ign(c()), true); /* doc 2 */ assert.equal(o.ign(c()), false, 'the old logic fails in this order (this is the bug)');
  const p = fakePage(), ign = canaryNoise(p);
  p.nav(); p.load(); assert.equal(ign(c()), true);         // document 1: load event first, canary after it
  p.nav(); assert.equal(ign(c()), true, 'document 2: the canary before its load event is still its one allowed message'); p.load();
  assert.equal(ign(c()), false, 'but a second one for document 2 is an error');
  // a late canary message of the previous document, delivered after the next navigation request started, does not make the next one an error
  const r = fakePage(), ign3 = canaryNoise(r);
  r.nav(); r.nav(); assert.equal(ign3(c()), true); assert.equal(ign3(c()), true); assert.equal(ign3(c()), false);
});

test('canaryNoise counts only navigations of the main frame that are not redirect hops', () => {
  const c = () => msg('error', L404, O + '/deny/lib/canary/target.js');
  const p = fakePage(), ign = canaryNoise(p);
  p.nav(); assert.equal(ign(c()), true);
  p.nav(navReq({ frame: () => ({ child: true }) }));
  p.nav(navReq({ isNavigationRequest: () => false }));
  p.nav(navReq({ redirectedFrom: () => ({}) }));
  assert.equal(ign(c()), false, 'a sub-frame, a sub-resource or a redirect hop does not allow another canary message');
});

test('the suites that fail on console errors use the shared helper (no private /deny/ allowance left)', () => {
  const dir = path.join(TEMPLATE, 'admin/e2e');
  for (const f of ['smoke.mjs', 'hardening.mjs', 'design-history.mjs']) assert.match(readFileSync(path.join(dir, f), 'utf8'), /canaryNoise\(/, f);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) assert.ok(!/includes\("\/deny\/"\)/.test(readFileSync(path.join(dir, f), 'utf8')), `${f} has a blanket /deny/ filter`);
});

test('isHttpFailure allows exactly one status on exactly one path (the provoked failure of a suite) and nothing else', () => {
  const T = 'Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)';
  assert.ok(isHttpFailure('error', T, O + '/api/v1/admin/me', '/api/v1/admin/me', 422));
  assert.ok(!isHttpFailure('error', T, O + '/api/v1/admin/me', '/api/v1/admin/me', 500), 'another status is a real failure');
  assert.ok(!isHttpFailure('error', T, O + '/api/v1/admin/shops/1/me', '/api/v1/admin/me', 422), 'another path is a real failure');
  assert.ok(!isHttpFailure('error', T, O + '/api/v1/admin/me/x', '/api/v1/admin/me', 422));
  assert.ok(!isHttpFailure('warning', T, O + '/api/v1/admin/me', '/api/v1/admin/me', 422));
  assert.ok(!isHttpFailure('error', 'Refused to connect (status of 4220)', O + '/api/v1/admin/me', '/api/v1/admin/me', 422));
  assert.ok(!isHttpFailure('error', T, '', '/api/v1/admin/me', 422));
});
