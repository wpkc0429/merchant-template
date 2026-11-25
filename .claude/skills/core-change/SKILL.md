---
name: core-change
description: The human-reviewed process for changing the LOCKED core of the merchant template, in particular adding a function or action to the admin design layer's `ctx` (or a `ShopCommerce` function / `SHOP_CONFIG` key to the storefront), adding an irreversible action with its fixed warning, changing a guard, the CSP files or any other locked path. Use when a design session hit an escalation that needs a locked change, or when a maintainer wants to change `template.json` lockedPaths files. Lists which files must change together (public-api.json, DESIGN-LAYER.md, guard fixtures, copy defaults, manifests), who runs the manifest `--update`, the tests to run, how to bump the version and write CORE-CHANGELOG (including `Design-layer action:` lines). An AI design session must NEVER do this work: it only proposes. Not for ordinary design edits (use storefront-design / admin-design), not for releasing or syncing (use template-release-and-sync).
---

# Core change (human-reviewed)

**An AI design session never performs a core change, never runs a manifest `--update`, never runs `sync-core.mjs` or `new-merchant.mjs`.** If you are in a design session and the request needs anything below, write the proposal (section "Proposing") and stop. Only a human maintainer, working in the TEMPLATE repo on a branch, does the steps in "Doing it". (Decided 2026-11-25, `docs/DECISIONS.md` D4.)

## What counts as a core change

Any change to a path in `template.json` `lockedPaths` (storefront `public/commerce/**`, `public/config.js`, `public/_headers`; admin `lib/ core/ ui/ vendor/ design-defaults/ scripts/ deploy/ docs/ e2e/` and the shell files incl. `styles.css`; `scripts/**` guards; `.github/`, `.claude/`, `CLAUDE.md`, `docs/CORE-CHANGELOG.md`, `docs/DECISIONS.md`). In particular:

- a new or changed admin `ctx` function or action (`ctx.data.*`, `ctx.actions.*`, `ctx.ui.*`, `ctx.logic.*`, ...), a new `ShopCommerce` function or `SHOP_CONFIG` key;
- a new irreversible action (needs a fixed warning, see below), a new copy key, a changed validation or permission rule;
- the CSP files (`public/_headers`, `admin/deploy/*`), the guards, the sync / new-merchant scripts, the workflow.

If the change is only to files in `sites.*.designPaths`, it is NOT a core change: use storefront-design / admin-design.

## Proposing (what an AI session or a developer hands to the maintainer)

State: what the request needs; why the design layer cannot do it; the locked files involved; the smallest design (new `ctx` name and signature, permission node, state rule, validation, error cases, copy keys and default wording, whether it is irreversible); the effect on existing merchants (will their design layer need an action?). Do not edit anything. Template: `.claude/skills/admin-design/references/workflow.md` (escalation) or the storefront-design "Escalate" section.

## Doing it (human maintainer, template repo, on a branch `core/<topic>`)

Never customise per merchant: the core is identical for every merchant.

### Files that must change together

