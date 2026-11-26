# Decisions

Standing decisions about the merchant template and every merchant repo made from it. Each one was **decided by the user**
(the template's owner) and is enforced by the tooling named next to it; changing one is a human decision, recorded here
first. Newest first. This file is part of the locked core (it is synced to merchant repos so design sessions can read it).

## 2026-11-26, decided by the owner

### D10. Locked-core changes: independent review replaces the owner for non-capability changes; v0.3.0 scope

Decided by the owner on 2026-11-26. **Policy**: a locked-core change no longer needs the owner personally when (1) an independent review (a fresh subagent, security-focused, that did not write the change) finds nothing open and (2) all guards and tests pass (check-layers --check, check-design, test-guard, content-schema --lint, tests/run.mjs, the admin and content tests). The maintainer assistant may then merge and tag, and reports to the owner afterwards. The owner is STILL required for changes that alter what the AI design layer can do: adding to `ctx` (or `ShopCommerce` / `SHOP_CONFIG`), changing the guard scripts or their rules, changing `lockedPaths`, or changing the manifest procedure itself (`--update` stays a maintainer action after a reviewed core change, never an AI action).

**v0.3.0 direction (decided by the owner, approved 2026-11-26)**: the design layer may READ the content store and DRY-RUN schemas, but must NOT register schemas or write content (save, publish, restore and so on stay core-owned actions behind permissions and human confirmation).

## v0.3.0 (PROPOSED on branch core/content-store-0.3.0; become standing decisions when the human reviewer merges)

Source: the platform decisions of change `headless-content-store` (design D8 runtime fetch by default, D9 security, D10 template follow-up T1-T5) and the user's task brief of 2026-11-25. The choices marked "maintainer choice" were made by the preparing session and need the reviewer's approval.

### D7. The storefront reads platform content at runtime; `content.js` stays the default copy

`ShopCommerce.content` (locked) fetches `GET /shop/content?include=content` with the publishable key, revalidates with ETag, and falls back to the last good content or the design layer's defaults on any failure (network, 5xx, 429, timeout); a missing key is not an error. The design layer overlays published documents on `content.js` and renders them through the core's safe helpers (text only via textContent; `richtext` only through the sanitizer built from the platform's allowlist, a locked byte copy with a pinned hash and a drift test; `link` only into href after a scheme check; `image` only into src from a known image origin). Loading approach (maintainer choice): the first paint waits at most 600 ms for the content (instant on a repeat visit thanks to a 5-minute sessionStorage cache of the published response, allowed because the locked core already uses sessionStorage and design code still may not); a slower API paints the defaults and swaps. Preview mode (`?content_preview=<token>`, header `X-Preview-Token`, token removed from the URL, never cached or persisted, visible banner) is core behaviour. Build-time snapshots and the publish hook are not built.

### D8. Content editing in the admin is core-owned; registering a schema stays human-only (extends D6)

New `ctx.data` / `ctx.actions` / `ctx.ui` functions (see admin/docs/DESIGN-LAYER.md) enforce permissions (`content.view` / `content.edit` / `content.publish` / `content.manage`), the optimistic lock (If-Match, If-None-Match: *; 412 shows a reload prompt, 428 is a programming error), and 422 pointer mapping inside the core, never in a view. Validation and field behaviour live in the core form builder; the design layer only lays out screens (required fields it omits are appended). The design layer can only DRY-RUN a schema (read-only report). `registerContentSchema()` is a core action that takes no arguments, requires `content.manage`, and always shows a confirmation dialog with a fixed warning and the removals report (a second confirmation before `confirm_removals=true`); no code path registers without the human answering that dialog. Restore only writes the draft ("restored to draft, not published yet"). Fixed warnings were added for publish, unpublish, delete, restore, register and register-with-removals (maintainer choice: publish is arguably reversible; reviewer may drop it).

### D9. Maintainer choices recorded for review

* The admin reads the schema from the same-origin `/content.schema.json` (nginx proxies it from the storefront, the dev server serves it from public/); the admin CSP `connect-src` stays `'self'`. Preview needs `ADMIN_CONFIG.siteOrigin`, supplied by the required deploy env `ADMIN_SITE_ORIGIN`.
* The schema screen is routed at `/content-schema` (not `/content/schema`): `schema` is a valid document key.
* Content images: only absolute http(s) URLs from an origin the platform returned (catalogue images) or from the optional `SHOP_CONFIG.imageOrigin` are accepted; relative paths and data: are refused.
* A published but empty FAQ shows an empty FAQ (not the defaults).

## 2026-11-25 (v0.2.0), decided by the user

### D1. A strict Content-Security-Policy is a DEPLOYMENT REQUIREMENT

Production and every AI-edit preview environment must serve a strict CSP. It is not optional and not a recommendation.

* **Storefront**: `public/_headers` (Cloudflare Workers static assets / Pages read it from the assets directory, so it works with
  `wrangler.jsonc` `assets.directory = ./public`). It is **locked** (not design layer: an AI session must never loosen it) and
  hash-protected in `scripts/commerce.manifest.json`; it is synced to merchant repos like the rest of the core (it is *not*
  merchant-owned, so every merchant gets CSP upgrades). Policy: `script-src 'self'` only (no inline scripts, no eval, no third-party
  scripts), `style-src 'self'` plus `style-src-attr 'unsafe-inline'` (the design layer sets product photos with inline `style=`
  attributes, which cannot run code), `img-src 'self' data: https:`, `connect-src 'self' https:`, `object-src 'none'`,
  `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`. Known limitation: `connect-src` / `img-src` allow any `https:`
  origin because the file is identical in every repo; pinning them per merchant is a possible follow-up.
  Enforced by `scripts/check-layers.mjs` (fails when `_headers` is missing, has no CSP, or weakens it; an inline `<script>` or
  `on*=` attribute in `public/index.html` is an error in the template and a warning in a merchant repo) and exercised by the
  storefront browser test (`tests/e2e/serve-storefront.mjs` sends the real policy).
  The optional localhost override is loaded from `public/commerce/local-config.js`, not from an inline script.
* **v0.2.1 amendment (approved by the owner on 2026-11-26)**: `form-action` is `'self'` plus the two ECPay payment hosts
  (`https://payment.ecpay.com.tw`, `https://payment-stage.ecpay.com.tw`) because checkout POSTs a form to ECPay; HSTS, Permissions-Policy and
  COOP are added to `public/_headers` and `admin/deploy/nginx.conf.template`. Pinning `connect-src` / `img-src` per merchant stays a follow-up: the file is
  locked and overwritten by every sync, so per-merchant values need a design decision first (see the comments in `public/_headers`).
* **Admin**: `admin/deploy/nginx.conf.template` sends the CSP on every response and `admin/deploy/Dockerfile` installs it; it is on by
  default, there is no switch to turn it off. Enforced by `admin/scripts/check-design.mjs` (step "deploy") and tested in
  `admin/scripts/test-guard.mjs`; the design e2e (D8) runs the admin under the policy.
* **Preview environments** of the future AI edit service must serve the same policy (`admin/docs/AI-EDIT-SERVICE-NOTES.md`).
* A hosting setup outside this repo (another nginx, a CDN rule) is not checked by the guards: a human must carry the policy over.

### D2. `admin/styles.css` stays LOCKED

The admin's AI customises through `admin/design/tokens.css` and `admin/design/theme.css` only. `admin/styles.css` is core (hash
manifest); a design that needs more than tokens and theme rules escalates to a human core change.

### D3. Irreversible actions: the warning is FIXED and core-owned

The confirmation dialog of each irreversible admin action is composed of editable wording from `admin/design/copy.js`
(`confirm.<id>.title`, `confirm.<id>.text` lead-in which may be empty, the button labels) plus a **fixed warning** that lives in
`admin/core/warnings.js`, has no copy key, and is always rendered by the dialog (`data-testid="confirm-warning"`). Copy that tries to
define one (any `confirm.*.*warn*` key) is rejected by `validateCopy` (`lib/design-schema.js`) and therefore fails the guard; the
retired v0.1.0 `confirm.<id>.message` keys of the irreversible confirms are ignored (console warning and a guard note, not a failure, so
a v0.1.0 merchant can still sync and then renames them); CSS that hides the warning is rejected (`css/hides-dialog`).
Covered by `admin/scripts/test-guard.mjs`, `tests/decisions.test.mjs` and the design e2e section D7b. The storefront has no
confirm-style irreversible UI (cart line removal is a plain "REMOVE" link on a reversible, client-only bag), so nothing was added there.

### D4. Core changes and the `ctx` surface are human-reviewed

Adding a function or action to the design-layer `ctx` (or any other locked-core change) is a human-reviewed core change, written
up in `.claude/skills/core-change`. **Only a human runs a manifest `--update`** (`node scripts/check-layers.mjs --update`,
`node admin/scripts/check-design.mjs --update`); an AI session never does, and never runs `sync-core` or `new-merchant`.

### D5. Merchant repos come from `new-merchant.mjs`; syncs come from a TAG only

* Merchant repos are created with `scripts/new-merchant.mjs`. The GitHub "Use this template" button is only for finding the template.
* Core syncs are run by a human, per merchant (`.claude/skills/template-release-and-sync`).
* The sync source is a **tag only**: `sync-core.mjs` refuses a template checkout whose HEAD is not exactly at the annotated tag
  `v<template.json version>` with a clean work tree (exit 2), unless a human passes the loud `--allow-untagged` override, which is
  logged in the output and appended to the history in the merchant repo's `.template-version`.

### D6. Content schema: registration is HUMAN ONLY

`public/content.schema.json` (a storefront **design-layer** path: the AI may edit it) describes the shop's editable content for the
platform's per-shop content schema. **Editing the file registers nothing.** Registering a schema on the platform
(`PUT /api/v1/admin/shops/{id}/content/schema`) is done by a human who holds `content.manage` after reading a dry-run report; CI,
the AI edit service, deploy hooks and unattended scripts never call it. `scripts/check-content-schema.mjs` can lint the file offline
and dry-run it (`?dry_run=true`, writes nothing; credentials from environment variables only); it has no registration code path.
Since v0.3.0 the storefront reads published platform content with `content.js` as the default copy (D7) and the admin registers a schema only through the confirmation dialog (D8).
