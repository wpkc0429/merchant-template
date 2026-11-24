# Default merchant template

The shared base from which every merchant's website is created: a **storefront** (repo root: `public/`,
`wrangler.jsonc`, `scripts/`) and the merchant **admin** (`admin/`) in one repo, zero build, no dependencies, no backend
of its own. Both talk to the e-commerce platform's API. The default design is a neutral, minimal,
category-agnostic retail look with placeholder brand, copy and a sample catalogue; the AI later restyles it, per merchant,
inside a fenced "design layer".

* `CLAUDE.md`: rules for design sessions (AI) and, separately, for the human maintainers of the locked core.
* `docs/TEMPLATE-NOTES.md`: naming map, every locked-code change, known limitations, open decisions.
* `docs/CORE-CHANGELOG.md`: versioned core changes (`v0.1.0` = baseline); `template.json` holds the version.
* `.claude/skills/`: `storefront-design`, `admin-design` (operating manuals for design sessions) and
  `merchant-onboarding` (the platform operator's playbook this template instantiates).

## Create a merchant

```bash
node scripts/new-merchant.mjs ../my-shop --name "My Shop" --slug my-shop \
  [--api-base https://api.example.com] [--publishable-key pk_...] \
  [--site-url https://shop.example.com] [--admin-origin https://admin.shop.example.com]
```

Run by a human. It refuses a non-empty target, copies the template (no `.git`, no template-only files), sets the brand
name in the storefront metadata and copy and in the admin copy, writes the real `public/config.js` values if given
(otherwise leaves the `REPLACE_WITH_*` placeholders, which `check-layers` then reports as a warning), sets
`isTemplate: false`, records the version in `.template-version` and `template.json`, re-locks both hash manifests,
runs `git init` and makes the initial commit. It creates no GitHub repo and pushes nothing. The platform side
(shop, owner, origins, publishable key, R2, Cloudflare) is `.claude/skills/merchant-onboarding`.

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

For a throwaway API and the end-to-end suites see `admin/README.md` ("測試"); never use the production database.

## Layout

```
public/            storefront (the only directory Cloudflare publishes)
  commerce/        LOCKED: API client, cart, checkout, public-api.json
  config.js        LOCKED + hash-protected, merchant-owned: apiBase, publishableKey, showPrices, featuredCategory
  app.js content.js styles.css index.html assets/    DESIGN LAYER (storefront)
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
| storefront | `public/app.js content.js styles.css index.html assets/**` | `public/commerce/**`, `public/config.js`, everything else | `node scripts/check-scope.mjs storefront --base <ref>` (scope + `check-layers --check`) |
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

The template is tagged (`v0.1.0`, ...). In a merchant repo, **by a human, never an AI session**:

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
node tests/run.mjs        # new-merchant, sync-core (refusals, preservation, rollback), import-catalog, workflow logic
node scripts/check-layers.mjs --check && node admin/scripts/check-design.mjs && node admin/scripts/test-guard.mjs
```
