# Worked examples (storefront)

File and key names below were checked against the template (`public/content.js`, `public/styles.css`, `public/app.js`). In a merchant repo, `grep` for the key first; the structure may have been extended.

## 1. "Change the hero wording" (content only)

Edit `SHOP_CONTENT.hero` in `public/content.js` (`eyebrow`, `titleHtml`, `lede`). `titleHtml` is inserted as raw HTML (the template uses `<br>` for line breaks): keep it plain static text plus `<br>`, never data from the API or the visitor. `eyebrow` and `lede` are escaped by `app.js`. Hero text appears in both the desktop and mobile trees and both read `CONTENT.hero`, so one edit covers both. Run both guards, preview both widths.

## 2. "Store hours, address, phone changed"

`SHOP_CONTENT.store` (`name`, `address`, `addressShort`, `hours`, `hoursShort`, `tel`). The long and short forms are used in different places (cards vs footers/mobile): update both. Check the "store" screens at 390 px for wrapping.

## 3. "Make it warmer / change the brand colour"

Two knobs: `accent` in `content.js` (written to `--accent` at boot) and the tokens in `:root` of `styles.css` (`--paper`, `--ink`, `--clay`, `--band`, `--placeholder`, ...). Change tokens, not component colours. The template has no background texture; if you add one, keep it under `public/assets/` and below a paper-coloured wash so text stays legible. Check text contrast of `--ink` on `--paper` and of any white-on-accent button text.

## 4. "Change fonts"

Fonts are loaded in `public/index.html` and referenced by `--f-display`, `--f-serif`, `--f-sans`, `--f-mono`. Changing the font links in `index.html` is allowed (it is a design file) but only to a stylesheet the merchant has approved; do not add scripts. Watch the CJK fallback.

## 5. "Add a free-shipping banner on the home page"

Copy goes in `content.js` (for example `SHOP_CONTENT.banner = { text: '...' }`), markup in `app.js` in BOTH the desktop home and the mobile home (`desktopPage()` / `mobilePage()` home views), text through `esc()`, style in `styles.css` with tokens (mobile uses `m-` prefixed classes). Do not compute a free-shipping threshold in the design layer; if the merchant wants "free over N" as a real rule, that is a platform and commerce matter: escalate.

## 6. "Show 'only N left' on the product page"

Allowed: read `sku.stock_qty` from the product in `state.catalog` and show copy when it is a small positive number. Use `Commerce.isSkuSellable(sku)` for the buy/disable decision, not your own condition. Add the string to `content.js`. Do it in the desktop and mobile product views.

## 7. "Add a size guide / care-instructions section to the product page"

Static text: `content.js` (the template already keeps `PINFO`-style product info there), render in both product views, style with tokens. If the merchant wants it per product, it must come from the product `description` or a platform field; do not map slugs to text in the design layer.

## 8. "Reorder or restyle the checkout steps"

Allowed: layout, labels, step order of the presentation, field-level error wording (the commerce layer returns `details[{pointer,message}]`; mapping pointers to field messages is design-layer work). Required: keep `submitLocked()` on every input and button, keep `data-k` on inputs, keep the stale-response check by `submit.key`, keep the order-created-then-payment sequence, keep the no-token message. The checkout is `DESKTOP_ONLY`: edit the desktop tree.

## Escalation examples (reply and stop)

- "Hide all prices": `showPrices` lives in `public/config.js`, a locked file. Reply: needs a human to change `config.js` (and run `node scripts/check-layers.mjs --update`); offer to hide prices visually only if the merchant accepts that it is cosmetic (CSS can hide but not change data).
- "Add a coupon code box": needs a new API function and a platform feature. Reply with the proposal: `public/commerce/checkout.js` change, `public-api.json` entry, platform support first.
- "Charge a different currency symbol": `money()` is in the locked commerce layer.
- "Add Google Analytics / a chat widget": external script, storage and network outside the whitelist; needs a human-reviewed change (and a CSP decision).
- "Show member points or order history": no such functions in `public-api.json`; needs a commerce change.
- "Connect to a different shop's catalogue": API base and key are locked config.

Escalation reply template:

> I stopped before editing. Your request needs `<what>`, which belongs to the locked `<file/layer>`. Why: `<one line>`. Proposed change for a developer: `<files, public-api.json entry, update step>`. What I can do now within the design layer: `<alternatives>`. Nothing has been changed.
