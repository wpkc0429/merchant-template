// Layer guard. Run: node scripts/check-layers.mjs   (also run by scripts/check-design.mjs)
//   lib/            = API / auth / permission / design-loader layer (CORE). Must not import ui/, core/, design/ or app.js,
//                     and must not build UI.
//   ui/             = UI primitives (CORE): safe DOM builder, dialogs, toasts, tables. No fetch / XHR / storage / API paths,
//                     no lib/api.js, no core/.
//   core/, app.js   = the facade the design layer sees (ctx), actions, auth and the bootstrap (CORE). No fetch / XHR /
//                     storage / API paths (all of that goes through lib/); no static imports of design/ (only
//                     lib/design.js loads it, dynamically).
//   design/, design-defaults/ = presentation views and data. Scanned by scripts/check-design.mjs (no imports of the
//                     core at all: everything arrives through ctx).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const js = (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)).filter((f) => f.endsWith(".js") && !f.includes(".min.")).map((f) => join(dir, f)) : []);
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
let bad = 0;
const fail = (file, msg) => { bad++; console.error(`  x ${file}: ${msg}`); };

for (const f of js("lib")) {
  const src = strip(readFileSync(join(root, f), "utf8"));
  if (/from\s+["']\.\.\/(ui|core|design|design-defaults)\//.test(src) || /from\s+["']\.\.\/app\.js/.test(src)) fail(f, "lib must not import ui/, core/, design/ or app.js");
  if (/\bh\(\s*["']|innerHTML|\.append\(|appendChild/.test(src.replace(/document\.head\.append\(s\)/g, ""))) fail(f, "lib must not build UI");
}
const noNetwork = /\bfetch\s*\(|XMLHttpRequest|\/api\/v1|localStorage|sessionStorage|document\.cookie/;
for (const f of js("ui")) {
  const src = strip(readFileSync(join(root, f), "utf8"));
  if (noNetwork.test(src)) fail(f, "ui must go through lib/ (no fetch / storage / API paths)");
  if (/from\s+["']\.\.\/lib\/(api|session|upload|catalog|orders|members|reports|team|dashboard)\.js["']/.test(src) || /from\s+["']\.\.\/core\//.test(src)) fail(f, "ui may only import lib/design.js, lib/dates.js and lib/perm.js");
}
for (const f of [...js("core"), "app.js"]) {
  const src = strip(readFileSync(join(root, f), "utf8"));
  if (noNetwork.test(src)) fail(f, "core must go through lib/ (no fetch / storage / API paths)");
  if (/from\s+["']\.\.?\/(?:\.\.\/)?(design|design-defaults)\//.test(src)) fail(f, "the core never imports the design layer statically (lib/design.js loads it)");
}
for (const f of ["config-loader.js", "config.js", "index.html"]) {
  if (existsSync(join(root, f)) && /<script>(?!\s*<)|onerror=|onclick=/.test(readFileSync(join(root, f), "utf8"))) fail(f, "no inline scripts or inline handlers (keeps script-src 'self' possible)");
}
if (bad) { console.error(`${bad} layer violation(s)`); process.exit(1); }
console.log("layers ok");