| Change | Files |
| --- | --- |
| New admin `ctx` function / action | implementation in `admin/core/` (`actions.js`, `data.js`, `context.js`) or `admin/lib/`; **`admin/lib/public-api.json`** (the guard proves it equals the real `ctx`); **`admin/docs/DESIGN-LAYER.md`** (section 4 and any worked example); permission and state checks inside the core action, never in a view; guard fixtures **`admin/scripts/__fixtures__/cases.mjs`** and **`admin/scripts/test-guard.mjs`** when a scan rule is involved; `admin/e2e/` coverage (smoke / run / design); the `admin-design` skill references if the surface is described there |
| New copy key | the SAME key in `admin/design/copy.js` and `admin/design-defaults/copy.js` (the two files stay identical); a view that uses it goes in both `admin/design/views|parts` and `admin/design-defaults/` (`cp`) |
| New IRREVERSIBLE action | the action goes through `ask()` in `admin/core/actions.js`; add its id to `WARNED_CONFIRM_IDS` in `admin/lib/design-schema.js`; add its FIXED warning to `admin/core/warnings.js` (module load throws if the two lists disagree); copy keys `confirm.<id>.title`, `.text` (lead-in, may be empty), `.yes` in both copy files, never a `.warning` or `.message`; tests in `admin/scripts/test-guard.mjs` and `tests/decisions.test.mjs` (they enumerate the ids) and the design e2e D7b |
| New content-store capability (v0.3.0 pattern) | `public/commerce/content.js` + `content-allowlist.*` (the allowlist is a byte copy of the platform's `api/internal/cms/richtext/allowlist.json`; update it only by copying and updating the pinned sha256 in `tests/content.test.mjs`), `admin/lib/content.js`, `admin/core/content-actions.js`, `admin/ui/content-form.js`; both `public-api.json` files; fixed warnings for new irreversible content actions; `admin/scripts/test-content.mjs`, `tests/content*.test.mjs` |
| New `ShopCommerce` function / config key | `public/commerce/*.js`; **`public/commerce/public-api.json`** (`check-layers` proves it equals the real exports); `scripts/check-layers.mjs` if a new forbidden pattern is needed; `.claude/skills/storefront-design/references/commerce-api.md`; CLAUDE.md |
| CSP | `public/_headers`, `admin/deploy/nginx.conf.template`, the checks (`checkCsp` in `scripts/check-layers.mjs`, `deployChecks` in `admin/scripts/check-design.mjs`) and their tests; `docs/DECISIONS.md` |
| Any locked file | the hash manifests (below), `docs/CORE-CHANGELOG.md`, `template.json` version |

### Re-locking the manifests (HUMAN ONLY)

First run the guards WITHOUT `--update` and read what they report: every `manifest/changed|added|removed` line must be a file you meant to change.

```bash
node scripts/check-layers.mjs --check          # storefront: lists locked files whose hash differs from scripts/commerce.manifest.json
node admin/scripts/check-design.mjs            # admin: lists manifest/changed lines; everything else must already be green
# only then, as the maintainer (never to "make the guard pass" without reading it):
node scripts/check-layers.mjs --update         # rewrites scripts/commerce.manifest.json
node admin/scripts/check-design.mjs --update   # rewrites admin/scripts/core.manifest.json
git diff --stat scripts/commerce.manifest.json admin/scripts/core.manifest.json   # review: only the intended files' hashes moved
```

### Tests (all must pass)

```bash
node scripts/check-layers.mjs --check && node scripts/check-content-schema.mjs --lint
node admin/scripts/check-design.mjs && node admin/scripts/test-guard.mjs
node tests/run.mjs                              # new-merchant, sync-core, import-catalog, workflow, decisions
```

When behaviour or screens changed also run the browser suites on a THROWAWAY stack (`docs/TEMPLATE-NOTES.md` section 5; never the main `ecommerce` database, the tunnel or Cloudflare; never `docker compose down -v`): `tests/e2e/storefront.mjs`, and from `admin/` `e2e/smoke.mjs`, `e2e/design.mjs` (and the 40+ minute `e2e/run.mjs` for core behaviour changes).

### Version and changelog

1. Bump `template.json` `version` (new capability: minor; fix: patch; breaking for design layers: minor or major, your call, but say so).
2. `docs/CORE-CHANGELOG.md`: new `## vX.Y.Z` section on top. **Add one `Design-layer action: <what a merchant's design layer must do>` line per thing that can break or should be adopted** (a renamed or removed copy key, a new required file, a removed or new `ctx` name, an `index.html` rule). `sync-core` turns these lines into a blocking notice that needs `--ack-design-actions`; additions or removals in the two `public-api.json` files are detected automatically. Write `Design-layer action: none` when nothing is needed. One line per action (the parser reads single lines).
3. Record a new standing decision in `docs/DECISIONS.md` (date, "decided by the user" or by whom).
4. Commit (logical commits; the manifests in the same commit as the files they lock), then release with `.claude/skills/template-release-and-sync` (annotated tag).

## Never

- Run `--update` to silence a guard you have not read; edit `lockedPaths` to unlock something; edit a design layer inside a core change to hide a failure.
- Let an AI session, CI, a hook or the AI edit service run any of this.
- Weaken a confirmation warning, the CSP or a guard "temporarily".
