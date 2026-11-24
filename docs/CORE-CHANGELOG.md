# Core changelog

Versioned changes to the LOCKED core of the merchant template (`template.json` `lockedPaths`). Merchant repos receive
them through `node scripts/sync-core.mjs` (run by a human, never by an AI session). `sync-core` reads this file from the
incoming template and prints every section newer than the merchant's current version.

Format rules (the sync script parses them):

* One `## vX.Y.Z` heading per version, newest first, followed by free text.
* A line starting with `Design-layer action:` (optionally after `-` or `*`) means the merchant's DESIGN layer may need
  to change to adopt or survive this core version (a new `ShopCommerce` function, a new `SHOP_CONFIG` key, a new or
  removed admin `ctx` function, a new copy key, a renamed or removed name). `sync-core` then refuses to apply the sync
  until the human passes `--ack-design-actions`. Write `Design-layer action: none` (or omit the line) when no action
  is needed. Additions to the two `public-api.json` files are also detected automatically.

## v0.1.0

Baseline: the first neutral template, extracted from a production merchant site (storefront + admin) and made
category-agnostic. Everything below is the starting point; later versions only describe differences.

Design-layer action: none (baseline).

* Storefront locked layer: `public/commerce/` (API client + catalogue loader, cart, checkout and payment redirect,
  `public-api.json`), `public/config.js`, guard scripts `scripts/check-layers.mjs`, `scripts/check-scope.mjs`,
  `scripts/check-locked.mjs`, importer `scripts/import-catalog.mjs`, `scripts/sync-core.mjs`.
* Admin locked core: `admin/{app.js,index.html,config.js,config-loader.js,styles.css}`, `admin/{lib,core,ui,vendor,design-defaults}/`,
  `admin/scripts/` (design guard, layer guard, guard tests, dev server), `admin/e2e/`, `admin/docs/`, `admin/deploy/`.
* Namespaces are neutral: `window.ShopCommerce`, `window.SHOP_CONFIG`, `window.SHOP_CONTENT`, storage keys
  `shopcommerce:*`; admin `window.ADMIN_CONFIG`, session keys `admin.*` (full map in `docs/TEMPLATE-NOTES.md`).
* `public/config.js` is locked and hash-protected everywhere but merchant-owned: placeholders are enforced only when
  `template.json` has `isTemplate: true`; merchant repos carry the real `apiBase` / `publishableKey` and only the
  manifest hash protects them. `sync-core` never overwrites it.
* No third-party font requests: `admin/index.html` no longer links Google Fonts (the admin CSP drops
  `fonts.googleapis.com` / `fonts.gstatic.com`); both sites use a system font stack.
* Admin hosting files: `admin/deploy/` (nginx config with the strict CSP, Dockerfile, tunnel ingress example).
* `admin/e2e/smoke.mjs`: a one-minute admin smoke test next to the full suite (`run.mjs`) and the design suite (`design.mjs`).
* `.github/workflows/guards.yml`: storefront guard, admin guards, per-branch scope check and locked-path check.
