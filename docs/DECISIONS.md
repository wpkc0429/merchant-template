# Decisions

Standing decisions about the merchant template and every merchant repo made from it. Each one was **decided by the user**
(the template's owner) and is enforced by the tooling named next to it; changing one is a human decision, recorded here
first. Newest first. This file is part of the locked core (it is synced to merchant repos so design sessions can read it).

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
* **v0.2.1 amendment (PROPOSED, awaiting the owner's approval; branch `fix/csp-form-action-and-headers`)**: `form-action` is `'self'` plus the two ECPay payment hosts
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
The storefront still reads `public/content.js` for now; the platform's public `/shop/content` read endpoint is not built, and no
content fetching exists in the template (roadmap in `docs/TEMPLATE-NOTES.md`).
