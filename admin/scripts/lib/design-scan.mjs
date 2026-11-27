// Static scanners for the design layer (design/**). No dependencies. CONSERVATIVE on purpose: a false positive
// costs an AI retry, a false negative could ship hostile code. The scan is defence in depth; the real
// boundaries are the core (permissions, state rules, confirmations, no tokens in ctx), the safe DOM builder
// and a strict CSP (see docs/DESIGN-LAYER.md). Every violation is {rule, msg, file, line}.
import path from "node:path";
import { ASSET_EXTENSIONS, LIMITS } from "../../lib/design-schema.js";

// ───────────────────────────── JavaScript ─────────────────────────────

/** Identifiers that may not appear anywhere in design code, not even as a property name. */
export const BANNED_IDENTIFIERS = new Set([
  // network and messaging
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "postMessage", "BroadcastChannel", "MessageChannel",
  "Worker", "SharedWorker", "ServiceWorker", "serviceWorker", "importScripts", "RTCPeerConnection", "WebTransport",
  // storage
  "localStorage", "sessionStorage", "indexedDB", "caches", "cookie", "cookieStore", "openDatabase",
  // dynamic code
  "eval", "Function", "AsyncFunction", "GeneratorFunction", "constructor", "__proto__", "__defineGetter__", "__defineSetter__",
  "__lookupGetter__", "__lookupSetter__", "Reflect", "Proxy", "WebAssembly", "Atomics",
  // ambient globals that reach everything else
  "window", "document", "globalThis", "navigator", "location",
  // raw HTML / element factories / attribute injection (the safe builder is ctx.ui.h)
  "innerHTML", "outerHTML", "insertAdjacentHTML", "insertAdjacentElement", "insertAdjacentText", "srcdoc", "createContextualFragment",
  "DOMParser", "XMLSerializer", "createElement", "createElementNS", "createDocumentFragment", "createRange", "setAttribute", "setAttributeNS", "setAttributeNode",
  "setHTMLUnsafe", "setHTML", "importNode", "adoptNode", "attachShadow", "execCommand", "write", "writeln",
  // things that send requests by being constructed
  "Image", "Audio", "Option", "Notification", "XSLTProcessor", "FileReader", "FormData", "RTCDataChannel",
]);
/** Bare references (not `.x` and not `x:`) that name a global window object. Renaming a local variable is the fix. */
export const BANNED_BARE = new Set(["self", "top", "parent", "frames", "opener"]);
/** String literals equal to one of these (whole value) are refused: they can only be used to reach the above by name. */
const BANNED_STRINGS = new Set([...BANNED_IDENTIFIERS, ...BANNED_BARE, "script", "iframe", "frame", "frameset", "embed", "object", "applet", "base", "meta", "portal", "action", "formaction", "formAction", "prototype", "defaultView", "ownerDocument", "contentWindow", "contentDocument", "parentNode", "parentElement"]);
// ── v0.4.2 (D12): dialogs, popovers, synthetic input, DOM traversal ──
// The design layer builds its screens with ctx.ui.h; the CORE owns every confirmation dialog. These rules make sure design
// code cannot open its own top-layer UI, fake a click on a core control, or climb out of its own subtree to reach one.
/** Dialog, popover, fullscreen and pointer-lock methods: never needed by a screen. (.show( and .close( are handled by receiver.) */
export const DIALOG_API = new Set(["showModal", "showPopover", "hidePopover", "togglePopover", "requestFullscreen", "requestPointerLock", "exitFullscreen", "exitPointerLock", "requestClose"]);
/** The popover and inert attributes / properties (also catches h("div", { popover: "auto" }), el.popover = ..., { inert: true }). */
export const POPOVER_INERT = new Set(["popover", "inert", "popoverTargetElement", "popovertarget", "popovertargetaction", "popoverTargetAction"]);
/** Programmatic input: dispatching events, requesting submits, constructing events. `.click(` / `.submit(` are handled by receiver. */
export const SYNTHETIC_INPUT = new Set(["dispatchEvent", "requestSubmit", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "PointerEvent", "InputEvent", "FocusEvent", "SubmitEvent", "TouchEvent", "WheelEvent", "UIEvent", "ClipboardEvent", "DragEvent"]);
/** Ways to reach an element outside the design layer's own subtree (names that are never legitimate for a screen). */
export const DOM_ESCAPE = new Set(["ownerDocument", "getRootNode", "parentNode", "parentElement", "offsetParent", "composedPath", "getElementById", "getElementsByClassName", "getElementsByTagName", "getElementsByName", "elementFromPoint", "elementsFromPoint", "previousSibling", "nextSibling", "previousElementSibling", "nextElementSibling", "assignedSlot", "firstChild", "lastChild", "childNodes", "firstElementChild", "lastElementChild", "relatedTarget", "srcElement", "originalTarget", "explicitOriginalTarget"]);
/** Escapes that are only a problem as a PROPERTY (the bare word is a normal variable or data key). */
const DOM_ESCAPE_DOT = new Set(["view"]);
/** Selector-style methods: allowed only on an element the file created itself (see selectorAllowed). */
const SELECTOR_METHODS = new Set(["querySelector", "querySelectorAll"]);
/** .closest( climbs OUT of the design's subtree (to body, to core dialogs): refused everywhere; keep a reference to the element you need instead. */
const CLIMB_METHODS = new Set(["closest"]);
/** Whole-string values that can only be used to build or reach the above by name (computed access is also refused). */
/** "dialog" is refused only as a call argument (h("dialog")): role: "dialog" is just an ARIA value. */
const POPOVER_INERT_LOWER = new Set([...POPOVER_INERT].map((x) => x.toLowerCase()));
const DIALOG_STRINGS = new Set(["dialog", "popover", "inert"]);
const NAMED_API_STRINGS = new Set([...DIALOG_API, ...SYNTHETIC_INPUT, ...DOM_ESCAPE, ...SELECTOR_METHODS, ...CLIMB_METHODS, "showDialog", "confirmDialog"]);
/** Core confirmation controls named in a string (ids, test ids, selectors): "confirm-yes", "confirm-warning", ... */
const CORE_CONFIRM_REF = /confirm-(yes|no|ok|cancel|warning|detail|dialog|title|text)\b/i;

// (written without "s*/?s*": two adjacent optional groups backtrack quadratically on a long run of spaces)
const HTML_IN_STRING = /<\s*(?:\/\s*)?(script|iframe|frame|object|embed|link|meta|style|base|form|svg|math|template|noscript|portal|dialog)\b/i;
const SCHEME_IN_STRING = /(javascript|vbscript)\s*:|data\s*:\s*text\/html|:\/\//i;

const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do", "yield", "await", "instanceof"]);
/** Punctuators, longest first (so `&&=`, `>>>=`, `**=`, `?.` ... are one token; a missing entry would split an operator into pieces the rules misread). */
const PUNCT = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "?.", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];
/** Words that are keywords in some positions and plain identifiers in others: a `/` after them is lexed both ways. */
const CONTEXTUAL_KEYWORDS = new Set(["of", "yield", "await"]);
/** Assignment operators (a token right after `ctx` that changes it). */
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=", "??="]);

// ── THE NORMALISATION CONTRACT (decision D17) ──
// Every rule compares CANONICAL values, never the spelling in the source:
//  * an identifier or property name token (t "id") has v = its escape-decoded name: \uXXXX and \u{...} are decoded wherever they
//    occur in the name (JavaScript treats `fetch` and `fetch` as the same identifier); non-ASCII ID_Start / ID_Continue
//    characters, ZWNJ and ZWJ belong to a name; NO Unicode normalisation is applied (JavaScript compares code points).
//    `raw` keeps the source spelling, `esc` says whether an escape was used;
//  * a string literal token (t "str") has v = its COOKED value: \x, \u, \u{}, legacy octal, \0, \b \t \n \v \f \r, line
//    continuations and identity escapes are resolved, so "fetch" and "fetch" are the same string;
//  * a template literal chunk (t "tpl") has v = its cooked value (same cooking); `raw` keeps the source text;
//  * line terminators are \n, \r, \r\n, U+2028 and U+2029 everywhere (they end a // comment and an unterminated string and
//    count lines); whitespace is whatever JavaScript's \s covers (NBSP, BOM, the Zs spaces);
//  * a number token never swallows a following `.name` (1..constructor is num `1.`, `.`, id `constructor`);
//  * `/` is a regex start or a division by context (paren and brace tracking). The one place where the context cannot be known
//    (a `}` that may end a block or an object literal, an arrow body, `of` / `yield` / `await`, `++` after a line break, then `/`) is lexed in EVERY combination (lexAll); more than four such places in a file is reported (js/ambiguous-slash), never guessed;
//  * compound assignments (`&&=`, `||=`, `??=`, ...) are single punctuators.
// Malformed escapes never throw and never loop: they decode as leniently as possible (the code would be a SyntaxError when
// loaded, so it cannot run). HTML-like comments (`<!--`, `-->`) are NOT comments here (a syntax error in a module), so their
// content is scanned like any other code. A hashbang line at the very start IS a comment.
const ID_START = /[\p{ID_Start}_$]/u, ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
const isLT = (c) => c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
const HEX = /^[0-9a-fA-F]+$/;
const SIMPLE_ESC = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };

