// Frozen intrinsics (CORE, docs/DECISIONS.md D18). The design layer's modules are loaded with import() into the SAME realm as the core,
// so a hostile module could otherwise poison built-ins (Promise.prototype.then, JSON.parse, Response.prototype.json, fetch, Array
// iteration, ...) and read what the core passes through them (a refresh response, form data). app.js calls lockdownIntrinsics() once at
// boot, after every core module and the vendored decoder are loaded and BEFORE the first design module is imported. After that,
// assigning to, redefining or deleting any of these in strict mode throws and in sloppy mode silently does nothing.
//
// Not covered (documented in D18): browser extensions and anything that runs before this file (the page's own classic scripts:
// config.js, config-loader.js), objects the page itself owns, and the platform's own origin isolation (there is none for a module in the
// same realm; a hostile module can still read the DOM and call what ctx gives it).
//
// "Override mistake": once a prototype is frozen, `error.name = "X"` or `obj.toString = f` on an INSTANCE throws, because the inherited
// data property is read-only. The core and the vendored decoder do that (`this.name = ...` in error classes), so for the few well-known
// keys we first turn the prototype's data property into an accessor whose setter creates an own property on the instance (the same
// approach as SES "enable property overrides"); assigning on the prototype itself still throws. Everything is frozen afterwards,
// including these accessors. It imports nothing and builds no DOM.

