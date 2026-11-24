# Extra examples (admin)

The main worked examples (pink theme, rename a label, hide the subtitle field, reorder navigation, restyle everything, orders as a table, reorder form sections, dashboard widget) are in `admin/docs/DESIGN-LAYER.md` section 9: use them as the pattern. This file adds cases that come up and the escalations.

## Doable in the design layer

1. **Change the login screen** (`views/login.js` and `parts/auth-parts.js`, wording in `copy.js` keys `login.*`): rearrange, add the shop logo as `design/assets/logo.svg` shown with `h("img", { src: ctx.asset("logo.svg"), alt: "" })`. Keep calling `ctx.auth.login(email, password)` and show failures with `ctx.auth.loginMessage(err)`. Keep the lockout message path (a 429 is not a wrong password). The set-password and accept-invite screens work the same way via `ctx.auth.passwordSetup.*` and `ctx.auth.invitation.*`; the link token never reaches your code.
2. **Soften or reword a confirmation** (`confirm.*` keys): you own the wording, the core owns the step. Keep irreversible warnings truthful (do not delete "無法復原" from a message about something that cannot be undone). Never hide the dialog with CSS.
3. **Bigger text for staff** (more readable orders): `theme.css` / `tokens.css` only. There is no documented per-role CSS hook; to differ by role, branch on `ctx.can(...)` inside a view and only for presentation.
4. **Different home page content**: compose `home.js` from existing `ctx.data` calls (`productCount`, `deliveriesOn`, `unshippedPaidCount`, `lowStockSkus`, reports) guarded by `ctx.can`. A widget whose data function refuses (no permission) must simply be absent.
5. **Another language for labels**: edit the values in `copy.js` (keys stay). Limits to tell the merchant: error and refusal messages produced by the core are already localized in Traditional Chinese and cannot be changed from the design layer; dates are Asia/Taipei calendar days; money is TWD whole dollars (`ctx.format.money`); text hard-coded inside a view is yours to change in that view.
6. **Rearrange the product form** or hide an optional field: keep the controls the action reads (see DESIGN-LAYER.md "Hide the English subtitle field": hide the line, keep the input). Never drop title, slug, SKU code fields.

## Must escalate (stop; nothing is edited)

| Request | Why it is core | What to propose |
|---|---|---|
| "Export orders to CSV / print labels" | needs a file download and DOM/Blob APIs that are forbidden, plus possibly a new data function | a `ctx.actions` export function in `core/` with its own permission check (human change) |
| "Let staff ship unpaid orders" / "allow cancelling paid orders" | state rules (`shipBlocker`, cancel conditions) are core logic; the API is the authority | decide with the platform operator; core change only if the platform allows it |
| "Remove the confirmation when cancelling" | confirmations of irreversible actions are core | refuse; offer reworded confirmation text |
| "Bulk edit prices / bulk upload products" | no such action in `ctx.actions` | new core action(s) with SKU-safety tests |
| "Show customer email/phone on the home page" or "show a report to staff" | data functions check permissions in the core; staff lack the nodes | the platform role change is the operator's decision, not a design edit |
| "Add a new page /help or change URLs" | routes and permission nodes are fixed in `core/routes.js` | core change |
| "Add analytics, chat widget, an external font or image URL" | external URLs and scripts are forbidden; CSP blocks them | human-reviewed core change and CSP update |
| "Change how login works / session length / remember me" | auth and tokens are core | core change |
| "Change money to another currency or decimals" | `ctx.format.money` is core, prices are whole TWD | core change |
| "Add a field the platform does not return" | not in `ctx.data` results | platform API change first, then core |

Use the escalation template in `references/workflow.md`.
