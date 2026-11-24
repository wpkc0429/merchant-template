# The design layer: operating manual

This file is written to be used directly as an AI agent's operating instructions, and as the contract for human
designers. If you are an agent: read sections 1 to 3 completely before editing anything, make the smallest change that
does what the merchant asked, then run the checks in section 9.

## 1. The model in one page

The merchant admin (`admin/` in the merchant monorepo; every command in this file is run from `admin/`; from the repo root use `node scripts/check-scope.mjs admin --base <ref>`) is split into a **locked core** and an **editable design layer**.

| Layer | Where | Who may edit |
| --- | --- | --- |
| **Design layer** | `design/**` only | You (the AI agent) and human designers |
| **Core** (locked) | `app.js`, `index.html`, `config*.js`, `styles.css`, `lib/**`, `core/**`, `ui/**`, `vendor/**`, `design-defaults/**`, `scripts/**`, `docs/**`, `e2e/**` | Nobody except an explicit, human-reviewed *core change* (then `node scripts/check-design.mjs --update`) |

The core owns everything that must never be bypassed: authentication, tokens, permissions (`can`), every API call,
the state rules (what can be shipped or cancelled), the stale-write and SKU-safety guards, upload limits and HEIC
conversion, password rules, and the **confirmation step of every irreversible action**. The design layer owns how
things *look and read*: markup, structure, layout, colours, fonts, wording, which fields a form shows and in what order.

You can redesign every screen, including login, set-password, accept-invite, lists, detail pages and forms. You
cannot change what the buttons *do*, because the actions are core functions you call through `ctx`.

How a screen gets built:

```
URL  ->  core/routes.js (route id, permission nodes)  ->  permission gate (core)  ->  design/routes.js (id -> file)
     ->  design/views/<file>.js : export default function (root, ctx)   ->  core mounts what you put in `root`
```

* If a route's permission nodes are not all granted, the core mounts the `noPermission` screen **instead of your view**.
  Your view never runs. Nothing you do can reveal a screen the person may not open.
* If your view is missing, fails to load, throws or hangs (20 s), the core mounts the **built-in view** from
  `design-defaults/` and logs a console warning. Login is never blocked by a broken design.
* Your view receives `ctx`. `ctx` contains exactly the names in `lib/public-api.json` (section 4) and nothing else:
  no token, no shop id, no `fetch`, no storage, no core modules.

## 2. The files you may edit

```
design/
  tokens.css        CSS custom properties: colours, fonts, radius, spacing   (cheap path for small edits)
  theme.css         free-form extra CSS, loaded LAST (empty by default)      (your main restyling surface)
  copy.js           ALL wording: "key": "text with {placeholders}"           (data only)
  routes.js         route id -> view file                                    (data only)
  views/*.js        one screen per file; default export is the render function
  parts/*.js        shared pieces imported by views (order chips, auth form, images section, ...)
  assets/           images, fonts, icons referenced from CSS (`url(assets/x.svg)`) or `ctx.asset("x.svg")`
```

Allowed file types: `.js` and `.css` anywhere under `design/` (a `.js` directly in `design/` must be `copy.js` or
`routes.js`; code lives in `views/` or `parts/`), `.md`/`.txt` notes, and under `design/assets/` only
`svg png jpg jpeg webp gif ico avif woff2` (max 512 KiB each, real file content, SVG must be passive). At most 300
files, 4 MiB in total, names made of letters, digits and `. _ -`.

### `design/copy.js`

```js
export default {
  "nav.deliveries": "今日配送",
  "home.greeting": "你好，{shop}",
  ...
};
```

* Plain data: no calls, no template expressions, no spreads, no concatenation.
* Only **known keys** (those in `design-defaults/copy.js`, 632 of them). Unknown keys are ignored with a console
  warning and fail the guard.
* A string may use **fewer** `{placeholders}` than the default, never new ones. Max 600 characters.
* A missing, invalid or non-string entry silently falls back to the built-in text, per entry.
* Key families: `nav.*` navigation, `home.*`, `orders.*` / `order.*` (list / detail), `deliveries.*`, `members.*` /
  `member.*` / `tiers.*`, `reports.*`, `team.*`, `shipping.*`, `cat.*` / `catOrder.*`, `product.*` / `img.*`,
  `login.*` / `pw.*` / `invite.*`, `status.*` / `payment.*` / `fulfillment.*` (labels), `err.*` / `v.*` (error and
  validation wording), `confirm.*` (wording of irreversible-action confirmations), `common.*`, `state.*`, `pager.*`.
  Search the file (`grep '今日配送' design/copy.js`) to find the key for a sentence.
