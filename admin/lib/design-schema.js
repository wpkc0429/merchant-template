// The contract between the locked core and the editable design layer, as PLAIN DATA plus tiny pure
// validators. Both the browser loader (lib/design.js) and the guard (scripts/check-design.mjs) import
// this file, so what the guard accepts is exactly what the loader accepts. It imports nothing.
//
// Anything the design layer is allowed to name is listed here. Anything not listed is rejected.

/** Route ids the core defines (core/routes.js owns patterns, permissions and data needs). */
export const ROUTE_IDS = [
  "shell", "login", "setPassword", "acceptInvite", "notFound", "noPermission", "bootError",
  "home", "orders", "orderDetail", "deliveries", "members", "tiers", "memberDetail", "reports", "team",
  "products", "productNew", "productEdit", "categories", "categoryOrder", "shipping",
];

/** Icon names the core can draw (ui/icons.js keeps this list in sync; the guard test checks it). */
export const ICON_NAMES = [
  "home", "orders", "shipments", "products", "categories", "shippingMethods", "members", "reports", "team",
  "more", "logout", "back", "up", "down", "left", "right", "plus", "close", "image",
];

export const LIMITS = {
  copyValueMax: 600,        // characters per copy string
  copyKeyMax: 80,
  routePathMax: 120,
  assetMaxBytes: 512 * 1024,
  cssMaxBytes: 256 * 1024,
  jsFileMaxBytes: 128 * 1024,
};

export const ASSET_EXTENSIONS = ["svg", "png", "jpg", "jpeg", "webp", "gif", "ico", "avif", "woff2"];
export const ASSET_TEXT_EXTENSIONS = ["txt", "md"];

export const COPY_KEY_RE = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_-]+)*$/;
const ROUTE_PATH_RE = /^views\/[a-z0-9][a-z0-9_-]*(\/[a-z0-9][a-z0-9_-]*)*\.js$/;
const PLACEHOLDER_RE = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

export const placeholdersOf = (s) => [...String(s).matchAll(PLACEHOLDER_RE)].map((m) => m[1]);

/**
 * Validates a copy object against the built-in defaults. Returns {copy, warnings}: `copy` holds only the
 * entries that are acceptable (known key, string, within the length cap, no unknown placeholders); every
 * other entry is dropped, so that key falls back to the default string.
 */
export function validateCopy(copy, defaults) {
  const warnings = [];
  const out = {};
  if (!copy || typeof copy !== "object" || Array.isArray(copy)) {
    return { copy: out, warnings: ["copy: must be a plain object of key -> string; using the built-in copy"] };
  }
  for (const [k, v] of Object.entries(copy)) {
    if (k.length > LIMITS.copyKeyMax || !COPY_KEY_RE.test(k)) { warnings.push(`copy: bad key "${k.slice(0, 40)}" ignored`); continue; }
    if (!(k in defaults)) { warnings.push(`copy: unknown key "${k}" ignored`); continue; }
    if (typeof v !== "string") { warnings.push(`copy: "${k}" must be a string; default used`); continue; }
    if (v.length > LIMITS.copyValueMax) { warnings.push(`copy: "${k}" is longer than ${LIMITS.copyValueMax} characters; default used`); continue; }
    const allowed = new Set(placeholdersOf(defaults[k]));
    const extra = placeholdersOf(v).filter((p) => !allowed.has(p));
    if (extra.length) { warnings.push(`copy: "${k}" uses unknown placeholder(s) {${extra.join("}, {")}}; default used`); continue; }
    out[k] = v;
  }
  return { copy: out, warnings };
}

/** Validates the route registry (route id -> module path under design/). Same return shape. */
export function validateRoutes(routes) {
  const warnings = [];
  const out = {};
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) {
    return { routes: out, warnings: ["routes: must be a plain object of route id -> module path; using the built-in views"] };
  }
  for (const [id, path] of Object.entries(routes)) {
    if (!ROUTE_IDS.includes(id)) { warnings.push(`routes: unknown route id "${id}" ignored`); continue; }
    if (typeof path !== "string" || path.length > LIMITS.routePathMax || !ROUTE_PATH_RE.test(path)) {
      warnings.push(`routes: "${id}" must be a path like "views/${id}.js"; built-in view used`);
      continue;
    }
    out[id] = path;
  }
  return { routes: out, warnings };
}

export const ROUTE_PATH_PATTERN = ROUTE_PATH_RE;