/** Reads the escape at src[j] === "\\" (inside a string or template). Returns { s: cooked text, next: index after it, lines: line terminators consumed, bad }. */
function cookEscape(src, j) {
  const d = src[j + 1];
  if (d === undefined) return { s: "", next: j + 1, lines: 0 };
  if (d === "\r") return { s: "", next: src[j + 2] === "\n" ? j + 3 : j + 2, lines: 1 };
  if (d === "\n" || d === "\u2028" || d === "\u2029") return { s: "", next: j + 2, lines: 1 };
  if (d === "u") {
    if (src[j + 2] === "{") {
      const e = src.indexOf("}", j + 3), hex = e < 0 ? "" : src.slice(j + 3, e);
      if (HEX.test(hex) && parseInt(hex, 16) <= 0x10ffff) return { s: String.fromCodePoint(parseInt(hex, 16)), next: e + 1, lines: 0 };
    } else {
      const hex = src.slice(j + 2, j + 6);
      if (hex.length === 4 && HEX.test(hex)) return { s: String.fromCharCode(parseInt(hex, 16)), next: j + 6, lines: 0 };
    }
    return { s: "u", next: j + 2, lines: 0, bad: true };
  }
  if (d === "x") {
    const hex = src.slice(j + 2, j + 4);
    if (hex.length === 2 && HEX.test(hex)) return { s: String.fromCharCode(parseInt(hex, 16)), next: j + 4, lines: 0 };
    return { s: "x", next: j + 2, lines: 0, bad: true };
  }
  if (d >= "0" && d <= "7") { // \0 (NUL) and the legacy octal escapes: up to 3 digits when the first is 0-3, else up to 2
    let k = j + 1, val = 0;
    const max = d <= "3" ? 3 : 2;
    while (k < j + 1 + max && src[k] >= "0" && src[k] <= "7") { val = val * 8 + (src.charCodeAt(k) - 48); k++; }
    return { s: String.fromCharCode(val), next: k, lines: 0 };
  }
  if (SIMPLE_ESC[d] !== undefined) return { s: SIMPLE_ESC[d], next: j + 2, lines: 0 };
  const ch = String.fromCodePoint(src.codePointAt(j + 1));
  return { s: ch, next: j + 1 + ch.length, lines: 0 };
}

/** Reads an identifier name (or `#private` name) at src[i]. Returns { v: canonical name, raw, end, esc } or null when no name starts here. */
function readName(src, i) {
  const n = src.length;
  let j = i, v = "", esc = false, first = true;
  if (src[j] === "#") { v = "#"; j++; }
  while (j < n) {
    let ch, len;
    if (src[j] === "\\") {
      if (src[j + 1] !== "u") break;
      const e = cookEscape(src, j);
      if (e.bad) break;
      ch = e.s; len = e.next - j; esc = true; // a decoded character that is not a legal name character is a SyntaxError in JS: still decoded
    } else {
      ch = String.fromCodePoint(src.codePointAt(j)); len = ch.length;
      if (!(first ? ID_START : ID_PART).test(ch)) break;
    }
    v += ch; j += len; first = false;
  }
  if (j === i) return null;
  return { v, raw: src.slice(i, j), end: j, esc };
}

/** Number literal at src[i] (a digit, or "." followed by a digit). Never swallows `.name`: 1..constructor is `1.` `.` `constructor`. */
function readNumber(src, i) {
  const n = src.length;
  let j = i;
  const digits = (re) => { while (j < n && re.test(src[j])) j++; };
  if (src[j] === "0" && /[xXoObB]/.test(src[j + 1] || "")) { j += 2; digits(/[0-9a-fA-F_]/); if (src[j] === "n") j++; return j; }
  digits(/[0-9_]/);
  if (src[j] === "n") return j + 1;
  if (src[j] === ".") { j++; digits(/[0-9_]/); }
  if (/[eE]/.test(src[j] || "") && (/[0-9]/.test(src[j + 1] || "") || (/[+-]/.test(src[j + 1] || "") && /[0-9]/.test(src[j + 2] || "")))) { j += 2; digits(/[0-9_]/); }
  return j;
}

/** Operand-end tokens: a `/` after them is a division, and a `[` after them is a member access. */
const endsOperand = (t) => Boolean(t) && (t.t === "num" || t.t === "str" || t.t === "regex" || (t.t === "tpl" && t.end) ||
  (t.t === "id" && !KEYWORDS_BEFORE_REGEX.has(t.v)) || (t.t === "punct" && (t.v === "]" || (t.v === ")" && !t.stmtParen) || (t.v === "}" && t.exprEnd === true))));

/**
 * Minimal JS lexer: strings, templates (with nested expressions), comments, regex literals, numbers, identifiers, punctuators.
 * `mode` only matters where a `/` follows a `}` that could end a block or an object literal: "div" reads a division, "regex" a
 * regex. lexAll() lexes every combination of such places (and reports a file with too many of them).
 */
