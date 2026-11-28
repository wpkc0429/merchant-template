// D24: the HTML tokenizer of the index.html guard scans (scripts/lib/html-scan.mjs, copied byte for byte to admin/scripts/lib/html-scan.mjs), the two
// consumers (admin indexHtmlProblems / inlineScripts, storefront check-layers 5 and 5b) and the scope-aware declaredNames of the storefront network
// scan. The browser comparison is tests/e2e/html-scan-differential.mjs (Playwright). Template-only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TEMPLATE, cleanup, node, read, write, makeMerchant } from './helpers.mjs';
import { scanHtml } from '../scripts/lib/html-scan.mjs';
import { inlineScripts, indexHtmlProblems, importMapHash } from '../admin/scripts/check-design.mjs';

after(cleanup);
const tpl = (p) => readFileSync(path.join(TEMPLATE, p), 'utf8');
const inline = (h) => scanHtml(h).scripts.filter((s) => !s.attrs.has('src'));

test('html-scan: the storefront and the admin copy of the tokenizer are byte for byte the same file', () => {
  assert.equal(tpl('scripts/lib/html-scan.mjs').replace(/\r\n/g, '\n'), tpl('admin/scripts/lib/html-scan.mjs').replace(/\r\n/g, '\n'));
});

test('html-scan: <!-- is NOT a comment inside style, title, textarea, noscript, xmp, iframe, noembed, noframes or a <script src> (the D23 documented bypass is caught)', () => {
  for (const el of ['style', 'title', 'textarea', 'noscript', 'xmp', 'iframe', 'noembed', 'noframes']) {
    const h = `<${el}><!-- </${el}><script>evil()</script> --></${el}>`;
    assert.equal(inline(h).length, 1, h);
    assert.equal(inline(h)[0].text, 'evil()', h);
    const up = h.toUpperCase();
    assert.equal(inline(up).length, 1, up);
  }
  const src = '<script src=a><!-- </script><script>evil()</script> --></script>';
  assert.deepEqual(inline(src).map((s) => s.text), ['evil()']);
  // and the opposite: a real comment hides what is in it
  assert.equal(inline('<!-- <script>evil()</script> -->').length, 0);
  assert.equal(inline('<style>a{}</style><!-- <script>x()</script> -->').length, 0);
});

test('html-scan: comment endings --> and --!>, the empty comments <!--> and <!--->, bogus comments and DOCTYPE', () => {
  assert.equal(inline('<!-- x --!><script>a()</script> -->').length, 1);
  assert.equal(inline('<!--><script>a()</script>').length, 1);
  assert.equal(inline('<!---><script>a()</script>').length, 1);
  assert.equal(inline('<!----><script>a()</script>').length, 1);
  assert.equal(inline('<!-- a -- !> <script>a()</script> -->').length, 0);
  assert.equal(inline('<!--x--!x--><script>a()</script>').length, 1);
  assert.equal(inline('<!x><script>a()</script>').length, 1);
  assert.equal(inline('<?x ><script>a()</script>').length, 1);
  assert.equal(inline('<![CDATA[ <script>a()</script> ]]>').length, 0, 'CDATA outside foreign content is a bogus comment that ends at the first >');
  assert.equal(inline('<!DOCTYPE html><script>a()</script>').length, 1);
  assert.equal(scanHtml('<!-- x').tokens[0].type, 'comment', 'an unterminated comment runs to the end of the input');
  assert.equal(inline('<!-- x <script>a()</script>').length, 0);
});

test('html-scan: script data escaped and double escaped states, end tags with attributes, unterminated scripts', () => {
  assert.deepEqual(inline('<script><!--<script>a()</script>-->b()</script><script>c()</script>').map((s) => s.text), ['<!--<script>a()</script>-->b()', 'c()']);
  assert.deepEqual(inline('<script><!--<script>a()</script></script><script>c()</script>').map((s) => s.text), ['<!--<script>a()</script>', 'c()'], 'double escaped: the first </script> only leaves the double escape');
  assert.deepEqual(inline('<script><!-- </script><script>c()</script>').map((s) => s.text), ['<!-- ', 'c()']);
  assert.deepEqual(inline('<script>a()</script x=y><script>b()</script/>').map((s) => s.text), ['a()', 'b()']);
  assert.deepEqual(inline('<script>a()</scriptx><script>b()</script>').map((s) => s.text), ['a()</scriptx><script>b()']);
  for (const h of ['<script>a()', '<script>a()</script', '<script', '<script type=importmap', '<script>a()</script x']) {
    const s = scanHtml(h).scripts;
    assert.ok(s.length === 1 && s[0].unterminated, h);
  }
  assert.equal(scanHtml('<script>a()</script x').scripts[0].text, 'a()', 'an end tag cut off by the end of the input is not part of the text');
  assert.deepEqual(scanHtml('<script data-x=">" b=\'>\'>a()</script>').scripts.map((s) => [s.text, s.attrs.get('data-x')]), [['a()', '>']]);
});

test('html-scan: elements whose parse the scanner does not model (svg, math, select, frameset) are reported, never silently scanned', () => {
  for (const el of ['svg', 'math', 'select', 'frameset']) assert.deepEqual(scanHtml(`<${el}><style><!--</style><script>x()</script>--></${el}>`).ambiguous.slice(0, 1), [el]);
  assert.deepEqual(scanHtml('<div><!-- <svg> --><p>').ambiguous, []);
  assert.deepEqual(scanHtml('<style><svg></style>').ambiguous, [], 'text inside a raw text element is not a tag');
});

