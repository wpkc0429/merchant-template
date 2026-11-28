// TEST-ONLY. The ONE place that says which browser console noise is expected (decision D19). Every load of the admin runs the isolation canary
// (lib/canary/probe.js), which deliberately imports /lib/canary/target.js through the import map; the map sends it to /deny/lib/canary/target.js, which answers 404, and the
// browser logs ONE console error for that ("Failed to load resource: ... 404"). Suites that fail on console errors use canaryNoise() per page and skip exactly that
// message: error type, a status 404 text, the URL path /deny/lib/canary/target.js, and only one per main-frame document load (D24: counted from the navigation requests, not from the load event). A /deny/ request for anything else, a second one
// for the same load, or a different status still counts as the console error it is.
export const CANARY_DENY_PATH = "/deny/lib/canary/target.js";

/** Pure: is this console message (type, text, url) the canary's expected 404? */
export function isCanary404(type, text, url) {
  if (type !== "error" || !/status of 404/.test(text || "")) return false;
  try { return new URL(url).pathname === CANARY_DENY_PATH; } catch { return false; }
}

/**
 * For one page: returns ignores(msg), true for the canary's 404 and false for everything else. Each document load of the MAIN frame (a navigation request that is not a
 * redirect hop) allows exactly ONE canary 404, counted over the whole page (D24). Before, the allowance was handed back by the page's "load" event, which is a race:
 * the canary runs after app.js has started, so on a slow resource (cold start, slow image) the new document's canary 404 can be logged BEFORE its load event while
 * the previous document's canary was logged AFTER its own load event; the second one then found the allowance still used and counted as a console error (found in
 * bouquet-next; reproduced with a delayed /deny/ answer and a slow image). Counting navigation requests does not depend on that order. A page that was already loaded
 * when this was called gets one allowance. A surplus canary 404 (more than one per load) and any other /deny/ hit is still a console error.
 */
export function canaryNoise(page) {
  let loads = 0, used = 0;
  if (page && typeof page.on === "function") {
    page.on("request", (r) => {
      try { if (r.isNavigationRequest() && r.frame() === page.mainFrame() && !r.redirectedFrom()) loads++; } catch { /* a request of a closed frame */ }
    });
  }
  return (m) => {
    if (!isCanary404(m.type(), m.text(), (m.location() || {}).url || "")) return false;
    if (used >= Math.max(loads, 1)) return false;
    used++;
    return true;
  };
}

// A suite that PROVOKES an HTTP failure on purpose (a fake API answering 422 or 500 to one path) says so here: the browser logs "Failed to load resource: ... status of NNN"
// for it. Exactly that status, error type and URL path is expected; the same path with another status, or any other path, still counts as the console error it is.
/** Pure: is this console message the logged failure of `status` for `path`? */
export function isHttpFailure(type, text, url, path, status) {
  if (type !== "error" || !new RegExp(`status of ${status}(?![0-9])`).test(text || "")) return false;
  try { return new URL(url).pathname === path; } catch { return false; }
}
