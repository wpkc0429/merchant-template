// Isolation canary (CORE, docs/DECISIONS.md D19). FAIL-CLOSED check that the import map in index.html is really in effect.
//
// WHY. A design module is a same-origin ES module loaded by lib/design.js. The static scan lets it import only files inside design/. The import map in
// index.html is the second wall: for every importer inside /design/ it sends everything outside /design/ to /deny/ (404), so even a module that got
// past the scan cannot import lib/, core/ or ui/. But an inline import map only works when (a) the browser supports import maps and (b) the page's
// Content-Security-Policy allows the inline <script> through its 'sha256-...' hash. When either is missing the map is IGNORED silently, which would
// make the wall disappear without anything failing. So before any design module is loaded, app.js runs this probe. This file sits in a DIRECTORY scope
// of the map, /lib/canary/, built like the design scope (a prefix scope: "/" is denied, one allowed prefix, /lib/canary/allowed/, maps to itself), so
// the probe exercises the same kind of rule as the real wall. It tries to import a core file that the map must deny. If that import RESOLVES, the map
// is not in effect and the design layer is NOT loaded (the built-in screens are used and the owner sees a note).
//
// A denied import proves nothing by itself (the file could simply be unreachable: 404, blocked), so the probe first FETCHES the target (fetch is not subject to
// import maps): only when the file is really there (200, a JavaScript content type) AND its import is refused is the isolation reported as holding.
// The positive control (a file the map must let through) shows that a failure is the map and not the network.
//
// The probe lives in lib/ (locked and hashed) because a design file cannot be core-owned. Not verified: Firefox and Safari. Everything here is standard
// import-maps behaviour, but only Chromium has been run; the probe is what makes an unverified browser safe (if it does not enforce the map, the design is off).

/**
 * { ok: true } when the isolation holds, otherwise { ok: false, reason } with reason one of
 * "unsupported", "control" (the control file did not load), "unverifiable" (the target is not reachable, so a refusal means nothing), "not-enforced".
 */
export async function checkIsolation() {
  const supports = typeof HTMLScriptElement === "function" && typeof HTMLScriptElement.supports === "function" ? HTMLScriptElement.supports("importmap") : false;
  if (supports !== true) return { ok: false, reason: "unsupported" };
  try { await import("./allowed/ok.js"); } catch { return { ok: false, reason: "control" }; }
  try {
    const res = await fetch(new URL("./target.js", import.meta.url).href, { cache: "no-store", credentials: "same-origin" });
    if (res.status !== 200 || !/javascript/i.test(res.headers.get("content-type") || "")) return { ok: false, reason: "unverifiable" };
  } catch { return { ok: false, reason: "unverifiable" }; }
  let reached = false;
  try { await import("./target.js"); reached = true; } catch { /* expected: the map sends it to /deny/ */ }
  return reached ? { ok: false, reason: "not-enforced" } : { ok: true };
}
