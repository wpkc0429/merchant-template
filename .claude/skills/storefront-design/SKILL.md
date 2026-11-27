---
name: storefront-design
description: Operating manual for editing a merchant's STOREFRONT design layer (public/app.js, public/content.js, public/content.schema.json, public/styles.css, public/index.html, public/assets/) in this static storefront repo, using only the whitelisted commerce API in public/commerce/public-api.json. Use when a merchant or developer asks to change the look, layout, wording, colours, images, sections or screens of the storefront, or to add a storefront screen built from existing catalogue/cart/checkout functions. Includes the branch-edit-check-preview-stop workflow, the exact guard commands, and the rule to stop and escalate if the request needs a locked commerce/config change or a new API function. Not for the admin back office (use admin-design), not for platform API work, not for onboarding a merchant.
---

# Storefront design layer

You edit how the storefront LOOKS and READS. You never change what it DOES with money, the cart, the API or storage. Everything you may use is listed in `public/commerce/public-api.json`.

Naming: the globals are `window.ShopCommerce`, `window.SHOP_CONFIG`, `window.SHOP_CONTENT` and storage keys start with `shopcommerce:` (the same in the template and in every merchant repo; locked code is never renamed per merchant). The truth is the top-level keys of `public/commerce/public-api.json` and the patterns in `scripts/check-layers.mjs`: read both first. Repo facts live in `template.json` (`sites.storefront.designPaths` is exactly the list below).

## What you may edit (only these)

`public/app.js` (screens, state, routes), `public/content.js` (static copy and design constants), `public/content.schema.json` (the content-field schema of that copy), `public/styles.css`, `public/index.html`, `public/assets/**`.

## Locked (never edit, even if asked)

`public/commerce/**` (API client, cart, checkout, `local-config.js`, `public-api.json`), `public/_headers` (the strict Content-Security-Policy; DERIVED from `scripts/headers.core.txt` + the human-owned `merchant.headers.json` by `scripts/render-headers.mjs`: never edit any of the four, `check-scope` refuses them), `public/config.js` (API base, publishable key, `showPrices`, `featuredCategory`: hash-protected in every repo, written by a human, never by you), `wrangler.jsonc`, `template.json`, `.template-version`, the hash manifests, `scripts/**`, `admin/**` (the back office, another skill), `catalog/**`, repo-root files, `.github/**`, `.claude/**`, docs. `public/config.local.js` is a gitignored local override; do not create or commit it for design work.

## Hard rules (the guard enforces the code ones)

