// D17: property / fuzz tests for the design-layer scanner (admin/scripts/lib/design-scan.mjs). Template-only. No dependencies.
// Deterministic: a seeded PRNG (mulberry32), default seed below, override with SCAN_FUZZ_SEED / SCAN_FUZZ_ITERATIONS to explore or replay.
// Node itself is the oracle:
//   * vm.Script says every transformed snippet is still SYNTACTICALLY valid (snippets the transforms break are skipped and counted);
//   * for every escaped identifier / string / template the oracle evaluates the escaped spelling and the plain spelling in a sandbox and
//     requires the SAME value (so "semantics-preserving" is proved by the engine, not assumed);
//   * the scanner must then report, on the transformed snippet, every rule it reports on the plain one (or any violation, for the rewrites
//     that legitimately move a name into a string key, which another rule catches), and nothing at all on the allowed snippets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanCode, lex } from '../admin/scripts/lib/design-scan.mjs';
import { IDENT_CONSTRUCTS } from '../admin/scripts/__fixtures__/escaped-cases.mjs';
import { BS, LS, PS, NBSP, BOM } from '../admin/scripts/__fixtures__/escapes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = Object.fromEntries(Object.entries(JSON.parse(readFileSync(path.join(ROOT, 'admin/lib/public-api.json'), 'utf8'))).filter(([k]) => k !== '_comment'));
const SEED = Number(process.env.SCAN_FUZZ_SEED || 0x17d17);
const ITER = Number(process.env.SCAN_FUZZ_ITERATIONS || 4000);

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const makeRng = (seed) => {
  const r = mulberry32(seed);
  return { f: r, int: (n) => Math.floor(r() * n), pick: (a) => a[Math.floor(r() * a.length)], chance: (p) => r() < p };
};

const scan = (body) => scanCode(`export default async function view(root, ctx) { ${body}\n}`, 'design/views/fuzz.js', { api, designRelPath: 'design/views/fuzz.js' });
const rulesOf = (found) => new Set(found.map((x) => x.rule));
const syntaxOk = (body) => { try { new vm.Script(`(async function (root, ctx) { ${body}\n})`); return true; } catch { return false; } };

// ── the oracle for names and literals ──
const sandbox = vm.createContext({});
const evalIn = (code) => vm.runInContext(code, sandbox, { timeout: 200 });
/** Does the escaped spelling name the same property as the plain one? (defineProperty by plain name, read by the escaped spelling.) */
const sameName = (plain, spelled) => {
  const code = `(function () { var o = {}; Object.defineProperty(o, ${JSON.stringify(plain)}, { value: 41 }); return o.${spelled}; })()`;
  try { return evalIn(code) === 41; } catch { return false; }
};
let oracleChecks = 0;

