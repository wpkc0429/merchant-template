#!/usr/bin/env node
/* ============================================================
   check-design.mjs: the single guard for the design layer. No dependencies (Node 18+).

   node scripts/check-design.mjs --base <git ref>     everything, including the scope check of
                                                      `git diff --name-only <base>` (+ untracked files)
   node scripts/check-design.mjs --files a b c        everything, scope check on this list
   node scripts/check-design.mjs                      everything except the scope check
   node scripts/check-design.mjs --update             rewrite scripts/core.manifest.json (intentional CORE change only)

   Options: --root <dir> (check another checkout), --json (machine-readable report), --no-layers.

   Exit codes
     0  every check passed
     1  at least one violation (the report lists rule, file, line and reason)
     2  usage or environment error (bad git ref, unreadable root, ...); nothing was judged

   What runs
     scope      every changed file must be under design/ (design/ and below)
     files      design/ inventory: allowed file types and names, no symlinks, size and count caps
     js         static scan of every .js under design/ (code rules; copy.js and routes.js must be pure data)
     css        static scan of every .css under design/
     assets     design/assets/: allowed types, size cap, magic bytes, passive SVG
     schema     design/copy.js and design/routes.js validated with lib/design-schema.js (the loader's own code)
     ctx        design code may use only names listed in lib/public-api.json; the manifest must equal the
                real ctx built by core/context.js
     defaults   design-defaults/ (the pristine fallback views) passes the same scans and covers every route id
     copy       every copy key the core or the default views ask for exists in design-defaults/copy.js
     manifest   sha256 of the locked core (scripts/core.manifest.json), CRLF normalised to LF
     layers     scripts/check-layers.mjs
   ============================================================ */
import { readFileSync, readdirSync, lstatSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { scanCode, scanDataJs, scanCss, scanAsset, scopeViolations } from "./lib/design-scan.mjs";
import { realSurface } from "./lib/ctx-surface.mjs";
import { ROUTE_IDS, ICON_NAMES, LIMITS, validateCopy, validateRoutes, ASSET_EXTENSIONS } from "../lib/design-schema.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ───────────── locked core: what the manifest covers ─────────────
export const LOCKED_FILES = ["app.js", "index.html", "config.js", "config-loader.js", "styles.css", "scripts/check-design.mjs", "scripts/check-layers.mjs", "scripts/serve.mjs"];
export const LOCKED_DIRS = ["lib", "ui", "core", "vendor", "design-defaults", "scripts/lib"];
const TEXT_EXT = new Set([".js", ".mjs", ".css", ".html", ".json", ".md", ".txt", ".svg"]);

const posix = (p) => p.split(path.sep).join("/");
function walk(root, dir) {
  const abs = path.join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    return e.isDirectory() ? walk(root, rel) : [rel];
  });
}
export function lockedList(root) {
  const files = new Set(LOCKED_FILES.filter((f) => existsSync(path.join(root, f))));
  for (const d of LOCKED_DIRS) for (const f of walk(root, d)) files.add(f);
  return [...files].sort();
}
function hashFile(root, rel) {
  let buf = readFileSync(path.join(root, rel));
  if (TEXT_EXT.has(path.extname(rel).toLowerCase())) buf = Buffer.from(buf.toString("utf8").replace(/\r\n/g, "\n"));
  return createHash("sha256").update(buf).digest("hex");
}
export function computeManifest(root) {
  const m = {};
  for (const f of lockedList(root)) m[f] = hashFile(root, f);
  return m;
}