export function lex(src, mode = "div") {
  const toks = [];
  let i = 0, line = 1;
  const n = src.length;
  const stack = []; // "tpl" | { kind: "block" | "expr" | "amb" }
  const parens = []; // index in toks of each open "(" (marked .stmt when it follows if / while / for / with / switch / catch)
  const push = (t, v, extra = {}) => { const tk = { t, v, line, ...extra }; toks.push(tk); return tk; };
  const last = (back = 1) => toks[toks.length - back];
  const isDot = (tk) => Boolean(tk) && tk.t === "punct" && (tk.v === "." || tk.v === "?.");
  toks.ambiguous = false;
  toks.siteLines = [];
  // regexClose(p): the index of the "/" that closes a regex literal whose body starts at p, or -1 (no closer on this line). A regex body cannot
  // span lines, a backslash before a line break ends it, "/" inside [ ] does not close it. One backward pass over the source (made on the first
  // regex attempt) gives every later attempt O(1), whatever the length of the literal (no cap: a 100000-character regex is still a regex).
  let afterClass = null, inClassTbl = null;
  const regexClose = (p) => {
    if (afterClass === null) {
      afterClass = new Int32Array(n + 3).fill(-1); inClassTbl = new Int32Array(n + 3).fill(-1);
      for (let q = n - 1; q >= 0; q--) {
        const ch = src[q];
        if (isLT(ch)) continue; // both stay -1
        if (ch === "\\") { const nx = src[q + 1]; if (nx !== undefined && !isLT(nx)) { afterClass[q] = afterClass[q + 2]; inClassTbl[q] = inClassTbl[q + 2]; } continue; }
        afterClass[q] = ch === "/" ? q : ch === "[" ? inClassTbl[q + 1] : afterClass[q + 1];
        inClassTbl[q] = ch === "]" ? afterClass[q + 1] : inClassTbl[q + 1];
      }
    }
    return p < n ? afterClass[p] : -1;
  };
  let sites = 0; // ambiguous places met so far; `mode` decides each one (see lexAll)
  const decide = () => { const i = sites++; toks.sites = sites; toks.ambiguous = true; toks.siteLines.push(line); return mode === "regex" ? true : Array.isArray(mode) ? Boolean(mode[i]) : false; };

  // is a `function` / `class` keyword after this token an EXPRESSION (so the body's "}" ends an operand)?
  const isExprStart = (tk) => {
    if (!tk) return false;
    if (tk.t === "punct") return !(tk.v === ";" || tk.v === "{" || tk.v === "}" || (tk.v === ")" && tk.stmtParen));
    if (tk.t === "id") return KEYWORDS_BEFORE_REGEX.has(tk.v) && tk.v !== "else" && tk.v !== "do";
    return false;
  };
  const classifyBrace = () => {
    const p = last();
    if (!p) return "block";
    if (p.t === "punct") {
      if (p.v === ")") {
        if (p.stmtParen) return "block";
        let m = (p.open === undefined ? -2 : p.open) - 1; // function expression or declaration, or a method
        if (toks[m] && toks[m].t === "id" && toks[m].v !== "function") m--;
        if (toks[m] && toks[m].t === "punct" && toks[m].v === "*") m--;
        if (toks[m] && toks[m].t === "id" && toks[m].v === "function") {
          m--;
          if (toks[m] && toks[m].t === "id" && toks[m].v === "async") m--;
          return isExprStart(toks[m]) ? "expr" : "block";
        }
        return "block"; // method body, get / set body
      }
      if (p.v === "=>") return "amb"; // an arrow body ends an operand, but a newline after it can start a statement (ASI): `() => {} /re/.test(x)` on two lines
      if (p.v === ";" || p.v === "{" || p.v === "}") return "block";
      if (p.v === ":") return "amb"; // object value or ternary branch, or a case label / labelled block
      return "expr";
    }
    if (p.t === "id") {
      if (p.v === "else" || p.v === "do" || p.v === "try" || p.v === "finally") return "block";
      if (KEYWORDS_BEFORE_REGEX.has(p.v)) return "expr";
      for (let m = toks.length - 1, c = 0; m >= 0 && c < 60; m--, c++) { // class X extends Y {
        const t = toks[m];
        if (t.t === "punct" && (t.v === ";" || t.v === "{" || t.v === "}")) break;
        if (t.t === "id" && t.v === "class" && !isDot(toks[m - 1])) return isExprStart(toks[m - 1]) ? "expr" : "block";
      }
      return "block"; // static { }, a bare block after an identifier statement
    }
    return "amb";
  };
  const regexAllowed = () => {
    const p = last();
    if (!p) return true;
    if (p.t === "num" || p.t === "str" || p.t === "regex") return false;
    if (p.t === "tpl") return !p.end;
    if (p.t === "id") {
      if (isDot(last(2))) return false; // `a.in / 2`: a property named like a keyword
      if (CONTEXTUAL_KEYWORDS.has(p.v)) return decide(); // `of`, `yield`, `await` are also plain identifiers: `of / 2` is a division
      return KEYWORDS_BEFORE_REGEX.has(p.v);
    }
    if (p.v === ")") return Boolean(p.stmtParen);
    if (p.v === "]") return false;
    if (p.v === "}") {
      if (p.exprEnd === true) return false;
      if (p.exprEnd === false) return true;
      return decide();
    }
    if (p.v === "++" || p.v === "--") { // a++ / 2 is a division, ++/re/.lastIndex a regex; after a line break the operator belongs to the NEXT statement
      if (!endsOperand(last(2))) return true;
      return last(2).line === p.line ? false : decide();
    }
    return true;
  };

  function readTemplate() { // after the opening backtick or a closing "}" of an expression
    let text = "", raw = "";
    while (i < n) {
      const c = src[i];
      if (c === "\\") { const e = cookEscape(src, i); text += e.s; raw += src.slice(i, e.next); line += e.lines; i = e.next; continue; }
      if (c === "`") { i++; push("tpl", text, { end: true, raw }); return; }
      if (c === "$" && src[i + 1] === "{") { i += 2; push("tpl", text, { end: false, raw }); stack.push("tpl"); return; }
      if (c === "\r") { const crlf = src[i + 1] === "\n"; line++; text += "\n"; raw += crlf ? "\r\n" : "\r"; i += crlf ? 2 : 1; continue; }
      if (c === "\n" || c === "\u2028" || c === "\u2029") line++;
      text += c; raw += c; i++;
    }
    push("tpl", text, { end: true, unterminated: true, raw });
  }

  if (src.startsWith("#!")) while (i < n && !isLT(src[i])) i++; // hashbang: a comment, only at the very start
  while (i < n) {
    const c = src[i];
    if (c === "\r") { line++; i += src[i + 1] === "\n" ? 2 : 1; continue; }
    if (c === "\n" || c === "\u2028" || c === "\u2029") { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && !isLT(src[i])) i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2), stop = e < 0 ? n : e + 2;
      for (let k = i; k < stop; k++) { if (src[k] === "\r") { if (src[k + 1] !== "\n") line++; } else if (src[k] === "\n" || src[k] === "\u2028" || src[k] === "\u2029") line++; }
      i = stop; continue;
    }
    if (c === '"' || c === "'") {
      const startLine = line;
      let j = i + 1, val = "", closed = false;
      while (j < n) {
        const d = src[j];
        if (d === c) { closed = true; break; }
        if (d === "\n" || d === "\r") break; // an unterminated string ends at the line terminator (a SyntaxError in JS)
        if (d === "\\") { const e = cookEscape(src, j); val += e.s; line += e.lines; j = e.next; continue; }
        if (d === "\u2028" || d === "\u2029") line++;
        val += d; j++;
      }
      const tk = push("str", val, { raw: src.slice(i, closed ? j + 1 : j) });
      tk.line = startLine;
      if (!closed) tk.unterminated = true;
      i = closed ? j + 1 : j; continue;
    }
    if (c === "`") { i++; readTemplate(); continue; }
    if (c === "{") { const kind = classifyBrace(); stack.push({ kind }); push("punct", "{"); i++; continue; }
    if (c === "}") {
      const top = stack.pop();
      if (top === "tpl") { i++; readTemplate(); continue; }
      const tk = push("punct", "}");
      tk.exprEnd = top ? (top.kind === "expr" ? true : top.kind === "block" ? false : "amb") : false;
      i++; continue;
    }
    if (c === "(") {
      let b = last(), bi = toks.length - 1;
      if (b && b.t === "id" && b.v === "await" && last(2) && last(2).t === "id" && last(2).v === "for") { b = last(2); bi = toks.length - 2; }
      const stmt = Boolean(b && b.t === "id" && ["if", "while", "for", "with", "switch", "catch"].includes(b.v) && !isDot(toks[bi - 1]));
      push("punct", "(", { stmt }); parens.push(toks.length - 1); i++; continue;
    }
    if (c === ")") {
      const o = parens.pop();
      const tk = push("punct", ")");
      if (o !== undefined) { tk.open = o; tk.stmtParen = Boolean(toks[o].stmt); }
      i++; continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] || ""))) { const j = readNumber(src, i); push("num", src.slice(i, j)); i = j; continue; }
    if (c === "#" || c === "\\" || ID_START.test(String.fromCodePoint(src.codePointAt(i)))) {
      const r = readName(src, i);
      if (r) { push("id", r.v, { raw: r.raw, ...(r.esc ? { esc: true } : {}) }); i = r.end; continue; }
      if (c === "#") { push("id", "#"); i++; continue; }
    }
    if (c === "/" && regexAllowed()) {
      const close = regexClose(i + 1);
      if (close >= 0) { // an unterminated regex is not a regex: "/" stays an operator so the rest of the line is not hidden
        let j = close + 1; while (j < n && ID_PART.test(src[j])) j++;
        push("regex", src.slice(i, j)); i = j; continue;
      }
    }
    if (c === "?" && src[i + 1] === "." && /[0-9]/.test(src[i + 2] || "")) { push("punct", "?"); i++; continue; } // a ?.5 : b
    let p = PUNCT.find((cand) => src.startsWith(cand, i));
    if (!p) p = String.fromCodePoint(src.codePointAt(i));
    push("punct", p); i += p.length;
  }
  return toks;
}

/** More ambiguous places than this in one reading is reported (js/ambiguous-slash) instead of guessed: 2^4 = 16 readings are enumerated in full. */
export const MAX_AMBIGUOUS_SLASHES = 4;
/**
 * lex() once for every combination of the readings of the places where a `/` could be a regex or a division (a `}` that may end a block or an
 * object, an arrow body, `of` / `yield` / `await`, a `++` after a line break). Every rule must run on each result. SOUND: the set is the
 * complete product (at most 31 readings, every decision vector of up to 4 places), never a sample; when any reading has more than
 * MAX_AMBIGUOUS_SLASHES places the enumeration stops and `tooAmbiguous` carries the line of the fifth place: the caller reports it.
 * Returns { readings, tooAmbiguous: { line } | null }.
 */
export function lexAll(src) {
  const first = lex(src, []);
  const readings = [first];
  const todo = [{ prefix: [], toks: first }];
  while (todo.length) {
    const { prefix, toks } = todo.shift();
    if ((toks.sites || 0) > MAX_AMBIGUOUS_SLASHES) return { readings, tooAmbiguous: { line: toks.siteLines[MAX_AMBIGUOUS_SLASHES] } };
    for (let i = prefix.length; i < (toks.sites || 0); i++) {
      const next = prefix.concat(new Array(i - prefix.length).fill(false), [true]);
      const t = lex(src, next);
      readings.push(t); todo.push({ prefix: next, toks: t });
    }
  }
  return { readings, tooAmbiguous: null };
}

/**
 * Does a tag in this text carry the popover or inert attribute (`<div popover>`, `<p inert=...`)? Linear: a tag runs from a "<" to the next ">",
 * and a "<" inside an unfinished tag starts nothing new (the earlier "<" already covers everything after it up to the same ">").
 */
