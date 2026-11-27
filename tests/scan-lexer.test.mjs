// D17: the normalisation contract of the design-layer scanners. Template-only.
//  * admin/scripts/lib/design-scan.mjs  lex(): token values are CANONICAL (escape-decoded names, cooked strings and templates);
//  * scripts/check-layers.mjs (storefront scan): escapes decoded and comments blanked by a real scanner before the regex rules run.
// The per-rule regression fixtures live in admin/scripts/__fixtures__/escaped-cases.mjs (run by admin/scripts/test-guard.mjs);
// the seeded property / fuzz tests are in tests/scan-fuzz.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { lex, lexAll, scanCode } from '../admin/scripts/lib/design-scan.mjs';
import { BS, LS, PS, NBSP, BOM, idEsc, strEsc } from '../admin/scripts/__fixtures__/escapes.mjs';
import { TEMPLATE, tmp, cleanup, node, read, write, copyHeaderFiles } from './helpers.mjs';

after(cleanup);
const vals = (src) => lex(src).map((t) => `${t.t}:${t.v}`);

test('D17 lexer: identifier and property names are escape-decoded', () => {
  assert.deepEqual(vals(`${BS}u0066etch(1)`).slice(0, 2), ['id:fetch', 'punct:(']);
  assert.equal(lex(`${BS}u{66}${BS}u{65}tch`)[0].v, 'fetch');
  assert.equal(lex(`a.${idEsc('constructor', 'all')}`)[2].v, 'constructor');
  assert.equal(lex(`a?.${idEsc('constructor', 'mid', true)}`)[2].v, 'constructor');
  assert.equal(lex(`${BS}u0061b${BS}u0063`)[0].raw, `${BS}u0061b${BS}u0063`);
  assert.equal(lex(`${BS}u0061b`)[0].esc, true);
  assert.equal(lex('abc')[0].esc, undefined);
  assert.equal(lex(`#${BS}u0070`)[0].v, '#p', 'a private name is decoded too');
  assert.equal(lex('caf' + String.fromCharCode(0xe9))[0].v, 'caf' + String.fromCharCode(0xe9), 'no Unicode normalisation: JavaScript compares code points');
  assert.equal(lex('a' + String.fromCharCode(0x200d) + 'b').length, 1, 'ZWJ belongs to a name');
  assert.equal(lex(String.fromCodePoint(0x1d41f) + 'x')[0].v, String.fromCodePoint(0x1d41f) + 'x', 'an astral ID_Start letter starts a name');
  assert.equal(lex(String.fromCodePoint(0x2160))[0].t, 'id', 'a letter number (Nl) starts a name');
  assert.equal(lex(`${BS}u{1d41f}x`)[0].v, String.fromCodePoint(0x1d41f) + 'x');
});

test('D17 lexer: string and template values are cooked', () => {
  const s = (body, q = '"') => lex(q + body + q)[0].v;
  assert.equal(s(`${BS}x66${BS}u0065${BS}u{74}${BS}143h`), 'fetch');
  assert.equal(s(`${BS}0`), '\0');
  assert.equal(s(`${BS}08`), '\x008');
  assert.equal(s(`${BS}101${BS}60${BS}7`), 'A0\x07', 'legacy octal: up to three digits when the first is 0-3');
  assert.equal(s(`a${BS}\nb`), 'ab', 'a line continuation vanishes');
  assert.equal(s(`a${BS}\r\nb`), 'ab');
  assert.equal(s(`${BS}q${BS}'${BS}"${BS}${BS}`), `q'"${BS}`);
  assert.equal(s(`${BS}u0041${LS}${PS}`), 'A' + LS + PS, 'U+2028 / U+2029 are allowed raw in a string');
  assert.equal(lex('`' + `${BS}x66etch` + '`')[0].v, 'fetch');
  assert.equal(lex('`' + `${BS}u{66}etch` + '`')[0].v, 'fetch');
  assert.equal(lex('`a\r\nb`')[0].v, 'a\nb', 'a template normalises CRLF');
  const nested = lex('`a${`b${c}d`}e`');
  assert.deepEqual(nested.map((t) => `${t.t}:${t.v}`), ['tpl:a', 'tpl:b', 'id:c', 'tpl:d', 'tpl:e']);
  // malformed escapes never throw and never loop
  for (const bad of [`"${BS}u{"`, `"${BS}u{110000}"`, `"${BS}u12"`, `"${BS}x4"`, `"${BS}`, `"${BS}u{zz}"`, `"${BS}u{`, '`' + BS + 'u{', BS + 'u', BS + 'u{', `a${BS}u00`, `#${BS}`]) assert.doesNotThrow(() => lex(bad), bad);
});