// ───────────── the checks (exported for scripts/test-guard.mjs) ─────────────
const DATA_FILES = new Set(["design/copy.js", "design/routes.js"]);
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/** Inventory + scans of one design tree (dirName "design" or "design-defaults"). Returns violations. */
export function scanTree(root, dirName, api) {
  const out = [];
  const files = walk(root, dirName);
  if (files.length > 300) out.push({ rule: "files/count", msg: `${files.length} files (cap 300)`, file: dirName, line: 0 });
  let total = 0;
  for (const rel of files) {
    const abs = path.join(root, rel);
    const st = lstatSync(abs);
    total += st.size;
    if (st.isSymbolicLink()) { out.push({ rule: "files/symlink", msg: "symbolic links are not allowed", file: rel, line: 0 }); continue; }
    const segs = rel.split("/");
    if (segs.length > 7 || !segs.every((s) => NAME_RE.test(s))) { out.push({ rule: "files/name", msg: "file names may use only letters, digits, . _ - and at most 6 folder levels", file: rel, line: 0 }); continue; }
    const ext = path.extname(rel).toLowerCase();
    const inAssets = rel.startsWith(`${dirName}/assets/`);
    if (inAssets) {
      if (["README.md", "README.txt"].includes(segs[segs.length - 1])) continue;
      out.push(...scanAsset(readFileSync(abs), rel));
    } else if (ext === ".js") {
      if (st.size > LIMITS.jsFileMaxBytes) { out.push({ rule: "js/size", msg: `larger than ${LIMITS.jsFileMaxBytes / 1024} KiB`, file: rel, line: 0 }); continue; }
      const src = readFileSync(abs, "utf8");
      const logical = rel.replace(new RegExp(`^${dirName}/`), "design/");
      if (DATA_FILES.has(logical)) out.push(...scanDataJs(src, rel));
      else if (segs.length === 2) out.push({ rule: "files/location", msg: "only copy.js and routes.js may sit directly in design/; put code in design/views/ or design/parts/", file: rel, line: 0 });
      else out.push(...scanCode(src, rel, { api, designRelPath: rel }));
    } else if (ext === ".css") {
      if (st.size > LIMITS.cssMaxBytes) { out.push({ rule: "css/size", msg: `larger than ${LIMITS.cssMaxBytes / 1024} KiB`, file: rel, line: 0 }); continue; }
      out.push(...scanCss(readFileSync(abs, "utf8"), rel, rel));
    } else if (ext === ".md" || ext === ".txt") {
      if (st.size > 64 * 1024) out.push({ rule: "files/size", msg: "documentation files are capped at 64 KiB", file: rel, line: 0 });
    } else {
      out.push({ rule: "files/type", msg: `${ext || "(no extension)"} is not an allowed design file (js, css, md, txt; images and fonts only under ${dirName}/assets/: ${ASSET_EXTENSIONS.join(", ")})`, file: rel, line: 0 });
    }
  }
  if (total > 4 * 1024 * 1024) out.push({ rule: "files/size", msg: `${(total / 1048576).toFixed(1)} MiB in total (cap 4 MiB)`, file: dirName, line: 0 });
  return out;
}

