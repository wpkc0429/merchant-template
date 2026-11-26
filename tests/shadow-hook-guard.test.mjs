// The core dialogs live in a CLOSED shadow root in production. Browser e2e suites reach them only through ONE test-only hook
// (admin/e2e/lib/shadow-hook.mjs, installed by hookBrowser in the TEST browser). This test makes sure the hook never leaks into the
// shipped code and that every suite that launches a browser uses it. Template-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { TEMPLATE } from './helpers.mjs';

const ADMIN = path.join(TEMPLATE, 'admin');
const read = (p) => readFileSync(p, 'utf8');
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const f = path.join(dir, n);
    if (statSync(f).isDirectory()) walk(f, out); else out.push(f);
  }
  return out;
}

test('production code has no test hook and still creates a CLOSED shadow root', () => {
  const prod = ['lib', 'core', 'ui', 'design', 'design-defaults'].flatMap((d) => walk(path.join(ADMIN, d))).concat(['app.js', 'index.html', 'config.js', 'config-loader.js'].map((f) => path.join(ADMIN, f)))
    .filter((f) => /\.(js|html|css)$/.test(f));
  for (const f of prod) {
    const src = read(f);
    assert.doesNotMatch(src, /__roots|__dq\b|__dqa|__shadowHook|shadow-hook|SHADOW_HOOK|__TEST|window\.__test/i, `${path.relative(TEMPLATE, f)} must not know about the test hook`);
  }
  const kit = read(path.join(ADMIN, 'ui/kit.js'));
  assert.match(kit, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.doesNotMatch(kit, /mode:\s*["']open["']/);
  assert.equal([...kit.matchAll(/attachShadow\(/g)].length >= 1, true);
});

test('every e2e suite that launches a browser installs the shared shadow hook (except the one deliberate raw browser)', () => {
  const dir = path.join(ADMIN, 'e2e');
  const hook = read(path.join(dir, 'lib/shadow-hook.mjs'));
  assert.match(hook, /mode: 'open'/);
  assert.match(hook, /export function hookBrowser/);
  let suites = 0;
  for (const n of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const src = read(path.join(dir, n));
    const launches = src.split('\n').filter((l) => /chromium\.launch\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    if (!launches.length) continue;
    suites++;
    assert.match(src, /from "\.\/lib\/shadow-hook\.mjs"/, `${n} imports the hook`);
    for (const l of launches) {
      const idx = src.split('\n').indexOf(l);
      const prev = src.split('\n')[idx - 1] || '';
      assert.ok(/hookBrowser\(/.test(l) || /RAW browser on purpose/.test(prev), `${n}: every launch is hooked: ${l.trim().slice(0, 80)}`);
    }
  }
  assert.ok(suites >= 8, `found ${suites} suites`);
});
