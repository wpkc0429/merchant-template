// CI runner for the real-browser suites that need NOTHING but this repository (stub / fake API + static servers; no platform stack, no secrets).
// Template-only. Run:  REQUIRE_BROWSER_TESTS=1 PLAYWRIGHT_DIR=<dir with node_modules/playwright> node tests/e2e/ci-browser.mjs
//
// It runs each suite below as its own process and FAILS when a suite exits non-zero, prints a SKIP line, or executes zero checks, and when the
// total of executed (non-skipped) checks is not above zero. With REQUIRE_BROWSER_TESTS=1 the suites themselves already fail instead of skipping
// (admin/e2e/lib/require-browser.mjs); this runner is the second, independent assertion that browser tests really ran.
// Suites that still need the throwaway ecommerce stack (private repo) are NOT here: see docs/DECISIONS.md D22.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
// [suite, minimum executed checks] = about 80% of the count when this was written (69, 39, 89, 73, 63, 97, 185, 32): a suite that exits early after a few ok lines fails.
export const SUITES = [
  ['admin/e2e/preview-banner.mjs', 55],
  ['admin/e2e/d12-runtime.mjs', 31],
  ['admin/e2e/import-map.mjs', 83],
  ['admin/e2e/hardening.mjs', 58],
  ['admin/e2e/profile.mjs', 50],
  ['admin/e2e/design-history.mjs', 77],
  ['admin/e2e/design-review.mjs', 148],
  ['tests/e2e/content-storefront.mjs', 25],
  ['tests/e2e/html-scan-differential.mjs', 1],   // D24: the index.html tokenizer against the real browser (prints one ok line; a mismatch exits non-zero)
];

if (process.env.REQUIRE_BROWSER_TESTS !== '1') { console.error('ci-browser: REQUIRE_BROWSER_TESTS=1 must be set (a CI run may not skip)'); process.exit(1); }
if (!process.env.PLAYWRIGHT_DIR) { console.error('ci-browser: PLAYWRIGHT_DIR must point at a folder with node_modules/playwright'); process.exit(1); }

let total = 0; const bad = []; const rows = [];
for (const [rel, min] of SUITES) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [resolve(ROOT, rel)], { cwd: ROOT, encoding: 'utf8', timeout: 600000, maxBuffer: 256 * 1024 * 1024, env: process.env });
  const out = (r.stdout || '') + (r.stderr || '');
  const executed = (out.match(/^\s+ok\s/gm) || []).length;
  const skipped = /^SKIP /m.test(out);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  total += executed;
  const problem = r.status !== 0 ? `exit ${r.status ?? r.signal}` : skipped ? 'SKIPPED' : executed < min ? `only ${executed} checks executed (minimum ${min})` : '';
  console.log(`${problem ? 'FAIL' : 'ok  '} ${rel}: ${executed} checks executed, ${secs}s${problem ? ' <- ' + problem : ''}`);
  rows.push(`| ${rel} | ${executed} | ${problem || 'ok'} |`);
  if (problem) { bad.push(rel); console.log(out.split('\n').slice(-60).join('\n')); }
}
console.log(`\nexecuted browser checks: ${total}`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['### Real-browser suites (executed checks: ' + total + ')', '', '| suite | checks executed | result |', '|---|---|---|', ...rows, ''].join('\n'));
if (total <= 0) bad.push('total executed checks is 0');
if (bad.length) { console.error(`ci-browser: FAILED (${bad.join(', ')})`); process.exit(1); }
console.log('ci-browser: all suites ran and passed');
