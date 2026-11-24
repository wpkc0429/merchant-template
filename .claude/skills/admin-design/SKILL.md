---
name: admin-design
description: Operating manual for editing a merchant's ADMIN back-office DESIGN layer (admin/design/**: tokens.css, theme.css, copy.js, routes.js, views/, parts/, assets/) in this build-less admin app, using only the whitelisted ctx in admin/lib/public-api.json. Use when a merchant or developer asks to change the look, wording, layout, navigation, colours, logo or screens of the admin/back office (orders, products, categories, shipping, members, reports, team, login). Includes the branch-edit-check-preview-stop workflow, exact guard commands, common guard failures, and the rule to stop and escalate when a request needs a locked core change or a new ctx function. Not for the public storefront (use storefront-design), not for platform API work, not for onboarding a merchant.
---

# Admin design layer

You change how the back office LOOKS and READS. You cannot change what its buttons DO, who may use them, or how data is fetched: those are in the locked core and reach your code only through `ctx`. The complete operating manual is `admin/docs/DESIGN-LAYER.md` (single source of truth, written to be given to an agent verbatim). Read its sections 1 to 3 completely before editing; this skill is the short operating procedure around it.

All commands below run from `admin/` unless stated. From the repo root the equivalent scope entry is `node scripts/check-scope.mjs admin --base <ref>`.

## What you may edit (only these)

`admin/design/**`: `tokens.css` (CSS variables), `theme.css` (free CSS, loaded last), `copy.js` (all wording, data only, known keys only), `routes.js` (route id to view file, data only), `views/*.js` (one screen per file, `export default function (root, ctx)`), `parts/*.js` (shared pieces), `assets/` (images, icons, woff2 fonts). File limits and allowed types: DESIGN-LAYER.md section 2.

## Locked (never edit)

Everything else under `admin/` (`app.js`, `index.html`, `config*.js`, `styles.css`, `lib/`, `core/`, `ui/`, `vendor/`, `design-defaults/`, `scripts/`, `docs/`, `e2e/`), the storefront (`public/`, root `scripts/`), repo-root files. `lib/public-api.json` and `scripts/core.manifest.json` are core: never touch, never run `check-design.mjs --update`, `scripts/sync-core.mjs` or `scripts/new-merchant.mjs`. `template.json` (`sites.admin.designPaths`) lists exactly what you may edit.

## How to build or change a screen

- Use only `ctx` (names listed in `admin/lib/public-api.json`; semantics in DESIGN-LAYER.md section 4): `ctx.ui` to build DOM (`h(tag, attrs, ...children)` escapes text), `ctx.data` for reads, `ctx.actions` for writes, `ctx.t` / `ctx.can` / `ctx.format` / `ctx.logic` / `ctx.enums` / `ctx.auth` / `ctx.nav`.
- Import only other files under `design/` by relative path. No `fetch`, storage, `window`/`document`, `innerHTML`, `eval`, external URLs (full list in section 6).
- After an `await`, check `ctx.alive()`. Show errors with `ctx.ui.toast(ctx.errorMessage(e, {...}), "error")`.
- Irreversible actions already show the core's confirmation; never build a replacement confirmation, and never hide dialogs with CSS.
- Wording: change entries in `design/copy.js` (known keys only; fewer placeholders allowed, never new ones; max 600 chars). A new wording key is a core change.
- Permissions: a screen you cannot reach for a person is the core's decision; `ctx.can` only decides what to offer.
- Required form fields stay required because the core action validates them. Hiding a required field makes the form unsaveable; do not remove title, slug or SKU fields.

Worked examples (colour change, rename a label, hide a field, reorder nav, restyle, table view, dashboard widget): DESIGN-LAYER.md section 9 and `references/examples.md`.

## Workflow

1. Read the request. Needs a core change or a `ctx` function that does not exist? Go to **Escalate** now.
2. `BASE=$(git rev-parse HEAD)`; branch `design/admin-<short-request-name>` (the `design/admin-` prefix selects the scope check in CI). Never work on `main`.
3. Smallest change first: tokens, then `copy.js`, then `theme.css`, then a view.
4. Run the gate after every meaningful edit (and always before presenting):
   ```bash
   cd admin
   node scripts/check-design.mjs --base "$BASE"      # exit 0 ok / 1 violations / 2 usage error
   cd .. && node scripts/check-scope.mjs admin --base "$BASE"   # same gate plus a repo-wide scope check
   ```
   Fix every reported line, re-run. Without `--base` the scope check is skipped, so use it. Exit 2 means nothing was judged (bad ref, unreadable checkout).
5. Preview (details in `references/workflow.md`): `node scripts/serve.mjs --proxy <throwaway API>` and open `http://localhost:3001`. Look for `[design]` console warnings (a refused entry or a fallback to the built-in screen). Check 390 px and 1280 px, no horizontal scroll, and sign in as an owner and as a staff member when navigation or permissions are involved.
6. **Stop.** Report the changed files, a plain-language summary, the guard output, how to preview, and any limits. Wait for the merchant's approval. You never merge, push, deploy, or open a PR yourself.

## Escalate (say so and stop; never work around)

- A new data field, a new action or any behaviour change (a new button that does something new, a different state rule, different validation, new permission logic): needs a new `ctx` function, which is a core change for a human (`core/`, `lib/public-api.json`, `check-design.mjs --update`, DESIGN-LAYER.md).
- Anything outside `admin/design/**`, a new route or URL, a new dependency or build step, an external script/font/image URL, tracking.
- Showing data the person lacks permission for.
- Anything that would weaken a confirmation, the guard, or the CSP.

Reply: what is needed, why it is core, the smallest proposal for a developer, and what you can do within the design layer now. Template in `references/workflow.md`. Nothing is edited when you escalate.

## Files

- `references/workflow.md` - branch, preview, role checks, hand-off report, escalation template, reset to defaults
- `references/guard-failures.md` - real guard messages and the fix for each
- `references/examples.md` - extra worked examples and escalation cases beyond DESIGN-LAYER.md

Single sources of truth, read them rather than relying on memory: `admin/docs/DESIGN-LAYER.md`, `admin/lib/public-api.json`, `admin/CLAUDE.md`, `admin/README.md`, `admin/docs/AI-EDIT-SERVICE-NOTES.md`, `admin/scripts/check-design.mjs` (header documents flags and exit codes).