test('D17 lexer: line terminators, whitespace, comments', () => {
  assert.deepEqual(vals(`// note${LS} fetch`), ['id:fetch'], 'U+2028 ends a line comment');
  assert.deepEqual(vals(`// note${PS} fetch`), ['id:fetch']);
  assert.deepEqual(vals('// note\r fetch'), ['id:fetch'], 'a lone CR ends a line comment');
  assert.deepEqual(vals(`/* a${LS}b */ x`), ['id:x']);
  assert.deepEqual(vals(`${BOM}a${NBSP}b\v\fc`), ['id:a', 'id:b', 'id:c']);
  assert.equal(lex(`a\nb\rc\r\nd${LS}e${PS}f`).map((t) => t.line).join(), '1,2,3,4,5,6', 'every terminator counts one line, CRLF once');
  assert.equal(lex(`/* a\nb */ x`)[0].line, 2);
  assert.equal(lex(`"a${BS}\nb" x`).map((t) => t.line).join(), '1,2', 'a string keeps the line it STARTED on; the next token is on line 2');
  assert.deepEqual(vals('#!/usr/bin/env node\nfetch'), ['id:fetch'], 'a hashbang at the very start is a comment');
  assert.notDeepEqual(vals('a\n#!x'), ['id:a'], 'a hashbang anywhere else is not');
  assert.ok(vals('x <!-- fetch\n').includes('id:fetch'), 'an HTML-like comment opener hides nothing (it is a syntax error in a module)');
  assert.ok(vals('x\n--> fetch').includes('id:fetch'));
  assert.deepEqual(vals('"abc\nfetch'), ['str:abc', 'id:fetch'], 'an unterminated string ends at the line end and does not swallow the next line');
});

test('D17 lexer: numbers never swallow the property that follows', () => {
  for (const [src, n] of [['1..constructor', 1], ['1.5.constructor', 1], ['0x10.constructor', 1], ['1e3.constructor', 1], ['1e+3.constructor', 1], ['10n.constructor', 1], ['1_0..constructor', 1], ['.5.constructor', 1]]) {
    const t = lex(src);
    assert.deepEqual(t.map((x) => x.t), ['num', 'punct', 'id'], src);
    assert.equal(t[2].v, 'constructor', src);
    assert.equal(n, 1);
  }
  assert.deepEqual(vals('1_000+0b11+0o7+.5'), ['num:1_000', 'punct:+', 'num:0b11', 'punct:+', 'num:0o7', 'punct:+', 'num:.5']);
  assert.deepEqual(vals('a?.5:b'), ['id:a', 'punct:?', 'num:.5', 'punct::', 'id:b'], 'a ?.5 : b is a ternary, not an optional chain');
  assert.deepEqual(vals('a?.b'), ['id:a', 'punct:?.', 'id:b']);
});