* Wording of a confirmation (`confirm.cancelOrder.title`, `.message`, `.yes`) is yours; the confirm step is the core's.
  Keep a confirmation's warning honest: do not remove "無法復原" from a message about something that cannot be undone.

### `design/routes.js`

Plain data mapping route ids to files under `design/views/` (path must look like `views/name.js`):

```js
export default { home: "views/home.js", orders: "views/orders.js", productNew: "views/product-edit.js", ... };
```

Two ids may share a file. Route ids are fixed (section 5); you cannot add routes or change URLs.

### `design/tokens.css`

Custom properties on `:root`: `--paper --card --ink --ink-soft --muted --muted-2 --clay --placeholder --band --line
--line-2 --line-3` (surfaces and text), `--accent --brand-primary` (accent and primary-button colour; the shop's
branding from `GET /admin/branding` is applied by the core as an inline override on `<html>` and wins, as before),
`--error --ok --warn`, `--f-display --f-serif --f-sans --f-mono` (fonts), `--r-sm --r-md --r-lg` (radius), `--shell
--gutter --sidebar-w --tabbar-h --savebar-h --safe-b` (layout metrics).

### `design/theme.css`

Any CSS, loaded after the core stylesheet, so it wins at equal specificity. Rules: no `@import` (anything), `url()`
only to files under `design/assets/` (or a `data:image/...` URI), no `expression()`, no `behavior:` /
`-moz-binding`, no CSS escapes outside strings, and no rule that hides or disables dialogs or confirmation controls
(`dialog`, `.dlg*`, `::backdrop`, `confirm` selectors with `display:none`, `visibility:hidden`, `opacity:0`,
`pointer-events:none`, zero size, ...). Fonts: the template uses a system font stack and makes no third-party font requests (the CSP allows none); to use a web font put a
`woff2` in `design/assets/` and declare `@font-face { src: url(assets/x.woff2) }`.

The core's CSS classes (`.btn`, `.card`, `.field`, `.tile`, `.ocard`, `.rt`, `.dlg`, ...) are in `styles.css`. Reuse them or
override them in `theme.css`; read `styles.css` to see them (do not edit it).

## 3. Writing a view

```js
// design/views/shipping.js
export default async function shipping(root, ctx) {
  const { h, pageHeader, dataTable, loading } = ctx.ui;   // destructuring is fine
  const { t, can, data, actions } = ctx;
  root.append(pageHeader(t("shipping.title")), loading());
  const list = await data.listShippingMethods();           // plain data; throws on API errors
  ...
}
```

* `root` is an empty element (a `DocumentFragment` for the shell, login, set-password, accept-invite and bootError
  screens). Append your DOM to it. The function may be `async`; return nothing, except the **shell** (below).
* Build DOM only with `ctx.ui.h(tag, attrs, ...children)`. Text children are always escaped. `h` drops (with a
  console warning) `innerHTML`, `outerHTML`, `srcdoc`, string `on*` attributes, `action`/`formaction`, script-like
  tags (`script iframe object embed link meta style base ...`), a string `style` (pass an object), and any `src`/`href`
  that is not relative, `#`, `tel:`/`mailto:`, `data:image/...`, same-origin or an allowed image origin. Event
  handlers are functions: `h("button", { onclick: fn })`. SVG: `ctx.ui.svg(tag, attrs, text)` (allowlisted tags).
* **Never** import anything except other files under `design/` by relative path (`import { x } from "../parts/x.js"`).
  Everything else you need arrives in `ctx`.
* After any action or data change, redraw yourself (`clear(el).append(...)` or re-render); there is no framework.
* Race guard: after an `await`, check `ctx.alive()` before touching the DOM (false means the person navigated away).
* The **shell** view (`routes.js` id `shell`) must return `{ main, setActive(navKey) }`: `main` is the element in
  `root` where the core mounts each screen; `setActive` is called on every navigation with the nav key (or `""`).
  It draws `ctx.nav.items` (`[{key, icon, href}]`, already filtered by permission). It may reorder, relabel, restyle or
  omit items. A hard-coded link to a screen the person may not open lands on the core's no-permission screen.
* Route-level data: `ctx.route.id`, `ctx.route.params` (e.g. `{id}`), `ctx.route.query`, `ctx.route.state` (login
  notice / boot error text). The link token of set-password / accept-invite is **not** in `params`; it stays in the
  core and is used by `ctx.auth.*`.