const OVERRIDABLE = {
  Object: ["constructor", "toString", "toLocaleString", "valueOf"],
  Function: ["constructor", "toString"],
  Array: ["constructor", "toString", "toLocaleString"],
  Error: ["name", "message", "toString"],
};
const ERROR_TYPES = ["EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "AggregateError"];

function enableOverride(proto, key) {
  const d = Object.getOwnPropertyDescriptor(proto, key);
  if (!d || !("value" in d) || !d.configurable) return;
  const value = d.value;
  const get = Object.freeze(function () { return value; });
  const set = function (v) {
    if (this === proto || this === null || (typeof this !== "object" && typeof this !== "function")) throw new TypeError(`Cannot assign to read only property '${String(key)}'`);
    Object.defineProperty(this, key, { value: v, writable: true, enumerable: true, configurable: true });
  };
  Object.freeze(set);
  Object.defineProperty(proto, key, { get, set, enumerable: d.enumerable, configurable: false });
}

const seen = new Set();
function freeze(o) {
  if (o === null || (typeof o !== "object" && typeof o !== "function") || seen.has(o)) return;
  seen.add(o);
  try { Object.freeze(o); } catch { /* exotic host object: skipped, reported by the caller's test */ }
}
function freezeClass(C) {
  if (typeof C !== "function") return;
  freeze(C);
  freeze(C.prototype);
}

/** Names of globals whose constructor AND prototype are frozen (only those that exist in this browser). */
const CLASSES = [
  "Object", "Function", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Date", "RegExp", "Error", "EvalError", "RangeError", "ReferenceError",
  "SyntaxError", "TypeError", "URIError", "AggregateError", "Promise", "Map", "Set", "WeakMap", "WeakSet", "WeakRef", "FinalizationRegistry", "Proxy",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "Headers", "Request", "Response", "URL", "URLSearchParams", "FormData", "Blob", "File", "FileReader", "AbortController", "AbortSignal", "EventTarget", "Event",
  "CustomEvent", "MessageEvent", "ErrorEvent", "ProgressEvent", "KeyboardEvent", "MouseEvent", "PointerEvent", "InputEvent", "FocusEvent", "UIEvent", "DOMException", "Node", "Element", "HTMLElement",
  "Document", "HTMLDocument", "DocumentFragment", "CharacterData", "Text", "Comment", "Attr", "NodeList", "HTMLCollection", "DOMTokenList", "NamedNodeMap",
  "CSSStyleDeclaration", "CSSStyleSheet", "StyleSheet", "XMLHttpRequest", "XMLHttpRequestEventTarget", "XMLHttpRequestUpload", "Storage", "TextEncoder", "TextDecoder",
  "DOMParser", "XMLSerializer", "MutationObserver", "ResizeObserver", "IntersectionObserver", "Worker", "MessageChannel", "MessagePort", "BroadcastChannel", "WebSocket",
  "ImageBitmap", "OffscreenCanvas", "CanvasRenderingContext2D", "OffscreenCanvasRenderingContext2D", "Image", "Option", "Audio", "DOMRect", "DOMMatrix", "ReadableStream", "WritableStream", "TransformStream", "CompressionStream", "DecompressionStream",
  "Performance", "Crypto", "SubtleCrypto", "Location", "History", "Navigator", "Window", "MediaQueryList", "Range", "Selection", "TreeWalker",
];
const NAMESPACES = ["Math", "JSON", "Reflect", "Atomics", "Intl", "WebAssembly", "console"];
/** Globals that become non-writable and non-configurable on window (so `window.fetch = ...` fails). */
const LOCK_ON_WINDOW = [
  "fetch", "XMLHttpRequest", "Request", "Response", "Headers", "JSON", "Promise", "Object", "Array", "Function", "String", "Number", "Boolean", "Symbol", "BigInt",
  "Map", "Set", "WeakMap", "WeakSet", "Reflect", "Proxy", "Math", "Date", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError", "URL", "URLSearchParams", "FormData", "Blob", "File",
  "FileReader", "AbortController", "AbortSignal", "EventTarget", "Event", "CustomEvent", "TextEncoder", "TextDecoder", "Uint8Array", "ArrayBuffer", "DataView",
  "structuredClone", "queueMicrotask", "setTimeout", "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame", "atob", "btoa",
  "createImageBitmap", "WebSocket", "Worker", "DOMParser", "Intl", "WebAssembly", "Atomics", "Node", "Element", "HTMLElement", "Document", "Storage", "Image", "Option",
  "MutationObserver", "ResizeObserver", "IntersectionObserver", "DOMException", "ImageBitmap", "OffscreenCanvas", "isNaN", "isFinite", "parseInt", "parseFloat", "encodeURIComponent", "decodeURIComponent",
  "encodeURI", "decodeURI", "escape", "unescape", "eval", "ADMIN_CONFIG",
];

/**
 * Freezes the intrinsics. Returns a small report {frozen, locked} for diagnostics. Idempotent. Never throws.
 */
export function lockdownIntrinsics() {
  const g = globalThis;
  // 1. keep the well-known instance-assignable keys assignable
  for (const [cls, keys] of Object.entries(OVERRIDABLE)) if (g[cls] && g[cls].prototype) for (const k of keys) enableOverride(g[cls].prototype, k);
  for (const n of ERROR_TYPES) if (g[n] && g[n].prototype) for (const k of ["name", "message"]) enableOverride(g[n].prototype, k);
  // 2. the language and platform classes
  for (const n of CLASSES) { try { freezeClass(g[n]); } catch { /* absent or exotic */ } }
  for (const n of NAMESPACES) { try { freeze(g[n]); } catch { /* absent */ } }
  // typed-array parent, the generator / iterator / async prototypes, and the Intl classes
  const ta = Object.getPrototypeOf(Uint8Array);
  freezeClass(ta);
  const protos = [
    Object.getPrototypeOf([][Symbol.iterator]()), Object.getPrototypeOf(new Map()[Symbol.iterator]()), Object.getPrototypeOf(new Set()[Symbol.iterator]()),
    Object.getPrototypeOf(""[Symbol.iterator]()), Object.getPrototypeOf(/x/[Symbol.matchAll]("x")),
    Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(async function* () {}),
  ];
  for (const p of protos) { freeze(p); freeze(p && p.prototype); freeze(p && Object.getPrototypeOf(p)); freeze(p && p.prototype && Object.getPrototypeOf(p.prototype)); }
  freeze(Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))); // %IteratorPrototype%
  if (typeof g.Iterator === "function") freezeClass(g.Iterator);
  if (g.Intl) for (const k of Object.getOwnPropertyNames(g.Intl)) { try { freezeClass(g.Intl[k]); } catch { /* skip */ } }
  // every HTML / SVG element interface and every Event interface the browser has
  for (const k of Object.getOwnPropertyNames(g)) {
    if (/^(HTML|SVG)\w*Element$/.test(k) || /^\w*Event$/.test(k) || /^(CSS|DOM)\w+$/.test(k)) { try { freezeClass(g[k]); } catch { /* skip */ } }
  }
  // configuration written by the page's classic scripts is read-only from here on
  try { if (g.ADMIN_CONFIG && typeof g.ADMIN_CONFIG === "object") { for (const v of Object.values(g.ADMIN_CONFIG)) freeze(v); freeze(g.ADMIN_CONFIG); } } catch { /* skip */ }
  // 3. the global bindings themselves
  const locked = [];
  for (const k of LOCK_ON_WINDOW) {
    const d = Object.getOwnPropertyDescriptor(g, k);
    if (!d || !d.configurable) continue;
    try { Object.defineProperty(g, k, "value" in d ? { writable: false, configurable: false } : { configurable: false }); locked.push(k); } catch { /* skip */ }
  }
  return { frozen: seen.size, locked };
}
