#!/usr/bin/env node
/* ============================================================
   check-content-schema.mjs: lints public/content.schema.json and DRY-RUNS it against a platform instance.
   No dependencies (Node 18+, global fetch). Locked: part of the core.

     node scripts/check-content-schema.mjs [schema-file] --lint     offline sanity checks only (no network, no credentials)
     node scripts/check-content-schema.mjs [schema-file]            lint, then dry-run against the platform

   THE DRY RUN WRITES NOTHING, AND THIS SCRIPT CANNOT REGISTER A SCHEMA. Registration (PUT .../content/schema without
   dry_run=true) is a HUMAN-ONLY step: the schema file is editable by an AI design session, so a human reads the
   dry-run report and then registers with their own login (see .claude/skills/merchant-onboarding and
   docs in the platform repo: docs/content-schema.md). The only request this script sends to the schema endpoint
   is `PUT ...?dry_run=true`. Never run it from CI, a deploy hook or an unattended job.

   Environment (never arguments, never files; nothing is printed except the report):
     CONTENT_API_BASE        required for the dry run, e.g. https://api.<platform-domain>
     CONTENT_SHOP_ID         required, the shop id
     CONTENT_ADMIN_EMAIL     required, a human who holds content.manage (merchant owner or platform admin)
     CONTENT_ADMIN_PASSWORD  required
   Exit: 0 ok, 1 lint failed or the platform rejected the schema (422 with pointers) or removals need confirmation (report shown),
         2 usage / environment error.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_SCHEMA = path.join(ROOT, 'public', 'content.schema.json');

/** Offline lint: the structural rules from the platform's content-schema reference that are cheap to check. Returns problems[]. */
export function lintSchema(doc) {
  const out = [];
  const bad = (ptr, msg) => out.push(`${ptr || '/'}: ${msg}`);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['/: the schema must be a JSON object'];
  if (doc.format !== 2) bad('/format', 'must be 2');
  if (!doc.types || typeof doc.types !== 'object') { bad('/types', 'missing'); return out; }
  for (const [k, def] of Object.entries(doc.types)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(k)) bad(`/types/${k}`, 'type key must match ^[a-z0-9][a-z0-9_-]{0,49}$');
    walk(def && def.schema, `/types/${k}/schema`, true);
  }
  if (!doc.types.global) bad('/types/global', 'a "global" type (shop-wide content) is expected');
  for (const [k, d] of Object.entries(doc.documents || {})) if (!doc.types[d && d.type]) bad(`/documents/${k}`, `unknown type ${JSON.stringify(d && d.type)}`);
  for (const [k, d] of Object.entries(doc.collections || {})) if (!doc.types[d && d.type]) bad(`/collections/${k}`, `unknown type ${JSON.stringify(d && d.type)}`);

  function walk(s, ptr, root = false) {
    if (!s || typeof s !== 'object') return bad(ptr, 'not a schema object');
    for (const bannedKey of ['$id', '$anchor', 'patternProperties', 'propertyNames', 'allOf', 'anyOf', 'not', 'if', 'then', 'else', 'uniqueItems', 'multipleOf']) {
      if (bannedKey in s) bad(`${ptr}/${bannedKey}`, 'not allowed by the platform vocabulary');
    }
    if ('$schema' in s && !root) bad(`${ptr}/$schema`, '$schema is allowed only at the root of a type');
    if (s.type === 'object') {
      if (s.additionalProperties !== false) bad(ptr, 'every object needs additionalProperties: false');
      for (const [p, sub] of Object.entries(s.properties || {})) {
        if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(p)) bad(`${ptr}/properties/${p}`, 'bad property name');
        walk(sub, `${ptr}/properties/${p}`);
      }
    } else if (s.type === 'array') {
      if (!Number.isInteger(s.maxItems) || s.maxItems < 1 || s.maxItems > 200) bad(ptr, 'every array needs maxItems (1..200)');
      if (!('default' in s)) bad(ptr, 'every array needs a default (use [])');
      if (!s.items) bad(ptr, 'every array needs items'); else walk(s.items, `${ptr}/items`);
    } else if (s.type === 'string') {
      if (!('default' in s)) bad(ptr, 'every string needs a default');
      if (!('const' in s) && !('enum' in s) && !Number.isInteger(s.maxLength)) bad(ptr, 'every string needs maxLength');
      if (typeof s.default === 'string' && Number.isInteger(s.maxLength) && s.default.length > s.maxLength) bad(ptr, 'default is longer than maxLength');
      if (typeof s.default !== 'string' && 'default' in s) bad(ptr, 'default must be a string');
    } else if (['integer', 'number', 'boolean'].includes(s.type)) {
      if (!('default' in s)) bad(ptr, `every ${s.type} needs a default`);
    } else bad(ptr, `unsupported or missing type ${JSON.stringify(s.type)}`);
    for (const t of ['title', 'description']) if (typeof s[t] === 'string' && /[<>]/.test(s[t])) bad(`${ptr}/${t}`, 'plain text only (no < or >)');
  }
  return out;
}