* Required fields stay required because the **action** checks them, not the form. A form that omits the title,
  slug or a SKU code gets the core's validation error back (`err.fields`, `{pointer: message}`; show them with
  `ctx.ui.applyFieldErrors(formEl, err.fields)` on elements created by `ctx.ui.field(label, input, { pointer })`).
  A form that omits an existing SKU size leaves that SKU untouched; no screen can delete a SKU.
* Irreversible actions (`cancelOrder`, `advanceShipment` to delivered/returned, `deleteProduct`, `deleteImage`,
  `deleteCategory`, `setMemberActive`, `revokeInvitation`, `createNewArrivalsCategory`) show the core's confirmation
  dialog themselves and return `{ cancelled: true }` if declined, or `{ ok: true, ... }`. Do not build your own
  confirmation as a substitute: it is not needed and does not replace the core's.
* Errors: functions throw. API errors have `.status` (number); core refusals are `ActionError`s
  (`e.isActionError`, `e.kind` = `permission | state | invalid | limit`, `e.message` already localized, `e.fields` for
  forms). Show them with `ctx.ui.toast(ctx.errorMessage(e, { 409: "..." }), "error")`.

### Minimal worked view (replace the not-found screen)

```js
export default function notFound(root, ctx) {
  root.append(ctx.ui.emptyState(ctx.t("notFound.title"), ctx.t("notFound.hint"),
    ctx.ui.h("a", { class: "btn btn--primary", href: "#/" }, ctx.t("nav.home"))));
}
```

## 4. The public API: everything `ctx` offers

`lib/public-api.json` is the machine-readable list; `scripts/check-design.mjs` fails if it differs from the real `ctx`,
and fails design code that uses a name not in it. Permissions are checked **inside** each function before any request.

### Top level
`ctx.route` · `ctx.alive()` · `ctx.t(key, params)` · `ctx.can(...nodes)` / `ctx.canAny(...nodes)` (UI hints only; the
core re-checks) · `ctx.navigate(path, {replace})` (only `/...` routes) · `ctx.scrollTop()` · `ctx.reload()` ·
`ctx.asset(name)` (URL of `design/assets/<name>`) · `ctx.errorMessage(err, overrides)` · `ctx.fieldErrors(err)` ·
`ctx.session` (`shopName`, `userEmail`, `userId`) · `ctx.nav.items` · `ctx.auth` · `ctx.ui` · `ctx.format` · `ctx.data` ·
`ctx.logic` · `ctx.enums` · `ctx.actions`.

### `ctx.ui` (presentation primitives)
`h svg append clear $ $$` · `button(label, {kind: ghost|primary|danger|danger-ghost, onClick, small, ...attrs})` ·
`busy(btn, fn)` · `toast(msg, "ok"|"error")` · `showDialog({title, content, actions:[{label,kind,onClick,testid,close}], wide})`
(`onClick` returning `false` keeps it open) · `confirmDialog({title,message,confirmText,cancelText,danger})` (for
*your own* non-core questions) · `field(label, input, {hint, pointer})` · `setFieldError clearFieldErrors applyFieldErrors
showFormError` · `input textarea select(options, value, attrs) toggle(label, checked, {onChange, hint, ariaLabel})` ·
`badge loading emptyState errorState pageHeader card dataTable({columns, rows, onRowClick, rowAttrs, empty}) pager
segmented copyText icon(name, size)`. Icon names: `home orders shipments products categories shippingMethods members
reports team more logout back up down left right plus close image`.

### `ctx.format`
`money(n)` (TWD whole dollars, never scaled) · `number` · `range(min,max)` · `date` · `dateTime` (Asia/Taipei) ·
`parseInteger` · `isValidSlug` · `slugify` · `taipeiDate(days?)` · `addDays(date, n)`.

