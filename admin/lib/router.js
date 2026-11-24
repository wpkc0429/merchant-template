// Tiny hash router. Routes are patterns like "/products/:id"; the first match wins.
// replaceState does not fire hashchange, so scrubbing a token from the URL
// never re-dispatches.

const routes = [];
let onChange = () => {};

export function route(pattern, handler) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:([a-z]+)/gi, (_, k) => { keys.push(k); return "([^/]+)"; }) + "/?$");
  routes.push({ re, keys, handler, pattern });
}

export function currentPath() {
  const raw = location.hash.replace(/^#/, "") || "/";
  return raw.startsWith("/") ? raw : "/" + raw;
}

export function match(path = currentPath()) {
  const clean = path.split("?")[0];
  for (const r of routes) {
    const m = r.re.exec(clean);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params, query: Object.fromEntries(new URLSearchParams(path.split("?")[1] || "")), pattern: r.pattern, path: clean };
    }
  }
  return null;
}

export function navigate(path, { replace = false } = {}) {
  const target = "#" + path;
  if (replace) { history.replaceState(null, "", target); dispatch(); }
  else if (location.hash === target) dispatch();
  else location.hash = target;
}

/** Rewrites the URL without dispatching (used to scrub tokens). */
export function scrub(path) { history.replaceState(null, "", "#" + path); }

function dispatch() { onChange(match()); }

export function start(cb) {
  onChange = cb;
  window.addEventListener("hashchange", dispatch);
  dispatch();
}
