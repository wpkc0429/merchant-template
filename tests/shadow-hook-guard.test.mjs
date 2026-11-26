// The core dialogs live in a CLOSED shadow root in production. Browser e2e suites reach them only through ONE test-only hook
// (admin/e2e/lib/shadow-hook.mjs, installed by hookBrowser in the TEST browser). This test makes sure no hook, wrapper, patch or open root
// leaks into the shipped code (it reads SOURCE TOKENS, not a fixed name list) and that every suite that launches a browser uses the hook.
// A mutation check proves the scanner catches the ways attachShadow could be wrapped, reassigned or opened. Template-only.
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

/** Tokens without comments: strings and template literals are one token each (id / str / p). */
function tokens(src) {
  const out = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out.push({ t: 'str', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_$]/.test(c)) { let j = i; while (j < n && /[\w$]/.test(src[j])) j++; out.push({ t: 'id', v: src.slice(i, j) }); i = j; continue; }
    out.push({ t: 'p', v: c });
    i++;
  }
  return out;
}
const same = (toks, i, want) => want.every((w, k) => toks[i + k] && (w.t ? toks[i + k].t === w.t && (w.v === undefined || toks[i + k].v === w.v) : toks[i + k].v === w));

/**
 * Problems in one production source. The ONLY permitted mention of attachShadow is `.attachShadow({ mode: "closed" })`; anything that could wrap,
 * reassign, redefine, build by string or open a shadow root is reported.
 */
export function scanProduction(src) {
  const toks = tokens(src);
  const problems = [];
  const hasAttach = toks.some((x) => x.t === 'id' && x.v === 'attachShadow');
  let calls = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'id' && t.v === 'attachShadow') {
      if (same(toks, i - 1, ['.', 'attachShadow', '(', '{', { t: 'id', v: 'mode' }, ':', { t: 'str', v: 'closed' }, '}', ')'])) calls++;
      else problems.push(`attachShadow used other than as .attachShadow({ mode: "closed" }) near token ${i}`);
    }
    if (t.t === 'str') {
      // adjacent string pieces joined with + ("op" + "en", "attach" + "Shadow")
      let joined = t.v, j = i;
      while (toks[j + 1] && toks[j + 1].v === '+' && toks[j + 2] && toks[j + 2].t === 'str') { joined += toks[j + 2].v; j += 2; }
      if (/attachshadow|shadowroot/i.test(joined)) problems.push(`a string names attachShadow / ShadowRoot: ${joined.slice(0, 40)}`);
      if (hasAttach && joined.trim().toLowerCase() === 'open') problems.push('the string "open" (a shadow root mode)');
      if (joined !== t.v) i = j;
    }
    if (t.t === 'id' && /^(defineProperty|defineProperties|setPrototypeOf)$/.test(t.v) && toks[i + 1] && toks[i + 1].v === '(') {
      let depth = 0, arg = [];
      for (let k = i + 1; k < toks.length; k++) { if (toks[k].v === '(') depth++; else if (toks[k].v === ')') { if (--depth === 0) break; } else if (depth === 1 && toks[k].v === ',') break; if (k > i + 1) arg.push(toks[k].v); }
      if (arg.some((a) => /prototype|Element|Node|EventTarget|Document|window|globalThis|Object$|Shadow/i.test(a))) problems.push(`${t.v}( on a platform prototype or global: ${arg.join('').slice(0, 40)}`);
    }
    if (t.t === 'id' && t.v === 'prototype' && toks[i - 1] && toks[i - 1].v === '.' && toks[i + 1] && toks[i + 1].v === '.' && toks[i + 2] && toks[i + 2].t === 'id' && toks[i + 3] && toks[i + 3].v === '=' && toks[i + 4] && toks[i + 4].v !== '=') {
      problems.push(`assignment to .prototype.${toks[i + 2].v}`);
    }
    if (t.t === 'id' && t.v === '__proto__') problems.push('__proto__');
    if (t.t === 'id' && t.v === 'mode' && toks[i + 1] && toks[i + 1].v === ':' && toks[i + 2] && toks[i + 2].t === 'id' && toks[i - 1] && toks[i - 1].v === '{' && toks[i + 3] && toks[i + 3].v === '}' && toks[i - 2] && toks[i - 2].v === '(') {
      problems.push('a variable as the shadow root mode');
    }
  }
  return { problems, calls };
}

