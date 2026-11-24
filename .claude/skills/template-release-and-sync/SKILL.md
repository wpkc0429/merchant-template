---
name: template-release-and-sync
description: Human procedure for (1) releasing a new version of the merchant template (changelog, tests, annotated tag vX.Y.Z) and (2) syncing that version into one merchant repo with scripts/sync-core.mjs (the sync source is an annotated TAG only, dry run first, handling the "design-layer action needed" notice, verification, rollback, the emergency --allow-untagged override). Use when a maintainer asks to cut a template release, create a merchant repo with new-merchant.mjs, or update a merchant's locked core. An AI design session must NEVER run sync-core.mjs, new-merchant.mjs or any manifest --update. Not for editing the locked core itself (use core-change), not for design work (storefront-design / admin-design).
---

# Template release and core sync (human procedure)

Decided 2026-11-25 (`docs/DECISIONS.md` D5): merchant repos are created with `scripts/new-merchant.mjs` (the GitHub "Use this template" button is only for finding the template); core syncs are run **by a human, per merchant**; the sync source is an **annotated tag only**. **An AI session never runs any of this.**

## 1. Release a template version (in the template repo, `main`, clean tree)

1. All core changes are committed (process: `.claude/skills/core-change`), manifests re-locked by the maintainer, `template.json` `version` is the new `X.Y.Z`.
2. `docs/CORE-CHANGELOG.md` has a `## vX.Y.Z` section on top, with one `Design-layer action: ...` line per thing a merchant's design layer must do (or `Design-layer action: none`).
3. Run everything:
   ```bash
   node scripts/check-layers.mjs --check
   node scripts/check-content-schema.mjs --lint
   node admin/scripts/check-design.mjs && node admin/scripts/test-guard.mjs
   node tests/run.mjs
   ```
   For a release that changes behaviour, also the throwaway-stack browser tests (`docs/TEMPLATE-NOTES.md` section 5: never the main `ecommerce` database, tunnel or Cloudflare, never `docker compose down -v`).
4. `git status` is clean, then tag the release commit with an **annotated** tag that equals `template.json` `version`:
   ```bash
   git tag -a vX.Y.Z -m "merchant-template X.Y.Z"
   git tag -n1 vX.Y.Z && git cat-file -t vX.Y.Z      # prints: tag  (a lightweight tag prints: commit and is refused by sync-core)
   ```
5. Pushing the tag (`git push origin vX.Y.Z`) is a separate human step, only once a remote exists.

## 2. Create a merchant

```bash
git -C <template checkout> checkout vX.Y.Z
node scripts/new-merchant.mjs ../my-shop --name "My Shop" --slug my-shop [--api-base ...] [--publishable-key ...] [--site-url ...] [--admin-origin ...]
```
Its output lists the next steps, including the human-only content schema registration. The provenance (version, tag, commit) is the first history line in the new repo's `.template-version`.

## 3. Sync a merchant to a release (in the merchant repo, one merchant at a time)

1. The merchant repo's work tree is clean (commit or stash), and you are on a new branch: `git switch -c core/vX.Y.Z`.
2. Check the template out at the TAG, detached, and make sure nothing else is in it:
   ```bash
   git -C <template checkout> checkout vX.Y.Z
   git -C <template checkout> status --short        # must print nothing
   ```
3. **Dry run first**, read it:
   ```bash
   node scripts/sync-core.mjs --from <template checkout> --dry-run
   ```
   It prints `source: tag vX.Y.Z (commit ...)`, then added / changed / removed locked files, then, if the changelog lines or `public-api.json` diffs say so, `!! DESIGN-LAYER ACTION NEEDED !!` (exit 3). It refuses (exit 2) a dirty merchant tree, a version that is not newer, a different template name, a template that fails its own guards, and **a template checkout that is not exactly at the annotated tag** (HEAD not at `vX.Y.Z`, a lightweight tag, a tag that disagrees with `template.json`, uncommitted changes, or a copy without `.git`).
4. Apply:
   ```bash
   node scripts/sync-core.mjs --from <template checkout> --yes                       # exit 0
   node scripts/sync-core.mjs --from <template checkout> --yes --ack-design-actions   # when step 3 listed design-layer actions
   ```
   It copies only `lockedPaths` (never design files, `config.js`, `wrangler.jsonc`, `.gitignore`), merges the hash manifests keeping merchant-owned entries, writes `.template-version` (version on line 1, a `#` history below) and re-verifies with the merchant's own guards (`check-layers --check`, `check-design`, `test-guard`).
5. **Verify**: `git status` / `git diff` shows only locked paths, `template.json`, `.template-version` and the two manifests; design files and `public/config.js` are untouched; re-run `node scripts/check-layers.mjs --check`, `node admin/scripts/check-design.mjs`.
6. **Design-layer actions**: do them in a separate `design/storefront-*` or `design/admin-*` branch through the design skills (a design session may do that; it must not touch the locked files the sync just wrote). Typical v0.2.0 actions: rename the `confirm.<id>.message` copy keys to `.text`; replace the inline `<script>` in `public/index.html` with `<script src="commerce/local-config.js"></script>`; add `public/content.schema.json`. Until then guards print notes / warnings but pass.
7. Commit on the `core/vX.Y.Z` branch (`git commit -am "Sync core to vX.Y.Z"`), open a PR, merge by a human (merging `main` deploys the storefront; branch protection is a GitHub setting, see `docs/TEMPLATE-NOTES.md`). Check the live `content-security-policy` response headers after the deploy.

### If something fails

- `sync-core` exit 1 = verification failed and **every file was restored** (`git status` is clean again). Read the printed guard output. Most often the merchant's design layer breaks a new rule: fix the design layer on a design branch first (or, if the new rule is wrong, fix the template in a new release), then sync again.
- To roll back an applied (uncommitted) sync: `git restore --staged --worktree .` plus `git clean -fd` for the new files, or `git switch -` and delete the `core/vX.Y.Z` branch. After a commit: `git revert` it.
- Never edit the manifests by hand to make a failure go away.

### Emergency override: `--allow-untagged`

Only a human, only when no tag can be cut (for example a broken tag that must be tested before re-tagging). The output is loud (`!!!!!!!! --allow-untagged ...`), `source: UNTAGGED checkout ...` is printed, and the merchant's `.template-version` gets a history line `# <date> sync A -> B from UNTAGGED checkout via --allow-untagged (<reason>; commit <sha>[, dirty])`. Cut a proper tag as soon as possible and sync again from it when possible.

## Rules

- AI sessions: no `sync-core.mjs`, no `new-merchant.mjs`, no `--update`, no tagging, no pushing.
- One merchant at a time; read every dry run; never use `--yes` blind.
- Template-only paths (`tests/`, `docs/TEMPLATE-NOTES.md`, `README.md`, `new-merchant.mjs`, `gen-placeholders.mjs`) are never copied to merchants.
