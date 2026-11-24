/* Shared helpers for scripts/new-merchant.mjs and scripts/sync-core.mjs. No dependencies (Node 18+).
   Locked: part of the core, synced to merchant repos. */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const posix = (p) => p.split(path.sep).join('/');

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** "1.2.3" -> [1,2,3]; throws on anything else (no pre-release tags: template versions are plain). */
export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v));
  if (!m) throw new Error(`not a plain semver version: ${JSON.stringify(v)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
export function cmpSemver(a, b) {
  const x = parseSemver(a), y = parseSemver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** A listed path ending in "/" is a directory prefix, anything else is one file. */
export const inPaths = (file, paths) => paths.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

/** Two listed paths overlap when one contains the other (file vs dir prefix included). */
export function pathsOverlap(a, b) {
  const d = (p) => (p.endsWith('/') ? p : null);
  if (a === b) return true;
  if (d(a) && b.startsWith(a)) return true;
  if (d(b) && a.startsWith(b)) return true;
  return false;
}

/** A listed path from a template.json is safe to act on: relative, forward slashes, no "..", not inside .git. */
export function isSafeListedPath(p) {
  return typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !/^[A-Za-z]:/.test(p) && !p.includes('\\')
    && !p.split('/').includes('..') && !p.startsWith('./') && p.split('/')[0] !== '.git';
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);
function walk(root, dir = '') {
  const abs = path.join(root, dir);
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    if (SKIP_DIRS.has(e.name)) return [];
    const rel = dir ? `${dir}/${e.name}` : e.name;
    return e.isDirectory() ? walk(root, rel) : [rel];
  });
}

/** Files of a checkout, relative posix paths: tracked + untracked-but-not-ignored when it is a git work tree, else a plain walk. */
export function listFiles(root) {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
    if (path.resolve(top).toLowerCase() === path.resolve(root).toLowerCase()) {
      return [...new Set(out.split('\0').filter(Boolean))].filter((f) => existsSync(path.join(root, f))).sort();
    }
  } catch { /* not a git checkout of its own */ }
  return walk(root).sort();
}

/** Git-tracked files only (what a merchant repo owns; ignored local files are never touched). */
export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').split('\0').filter(Boolean).sort();
}

const TEXT_EXT = new Set(['.js', '.mjs', '.css', '.html', '.json', '.jsonc', '.md', '.txt', '.svg', '.yml', '.yaml', '.conf', '.example', '.template', '']);
export const isText = (rel) => TEXT_EXT.has(path.extname(rel).toLowerCase()) || path.basename(rel) === 'Dockerfile';

/** Bytes with CRLF normalised to LF for text files, so CRLF checkouts compare and hash like LF. */
export function normBytes(file, rel) {
  let buf = readFileSync(file);
  if (isText(rel)) buf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'));
  return buf;
}
export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export function isSymlink(file) {
  try { return lstatSync(file).isSymbolicLink(); } catch { return false; }
}

/**
 * Where does a template checkout stand relative to the release tags? Used by sync-core (tag-only sync source) and
 * new-merchant (provenance). `tagged` is true only when HEAD is exactly at an ANNOTATED tag vX.Y.Z that equals
 * `v<version>` and the work tree is clean (what is on disk is what the tag contains).
 * Returns { git, commit, tags, annotated, dirty, tagged, reason }.
 */
export function sourceInfo(root, version) {
  const g = (...a) => { try { return { ok: true, out: execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim() }; } catch { return { ok: false, out: '' }; } };
  const same = (a, b) => { try { return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase(); } catch { return false; } };
  const top = g('rev-parse', '--show-toplevel');
  if (!top.ok || !same(top.out, root)) return { git: false, commit: null, tags: [], annotated: [], dirty: false, tagged: false, reason: 'not a git checkout of its own (a copied or exported folder has no tag)' };
  const commit = g('rev-parse', 'HEAD').out || null;
  const dirty = g('status', '--porcelain', '--untracked-files=all').out !== '';
  const tags = g('tag', '--points-at', 'HEAD').out.split(/\r?\n/).filter(Boolean);
  const annotated = tags.filter((t) => /^v\d+\.\d+\.\d+$/.test(t) && g('cat-file', '-t', `refs/tags/${t}`).out === 'tag');
  let reason = null;
  if (!annotated.length) reason = tags.length ? `HEAD has tag(s) ${tags.join(', ')} but none is an annotated vX.Y.Z tag` : 'HEAD is not at any release tag (an annotated vX.Y.Z)';
  else if (!annotated.includes(`v${version}`)) reason = `HEAD is at ${annotated.join(', ')} but template.json says version ${version}: the tag and template.json disagree`;
  else if (dirty) reason = `the work tree has uncommitted changes (not exactly what tag v${version} contains)`;
  return { git: true, commit, tags, annotated, dirty, tagged: reason === null, reason };
}

/** New text of .template-version: the version on the first line, then a `#` history (newest first). */
export function withHistory(previousText, version, entry) {
  const old = String(previousText || '').split(/\r?\n/).slice(1).filter((l) => l.startsWith('#') && !l.startsWith('# core history'));
  return [version, '# core history (newest first; written by new-merchant.mjs and sync-core.mjs)', `# ${entry}`, ...old].join('\n') + '\n';
}