// ── snippets as token lists: the DSL marks the escapable identifier with sentinel characters ──
const S1 = String.fromCharCode(1), S2 = String.fromCharCode(2);
const KEYWORDS = new Set(['new', 'const', 'let', 'var', 'await', 'import', 'function', 'catch', 'try', 'class', 'async', 'in', 'of', 'return', 'if', 'for', 'while', 'else', 'typeof']);
const TOKEN_RE = new RegExp(`${S1}([^${S2}]*)${S2}|[A-Za-z_$][\\w$]*|[0-9]+|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|\\.\\.\\.|&&=|\\|\\|=|\\?\\?=|=>|\\?\\.|\\S`, 'g');
function tokenize(src) {
  const toks = [];
  for (const m of src.matchAll(TOKEN_RE)) {
    if (m[1] !== undefined) toks.push({ k: 'id', v: m[1], esc: true });
    else if (/^[A-Za-z_$]/.test(m[0])) toks.push({ k: 'id', v: m[0], esc: !KEYWORDS.has(m[0]) });
    else if (/^[0-9]/.test(m[0])) toks.push({ k: 'num', v: m[0] });
    else if (/^["']/.test(m[0])) toks.push({ k: 'str', v: m[0] });
    else toks.push({ k: 'p', v: m[0] });
  }
  return toks;
}

const SEPARATORS = [' ', '  ', '\n', '\t', '\r\n', '\r', NBSP, LS, PS, BOM, '\v', '\f', '/* c */', '/*a\nb*/', `/*${LS}${PS}*/`, '// c\n', `// c${LS}`, `// c${PS}`, '// c\r', "/* it's */", '// "q" `t`\n', `/*'*/`, '/* // */'];
const SAFE_EDGE = '()[]{},;"\'';
const mustSeparate = (a, b) => !(SAFE_EDGE.includes(a.v[a.v.length - 1]) || SAFE_EDGE.includes(b.v[0]));

const hex4 = (cp) => cp.toString(16).padStart(4, '0');
function spellIdent(rng, name, p) {
  // escape a random subset of the characters, as \uXXXX or \u{X}; at least the intent is an escape when p is high
  return [...name].map((c) => (rng.chance(p) ? (rng.chance(0.3) ? `${BS}u{${c.codePointAt(0).toString(rng.pick([16, 16, 16]))}}` : `${BS}u${hex4(c.codePointAt(0))}`) : c)).join('');
}

/** Apply a random semantics-preserving transformation to a token list; returns { src, loose, escapedIdents: [[plain, spelled]] }. */
function transform(rng, toks, opts = {}) {
  let t = toks.map((x) => ({ ...x }));
  let loose = false;
  // rewrites: a?.b(...), a["b"] (the name moves into a string; another rule catches it), (f)(...), (0, f)(...)
  for (let i = 1; i < t.length - 1; i++) {
    const x = t[i];
    if (x.k === 'p' && x.v === '.' && t[i + 1].k === 'id' && rng.chance(0.25)) {
      const callNext = t[i + 2] && t[i + 2].v === '(';
      if (callNext && rng.chance(0.6)) { x.v = '?.'; }
      else if (opts.bracket && rng.chance(0.5) && !(t[i - 1] && t[i - 1].v === 'import')) { t.splice(i, 2, { k: 'p', v: '[' }, { k: 'str', v: JSON.stringify(t[i + 1].v), key: t[i + 1] }, { k: 'p', v: ']' }); loose = true; }
    }
  }
  for (let i = 0; i < t.length - 1; i++) {
    const x = t[i];
    if (x.k === 'id' && x.esc && t[i + 1].v === '(' && !(t[i - 1] && (t[i - 1].v === '.' || t[i - 1].v === '?.' || KEYWORDS.has(t[i - 1].v) || t[i - 1].v === 'function')) && rng.chance(0.2)) {
      const wrap = rng.pick([[{ k: 'p', v: '(' }, x, { k: 'p', v: ')' }], [{ k: 'p', v: '(' }, { k: 'num', v: '0' }, { k: 'p', v: ',' }, x, { k: 'p', v: ')' }], [{ k: 'p', v: '(' }, { k: 'p', v: '(' }, x, { k: 'p', v: ')' }, { k: 'p', v: ')' }]]);
      t.splice(i, 1, ...wrap); i += wrap.length - 1;
    }
  }
  const pEsc = rng.pick([0.3, 0.6, 1]);
  const escapedIdents = [];
  const parts = [];
  t.forEach((x, i) => {
    let text = x.v;
    if (x.k === 'id' && x.esc && rng.chance(0.85)) { text = spellIdent(rng, x.v, pEsc); if (text !== x.v) escapedIdents.push([x.v, text]); }
    else if (x.k === 'str' && x.key && rng.chance(0.8)) { // ["name"] with escapes inside the string
      const name = x.key.v;
      text = '"' + [...name].map((c) => (rng.chance(pEsc) ? rng.pick([`${BS}x${c.codePointAt(0).toString(16).padStart(2, '0')}`, `${BS}u${hex4(c.codePointAt(0))}`, `${BS}u{${c.codePointAt(0).toString(16)}}`, `${BS}${c.codePointAt(0).toString(8).padStart(3, '0')}`]) : c)).join('') + '"';
      escapedIdents.push([name, null, text]);
    }
    parts.push(text);
    const next = t[i + 1];
    if (next) {
      const need = mustSeparate({ v: text }, { v: next.v });
      const sepP = rng.pick([0.3, 0.7, 1]);
      parts.push(rng.chance(sepP) ? rng.pick(SEPARATORS) : need ? ' ' : '');
    }
  });
  return { src: parts.join(''), loose, escapedIdents };
}

const checkOracle = (escapedIdents) => {
  for (const [plain, spelled, strSpelled] of escapedIdents) {
    oracleChecks++;
    if (strSpelled) assert.equal(evalIn(strSpelled), plain, `string spelling ${strSpelled}`);
    else assert.ok(sameName(plain, spelled), `identifier spelling ${spelled} must name ${plain}`);
  }
};

// Constructs: every banned category of the D12 rules (see escaped-cases.mjs), plus a few that exercise the lexer around the name.
const CONSTRUCTS = IDENT_CONSTRUCTS.map(([name, rule, build]) => ({ name, src: build(S1 + name + S2) }));
// Statements before a construct that make the lexer's state hard: regex vs division, templates, comments with quotes, blocks.
const PREFIXES = ['', '', 'const a = root.b / 2 / 3;', "if (root) /'/.test('x');", 'while (0) /"/.test(1);', 'function f() {}\n/\'/.test("x");', 'const t = `a${`b${root.c}`}d`;', "const r = /[//]/;", 'const n = 1_000 + 0x1f + .5 + 1e3;', "const s = '//', u = \"/*\";", 'let i = 0; const q = i++ / 2 / 3;', 'const o = { a: 1 }; const v = o.a / 2;', "const w = root.in / 2 / 3;", 'class A { #p = 1; m() { return this.#p; } }', 'const x = root?.y?.[0];', '/* \' */', '// it\'s\n'];

test('D17 fuzz: forbidden constructs are flagged with the same rule in every transformed spelling (seeded)', (t) => {
  const rng = makeRng(SEED);
  let ran = 0, skipped = 0, loose = 0;
  const byRule = {};
  for (let n = 0; n < ITER; n++) {
    const c = rng.pick(CONSTRUCTS);
    const prefix = rng.pick(PREFIXES);
    const plainBody = prefix + ' ' + c.src.split(S1).join('').split(S2).join('');
    const want = rulesOf(scan(plainBody));
    assert.ok(want.size > 0, `the plain construct must be flagged: ${plainBody}`);
    const tr = transform(rng, tokenize(c.src), { bracket: true });
    const body = prefix + ' ' + tr.src;
    if (!syntaxOk(body)) { skipped++; continue; }
    checkOracle(tr.escapedIdents);
    const got = rulesOf(scan(body));
    if (tr.loose) { loose++; assert.ok(got.size > 0, `a bracket rewrite must still be flagged (any rule): ${JSON.stringify(body)}`); }
    else for (const r of want) assert.ok(got.has(r), `${r} missing for ${JSON.stringify(body)} (plain: ${JSON.stringify(plainBody)}; got ${[...got].join(',')})`);
    ran++; byRule[c.name] = (byRule[c.name] || 0) + 1;
  }
  assert.ok(ran > ITER * 0.8, `too many transformed snippets were invalid JavaScript (${skipped} of ${ITER})`);
  t.diagnostic(`seed ${SEED} (0x${SEED.toString(16)}): ${ITER} iterations, ${ran} checked (${loose} bracket rewrites), ${skipped} skipped as invalid JavaScript, ${oracleChecks} identifier/string spellings proved equal by the engine, ${Object.keys(byRule).length} constructs`);
});

// Allowed code: the same transformations must not make the scanner complain.
const ALLOWED = [
  `const ${S1}total${S2} = 1; return ${S1}total${S2} + 1;`,
  `const ${S1}fetchCount${S2} = 1, ${S1}myWindow${S2} = 2; return ${S1}fetchCount${S2} + ${S1}myWindow${S2};`,
  `return ${S1}ctx${S2}.t("home.greeting", { shop: "x" });`,
  `root.append(${S1}ctx${S2}.ui.h("p", { class: "muted" }, "x"));`,
  `if (${S1}ctx${S2}.can("order.view")) ${S1}ctx${S2}.data.listOrders({}).then((r) => r.orders.map((o) => o.id));`,
  `const { ${S1}ui${S2} } = ctx; return ${S1}ui${S2}.h("p");`,
  `const ${S1}el${S2} = ctx.ui.h("p"); root.append(${S1}el${S2});`,
  `const ${S1}items${S2} = [1, 2, 3]; return ${S1}items${S2}[0] + ${S1}items${S2}.length;`,
  `root.${S1}textContent${S2} = "plain text";`,
  `const ${S1}fn${S2} = (a) => a * 2; return ${S1}fn${S2}(2);`,
  `return root.${S1}children${S2}.length;`,
  `const ${S1}role${S2} = { role: "dialog" }; return ${S1}role${S2};`,
  `const ${S1}price${S2} = root.${S1}dataset${S2}.price / 100; return ${S1}price${S2};`,
];

test('D17 fuzz: allowed code stays allowed under every transformation (seeded)', (t) => {
  const rng = makeRng(SEED ^ 0x5a5a);
  let ran = 0, skipped = 0;
  const n = Math.round(ITER / 2);
  for (let k = 0; k < n; k++) {
    const src = rng.pick(ALLOWED), prefix = rng.pick(PREFIXES);
    const plain = prefix + ' ' + src.split(S1).join('').split(S2).join('');
    assert.deepEqual(scan(plain), [], `the plain snippet must be clean: ${plain}`);
    const tr = transform(rng, tokenize(src), { bracket: false });
    const body = prefix + ' ' + tr.src;
    if (!syntaxOk(body)) { skipped++; continue; }
    checkOracle(tr.escapedIdents);
    assert.deepEqual(scan(body), [], `allowed code was flagged: ${JSON.stringify(body)}`);
    ran++;
  }
  assert.ok(ran > n * 0.8, `too many invalid snippets (${skipped} of ${n})`);
  t.diagnostic(`seed 0x${(SEED ^ 0x5a5a).toString(16)}: ${n} iterations, ${ran} checked, ${skipped} skipped`);
});

// ── literals: the lexer's cooked value must equal the engine's ──
test('D17 fuzz: string and template literal values equal what the engine computes (seeded)', (t) => {
  const rng = makeRng(SEED ^ 0xa5a5);
  const piece = (tpl) => rng.pick([
    () => rng.pick(['a', 'fetch', ' ', 'Z', '-', 'confirm-yes', '</', '%']),
    () => `${BS}x${rng.int(256).toString(16).padStart(2, '0')}`,
    () => `${BS}u${hex4(rng.int(0xd800))}`,
    () => `${BS}u{${rng.int(0x10ffff + 1).toString(16)}}`,
    () => `${BS}u{${'0'.repeat(rng.int(4))}${(0x41 + rng.int(26)).toString(16)}}`,
    () => rng.pick([`${BS}n`, `${BS}t`, `${BS}r`, `${BS}b`, `${BS}f`, `${BS}v`, `${BS}0`, `${BS}'`, `${BS}"`, `${BS}${BS}`, `${BS}q`, `${BS}/`, `${BS}${BS}u0041`, `${BS}\n`, `${BS}\r\n`, `${BS}${LS}`, `${BS}${PS}`, `${BS}\r`]),
    () => (tpl ? rng.pick(['\n', '\r\n', '\r', '}', '$']) : rng.pick([LS, PS, '$', '{', '}'])),
    () => String.fromCodePoint(0x1d41f + rng.int(8)),
    () => (tpl ? `${BS}u${hex4(0xd800 + rng.int(0x800))}` : [`${BS}${rng.int(8)}${rng.int(8)}${rng.int(8)}`, `${BS}${rng.int(4)}${rng.int(8)}`, `${BS}${1 + rng.int(7)}`, `${BS}8`, `${BS}9`, `${BS}0${rng.int(8)}`][rng.int(6)]),
  ])();
  let strs = 0, tpls = 0, bad = 0;
  for (let n = 0; n < ITER; n++) {
    const tpl = rng.chance(0.4);
    const body = Array.from({ length: 1 + rng.int(8) }, () => piece(tpl)).join('');
    const q = tpl ? '`' : rng.pick(['"', "'"]);
    const src = q + body + q;
    let want;
    try { want = evalIn(`(${src})`); } catch { bad++; continue; } // not valid JavaScript (a stray quote, a bad escape): nothing to compare with
    const toks = lex(src);
    if (tpl) { assert.equal(toks.length, 1, `one template token for ${JSON.stringify(src)}`); assert.equal(toks[0].t, 'tpl'); assert.equal(toks[0].v, want.replace(/\r\n?/g, '\n') === want ? want : want, `template ${JSON.stringify(src)}`); tpls++; }
    else { assert.equal(toks.length, 1, `one string token for ${JSON.stringify(src)}`); assert.equal(toks[0].t, 'str'); assert.equal(toks[0].v, want, `string ${JSON.stringify(src)}`); strs++; }
  }
  assert.ok(strs > 500 && tpls > 300, `not enough valid literals (${strs} strings, ${tpls} templates)`);
  t.diagnostic(`seed 0x${(SEED ^ 0xa5a5).toString(16)}: ${strs} strings and ${tpls} templates compared with the engine's value (${bad} generated spellings were not valid JavaScript)`);
});

test('D17 fuzz: the lexer never throws or hangs on hostile input, and tokens stay inside the source', (t) => {
  const rng = makeRng(SEED ^ 0x3c3c);
  const alphabet = [BS, 'u', 'x', '{', '}', '`', '"', "'", '/', '*', '.', '?', '#', '$', '!', '<', '-', '1', '0', 'e', '_', 'n', ' ', '\n', '\r', LS, PS, '(', ')', '[', ']', '=', '>', ';', 'a', 'Z', String.fromCodePoint(0x1d41f), String.fromCharCode(0xd800), String.fromCharCode(0x200d)];
  const started = Date.now();
  let tokens = 0;
  for (let n = 0; n < ITER; n++) {
    const src = Array.from({ length: 1 + rng.int(40) }, () => rng.pick(alphabet)).join('');
    const toks = lex(src);
    tokens += toks.length;
    scanCode(src, 'design/views/fuzz.js', { api });
    for (const tk of toks) assert.ok(tk.line >= 1 && tk.line <= src.split(/\r\n|[\n\r\u2028\u2029]/).length + 1, `line number ${tk.line} for ${JSON.stringify(src)}`);
  }
  const ms = Date.now() - started;
  assert.ok(ms < 30000, `hostile-input fuzz took ${ms} ms`);
  t.diagnostic(`seed 0x${(SEED ^ 0x3c3c).toString(16)}: ${ITER} hostile inputs, ${tokens} tokens, ${ms} ms`);
});