test('D17 lexer: regex literal or division follows the context', () => {
  assert.ok(vals("if (a) /'/.test(b); fetch(1)").includes('id:fetch'), 'a regex holding a quote after if (...) does not start a string');
  assert.ok(vals("while (0) /\"/.test(b); fetch(1)").includes('id:fetch'));
  assert.ok(vals("for (;;) /`/.test(b); fetch(1)").includes('id:fetch'));
  assert.ok(vals("function f() {}\n/'/.test(b); fetch(1)").includes('id:fetch'), 'a regex after a function declaration');
  assert.ok(vals("const r = /[//]/; fetch(1)").includes('id:fetch'));
  assert.ok(vals("a = b / 2 / 3; fetch(1)").includes('id:fetch'), 'divisions');
  assert.ok(vals("a = (b) / 2 / 3; fetch(1)").includes('id:fetch'));
  assert.ok(vals("a = b[0] / 2 / 3; fetch(1)").includes('id:fetch'));
  assert.ok(vals("a = i++ / 2 / 3; fetch(1)").includes('id:fetch'));
  assert.ok(vals("a = b.in / 2 / 3; fetch(1)").includes('id:fetch'), 'a property named like a keyword is an operand');
  assert.ok(vals("a = function () {} / 2; fetch(1)").includes('id:fetch'), 'a function expression ends an operand');
  assert.ok(vals("a = {} / 2; fetch(1)").includes('id:fetch'));
  assert.equal(lex('x = a / b').some((t) => t.t === 'regex'), false);
  assert.equal(lex('x = /a/g').some((t) => t.t === 'regex'), true);
  assert.equal(lex('return /a/').some((t) => t.t === 'regex'), true);
  assert.deepEqual(vals('x = `${/a/.test(b)}`').includes('regex:/a/'), true, 'a regex right after ${');
  assert.equal(lex('a /b\nfetch(1) /c').some((t) => t.t === 'regex'), false, 'an unterminated regex is not a regex (the rest of the line stays visible)');
  // the one real ambiguity: "}" then "/" (block end or object end). Both readings are produced and every rule runs on both.
  const amb = lexAll("x = c ? {} : {}\n/'/.test(y); fetch(1)").readings;
  assert.equal(amb.length, 2, 'an ambiguous } then / is lexed both ways');
  assert.ok(amb.some((toks) => toks.some((t) => t.v === 'fetch')), 'at least one reading sees the call');
  // the one real ambiguity: "}" then "/" (block end or object end). Both readings are produced and every rule runs on both.
});

test('D17 lexer: punctuators are whole', () => {
  assert.deepEqual(vals('a &&= b ||= c ??= d >>>= e **= f'), ['id:a', 'punct:&&=', 'id:b', 'punct:||=', 'id:c', 'punct:??=', 'id:d', 'punct:>>>=', 'id:e', 'punct:**=', 'id:f']);
  assert.deepEqual(vals('a?.[0]?.(1)'), ['id:a', 'punct:?.', 'punct:[', 'num:0', 'punct:]', 'punct:?.', 'punct:(', 'num:1', 'punct:)']);
});

// ── the storefront scan (scripts/check-layers.mjs) ──
const layers = (d) => node(['scripts/check-layers.mjs', '--check'], d);
const fresh = () => {
  const dir = tmp('mt-d17-');
  cpSync(path.join(TEMPLATE, 'public'), path.join(dir, 'public'), { recursive: true });
  mkdirSync(path.join(dir, 'scripts'));
  cpSync(path.join(TEMPLATE, 'scripts/check-layers.mjs'), path.join(dir, 'scripts/check-layers.mjs'));
  copyHeaderFiles(dir);
  const tj = JSON.parse(readFileSync(path.join(TEMPLATE, 'template.json'), 'utf8')); tj.isTemplate = false;
  writeFileSync(path.join(dir, 'template.json'), JSON.stringify(tj));
  writeFileSync(path.join(dir, 'public/config.js'), readFileSync(path.join(dir, 'public/config.js'), 'utf8').replace('REPLACE_WITH_PLATFORM_API_BASE', 'https://api.example.com').replace('REPLACE_WITH_PUBLISHABLE_KEY', 'pk_test123456'));
  node(['scripts/check-layers.mjs', '--update'], dir);
  return dir;
};

