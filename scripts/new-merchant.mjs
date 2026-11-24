#!/usr/bin/env node
/* ============================================================
   new-merchant.mjs: creates a merchant repo from this template. No dependencies (Node 18+).

     node scripts/new-merchant.mjs <target-dir> --name "<Shop name>" --slug <slug>
          [--api-base <url>] [--publishable-key <pk_...>] [--site-url <storefront origin>]
          [--admin-origin <admin origin>] [--no-git]

   RUN BY A HUMAN. It writes the merchant's real config.js values and re-locks the hash manifests, which are
   steps that AI design sessions must never do. It never pushes anything and creates no GitHub repo.

   What it does
     * refuses to touch a non-empty target directory (an existing EMPTY directory is fine)
     * copies the template files (no .git, no tags, no node_modules, no template-only files: see
       template.json "templateOnlyPaths")
     * sets the brand name in the storefront metadata (index.html title / og tags), the storefront copy
       (content.js brand + store name), the admin copy (admin/design/copy.js app.name, shop fallback) and
       wrangler.jsonc (worker name = slug)
     * writes apiBase / publishableKey into public/config.js when given, otherwise leaves the clearly marked
       REPLACE_WITH_* placeholders (check-layers then warns until a human fills them in)
     * sets "isTemplate": false, records the template version in .template-version and template.json
     * re-locks the hash manifests (check-layers --update, admin check-design --update) after all edits
     * writes a short merchant README.md, runs `git init -b main` and makes the initial commit
   Next steps are printed at the end (platform provisioning, origins, key, catalogue import, hosting).
   ============================================================ */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readJson, inPaths, listFiles } from './lib/template.mjs';

const TEMPLATE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const die = (m, code = 2) => { console.error(`new-merchant: ${m}`); process.exit(code); };

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--no-git') a.noGit = true;
    else if (t.startsWith('--')) { a[t.slice(2)] = argv[++i]; if (a[t.slice(2)] === undefined) die(`${t} needs a value`); }
    else a._.push(t);
  }
  return a;
}

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function replaceOnce(text, from, to, what) {
  if (!text.includes(from)) throw new Error(`template text not found for ${what}: ${JSON.stringify(from.slice(0, 60))} (did the template change?)`);
  return text.replace(from, () => to);
}
const jsStr = (s) => JSON.stringify(s);   // a double-quoted JS/JSON string literal (escapes quotes and backslashes)

