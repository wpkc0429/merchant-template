# Storefront architecture rules (distilled from the root CLAUDE.md)

Single source of truth is the repo's `CLAUDE.md` section "架構約束" and `README.md`; read the original for the reasons. This is the checklist you apply while editing `public/app.js`. Names (`state`, `render`, `actions`, `data-k`, `data-act`, `desktopPage`, `mobilePage`) are the template's; confirm with `grep` in the merchant repo before relying on them.

## Rendering

- `app.js` is one IIFE. UI = `state -> view() -> app.innerHTML`, full redraw on every `render()`. No diffing, no component instances. After any state change call `render()`.
- Every `<input>` / `<textarea>` needs `data-k="<key>"` so `render()` can restore focus and the caret; forgetting it makes the caret jump while typing (the search box is the usual victim).
- The scrollable mobile content region carries `data-scroll="app-body"` so scroll position survives a redraw. Keep it on any new scroll container that redraws.
- Everything interpolated into an HTML string goes through `esc()`, including server text (error messages, order numbers, product titles).

## Events

- Delegated listeners on `#app` for `click` and `input`. A clickable element uses `data-act="<name>"` (extra argument `data-a`), implemented as a function of the same name in the `actions` object. Inputs use `data-act="input:<target>"` handled in the `input` listener. Adding an action means adding to `actions`; never add listeners elsewhere.
- Navigation uses real anchors `href="#/..."`. The click handler lets real hrefs navigate and only calls `preventDefault()` for `href="#"` and buttons. Do not intercept navigation in JS.

## Routing

- Hash routes. `applyHash()` derives `state.route`, `state.cat`, `state.pslug` from `location.hash`. Navigate with `go(hash)` or an anchor; never assign `state.route`. Product URLs use the platform `slug` (`#/product/<slug>`), never the numeric id (ids differ per environment). Category filter is the category slug (`#/shop/<slug>`).
- Side effects live in `applyHash()`: entering `product` resets the product configurator; leaving `checkout` clears `done`, `errors`, `submit`; entering `order-status` calls `loadOrderStatus()`. Keep them intact.
- Sort and search are transient state, deliberately not in the URL.

## Two layouts

- `view()` switches on `state.mode` between `desktopPage()` and `mobilePage()`. These are two separate trees with their own `m-` prefixed CSS, not responsive variants of one markup. A component present on both sides must be changed on both sides.
- `MOBILE_BP` (720 px) is the only switch criterion; there is no manual layout toggle (removed on purpose). `DESKTOP_ONLY` routes (`checkout`, `order-status`) fall back to the desktop tree even on mobile. Decide which side a new route belongs to. Keep `env(safe-area-inset-bottom)` style values on mobile.

## Catalogue state

- `state.catalog` is `{status: idle|loading|ready|error, products, shippingMethods, categories, featuredSlugs, error}` loaded once by `Commerce.loadCatalog()`. Every screen that reads it must render all three states (loading, error through the shared status block, ready), on desktop AND mobile.
- Sizes/options come from the SKUs; the template reads `options.size` (S/M/L first, any other value after them with its raw text), see `docs/TEMPLATE-NOTES.md` in the template repo. Price is the SKU's `price_amount`. Unsellable options are disabled and labelled (use `Commerce.isSkuSellable`). Empty categories are hidden; the featured block falls back to the first products when the featured category is empty. Products without images render with the placeholder background (CSS background is the fallback, no `onerror`).
- Cart lines are snapshots held by the commerce layer; after a rejected checkout (422 on `/items/N`) the template re-reads the catalogue and reconciles. Keep that recovery path when editing checkout screens.

## Checkout

- `state.submit` `{status, key, error, order, paymentIssue}`; `submit.key` doubles as response ownership: a response whose key differs from `state.submit.key` must not redraw or navigate (the visitor left). The exception is an old but created order: clear the cart and flash a notice. While `status` is `pending` or `redirecting` the form is locked (`submitLocked()`); new inputs must honour it.
- Totals shown before submit are estimates; the server's `subtotal_amount`, `shipping_fee`, `total_amount` win after submit. The client never sends or claims an amount. There are no card fields.
- Payment is a second request after the order is created; a missing order token must show "order placed, payment needs separate handling", never "order failed".

## Styling, content, assets

- Design tokens live in `:root` of `public/styles.css`; no hard-coded colours in components. `--accent` is written at boot from `SHOP_CONTENT.accent`. Background wash is `--bg-wash`; read the README section on the background texture before changing it.
- Static copy and design constants belong in `public/content.js`. Catalogue-derived text never goes there.
- `public/assets/` holds production assets only; keep filenames stable when replacing (file names are a contract with the design project). Product photos are WebP; background textures are PNG; the two use opposite compression logic (README "圖片"). Never put scratch files in `public/`: it is published.
- Nothing may add a long-cache header or a `_headers` file (deliberate, see README "部署"); do not touch `wrangler.jsonc`.
