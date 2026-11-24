#!/usr/bin/env node
/* ============================================================
   sync-core.mjs: brings a MERCHANT repo's locked core up to a newer template version.
   No dependencies (Node 18+).

     node scripts/sync-core.mjs --from <template checkout at an annotated vX.Y.Z tag> [--dry-run] [--yes] [--ack-design-actions] [--allow-untagged]

   THE SOURCE IS A TAG ONLY: the template checkout must have HEAD exactly at the annotated tag v<version> (the version in
   its template.json) with a clean work tree, otherwise the sync is refused (exit 2) unless --allow-untagged is given.

   RUN BY A HUMAN (or by the platform's own, human-approved pipeline). NEVER BY AN AI DESIGN SESSION: it rewrites
   the locked core and the hash manifests, which design sessions must not do. It does not commit and does not push:
   review `git diff` / `git status` afterwards and commit on a branch yourself.

   What it does
     1. Refuses unless: this is a merchant repo (template.json "isTemplate": false), the git work tree is clean
        (untracked files count), the template checkout is the same template (name) with isTemplate true, and its
        version is STRICTLY NEWER than this repo's.
     2. Runs the template's own guards inside the template checkout (storefront check-layers --check, admin
        check-design) so a damaged or half-edited template is never applied.
     3. Copies ONLY the template's `lockedPaths`, minus `merchantOwnedPaths` (public/config.js, wrangler.jsonc: never
        overwritten). Files removed from the template's locked paths are removed here. `designPaths`, .gitignore and
        everything else are never touched. A template whose lockedPaths overlap this repo's design paths (or that list
        unsafe paths) is refused.
     4. Merges the template's hash manifests (merchant-owned entries keep this repo's value), writes
        .template-version and the new version / path lists into template.json.
     5. Re-verifies with this repo's real guards (check-layers --check, admin check-design). If anything fails, every
        file is restored and the command exits 1.
     6. Prints exactly what was added / changed / removed.
   DESIGN-LAYER ACTION NEEDED: the incoming docs/CORE-CHANGELOG.md entries (between your version, exclusive, and the new
   one) may carry "Design-layer action:" lines, and a new / removed ShopCommerce function, config key or admin ctx name
   (diff of the public-api.json files) is detected automatically. Then nothing is applied unless you pass
   --ack-design-actions as well as --yes (exit 3 otherwise), and the notice is printed again at the end.

   Options
     --dry-run              print the plan, change nothing (exit 0; exit 3 when a design-layer action would block)
     --yes                  do not ask for confirmation (required when stdin is not a terminal)
     --ack-design-actions   acknowledge the design-layer actions listed
     --allow-untagged       EMERGENCY OVERRIDE: accept a template checkout that is not exactly at the annotated tag
                            v<version> (or has a dirty tree). Loud in the output and recorded in .template-version.
   Exit: 0 ok, 1 failed (and rolled back), 2 refused / usage, 3 design-layer action needs acknowledgement.
   ============================================================ */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { readJson, cmpSemver, inPaths, pathsOverlap, isSafeListedPath, listFiles, trackedFiles, normBytes, isSymlink, sourceInfo, withHistory } from './lib/template.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

class Refuse extends Error { constructor(m, code = 2) { super(m); this.code = code; } }

const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });

function runGuard(cwd, args, label) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, label, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

/** Pure planning step (exported for tests): what a sync would add / change / remove. */
export function plan({ mine, theirs, fromRoot, root, mineTracked, theirsFiles }) {
  const owned = [...new Set([...(mine.merchantOwnedPaths || []), ...(theirs.merchantOwnedPaths || [])])];
  const locked = theirs.lockedPaths || [];
  const add = [], change = [], remove = [], same = [];
  for (const f of theirsFiles) {
    if (!inPaths(f, locked) || inPaths(f, owned)) continue;
    const dst = path.join(root, f);
    if (!existsSync(dst)) add.push(f);
    else if (Buffer.compare(normBytes(path.join(fromRoot, f), f), normBytes(dst, f)) === 0) same.push(f);
    else change.push(f);
  }
  const incoming = new Set(theirsFiles);
  for (const f of mineTracked) {
    // removal only for tracked files inside the (union of old and new) locked paths that the template no longer ships
    // (keepExtraPaths, e.g. .claude/ and .github/, are add / update only: a merchant may keep its own extra files there)
    if ((inPaths(f, locked) || inPaths(f, mine.lockedPaths || [])) && !inPaths(f, owned) && !inPaths(f, theirs.keepExtraPaths || []) && !incoming.has(f)) remove.push(f);
  }
  return { add, change, remove, same, owned };
}