export function tagHasPopoverOrInert(text) {
  let pos = 0;
  while (pos < text.length) {
    const lt = text.indexOf("<", pos);
    if (lt < 0) return false;
    const gt = text.indexOf(">", lt);
    const end = gt < 0 ? text.length : gt;
    if (/^<[^>]*\s(popover|inert)\b/i.test(text.slice(lt, end))) return true;
    if (gt < 0) return false;
    pos = gt + 1;
  }
  return false;
}

const v = (rule, msg, file, line) => ({ rule, msg, file, line });

/** Data files (design/copy.js, design/routes.js) may contain only literals. */
export function scanDataJs(src, file) {
  const out = [];
  const toks = lex(src);
  const ALLOWED_PUNCT = new Set(["{", "}", "[", "]", ",", ":", ";", "-"]);
  let sawExport = false;
  toks.forEach((tk, k) => {
    if (tk.t === "str" || tk.t === "num") return;
    if (tk.t === "tpl") { if (!tk.end || tk.unterminated) out.push(v("js/data-not-pure", "template literals with ${} are not allowed in data files", file, tk.line)); return; }
    if (tk.t === "punct") { if (!ALLOWED_PUNCT.has(tk.v)) out.push(v("js/data-not-pure", `"${tk.v}" is not allowed in a data file (literals only: no calls, operators, spreads or functions)`, file, tk.line)); return; }
    if (tk.t === "id") {
      if (tk.v === "export" || tk.v === "default") { sawExport = sawExport || tk.v === "export"; return; }
      if (["true", "false", "null"].includes(tk.v)) return;
      const next = toks[k + 1];
      if (next && next.t === "punct" && next.v === ":") return; // unquoted key
      out.push(v("js/data-not-pure", `identifier "${tk.v}" is not allowed in a data file`, file, tk.line));
      return;
    }
    out.push(v("js/data-not-pure", `unexpected ${tk.t} token in a data file`, file, tk.line));
  });
  if (!sawExport) out.push(v("js/data-not-pure", 'a data file must `export default { ... }`', file, 1));
  return out;
}

const SIMPLE_INDEX = (inner) => {
  // allowed bracket contents: number | identifier | string literal | ident.ident | ident +/- number | ident.length
  if (inner.length === 1) return inner[0].t === "num" || inner[0].t === "id" || inner[0].t === "str";
  if (inner.length === 3) {
    const [a, op, b] = inner;
    if (a.t === "id" && op.t === "punct" && (op.v === "." || op.v === "?.") && b.t === "id") return true;
    if ((a.t === "id" || a.t === "num") && op.t === "punct" && (op.v === "+" || op.v === "-") && (b.t === "num" || b.t === "id")) return a.t !== "str" && b.t !== "str";
  }
  if (inner.length === 5) { // ident . ident . ident  (e.g. [p.kind.x]) is fine too
    return inner[0].t === "id" && inner[1].v === "." && inner[2].t === "id" && inner[3].v === "." && inner[4].t === "id";
  }
  return false;
};

/**
 * Code files (views, parts). `api` is lib/public-api.json (or null to skip the ctx-name check).
 * `designRelPath` is the path of this file relative to the repo root (e.g. "design/views/home.js").
 */
export function scanCode(src, file, opts = {}) {
  // lexAll: usually one token list; two when a "}" followed by "/" could be read as a block end or an object end (see lex). The rules
  // run on each reading and the findings are merged, so neither reading can hide code from the other.
  const seen = new Set(), out = [];
  const { readings, tooAmbiguous } = lexAll(src);
  if (tooAmbiguous) out.push(v("js/ambiguous-slash", `more than ${MAX_AMBIGUOUS_SLASHES} places where a "/" could start a regex or divide (after the "}" of an arrow function or block, after of / yield / await, after ++ or -- on a new line): the scan cannot tell which, so it refuses the file. Add semicolons or parentheses so that each "/" is unambiguous`, file, tooAmbiguous.line));
  for (const toks of readings) {
    for (const f of scanCodeTokens(toks, file, opts)) {
      const key = `${f.rule}|${f.line}|${f.msg}`;
      if (!seen.has(key)) { seen.add(key); out.push(f); }
    }
  }
  return out;
}