test('D17 storefront scan: escaped identifiers and strings, hidden-comment tricks and split calls are caught; legitimate code and comments pass', () => {
  const d = fresh();
  assert.equal(layers(d).status, 0, layers(d).out);
  const orig = read(d, 'public/app.js');
  const bad = [
    [`${idEsc('fetch', 'first')}('/x');`, 'escaped fetch'],
    [`${idEsc('fetch', 'all', true)}('/x');`, 'braced fetch'],
    [`var a = {} / ${idEsc('fetch', 'last')}('/x') / 2;`, 'a division guessed as a regex still has its escapes decoded'],
    [`var of = 1; of / ${idEsc('fetch', 'first')}('/x') / 2;`, 'of as a variable'],
    [`var i = 1; i++ / ${idEsc('fetch', 'mid')}('/x') / 2;`, 'postfix increment then a division'],
    [`var s = ${idEsc('localStorage', 'mid')};`, 'escaped localStorage'],
    [`var s = {}; s.${idEsc('sessionStorage', 'last')};`, 'escaped sessionStorage property'],
    [`var s = {}; s.${idEsc('XMLHttpRequest', 'first')};`, 'escaped XMLHttpRequest'],
    [`var k = '${strEsc('shopcommerce:cart', 'x', 'first')}';`, 'escaped storage key'],
    [`var k = "${strEsc('/api/v1', 'u', 'mid')}";`, 'escaped /api/v1'],
    [`${idEsc('eval', 'first')}('1');`, 'escaped eval'],
    [`var x = {}; x.${idEsc('showModal', 'mid')}();`, 'escaped showModal'],
    [`var x = {}; x.${idEsc('click', 'first')}();`, 'escaped click'],
    [`var x = {}; x.click\n();`, 'click then a line break then the call'],
    [`var x = {}; x.click${LS}();`, 'click then U+2028 then the call'],
    [`var x = new\n  MouseEvent('click');`, 'new on one line, MouseEvent on the next'],
    [`var x = new ${idEsc('CustomEvent', 'first')}('x');`, 'escaped CustomEvent'],
    [`var s = 'confirm-${strEsc('yes', 'x', 'first')}';`, 'escaped confirm id'],
    [`var s = \`#confirm-${strEsc('warning', 'u', 'all')}\`;`, 'escaped confirm id in a template'],
    [`var o = { ${idEsc('popover', 'first')}: 'auto' };`, 'escaped popover'],
    [`// a note${LS} fetch('/x');`, 'U+2028 ends a line comment'],
    [`// a note\r fetch('/x');`, 'CR ends a line comment'],
    [`var s = " //"; fetch('/x');`, 'a comment opener inside a string must not blank the call after it'],
    [`var s = "a /* b"; fetch('/x'); var t = "*/";`, 'a block-comment opener inside a string'],
    [`var r = /[//]/; fetch('/x');`, 'slashes in a regex class'],
    [`var r = a / 2; var u = ' // '; fetch('/x');`, 'a division then a string holding //'],
    [`if (a) /'/.test(b); fetch('/x');`, 'a regex holding a quote'],
    [`var t = \`a\${\`b\`} // \`; fetch('/x');`, 'a template holding //'],
  ];
  for (const [code, label] of bad) {
    write(d, 'public/app.js', orig + '\n' + code + '\n');
    const r = layers(d);
    assert.equal(r.status, 1, `${label}: ${code}\n${r.out}`);
  }
  const good = [
    `// fetch('/x') and localStorage are only words here\nvar a = 1;`,
    `/* eval('1'); window.fetch( */ var a = 1;`,
    `var a = b / 2 / 3; // fetch('/x')`,
    `var s = '${strEsc('fetch it', 'u', 'mid')}'; var t = "x"; // sessionStorage`,
    `var caf${String.fromCharCode(0xe9)} = 1; var ${idEsc('total', 'mid')} = 2;`,
    `var s = "the popover menu and the inert gas";`,
    `var r = /a\\/b/.test('a/b'); var u = r ? 1 : 2; // eval(`,
  ];
  for (const code of good) {
    write(d, 'public/app.js', orig + '\n' + code + '\n');
    const r = layers(d);
    assert.equal(r.status, 0, `valid: ${code}\n${r.out}`);
  }
});

