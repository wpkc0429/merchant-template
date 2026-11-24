# Admin design workflow details

Complements `SKILL.md`. Sources: `admin/docs/DESIGN-LAYER.md` (sections 7, 8, 10), `admin/docs/AI-EDIT-SERVICE-NOTES.md`, `admin/README.md` (本機執行, 測試), `admin/scripts/check-design.mjs` header.

## Branch and base

```bash
BASE=$(git rev-parse HEAD)            # the commit the edit starts from; the guard diffs against it
git switch -c design/admin-<short-request-name>
```

The guard counts as changed: `git diff --name-only <BASE>` plus untracked, non-ignored files. A stray file anywhere in the repo (a screenshot, a note) fails the scope check, so keep scratch output outside the repository. `config.local.js` is gitignored and not counted.

## The gate

```bash
cd admin
node scripts/check-design.mjs --base "$BASE"           # human report on stderr
node scripts/check-design.mjs --base "$BASE" --json    # machine-readable
node scripts/check-design.mjs --files design/views/x.js design/theme.css   # explicit list, no git needed
cd .. && node scripts/check-scope.mjs admin --base "$BASE"
```

Exit codes: 0 ok, 1 violations (each line names rule, file, line, reason), 2 usage or environment error (nothing judged). The steps it runs: scope, file inventory, JS scan, CSS scan, assets, schema of `copy.js` and `routes.js`, ctx manifest, defaults, copy keys, core hash manifest, layers. The last four are not about your edit; if they fail, you changed something outside `design/` or the checkout is damaged: restore, do not `--update`.

Maintainers only: `node scripts/test-guard.mjs` (the guard's own tests) and `node scripts/check-layers.mjs` (core layering).

## Preview

```bash
cd admin
node scripts/serve.mjs --proxy http://127.0.0.1:<throwaway-api-port>    # http://localhost:3001
```

- Needs an API: a throwaway platform instance (see `admin/README.md` "測試": own database, own Redis DB, never the main database, tunnel or Cloudflare). On localhost, the gitignored `admin/config.local.js` holds `window.ADMIN_CONFIG.apiBase`. The admin origin must be registered with the platform for that shop (`purpose: admin`), which is a platform operator action; ask for it, do not do it.
- Reload after each edit (no build, no cache). Open the browser console: every design problem is a `[design] ...` warning (an entry that was refused, a view that threw and was replaced by the built-in one). A silent fallback to the built-in screen means your view has a bug even though the app still works.
- Check at 390 px (phone, bottom tab bar) and 1280 px (desktop, sidebar). Nothing may scroll horizontally.
- Check as an owner and as a staff member when you touched navigation, a list, or a widget: staff have fewer permissions, so widgets must be absent, not broken, and the shell must not link to screens they cannot open.
- Merchant-facing e2e (`node e2e/run.mjs`, includes `e2e/design.mjs`) is for maintainers on a throwaway stack; do not run it against anything shared. It temporarily rewrites `design/` files; if it is killed, run `git status design` and restore.

## Hand-off report (what to send the merchant or developer)

1. One-paragraph summary in the merchant's terms.
2. Files changed (all under `admin/design/`), with one line each.
3. Guard result (paste the final "design check OK" lines, or the failures you could not fix).
4. How to preview (branch name, commands), and what you looked at (widths, roles).
5. Limits: what you did not do and why (escalations), and the "Known limits" reminder when relevant: the scan is defence in depth, not a sandbox; a human must review the preview.
6. State clearly: not merged, not deployed. Approval is the merchant's; publishing (merge or fast-forward after re-running the gate on the exact commit) is done by a human or by the edit service after an explicit click.

## Escalation template

> I stopped before editing. Your request needs `<new data / new action / behaviour change / outside design/>`. That belongs to the locked core because `<one line: permission, state rule, validation, confirmation, API access>`. Proposal for a developer: `<core/ files, lib/public-api.json entry, docs/DESIGN-LAYER.md update, check-design.mjs --update after review>`. Meanwhile I can `<design-only alternative>`. Nothing has been changed.

## Reset or undo

Everything the agent changed is under `admin/design/`: drop the branch, or `git checkout <initial-commit> -- admin/design/`. A broken view never blocks login (the core falls back to `design-defaults/`), but fix or revert it anyway.

## Template note

In a merchant repo created from the template the same rules apply. Facts that belong to a particular merchant (language of the copy, currency, size options, the featured-category slug) are in that repo's `design/copy.js`, core `lib/`, and platform data, not in this skill: read the repo instead of assuming the template's values.
