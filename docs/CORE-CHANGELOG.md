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

## v0.2.1

Security headers fix (audit findings H2 and M7 of the ecommerce launch checklist). Proposed, needs the owner's approval (docs/DECISIONS.md D1 amendment).

Design-layer action: none

* `public/_headers`: `form-action` now allows the ECPay payment hosts (production and stage), so the checkout form POST (`public/commerce/checkout.js`) is not blocked; added Strict-Transport-Security, Permissions-Policy and Cross-Origin-Opener-Policy. script-src and the rest of the CSP are unchanged. `connect-src` / `img-src` stay `https:` (pinning per merchant is a documented follow-up, see the file header).
* `admin/deploy/nginx.conf.template`: added HSTS, Permissions-Policy and COOP; the CSP is unchanged.
* `scripts/check-layers.mjs`: the CSP check also requires a `form-action` directive without a wildcard or bare scheme.
* `scripts/commerce.manifest.json` and `admin/scripts/core.manifest.json` re-locked by the maintainer procedure.

## v0.2.0

Decisions of 2026-11-25 (see docs/DECISIONS.md), all decided by the user. Core changes in short: strict CSP as a deployment
requirement, fixed warnings in irreversible confirmations, tag-only core sync, the content schema file and its tooling.

Design-layer action: admin/design/copy.js: for the eight irreversible confirmations (cancelOrder, shipDelivered, shipReturned, deleteProduct, deleteImage, deleteCategory, disableMember, revokeInvite) the copy key `confirm.<id>.message` was renamed `confirm.<id>.text` (deleteCategory also `messageSub` -> `textSub`) and now holds only an editable lead-in; the warning itself is fixed in the core. The old keys are ignored (the default lead-in and the fixed warning show; the guard prints a note and the console warns) and any `confirm.*.warning` key fails the guard: rename them (take the new defaults from admin/design-defaults/copy.js, then re-apply your wording to title, text and the buttons).
Design-layer action: public/index.html: replace the inline <script> that loads config.local.js with `<script src="commerce/local-config.js"></script>` (the strict CSP in public/_headers blocks inline scripts; check-layers warns until you do). Keep index.html free of inline scripts and on*= attributes.
Design-layer action: add public/content.schema.json (the shop's content-field schema; copy it from the template tag and align it with your public/content.js); optionally change hero / storyTeaser / story `titleHtml: 'a<br>b'` in content.js to a plain-text `title` with a newline and render it with the newline-to-<br> helper `lines()` of the template's app.js, so content.js matches the schema (registering the schema on the platform is a human step; the storefront does not read platform content yet).

* Strict CSP is a deployment requirement. New locked file `public/_headers` (Cloudflare reads it from public/; hash-protected in commerce.manifest.json, synced, not merchant-owned). `scripts/check-layers.mjs` fails when it is missing, has no CSP or weakens it, and reports an inline script in index.html (error in the template, warning in a merchant repo). New locked `public/commerce/local-config.js` loads the optional localhost config.local.js (replaces the inline script). `admin/scripts/check-design.mjs` has a new "deploy" step: admin/deploy/nginx.conf.template and Dockerfile must carry the CSP (on by default, documented as non-optional).
* Fixed warnings: new `admin/core/warnings.js`; `admin/core/actions.js` composes every irreversible confirmation from editable copy plus the fixed warning; `admin/ui/kit.js` `confirmDialog` renders it (`.dlg__warning`, `data-testid="confirm-warning"`); `admin/lib/design-schema.js` rejects warning keys in copy. Default wording is unchanged, except that the delete-category dialog now also says "刪除後無法復原。". `ctx` is unchanged (no public-api.json change).
* `admin/styles.css` stays locked (decision recorded; the admin AI works through tokens.css and theme.css).
* `scripts/sync-core.mjs`: the source must be a template checkout at the annotated tag v<version> with a clean tree (new `sourceInfo` / `withHistory` in scripts/lib/template.mjs), otherwise it is refused unless `--allow-untagged`; `.template-version` now keeps a `#` history (the first line is still the version). `new-merchant.mjs` records provenance there too and prints the human content-schema registration steps.
* New locked `scripts/check-content-schema.mjs` (offline lint; dry run against a platform instance with CONTENT_* environment variables; it cannot register) and the guards workflow runs its lint.
* New locked doc `docs/DECISIONS.md`; new skills `core-change` and `template-release-and-sync`; `merchant-onboarding` (synced from the platform), `storefront-design` and `admin-design` updated.
* Design-layer files that changed in the template only (never synced): public/content.schema.json (new), public/content.js and public/app.js (title fields are plain text, newlines render as <br>), public/index.html (no inline script), admin/design/copy.js (the key rename above).

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
