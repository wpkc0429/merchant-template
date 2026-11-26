# Default merchant template

The shared base from which every merchant's website is created: a **storefront** (repo root: `public/`,
`wrangler.jsonc`, `scripts/`) and the merchant **admin** (`admin/`) in one repo, zero build, no dependencies, no backend
of its own. Both talk to the e-commerce platform's API. The default design is a neutral, minimal,
category-agnostic retail look with placeholder brand, copy and a sample catalogue; the AI later restyles it, per merchant,
inside a fenced "design layer".

* `CLAUDE.md`: rules for design sessions (AI) and, separately, for the human maintainers of the locked core.
* `docs/TEMPLATE-NOTES.md`: guide for adapting an existing storefront, every locked-code change, known limitations, open decisions.
* `docs/CORE-CHANGELOG.md`: versioned core changes (`v0.1.0` = baseline, `v0.2.0` = the 2026-11-25 decisions); `template.json` holds the version.
* `docs/DECISIONS.md`: the standing decisions (strict CSP is a deployment requirement, `admin/styles.css` stays locked, fixed
  warnings in irreversible confirmations, locked-core changes are human-reviewed, merchant repos come from `new-merchant.mjs` and
  syncs from a tag only, the content schema is registered by a human only).
* `.claude/skills/`: `storefront-design`, `admin-design` (operating manuals for design sessions), `merchant-onboarding` (the
  platform operator's playbook this template instantiates), `core-change` (the human-reviewed process for changing the locked
  core or the `ctx` surface) and `template-release-and-sync` (releasing a version, syncing it into a merchant).

## Create a merchant

```bash
node scripts/new-merchant.mjs ../my-shop --name "My Shop" --slug my-shop \
  [--api-base https://api.example.com] [--publishable-key pk_...] \
  [--site-url https://shop.example.com] [--admin-origin https://admin.shop.example.com]
```

