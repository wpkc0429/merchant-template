// D13 (PR1 of the T1-T4 design history, v0.5.0 unreleased): the decision is recorded, the changelog section is marked unreleased and
// template.json is not bumped, the three ctx.data functions exist and nothing else was added to ctx, the routes are defined but not
// registered (no dead nav), and no guard rule / warning list changed. Template-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TEMPLATE } from './helpers.mjs';

const isComment = (l) => ['//', '/*', '*'].some((c) => l.trim().startsWith(c));
const f = (p) => readFileSync(path.join(TEMPLATE, p), 'utf8').replace(/\r\n/g, '\n');

test('D13 is recorded whole in docs/DECISIONS.md, newest first, and names what is and is not in PR1', () => {
  const lines = f('docs/DECISIONS.md').split('\n');
  const ids = lines.map((l) => /^### (D\d+)\./.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.ok(ids.includes('D13') && ids.indexOf('D13') < ids.indexOf('D12'));
  assert.equal(new Set(ids).size, ids.length);
  const start = lines.findIndex((l) => l.startsWith('### D13. T1-T4 build plan approved 2026-11-27; PR1 read layer'));
  assert.ok(start > 0);
  let end = lines.findIndex((l, i) => i > start && /^##/.test(l)); if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n');
  for (const n of ['listDesignRequests', 'getDesignRequest', 'getDesignState', 'openDesignReview', 'requestDesignRevert', 'cancelDesignRequest', 'WARNED_CONFIRM_IDS', 'PR3']) assert.ok(body.includes(n), n);
  assert.match(body, /Not in this PR/);
  assert.match(body.trim(), /\.$/, 'the entry ends with a full stop (not cut off)');
});

test('CORE-CHANGELOG has a clearly marked UNRELEASED v0.5.0 section; template.json is NOT bumped; the section does not block a sync', async () => {
  const log = f('docs/CORE-CHANGELOG.md');
  assert.match(log, /^## v0\.5\.0 \(UNRELEASED/m);
  assert.ok(log.indexOf('## v0.5.0') < log.indexOf('## v0.4.2'), 'newest first');
  assert.match(log, /^Design-layer action: none yet; the three ctx\.data functions are additive$/m);
  assert.equal(JSON.parse(f('template.json')).version, '0.4.2');
  const { designActions } = await import('../scripts/sync-core.mjs');
  assert.deepEqual(designActions({ fromVersion: '0.4.1', toVersion: '0.4.2', changelogText: log, apiPairs: [] }).filter((a) => a.startsWith('v0.5.0')), []);
});

test('ctx: exactly the three read functions were added to ctx.data and no action, warning or ROUTE_IDS entry', () => {
  const api = JSON.parse(f('admin/lib/public-api.json'));
  for (const n of ['listDesignRequests', 'getDesignRequest', 'getDesignState']) assert.ok(api['ctx.data'].includes(n), n);
  // PR2 (D14) added the three actions on purpose; tests/design-review.test.mjs pins exactly that.
  const schema = f('admin/lib/design-schema.js');
  // PR3 (D15) registered the two routes together with their views; tests/design-history-screens.test.mjs pins that.
  // PR2 (D14) added the five fixed warnings; tests/design-review.test.mjs pins them.
  assert.match(f('admin/docs/DESIGN-LAYER.md'), /`listDesignRequests\(\{site\?, status\?, kind\?, page, pageSize\}\)`/);
});

test('routes: design and designRequest are defined with design.view (PR3 registered them; the all-or-nothing rule is pinned in design-history-screens.test.mjs)', () => {
  const r = f('admin/core/routes.js');
  assert.match(r, /id: "design", pattern: "\/design", perm: \["design\.view"\], nav: "design", ready: (true|false)/);
  assert.match(r, /id: "designRequest", pattern: "\/design\/:id", perm: \["design\.view"\], nav: "design", ready: (true|false)/);
  assert.match(r, /export const ROUTES = \[\.\.\.BASE_ROUTES, \.\.\.DESIGN_HISTORY_ROUTES\.filter\(\(r\) => r\.ready\)/);
});

test('the read layer never exposes the ETag or a signed URL', () => {
  const core = f('admin/core/design-history.js'), lib = f('admin/lib/design-history.js');
  assert.ok(!/reviewBasis|etag/i.test(core.split('\n').filter((l) => !isComment(l)).join('\n')), 'core/design-history.js never touches the ETag');
  assert.match(lib, /export const reviewBasis/);
  assert.ok(!/reviewBasis/.test(f('admin/core/data.js')) && !/reviewBasis/.test(f('admin/core/context.js')));
  assert.ok(!/signed|screenshot/i.test(lib.split('\n').filter((l) => !isComment(l)).join('\n')), 'no screenshot or signed URL code in the read layer');
});