### `ctx.data` (queries; each checks its permission first and returns plain data)
| Function | Needs |
| --- | --- |
| `listProducts({q,status})`, `productCount(status)`, `getProduct(id)`, `listImages(productId)`, `lowStockSkus()` | `product.view` |
| `categoryTree()`, `getProductOrder(categoryId)` | `category.view` |
| `listShippingMethods()` | `shipping_method.view` |
| `listOrders({page,status,payment,fulfillment,from,to,q,memberID})`, `getOrder(id)`, `deliveriesOn(date?)`, `unshippedPaidCount()` | `order.view` |
| `listOrderPayments(id)` | `payment.view` |
| `listOrderShipments(id)` | `shipment.view` |
| `listMembers({page,q})`, `getMember(id)` | `member.view` |
| `listPointTransactions(id,page)` | `member.view` + `point.view` |
| `memberOrderSummary(id)` | `member.view` + `order.view` |
| `listMemberTiers()` | `member_tier.view` |
| `salesReport({from,to,groupBy})`, `productReport({from,to,limit})` | `report.view` (range rules enforced) |
| `listTeam()`, `listRoles()`, `listInvitations()` | `user.manage_members` |
| `media()` (`{enabled, maxImages, maxBytes}`) | none (read-only facts) |

### `ctx.logic` (pure helpers that mirror state rules, for deciding what to *offer*)
`summarizeSkus skuForSize flattenTree remainingQty hasUnshipped canCancelOrder shipBlocker(order, shipments) -> "" |
cancelled | returned | unpaid | allShipped` · `isOpenDelivery timeline blockedReason presetRange fillDays maxDays
rangeDays isDate`. `ctx.enums`: `ORDER_STATUS PAYMENT FULFILLMENT SHIPMENT SIZES NEW_ARRIVALS_SLUG LOW_STOCK_THRESHOLD
ORDERS_PAGE_SIZE MEMBERS_PAGE_SIZE`.

### `ctx.actions` (every one enforces permission + state + validation in the core)
| Function | Notes |
| --- | --- |
| `saveProduct(original, form)` | `form = {title, subtitle, slug, description, status, sizes:{S,M,L:{enabled, sku_code, price, stock, is_active}}, category_ids}` (price/stock are the raw text). Validates, never drops a SKU, re-reads before the PUT, refuses a stale form (`e.name === "StaleProductError"`). Needs `product.create` / `product.edit`. |
| `deleteProduct(id)` | confirm; `product.delete` |
| `createNewArrivalsCategory()` | confirm; `category.create` |
| `uploadProductImage(productId, file, {onStage, onProgress})`, `setImageAlt`, `moveImage`, `deleteImage` (confirm) | `product.edit`; limits and HEIC conversion in the core |
| `createCategory({name,slug,parentId})`, `updateCategory(id, {...})`, `moveCategory(id, delta)`, `setProductOrder(categoryId, productIds)`, `deleteCategory(id)` (confirm) | `category.*` |
| `createShippingMethod({name,carrier,flatRate,isActive})`, `updateShippingMethod(id, {...})`, `setShippingActive(id, bool)` | `shipping_method.*` |
| `createMemberTier({name,minPoints,discountPercent})`, `updateMemberTier(id, {...})` | `member_tier.*` |
| `cancelOrder(id)` | confirm; only unpaid + unshipped; `order.cancel` |
| `createShipment(orderId, {carrier, tracking, quantities})` | state rule (`shipBlocker`) + quantities checked against a fresh read; `shipment.create` |
| `advanceShipment(orderId, shipmentId, "delivered"\|"returned")` | confirm; `shipment.update` (+ `shipment.return`) |
| `inviteMember({email, roleId})`, `revokeInvitation(id)` (confirm), `setMemberActive(userId, active)` (confirm) | `user.manage_members`; assignable roles only; owner/self protected |

### `ctx.auth`
`login(email, password)` (enters the app on success; throws → `auth.loginMessage(err)`) · `logout()` · `minPassword` ·
`passwordSetup.inspect()` / `.submit(password, confirm)` · `invitation.inspect()` / `.acceptNew(password, confirm)` /
`.loginAndJoin(email, password)` · `loginMessage(err)`. Tokens never reach you.

## 5. Routes (fixed by the core)

| Route id | URL | Needs | Default file |
| --- | --- | --- | --- |
| `shell` | (the frame) | session | `views/shell.js` |
| `login` `setPassword` `acceptInvite` | `/login` `/set-password/:token` `/accept-invite/:token` | none | `login.js` `set-password.js` `accept-invite.js` |
| `notFound` `noPermission` `bootError` | (system screens) | none | `not-found.js` `no-permission.js` `boot-error.js` |
| `home` | `/` | none | `home.js` |
| `orders` `orderDetail` `deliveries` | `/orders` `/orders/:id` `/deliveries` | `order.view` | `orders.js` `order-detail.js` `deliveries.js` |
| `members` `memberDetail` `tiers` | `/members` `/members/:id` `/members/tiers` | `member.view` (+ `member_tier.view`) | `members.js` `member-detail.js` `tiers.js` |
| `reports` | `/reports` | `report.view` | `reports.js` |
| `team` | `/team` | `user.manage_members` | `team.js` |
| `products` `productNew` `productEdit` | `/products` `/products/new` `/products/:id` | `product.view` / `product.create` | `products.js` `product-edit.js` |
| `categories` `categoryOrder` | `/categories` `/categories/:id/order` | `category.view` | `categories.js` `category-order.js` |
| `shipping` | `/shipping-methods` | `shipping_method.view` | `shipping.js` |