- Reach the commerce layer only through `window.ShopCommerce` and only the names in `public-api.json`. Read only the `config` keys listed there. No `fetch(`, `XMLHttpRequest`, `localStorage`, `sessionStorage`, `/api/v1`, `apiBase`, `publishableKey`, `_internal`, `'shop:...'` keys, and no `import` in design code.
- Catalogue data (products, prices, images, subtitles, categories, shipping) always comes from the API through `loadCatalog()`. Never hard-code any of it. Static copy goes in `content.js`, not scattered in `app.js`.
- Prices go through `money()`; the server decides every amount. Insert every dynamic string into HTML through `esc()`. Colours via the `:root` tokens in `styles.css`.
- **Content and its schema.** Static copy lives in `content.js`; `content.schema.json` is the field schema for the same content (a platform content schema, format 2). When you add, rename or remove a content field, change BOTH files and keep them aligned: every non-object/array field needs a `default` equal to the `content.js` value and every string a `maxLength`, every array a `maxItems` and a `default`, every object `additionalProperties: false`; no `allOf/anyOf/if/patternProperties`, no new top-level `x-` keys beyond `x-editor`, `x-editor-order`, `x-help`. Check offline with `node scripts/check-content-schema.mjs --lint` (exit 0 ok). Title fields (`hero.title`, `storyTeaser.title`, `story.title`) are plain text: a newline becomes `<br>` through `lines()` in `app.js`; never put HTML in content. **Editing the schema file registers nothing, and registering it on the platform is a HUMAN-ONLY step.** You never call the registration endpoint, never run `check-content-schema.mjs` without `--lint` (it needs a human's credentials), never ask for `content.manage` credentials, never wire registration into CI or a script. Say in your report that a changed schema must be dry-run and registered by a human (`.claude/skills/merchant-onboarding`, step 11a), and that since v0.3.0 the storefront overlays published platform content on `content.js` through `ShopCommerce.content` (see `references/commerce-api.md`): keep the defaults valid, render content only via `esc()` or the core helpers, never `fetch`, never `innerHTML`, and keep `index.html` loading `commerce/content-allowlist.js` and `commerce/content.js` before `checkout.js`.
- **Network egress is pinned.** `connect-src` allows only the merchant's own API origin and `img-src` only its own image origin (`merchant.headers.json`, human-owned, D20). A design that needs another origin (an embed, a font host, a map tile) is an ESCALATION: a human decides whether to declare it in `extraConnect` / `extraImg` / `extraFont`. The scan also refuses `fetch`, `sendBeacon`, `WebSocket`, `EventSource`, `XMLHttpRequest`, `new Image`/`Audio`/`Worker`, `window.open` and dynamic `import()` in design code, however they are spelled.
- **Strict CSP.** Production and previews serve `public/_headers`: `script-src 'self'` only. So no inline `<script>`, no `on*=` attributes, no `javascript:` links, no `eval`/`new Function`, no third-party script, font or stylesheet (use a system font stack or a font file under `public/assets/`), and keep `index.html` free of inline scripts (the localhost override loads from `commerce/local-config.js`). Inline `style="..."` attributes are allowed (`style-src-attr`); `<style>` elements are not. `check-layers.mjs` flags inline scripts. A request that needs analytics, a chat widget or an external embed is an escalation (a human decides the CSP change).
- **No irreversible-confirmation UI exists in the storefront** (the only removal is the reversible cart "REMOVE" link). If a request adds one, stop and escalate: the admin solves this with fixed core-owned warnings; the storefront has no equivalent yet.
- Do not add a build step, `package.json`, linter or framework. Nothing temporary inside `public/` (it is published).
- Details of the render loop, event delegation, routing, two layouts and catalogue states: `references/architecture-rules.md`. Read it before touching `app.js`.

## Workflow

1. Read the request. If it is a locked change or needs a function not in `public-api.json`, go to **Escalate** now.
2. `BASE=$(git rev-parse HEAD)`; create a branch `design/storefront-<short-request-name>` (the `design/storefront-` prefix selects the scope check in CI). Never work on `main`.
3. Make the smallest change that satisfies the request. Prefer `content.js` / `styles.css` over `app.js`. Both layouts (desktop and mobile trees in `app.js`) must be changed when the element exists in both.
4. Run the guards (from the repo root):
   ```bash
   node scripts/check-layers.mjs --check
   node scripts/check-scope.mjs storefront --base "$BASE"
   ```
   Exit 0 = ok, 1 = violation (read the listed file and rule, fix, re-run), 2 = usage error. Never run `--update`, `scripts/sync-core.mjs` or `scripts/new-merchant.mjs`.
5. Preview: `python3 -m http.server 8080 --directory public`, with a backend the merchant's `public/config.local.js` points at (the platform's `make openapi-mock` on :4010, or a throwaway API). Check 390 px and 1280 px widths, no horizontal scroll, all three catalogue states (loading, error, ready), the cart, and the checkout steps.
6. **Stop.** Report: files changed, what changed, guard output, how to preview, and anything you could not do. Wait for the merchant's approval. You never merge, push, deploy or open a PR on your own. A push to `main` deploys production.

## Escalate (say so and stop; do not edit around it)

- Needs a change in `public/commerce/**` or `public/config.js` (new checkout field or API call, price/tax/currency logic, shipping or payment behaviour, storage, analytics, cart rules, API base or key).
- Needs a function or config key that is not in `public-api.json`.
- Needs data the API does not provide (it must come from the platform, not be faked in the design).
- Needs files outside the design layer (including `public/_headers`), an external script/embed or font, anything the CSP forbids, a new dependency or a build step.
- Would weaken a guard or a safety rule.

Reply with: what the request needs, which locked part is involved, the smallest proposal for a human-reviewed commerce change (files, `public-api.json` addition, `check-layers.mjs --update` afterwards), and what you CAN do within the design layer meanwhile.

## Common mistakes

See `references/common-mistakes.md`. Worked examples: `references/examples.md`. The API surface with call shapes: `references/commerce-api.md`.

## Single sources of truth (do not duplicate, read them)

`CLAUDE.md` (rules and architecture constraints), `docs/DECISIONS.md` (standing decisions: CSP, content schema registration), `README.md` (layout, how to run), `public/commerce/public-api.json`, `scripts/check-layers.mjs`, `scripts/check-scope.mjs`, `template.json`. Platform API contract: the platform repo's `docs/storefront-integration.md` (read-only).
