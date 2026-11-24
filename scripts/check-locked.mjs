#!/usr/bin/env node
/* check-locked.mjs: fails when a change touches a LOCKED path. No dependencies (Node 18+).

     node scripts/check-locked.mjs --base <git ref> [--head <git ref>]

   Used by .github/workflows/guards.yml on every `design/*` branch: design work (human or AI) may
   never modify the locked core, so any diff against the base that touches lockedPaths,
   merchantOwnedPaths, the hash manifests, template.json or .template-version is a failure.
   (`design/storefront-*` and `design/admin-*` branches additionally get the stricter
   scripts/check-scope.mjs, which allows ONLY that site's design paths.)

   The path lists are read from template.json at the BASE ref (falling back to the work tree), so a
   branch cannot shrink the lock list by editing template.json in the same change.
   With --head the diff is `<base>...<head>` (what the branch introduces); without it, `<base>` against
   the work tree plus untracked files. Exit: 0 ok, 1 locked path touched, 2 usage/environment error. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const base = val('--base');
const head = val('--head');
if (!base) { console.error('usage: node scripts/check-locked.mjs --base <git ref> [--head <git ref>]'); process.exit(2); }

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let tpl;
try { tpl = JSON.parse(git('show', `${base}:template.json`)); }
catch { try { tpl = JSON.parse(readFileSync(path.join(ROOT, 'template.json'), 'utf8')); } catch (e) { console.error('cannot read template.json: ' + e.message); process.exit(2); } }

const protectedPaths = [
  ...(tpl.lockedPaths || []), ...(tpl.merchantOwnedPaths || []),
  ...Object.values(tpl.manifests || {}), 'template.json', '.template-version'
];
if (!protectedPaths.length) { console.error('template.json lists no lockedPaths'); process.exit(2); }

let changed;
try {
  changed = [...new Set((head
    ? git('diff', '--name-only', '--no-renames', `${base}...${head}`).split(/\r?\n/)
    : [...git('diff', '--name-only', '--no-renames', base).split(/\r?\n/), ...git('ls-files', '--others', '--exclude-standard').split(/\r?\n/)]
  ).map((l) => l.trim()).filter(Boolean))];
} catch (e) {
  console.error(`cannot read the diff against "${base}": ${(e.stderr || e.message).toString().trim()}`);
  process.exit(2);
}

const hit = (f) => protectedPaths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p));
const bad = changed.filter(hit);
if (bad.length) {
  console.error('LOCKED PATH CHECK FAILED: this change modifies locked files (core, config, manifests or template metadata):');
  for (const f of bad) console.error(`  x ${f}`);
  console.error('Locked changes are human-reviewed core changes, never part of a design/* branch.');
  process.exit(1);
}
console.log(`ok  locked paths untouched (${changed.length} changed file(s))`);
