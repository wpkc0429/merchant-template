// TEST-ONLY. The ONE place that says which browser console noise is expected (decision D19). Every load of the admin runs the isolation canary
// (lib/canary/probe.js), which deliberately imports /lib/canary/target.js through the import map; the map sends it to /deny/lib/canary/target.js, which answers 404, and the
// browser logs ONE console error for that ("Failed to load resource: ... 404"). Suites that fail on console errors use canaryNoise() per page and skip exactly that
// message: error type, a status 404 text, the URL path /deny/lib/canary/target.js, and only the first one per page load. A /deny/ request for anything else, a second one
// for the same load, or a different status still counts as the console error it is.
export const CANARY_DENY_PATH = "/deny/lib/canary/target.js";

/** Pure: is this console message (type, text, url) the canary's expected 404? */
export function isCanary404(type, text, url) {
  if (type !== "error" || !/status of 404/.test(text || "")) return false;
  try { return new URL(url).pathname === CANARY_DENY_PATH; } catch { return false; }
}

/** For one page: returns ignores(msg), true once per document load for the canary's 404 and false for everything else (the count restarts when the page fires "load"). */
export function canaryNoise(page) {
  let seen = false;
  if (page && typeof page.on === "function") page.on("load", () => { seen = false; });
  return (m) => {
    if (seen || !isCanary404(m.type(), m.text(), (m.location() || {}).url || "")) return false;
    seen = true;
    return true;
  };
}
