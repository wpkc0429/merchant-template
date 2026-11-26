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

## v0.4.1

Banner hardening (low findings of the independent review of v0.4.0). Human-reviewed core change; manifests re-locked with `--update` on the branch `core/banner-hardening-0.4.1`; nothing is tagged.

Design-layer action: none

* `admin/ui/preview-banner.js`: the banner is rendered in the browser top layer (Popover API, `popover="manual"` + `showPopover()`), so no z-index, fixed overlay or `body::after` can cover it, including `pointer-events:none` overlays that `elementFromPoint` cannot see. The popover UA styles are overridden by the core's `!important` styles (same bar, same text); a cosmetic spacer keeps page content below the bar. A closed popover (`hidePopover()`) or a removed or changed `popover` attribute is detected (also through the `toggle` event) and rebuilt under the existing rebuild cap, then fail closed once. A modal `<dialog>` or another top-layer element is handled by re-raising the banner (no rebuild); the hit-test is skipped while a modal is open because inert nodes are not hit-testable. Without the Popover API the old behaviour stays and an interval scan also looks for fixed/absolute elements and `body`/`html` pseudo-elements painted over the bar.
* Re-review fix (same version): raising the banner above a modal dialog / popover now happens at once on DOM, `toggle` and `close` events (not only on the 1 s timer), only when a top-layer element appeared that the banner is not already above (no churn while a legitimate modal stays open), and every raise counts in the rebuild window (4 per 3 s, then fail closed once), so a design layer that keeps closing and re-opening full-screen modals or popovers ends in one fail-closed instead of covering the banner. Ordinary confirm dialogs (`ui/kit.js`) keep working.
* `admin/e2e/preview-banner.mjs`: new cases (pointer-events:none div and `body::after`, clickable overlays, modal dialog, normal confirm dialogs, showModal / popover=manual loops every 40 ms, `hidePopover()` and attribute removal, a `hidePopover()` loop, and the whole overlay set again with the Popover API removed), new 390 and 1280 screenshots, and a pixel check of what is painted.
* Docs: an admin host that is not the official nginx image and not `localhost`, `127.0.0.1` or `[::1]` is treated as "preview config missing" and locked read-only (README, admin/README). The test and docs use `PLATFORM_DIR` / `PLAYWRIGHT_DIR` and "a platform checkout" (the env var of the platform e2e scripts is now `PLATFORM_DIR`).
* No guard rule was changed; the ctx surface is unchanged.

## v0.4.0

Version preview (platform change design-history, D25; decision D11 in docs/DECISIONS.md). Human-reviewed core change: the manifests were re-locked with `--update` on the branch `core/version-preview-0.4.0`; nothing is tagged. The owner approved exactly two new ctx functions (option A); nothing else was added to ctx.

Design-layer action: adopt the new default history view: admin/design/routes.js add the route designVersionPreview (views/design-version-preview.js and parts/version-preview-section.js, copied from admin/design-defaults/); without it the built-in screen is used. Embed versionPreviewSection(ctx, {requestId, tag, onRevert}) next to each past published design in your history screen.
Design-layer action: admin/design/copy.js: add the new copy keys (vp.*, err.readOnly) from admin/design-defaults/copy.js; vp.limits is FIXED by the core and any override is ignored.
Design-layer action: ctx additions: ctx.actions.requestVersionPreview(requestId) and ctx.data.getVersionPreview(previewId) (permission design.view). In preview mode every ctx.actions function throws ActionError reason read_only: show ctx.errorMessage(e) and do not work around it.
Design-layer action: deploy (host, not design layer): a preview host must start with ADMIN_PREVIEW_MODE=version or change (optional ADMIN_PREVIEW_TAG, ADMIN_PREVIEW_EXPIRES); every response now also carries X-Robots-Tag noindex.

