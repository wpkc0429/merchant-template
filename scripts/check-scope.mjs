#!/usr/bin/env node
/* check-scope.mjs: root-level scope rule for AI edit sessions in the merchant monorepo.
   No dependencies (Node 18+).

     node scripts/check-scope.mjs storefront --base <git ref>
     node scripts/check-scope.mjs admin      --base <git ref>

   storefront  may change only the storefront design layer (template.json sites.storefront.designPaths):
                 public/app.js, public/content.js, public/styles.css, public/index.html, public/assets/**
               and then runs `scripts/check-layers.mjs --check`.
   admin       may change only admin/design/** (template.json sites.admin.designPaths)
               and then runs `admin/scripts/check-design.mjs --base <ref>` (run from admin/).
   Neither site may touch the other's directory, the locked commerce/core layers, or any
   repo-root file. "Changed" = `git diff --name-only <ref>` plus untracked, non-ignored files.
   Exit: 0 ok, 1 violation, 2 usage/environment error. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const site = argv[0];
const bi = argv.indexOf('--base');
const base = bi >= 0 ? argv[bi + 1] : null;
if (!['storefront', 'admin'].includes(site) || !base) {
  console.error('usage: node scripts/check-scope.mjs <storefront|admin> --base <git ref>');
  process.exit(2);
}

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let changed;
try {
  changed = [...new Set([
    ...git('diff', '--name-only', '--no-renames', base).split(/\r?\n/),
    ...git('ls-files', '--others', '--exclude-standard').split(/\r?\n/),
  ].map((l) => l.trim()).filter(Boolean))];
} catch (e) {
  console.error(`cannot read the diff against "${base}": ${(e.stderr || e.message).toString().trim()}`);
  process.exit(2);
}

// The design paths come from template.json: a path ending in "/" is a directory prefix, anything else is one file.
// Read from the BASE ref when possible, so a branch cannot widen its own scope by editing template.json.
let tpl;
try { tpl = JSON.parse(git('show', `${base}:template.json`)); }
catch { try { tpl = JSON.parse(readFileSync(path.join(ROOT, 'template.json'), 'utf8')); } catch (e) { console.error('cannot read template.json: ' + e.message); process.exit(2); } }
const designPaths = tpl.sites?.[site]?.designPaths;
if (!Array.isArray(designPaths) || !designPaths.length) { console.error(`template.json has no sites.${site}.designPaths`); process.exit(2); }
const allowed = (f) => designPaths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
const bad = changed.filter((f) => f.includes('..') || !allowed(f));
if (bad.length) {
  console.error(`SCOPE CHECK FAILED (${site}): only the ${site} design paths (${designPaths.join(', ')}) may change:`);
  for (const f of bad) console.error(`  x ${f}`);
  process.exit(1);
}
console.log(`ok  scope (${site}): ${changed.length} changed file(s), all in scope`);

const r = site === 'admin'
  ? spawnSync(process.execPath, ['scripts/check-design.mjs', '--base', base], { cwd: path.join(ROOT, 'admin'), stdio: 'inherit' })
  : spawnSync(process.execPath, ['scripts/check-layers.mjs', '--check'], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 2);
