# Decisions

Standing decisions about the merchant template and every merchant repo made from it. Each one was **decided by the user**
(the template's owner) and is enforced by the tooling named next to it; changing one is a human decision, recorded here
first. Newest first. This file is part of the locked core (it is synced to merchant repos so design sessions can read it).

## 2026-11-27, decided by the owner

### D12. Guard rule tightening (design layer) and the follow-up T1-T4 plan

**Guard rule tightening, approved by the owner on 2026-11-27 ("全部照建議"), items 1-3**, under D10 (a guard-rule change is a capability-boundary change, so the owner decides). The design layer is already unable to `fetch`, touch storage or build raw HTML; these rules close the remaining ways it could take over the screen or drive a core confirmation. Enforced in two layers, because a static scan alone can be bypassed: (a) the static scan, `admin/scripts/lib/design-scan.mjs` (admin `design/` and `design-defaults/`) and section 5d of `scripts/check-layers.mjs` (storefront), and (b) RUNTIME restrictions in the core (`admin/ui/kit.js`, `admin/core/context.js`) that only take away what the design layer can do and add no `ctx` function. The current template (admin `design/`, `design-defaults/`, the storefront `public/*.js`) passes with ZERO violations; `admin/scripts/__fixtures__/cases.mjs` and `tests/guard-d12.test.mjs` hold a negative test for every construct (including each bypass the independent review found) and positive tests for the legitimate ones; `admin/e2e/d12-runtime.mjs` checks the runtime part in a real browser.
1. **Dialog, popover, fullscreen, pointer lock.** Static: rule `js/dialog-api` refuses `showModal`, `showPopover`, `hidePopover`, `togglePopover`, `requestFullscreen`, `requestPointerLock` (and the exit variants) as identifiers, and `.show(` / `.close(` as method calls (the `{ close }` argument of a dialog action is a plain function and stays allowed). `.show(` and `.close(` are ordinary method names, so the real protection is that design code can no longer create anything they act on: rule `js/dialog-element` refuses the `dialog` tag (`h("dialog")`, as a call argument or in a template) and rule `js/popover-inert` refuses the `popover` and `inert` attributes and properties. Runtime: `h()` throws a `DesignError` for the `dialog` tag (any case, any computed string, non-string tags) and for the attributes `popover`, `popovertarget`, `popovertargetaction`, `inert`, `commandfor`, `command`, `interestfor`; the view then fails to mount and the core shows the built-in view. Only the core creates dialogs (`document.createElement` inside `showDialog`). `ctx.ui.showDialog` returns only `{ close }` to the design layer, no element. Plain `position: fixed` / `z-index` CSS stays allowed.
2. **Programmatic click and auto-confirm.** Static: rule `js/synthetic-input` refuses `dispatchEvent`, `requestSubmit`, `.submit` (except `ctx.auth.passwordSetup.submit`, the core's own function), constructing `Event`, `MouseEvent`, `KeyboardEvent` and the other event classes, computed access such as `el["click"]`, and `.click` on anything except a hidden file input created in the same file with `h("input", { type: "file" })` (the upload button pattern). Rule `js/core-ui-selector` refuses strings and templates that name the core confirmation controls (`confirm-yes`, `confirm-warning`, ...). Runtime: every button of a core dialog (`showDialog`, so also `confirmDialog` and the fixed-warning confirmations) ignores events whose `isTrusted` is not true, so a synthetic `.click()` or `dispatchEvent` can never confirm; only a real user input does.
3. **Traversal out of the design's own subtree.** Static: rule `js/dom-escape` refuses `ownerDocument`, `getRootNode`, `parentNode`, `parentElement`, `offsetParent`, `composedPath`, `getElementById`, `getElementsBy*`, `elementFromPoint(s)`, sibling and `firstChild` / `lastChild` / `childNodes` / `firstElementChild` / `lastElementChild` walks, `relatedTarget` and `.view`, `.closest(` everywhere, and `querySelector` / `querySelectorAll` on anything except an element created by the same file with a `ctx.ui` builder or `root`; `ctx.ui.$` and `$$` need such an element as their second argument. Rule `js/ctx-shadow` refuses redeclaring, re-assigning or shadowing `ctx` in a nested function; `js/ctx-unknown` refuses computed access on ctx namespaces, `Object.values` / `entries` / `assign` / ... over them and spreading them. `children` (also a normal data key in the category tree) stays allowed: it only walks DOWN from an element the design owns. Runtime: `ctx.ui.$` and `$$` are scoped (they need an element root, refuse document, `html`, `body`, anything inside a dialog and any container of core UI, and never return a node inside a dialog, the toast host or the preview banner). The storefront scan does not include traversal (its event delegation uses `querySelector` / `closest` on `#app`); it covers items 1 and 2.
Known residue (accepted): the own-element and file-input exceptions are decided by names within one file, not by data flow, and the scan is a token scan, not a proof; the CSP, the core-owned confirmations, the fixed warnings, the trusted-input check and the runtime restrictions above are the real boundaries.

**Follow-up T1-T4 plan, approved by the owner on 2026-11-27 (to be built in later PRs, NOT in v0.4.2).** Six new `ctx` functions: `listDesignRequests`, `getDesignRequest`, `getDesignState`, `openDesignReview`, `requestDesignRevert`, `cancelDesignRequest`. Five new core-fixed warning ids: `approveDesign`, `approveRevert`, `rejectDesign`, `cancelDesign`, `revertDesign`, to be added to `WARNED_CONFIRM_IDS` in a later PR (with the fixed warning texts in `core/warnings.js` and the `confirm.<id>.title/.text/.yes` copy keys in both copy files). The core fetches review screenshots via fetch->blob (the design layer never fetches and gets no image URL it can load by itself). Approval needs a checkbox acknowledgement and no password. The names of the proposer and the approver are shown through a platform-provided, shop-scoped display name. Each of those PRs is still a human-reviewed core change; this entry records the owner's approval of the plan, not an implementation.

## 2026-11-26, decided by the owner

### D11. Version preview: two new `ctx` functions, core-owned logic (option A)

Adding the two `ctx` functions `ctx.actions.requestVersionPreview(requestId)` and `ctx.data.getVersionPreview(previewId)` was **approved by the owner on 2026-11-26, option A**: core-owned logic exposed via ctx; alternatives B (a core-owned screen), C (a fixed component) and D (no button) were considered. The logic is the core's (permission `design.view` checked inside the core, 409 `revert_below_core_floor` / `already_current` / `invalid_state` / `site_state_unknown` and 429 `hourly_cap_reached` / `daily_cap_reached` with Retry-After mapped to ActionErrors, no token or shop id handed to the design layer, `origin` only as the platform gives it to the person who asked and only if it is a plain origin); the design layer only renders. **No other capability was added to `ctx`** (v0.4.0). Consequences, all core-owned and tested (`admin/scripts/test-preview.mjs`, `tests/nginx-config.test.mjs`):
* The limits sentence next to the "preview this version" button is FIXED (`lib/fixed-text.js`, copy key `vp.limits`; `lib/design.js` ignores any override and refuses to load if the built-in copy differs), like the fixed warnings of D3. The revert button is shown only with `design.revert` and only enters the existing revert flow; a preview is not an approval.
* Preview mode (owner decision, same day) is READ-ONLY: on a preview host every write-capable `ctx.actions` function throws `reason: "read_only"` (a wrapper over the whole table in `core/actions.js`, so a new action cannot be forgotten), and `lib/api.js` refuses non-GET requests. The mode comes from `window.ADMIN_CONFIG.preview` (written by `deploy/preview-config.sh`), is read once and frozen.
* Preview hosts carry the same strict CSP (D1), `X-Robots-Tag: noindex, nofollow`, no framing, and a CORE banner (`ui/preview-banner.js`: kind, tag, expiry) rebuilt by a load-time check, a MutationObserver and a timer if the design layer removes or hides it; if it cannot be shown the page fails closed. No guard RULE was changed; a scan rule for CSS aimed at the banner (like `css/hides-dialog`) is a possible follow-up and would need a decision.

### D10. Locked-core changes: independent review replaces the owner for non-capability changes; v0.3.0 scope

Decided by the owner on 2026-11-26. **Policy**: a locked-core change no longer needs the owner personally when (1) an independent review (a fresh subagent, security-focused, that did not write the change) finds nothing open and (2) all guards and tests pass (check-layers --check, check-design, test-guard, content-schema --lint, tests/run.mjs, the admin and content tests). The maintainer assistant may then merge and tag, and reports to the owner afterwards. The owner is STILL required for changes that alter what the AI design layer can do: adding to `ctx` (or `ShopCommerce` / `SHOP_CONFIG`), changing the guard scripts or their rules, changing `lockedPaths`, or changing the manifest procedure itself (`--update` stays a maintainer action after a reviewed core change, never an AI action).

**v0.3.0 direction (decided by the owner, approved 2026-11-26)**: the design layer may READ the content store and DRY-RUN schemas, but must NOT register schemas or write content (save, publish, restore and so on stay core-owned actions behind permissions and human confirmation).

**Owner approval, as recorded in chat on 2026-11-26** (verbatim):
* Policy approval: "「可以」,政策改成擬建議的版本"
* Tightening approval (guard rule, the `check-design` deploy rule: server-level CSP required, and every location that sets its own add_header must repeat the full security header set with a CSP at least as strict): "建議收緊 就收緊"
* UX rule: "會影響到用戶體驗的再問我" (anything that changes the user experience goes back to the owner first).

Approval was given in chat to the maintainer assistant. A human can contest or revoke it at any time by editing this decision.

## v0.3.0 (DECIDED: merged 2026-11-26 under D10)

Merged 2026-11-26 under D10 after two independent security reviews and passing guards/tests. The owner approved the boundary direction (the design layer may read content and dry-run schemas but may not register or write) and delegated the maintainer-choice items (D7 600 ms wait, D8 warnings on all content actions, D9a ADMIN_SITE_ORIGIN, D9b /content-schema, D9c image origins, D9d empty FAQ) to the maintainer assistant's recommendation.

Source: the platform decisions of change `headless-content-store` (design D8 runtime fetch by default, D9 security, platform template follow-up T1-T5 (platform label "D10", unrelated to this repo's D10)) and the user's task brief of 2026-11-25. The choices marked "maintainer choice" were made by the preparing session and were approved as described in the line above.

### D7. The storefront reads platform content at runtime; `content.js` stays the default copy

`ShopCommerce.content` (locked) fetches `GET /shop/content?include=content` with the publishable key, revalidates with ETag, and falls back to the last good content or the design layer's defaults on any failure (network, 5xx, 429, timeout); a missing key is not an error. The design layer overlays published documents on `content.js` and renders them through the core's safe helpers (text only via textContent; `richtext` only through the sanitizer built from the platform's allowlist, a locked byte copy with a pinned hash and a drift test; `link` only into href after a scheme check; `image` only into src from a known image origin). Loading approach (maintainer choice): the first paint waits at most 600 ms for the content (instant on a repeat visit thanks to a 5-minute sessionStorage cache of the published response, allowed because the locked core already uses sessionStorage and design code still may not); a slower API paints the defaults and swaps. Preview mode (`?content_preview=<token>`, header `X-Preview-Token`, token removed from the URL, never cached or persisted, visible banner) is core behaviour. Build-time snapshots and the publish hook are not built.

### D8. Content editing in the admin is core-owned; registering a schema stays human-only (extends D6)

New `ctx.data` / `ctx.actions` / `ctx.ui` functions (see admin/docs/DESIGN-LAYER.md) enforce permissions (`content.view` / `content.edit` / `content.publish` / `content.manage`), the optimistic lock (If-Match, If-None-Match: *; 412 shows a reload prompt, 428 is a programming error), and 422 pointer mapping inside the core, never in a view. Validation and field behaviour live in the core form builder; the design layer only lays out screens (required fields it omits are appended). The design layer can only DRY-RUN a schema (read-only report). `registerContentSchema()` is a core action that takes no arguments, requires `content.manage`, and always shows a confirmation dialog with a fixed warning and the removals report (a second confirmation before `confirm_removals=true`); no code path registers without the human answering that dialog. Restore only writes the draft ("restored to draft, not published yet"). Fixed warnings were added for publish, unpublish, delete, restore, register and register-with-removals (maintainer choice: publish is arguably reversible; reviewer may drop it).

### D9. Maintainer choices recorded for review

* The admin reads the schema from the same-origin `/content.schema.json` (nginx proxies it from the storefront, the dev server serves it from public/); the admin CSP `connect-src` stays `'self'`. Preview needs `ADMIN_CONFIG.siteOrigin`, supplied by the required deploy env `ADMIN_SITE_ORIGIN`.
* The schema screen is routed at `/content-schema` (not `/content/schema`): `schema` is a valid document key.
* Content images: only absolute http(s) URLs from an origin the platform returned (catalogue images) or from the optional `SHOP_CONFIG.imageOrigin` are accepted; relative paths and data: are refused.
* A published but empty FAQ shows an empty FAQ (not the defaults).

### Known follow-ups (v0.3.0)

* check-design `cspProblems` (admin/scripts/check-design.mjs) accepts `img-src https:`, while the template only intends `data:`, `blob:` and the specific image origin. Open low finding from the independent reviews. Tighten later; guard rule changes need the owner under D10.

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
