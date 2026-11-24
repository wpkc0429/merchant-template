// Shared helpers for the template tests. No dependencies (Node 18+, node:test). Template-only.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listFiles } from '../scripts/lib/template.mjs';
import { createMerchant } from '../scripts/new-merchant.mjs';

export const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
    siteUrl: 'https://shop.example.com', adminOrigin: 'https://admin.shop.example.com', ...extra
  });
  return { dir, ...r };
}

/** A copy of the template working tree (a stand-in for a checkout of a newer tag), version bumped, manifests re-locked. */
export function makeTemplateCopy(version, mutate = () => {}) {
  const dir = path.join(tmp('mt-tpl-'), 'template');
  for (const f of listFiles(TEMPLATE)) {
    if (/(^|\/)config\.local\.js$/.test(f)) continue;
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    copyFileSync(path.join(TEMPLATE, f), path.join(dir, f));
  }
  const tj = JSON.parse(read(dir, 'template.json'));
  tj.version = version;
  write(dir, 'template.json', JSON.stringify(tj, null, 2) + '\n');
  mutate(dir);
  const a = node(['scripts/check-layers.mjs', '--update'], dir);
  const b = node(['scripts/check-design.mjs', '--update'], path.join(dir, 'admin'));
  if (a.status !== 0 || b.status !== 0) throw new Error(`could not re-lock the template copy:\n${a.out}\n${b.out}`);
  return dir;
}

export const sync = (merchantDir, tplDir, ...flags) => node(['scripts/sync-core.mjs', '--from', tplDir, ...flags], merchantDir);

/** Snapshot of file contents (for "unchanged" assertions). */
export const snap = (root, files) => Object.fromEntries(files.map((f) => [f, existsSync(path.join(root, f)) ? readFileSync(path.join(root, f), 'utf8') : null]));