function scanCodeTokens(toks, file, { api = null, designRelPath = file } = {}) {
  const out = [];
  const at = (k) => toks[k];
  const isP = (tk, val) => tk && tk.t === "punct" && tk.v === val;
  // Bracket structure, computed ONCE (every rule below used to rescan: quadratic on hostile input). enclosing[i] = the innermost open bracket
  // before token i (-1 at top level); matchOf pairs ( [ { with their closers whatever the kinds; braceMatch / parenMatch pair one kind only.
  const enclosing = new Array(toks.length).fill(-1), matchOf = new Array(toks.length).fill(-1), braceMatch = new Array(toks.length).fill(-1), parenMatch = new Array(toks.length).fill(-1);
  {
    const all = [], br = [], pa = [];
    toks.forEach((t, i) => {
      enclosing[i] = all.length ? all[all.length - 1] : -1;
      if (t.t !== "punct") return;
      if (t.v === "(" || t.v === "[" || t.v === "{") all.push(i);
      else if ((t.v === ")" || t.v === "]" || t.v === "}") && all.length) { const o = all.pop(); matchOf[o] = i; matchOf[i] = o; }
      if (t.v === "{") br.push(i); else if (t.v === "}" && br.length) { const o = br.pop(); braceMatch[o] = i; }
      if (t.v === "(") pa.push(i); else if (t.v === ")" && pa.length) { const o = pa.pop(); parenMatch[o] = i; }
    });
  }

  // ── helpers for the v0.4.2 rules ──
  // ctxNames: names that are PURE aliases of ctx, ctx.actions, ctx.data or ctx.auth (never ctx.ui, never computed / spread / called). The only
  // member of those namespaces the scan needs to treat specially is ctx.auth.passwordSetup.submit (the core's own function).
  const ctxNames = new Set(["ctx"]);
  const uiNames = new Set(["h"]);    // names of ctx.ui builders (the elements they return belong to this file)
  const PURE_NS = new Set(["actions", "data", "auth"]);
  const authNames = new Set();
  const uiNs = new Set(["ui"]);      // names that hold the whole ctx.ui object
  for (let k = 1; k < toks.length; k++) {
    if (!(toks[k].t === "id" && toks[k].v === "ctx") || !isP(toks[k - 1], "=")) continue;
    let seg = null, end = k + 1;
    if (isP(toks[k + 1], ".") && toks[k + 2] && toks[k + 2].t === "id") { seg = toks[k + 2].v; end = k + 3; }
    const pure = !isP(toks[end], ".") && !isP(toks[end], "?.") && !isP(toks[end], "[") && !isP(toks[end], "(");
    const isUi = seg === "ui" && pure;
    const okNs = seg === null || PURE_NS.has(seg);
    if (isUi && toks[k - 2] && toks[k - 2].t === "id") uiNs.add(toks[k - 2].v);
    if (toks[k - 2] && toks[k - 2].t === "id" && pure && okNs) { ctxNames.add(toks[k - 2].v); if (seg === "auth") authNames.add(toks[k - 2].v); continue; }
    if (isP(toks[k - 2], "}") && pure) {
      for (let j = k - 3; j >= 0 && j > k - 400 && !isP(toks[j], "{"); j--) {
        if (toks[j].t !== "id") continue;
        if (isUi) uiNames.add(toks[j].v);
        else if (okNs && (seg === "auth" || (seg === null && toks[j].v === "auth") ? authNames.add(toks[j].v) || true : true) && !(seg === null && (toks[j].v === "ui" || (isP(toks[j - 1], ":") && toks[j - 2] && toks[j - 2].v === "ui")))) ctxNames.add(toks[j].v);
        if (seg === null && ((toks[j].v === "ui" && !isP(toks[j - 1], ":")) || (isP(toks[j - 1], ":") && toks[j - 2] && toks[j - 2].v === "ui"))) uiNs.add(toks[j].v);
      }
    }
  }
  for (const n of ["$", "$$", "append", "toast", "copyText", "clear", "busy", "showDialog", "confirmDialog", "applyFieldErrors", "clearFieldErrors", "setFieldError", "showFormError"]) uiNames.delete(n);
  // index of the "(" that CALLS the name at k, looking through closing parens and an optional-call `?.`: (f)(x), (0, f)(x), f?.(x); 0 when it is not called
  const callFollows = (k) => { let j = k + 1; while (isP(toks[j], ")")) j++; if (isP(toks[j], "?.") && isP(toks[j + 1], "(")) j++; return isP(toks[j], "(") ? j : 0; };
  const own = new Set(); // const/let/var X = <ctx.ui builder>(...)
  for (let k = 3; k < toks.length; k++) {
    if (!isP(toks[k - 1], "=") || toks[k - 2].t !== "id" || !(toks[k - 3].t === "id" && ["const", "let", "var"].includes(toks[k - 3].v))) continue;
    const t0 = toks[k];
    const viaUi = t0.t === "id" && uiNames.has(t0.v) && isP(toks[k + 1], "(");
    const viaCtxUi = t0.t === "id" && t0.v === "ctx" && isP(toks[k + 1], ".") && toks[k + 2] && toks[k + 2].v === "ui" && isP(toks[k + 3], ".") && toks[k + 4] && !["$", "$$", "showDialog", "confirmDialog"].includes(toks[k + 4].v) && isP(toks[k + 5], "(");
    if (viaUi || viaCtxUi) own.add(toks[k - 2].v);
  }
  // fileInputs: X = h("input", { ..., type: "file", ... }) (const, let, var or a plain assignment): the hidden file input behind an upload button
  const fileInputs = new Set();
  for (let k = 2; k < toks.length; k++) {
    if (!isP(toks[k - 1], "=") || toks[k - 2].t !== "id") continue;
    const t0 = toks[k];
    const viaH = t0.t === "id" && uiNames.has(t0.v) && isP(toks[k + 1], "(") && toks[k + 2] && toks[k + 2].t === "str" && toks[k + 2].v === "input" && isP(toks[k + 3], ",") && isP(toks[k + 4], "{");
    if (!viaH) continue;
    let depth = 0;
    for (let j = k + 4; j < toks.length && j < k + 600; j++) {
      if (isP(toks[j], "{") || isP(toks[j], "(") || isP(toks[j], "[")) depth++;
      else if (isP(toks[j], "}") || isP(toks[j], ")") || isP(toks[j], "]")) { depth--; if (depth <= 0) break; }
      else if (depth === 1 && toks[j].t === "id" && toks[j].v === "type" && isP(toks[j + 1], ":") && toks[j + 2] && toks[j + 2].t === "str" && toks[j + 2].v === "file") { fileInputs.add(toks[k - 2].v); break; }
    }
  }
  /** index of the root identifier of the member chain whose last member is toks[k] (a.b.c: k points at c), or -1 when it starts at a call/index. */
  const chainRoot = (k) => {
    let j = k;
    for (let steps = 0; (isP(toks[j - 1], ".") || isP(toks[j - 1], "?.")) && steps < 200; steps++) {
      const before = toks[j - 2];
      if (!before || before.t !== "id") return -1;
      j -= 2;
    }
    return j;
  };
  const ctxRooted = (k) => { const r = chainRoot(k); return r >= 0 && r !== k && ctxNames.has(toks[r].v); };
  const coreSubmit = (k) => { const r = chainRoot(k); return r >= 0 && r !== k && ((toks[r].v === "ctx" && toks[r + 2] && toks[r + 2].v === "auth") || authNames.has(toks[r].v)); };
  // { parentNode: 1 } as a plain object literal key is harmless data; as a destructuring pattern ({ parentNode: p } = el) it is an escape
  const isObjectLiteralKey = (k) => {
    if (!(isP(toks[k + 1], ":") && (isP(toks[k - 1], "{") || isP(toks[k - 1], ",")))) return false;
    const o = enclosing[k];
    if (o < 0 || !isP(toks[o], "{")) return false;
    const c = braceMatch[o];
    if (c < 0) return false;
    const a1 = toks[c + 1], a2 = toks[c + 2];
    if (isP(a1, "=") || isP(a1, "=>")) return false;
    if (isP(a1, ")") && isP(a2, "=>")) return false;
    const before = toks[o - 1];
    return Boolean(before && (isP(before, "=") || isP(before, "(") || isP(before, ",") || isP(before, ":") || isP(before, "[") || isP(before, "?") || (before.t === "id" && ["return", "yield", "await", "of", "in"].includes(before.v))));
  };
  const ownReceiver = (k) => isP(toks[k - 1], ".") && toks[k - 2] && toks[k - 2].t === "id" && own.has(toks[k - 2].v) && !isP(toks[k - 3], ".") && !isP(toks[k - 3], "?.");
  const fileInputReceiver = (k) => isP(toks[k - 1], ".") && toks[k - 2] && toks[k - 2].t === "id" && fileInputs.has(toks[k - 2].v) && !isP(toks[k - 3], ".") && !isP(toks[k - 3], "?.");
  const selectorAllowed = (k) => {
    const recv = toks[k - 2];
    if (!recv) return false;
    if (ownReceiver(k)) return true;
    if (recv.t === "id" && recv.v === "root" && !isP(toks[k - 3], ".")) return true;
    return false;
  };
  const dollarAllowed = (k) => {
    if (!isP(toks[k + 1], "(")) return false;
    let depth = 0, j = k + 1, commaAt = -1;
    for (; j < toks.length && j < k + 500; j++) { // (a call with more than 500 tokens of arguments is not the allowed form)
      if (isP(toks[j], "(") || isP(toks[j], "[") || isP(toks[j], "{")) depth++;
      else if (isP(toks[j], ")") || isP(toks[j], "]") || isP(toks[j], "}")) { depth--; if (depth === 0) break; }
      else if (depth === 1 && isP(toks[j], ",") && commaAt < 0) commaAt = j;
    }
    if (commaAt < 0) return false;
    const arg = toks[commaAt + 1];
    return Boolean(arg && arg.t === "id" && (arg.v === "root" || own.has(arg.v)) && isP(toks[commaAt + 2], ")"));
  };

  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k], prev = at(k - 1), next = at(k + 1);
    if (tk.t === "str") {
      const sv = tk.v.trim();
      if (DIALOG_STRINGS.has(sv.toLowerCase()) && (sv.toLowerCase() !== "dialog" || isP(prev, "("))) out.push(v("js/dialog-element", `the string "${tk.v}" names the dialog tag or a popover/inert attribute: the core owns every dialog (use ctx.ui.showDialog)`, file, tk.line));
      else if (POPOVER_INERT_LOWER.has(sv.toLowerCase())) out.push(v("js/popover-inert", `the string "${tk.v}" names the popover or inert attribute / property (el["popoverTargetElement"] is el.popoverTargetElement): refused`, file, tk.line));
      else if (NAMED_API_STRINGS.has(sv)) out.push(v("js/dom-escape", `the string "${tk.v}" names a forbidden DOM API (synthetic input, a dialog method or traversal out of the design's own subtree)`, file, tk.line));
      if (CORE_CONFIRM_REF.test(tk.v)) out.push(v("js/core-ui-selector", `the string "${tk.v.slice(0, 60)}" refers to a core confirmation control`, file, tk.line));
      if (BANNED_STRINGS.has(tk.v.trim())) out.push(v("js/banned-string", `the string "${tk.v}" names a forbidden API`, file, tk.line));
      if (HTML_IN_STRING.test(tk.v) || SCHEME_IN_STRING.test(tk.v)) out.push(v("js/html-or-url-in-string", `a string contains markup, a script scheme or an external URL: ${JSON.stringify(tk.v.slice(0, 60))}`, file, tk.line));
      if (prev && prev.t === "punct" && prev.v === "+" && toks[k - 2] && toks[k - 2].t === "str") out.push(v("js/string-concat", "concatenating string literals is refused (write the string whole, or use ctx.t)", file, tk.line));
      if (/^on[a-z]+$/i.test(tk.v) && isP(next, ":") && at(k + 2) && (at(k + 2).t === "str" || at(k + 2).t === "tpl")) out.push(v("js/event-handler-string", `string event handler "${tk.v}"`, file, tk.line));
      continue;
    }
    if (tk.t === "tpl") {
      if (/<\s*(?:\/\s*)?dialog\b/i.test(tk.v) || tagHasPopoverOrInert(tk.v)) out.push(v("js/dialog-element", "a template contains a <dialog> or a popover/inert attribute", file, tk.line));
      if (CORE_CONFIRM_REF.test(tk.v)) out.push(v("js/core-ui-selector", "a template refers to a core confirmation control", file, tk.line));
      if (HTML_IN_STRING.test(tk.v) || SCHEME_IN_STRING.test(tk.v)) out.push(v("js/html-or-url-in-string", `a template contains markup, a script scheme or an external URL: ${JSON.stringify(tk.v.slice(0, 60))}`, file, tk.line));
      continue;
    }
    if (tk.t !== "id") continue;
    const name = tk.v;
    const afterDot = prev && (isP(prev, ".") || isP(prev, "?."));

    if (BANNED_IDENTIFIERS.has(name)) { out.push(v("js/forbidden-identifier", `"${name}" is not allowed in design code`, file, tk.line)); continue; }
    if (DIALOG_API.has(name)) { out.push(v("js/dialog-api", `"${name}" is not allowed: design code may not open dialogs, popovers, fullscreen or pointer lock (use ctx.ui.showDialog; the core owns confirmations)`, file, tk.line)); continue; }
    if (POPOVER_INERT.has(name)) { out.push(v("js/popover-inert", `"${name}" is not allowed: the popover and inert attributes and properties are refused`, file, tk.line)); continue; }
    if (SYNTHETIC_INPUT.has(name)) { out.push(v("js/synthetic-input", `"${name}" is not allowed: design code may not dispatch or construct events or request a submit`, file, tk.line)); continue; }
    if (DOM_ESCAPE.has(name) && !isObjectLiteralKey(k)) { out.push(v("js/dom-escape", `"${name}" is not allowed: design code may not reach elements outside its own subtree`, file, tk.line)); continue; }
    if (afterDot && (name === "show" || name === "close") && callFollows(k)) { out.push(v("js/dialog-api", `.${name}( is refused (it opens or closes a dialog); close a ctx.ui.showDialog dialog through the { close } argument of its action`, file, tk.line)); continue; }
    if (afterDot && name === "submit" && !coreSubmit(k)) { out.push(v("js/synthetic-input", ".submit is refused (it submits a form programmatically)", file, tk.line)); continue; }
    if (afterDot && name === "click" && !fileInputReceiver(k)) { out.push(v("js/synthetic-input", ".click is allowed only on a hidden file input this file created itself: const f = h('input', { type: 'file' }); f.click()", file, tk.line)); continue; }
    if (afterDot && CLIMB_METHODS.has(name)) { out.push(v("js/dom-escape", `.${name}( climbs out of the design's own subtree and is refused: keep a reference to the element you need`, file, tk.line)); continue; }
    if (afterDot && DOM_ESCAPE_DOT.has(name)) { out.push(v("js/dom-escape", `.${name} reaches the window and is refused`, file, tk.line)); continue; }
    if (afterDot && SELECTOR_METHODS.has(name) && !selectorAllowed(k)) { out.push(v("js/dom-escape", `.${name}( is allowed only on an element this file created itself (a const from ctx.ui.h or another ctx.ui builder) or on root`, file, tk.line)); continue; }
    if ((name === "$" || name === "$$") && !dollarAllowed(k) && !(!isP(next, "(") && (isP(next, ",") || isP(next, "}")) && (isP(prev, "{") || isP(prev, ",")))) { out.push(v("js/dom-escape", `${name}( queries the whole document unless given an element: pass an element this file created, or root, as the second argument`, file, tk.line)); continue; }
    if (BANNED_BARE.has(name) && !afterDot && !isP(next, ":")) { out.push(v("js/forbidden-identifier", `bare "${name}" refers to a window object (rename the variable)`, file, tk.line)); continue; }

    if (name === "import") {
      if (isP(next, "(")) { out.push(v("js/dynamic-import", "dynamic import() is not allowed", file, tk.line)); continue; }
      if (isP(next, ".")) { out.push(v("js/forbidden-identifier", "import.meta is not allowed", file, tk.line)); continue; }
      checkSpecifier(k, true);
      continue;
    }
    if (name === "export") {
      // "export ... from 'x'" re-exports; plain exports are fine
      for (let j = k + 1; j < toks.length && j < k + 40; j++) {
        if (isP(toks[j], ";") || (toks[j].t === "id" && ["function", "const", "let", "var", "class", "default", "async"].includes(toks[j].v))) break;
        if (toks[j].t === "id" && toks[j].v === "from") { checkSpecifier(j - 1, false, j); break; }
      }
      continue;
    }

    // setTimeout("code") / setInterval("code")
    if ((name === "setTimeout" || name === "setInterval") && callFollows(k) && at(callFollows(k) + 1) && (at(callFollows(k) + 1).t === "str" || at(callFollows(k) + 1).t === "tpl")) {
      out.push(v("js/timer-string", `${name} with a string argument is code injection`, file, tk.line));
    }
    // form submission targets are not the design layer's business
    if ((name === "action" || name === "formAction" || name === "formaction") && isP(next, ":")) out.push(v("js/form-action", `"${name}" attribute is not allowed (screens talk to the core, not to URLs)`, file, tk.line));
    // x.onfoo = ...   /   { onfoo: "string" }
    if (/^on[a-z]+$/.test(name)) {
      if (afterDot && isP(next, "=")) out.push(v("js/event-handler-assignment", `assigning .${name} is refused (use h({ ${name}: fn }) or addEventListener)`, file, tk.line));
      if (!afterDot && isP(next, ":") && at(k + 2) && (at(k + 2).t === "str" || at(k + 2).t === "tpl")) out.push(v("js/event-handler-string", `string event handler "${name}"`, file, tk.line));
    }
    // computed member access
    // handled below via brackets
  }

  // computed member access: x[ ... ]
  for (let k = 1; k < toks.length; k++) {
    if (!isP(toks[k], "[")) continue;
    const p = toks[k - 1];
    // "?.[" is a member access too (a?.[x + y] is as computed as a[x + y]); so is a number, a regex or a closed template before "[", and the "}" of an object literal or function expression
    const isMember = (p.t === "id" && !KEYWORDS_BEFORE_REGEX.has(p.v) && !["return", "const", "let", "var", "export", "default", "in", "of"].includes(p.v)) || isP(p, ")") || isP(p, "]") || isP(p, "?.") || (isP(p, "}") && p.exprEnd === true) || p.t === "str" || p.t === "num" || p.t === "regex" || (p.t === "tpl" && p.end);
    if (!isMember) continue; // array literal
    const j = matchOf[k] > k && isP(toks[matchOf[k]], "]") ? matchOf[k] + 1 : toks.length + 1;
    const inner = j - 1 - (k + 1) <= 6 ? toks.slice(k + 1, j - 1) : toks.slice(k + 1, k + 8); // a longer index is never a simple one; do not copy it (nested indexes would be quadratic)
    const longIndex = j - 1 - (k + 1) > 6;
    if (inner.length === 1 && inner[0].t === "str" && ["click", "submit", "show", "close", "$", "$$", "showDialog", "confirmDialog", "closest"].includes(inner[0].v)) out.push(v("js/synthetic-input", `computed access to ["${inner[0].v}"] is refused (it can click, submit, open or close)`, file, toks[k].line));
    if (inner.length === 1 && inner[0].t === "str" && DOM_ESCAPE_DOT.has(inner[0].v)) out.push(v("js/dom-escape", `computed access to ["${inner[0].v}"] reaches the window and is refused (as .${inner[0].v} is)`, file, toks[k].line));
    if (inner.length === 1 && inner[0].t === "str" && /^on[a-z]+$/.test(inner[0].v) && isP(toks[j], "=")) out.push(v("js/event-handler-assignment", `assigning ["${inner[0].v}"] is refused (use h({ ${inner[0].v}: fn }) or addEventListener)`, file, toks[k].line));
    if (longIndex || !inner.length || !SIMPLE_INDEX(inner)) out.push(v("js/computed-access", "computed member access with a non-trivial expression is refused (use a plain index, identifier or string literal)", file, toks[k].line));
  }

  // imports must stay inside design/
  function checkSpecifier(k, isImport, fromIdx) {
    let spec = null;
    if (isImport) {
      for (let j = k + 1; j < toks.length && j < k + 80; j++) {
        if (toks[j].t === "str" && (j === k + 1 || (toks[j - 1].t === "id" && toks[j - 1].v === "from"))) { spec = toks[j]; break; }
        if (isP(toks[j], ";")) break;
      }
    } else spec = toks[fromIdx + 1] && toks[fromIdx + 1].t === "str" ? toks[fromIdx + 1] : null;
    if (!spec) { out.push(v("js/import", "could not read the import specifier", file, toks[k].line)); return; }
    const s = spec.v;
    if (!/^\.{1,2}\/[A-Za-z0-9_\/.-]+\.js$/.test(s)) { out.push(v("js/import", `import "${s}" is not allowed: design code may only import other files under design/ by relative path (everything else comes from ctx)`, file, spec.line)); return; }
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(designRelPath), s));
    const root = designRelPath.split("/")[0];
    if (!resolved.startsWith(root + "/") || resolved.includes("..")) out.push(v("js/import", `import "${s}" leaves ${root}/`, file, spec.line));
  }

  // ── ctx must be the module's own argument: no shadowing, no re-assignment, no Object.* or spread over ctx ──
  {
    const braceDepth = new Array(toks.length).fill(0);
    let d = 0;
    toks.forEach((t, i) => { if (isP(t, "{")) d++; braceDepth[i] = d; if (isP(t, "}")) d--; });
    // the member called on Object at toks[k]: Object.x(, Object?.x(, Object["x"]( or Object?.["x"]( -> { name, open: index of the "(" } or null
    const objectMember = (k) => {
      let j = k + 1, name = null;
      if (isP(toks[j], ".") || isP(toks[j], "?.")) { if (toks[j + 1] && toks[j + 1].t === "id") { name = toks[j + 1].v; j += 2; } else if (isP(toks[j], "?.") && isP(toks[j + 1], "[")) j++; else return null; }
      if (name === null) { if (isP(toks[j], "[") && toks[j + 1] && toks[j + 1].t === "str" && isP(toks[j + 2], "]")) { name = toks[j + 1].v; j += 3; } else return null; }
      return isP(toks[j], "(") ? { name, open: j } : null;
    };
    const closeOf = (i) => (isP(toks[i], "(") ? parenMatch[i] : -1);
    // is toks[k] a NAME bound or assigned by a destructuring pattern: const { ctx } = x, const { a: ctx } = x, const [ctx] = x, [ctx] = x, ({ ctx } = x), for (const [ctx] of x)?
    // (a pattern is a { } or [ ] whose closer is followed by "=", or by of / in after const / let / var / "(" ; nested patterns are looked through)
    const inPattern = (k) => {
      const pv = toks[k - 1], nx = toks[k + 1];
      if (!(pv && pv.t === "punct" && ["{", "[", ",", ":"].includes(pv.v) && nx && nx.t === "punct" && ["}", "]", ",", "="].includes(nx.v))) return false;
      let o = enclosing[k];
      for (let level = 0; level < 4 && o >= 0; level++) {
        if (isP(toks[o], "{") || isP(toks[o], "[")) {
          const c = matchOf[o], after = toks[c + 1], before = toks[o - 1];
          if (c > o && after && (isP(after, "=") || (after.t === "id" && (after.v === "of" || after.v === "in") && before && ((before.t === "id" && ["const", "let", "var"].includes(before.v)) || isP(before, "("))))) return true;
        } else break;
        o = enclosing[o];
      }
      return false;
    };
    for (let k = 0; k < toks.length; k++) {
      const tk = toks[k];
      if (tk.t === "id" && tk.v === "ctx" && !isP(toks[k - 1], ".") && !isP(toks[k - 1], "?.")) {
        const p = toks[k - 1];
        if (p && p.t === "id" && ["const", "let", "var", "function", "class"].includes(p.v)) out.push(v("js/ctx-shadow", "declaring another `ctx` hides the real one from the scan; use another name", file, tk.line));
        else if (toks[k + 1] && toks[k + 1].t === "punct" && ASSIGN_OPS.has(toks[k + 1].v)) out.push(v("js/ctx-shadow", "assigning to `ctx` is refused", file, tk.line));
        else if (isP(toks[k + 1], "=>")) out.push(v("js/ctx-shadow", "an arrow parameter named `ctx` hides the real one; use another name", file, tk.line));
        else if (isP(p, "(") && toks[k - 2] && toks[k - 2].t === "id" && toks[k - 2].v === "catch") out.push(v("js/ctx-shadow", "a catch parameter named ctx is refused", file, tk.line));
        else if (isP(p, "++") || isP(p, "--") || isP(toks[k + 1], "++") || isP(toks[k + 1], "--")) out.push(v("js/ctx-shadow", "assigning to `ctx` is refused", file, tk.line));
        else if (p && p.t === "id" && (p.v === "import" || p.v === "as")) out.push(v("js/ctx-shadow", "importing something as `ctx` hides the real one; use another name", file, tk.line));
        else if (isP(p, "(") && toks[k - 2] && toks[k - 2].t === "id" && toks[k - 2].v === "for" && toks[k + 1] && toks[k + 1].t === "id" && (toks[k + 1].v === "of" || toks[k + 1].v === "in")) out.push(v("js/ctx-shadow", "a for loop variable named `ctx` is refused", file, tk.line));
        else if (inPattern(k)) out.push(v("js/ctx-shadow", "declaring or assigning `ctx` through a destructuring pattern is refused", file, tk.line));
      }
      if (isP(tk, "(") && braceDepth[k] > 0) {
        const c = closeOf(k), pv = toks[k - 1];
        if (c > 0 && pv && !(pv.t === "id" && ["if", "for", "while", "switch", "with", "catch", "return", "typeof", "await", "in", "of", "void", "new", "throw", "else", "yield"].includes(pv.v)) && (isP(toks[c + 1], "=>") || isP(toks[c + 1], "{")) && (pv.t === "id" || isP(pv, "=") || isP(pv, ",") || isP(pv, "(") || isP(pv, ":") || isP(pv, "=>"))) {
          // a nested function's parameter list (a top-level function is the module's own and may take ctx)
          if (isP(toks[c + 1], "=>") || pv.t === "id") {
            for (let j = k + 1; j < c; j++) if (toks[j].t === "id" && toks[j].v === "ctx" && !isP(toks[j - 1], ".")) out.push(v("js/ctx-shadow", "a nested function parameter named `ctx` hides the real one; use another name", file, toks[j].line));
          }
        }
      }
      // an operand that IS a ctx namespace object (not a call result, not plain data): ctx, ctx.ui, ctx.actions, or a bare alias of one
      const nsOperand = (i) => {
        const t0 = toks[i];
        if (!t0 || t0.t !== "id") return false;
        let j = i + 1, path = t0.v;
        while ((isP(toks[j], ".") || isP(toks[j], "?.")) && toks[j + 1] && toks[j + 1].t === "id") { path += "." + toks[j + 1].v; j += 2; }
        if (isP(toks[j], "(") || isP(toks[j], "[")) return false;
        if (t0.v === "ctx") return Boolean(api && api[path]);
        return path === t0.v && ((ctxNames.has(t0.v) && t0.v !== "t") || uiNs.has(t0.v));
      };
      // Object.x( / Object?.x( / Object["x"]( / Object?.["x"]( with ctx or a namespace of it as an argument
      const objCall = tk.t === "id" && tk.v === "Object" ? objectMember(k) : null;
      if (objCall && ["values", "entries", "assign", "fromEntries", "keys", "getOwnPropertyNames", "getOwnPropertyDescriptors", "getOwnPropertyDescriptor", "getPrototypeOf", "create", "defineProperty", "defineProperties"].includes(objCall.name)) {
        const c = closeOf(objCall.open);
        let dd = 0;
        for (let j = objCall.open + 1; j < c; j++) {
          if (isP(toks[j], "(") || isP(toks[j], "[") || isP(toks[j], "{")) dd++;
          else if (isP(toks[j], ")") || isP(toks[j], "]") || isP(toks[j], "}")) dd--;
          const argStart = dd === 0 && (j === objCall.open + 1 || isP(toks[j - 1], ","));
          if (argStart && nsOperand(j)) { out.push(v("js/ctx-unknown", `Object.${objCall.name} over ctx or one of its namespaces is refused (it can enumerate functions the guard cannot see by name)`, file, tk.line)); break; }
        }
      }
      if (isP(tk, "...") && nsOperand(k + 1)) out.push(v("js/ctx-unknown", "spreading ctx or one of its namespaces is refused", file, tk.line));
    }
  }

  if (api) checkCtx(toks, api, file, out);
  return out;
}