/** "## v1.2.3" sections of a CORE-CHANGELOG, newest first: [{version, body}] */
export function parseChangelog(text) {
  const out = [];
  const re = /^##\s+v?(\d+\.\d+\.\d+)\b[^\n]*\n([\s\S]*?)(?=^##\s+v?\d+\.\d+\.\d+\b|(?![\s\S]))/gm;
  for (const m of text.matchAll(re)) out.push({ version: m[1], body: m[2] });
  return out;
}

/** Design-layer actions: explicit changelog lines for versions in (from, to], plus names added / removed in the public-api.json files. */
export function designActions({ fromVersion, toVersion, changelogText, apiPairs }) {
  const actions = [];
  for (const sec of parseChangelog(changelogText || '')) {
    if (cmpSemver(sec.version, fromVersion) > 0 && cmpSemver(sec.version, toVersion) <= 0) {
      for (const line of sec.body.split(/\r?\n/)) {
        const m = /^\s*[-*]?\s*\**Design-layer action\**:?\**\s*(.+)$/i.exec(line);
        if (m && !/^none\b/i.test(m[1].trim())) actions.push(`v${sec.version}: ${m[1].trim()}`);
      }
    }
  }
  for (const { label, before, after } of apiPairs) {
    const flat = (o) => Object.entries(o || {}).filter(([k]) => k !== '_comment' && Array.isArray(o[k])).flatMap(([k, v]) => v.map((n) => `${k}.${n}`));
    const b = new Set(flat(before)), a = new Set(flat(after));
    for (const n of a) if (!b.has(n)) actions.push(`${label}: NEW ${n} (the design layer may want to adopt it)`);
    for (const n of b) if (!a.has(n)) actions.push(`${label}: REMOVED ${n} (BREAKING: check the design layer still works)`);
  }
  return actions;
}