test('production code has no test hook, no patched or open shadow root, and creates exactly one CLOSED root', () => {
  const prod = ['lib', 'core', 'ui', 'design', 'design-defaults'].flatMap((d) => walk(path.join(ADMIN, d))).concat(['app.js', 'index.html', 'config.js', 'config-loader.js'].map((f) => path.join(ADMIN, f)))
    .filter((f) => /\.(js|html)$/.test(f));
  let calls = 0;
  for (const f of prod) {
    const src = read(f);
    assert.doesNotMatch(src, /__roots|__dq\b|__dqa|__shadowHook|shadow-hook|SHADOW_HOOK|__TEST|window\.__test/i, `${path.relative(TEMPLATE, f)} must not know about the test hook`);
    const r = scanProduction(src);
    assert.deepEqual(r.problems, [], `${path.relative(TEMPLATE, f)}: ${r.problems.join('; ')}`);
    calls += r.calls;
  }
  assert.equal(calls, 1, 'exactly one attachShadow call in the whole shipped code');
  assert.match(read(path.join(ADMIN, 'ui/kit.js')), /attachShadow\(\{ mode: "closed" \}\)/);
});

test('mutation check: the scanner reports every way of wrapping, reassigning or opening attachShadow', () => {
  const base = read(path.join(ADMIN, 'ui/kit.js'));
  assert.deepEqual(scanProduction(base).problems, []);
  const mutants = {
    'prototype patch': 'const o = Element.prototype.attachShadow; Element.prototype.attachShadow = function (x) { return o.call(this, { ...x, mode: "open" }); };',
    'defineProperty': 'Object.defineProperty(Element.prototype, "attach" + "Shadow", { value() {} });',
    'defineProperty on a global alias': 'const E = Element; Object.defineProperty(E.prototype, k, { value() {} });',
    'string-built open': 'host.attachShadow({ mode: "op" + "en" });',
    'plain open': 'host.attachShadow({ mode: "open" });',
    'mode variable': 'const m = "closed"; host.attachShadow({ mode: m });',
    'bracket access with a built name': 'Element.prototype["attach" + "Shadow"] = function () {};',
    'a second legitimate-looking call': 'document.createElement("p").attachShadow({ mode: "closed", delegatesFocus: true });',
    'reflect style': 'const f = Element.prototype.attachShadow; f.call(h, { mode: "closed" });',
    'proto': 'Element.prototype.__proto__.x = 1;',
  };
  for (const [name, code] of Object.entries(mutants)) {
    const r = scanProduction(base + '\n' + code);
    assert.ok(r.problems.length > 0 || r.calls !== 1, `the scanner must catch: ${name}`);
  }
});

test('every e2e suite that launches a browser installs the shared shadow hook (except the one deliberate raw browser)', () => {
  const dir = path.join(ADMIN, 'e2e');
  const hook = read(path.join(dir, 'lib/shadow-hook.mjs'));
  assert.match(hook, /mode: 'open'/);
  assert.match(hook, /export function hookBrowser/);
  let suites = 0;
  for (const n of readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const lines = read(path.join(dir, n)).split('\n');
    const launches = lines.map((l, i) => [l, i]).filter(([l]) => /chromium\.launch\(/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    if (!launches.length) continue;
    suites++;
    assert.match(lines.join('\n'), /from "\.\/lib\/shadow-hook\.mjs"/, `${n} imports the hook`);
    for (const [l, i] of launches) assert.ok(/hookBrowser\(/.test(l) || /RAW browser on purpose/.test(lines[i - 1] || ''), `${n}: every launch is hooked: ${l.trim().slice(0, 80)}`);
  }
  assert.ok(suites >= 8, `found ${suites} suites`);
});