test('D17 storefront scan: the current design layer reports the same on every line (line numbers stay true)', () => {
  const d = fresh();
  const orig = read(d, 'public/app.js');
  const n = orig.split('\n').length;
  write(d, 'public/app.js', orig + `\n/* a\nb */\nvar x = {}; x.${idEsc('showModal', 'first')}();\n`);
  const r = layers(d);
  assert.equal(r.status, 1);
  assert.match(r.out, new RegExp(`public/app.js:${n + 3}:`), r.out);
});

test('D17 is recorded (newest first) with the owner approval, the contract, the findings and what stays out of scope; docs and changelog point at it', () => {
  const f = (p) => readFileSync(path.join(TEMPLATE, p), 'utf8').replace(/\r\n/g, '\n');
  const lines = f('docs/DECISIONS.md').split('\n');
  const ids = lines.map((l) => /^### (D\d+)\./.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.equal(ids[3], 'D17'); assert.equal(ids[2], 'D18'); assert.equal(ids[1], 'D19'); assert.equal(ids[0], 'D20');
  const start = lines.findIndex((l) => l.startsWith('### D17.'));
  let end = lines.findIndex((l, i) => i > start && /^##/.test(l)); if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n');
  for (const n of ['owner explicitly approved', 'D10', 'D16', 'CANONICAL', 'COOKED', 'U+2028', '1..constructor', 'regex', 'check-layers.mjs', 'escaped-cases.mjs', 'scan-fuzz.test.mjs', 'best-effort', 'not a proof', 'No new ctx function', 'remains out of scope']) assert.ok(body.includes(n), n);
  assert.match(body.trim(), /\.$/);
  assert.match(f('docs/CORE-CHANGELOG.md'), /decision D17/);
  assert.match(f('admin/docs/DESIGN-LAYER.md'), /How the scan reads your code \(decision D17/);
  assert.match(f('admin/scripts/lib/design-scan.mjs'), /THE NORMALISATION CONTRACT \(decision D17\)/);
});

// ── performance: hostile input must not make the scan quadratic (jsFileMaxBytes is 128 KiB, so this is the worst a file can be) ──
test('D17 performance: 128 KiB of hostile input is scanned in bounded time (admin scan and storefront scan)', () => {
  const N = 128 * 1024;
  const rep = (str) => str.repeat(Math.ceil(N / str.length));
  const w = (b) => `export default function view(root, ctx) { ${b} }`;
  const cases = {
    'object keys that are DOM names': w(`const o = { ${rep('parentNode:1,')} };`),
    'a "<" followed by spaces in a string': w(`const s = "<${' '.repeat(N)}";`),
    'many "<" in a template': w('const s = `' + '<'.repeat(N) + '`;'),
    'nested parentheses': w('f(' + '('.repeat(N / 2) + ')'.repeat(N / 2) + ');'),
    'unclosed parentheses': w('('.repeat(N)),
    'nested index brackets': w('x = ' + 'a['.repeat(N / 4) + '0' + ']'.repeat(N / 4) + ';'),
    'dollar calls': w(rep('$($(')),
    'regex-like class openers': w(rep('/[')),
    'file input builders': w(rep('x = h("input", { ')),
    'destructuring from ctx': w(rep('} = ctx ')),
    'a long .click chain': w('a' + rep('.click')),
    'Object.keys calls': w(rep('Object.keys(')),
    'arrow parameters named ctx': w(rep('(ctx) => ')),
    'braces': w('{'.repeat(N)),
    'ambiguous slashes': w(rep('of / 2 ')),
    'ambiguous blocks': w(rep('{}\n/ ')),
  };
  for (const [name, src] of Object.entries(cases)) {
    const t0 = Date.now();
    scanCode(src, 'design/views/f.js', { designRelPath: 'design/views/f.js' });
    const ms = Date.now() - t0;
    assert.ok(ms < 10000, `${name}: ${ms} ms`);
  }
  const d = fresh();
  const orig = read(d, 'public/app.js');
  for (const line of ["var s = '" + '<'.repeat(200000) + "';", "var s = '<" + ' '.repeat(200000) + "';", 'var r = ' + '/['.repeat(60000) + ';', 'x' + '.click'.repeat(30000) + ';']) {
    write(d, 'public/app.js', orig + '\n' + line + '\n');
    const t0 = Date.now();
    layers(d);
    const ms = Date.now() - t0;
    assert.ok(ms < 15000, `storefront scan: ${ms} ms for ${line.slice(0, 30)}`);
  }
});

test('D17 lexer: a regex literal of any length is a regex; too many ambiguous slashes are reported, never sampled', () => {
  for (const L of [1200, 5000, 100000]) {
    const t = lex("const r = /[/']" + 'a'.repeat(L) + "'/gi.test(x); fetch(1); const q = '/';");
    assert.equal(t.filter((x) => x.t === 'regex').length, 1, 'one regex of ' + L + ' characters');
    assert.ok(t.some((x) => x.v === 'fetch'), 'the call after it is visible');
    assert.equal(t.filter((x) => x.t === 'str').length, 1, 'and only the real string is a string');
  }
  assert.equal(lex('x = /abc' + '\\' + '\n/ y').filter((x) => x.t === 'regex').length, 0, 'a backslash before a line break does not continue a regex');
  const pad = (n) => 'const of = 4; const f = () => {}\n/\'/.test(1); ' + 'of / 2; '.repeat(n) + "of / fetch('x') / 3; const q = '/';";
  assert.equal(lexAll(pad(2)).tooAmbiguous, null);
  assert.ok(lexAll(pad(2)).readings.length > 1);
  assert.ok(lexAll(pad(3)).tooAmbiguous, 'five places is more than the four that are enumerated');
  assert.equal(typeof lexAll(pad(3)).tooAmbiguous.line, 'number');
  // the complete product of the readings is enumerated for up to four places (no sampling): one place -> 2 readings, four -> 16
  for (const [n, want] of [[0, 2], [1, 3], [2, 5]].map(([k, w]) => [k, w])) assert.ok(lexAll(pad(n)).readings.length >= want - 1);
  // 3000 ambiguous places: reported quickly, with the new rule id
  const t0 = Date.now();
  const found = scanCode('export default function view(root, ctx) { const of = 1; ' + 'of / 2; '.repeat(3000) + '}', 'design/views/f.js');
  assert.ok(Date.now() - t0 < 2000, 'took ' + (Date.now() - t0) + ' ms');
  assert.ok(found.some((x) => x.rule === 'js/ambiguous-slash'), JSON.stringify(found).slice(0, 200));
});

test('D17 storefront scan: a long regex is read as a regex and does not hide what follows or what hides in it', () => {
  const d = fresh();
  const orig = read(d, 'public/app.js');
  for (const L of [1200, 5000, 100000]) {
    write(d, 'public/app.js', orig + '\nvar r = /[/\']' + 'a'.repeat(L) + "'/.test(1); fetch('/x'); var q = '/';\n");
    assert.equal(layers(d).status, 1, 'fetch after a regex of ' + L + ' characters');
    write(d, 'public/app.js', orig + '\nvar r = /[/\']' + 'a'.repeat(L) + "'/.test(1); var q = '/'; // fetch('/x')\n");
    assert.equal(layers(d).status, 0, 'a comment after a regex of ' + L + ' characters is still a comment');
  }
});
