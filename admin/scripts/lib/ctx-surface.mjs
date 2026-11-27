// Builds the REAL ctx in Node (browser globals stubbed) and returns its public surface as
// { "ctx": [names], "ctx.ui": [names], ... }. Used by check-design.mjs to prove lib/public-api.json is exact.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export async function realSurface(root) {
  const store = new Map();
  const g = globalThis;
  g.window = g.window || { ADMIN_CONFIG: {}, scrollTo() {}, addEventListener() {} };
  g.location = g.location || { hostname: "localhost", origin: "http://localhost:3001", hash: "", href: "http://localhost:3001/", reload() {} };
  g.sessionStorage = g.sessionStorage || { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  g.document = g.document || { createElement: () => ({}), body: {}, head: {} };
  g.history = g.history || { replaceState() {} };
  const url = (p) => pathToFileURL(resolve(root, p)).href;
  const { makeContext } = await import(url("core/context.js"));
  const makeAuth = (await import(url("core/auth.js"))).takeMakeAuth(); // boot phase (lib/boot.js, D19): nothing sealed it
  const ctx = makeContext({ routeId: "home", nav: [], auth: makeAuth({ linkToken: null, hooks: {} }) });
  const out = {};
  const walk = (obj, path) => {
    out[path] = Object.keys(obj).sort();
    for (const k of out[path]) {
      const v = obj[k];
      if (path === "ctx.route") continue; // params / query / state are plain data with free keys
      if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Node0)) walk(v, `${path}.${k}`);
    }
  };
  class Node0 {}
  walk(ctx, "ctx");
  // data-like leaves that are plain values (not namespaces) must not be walked: drop non-namespace entries
  for (const k of Object.keys(out)) {
    const parts = k.split(".");
    if (parts.length === 2 && ["route", "session", "nav"].includes(parts[1])) continue;
  }
  return out;
}
