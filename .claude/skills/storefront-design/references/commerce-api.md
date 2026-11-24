# The whitelisted commerce surface

Authority: `public/commerce/public-api.json` (enforced by `node scripts/check-layers.mjs`, which loads the commerce scripts in a sandbox and fails if the list differs from the real exports). The shapes below were read from `public/commerce/*.js`; if the code and this file disagree, the code wins and this file should be updated. Platform field names (product, sku, order) come from the platform contract (`../ecommerce/api/openapi/openapi.yaml`, flow in `../ecommerce/docs/storefront-integration.md`), which this repo only consumes; do not copy those docs here.

Namespace in this template: `window.ShopCommerce` (alias it once: `var Commerce = window.ShopCommerce;`). Aliases are tracked by the guard.

## Top level

| Name | Use |
|---|---|
| `Commerce.loadCatalog()` | Promise of `{ ok, products, shippingMethods, categories, featuredSlugs, error }`. Called once at boot in the template (`state.catalog`). On failure `ok:false` and `error` is a ready message. |
| `Commerce.money(n)` | Formats an integer amount of the minor unit as the shop currency string. In the template it is hard-wired to `NT$` + thousands separator, so a different currency is a commerce change (escalate). |
| `Commerce.describeApiError(r)` | Message for a failed API result (`status` 404 key invalid, 503 shop disabled, 0 offline, else generic). |
| `Commerce.isSkuSellable(sku)` | The only test for "can be bought": `is_active !== false` and `stock_qty` not `<= 0`. |

## `Commerce.cart`

`lines()` (array of `{key, skuId, productId, slug, name, img, size, unitPrice, qty, msg, max}`; a snapshot taken when added) · `count()` · `subtotal()` · `isEmpty()` · `add(product, sku, sizeKey, qty, msg, img)` returns `{ok:true}` or `{ok:false, reason:'sold_out'|'stock_limit'|'no_sku'}` · `inc(key)` · `dec(key)` · `remove(key)` · `clear()` · `reconcile(products)` returns `{removed, soldOut}` (call after every catalogue load).

The cart is persisted by the commerce layer, per shop (keyed by the publishable key). The design layer never touches storage.

## `Commerce.checkout`

| Function | Returns |
|---|---|
| `newKey()` | a fresh idempotency key for ONE attempt (one per entry into checkout) |
| `placeOrder({ key, form:{email,name,phone,addr,date}, shipId })` | Promise of `{kind:'created', order:{id,subtotal,shipFee,total}, token}` or `{kind:'error', status, code, details:[{pointer,message}], message}`. Clears the cart on `created`. No amounts are sent; the server prices the order. |
| `startPayment(token)` | Promise of `{kind:'form', form}` or `{kind:'url', url}` or `{kind:'failed'}` |
| `redirectToPayment(result)` | leaves the page (posts the payment form or navigates) |
| `getOrderToken()` | the stored order-access token or `''` |
| `loadOrderStatus()` | Promise of `{ok:true, order}` or `{ok:false, reason:'no_token'|'api', error}` |

## Config readable from design code

`SHOP_CONFIG.showPrices` (false means every price shows as an em dash; the template keeps cart subtotal/total visible) and `SHOP_CONFIG.featuredCategory` (slug of the home featured block). Nothing else (`apiBase`, `publishableKey` are forbidden even to mention).

## Catalogue data shapes (from the platform, read in `state.catalog`)

Product: `id, slug, title, subtitle, description, images[{id, alt, position, width, height, urls:{thumb,large}}] (always an array, maybe empty), categories[{id, slug, name}], skus[{id, sku_code, options, price_amount, stock_qty, is_active}]`. Category tree from `categories`. Shipping method: `id, name, carrier, flat_rate`. Which sizes/options exist is derived from the SKUs (the template reads `options.size`); never assume a fixed set. Use `thumb` in lists and cards, `large` in detail views. A product without images must still render (placeholder background).

## What is NOT available (so requests needing it escalate)

Customer login/registration, points, tiers, order history, saving favourites beyond the page session, coupons, any other endpoint, analytics or tracking scripts, reading or writing storage, any `fetch`. Adding one means a new function in `public/commerce/` and `public-api.json`, reviewed by a human, then `node scripts/check-layers.mjs --update`.
