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

test('docs/DECISIONS.md is structurally intact: one title, unique headings, no repeated paragraph, D12 whole', () => {
  const dec = readFileSync(path.join(TEMPLATE, 'docs/DECISIONS.md'), 'utf8').replace(/\r\n/g, '\n');
  const lines = dec.split('\n');
  assert.equal(lines[0], '# Decisions');
  const heads = lines.filter((l) => /^#{1,3} /.test(l));
  assert.equal(heads.filter((l) => l === '# Decisions').length, 1, 'exactly one title');
  assert.equal(new Set(heads).size, heads.length, 'every heading is unique: ' + heads.filter((h, i) => heads.indexOf(h) !== i).join(' | '));
  const ids = heads.map((h) => /^### (D\d+)\./.exec(h)).filter(Boolean).map((m) => m[1]);
  assert.deepEqual(ids.slice(0, 4), ['D14', 'D13', 'D12', 'D11'], 'newest first');
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('D12') && ids.includes('D11') && ids.includes('D10'));
  const paras = dec.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 80);
  assert.equal(new Set(paras).size, paras.length, 'no paragraph appears twice');
  // D12 is whole: between its heading and the next ## heading: the three numbered items (complete paragraphs) and the T1-T4 paragraph
  const start = lines.findIndex((l) => l.startsWith('### D12.'));
  let end = lines.findIndex((l, i) => i > start && /^##/.test(l)); if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end);
  const items = body.filter((l) => /^[1-3]\. \*\*/.test(l));
  assert.equal(items.length, 3, 'three numbered items');
  for (const it of items) assert.match(it, /[.)]\s*$/, 'item ends in a full stop: ' + it.slice(0, 40));
  assert.ok(items[0].includes('js/dialog-api') && items[1].includes('js/synthetic-input') && items[2].includes('js/dom-escape'));
  assert.match(items[2], /items 1 and 2\.$/, 'item 3 is complete (not cut off at the $ of ctx.ui.$)');
  assert.ok(items[2].includes('`ctx.ui.$` and `$$`'), 'item 3 keeps its ctx.ui.$ text');
  assert.equal(body.filter((l) => l.startsWith('**Follow-up T1-T4 plan')).length, 1);
  assert.equal(body.filter((l) => l.startsWith('**Guard rule tightening')).length, 1);
  // no line starts mid-sentence (the symptom of a replace that swallowed text)
  for (const l of body) assert.ok(l === '' || /^[A-Z0-9*\-|`#>(\[]/.test(l) || /^\s/.test(l), 'a line starts mid-sentence: ' + l.slice(0, 50));
});

test('D12 is recorded in docs/DECISIONS.md and the v0.4.2 changelog and template.json agree', () => {
  const dec = readFileSync(path.join(TEMPLATE, 'docs/DECISIONS.md'), 'utf8');
  assert.match(dec, /^### D12\. /m);
  assert.match(dec, /2026-11-27/);
  for (const id of ['listDesignRequests', 'getDesignRequest', 'getDesignState', 'openDesignReview', 'requestDesignRevert', 'cancelDesignRequest', 'approveDesign', 'approveRevert', 'rejectDesign', 'cancelDesign', 'revertDesign', 'WARNED_CONFIRM_IDS']) assert.ok(dec.includes(id), id);
  assert.match(dec, /checkbox/); assert.match(dec, /fetch->blob/);
  const log = readFileSync(path.join(TEMPLATE, 'docs/CORE-CHANGELOG.md'), 'utf8');
  assert.match(log, /^## v0\.4\.2$/m);
  assert.match(log, /^Design-layer action: the stricter scan newly flags/m);
  assert.equal(JSON.parse(readFileSync(path.join(TEMPLATE, 'template.json'), 'utf8')).version, '0.4.2');
});

test('D12 runtime restrictions exist in the core: untrusted events ignored, h() throws, ctx.ui.$ scoped, showDialog hands back only close', () => {
  const kit = readFileSync(path.join(TEMPLATE, 'admin/ui/kit.js'), 'utf8');
  assert.match(kit, /ev\.isTrusted !== true/);
  assert.match(kit, /class DesignError/);
  assert.match(kit, /name === "dialog"\) throw new DesignError/);
  assert.match(kit, /TOP_LAYER_ATTRS/);
  assert.match(kit, /export function designQuery\b/);
  assert.match(kit, /return \{ close \}/);
  assert.doesNotMatch(kit, /h\("dialog"/);
  const ctx = readFileSync(path.join(TEMPLATE, 'admin/core/context.js'), 'utf8');
  assert.match(ctx, /\$: kit\.designQuery, \$\$: kit\.designQueryAll/);
  assert.match(ctx, /showDialog: kit\.designShowDialog/);
});

test('check-layers 5d scans code forms of popover / inert, not the word in copy text', () => {
  const d = fresh();
  const orig = read(d, 'public/app.js');
  write(d, 'public/app.js', orig + "\nvar copy = 'The inert gas and the popover menu are described here';\n");
  assert.equal(layers(d).status, 0, layers(d).out);
  for (const code of ["var o = { popover: 'auto' };", "var x = {}; x.inert = true;", "var s = '<p popover=auto>x</p>';", "var x = {}; x.setAttribute('inert', '');"]) {
    write(d, 'public/app.js', orig + '\n' + code + '\n');
    assert.equal(layers(d).status, 1, code);
  }
});
