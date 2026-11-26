// Runs the real-browser banner test (admin/e2e/preview-banner.mjs) when Playwright + Chromium are available; the script itself
// prints "SKIP ..." and exits 0 when they are not (the template has no npm dependencies; see the header of that file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TEMPLATE } from './helpers.mjs';

test('preview banner in a real Chromium (skips cleanly without Playwright)', { timeout: 280000 }, () => {
  const r = spawnSync(process.execPath, [path.join(TEMPLATE, 'admin', 'e2e', 'preview-banner.mjs')], { encoding: 'utf8', timeout: 270000 });
  process.stdout.write(r.stdout || '');
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
});

test('D12 runtime restrictions in a real Chromium: synthetic input never confirms a core dialog, h() refuses dialog / popover / inert, ctx.ui.$ is scoped (skips cleanly without Playwright)', { timeout: 280000 }, () => {
  const r = spawnSync(process.execPath, [path.join(TEMPLATE, 'admin', 'e2e', 'd12-runtime.mjs')], { encoding: 'utf8', timeout: 270000 });
  process.stdout.write(r.stdout || '');
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
});
