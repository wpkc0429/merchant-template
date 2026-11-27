// Shared helpers for the template tests. No dependencies (Node 18+, node:test). Template-only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listFiles } from '../scripts/lib/template.mjs';
import { createMerchant } from '../scripts/new-merchant.mjs';

export const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Versions are relative to the template under test: V1 = what a freshly created merchant is at, V2 / V3 = newer fake releases.
const bumpMinor = (v, n) => { const [a, b] = v.split('.').map(Number); return `${a}.${b + n}.0`; };
export const V1 = JSON.parse(readFileSync(path.join(TEMPLATE, 'template.json'), 'utf8')).version;
export const V2 = bumpMinor(V1, 1);
export const V3 = bumpMinor(V1, 2);
const created = [];
export function tmp(prefix = 'mt-test-') {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(d);
  return d;
}
export function cleanup() { for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true }); }

export function run(cmd, args, cwd, input) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
export const node = (args, cwd) => run(process.execPath, args, cwd);
export const git = (cwd, ...a) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', ...a], cwd);

export const read = (root, rel) => readFileSync(path.join(root, rel), 'utf8');
export const write = (root, rel, text) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };

/** A merchant repo built by new-merchant.mjs, with the real config values, in a scratch dir outside the template. */
export function makeMerchant(extra = {}) {
  const dir = path.join(tmp(), 'shop');
  const r = createMerchant({
    target: dir, name: '測試商店', slug: 'test-shop', apiBase: 'https://api.example.com', publishableKey: 'pk_testkey123456',
    siteUrl: 'https://shop.example.com', imageOrigin: 'https://img.example.com', adminOrigin: 'https://admin.shop.example.com', ...extra
  });
  return { dir, ...r };
}

/**
 * A copy of the template working tree (a stand-in for a checkout of a newer release), version bumped, manifests re-locked,
 * committed in its own git repo. By default HEAD carries the ANNOTATED tag v<version> (what sync-core requires);
 * { tag: false } leaves it untagged, { tag: 'light' } makes a lightweight tag, { dirty: true } leaves an uncommitted change.
 */
export function makeTemplateCopy(version, mutate = () => {}, { tag = true, dirty = false } = {}) {
  const dir = path.join(tmp('mt-tpl-'), 'template');
  for (const f of listFiles(TEMPLATE)) {
    if (/(^|\/)config\.local\.js$/.test(f)) continue;
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    copyFileSync(path.join(TEMPLATE, f), path.join(dir, f));
  }
  const tj = JSON.parse(read(dir, 'template.json'));
  tj.version = version;
  write(dir, 'template.json', JSON.stringify(tj, null, 2) + '\n');
  // The stand-in models a hypothetical NEXT release: the real in-progress section (## vX.Y.Z (UNRELEASED ...)) of the changelog is not part of it
  // (its Design-layer action lines would block every fixture sync until acknowledged).
  write(dir, 'docs/CORE-CHANGELOG.md', read(dir, 'docs/CORE-CHANGELOG.md').replace(/^## v\d+\.\d+\.\d+ \(UNRELEASED[\s\S]*?(?=^## v\d)/m, ''));
  mutate(dir);
  const a = node(['scripts/check-layers.mjs', '--update', '--allow-placeholders'], dir);
  const b = node(['scripts/check-design.mjs', '--update'], path.join(dir, 'admin'));
  if (a.status !== 0 || b.status !== 0) throw new Error(`could not re-lock the template copy:\n${a.out}\n${b.out}`);
  const g = (...x) => { const r = git(dir, ...x); if (r.status !== 0) throw new Error(`git ${x.join(' ')}: ${r.out}`); };
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-q', '-m', `template ${version}`);
  if (tag === true) g('tag', '-a', `v${version}`, '-m', `release ${version}`);
  else if (tag === 'light') g('tag', `v${version}`);
  if (dirty) write(dir, 'docs/CORE-CHANGELOG.md', read(dir, 'docs/CORE-CHANGELOG.md') + '\n<!-- uncommitted -->\n');
  return dir;
}

export const sync = (merchantDir, tplDir, ...flags) => node(['scripts/sync-core.mjs', '--from', tplDir, ...flags], merchantDir);

/** Snapshot of file contents (for "unchanged" assertions). */
export const snap = (root, files) => Object.fromEntries(files.map((f) => [f, existsSync(path.join(root, f)) ? readFileSync(path.join(root, f), 'utf8') : null]));

/** For tests that build a bare scratch dir with only check-layers.mjs: the files check-layers now needs (D20), with example.test origins rendered. */
export function copyHeaderFiles(dir, { apiOrigin = 'https://api.example.com', imageOrigin = 'https://img.example.com' } = {}) {
  mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const f of ['scripts/render-headers.mjs', 'scripts/headers.core.txt']) copyFileSync(path.join(TEMPLATE, f), path.join(dir, f));
  writeFileSync(path.join(dir, 'merchant.headers.json'), JSON.stringify({ apiOrigin, imageOrigin }, null, 2) + '\n');
  const r = node(['scripts/render-headers.mjs'], dir);
  if (r.status !== 0) throw new Error('render-headers failed: ' + r.out);
}