This is the only way to create a merchant repo (GitHub's "Use this template" button is just for finding the template). Run by a
human. It refuses a non-empty target, copies the template (no `.git`, no template-only files), sets the brand
name in the storefront metadata and copy and in the admin copy, writes the real `public/config.js` values if given
(otherwise leaves the `REPLACE_WITH_*` placeholders, which `check-layers` then reports as a warning), sets
`isTemplate: false`, records the version in `.template-version` and `template.json`, re-locks both hash manifests,
runs `git init` and makes the initial commit (provenance, including the tag and commit, goes into the `.template-version` history).
It creates no GitHub repo and pushes nothing. At the end it prints the next steps, including the **human-only content schema
registration** (below). The platform side (shop, owner, origins, publishable key, R2, Cloudflare) is
`.claude/skills/merchant-onboarding`.

### Content schema (human registration only)

`public/content.schema.json` describes the shop's editable content (brand, store info, hero, story, FAQ, product info) for the
platform's per-shop content schema; it matches `public/content.js` field for field (a test checks it) and is a storefront
**design-layer** file. **Editing it registers nothing, and registration is a human step**: never CI, the AI edit service, a deploy
hook or an unattended script. A human who holds `content.manage` (the shop owner or a platform admin):

```bash
node scripts/check-content-schema.mjs --lint                      # offline sanity check, no credentials
CONTENT_API_BASE=https://api.example.com CONTENT_SHOP_ID=12 CONTENT_ADMIN_EMAIL=... CONTENT_ADMIN_PASSWORD=... \
  node scripts/check-content-schema.mjs                            # 1. dry run on the platform: writes nothing, prints the report
# 2. register for real (platform docs/content-schema.md, merchant-onboarding skill step 11a): PUT .../content/schema
# 3. only if the platform answers 409 removals_require_confirmation: review the removals, then repeat with ?confirm_removals=true
```

Since v0.3.0 the template consumes and edits the platform content store. Storefront: the locked `ShopCommerce.content` fetches the
published documents at runtime (ETag, cache, preview mode `?content_preview=<token>`, safe render helpers; the allowlist in
`public/commerce/content-allowlist.json` is a byte copy of the platform's) and the design layer overlays them on the defaults of
`public/content.js`, which stay the fallback. Admin: new `ctx` content functions, a core form builder and default screens
(documents, editor, revisions, schema status; permissions `content.view/edit/publish/manage`); registering a schema is a core
action with a human confirmation dialog. The admin host needs `ADMIN_SITE_ORIGIN` (preview link, schema proxy). See
`docs/CORE-CHANGELOG.md` v0.3.0 and `docs/DECISIONS.md` D7-D10. Platform CORS: the platform API must allow the request headers `If-None-Match` and `X-Preview-Token` and expose `ETag` (`Access-Control-Expose-Headers: ETag`) for the storefront content request. Content images show only from catalogue image origins or `SHOP_CONFIG.imageOrigin` (set it to have them at first paint). `ADMIN_SITE_ORIGIN` must be `https://host[:port]` (validated at start-up; the schema proxy resolves it per request).

Then load the catalogue (credentials only from the environment):

```bash
cp catalog/catalog.sample.json catalog/catalog.json        # edit: your categories, products, prices, photos
IMPORT_API_BASE=https://api.example.com IMPORT_ADMIN_EMAIL=... IMPORT_ADMIN_PASSWORD=... \
  node scripts/import-catalog.mjs catalog/catalog.json --dry-run     # then without --dry-run
```

`import-catalog.mjs` is idempotent (upsert by slug / `sku_code` / name; images through the real presign, PUT, attach
flow), validates the file first, and never deletes anything. The sample catalogue is eight made-up products with
placeholder prices and generated placeholder images (`node scripts/gen-placeholders.mjs` regenerates them).

## Run the sites

```bash
# storefront: http://localhost:8080  (point it at an API with public/config.local.js, copy the .example)
python3 -m http.server 8080 --directory public

# admin: http://localhost:3001  (same-origin through the proxy; copy admin/config.local.js.example)
cd admin && node scripts/serve.mjs --proxy http://127.0.0.1:8080
```

Dev servers and preview mode: the admin treats every host that is not `localhost`, `127.0.0.1` or `[::1]` as a deployed host that must serve `preview-config.js` (written by the official nginx image). A host that is neither (for example `serve.mjs` reached through an internal IP or a custom hostname) counts as "preview config missing": the page is locked read-only and the app stops with a notice. Run dev servers on `localhost:3001` (or `127.0.0.1`), or use the official image for any other host name. See `admin/README.md`.

For a throwaway API and the end-to-end suites see `admin/README.md` ("測試"); never use the production database.

## Layout

```
public/            storefront (the only directory Cloudflare publishes)
  commerce/        LOCKED: API client, cart, checkout, public-api.json
  config.js        LOCKED + hash-protected, merchant-owned: apiBase, publishableKey, showPrices, featuredCategory
  _headers         LOCKED + hash-protected: the strict Content-Security-Policy (a deployment requirement)
  app.js content.js content.schema.json styles.css index.html assets/    DESIGN LAYER (storefront)
scripts/           check-layers (storefront guard), check-scope, check-locked, import-catalog, sync-core,
                   lib/, new-merchant + gen-placeholders (template only), commerce.manifest.json
admin/             merchant back office (build-less ES modules)
  lib/ core/ ui/ vendor/ design-defaults/ scripts/ ...    LOCKED core (hash manifest: scripts/core.manifest.json)
  design/          DESIGN LAYER (admin): tokens, theme, copy, routes, views, parts, assets
  deploy/          nginx config with the strict CSP, Dockerfile, tunnel ingress example (nothing is deployed from here)
catalog/           sample catalogue + generated placeholder images
tests/             template-only tests (new-merchant, sync-core, import-catalog, workflow logic)
template.json      name, version, isTemplate, lockedPaths, designPaths, merchantOwnedPaths, sync rules
.github/workflows/guards.yml    CI guards
```

## Layers and guards

Everything that touches money, the API, auth, storage or permissions is in the locked core; the AI edits only the
design layer of one site per session:

| Site | Design layer (editable) | Locked (never from a design session) | Guard |
| --- | --- | --- | --- |
| storefront | `public/app.js content.js content.schema.json styles.css index.html assets/**` | `public/commerce/**`, `public/config.js`, everything else | `node scripts/check-scope.mjs storefront --base <ref>` (scope + `check-layers --check`) |
| admin | `admin/design/**` | all other files under `admin/` | `node scripts/check-scope.mjs admin --base <ref>` (scope + `admin/scripts/check-design.mjs`) |

The design layer reaches the core only through `window.ShopCommerce` (storefront) and `ctx` (admin), restricted to the
names in the two `public-api.json` files; static scans reject network, storage, `eval`, `innerHTML` and so on. The
locked core is protected by sha256 manifests. `config.js` is locked against AI edits in every repo, but the
"must be placeholders" rule applies to the template only (`template.json` `isTemplate`): a merchant repo's real values
are written by `new-merchant.mjs` or a human edit, then a human runs `node scripts/check-layers.mjs --update`.

CI (`.github/workflows/guards.yml`): storefront guard, admin guard and its self-test on every push and pull request;
on `design/storefront-*` / `design/admin-*` branches the matching scope check; on any `design/*` branch
`check-locked` fails the run if a locked path, a manifest or `template.json` is touched. **A human must protect the
deploying branch on GitHub** (require pull requests and the `guards` check, block direct pushes): a workflow cannot
configure that.

## Sync core updates into a merchant repo

The template is tagged with annotated tags (`v0.1.0`, `v0.2.0`, ...). **The sync source is a tag only**: `sync-core` refuses a
template checkout whose HEAD is not exactly at the annotated tag `v<version>` of its `template.json` (or whose tree is dirty),
unless a human passes the loud `--allow-untagged` override (printed in the output and appended to the `.template-version`
history). Core syncs are run per merchant, **by a human, never an AI session** (`.claude/skills/template-release-and-sync`):

```bash
git -C <template checkout> checkout v0.2.0
node scripts/sync-core.mjs --from <template checkout> --dry-run     # shows added / changed / removed + design-layer actions
node scripts/sync-core.mjs --from <template checkout> --yes         # (add --ack-design-actions when it asks)
git diff; git checkout -b core/v0.2.0; git commit -am "Sync core to v0.2.0"
```

It refuses a dirty tree or a template version that is not newer; copies only `lockedPaths` (never `designPaths`,
never `config.js`, `wrangler.jsonc`, `.gitignore`); runs the template's own guards first and the merchant's after, and
restores everything if verification fails. If the new core needs the design layer to adopt something (a new `ctx`
function, a new config key, a removal), it stops with a "design-layer action needed" notice taken from
`docs/CORE-CHANGELOG.md` and from the `public-api.json` diffs.

## Tests

```bash
node tests/run.mjs        # new-merchant, sync-core (tag-only source, refusals, preservation, rollback), import-catalog, workflow logic,
                          # decisions (content schema, CSP guards, fixed confirmation warnings)
node scripts/check-layers.mjs --check && node admin/scripts/check-design.mjs && node admin/scripts/test-guard.mjs
```

## Licence

MIT, see `LICENSE`. The vendored `admin/vendor/heic2any` is MIT too; its own notice stays in `admin/vendor/heic2any.LICENSE.md`.