* New ctx: `ctx.actions.requestVersionPreview(requestId)` (POST .../design/requests/{id}/version-preview; design.view; ids checked for shape; 409 revert_below_core_floor / already_current / invalid_state / site_state_unknown and 429 hourly_cap_reached / daily_cap_reached with Retry-After become ActionErrors with `reason`, `detail`, `retryAfter`) and `ctx.data.getVersionPreview(previewId)` (GET .../design/version-previews/{id}; state waiting / ready / failed with failureRuleIds / expired; `origin` only as the platform gives it to the initiator and only if a plain https origin; no token or shop id).
* Read-only preview mode (core-enforced): `lib/preview.js` (mode read once from `window.ADMIN_CONFIG.preview`, frozen), `core/guard.js` `readOnlyGuarded` wraps the whole `ctx.actions` table (also requestVersionPreview and previewContentDocument), `lib/api.js` refuses non-GET requests. Sign-in, refresh and sign-out are unaffected.
* Core banner on preview hosts: `ui/preview-banner.js` (kind, tag, expiry; outside #app; CSSOM `!important` styles; load-time check, MutationObserver and timer rebuild it; fails closed). `config-loader.js` loads `preview-config.js`; `deploy/preview-config.sh` writes it from ADMIN_PREVIEW_MODE / _TAG / _EXPIRES (bad values stop the container); nginx adds `X-Robots-Tag: noindex, nofollow` to every response (strict CSP and no framing unchanged).
* Default views: route `designVersionPreview` (`/design/:id/version-preview`, design.view), `views/design-version-preview.js`, `parts/version-preview-section.js` (waiting / ready / failed with rule ids / expired, the FIXED limits text `vp.limits` in `lib/fixed-text.js`, the revert button only for design.revert). The history list and detail screens (platform tasks T1-T4) do not exist in the template yet: the section is built to be embedded, and the revert button navigates to `/design/:id`, the request screen T4 will add.
* Tests: `admin/scripts/test-preview.mjs` (run by test-guard: permission gating, id checks, error mapping, origin rules, read-only for every action in version and change mode, banner rebuild), `tests/nginx-config.test.mjs` (X-Robots-Tag, preview-config.sh). No guard rule was changed.

Review fixes (same version, before merge; PR #2 review "fix before merge"):

* Banner: styles are compared with the browser's own serialization (a detached probe element), not the strings written (they were always "not intact" in real browsers, which failed closed on every preview page and looped the MutationObserver); re-entrancy flag, rebuild rate limit (4 per 3 s, then fail closed once, observers and timer stopped), observer throttled (animation frame, at most one check per 200 ms) and scoped to html/body/head/banner. `visible()` also checks ancestors (opacity, filter, transform, clip-path, mask, content-visibility), `text-indent`, `-webkit-text-fill-color`, font size, text/background colour, `::before`/`::after`/`::first-line`, geometry and `document.elementFromPoint` (covered). More fixed styles are `!important` in the CSSOM. No guard rule changed; limitation: a covering element with `pointer-events: none` is not seen by `elementFromPoint`.
* Real-browser test: `admin/e2e/preview-banner.mjs` (Playwright from `$PLAYWRIGHT_DIR`; skips cleanly when absent; run by `tests/preview-banner-browser.test.mjs`): normal page, preview page (390 and 1280 screenshots), config missing, repairable tampering, attacks that fail closed exactly once.
* Deploy: `preview-config.sh` and `require-origins.sh` refuse any newline or control character (the per-line grep passed `ok
"};alert(1);//`), preview-config.sh aborts when it cannot write, and the file ends with the marker `window.ADMIN_CONFIG.previewConfig = true;`. `lib/preview.js` treats a non-localhost host without that marker as a preview host whose config failed: read-only, banner text "預覽設定未載入", the app is stopped (fail closed). Operations: hosts built from older images without the marker must be redeployed with the new image.
* The "改成這個版本" button stays implemented but the default view no longer passes `onRevert` (its target `/design/:id` does not exist: history list and restore flow T1-T4 are not built). Version preview is NOT reachable by users until the history list (T1-T4) exists.
* `safeOrigin`: https only (no http for localhost), a dot inside the host, no trailing dot, no IP literal. The preview origin is registered for link `href` only, in a single slot (`allowPreviewLinkOrigin`), not in the global image/link allowlist.
* `design/copy.js` no longer has `vp.limits` (fixed core text), so the default design prints no console warning on load; `lib/design.js` warns only when the design's own copy defines a fixed key.

## v0.3.0

The template can now CONSUME and EDIT the platform content store (platform change `headless-content-store`, slices 1 and 2; decisions D6-D10 below in docs/DECISIONS.md). Human-reviewed core change (new locked functions and `ctx` surface): the manifests were re-locked with `--update` on the branch `core/content-store-0.3.0` by the preparing maintainer session because the core-change skill requires a human to review before merge; nothing is tagged.

Design-layer action: public/index.html: load `commerce/content-allowlist.js` and `commerce/content.js` after `commerce/cart.js` and before `commerce/checkout.js` (check-layers fails without them; checkout.js freezes ShopCommerce).
Design-layer action: public/app.js: overlay the published `ShopCommerce.content` documents on the defaults of public/content.js (template: applyPlatformContent() and the boot wait with a 600 ms first-paint budget); render content values only through esc() as text or through the core helpers ShopCommerce.content.text / richText / link / image, never innerHTML.
Design-layer action: public/styles.css: optionally restyle the core preview banner `#shop-preview-banner.shop-preview-banner` (the template adds a default rule).
Design-layer action: public/content.js and public/content.schema.json: keep the defaults equal to the schema defaults (a template test checks it); the document keys the storefront reads are global, home, story, faq and product-info.
Design-layer action: admin/design/routes.js: add the routes content, contentDocument, contentRevisions and contentSchema (views admin/design/views/content.js, content-document.js, content-revisions.js, content-schema.js, copied from admin/design-defaults/); without them the built-in default screens are used.
Design-layer action: admin/design/copy.js: add the new copy keys (nav.content, content.*, cf.*, confirm.publishContent / unpublishContent / deleteContent / restoreContent / registerContentSchema / registerContentSchemaRemovals .title/.text/.yes) from admin/design-defaults/copy.js; without them the defaults show; the fixed warnings of these six confirmations are core-owned.
Design-layer action: admin/design/views/shell.js: add the nav entry id `content` (label nav.content) if the shell lists navigation items explicitly.
Design-layer action: deploy (host, not design layer): set ADMIN_SITE_ORIGIN (the storefront origin) for the admin container; nginx now requires it, serves /site-config.js (ADMIN_CONFIG.siteOrigin for the preview tab) and proxies /content.schema.json from the storefront. Optional SHOP_CONFIG.imageOrigin in public/config.js only if content image fields are used before any product image is loaded.

* Storefront locked layer: new `public/commerce/content.js` (`ShopCommerce.content`: ready, all, get, onChange, isPreview, text, richText, link, image, safeHref, safeImageSrc; fetch of GET /shop/content?include=content with ETag / If-None-Match, in-memory cache, 5-minute sessionStorage cache of the published response only, bounded timeout, failure keeps the last good content or the defaults, preview mode `?content_preview=<token>` with the X-Preview-Token header, token removed from the URL, never cached or persisted, a core banner), `public/commerce/content-allowlist.json` (byte copy of the platform's api/internal/cms/richtext/allowlist.json, sha256 pinned in tests) and `content-allowlist.js` (the same object as a classical script; a test keeps them equal), `api.js` (timeout option, ETag, image origins), `checkout.js` (freezes content), `public-api.json`, `scripts/check-layers.mjs` (new surface, script order, forbidden patterns).
* Admin locked core: `admin/lib/content.js`, `lib/content-schema.js`, `core/content-actions.js`, `ui/content-form.js` (schema-driven form builder, all nine x-editor kinds, required fields cannot be omitted), `lib/api.js` (`apiRaw` with response headers), `core/{actions,context,data,errors,routes,warnings}.js`, `ui/kit.js` (confirm detail), `styles.css`, `lib/public-api.json`, `lib/design-schema.js`, deploy files and config loader. New ctx.data: getContentSchema, listContentSchemaVersions, listContentDocuments, getContentDocument, listContentRevisions, getContentRevision, dryRunContentSchema (read only, content.manage), contentSite. New ctx.actions: saveContentDocument, publishContentDocument, unpublishContentDocument, deleteContentDocument, restoreContentRevision (draft only), uploadContentImage, previewContentDocument, registerContentSchema (content.manage, always a human confirmation dialog with the removals report, second confirmation before confirm_removals). New ctx.ui: contentForm, contentField. New permissions used: content.view, content.edit, content.publish, content.manage. ActionError kinds stale (412) and internal (428 / unexpected).
* Six new irreversible confirmations with fixed warnings (publish, unpublish, delete, restore, register schema, register schema with removals).
* Tests: tests/content.test.mjs, tests/content-guards.test.mjs (template only); admin/scripts/test-content.mjs, new guard fixtures, admin e2e section content.
* Review fixes (same version, before merge): nginx security headers repeated in the two new locations (nginx does not inherit add_header), the schema proxy hardened (no Cookie / Authorization / Cf-Access-Jwt-Assertion / CF_Authorization forwarded, GET only, no redirects, 5 s timeout, fixed application/json Content-Type, upstream cookies and CSP dropped, variable proxy_pass + resolver); start-up validation of the origins; publish and restore now REQUIRE the revision the person saw (If-Match; a missing rev is an internal error, no default read after the dialog; the default restore screen sends the revision it displayed and reloads on 412); admin linkOK rejects any backslash and imageOK accepts nothing but "" when no image domain is configured (aligned with the storefront safeHref / safeImageSrc); catalogue image origins now trigger a content re-render; the design layer's applyPlatformContent falls back to the defaults when content is malformed. None of this widens ctx or any capability.
* Guard tightening (decided by the owner, D10, 2026-11-26): `admin/scripts/check-design.mjs` deploy rule now requires a server-level Content-Security-Policy in `deploy/nginx.conf.template`, and every location block that defines its own `add_header` must repeat the full security header set (incl. Cross-Origin-Resource-Policy) with a CSP identical to or at least as strict as the server-level one; failures name the location (`deploy/loc-headers`, `deploy/csp-weak`, `deploy/csp-always`). Negative tests in `admin/scripts/test-guard.mjs`; `tests/nginx-config.test.mjs` also requires Cross-Origin-Resource-Policy. No design-layer action.
Operations notes (v0.3.0 review fixes):
* ADMIN_SITE_ORIGIN must match https://host[:port] in lowercase (no trailing slash, path, quotes or semicolons); the image refuses to start otherwise (deploy/require-origins.sh). The same shape check applies to ADMIN_IMG_ORIGIN and ADMIN_UPLOAD_ORIGIN (http or https).
* DNS: /content.schema.json is proxied with a variable proxy_pass and a resolver (ADMIN_RESOLVER, taken from /etc/resolv.conf by deploy/resolver.envsh, overridable by setting ADMIN_RESOLVER), so the admin starts even if the storefront hostname does not resolve yet; the schema screen just reports an error until it does. The container needs a reachable DNS server.
* Platform CORS requirement for the storefront content request (browser, cross-origin to the platform API): the platform must allow the request headers If-None-Match and X-Preview-Token, and expose the response header ETag (Access-Control-Expose-Headers: ETag). Without it revalidation and preview do not work (content still loads, uncached).
* Storefront images in content: a content image is shown only if its origin is one the catalogue returned or SHOP_CONFIG.imageOrigin. The catalogue usually arrives after the content, so the core now re-notifies listeners when the catalogue adds an image origin (the page repaints); set SHOP_CONFIG.imageOrigin in public/config.js to have them at the first paint.
* A merchant that does nothing keeps working: unpublished or missing documents fall back to public/content.js, and the admin uses its built-in default screens.

## v0.2.1

Security headers fix (audit findings H2 and M7 of the platform launch checklist). Approved by the owner on 2026-11-26 (docs/DECISIONS.md D1 amendment).

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
