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
* Exception (D14): the five design-history confirmations (`approveDesign`, `approveRevert`, `rejectDesign`, `cancelDesign`, `revertDesign`) and the review dialog have NO copy keys: their title, button labels and decline label are core text, and core dialogs are drawn in a closed shadow root with the core's own stylesheet (not themable; your CSS cannot reach them, and `ctx.ui.showDialog` does nothing while one is open).
* Core dialogs (every confirmation and the design review) can be themed ONLY through these design tokens, which the core reads, validates and turns into literal values in the dialog's own stylesheet (so @property registrations and other CSS cannot change the painted result): `--ink` + `--card` (text and dialog colours: opaque, contrast at least 7:1 together, else both default); `--brand-primary` (primary buttons and checkbox; also what the shop branding sets) and `--error` (danger buttons, the warning frame) and `--accent` (focus ring, note stripe): opaque colours; a colour that is too close to the card is NOT dropped but moved along its own hue, in lightness, to the nearest shade that passes (at least 3:1 against the card; for the two button colours also at least 4.5:1 for the automatically chosen white or black label), so a pastel brand colour such as #c9a46a on #f7f4ee becomes a darker shade of the same hue, and on a dark card the default red is lightened until it reads (a destructive button still looks destructive); `--r-sm` and `--r-lg` (plain px values up to 24 and 28); `--f-sans` (honoured ONLY when it is one generic keyword: serif, sans-serif, system-ui, monospace, ui-serif, ui-sans-serif, ui-monospace, ui-rounded). Muted and secondary text are solid ink-derived colours that pass 4.5:1 on both the card and the tinted band. Set them in `design/tokens.css` (the shop branding sets `--brand-primary` and `--accent` itself). Any other CSS (selectors, `content`, filters, sizes, positions, registered custom properties) cannot change, hide or rewrite a core dialog.
* Wording of a confirmation is yours: `confirm.<id>.title`, `confirm.<id>.text` (a lead-in sentence; the default is empty for most
  confirmations, so you may leave it empty or add one) and the button labels `.yes` / `.no`. **The confirm step AND its warning
  are the core's.** For every irreversible action (`cancelOrder`, `shipDelivered`, `shipReturned`, `deleteProduct`, `deleteImage`,
  `deleteCategory`, `disableMember`, `revokeInvite`) the dialog always shows a FIXED warning ("...無法復原", "庫存會歸還", the points
  claw-back, ...) that lives in `core/warnings.js`, has no copy key, and cannot be defined, reworded, shortened or removed by you:
  a `confirm.<id>.warning` key (or any `confirm.*.*warn*` key) fails the guard (`schema/copy`, "FIXED by the core"), and CSS that
  hides, shrinks or disables the dialog or the warning (`.dlg__warning`, `[data-testid=confirm-warning]`) fails `css/hides-dialog`.
  You may style it (colour, weight). The v0.1.0 key `confirm.<id>.message` no longer exists for these ids: it is ignored (the guard
  prints a "retired" note); move any lead-in wording to `.text` and drop the warning part, because the core shows the warning anyway.
  Needing a different warning is a core change (a human edits `core/warnings.js`), not a design change.

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
override them in `theme.css`; read `styles.css` to see them. **`styles.css` is LOCKED and stays locked** (decided 2026-11-25): you customise the admin only through `design/tokens.css` and `design/theme.css`; if that is not enough, say so and escalate.

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
reports team more logout back up down left right plus close image content`.

**Content form builder (core-owned, since v0.3.0).** `contentForm(schemaNode, value, {layout, readOnly})` returns `{el, read(), validate(), setErrors(fields), focusFirstError()}`; `contentField(schemaNode, pointer, value, {readOnly})` returns `{el, pointer, read(), validate(), setErrors(fields)}` for one field (`value` is the whole content, the field reads its own part). The control for each field comes from the schema's `x-editor` (`text textarea richtext image link color select list sections`); **validation is locked in the core** (required, length, pattern, enum, link scheme, image domain, number range, array limits, block types) and runs again before every save. You control LAYOUT only: `layout` is `[{title?, description?, fields: ["/hero", "/hero/title", ...]}]` (JSON Pointers into the content; array items are not addressable). A **required** field your layout leaves out is appended by the core in an extra group, so a layout can never make a required field unreachable; optional fields you omit keep their stored value. `validate()` returns `{ok, errors}` and shows the errors on the fields; `setErrors({pointer: message})` shows a 422 (`e.fields` of the action error); it returns the messages that found no field. Image fields upload through the core (permission, HEIC conversion, size limits); labels and help text come from the platform schema as plain text.

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
| `getContentSchema()` (`{version, format, schema}` or `null` when none is registered), `listContentSchemaVersions()`, `listContentDocuments()` (`[{key, type, title, status, isPublished, needsAttention, declared, rev, updatedAt, publishedAt}]`), `getContentDocument(key)` (adds `draft` (hydrated), `published` (content or null), `schemaNode`, `typeTitle`, `meta`), `listContentRevisions(key)`, `getContentRevision(key, rev)` | `content.view` |
| `dryRunContentSchema()` (**read-only**: reads the storefront's `content.schema.json` and returns the platform's report `{version, wouldRegisterVersion, changed, report, lines, hasRemovals}`; it can only ever send `?dry_run=true`) | `content.manage` |
| `contentSite()` (`{previewEnabled}`) | none (read-only fact) |
| `getVersionPreview(previewId)` -> `{id, requestId, tag, state: "waiting"/"ready"/"failed"/"expired", status, superseded, failureCode, failureDetail, failureRuleIds[], coreVersion, createdAt, readyAt, expiresAt, readOnly: true, origin}`. `origin` is set only for the person who asked, only while `ready` and not expired, and only if it is a plain https origin (no path); `failureDetail` / `failureRuleIds` are DATA (render as text). Errors are ActionErrors (see `requestVersionPreview`) | `design.view` |
| `listDesignRequests({site?, status?, kind?, page, pageSize})` -> `{requests[], page, pageSize, total}` (each request: `{id, site, kind, status, promptExcerpt, promptFlags, proposedByName, approvedByName, rejectedByName, isCurrent, revertTargetTag, publishedTag, headSha, coreVersion, createdAt, updatedAt, approvedAt, ...}`; `site`/`status`/`kind` must be known values, `page` >= 1, `pageSize` 1-100, checked before any request; an invalid filter is an ActionError `invalid`), `getDesignRequest(id)` -> the same fields plus `{promptText (or null after retention), changeNote, rejectReason, failureDetail, diff: {filesChanged, additions, deletions, files[{path,status,additions,deletions}]}, guard: {passed, checkedSha, ruleIds[], violationCount, guardVersion, checkedAt} or null, previewOrigin (a plain https origin or ""), previewReadOnly: true, events[{seq, kind, fromStatus, toStatus, actorType, actorName, headSha, createdAt}] (first 100)}`; `getDesignState({site?})` -> `{sites: [{site, current: {requestId, tag, coreVersion}, designFloorVersion, untracked, pendingApproval, updatedAt}], pendingApproval, designEnabled}`. **All text is DATA: render it as text.** `promptText`, `headSha`, `diff`, `guard` and `previewOrigin` are what the AI service CLAIMED, not platform-verified; the status, approver, approval time, approved sha and tag are the platform's own record: label them apart. Names are display names, never an email. The core never returns a signed URL, token, shop id or ETag (the ETag stays in the core). Errors are ActionErrors (`permission`, `gone` 404, `invalid`, `limit` with `retryAfter`, `state` 503). They are GETs and also work on a read-only preview host | `design.view` |

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
| `saveContentDocument(key, values, {rev, create, typeKey, meta})` | `values` = `contentForm().read()`. Validates with the schema from the platform, sends `If-Match: "<rev>"` (create: `If-None-Match: *`), returns `{ok, doc}` where `doc` is **what the server stored** (rebuild the form from `doc.draft`: rich text is rewritten). Errors: `kind "stale"` (412, someone else saved first: offer a reload), `kind "invalid"` with `e.fields` (client or 422 pointers), `kind "internal"` (428, a programming error). `content.edit` |
| `publishContentDocument(key, {rev})`, `unpublishContentDocument(key)`, `deleteContentDocument(key)` | confirm (fixed warning); a document that `needsAttention` cannot be published; `content.publish` |
| `restoreContentRevision(key, rev, {rev})` | confirm; returns `{ok, restoredToDraft: true, restoredValid, doc}`: **only the draft changes, nothing is published** (say "restored to draft, not published yet"); `content.edit` |
| `uploadContentImage(file, {onStage, onProgress})` | `content.edit`; normally used by the form builder itself |
| `previewContentDocument(key)` | opens `{site}/?content_preview=<token>` in a new tab (needs the host to configure the site origin; check `data.contentSite().previewEnabled`); `content.view` |
| `requestVersionPreview(requestId)` -> the same object as `data.getVersionPreview` (state `waiting`; poll `data.getVersionPreview(result.id)` every few seconds). Asks for a **version preview**: a past published design on the CURRENT core, short-lived and read-only, not part of any request, not an approval. `requestId` must be a request id (checked for shape before any request). Failures are ActionErrors: `reason` `revert_below_core_floor` (older than a core sync that needs design changes; `e.detail` has the platform's explanation), `already_current`, `invalid_state`, `site_state_unknown` (kind `state`), `hourly_cap_reached` / `daily_cap_reached` (kind `limit`, `e.retryAfter` seconds, the wait is in the message). `design.view`. **Refused in a preview** (see below) |
| `openDesignReview(requestId)` -> `{outcome: "approved"/"rejected"/"changesRequested"/"closed", request}`. Opens the **core-drawn review dialog** (what is being approved: version and file count, the guard result as the service claimed it, before/after screenshots, the preview link, the fixed warning, and a required "I have reviewed the before/after and the preview" checkbox before the approve button works; also reject and request changes). It takes NO head sha, ETag or URL: the core reads the request itself and approves exactly what the person saw; if the design changed meanwhile the dialog reloads and the person must look again. The design layer renders only its own button; it gets no element and no screenshot URL. Needs `design.view` to open; approve / reject / request changes need `design.approve` (owner), checked again inside the core. `request` has the shape of `data.getDesignRequest` | `design.view` (+ `design.approve` for the buttons) |
| `requestDesignRevert(requestId, {reason?})` -> `{request}` (the NEW revert request, `kind: "revert"`) or `{cancelled: true}`. Asks for a confirmation with the fixed `revertDesign` warning (the old version tag is read by the core), then creates a revert request; it changes nothing live: the request still goes through the guard, a preview, screenshots and a human approval. `reason` is optional plain text, at most 500 characters. 409 reasons (`revert_below_core_floor`, `already_current`, `request_in_progress`, `invalid_state`, `site_state_unknown`) become ActionErrors with `reason` | `design.revert` |
| `cancelDesignRequest(requestId)` -> `{request}` or `{cancelled: true}`. Confirmation with the fixed `cancelDesign` warning, then cancels a request that is not finished | `design.request` |
| `registerContentSchema()` | **Takes no arguments.** Reads the storefront's `content.schema.json`, dry-runs it, and ALWAYS shows the core's confirmation dialog (report + fixed warning); a platform 409 about removed values needs a second explicit confirmation. Nothing you pass can skip it (and AI sessions and automation never register: decisions D6). `content.manage` (store owner) |

### `ctx.auth`
`login(email, password)` (enters the app on success; throws → `auth.loginMessage(err)`) · `logout()` · `minPassword` ·
`passwordSetup.inspect()` / `.submit(password, confirm)` · `invitation.inspect()` / `.acceptNew(password, confirm)` /
`.loginAndJoin(email, password)` · `loginMessage(err)`. Tokens never reach you.

### Preview mode is read-only (core-enforced)

On a preview host (a version preview or a change preview of the AI edit service; `deploy/preview-config.sh` writes `window.ADMIN_CONFIG.preview`) the core is READ-ONLY: **every** `ctx.actions` function (also `requestVersionPreview` and `previewContentDocument`) throws an ActionError with `reason: "read_only"` before anything else (no permission check, no dialog, no request), and `lib/api.js` refuses any non-GET request as a backstop. Show the error (`ctx.errorMessage(e)`); do not try to work around it. Reads and navigation work. The core also puts its own banner (preview kind, tag, expiry) at the top of the page: it lives outside your container, is rebuilt if removed or hidden, and cannot be changed from the design layer.

### The version preview section

`design/parts/version-preview-section.js` (`versionPreviewSection(ctx, {requestId, tag, onRevert})`) is the default "preview this version" block for the design history: the button, the waiting / ready (link to the preview) / failed (with `failureRuleIds`) / expired states, the limits text and the revert button (only when you pass `onRevert`). Embed it next to each past published design. Rules the core enforces regardless of your view: the limits sentence `t("vp.limits")` is **fixed** (an override in `copy.js` is ignored with a console warning; always show it next to the button), and the revert button ("改成這個版本") is rendered only when you pass `onRevert` AND the person has `can("design.revert")`; it only leads INTO the existing revert flow; a preview is not an approval and skips nothing. Since v0.5.0 the default request screen (`views/design-request.js`) passes `onRevert` for a published design that is not the one in use, wired to `ctx.actions.requestDesignRevert`, so the button is real (it needs `design.revert`; the core asks for its fixed confirmation and creates a NEW revert request; nothing changes until that is approved). Only the `vp.limits` text is fixed: do not put `vp.limits` in your `copy.js` (the default design has none; an override is ignored and prints a console warning). The preview link `href` is opened through a single core-registered https origin (link only, never an image source; the next preview replaces it).

The core banner on preview hosts (`ui/preview-banner.js`) is checked against the browser's own computed styles: hiding it (also via `<body>`/`<html>` opacity, filter, transform, clip, mask, `text-indent`, text fill, `content-visibility`, generated content, `::first-line`), shrinking, moving or covering it (`elementFromPoint`) is repaired once; if it cannot be repaired, or keeps being undone (more than 4 rebuilds in 3 s), the page fails closed ONCE (the app is removed and a message is shown). A host whose `preview-config.js` did not load completely (no `previewConfig` marker on a non-localhost host) also fails closed.

### The design history screens (v0.5.0, decision D15)

Two default screens, plus one nav item, show every AI design change. Both are plain views built only from `ctx`, so the design layer can restyle or rearrange them like any other screen; what it cannot change is the core review dialog and its fixed warnings.

* `views/design-history.js` (route `design`, `/design`, `design.view`): site tabs (storefront | admin), a status filter and the page in the URL (`#/design?site=admin&status=awaiting_approval&page=2`), a table on desktop and stacked cards on a phone (`ctx.ui.dataTable`), a status chip per row, the "currently in use" marker (`isCurrent`), the state line (current design tag, untracked changes, from `ctx.data.getDesignState`; a failure there is ignored) and paging with `ctx.ui.pager`. Three DIFFERENT empty states: no history (`dh.empty.none.*`), no screenshots yet (`dh.empty.noShots.*`, shown on a request that has none) and storage not configured (an ActionError with `reason: "design_storage_not_configured"`, `dh.empty.storage.*`); any other failure uses `ctx.ui.errorState` with retry.
* `views/design-request.js` (route `designRequest`, `/design/:id`, `design.view`): TWO regions kept apart on purpose. **What the service claims (not verified by the platform)**: the prompt (plain text, shortened with an expand button), the gatekeeper report, the change summary and the change-preview link. **Platform record**: state, proposer, approver, times, the approved version, the tag. Then the event timeline. Buttons follow `can()`: "look at before / after" calls `ctx.actions.openDesignReview(id)` (approve, reject and request changes happen only inside the core dialog), "cancel" calls `ctx.actions.cancelDesignRequest(id)` (needs `design.request`), and a published design embeds `versionPreviewSection` with `onRevert` wired to `ctx.actions.requestDesignRevert(id)` (needs `design.revert`; on success the screen opens the new revert request). After an action the screen reloads the request.
* The nav item `design` ("設計歷史", icon `image`) is listed only for `design.view`, and the default `shell.js` shows it only when `getDesignState().designEnabled === true` (hidden by default; any failure or false keeps it hidden; D16). The pending-approval badge (`getDesignState().pendingApproval`) is loaded only then and refreshed when the design screens open. The routes `/design` and `/design/:id` stay reachable for `design.view` either way; with `designEnabled === false` and no history the list shows a calm `dh.empty.disabled.*` state. An out-of-range `?page=` jumps to the last page.
* Roles (platform D9): the owner sees everything and can approve, reject, request changes, cancel and request a revert; an editor has only `design.view` (lists, details, version preview, the review dialog without any decision button); staff (no `design.view`) get no nav item and a direct URL shows `noPermission`.
* Read-only preview hosts: `ctx.route.state.readOnly` is `true` (the core sets it from the deployment's preview config; it is plain data, not a function). The default screens then render but leave out every action button. Do not work around it: the core refuses every write anyway.
* The change-preview link: `getDesignRequest` registers the request's `previewOrigin` in the ONE href-only link slot (`allowPreviewLinkOrigin`; replaced by the next request or version preview, never widening the image or link allowlist). `h()` drops an `href` the slot does not allow, so check `a.hasAttribute("href")` and fall back to plain text like the default does. Only plain https origins reach it.
* Rules: all dynamic text (prompt, names, paths, reasons) goes in as text (h() children or `textContent`), never HTML; keep the "claims" and "record" labels (`dh.claims.title`, `dh.record.title`) next to their data; do not re-create approve or reject yourself. Touch targets stay at least 44 px and nothing may overflow at 390 px. Copy keys are `dh.*` and `nav.design` (the approval, reject, cancel and revert wording is core text, not in `copy.js`).

Example, show one more fact in the record region: in `design-request.js` `record()` add a row such as `[t("dh.rec.core"), req.coreVersion]` to the `factList` rows (a row with an empty value is left out).

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
| `content` `contentDocument` `contentRevisions` | `/content` `/content/:key` `/content/:key/revisions` | `content.view` | `content.js` `content-document.js` `content-revisions.js` |
| `design` `designRequest` | `/design` `/design/:id` (nav item `design`, icon `image`) | `design.view` | `design-history.js` `design-request.js` |
| `designVersionPreview` | `/design/:id/version-preview` (no nav entry; the request screen embeds the same section) | `design.view` | `design-version-preview.js` |
| `contentSchema` | `/content-schema` (distinct from `/content/:key`: `schema` is a valid document key) | `content.manage` | `content-schema.js` |

The navigation entry `content` (icon `content`) is listed only for roles with `content.view` (owner and editor; staff see nothing); the schema screen is reached from the list for `content.manage` holders.

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
* Register a content schema, or build your own path to it: `ctx.actions.registerContentSchema()` takes no arguments and always opens the core's confirmation (report + fixed warning). An AI session only edits `public/content.schema.json` (storefront design layer) and never registers; do not hide or restyle the report (`.dlg__detail`) or the warning.
* Drop a required content field from a screen on the assumption that it will not be sent: the form builder appends it, and the core validates the whole content before every save.
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

### "Lay out a content screen" (the form builder)
In `design/views/content-document.js` replace `ctx.ui.contentForm(doc.schemaNode, doc.draft, { readOnly: !editable })` with a layout:
```js
form = ctx.ui.contentForm(doc.schemaNode, doc.draft, { readOnly: !editable, layout: [
  { title: t("content.group.hero"), fields: ["/hero"] },      // add the key content.group.hero to BOTH copy files first
  { fields: ["/storyTeaser/title", "/storyTeaser/lede"] },
] });
```
Fields your layout does not list are appended by the core when they are required; the screen still saves with `actions.saveContentDocument(key, form.read(), {rev: doc.rev})`, shows server field errors with `form.setErrors(e.fields)`, and on `e.kind === "stale"` offers a reload. Never register or publish from your own code path: those actions open the core's confirmation.

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

### Dialogs, input and DOM reach (decision D12, v0.4.2)

The core owns every dialog, every confirmation and the fixed warnings. The scan and the runtime therefore refuse the following in design code (rule ids in `check-design.mjs` output; fixes in `.claude/skills/admin-design/references/guard-failures.md`):

- **No dialog, popover, fullscreen or pointer lock of your own** (`js/dialog-api`, `js/dialog-element`, `js/popover-inert`): no `h("dialog")`, no `popover` / `inert` attributes, no `showModal()` / `show()` / `close()` / `requestFullscreen()`. Use `ctx.ui.showDialog` (it returns only `{ close }`; its action buttons also receive `{ close }`). At runtime `h()` throws a design error for the dialog tag and these attributes, and the screen falls back to the built-in one.
- **No programmatic clicks, events or submits** (`js/synthetic-input`, `js/core-ui-selector`): no `dispatchEvent`, `new Event` / `MouseEvent` / `KeyboardEvent`, `requestSubmit`, `.submit()`, no `.click()` except on a hidden file input you built with `h("input", { type: "file" })`, no strings naming the core's confirm controls. At runtime every core dialog button ignores events that are not real user input, so a confirmation cannot be answered by code.
- **Stay inside your own subtree** (`js/dom-escape`): no `ownerDocument`, `getRootNode`, `parentNode`, `parentElement`, `closest`, `firstChild` / `lastChild` / `childNodes` / `first|lastElementChild`, siblings, `getElementById`, `relatedTarget`; `querySelector(All)` only on `root` or an element built in the same file; `ctx.ui.$` / `$$` need that element as the second argument (at runtime they refuse `document`, `body` and anything near a dialog, and never return a core node). `children` is allowed (it only walks down).
- **`ctx` is the module's own argument** (`js/ctx-shadow`, `js/ctx-unknown`): do not shadow or re-assign it, do not index it (`ctx.ui["$"]`), spread it or enumerate it (`Object.values(ctx.ui)`).

### Runtime hardening (decision D18, v0.5.0)

Design modules are loaded with `import()` into the same page, origin and module graph as the core, so the core closes what it can **before the first design module loads** (the scan stays the first line of defence; this is the second). None of it changes what your views may do through `ctx`; it only removes what they never should have reached:

- **The API client and the token are sealed.** `lib/api.js` exports only `ApiError`, `takeApi` and `sealApi`; `takeApi()` throws once the app has booted. There is no `tokens`, no `.access`, no `api()` / `apiRaw()` / `refreshTokens()` to import, and `ctx.session` never had a token. Importing a core module from a view is refused by the guard and gets you nothing at run time.
- **Built-ins are frozen, by enumeration.** Every constructor, namespace object and function binding on the page's global object is frozen or made read-only (the list is not written by hand: anything the browser offers is covered, except the documented `EXCEPTIONS` in `lib/lockdown.js`), including the singleton instances `document`, `performance` and `navigator`; the accessors of `window` (`innerWidth`, `innerHeight`, `devicePixelRatio`, `visualViewport`, `name`, `opener`, `on*` ...) can be read but not redefined or assigned. The named-properties object above `Window.prototype` cannot be frozen (a browser special case, low risk). For example `Object.prototype`, `Function.prototype`, `Array.prototype`, `Promise` (and its statics), `JSON`, `Headers`, `Response`, `Request`, `URL`, `Blob`, the iterator prototypes, `Node` / `Element` / every HTML element prototype, `XMLHttpRequest`, `Storage` and the rest listed in `lib/lockdown.js`, plus `fetch`, `XMLHttpRequest`, `structuredClone`, `setTimeout` ... on `window`. Assigning to or redefining any of them throws in strict mode (ES modules always are) and does nothing in sloppy code. A view that patches a built-in will fail to load and the built-in view takes over, as for any broken design. `error.name = "X"` on your own error instances still works.
- **Review and approval are core-owned and slower on purpose.** In the review dialog the approve button (and the reject confirmation) is enabled only after the box was ticked with a real click and **1 second** after the dialog appeared (a countdown is shown once per second, one polite announcement says when the button is usable, and while it waits the button is `aria-disabled` and described by its hints); the service's scan report (guard verdict, rule ids, checked sha, the full list of changed paths) is shown next to the approve button. The report is a **service claim shown to the human, not a gate**: a failed guard (`passed: false`) is displayed prominently but does not block the person from approving. You cannot change any of it.
- **Not covered:** this is defence in depth, not isolation. A module in the admin origin can still read the DOM, call anything `ctx` gives it, and ask the platform for a session the way the page does (the cookie refresh). Browser extensions are out of scope.

### Import-map isolation (decision D19, v0.5.0)

Your modules are loaded from `/design/`. The page carries an import map (`index.html`) that lets a module under `/design/` import **only files under `/design/`**; every other import, in any spelling (`../../lib/x.js`, `/lib/x.js`, a full URL, a query string, percent-encoding, `import()` with a computed name, `new URL(..., import.meta.url)`), fails with a TypeError. This is the second wall behind the scan (which already refuses imports outside `design/`). You do not have to do anything; import your own `../parts/*.js` as before. Do not put a percent sign in a design file name or path (nginx refuses any path with an encoded slash, dot or backslash, and any double slash).

- **If the design looks like the built-in one and a note says "custom design is disabled"**, the isolation could not be verified (the server's CSP lacks the import-map hash, the map text was changed, or the browser has no import maps): the core did not load any design module. That is a hosting problem, not a design bug. Preview hosts must be the same image as production.
- The console shows one 404 for `/deny/lib/canary/target.js` on every load: that is the start-up check, expected.
- Not isolation: a module can still read the page and call whatever `ctx` gives it. Firefox and Safari are unverified; there the check fails closed (design off) if the map is not enforced.

### Preview hosts: what the operator sets (decision D18)

A preview host serves the same files with `ADMIN_PREVIEW_MODE=version|change` (plus `ADMIN_PREVIEW_TAG`, `ADMIN_PREVIEW_EXPIRES`; `deploy/preview-config.sh`) on its **own origin**, which the platform operator registers in the platform's `ADMIN_PREVIEW_ORIGINS` (exact `https://p-1.preview.example` or one wildcard label `https://*.preview.example`; never the normal admin origin, never a `Domain=` cookie over a parent domain). Sessions started from that origin are **read-only on the server**: the platform issues `scope: "preview_ro"` tokens (and the host-only cookie `__Secure-admin_preview_refresh`) that last at most 30 minutes in total, whatever you click. The template then does the following, and the design layer cannot change any of it:

- the client read-only flags stay (every write action is refused before a request, `lib/api.js` refuses non-GET): user experience only, the platform is the boundary;
- a login or refresh answer **without `scope: "preview_ro"`** is dropped at once ("this address is not set up as a preview host"): a preview host never keeps a normal, writable session;
- a 403 `preview_read_only` shows "this is a preview, please go back to the normal admin to edit" (it is not a missing permission and does not log the person out);
- when the 30 minutes are over (the refresh is refused) the next request lands on the login screen with "the preview has expired, please log in again"; any other refresh failure shows the generic message;
- tokens exist per origin in memory only, so nothing is shared between the preview and the normal admin: the person logs in on the preview host with their normal account.

### How the scan reads your code (decision D17, v0.5.0)

The scan has its own small JavaScript lexer (`scripts/lib/design-scan.mjs`); it does not parse the language. Its contract, so that a banned name cannot be hidden by the way it is spelled:

- **Names are compared by their canonical value.** An identifier or a property name is decoded first: `\u0066etch`, `\u{66}etch` and `fetch` are the same name (as they are for JavaScript), whichever characters of the name are escaped, after a `.` or `?.`, as an object key, a method name, a private `#name`, or a `ctx` alias. Non-ASCII letters, combining marks, the zero-width joiners and letters outside the BMP belong to a name; no Unicode normalisation is applied (JavaScript compares code points, so does the scan).
- **String and template values are compared by their cooked value.** `"\x66etch"`, `"\u0066etch"`, `"\u{66}etch"`, `"\146etch"` (legacy octal), a string split by a line continuation, and a template literal `` `confirm-\x79es` `` are the values `fetch` and `confirm-yes`, so every rule that looks at a string (banned names, the dialog / popover / inert strings, the core confirmation control ids, markup and script schemes, import specifiers, `["click"]`-style computed access, `on*` handler keys) sees the same text the engine does.
- **Line terminators and whitespace are JavaScript's.** `\n`, `\r`, `\r\n`, U+2028 and U+2029 end a `//` comment and an unterminated string; NBSP, the byte-order mark and the other Unicode spaces are whitespace; a hashbang is a comment only on the very first line; `<!--` and `-->` are not comments (they are a syntax error in a module), so what follows them is scanned.
- **Numbers never swallow a property** (`1..constructor`, `0x10.x`, `1e3.x` are a number, a dot and a name), and `/` is a regex or a division by context (parenthesis kinds, block versus object braces). Where the context cannot be known (`}` then `/`, an arrow function body, `of` / `yield` / `await` used as names, `++` after a line break), every combination of the readings is scanned and every finding is kept. A file with MORE than four such places is refused (`js/ambiguous-slash`): add semicolons or parentheses so that each `/` is unambiguous (`const f = () => {};` instead of a bare `}` before a line that starts with `/`, `of` not used as a variable name before a division).
- **Member access is member access** however it is written: `a.b`, `a?.b`, `a["b"]`, `a?.["b"]`, `(a)["b"]`, and `(f)(x)`, `(0, f)(x)`, `f?.(x)` are calls of `f`.
- **Compound assignment is assignment** (`ctx &&= x`, `ctx ||= x`, `ctx ??= x`), and `ctx` is not shadowed through `catch (ctx)`, a destructuring pattern (`const { ctx } = x`, `[ctx] = x`), an import name, a for-of variable or `ctx++`.
- **Bounded work:** the scan is linear in the size of a file (128 KiB of hostile input takes well under a second).

What this still cannot guarantee: the scan is a best-effort defence, not a proof. It does not follow data flow (`const f = ctx; f.x`, a name assembled at run time), it does not read across the `${}` parts of one template literal (`<scr${""}ipt`), and it cannot see what the code does when it runs. The runtime defences are the real boundary (the core never puts tokens or the network in `ctx`, the safe builder, the strict CSP, the core-owned dialogs and fixed warnings, human approval of the preview); the scan makes sure an honest design cannot reach for the forbidden APIs by accident and a hostile one cannot do it cheaply. The storefront scan (`scripts/check-layers.mjs`) applies the same canonical spelling (comments blanked, Unicode escapes decoded in names and literals) before its regular expressions run. Regression fixtures: `scripts/__fixtures__/escaped-cases.mjs`; seeded property test: `tests/scan-fuzz.test.mjs` in the template repo.

Static scanning is conservative defence in depth, not a sandbox: design views are JavaScript running in the admin
origin. A determined, obfuscated payload could in theory evade the scan; the real controls are (1) the core never
puts tokens or the network in `ctx`, (2) the safe builder `ctx.ui.h`, (3) a strict CSP when serving (README
"部署", section 5), and (4) human approval of the preview. CSS can still change appearance in confusing ways (for
example hiding a non-dialog button): review the preview at both widths before approving.