function mergeManifest(site, mineM, theirsM, owned, rootPrefix) {
  const out = {};
  const isOwned = (k) => inPaths(rootPrefix ? `${rootPrefix}/${k}` : k, owned);
  for (const [k, v] of Object.entries(theirsM)) out[k] = isOwned(k) ? (mineM[k] ?? v) : v;
  for (const [k, v] of Object.entries(mineM)) if (isOwned(k) && !(k in out)) out[k] = v;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

async function confirm(q) {
  if (!process.stdin.isTTY) throw new Refuse('not a terminal: pass --yes to apply without a prompt');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((r) => rl.question(q, r));
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

export async function main(argv = process.argv.slice(2), root = ROOT) {
  const flag = (n) => argv.includes(n);
  const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  const dry = flag('--dry-run'), yes = flag('--yes'), ack = flag('--ack-design-actions'), allowUntagged = flag('--allow-untagged');
  const fromArg = val('--from');
  if (!fromArg || flag('--help')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 40).join('\n')); return fromArg ? 0 : 2; }

  // ---- 1. refusals
  const tplFile = path.join(root, 'template.json');
  if (!existsSync(tplFile)) throw new Refuse('template.json is missing: this is not a merchant repo made by new-merchant.mjs');
  const mine = readJson(tplFile);
  if (mine.isTemplate !== false) throw new Refuse('this is the template repo itself (isTemplate is not false): core sync only runs in a merchant repo');
  const fromRoot = path.resolve(fromArg);
  if (!existsSync(path.join(fromRoot, 'template.json'))) throw new Refuse(`${fromRoot} has no template.json: pass a template checkout`);
  if (realpathSync(fromRoot).toLowerCase() === realpathSync(root).toLowerCase()) throw new Refuse('--from points at this repo itself');
  const theirs = readJson(path.join(fromRoot, 'template.json'));
  if (theirs.name !== mine.name) throw new Refuse(`template name mismatch: this repo follows "${mine.name}", --from is "${theirs.name}"`);
  if (theirs.isTemplate !== true) throw new Refuse('--from is not a template checkout (its template.json does not say isTemplate: true)');
  let cmp;
  try { cmp = cmpSemver(theirs.version, mine.version); } catch (e) { throw new Refuse(`bad version: ${e.message}`); }
  if (cmp <= 0) throw new Refuse(`the template version ${theirs.version} is not newer than this repo's ${mine.version}: nothing to sync`);

  const st = git(root, 'status', '--porcelain', '--untracked-files=all');
  if (st.status !== 0) throw new Refuse('this directory is not a git work tree');
  if (st.stdout.trim()) throw new Refuse(`the working tree is not clean, commit or stash first:\n${st.stdout.trimEnd()}`);

  // path-list sanity: the template may not point the sync at design files or outside the repo
  const owned = [...new Set([...(mine.merchantOwnedPaths || []), ...(theirs.merchantOwnedPaths || [])])];
  const myDesign = Object.values(mine.sites || {}).flatMap((s) => s.designPaths || []);
  const theirDesign = Object.values(theirs.sites || {}).flatMap((s) => s.designPaths || []);
  for (const p of [...(theirs.lockedPaths || []), ...(theirs.merchantOwnedPaths || [])]) {
    if (!isSafeListedPath(p)) throw new Refuse(`the template lists an unsafe path: ${JSON.stringify(p)}`);
  }
  for (const lp of theirs.lockedPaths || []) {
    for (const dp of [...myDesign, ...theirDesign]) {
      if (pathsOverlap(lp, dp)) throw new Refuse(`refused: the template's locked path "${lp}" overlaps the design-layer path "${dp}"; core sync never touches design files`);
    }
  }
  for (const p of ['.git/', '.gitignore', 'template.json', '.template-version']) {
    if ((theirs.lockedPaths || []).some((lp) => pathsOverlap(lp, p))) throw new Refuse(`refused: the template's locked paths include "${p}"`);
  }
  if ((theirs.manifests && Object.values(theirs.manifests).some((p) => !isSafeListedPath(p)))) throw new Refuse('the template lists an unsafe manifest path');

  // ---- 1b. the sync SOURCE is a TAG only (decided 2026-11-25): HEAD exactly at the annotated tag v<version>, clean tree
  const src = sourceInfo(fromRoot, theirs.version);
  if (!src.tagged && !allowUntagged) {
    throw new Refuse(`the template checkout is not at a release tag: ${src.reason}.\n  Check out the tag first (git -C ${fromRoot} checkout v${theirs.version}) and run again.\n  Core syncs come from annotated vX.Y.Z tags only. In an emergency a human may pass --allow-untagged (loud, recorded in .template-version).`);
  }
  if (!src.tagged) {
    console.log('!!!!!!!! --allow-untagged: syncing from an UNTAGGED template checkout !!!!!!!!');
    console.log(`  reason: ${src.reason}`);
    console.log(`  commit: ${src.commit || '(none, not a git checkout)'}${src.dirty ? '  (work tree has uncommitted changes)' : ''}`);
    console.log('  This is recorded in .template-version. Normal syncs must come from an annotated release tag.\n');
  }
  const sourceNote = src.tagged ? `tag v${theirs.version} (commit ${String(src.commit).slice(0, 12)})`
    : `UNTAGGED checkout via --allow-untagged (${src.reason}; commit ${src.commit ? String(src.commit).slice(0, 12) : 'none'}${src.dirty ? ', dirty' : ''})`;

  // ---- 2. the template must verify itself
  const theirsGuards = [
    runGuard(fromRoot, ['scripts/check-layers.mjs', '--check'], 'template: storefront check-layers --check'),
    runGuard(path.join(fromRoot, 'admin'), ['scripts/check-design.mjs'], 'template: admin check-design')
  ];
  for (const g of theirsGuards) if (!g.ok) throw new Refuse(`${g.label} failed inside the template checkout, refusing to sync from a broken template:\n${g.out}`);

  // ---- 3. plan
  const theirsFiles = listFiles(fromRoot);
  for (const f of theirsFiles) if (inPaths(f, theirs.lockedPaths || []) && isSymlink(path.join(fromRoot, f))) throw new Refuse(`the template contains a symbolic link in a locked path: ${f}`);
  const p = plan({ mine, theirs, fromRoot, root, mineTracked: trackedFiles(root), theirsFiles });

  // design-layer actions
  const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const jsonIf = (f) => { try { return JSON.parse(readIf(f)); } catch { return {}; } };
  const actions = designActions({
    fromVersion: mine.version, toVersion: theirs.version,
    changelogText: readIf(path.join(fromRoot, 'docs/CORE-CHANGELOG.md')),
    apiPairs: [
      { label: 'storefront ShopCommerce API', before: jsonIf(path.join(root, 'public/commerce/public-api.json')), after: jsonIf(path.join(fromRoot, 'public/commerce/public-api.json')) },
      { label: 'admin ctx', before: jsonIf(path.join(root, 'admin/lib/public-api.json')), after: jsonIf(path.join(fromRoot, 'admin/lib/public-api.json')) }
    ]
  });

  // ---- report
  console.log(`core sync: ${mine.version} -> ${theirs.version}   (template: ${fromRoot})`);
  console.log(`source: ${sourceNote}`);
  const show = (t, l) => { if (l.length) { console.log(`\n${t} (${l.length}):`); l.forEach((f) => console.log(`  ${t === 'removed' ? '-' : t === 'added' ? '+' : '~'} ${f}`)); } };
  show('added', p.add); show('changed', p.change); show('removed', p.remove);
  console.log(`\nunchanged locked files: ${p.same.length}. merchant-owned (never overwritten): ${p.owned.join(', ') || '(none)'}. design paths (never touched): ${myDesign.join(', ')}`);
  if (actions.length) {
    console.log('\n!! DESIGN-LAYER ACTION NEEDED !!  The incoming core changes things your design layer may need to adopt:');
    actions.forEach((a) => console.log(`  * ${a}`));
    console.log('  Read docs/CORE-CHANGELOG.md, then update the design layer in a design/* branch AFTER this sync.');
  }
  if (dry) { console.log('\n[dry-run] nothing changed'); return actions.length ? 3 : 0; }
  if (actions.length && !ack) {
    console.error('\nrefused: design-layer actions are listed above. Re-run with --yes --ack-design-actions to apply the sync anyway (nothing was changed).');
    return 3;
  }
  if (!p.add.length && !p.change.length && !p.remove.length) console.log('\nthe locked files already match; only the version records will be updated');
  if (!yes && !(await confirm('\napply this sync? [y/N] '))) { console.log('aborted, nothing changed'); return 2; }

  // ---- 4. apply (with an in-memory backup for rollback)
  const touched = new Map();   // path -> Buffer | null (null = did not exist)
  const remember = (rel) => { if (!touched.has(rel)) { const f = path.join(root, rel); touched.set(rel, existsSync(f) ? readFileSync(f) : null); } };
  const rollback = () => {
    for (const [rel, buf] of touched) {
      const f = path.join(root, rel);
      if (buf === null) rmSync(f, { force: true }); else { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, buf); }
    }
  };
  try {
    for (const rel of [...p.add, ...p.change]) {
      remember(rel);
      const dst = path.join(root, rel);
      mkdirSync(path.dirname(dst), { recursive: true });
      writeFileSync(dst, readFileSync(path.join(fromRoot, rel)));
    }
    for (const rel of p.remove) { remember(rel); rmSync(path.join(root, rel), { force: true }); }

    // manifests: merge, merchant-owned entries keep this repo's value
    for (const [site, mrel] of Object.entries(theirs.manifests || {})) {
      const prefix = (theirs.sites?.[site]?.root || '.') === '.' ? '' : theirs.sites[site].root;
      remember(mrel);
      const mineM = existsSync(path.join(root, mrel)) ? readJson(path.join(root, mrel)) : {};
      const merged = mergeManifest(site, mineM, readJson(path.join(fromRoot, mrel)), owned, prefix);
      mkdirSync(path.dirname(path.join(root, mrel)), { recursive: true });
      writeFileSync(path.join(root, mrel), JSON.stringify(merged, null, 2) + '\n');
    }

    // version records and the path lists (merchant-specific fields stay)
    remember('template.json'); remember('.template-version');
    const next = { ...mine, version: theirs.version, description: theirs.description ?? mine.description, sites: theirs.sites, lockedPaths: theirs.lockedPaths, merchantOwnedPaths: theirs.merchantOwnedPaths, templateOnlyPaths: theirs.templateOnlyPaths, keepExtraPaths: theirs.keepExtraPaths, manifests: theirs.manifests, sync: theirs.sync };
    writeFileSync(path.join(root, 'template.json'), JSON.stringify(next, null, 2) + '\n');
    const prevVersionFile = existsSync(path.join(root, '.template-version')) ? readFileSync(path.join(root, '.template-version'), 'utf8') : '';
    writeFileSync(path.join(root, '.template-version'), withHistory(prevVersionFile, theirs.version, `${new Date().toISOString().slice(0, 10)} sync ${mine.version} -> ${theirs.version} from ${sourceNote}`));

    // ---- 5. verify with this repo's own guards
    const guards = [
      runGuard(root, ['scripts/check-layers.mjs', '--check'], 'storefront: scripts/check-layers.mjs --check'),
      runGuard(path.join(root, 'admin'), ['scripts/check-design.mjs'], 'admin: scripts/check-design.mjs'),
      runGuard(path.join(root, 'admin'), ['scripts/test-guard.mjs'], 'admin: scripts/test-guard.mjs')
    ];
    const bad = guards.filter((g) => !g.ok);
    if (bad.length) throw new Error(bad.map((g) => `${g.label} FAILED:\n${g.out.split('\n').slice(-12).join('\n')}`).join('\n\n'));
    for (const g of guards) console.log(`verified: ${g.label}`);
  } catch (e) {
    rollback();
    console.error(`\nSYNC FAILED, every file was restored:\n${e.message}`);
    console.error('(If the admin design guard complains about the design layer, fix the design layer first, then sync again.)');
    return 1;
  }

  console.log(`\nsync done: core is now at template v${theirs.version}. Review with \`git status\` / \`git diff\`, then commit on a branch.`);
  if (actions.length) {
    console.log('\n!! DESIGN-LAYER ACTION NEEDED (again, so it is not missed) !!');
    actions.forEach((a) => console.log(`  * ${a}`));
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((c) => process.exit(c), (e) => {
    if (e instanceof Refuse) { console.error(`refused: ${e.message}`); process.exit(e.code); }
    console.error(e); process.exit(1);
  });
}