export function createMerchant({ target, name, slug, apiBase, publishableKey, siteUrl, adminOrigin, git = true, templateRoot = TEMPLATE_ROOT }) {
  const tpl = readJson(path.join(templateRoot, 'template.json'));
  if (tpl.isTemplate !== true) throw new Error('this checkout is not the template (template.json isTemplate is not true)');
  if (!name || !name.trim() || name.length > 60 || /[\r\n]/.test(name)) throw new Error('--name is required (1 to 60 characters, one line)');
  if (!slug || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) throw new Error('--slug is required: lowercase letters, digits and hyphens (2 to 41 characters)');
  const origin = (v, flag, https = false) => {
    if (v === undefined) return null;
    let u; try { u = new URL(v); } catch { throw new Error(`${flag} must be an absolute URL`); }
    if (!/^https?:$/.test(u.protocol) || (https && u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname))) throw new Error(`${flag} must be https (http only for localhost)`);
    return u;
  };
  const api = origin(apiBase, '--api-base', true);
  const site = origin(siteUrl, '--site-url', true);
  const admin = origin(adminOrigin, '--admin-origin', true);
  if (publishableKey !== undefined && !/^pk_[A-Za-z0-9_]{8,}$/.test(publishableKey)) throw new Error('--publishable-key must look like pk_... (letters, digits, underscore)');

  const dest = path.resolve(target);
  if (existsSync(dest)) {
    if (readdirSync(dest).length) throw new Error(`refusing to use ${dest}: it exists and is not empty`);
  }
  const realTpl = realpathSync(templateRoot).toLowerCase();
  const probe = existsSync(dest) ? realpathSync(dest).toLowerCase() : path.resolve(dest).toLowerCase();
  if (probe === realTpl || probe.startsWith(realTpl + path.sep)) throw new Error('the target must be outside the template directory');
  mkdirSync(dest, { recursive: true });

  // ---- copy
  const skip = [...(tpl.templateOnlyPaths || []), '.template-version'];
  let n = 0;
  for (const f of listFiles(templateRoot)) {
    if (inPaths(f, skip) || /(^|\/)config\.local\.js$/.test(f)) continue;
    const to = path.join(dest, f);
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(path.join(templateRoot, f), to);
    n++;
  }

  const edit = (rel, fn) => { const f = path.join(dest, rel); writeFileSync(f, fn(readFileSync(f, 'utf8'))); };
  const shopName = name.trim();

  // ---- storefront metadata and copy
  edit('public/index.html', (t) => {
    t = replaceOnce(t, '<title>你的商店</title>', `<title>${escHtml(shopName)}</title>`, 'index.html title');
    t = replaceOnce(t, '<meta name="description" content="你的商店 — 這是商店的簡短介紹，請換成自己的文字。">', `<meta name="description" content="${escHtml(shopName)}：歡迎選購。">`, 'index.html description');
    t = replaceOnce(t, '<meta property="og:title" content="你的商店">', `<meta property="og:title" content="${escHtml(shopName)}">`, 'og:title');
    t = replaceOnce(t, '<meta property="og:description" content="這是商店的簡短介紹，請換成自己的文字。">', `<meta property="og:description" content="${escHtml(shopName)}：歡迎選購。">`, 'og:description');
    t = replaceOnce(t, '<meta property="og:site_name" content="你的商店">', `<meta property="og:site_name" content="${escHtml(shopName)}">`, 'og:site_name');
    if (site) {
      const base = site.origin + '/';
      t = replaceOnce(t, 'content="https://shop.example.com/">', `content="${escHtml(base)}">`, 'og:url');
      t = replaceOnce(t, 'content="https://shop.example.com/assets/og-cover.png">', `content="${escHtml(base)}assets/og-cover.png">`, 'og:image');
    }
    return t;
  });
  edit('public/content.js', (t) => {
    t = replaceOnce(t, "brand: { name: '你的商店', footer: '你的商店' },", `brand: { name: ${jsStr(shopName)}, footer: ${jsStr(shopName)} },`, 'content.js brand');
    t = replaceOnce(t, "store: {\n    name: '你的商店',", `store: {\n    name: ${jsStr(shopName)},`, 'content.js store name');
    t = replaceOnce(t, 'titleHtml: \'關於<br>你的商店\',\n    lede: \'用幾句話介紹你的品牌與理念。\'', `titleHtml: ${jsStr('關於<br>' + escHtml(shopName))},\n    lede: '用幾句話介紹你的品牌與理念。'`, 'storyTeaser');
    t = replaceOnce(t, 'titleHtml: \'關於<br>你的商店\',\n    paragraphs', `titleHtml: ${jsStr('關於<br>' + escHtml(shopName))},\n    paragraphs`, 'story');
    return t;
  });

  // ---- admin copy (design layer; design-defaults stays neutral, it is the locked fallback)
  edit('admin/design/copy.js', (t) => {
    t = replaceOnce(t, '"app.name": "商店後台"', `"app.name": ${jsStr(shopName + '後台')}`, 'admin app.name');
    t = replaceOnce(t, '"home.shopFallback": "商店"', `"home.shopFallback": ${jsStr(shopName)}`, 'admin shop fallback');
    return t;
  });

  // ---- wrangler worker name (merchant-owned)
  edit('wrangler.jsonc', (t) => replaceOnce(t, '"name": "merchant-template"', `"name": ${jsStr(slug)}`, 'wrangler name'));

  // ---- config.js (locked + merchant-owned): real values, or the marked placeholders
  if (api || publishableKey !== undefined) {
    edit('public/config.js', (t) => {
      if (api) t = replaceOnce(t, "apiBase: 'REPLACE_WITH_PLATFORM_API_BASE',", `apiBase: ${jsStr(api.origin)},`, 'apiBase');
      if (publishableKey !== undefined) t = replaceOnce(t, "publishableKey: 'REPLACE_WITH_PUBLISHABLE_KEY',", `publishableKey: ${jsStr(publishableKey)},`, 'publishableKey');
      return t;
    });
  }

  // ---- template.json and .template-version
  const next = { ...tpl, isTemplate: false, merchant: { name: shopName, slug, siteUrl: site ? site.origin : null, adminOrigin: admin ? admin.origin : null } };
  delete next.description;
  writeFileSync(path.join(dest, 'template.json'), JSON.stringify(next, null, 2) + '\n');
  writeFileSync(path.join(dest, '.template-version'), tpl.version + '\n');

  // ---- merchant README (the template's README is template-only)
  writeFileSync(path.join(dest, 'README.md'), merchantReadme({ shopName, slug, version: tpl.version, site, admin }));

  // ---- re-lock the hash manifests (the human step), then verify
  const run = (cwd, args) => {
    const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${args.join(' ')} failed in ${cwd}:\n${r.stdout}${r.stderr}`);
    return r.stdout;
  };
  run(dest, ['scripts/check-layers.mjs', '--update']);
  run(path.join(dest, 'admin'), ['scripts/check-design.mjs', '--update']);
  run(dest, ['scripts/check-layers.mjs', '--check']);
  run(path.join(dest, 'admin'), ['scripts/check-design.mjs']);

  // ---- git
  if (git) {
    const g = (...a) => { const r = spawnSync('git', a, { cwd: dest, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout; };
    g('init', '-b', 'main');
    g('add', '-A');
    const has = (k) => spawnSync('git', ['config', k], { cwd: dest, encoding: 'utf8' }).stdout.trim();
    const ident = has('user.name') && has('user.email') ? [] : ['-c', 'user.name=merchant-template', '-c', 'user.email=merchant-template@localhost'];
    g(...ident, 'commit', '-q', '-m', `Initial commit from merchant-template v${tpl.version}\n\nCreated by scripts/new-merchant.mjs for "${shopName}" (${slug}).`);
  }
  return { dest, files: n, version: tpl.version, hasConfig: !!(api && publishableKey !== undefined) };
}

function merchantReadme({ shopName, slug, version, site, admin }) {
  return `# ${shopName}

Merchant site (storefront + admin) created from **merchant-template v${version}** (\`${slug}\`).
Layout, layers, guards and rules are the template's; see \`CLAUDE.md\` (rules for design sessions) and \`admin/README.md\`.

\`\`\`
public/   storefront (the only directory Cloudflare publishes)      scripts/  guards, sync-core, import-catalog
admin/    merchant back office (served separately, same origin as the API, behind Cloudflare Access)
catalog/  catalogue data for scripts/import-catalog.mjs
\`\`\`

- Storefront: \`python3 -m http.server 8080 --directory public\` (local API override: \`public/config.local.js\`, copy \`public/config.local.js.example\`).
- Admin: \`cd admin && node scripts/serve.mjs --proxy <API>\` (local override: \`admin/config.local.js\`).
- Guards: \`node scripts/check-layers.mjs --check\`, \`node admin/scripts/check-design.mjs --base <ref>\`, \`node scripts/check-scope.mjs <storefront|admin> --base <ref>\`.
- \`public/config.js\` holds this shop's real \`apiBase\` and \`publishableKey\` (locked and hash-protected; a human edits it, then runs \`node scripts/check-layers.mjs --update\`).
- Core updates: a human runs \`node scripts/sync-core.mjs --from <template checkout> --dry-run\` (never an AI session).
${site ? `\nStorefront origin: ${site.origin}\n` : ''}${admin ? `Admin origin: ${admin.origin}\n` : ''}`;
}

function nextSteps(r, name, slug, flags) {
  console.log(`
created ${r.dest}
  ${r.files} files copied from merchant-template v${r.version}, manifests re-locked, initial commit made (no remote, nothing pushed).

Next steps (see .claude/skills/merchant-onboarding for the platform side):
  1. ${r.hasConfig ? 'config.js already holds apiBase and publishableKey.' : 'public/config.js still has REPLACE_WITH_* placeholders: after the platform provisions the shop and issues a publishable key, a human edits apiBase / publishableKey and runs  node scripts/check-layers.mjs --update  (check-layers warns until then).'}
  2. Register the storefront origin${flags.siteUrl ? ` (${flags.siteUrl})` : ''} as purpose=storefront and the admin origin${flags.adminOrigin ? ` (${flags.adminOrigin})` : ''} as purpose=admin on the platform; add the admin origin to the R2 bucket CORS.
  3. Import the catalogue: copy catalog/catalog.sample.json to catalog/catalog.json, edit it, then
       IMPORT_API_BASE=... IMPORT_ADMIN_EMAIL=... IMPORT_ADMIN_PASSWORD=... node scripts/import-catalog.mjs catalog/catalog.json --dry-run
  4. Create the GitHub repo and Cloudflare / hosting setup yourself (this script never does).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = parseArgs(process.argv.slice(2));
  if (a._.length !== 1 || !a.name || !a.slug) die('usage: node scripts/new-merchant.mjs <target-dir> --name "<Shop name>" --slug <slug> [--api-base <url>] [--publishable-key <key>] [--site-url <url>] [--admin-origin <url>] [--no-git]');
  try {
    const r = createMerchant({ target: a._[0], name: a.name, slug: a.slug, apiBase: a['api-base'], publishableKey: a['publishable-key'], siteUrl: a['site-url'], adminOrigin: a['admin-origin'], git: !a.noGit });
    nextSteps(r, a.name, a.slug, { siteUrl: a['site-url'], adminOrigin: a['admin-origin'] });
  } catch (e) { die(e.message, 1); }
}