## 6. What you must never do

* Edit anything outside `design/`. The scope check rejects the whole change.
* Use `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon`, `localStorage`, `sessionStorage`, `indexedDB`,
  `document.cookie`, `eval`, `Function`, `import()`, `importScripts`, `Worker`, `window`, `document`, `globalThis`,
  `location`, `navigator`, `innerHTML` / `outerHTML` / `insertAdjacentHTML`, `setAttribute`, `createElement`,
  `new Image()`, `constructor`, `Reflect`, `Proxy`, bare `self`/`top`/`parent`/`frames`/`opener`.
* Import core modules (`../../lib/...`, `../../ui/...`, `../../core/...`) or anything outside `design/`.
* Create `<script>`, `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<style>`, or any element with a form `action`.
* Set `on*` handlers from strings, assign `.onclick = ...`, or call `setTimeout("code")`.
* Put an external URL (`https://...`, `//...`, `javascript:`) in a string, a link, an image or CSS.
* Obfuscate: string concatenation of literals, computed member access with templates/calls (`ctx.ui["h"+x]`),
  computed access on `ctx`.
* Use a `ctx` name that is not in `lib/public-api.json`.
* Remove a confirmation's meaning, hide dialogs or confirmation buttons with CSS, or build a fake confirmation.
* Try to show data the person may not see: `ctx.data.*` refuses it in the core, and an empty widget is the correct result.
* Edit `design-defaults/` (the pristine fallback), `lib/public-api.json`, `scripts/core.manifest.json`, or this file.

## 7. Previewing locally

```bash
# 1. serve the site (static files, with a same-origin proxy to an API; see README "本機執行" / "測試")
node scripts/serve.mjs --proxy http://127.0.0.1:8180        # http://localhost:3001
# 2. edit files under design/, reload the browser (no build step, no caching)
# 3. look at the browser console: every design problem is a "[design] ..." warning
```

Check both widths: 390px (phone, bottom tab bar) and 1280px (desktop, sidebar). Nothing may scroll horizontally.
For the AI edit service the same files are served from a branch checkout (see `docs/AI-EDIT-SERVICE-NOTES.md`).

## 8. Checks to run before showing a preview

```bash
node scripts/check-design.mjs --base <ref>      # the one command (ref = the commit the edit started from)
node scripts/test-guard.mjs                     # (maintainers) the guard's own tests
```

