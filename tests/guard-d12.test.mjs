// D12 (v0.4.2): the design-layer scans refuse dialogs, popovers, fullscreen / pointer lock, synthetic input and DOM
// traversal; the decision is recorded. Template-only. The admin scan is covered fixture by fixture in
// admin/scripts/test-guard.mjs (CASES, "D12"); this file covers the storefront scan, the CLI path and the decision text.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TEMPLATE, tmp, cleanup, node, read, write } from './helpers.mjs';

after(cleanup);
const layers = (d) => node(['scripts/check-layers.mjs', '--check'], d);
const fresh = () => {
  const dir = tmp('mt-d12-');
  cpSync(path.join(TEMPLATE, 'public'), path.join(dir, 'public'), { recursive: true });
  mkdirSync(path.join(dir, 'scripts'));
  cpSync(path.join(TEMPLATE, 'scripts/check-layers.mjs'), path.join(dir, 'scripts/check-layers.mjs'));
  const tj = JSON.parse(readFileSync(path.join(TEMPLATE, 'template.json'), 'utf8')); tj.isTemplate = false;
  writeFileSync(path.join(dir, 'template.json'), JSON.stringify(tj));
  writeFileSync(path.join(dir, 'public/config.js'), readFileSync(path.join(dir, 'public/config.js'), 'utf8').replace('REPLACE_WITH_PLATFORM_API_BASE', 'https://api.example.com').replace('REPLACE_WITH_PUBLISHABLE_KEY', 'pk_test123456'));
  node(['scripts/check-layers.mjs', '--update'], dir);
  return dir;
};

test('D12 storefront: the current design layer passes; each forbidden dialog / popover / fullscreen / synthetic-input construct fails with file:line', () => {
  const d = fresh();
  assert.equal(layers(d).status, 0, layers(d).out);
  const orig = read(d, 'public/app.js');
  const bad = [
    "var x = document.createElement('div'); x.showModal();",
    "var x = {}; x.showPopover();",
    "var x = {}; x.hidePopover();",
    "var x = {}; x.togglePopover();",
    "document.body.requestFullscreen();",
    "document.body.requestPointerLock();",
    "var t = '<dialog open>x</dialog>';",
    "var e = document.createElement('dialog');",
    "var t = '<div popover>x</div>';",
    "var t = '<div inert>x</div>';",
    "var b = {}; b.click();",
    "var b = {}; b.dispatchEvent(1);",
    "var f = {}; f.requestSubmit();",
    "var f = {}; f.submit();",
    "var e = new MouseEvent('click');",
    "var e = new KeyboardEvent('keydown');",
    "var e = new Event('x');",
    "var s = '[data-testid=confirm-yes]';"
  ];
  for (const code of bad) {
    write(d, 'public/app.js', orig + '\n' + code + '\n');
    const r = layers(d);
    assert.equal(r.status, 1, code);
    assert.match(r.out, /public\/app\.js:\d+: forbidden in design layer: .*\(D12\)/, code);
  }
  // legitimate constructs still pass: delegation with closest/querySelector on #app, addEventListener('click'), position: fixed text
  write(d, 'public/app.js', orig + "\nvar q = document.getElementById('app').querySelector('[data-act]'); document.addEventListener('click', function (e) { return e.target.closest('[data-act]'); }); var css = 'position:fixed;z-index:9';\n");
  assert.equal(layers(d).status, 0, layers(d).out);
});

test('D12 admin: the real design and design-defaults trees pass the tightened scan with zero violations', () => {
  const r = node(['scripts/check-design.mjs', '--no-layers'], path.join(TEMPLATE, 'admin'));
  assert.equal(r.status, 0, r.out);
});

test('D12 is recorded in docs/DECISIONS.md and the v0.4.2 changelog and template.json agree', () => {
  const dec = readFileSync(path.join(TEMPLATE, 'docs/DECISIONS.md'), 'utf8');
  assert.match(dec, /^### D12\. /m);
  assert.match(dec, /2026-11-27/);
  for (const id of ['listDesignRequests', 'getDesignRequest', 'getDesignState', 'openDesignReview', 'requestDesignRevert', 'cancelDesignRequest', 'approveDesign', 'approveRevert', 'rejectDesign', 'cancelDesign', 'revertDesign', 'WARNED_CONFIRM_IDS']) assert.ok(dec.includes(id), id);
  assert.match(dec, /checkbox/); assert.match(dec, /fetch->blob|fetch → blob|fetch-to-blob/);
  const log = readFileSync(path.join(TEMPLATE, 'docs/CORE-CHANGELOG.md'), 'utf8');
  assert.match(log, /^## v0\.4\.2$/m);
  assert.equal(JSON.parse(readFileSync(path.join(TEMPLATE, 'template.json'), 'utf8')).version, '0.4.2');
});