/** copy.js / routes.js validated with the same code the browser loader uses. Only imports files that passed the data scan. */
export async function schemaChecks(root, dataClean) {
  const out = [];
  const imp = async (rel) => (await import(`${pathToFileURL(path.join(root, rel)).href}?t=${Date.now()}`)).default;
  let defaults = {};
  try { defaults = await imp("design-defaults/copy.js"); } catch (e) { out.push({ rule: "schema/defaults", msg: `design-defaults/copy.js cannot be loaded: ${e.message}`, file: "design-defaults/copy.js", line: 0 }); }
  if (!existsSync(path.join(root, "design/copy.js"))) out.push({ rule: "schema/copy", msg: "design/copy.js is missing", file: "design/copy.js", line: 0 });
  else if (dataClean["design/copy.js"]) {
    const { warnings } = validateCopy(await imp("design/copy.js"), defaults);
    for (const w of warnings) out.push({ rule: "schema/copy", msg: w, file: "design/copy.js", line: 0 });
  }
  if (!existsSync(path.join(root, "design/routes.js"))) out.push({ rule: "schema/routes", msg: "design/routes.js is missing", file: "design/routes.js", line: 0 });
  else if (dataClean["design/routes.js"]) {
    const routes = await imp("design/routes.js");
    const { routes: ok, warnings } = validateRoutes(routes);
    for (const w of warnings) out.push({ rule: "schema/routes", msg: w, file: "design/routes.js", line: 0 });
    for (const [id, p] of Object.entries(ok)) {
      const f = `design/${p}`;
      if (!existsSync(path.join(root, f))) { out.push({ rule: "schema/routes", msg: `${id} -> ${p}: the file does not exist`, file: "design/routes.js", line: 0 }); continue; }
      if (!/export\s+default\s+(async\s+)?function|export\s*\{[^}]*\bas\s+default\b|export\s+default\s+(async\s+)?\(/.test(readFileSync(path.join(root, f), "utf8"))) out.push({ rule: "schema/routes", msg: `${id} -> ${p}: no \`export default function\``, file: f, line: 0 });
    }
  }
  return out;
}

export async function ctxChecks(root) {
  const out = [];
  const apiPath = path.join(root, "lib/public-api.json");
  const api = JSON.parse(readFileSync(apiPath, "utf8"));
  const real = await realSurface(root);
  const declared = Object.fromEntries(Object.entries(api).filter(([k]) => k !== "_comment"));
  for (const k of new Set([...Object.keys(real), ...Object.keys(declared)])) {
    const a = real[k], b = declared[k];
    if (!a) { out.push({ rule: "ctx/manifest", msg: `${k} is listed in lib/public-api.json but does not exist on the real ctx`, file: "lib/public-api.json", line: 0 }); continue; }
    if (!b) { out.push({ rule: "ctx/manifest", msg: `${k} exists on the real ctx but is missing from lib/public-api.json`, file: "lib/public-api.json", line: 0 }); continue; }
    for (const n of a) if (!b.includes(n)) out.push({ rule: "ctx/manifest", msg: `${k}.${n} exists on the real ctx but is not listed in lib/public-api.json`, file: "lib/public-api.json", line: 0 });
    for (const n of b) if (!a.includes(n)) out.push({ rule: "ctx/manifest", msg: `${k}.${n} is listed in lib/public-api.json but does not exist on the real ctx`, file: "lib/public-api.json", line: 0 });
  }
  // icon catalogue
  try {
    const icons = await import(`${pathToFileURL(path.join(root, "ui/icons.js")).href}`);
    if (JSON.stringify([...icons.ICON_NAMES].sort()) !== JSON.stringify([...ICON_NAMES].sort())) out.push({ rule: "ctx/icons", msg: "ICON_NAMES in lib/design-schema.js differs from ui/icons.js", file: "lib/design-schema.js", line: 0 });
  } catch (e) { out.push({ rule: "ctx/icons", msg: `ui/icons.js cannot be loaded: ${e.message}`, file: "ui/icons.js", line: 0 }); }
  return { out, api: declared };
}

export async function defaultsChecks(root, api) {
  const out = [];
  out.push(...scanTree(root, "design-defaults", api).map((x) => ({ ...x, rule: `defaults:${x.rule}` })));
  if (!existsSync(path.join(root, "design-defaults/routes.js"))) return [...out, { rule: "defaults/routes", msg: "design-defaults/routes.js is missing", file: "design-defaults/routes.js", line: 0 }];
  const routes = (await import(`${pathToFileURL(path.join(root, "design-defaults/routes.js")).href}?t=${Date.now()}`)).default;
  for (const id of ROUTE_IDS) {
    if (!routes[id]) out.push({ rule: "defaults/routes", msg: `no built-in view for route id "${id}"`, file: "design-defaults/routes.js", line: 0 });
    else if (!existsSync(path.join(root, "design-defaults", routes[id]))) out.push({ rule: "defaults/routes", msg: `${id} -> ${routes[id]} does not exist`, file: "design-defaults/routes.js", line: 0 });
  }
  return out;
}

/** Every literal t("key") in core or default views must exist in design-defaults/copy.js; dynamic families need at least one key. */
export async function copyChecks(root) {
  const out = [];
  const defaults = (await import(`${pathToFileURL(path.join(root, "design-defaults/copy.js")).href}?t=${Date.now()}`)).default;
  const files = ["app.js", ...["lib", "ui", "core", "design-defaults/views", "design-defaults/parts"].flatMap((d) => walk(root, d))].filter((f) => f.endsWith(".js"));
  for (const f of files) {
    const src = readFileSync(path.join(root, f), "utf8");
    for (const m of src.matchAll(/\b(?:ctx\.)?t\(\s*"([^"]+)"/g)) if (!(m[1] in defaults)) out.push({ rule: "copy/missing", msg: `copy key "${m[1]}" is used but not defined in design-defaults/copy.js`, file: f, line: src.slice(0, m.index).split("\n").length });
    for (const m of src.matchAll(/\b(?:ctx\.)?t\(\s*`([^`$]*)\$\{/g)) if (!Object.keys(defaults).some((k) => k.startsWith(m[1]))) out.push({ rule: "copy/missing", msg: `no copy keys start with "${m[1]}" (used with a computed suffix)`, file: f, line: 0 });
  }
  return out;
}

export function manifestChecks(root, { update = false } = {}) {
  const file = path.join(root, "scripts/core.manifest.json");
  const now = computeManifest(root);
  if (update) { writeFileSync(file, JSON.stringify(now, null, 2) + "\n"); return { out: [], wrote: Object.keys(now).length }; }
  if (!existsSync(file)) return { out: [{ rule: "manifest/missing", msg: "scripts/core.manifest.json is missing (run with --update)", file: "scripts/core.manifest.json", line: 0 }] };
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const out = [];
  for (const f of new Set([...Object.keys(saved), ...Object.keys(now)])) {
    if (saved[f] !== now[f]) out.push({ rule: "manifest/changed", msg: `locked core file ${saved[f] ? (now[f] ? "modified" : "removed") : "added"}: ${f}`, file: f, line: 0 });
  }
  return { out };
}

// Paths are returned relative to `root` (the admin directory). `root` may be a subdirectory of the git
// work tree (the merchant monorepo keeps the admin under admin/): anything changed OUTSIDE root comes back
// as "../x", which the scope check rejects, so an admin edit can never touch the storefront or the repo root.
export function changedFiles(root, base) {
  const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const top = run(root, "rev-parse", "--show-toplevel").trim();
  const prefix = path.relative(top, path.resolve(root)).split(path.sep).join("/"); // "" when root is the repo root
  const fromTop = (l) => (prefix ? path.posix.relative(prefix, l) : l);
  const names = new Set();
  // git diff prints repo-root relative names; ls-files runs from the top (with --full-name) so it sees everything.
  const lines = [
    ...run(root, "diff", "--name-only", "--no-renames", base).split(/\r?\n/),
    ...run(top, "ls-files", "--others", "--exclude-standard", "--full-name").split(/\r?\n/),
  ];
  for (const l of lines) if (l.trim()) names.add(fromTop(l.trim()));
  return [...names];
}

// ───────────── main ─────────────
async function main() {
  const argv = process.argv.slice(2);
  const flag = (n) => argv.includes(n);
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  if (flag("--help") || flag("-h")) { console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 36).join("\n")); return 0; }
  const root = path.resolve(val("--root") || path.join(HERE, ".."));
  const json = flag("--json");
  const violations = [];
  const steps = [];
  const step = (name, list, note = "") => { steps.push({ name, count: list.length, note }); violations.push(...list); };

  if (flag("--update")) {
    const r = manifestChecks(root, { update: true });
    console.log(`wrote scripts/core.manifest.json (${r.wrote} locked files)`);
    return 0;
  }

  // scope
  let changed = null;
  if (val("--base")) {
    try { changed = changedFiles(root, val("--base")); } catch (e) { console.error(`cannot read the diff against "${val("--base")}": ${(e.stderr || e.message).toString().trim()}`); return 2; }
  } else if (flag("--files")) {
    const i = argv.indexOf("--files");
    changed = argv.slice(i + 1).filter((a) => !a.startsWith("--"));
  }
  if (changed) step("scope", scopeViolations(changed), `${changed.length} changed file(s)`);
  else steps.push({ name: "scope", count: 0, note: "skipped (give --base <ref> or --files ...)" });

  if (!existsSync(path.join(root, "design"))) { console.error(`${root}: no design/ directory`); return 2; }
  let api = null;
  try { api = JSON.parse(readFileSync(path.join(root, "lib/public-api.json"), "utf8")); } catch (e) { console.error(`cannot read lib/public-api.json: ${e.message}`); return 2; }
  api = Object.fromEntries(Object.entries(api).filter(([k]) => k !== "_comment"));

  const treeV = scanTree(root, "design", api);
  step("design scan (files, js, css, assets)", treeV);

  const dataClean = {};
  for (const f of ["design/copy.js", "design/routes.js"]) dataClean[f] = !treeV.some((x) => x.file === f);
  step("schema (copy.js, routes.js)", await schemaChecks(root, dataClean));

  // Core code that cannot even be loaded (a deleted or broken locked file) is reported, not thrown.
  const guarded = async (name, fn) => { try { return await fn(); } catch (e) { return [{ rule: "core/load", msg: `${name}: ${String(e.message).split(String.fromCharCode(10))[0]}`, file: "(core)", line: 0 }]; } };
  step("ctx manifest (lib/public-api.json == real ctx)", await guarded("ctx", async () => (await ctxChecks(root)).out));
  step("defaults (design-defaults/ scans and covers every route)", await guarded("defaults", () => defaultsChecks(root, api)));
  step("copy keys (used == defined)", await guarded("copy", () => copyChecks(root)));
  step("core manifest (scripts/core.manifest.json)", manifestChecks(root).out);

  if (!flag("--no-layers")) {
    const r = spawnSync(process.execPath, [path.join(root, "scripts/check-layers.mjs")], { cwd: root, encoding: "utf8" });
    const list = r.status === 0 ? [] : (r.stderr || r.stdout).split("\n").filter((l) => l.trim()).map((l) => ({ rule: "layers", msg: l.trim(), file: "scripts/check-layers.mjs", line: 0 }));
    step("layers (scripts/check-layers.mjs)", list);
  }

  if (json) { console.log(JSON.stringify({ ok: violations.length === 0, steps, violations }, null, 2)); return violations.length ? 1 : 0; }
  for (const s of steps) console.log(`${s.count ? "x" : "ok"}  ${s.name}${s.note ? `  (${s.note})` : ""}${s.count ? `  ${s.count} violation(s)` : ""}`);
  if (violations.length) {
    console.error("\nDESIGN CHECK FAILED");
    for (const x of violations) console.error(`  x [${x.rule}] ${x.file}${x.line ? `:${x.line}` : ""}  ${x.msg}`);
    return 1;
  }
  console.log("\ndesign check OK");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
}