function checkCtx(toks, api, file, out) {
  const isP = (tk, val) => tk && tk.t === "punct" && tk.v === val;
  const known = (nsPath) => api[nsPath];
  const aliases = new Map(); // alias name -> namespace path ("ctx.ui")

  // chain: starting at index k (the identifier), return {segments, end}
  const readChain = (k) => {
    const segs = [];
    let j = k + 1;
    while (j < toks.length && (isP(toks[j], ".") || isP(toks[j], "?.")) && toks[j + 1] && toks[j + 1].t === "id") { segs.push({ name: toks[j + 1].v, line: toks[j + 1].line }); j += 2; }
    return { segs, end: j };
  };
  let afterIdx = 0;
  const checkSegs = (base, segs, line) => {
    let ns = base;
    for (const s of segs) {
      const list = known(ns);
      if (!list) return; // plain data below this point (e.g. ctx.route.params.x)
      if (!list.includes(s.name)) { out.push(v("js/ctx-unknown", `${ns}.${s.name} is not in lib/public-api.json`, file, s.line || line)); return; }
      ns = `${ns}.${s.name}`;
    }
    if (isP(toks[afterIdx], "[") && known(ns)) out.push(v("js/ctx-unknown", `computed access on ${ns} is refused`, file, line));
  };

  // pass 1: destructuring  const { a, b: c } = ctx[.ns]
  for (let k = 0; k < toks.length; k++) {
    if (!(toks[k].t === "id" && toks[k].v === "ctx") || !isP(toks[k - 1], "=")) continue;
    if (!isP(toks[k - 2], "}")) continue;
    let j = k - 2, depth = 0;
    for (; j >= 0; j--) { if (isP(toks[j], "}")) depth++; else if (isP(toks[j], "{")) { depth--; if (depth === 0) break; } }
    const pattern = toks.slice(j + 1, k - 2);
    const { segs } = readChain(k);
    const base = ["ctx", ...segs.map((s) => s.name)].join(".");
    if (segs.length && !known("ctx." + segs.map((s) => s.name).join("."))) { checkSegs("ctx", segs, toks[k].line); }
    if (pattern.some((p) => isP(p, "{") || isP(p, "["))) { out.push(v("js/ctx-unknown", "nested destructuring of ctx is refused (destructure one level)", file, toks[k].line)); continue; }
    let idx = 0;
    while (idx < pattern.length) {
      const key = pattern[idx];
      if (key.t === "id") {
        const list = known(base);
        if (!list) {
          // plain data below a known namespace (ctx.route.params / query / state): any keys are fine
          const parentNs = base.slice(0, base.lastIndexOf("."));
          if (known(parentNs) && known(parentNs).includes(base.slice(base.lastIndexOf(".") + 1))) break;
          out.push(v("js/ctx-unknown", `cannot destructure from ${base}`, file, key.line)); break;
        }
        if (!list.includes(key.v)) out.push(v("js/ctx-unknown", `${base}.${key.v} is not in lib/public-api.json`, file, key.line));
        let alias = key.v;
        if (isP(pattern[idx + 1], ":") && pattern[idx + 2] && pattern[idx + 2].t === "id") { alias = pattern[idx + 2].v; idx += 2; }
        if (known(`${base}.${key.v}`)) aliases.set(alias, `${base}.${key.v}`);
      }
      while (idx < pattern.length && !isP(pattern[idx], ",")) idx++;
      idx++;
    }
  }

  // pass 2: every chain that starts with ctx or an alias
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t !== "id") continue;
    if (isP(toks[k - 1], ".") || isP(toks[k - 1], "?.")) continue;
    if (tk.v === "ctx") {
      if (isP(toks[k + 1], "[")) { out.push(v("js/ctx-unknown", "computed access on ctx is refused", file, tk.line)); continue; }
      const { segs, end } = readChain(k);
      afterIdx = end;
      checkSegs("ctx", segs, tk.line);
    } else if (aliases.has(tk.v) && !isP(toks[k + 1], ":")) {
      if (isP(toks[k + 1], "[")) { out.push(v("js/ctx-unknown", `computed access on ${tk.v} is refused`, file, tk.line)); continue; }
      const { segs, end } = readChain(k);
      afterIdx = end;
      checkSegs(aliases.get(tk.v), segs, tk.line);
    }
  }
}