test('check-design (admin): indexHtmlProblems uses the tokenizer; the D23 residual bypass is refused; the real admin/index.html is clean', () => {
  const real = tpl('admin/index.html');
  assert.deepEqual(indexHtmlProblems(real), []);
  assert.ok(importMapHash(real));
  const hide = (extra) => indexHtmlProblems(real.replace('</body>', extra + '\n</body>')).join(' | ');
  for (const extra of [
    '<style><!-- </style><script>evil()</script> --></style>',
    '<title><!-- </title><script>evil()</script> --></title>',
    '<textarea><!-- </textarea><script>evil()</script> --></textarea>',
    '<noscript><!-- </noscript><script>evil()</script> --></noscript>',
    '<script src=a.js><!-- </script><script>evil()</script> --></script>',
    '<!-- x --!><script>evil()</script> -->',
    '<script>evil()'
  ]) assert.match(hide(extra), /no inline script other than the import map|never closed/, extra);
  assert.match(hide('<svg><style><!--</style><script>evil()</script>--></style></svg>'), /contains <svg>/);
  assert.match(hide('<select></select>'), /contains <select>/);
  for (const extra of ['<!-- <script>evil()</script> -->', '<style>a { color: red }</style>', '<script src="x.js"></script>']) assert.equal(hide(extra), '', extra);
  // a forged import map hidden in a raw text element does not count as the import map
  assert.equal(inlineScripts('<style><!--</style><script type=importmap>{}</script>-->').length, 1);
});

test('check-layers (storefront): the tokenizer is used by the inline-script check (5) and the script order check (5b); the real public/index.html is clean', () => {
  const m = makeMerchant();
  const d = m.dir;
  const idx = read(d, 'public/index.html');
  const withBody = (extra) => { write(d, 'public/index.html', idx.replace('</body>', extra + '\n</body>')); const r = node(['scripts/check-layers.mjs', '--check'], d); write(d, 'public/index.html', idx); return r; };
  assert.equal(node(['scripts/check-layers.mjs', '--check'], d).status, 0);
  assert.deepEqual(scanHtml(idx).ambiguous, []);
  for (const extra of ['<style><!-- </style><script>evil()</script> --></style>', '<title><!-- </title><script>evil()</script> --></title>', '<textarea><!-- </textarea><script>evil()</script> --></textarea>', '<noscript><!-- </noscript><script>evil()</script> --></noscript>', '<script src=a.js><!-- </script><script>evil()</script> --></script>']) {
    const r = withBody(extra); assert.match(r.out, /inline <script>/, extra + r.out);
  }
  assert.match(withBody('<svg><style><!--</style><script>x()</script>--></style></svg>').out, /contains <svg>/);
  assert.doesNotMatch(withBody('<!-- <script>x()</script> -->').out, /inline <script>|contains </);
  // 5b: a src inside a comment does not count; an unquoted src does
  const order = (idxText) => { write(d, 'public/index.html', idxText); const r = node(['scripts/check-layers.mjs', '--check'], d); write(d, 'public/index.html', idx); return r; };
  assert.equal(order(idx.replace(/<script src="app.js"><\/script>/, '<script src=app.js></script>')).status, 0);
  assert.doesNotMatch(order(idx.replace(/<script src="app.js"><\/script>/, '<!-- <script src="app.js"></script> -->')).out, /^$/);
  assert.match(order(idx.replace(/<script src="app.js"><\/script>/, '<!-- <script src="app.js"></script> -->')).out, /does not load app\.js/);
});

test('html-scan: mutation tests - removing a tokenizer feature makes the D23 bypass pass again', async () => {
  const src = tpl('scripts/lib/html-scan.mjs');
  const load = async (code) => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const mutations = [
    ['raw text switch removed', (s) => s.replace('state = RCDATA.has(tag.name) ? "rcdata" : RAWTEXT.has(tag.name) ? "rawtext" :', 'state = false ? "rcdata" : false ? "rawtext" :'), '<style><!-- </style><script>evil()</script> --></style>'],
    ['rcdata switch removed', (s) => s.replace('state = RCDATA.has(tag.name) ? "rcdata" :', 'state = false ? "rcdata" :'), '<title><!-- </title><script>evil()</script> --></title>'],
    ['--!> no longer ends a comment', (s) => s.replace('else if (c === ">") { emitComment(i + 1); i++; }\n        else if (c === undefined) emitComment(n);\n        else state = "comment";\n        break;\n      // ── RCDATA', 'else if (c === undefined) emitComment(n);\n        else state = "comment";\n        break;\n      // ── RCDATA'), '<!-- x --!><script>evil()</script> -->'],
    ['<!--> no longer an empty comment', (s) => s.replace('else if (c === ">") { emitComment(i + 1); i++; }\n        else state = "comment";\n        break;\n      case "commentStartDash"', 'else state = "comment";\n        break;\n      case "commentStartDash"'), '<!--><script>evil()</script>-->'],
    ['double escape removed', (s) => s.replace('state = buf === "script" ? "doubleEscaped" : "escaped"; i++; }', 'state = "escaped"; i++; }'), '<script><!--<script>a()</script>-->b()</script><script>c()</script>']
  ];
  for (const [name, mut, html] of mutations) {
    const mutated = mut(src);
    assert.notEqual(mutated, src, name + ': the mutation must change the file');
    const sig = (r) => r.scripts.filter((s) => !s.attrs.has('src')).map((s) => s.text).join('|');
    const good = sig(scanHtml(html));
    const bad = sig((await load(mutated)).scanHtml(html));
    assert.ok(good !== '', name + ': the real tokenizer sees the live script');
    assert.notEqual(bad, good, name + ': the mutated tokenizer must give a different (wrong) answer');
  }
});