`check-design.mjs` exit codes: **0** all checks passed · **1** at least one violation (the report lists rule, file, line,
reason; fix and re-run) · **2** usage/environment error (bad ref, unreadable checkout; nothing was judged).
Without `--base` the scope check is skipped; `--files a b c` checks an explicit list. It runs: scope (only `design/**`
changed), file inventory, JS scan, CSS scan, assets, schema (`copy.js` / `routes.js` validated with the loader's own code),
the `ctx` manifest (design code uses only listed names; the manifest equals the real `ctx`), the pristine defaults, the
copy-key check, the core hash manifest (`scripts/core.manifest.json`, CRLF-normalised) and `scripts/check-layers.mjs`.
`--update` rewrites the core manifest: **only after an intentional, reviewed core change, never as part of a design edit.**

## 9. Worked examples

### "Make the admin pink"
Edit `design/tokens.css` only:
```css
--paper: #fff1f5;  --card: #fffafc;  --accent: #d4688a;  --brand-primary: #8a2f52;  --clay: #c0577a;  --band: rgba(247, 214, 225, .72);
```
(The shop's own branding colours, when set in the platform, still override `--accent` / `--brand-primary`.) For anything
the tokens cannot do, add rules to `design/theme.css`, e.g. `.btn { border-radius: 8px; }`. Check contrast of
`--ink` on `--paper` and of white text on `--brand-primary`.

### "Rename 今日配送 to 今日出貨"
In `design/copy.js` change the entries whose text is 今日配送: `nav.deliveries`, `home.tile.deliveries.title`,
`home.stat.today.label`, `home.deliveries.title`, `orders.toDeliveries`, `deliveries.title.today` (and, if wanted,
`deliveries.empty.today`). Keep them short (a nav label must fit on a 390px tab bar). Do not touch code.

### "Hide the English subtitle field"
In `design/views/product-edit.js` remove the `field(t("product.subtitle"), subtitle, {...})` line from `basics`
(keep the `subtitle` input element: `collect()` still sends its value, so an existing subtitle is preserved, and the
slug auto-fill that listens to it simply stops). Do **not** remove title, slug or the SKU fields: the core would answer
with its validation errors and the form could not save. Optionally drop `product.subtitle*` copy entries (harmless to keep).

### "Reorder the nav" (and the phone tab bar)
In `design/views/shell.js` change the order in which `items` are drawn, e.g. `const order = ["home", "deliveries", "orders",
"products", ...]; const items = order.map((k) => ctx.nav.items.find((n) => n.key === k)).filter(Boolean)`, and change
`TAB_KEYS` for the four primary phone tabs. Leaving an item out hides it; you cannot add one: `ctx.nav.items` already holds
only what the permissions allow. Labels are `nav.*` in `copy.js`.

### "Restyle the whole admin"
`tokens.css` for colours/fonts/radius, `theme.css` for the rest (page headers, cards, buttons, tables). Add a logo as
`design/assets/logo.svg` and show it from `shell.js` with `h("img", { src: ctx.asset("logo.svg"), alt: "" })`. Test every
screen at 390px and 1280px.

### "Restructure the orders screen" (cards to a table)
Create `design/views/orders-table.js`, then set `orders: "views/orders-table.js"` in `design/routes.js`:
```js
export default async function orders(root, ctx) {
  const { pageHeader, dataTable, loading, clear } = ctx.ui;
  root.append(pageHeader(ctx.t("orders.title")), loading());
  const r = await ctx.data.listOrders({ page: 1 });
  root.replaceChildren(pageHeader(ctx.t("orders.title")), dataTable({
    rows: r.orders,
    rowAttrs: (o) => ({ "data-testid": "order-row" }),
    onRowClick: (o) => ctx.navigate(`/orders/${o.id}`),
    columns: [
      { label: "#", primary: true, render: (o) => `#${o.id}` },
      { label: ctx.t("order.amounts.total"), render: (o) => ctx.format.money(o.total_amount) },
    ],
  }));
}
```
Order detail actions keep working unchanged (`ctx.actions.cancelOrder` shows the core's confirmation).

### "Reorder the product form sections"
In `design/views/product-edit.js` change `const formEl = h("div", { class: "form-body" }, basics, sizeCard, catCard);` to
`sizeCard, basics, catCard`. Everything else (validation, SKU safety, stale-save refusal) is the core's.

### "Add a dashboard widget" (built from existing data functions)
In `design/views/home.js`, inside the `jobs` list:
```js
if (can("product.view")) jobs.push(data.productCount(0).then((n) =>
  stats.append(stat("已下架商品", format.number(n), "還沒有上架的商品", "#/products", "stat-hidden"))));
```
`data.productCount(0)` counts inactive products. If the person lacks the permission the function refuses and the widget
is simply absent; for any new wording add keys by reusing existing ones or write the text inline in your view.

## 10. When something goes wrong

* A console warning starting `[design]` names the entry that was refused and what was used instead.
* View throws, is missing or hangs: the built-in view is shown (that is the fallback working, not a bug in the core).
  Fix the view, or revert the commit.
* The guard fails: the report names the rule. Typical fixes: remove the forbidden identifier, use `ctx.ui.h` instead of
  raw DOM, move the logic to an existing `ctx.actions` function, shorten/split a string instead of concatenating.
* If the feature the merchant wants needs something `ctx` does not offer (a new data field, a new action), **stop and
  say so**: that is a core change for a human, not something to work around.

## 11. Known limits (be honest with the merchant)

Static scanning is conservative defence in depth, not a sandbox: design views are JavaScript running in the admin
origin. A determined, obfuscated payload could in theory evade the scan; the real controls are (1) the core never
puts tokens or the network in `ctx`, (2) the safe builder `ctx.ui.h`, (3) a strict CSP when serving (README
"部署", section 5), and (4) human approval of the preview. CSS can still change appearance in confusing ways (for
example hiding a non-dialog button): review the preview at both widths before approving.