// ───────────────────────────── CSS ─────────────────────────────

const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
const stripCssStrings = (s) => s.replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, (m) => '"' + " ".repeat(Math.max(0, m.length - 2)) + '"');
const HIDING = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?![.\d])|pointer-events\s*:\s*none|(?:^|[;{\s])(?:width|height|max-width|max-height|font-size)\s*:\s*0(?:px|rem|em|%)?\s*(?:[;}!]|$)|clip-path\s*:\s*(?:inset|circle|polygon)|transform\s*:[^;}]*scale\(\s*0/i;

/** cssRel: the file's path relative to the repo root, e.g. "design/theme.css". */
export function scanCss(src, file, cssRel = file) {
  const out = [];
  const noComments = stripCssComments(src);
  const lineOf = (idx) => noComments.slice(0, idx).split("\n").length;
  if (/@import/i.test(noComments)) out.push(v("css/import", "@import is not allowed (put the rules in the file)", file, lineOf(noComments.search(/@import/i))));
  for (const m of noComments.matchAll(/url\s*\(\s*(["']?)([^)]*?)\1\s*\)/gi)) {
    const target = m[2].trim();
    const ok = /^data:image\/(png|jpe?g|webp|gif|avif|svg\+xml)[;,]/i.test(target) ||
      (!/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("//") && !target.startsWith("\\") &&
        path.posix.normalize(path.posix.join(path.posix.dirname(cssRel), target)).startsWith(cssRel.split("/")[0] + "/assets/"));
    if (!ok) out.push(v("css/url", `url(${target.slice(0, 60)}) must be a file under design/assets/ (or a data:image URI)`, file, lineOf(m.index)));
  }
  if (/image-set\s*\(\s*["']/i.test(noComments) || /\bsrc\s*\(/i.test(noComments)) out.push(v("css/url", "image-set(\"...\") / src() string URLs are refused; use url(assets/...)", file, 1));
  if (/expression\s*\(/i.test(noComments)) out.push(v("css/expression", "expression() is not allowed", file, lineOf(noComments.search(/expression\s*\(/i))));
  if (/behavior\s*:|-moz-binding|javascript\s*:|vbscript\s*:/i.test(noComments)) out.push(v("css/behavior", "behaviour hacks (behavior:, -moz-binding, javascript:) are not allowed", file, 1));
  if (/\\[0-9a-fA-F]{1,6}/.test(stripCssStrings(noComments))) out.push(v("css/escape", "CSS escapes outside strings can hide forbidden tokens", file, 1));
  if (/<\s*\/?\s*(script|style|iframe)/i.test(noComments)) out.push(v("css/markup", "markup inside CSS", file, 1));
  // rules that make confirmation dialogs invisible or unclickable
  const flat = noComments;
  for (const m of flat.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const sel = m[1], decl = m[2];
    if (/dialog|\.dlg|confirm|::backdrop|data-testid\s*[~|^$*]?=\s*["']?confirm/i.test(sel) && HIDING.test(decl)) {
      out.push(v("css/hides-dialog", `a rule on "${sel.trim().slice(0, 50)}" hides or disables a dialog / confirmation control`, file, lineOf(m.index)));
    }
  }
  return out;
}

// ───────────────────────────── Assets ─────────────────────────────

const SIGNATURES = {
  png: (b) => b.length > 8 && b[0] === 0x89 && b.slice(1, 4).toString() === "PNG",
  jpg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8,
  jpeg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8,
  gif: (b) => b.slice(0, 3).toString() === "GIF",
  webp: (b) => b.length > 12 && b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP",
  woff2: (b) => b.slice(0, 4).toString() === "wOF2",
  ico: (b) => b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0,
  avif: (b) => b.length > 12 && b.slice(4, 8).toString() === "ftyp",
};

export function scanAsset(buf, file) {
  const out = [];
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!ASSET_EXTENSIONS.includes(ext)) { out.push(v("asset/type", `.${ext} files are not allowed in design/assets/ (allowed: ${ASSET_EXTENSIONS.join(", ")})`, file, 1)); return out; }
  if (buf.length > LIMITS.assetMaxBytes) out.push(v("asset/size", `${(buf.length / 1024).toFixed(0)} KiB exceeds the ${LIMITS.assetMaxBytes / 1024} KiB cap`, file, 1));
  if (ext === "svg") {
    const text = buf.toString("utf8");
    if (/<\s*(script|foreignObject|iframe|object|embed|animate|set|use|image|a)\b/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /javascript\s*:/i.test(text) ||
      /(?:xlink:)?href\s*=\s*["'](?!#)/i.test(text) || /<!ENTITY|<!DOCTYPE/i.test(text) || /url\s*\(\s*["']?(?!#)/i.test(text) || /@import/i.test(text)) {
      out.push(v("asset/svg-active", "SVG must be passive: no script, foreignObject, event handlers, external references, entities or url()/@import", file, 1));
    }
  } else if (SIGNATURES[ext] && !SIGNATURES[ext](buf)) out.push(v("asset/magic", `the content is not a real .${ext} file`, file, 1));
  return out;
}

// ───────────────────────────── Scope ─────────────────────────────

/** Fails every path outside design/**. `paths` use forward slashes relative to the repo root. */
export function scopeViolations(paths) {
  const out = [];
  for (const raw of paths) {
    const p = String(raw).replace(/\\/g, "/").replace(/^\.\//, "");
    const norm = path.posix.normalize(p);
    if (!norm.startsWith("design/") || norm.includes("..") || path.posix.isAbsolute(norm)) out.push(v("scope/outside-design", `${p} is outside design/ (only design/** may change)`, p, 0));
  }
  return out;
}
