// Native functions the core's own checks depend on, captured when this module is evaluated (the boot phase, before any design module can run;
// docs/DECISIONS.md D18). Core code uses THESE references, never a live global lookup, for: the clock of the approve delay, getComputedStyle (the
// display checks of the dialogs and the preview banner), matchMedia and requestAnimationFrame. lib/lockdown.js additionally makes the globals
// read-only, so this is the second line. The wrappers fall back to the live global only when nothing was there at load time (offline tests
// with a stub DOM; a real browser always has them). It imports nothing and builds no DOM.
const w = typeof window !== "undefined" ? window : globalThis;
const grab = (name) => (typeof w[name] === "function" ? w[name].bind(w) : null);
const _now = typeof performance === "object" && performance && typeof performance.now === "function" ? performance.now.bind(performance) : null;
const _gcs = grab("getComputedStyle");
const _mm = grab("matchMedia");
const _raf = grab("requestAnimationFrame");

/** Monotonic milliseconds (performance.now). */
export const now = () => (_now ? _now() : performance.now());
export const hasGcs = () => typeof (_gcs || w.getComputedStyle) === "function";
export const gcs = (...a) => (_gcs || w.getComputedStyle)(...a);
export const matchMedia = (q) => (_mm || w.matchMedia)(q);
export const hasRaf = () => typeof (_raf || w.requestAnimationFrame) === "function";
export const raf = (f) => (_raf || w.requestAnimationFrame)(f);