function parseJsonFile(file) {
  const text = readFileSync(file, 'utf8');
  return { text, doc: JSON.parse(text) };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const lintOnly = argv.includes('--lint');
  const files = argv.filter((a) => !a.startsWith('--'));
  if (files.length > 1 || argv.some((a) => a.startsWith('--') && a !== '--lint')) { console.error('usage: node scripts/check-content-schema.mjs [schema-file] [--lint]   (credentials only from CONTENT_* environment variables)'); return 2; }
  const file = path.resolve(files[0] || DEFAULT_SCHEMA);
  let parsed;
  try { parsed = parseJsonFile(file); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); return 2; }
  const problems = lintSchema(parsed.doc);
  if (problems.length) {
    console.error(`LINT FAILED for ${path.relative(ROOT, file) || file}:`);
    problems.forEach((p) => console.error(`  - ${p}`));
    return 1;
  }
  console.log(`lint ok: ${Object.keys(parsed.doc.types).length} type(s) (${Object.keys(parsed.doc.types).join(', ')})`);
  if (lintOnly) return 0;

  const API = (env.CONTENT_API_BASE || '').replace(/\/+$/, '');
  const SHOP = env.CONTENT_SHOP_ID, EMAIL = env.CONTENT_ADMIN_EMAIL, PASSWORD = env.CONTENT_ADMIN_PASSWORD;
  if (!API || !SHOP || !EMAIL || !PASSWORD) {
    console.error('missing env: CONTENT_API_BASE, CONTENT_SHOP_ID, CONTENT_ADMIN_EMAIL and CONTENT_ADMIN_PASSWORD are required for the dry run (never pass credentials as arguments). Use --lint for the offline check only.');
    return 2;
  }
  if (!/^\d+$/.test(SHOP)) { console.error('CONTENT_SHOP_ID must be a number'); return 2; }
  const call = async (method, p, body, token) => {
    const res = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };
  const login = await call('POST', '/api/v1/admin/auth/login', { email: EMAIL, password: PASSWORD });
  const token = login.json && login.json.access_token;
  if (!token) { console.error(`login failed (HTTP ${login.status})`); return 2; }
  // The ONLY schema request this script makes: dry_run=true, which the platform guarantees writes nothing.
  const r = await call('PUT', `/api/v1/admin/shops/${SHOP}/content/schema?dry_run=true`, parsed.text, token);
  if (r.status === 200 && r.json) {
    console.log(`dry run ok (HTTP 200): active version ${r.json.version}, would register version ${r.json.would_register_version}, changed: ${r.json.changed}`);
    for (const d of (r.json.report && r.json.report.documents) || []) {
      console.log(`  ${d.kind} ${d.key}: ${d.status}${(d.removed_paths || []).length ? ` (would drop ${d.removed_paths.length} value(s))` : ''}`);
    }
    console.log('Nothing was registered. Registration is a human step: read this report, then see .claude/skills/merchant-onboarding (content schema).');
    return 0;
  }
  console.error(`dry run answered HTTP ${r.status}:`);
  console.error(r.json ? JSON.stringify(r.json, null, 2) : r.text.slice(0, 2000));
  return r.status === 409 || r.status === 422 ? 1 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(2); });
}
