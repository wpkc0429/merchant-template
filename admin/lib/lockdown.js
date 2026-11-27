// Frozen intrinsics (CORE, docs/DECISIONS.md D18). The design layer's modules are loaded with import() into the SAME realm as the core,
// so a hostile module could otherwise poison built-ins (Promise.prototype.then, JSON.parse, Response.prototype.json, fetch, Array
// iteration, a setter on a shadow root's adoptedStyleSheets, ...) and read what the core passes through them (a refresh response, form data).
// app.js calls lockdownIntrinsics() once at boot, after every core module is loaded and BEFORE the first design module is imported. After that,
// assigning to, redefining or deleting any of these in strict mode throws and in sloppy mode silently does nothing.
//
// The approach is an ENUMERATION, not a list of names: every own property of the global object is looked at.
//   * a constructor (a function with a prototype object) is frozen together with its prototype and its parent classes;
//   * a namespace-like object (Math, JSON, Reflect, Intl, Atomics, WebAssembly, Temporal, CSS, console, ...) is frozen with the classes inside it;
//   * the global binding itself (window.fetch, window.getComputedStyle, window.matchMedia, window.open, window.setTimeout, ...) becomes
//     non-writable and non-configurable;
//   * the page's well-known singleton instances (document, performance, navigator, screen, history, crypto, ...) are frozen too, so a
//     module cannot shadow performance.now or document.createElement on the instance.
// A new browser API is therefore frozen without anyone adding it to a list. Only EXCEPTIONS stay open (documented below); the real-browser test
// admin/e2e/hardening.mjs enumerates the globals again and fails if anything else is left unfrozen.
//
// Not covered (documented in D18): browser extensions and anything that runs before this file (the page's own classic scripts:
// config.js, config-loader.js), objects the page itself owns, and isolation (there is none for a module in the same realm; a hostile
// module can still read the DOM and call what ctx gives it).
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

/**
 * The EXPLICIT exceptions: globals that stay as they are. Everything else found on the global object is frozen / locked.
 *   heic2any : the vendored decoder's script assigns it on its first use (lib/upload.js takes it out of window at once and refuses a pre-seeded one).
 * Everything the core itself assigns later is a property of its OWN objects, never of a frozen built-in.
 */
export const EXCEPTIONS = Object.freeze(["heic2any"]);
const isException = (name) => EXCEPTIONS.includes(name);

/** Singletons of the page whose INSTANCE is frozen (their methods live on frozen prototypes; this stops shadowing on the instance). */
const INSTANCES = ["document", "performance", "navigator", "screen", "history", "crypto", "customElements", "visualViewport", "scheduler", "trustedTypes", "speechSynthesis", "caches", "indexedDB", "cookieStore", "navigation", "location"];

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
  if (o === null || (typeof o !== "object" && typeof o !== "function") || seen.has(o)) return false;
  seen.add(o);
  try { Object.freeze(o); } catch { /* exotic host object: left alone, and the browser test names it */ }
  return true;
}
const isCtor = (v) => typeof v === "function" && v.prototype !== null && typeof v.prototype === "object";
function freezeClass(C) {
  if (!isCtor(C)) return;
  freeze(C);
  freeze(C.prototype);
  for (let p = Object.getPrototypeOf(C); typeof p === "function" && p !== Function.prototype && !seen.has(p); p = Object.getPrototypeOf(p)) { freeze(p); freeze(p.prototype); }
}
/** A namespace-like object: frozen, and so is every class / nested namespace inside it (Intl.NumberFormat, Temporal.PlainDate, WebAssembly.Module, ...). */
function freezeNamespace(ns, depth = 0) {
  if (!ns || typeof ns !== "object" || seen.has(ns) || depth > 3) return;
  freeze(ns);
  for (const k of Reflect.ownKeys(ns)) {
    let d; try { d = Object.getOwnPropertyDescriptor(ns, k); } catch { continue; }
    if (!d || !("value" in d)) continue;
    if (isCtor(d.value)) freezeClass(d.value);
    else if (d.value && typeof d.value === "object") freezeNamespace(d.value, depth + 1);
  }
}

/**
 * Freezes the intrinsics. Returns a small report {frozen, locked} for diagnostics. Idempotent. Never throws.
 */
export function lockdownIntrinsics() {
  const g = globalThis;
  // 1. keep the well-known instance-assignable keys assignable
  for (const [cls, keys] of Object.entries(OVERRIDABLE)) if (g[cls] && g[cls].prototype) for (const k of keys) enableOverride(g[cls].prototype, k);
  for (const n of ERROR_TYPES) if (g[n] && g[n].prototype) for (const k of ["name", "message"]) enableOverride(g[n].prototype, k);
  // 2. the language pieces that are not reachable as a global name: typed-array parent, iterator / generator / async prototypes
  freezeClass(Object.getPrototypeOf(Uint8Array));
  const iterProtos = [
    Object.getPrototypeOf([][Symbol.iterator]()), Object.getPrototypeOf(new Map()[Symbol.iterator]()), Object.getPrototypeOf(new Set()[Symbol.iterator]()),
    Object.getPrototypeOf(""[Symbol.iterator]()), Object.getPrototypeOf(/x/[Symbol.matchAll]("x")),
    Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(async function* () {}),
  ];
  for (const p of iterProtos) { freeze(p); freeze(p && p.prototype); freeze(p && Object.getPrototypeOf(p)); freeze(p && p.prototype && Object.getPrototypeOf(p.prototype)); }
  freeze(Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))); // %IteratorPrototype%
  // 3. EVERY own property of the global object
  const locked = [];
  for (const name of Object.getOwnPropertyNames(g)) {
    if (isException(name)) continue;
    let d; try { d = Object.getOwnPropertyDescriptor(g, name); } catch { continue; }
    if (!d || !("value" in d)) continue; // accessors (document, location, localStorage ...) are handled below
    const v = d.value;
    if (isCtor(v)) freezeClass(v);
    else if (v && typeof v === "object" && v !== g) { try { freezeNamespace(v); } catch { /* skip */ } }
    if (d.configurable && (typeof v === "function" || (v && typeof v === "object" && v !== g))) {
      try { Object.defineProperty(g, name, { writable: false, configurable: false }); locked.push(name); } catch { /* skip */ }
    }
  }
  // 4. the singleton instances (accessors on window)
  for (const name of INSTANCES) {
    try {
      const v = g[name];
      if (v && typeof v === "object") freeze(v);
      // the accessor on window: keep the getter, drop the [Replaceable] setter and make it non-configurable (window.performance = x, defineProperty(window, ...))
      const d = Object.getOwnPropertyDescriptor(g, name);
      if (d && d.configurable && d.get) { Object.defineProperty(g, name, { get: d.get, set: undefined, enumerable: d.enumerable, configurable: false }); locked.push(name); }
    } catch { /* absent or restricted */ }
  }
  // 5. configuration written by the page's classic scripts is read-only from here on
  try { if (g.ADMIN_CONFIG && typeof g.ADMIN_CONFIG === "object") { for (const v of Object.values(g.ADMIN_CONFIG)) freeze(v); freeze(g.ADMIN_CONFIG); } } catch { /* skip */ }
  return { frozen: seen.size, locked };
}
