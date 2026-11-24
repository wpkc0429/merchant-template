# Notes for the future AI edit service (not built yet)

The service lets a merchant chat with an AI agent that edits **only the admin's design layer**, shows a preview, and
publishes only after the merchant approves. This repo is ready for it; these are the requirements it can rely on and
the things it must do. The agent's own instructions are `docs/DESIGN-LAYER.md` (give it that file verbatim).

## What this repo guarantees

* Everything the agent may change is under `design/`. Everything else is locked and hash-manifested
  (`scripts/core.manifest.json`).
* `node scripts/check-design.mjs --base <ref>` is the single gate. Exit `0` ok, `1` violations (report on stderr, or
  `--json` for a machine-readable report), `2` usage/environment error. No dependencies, Node 18+, runs in seconds.
* A design that is broken at runtime degrades to the built-in screens with a console warning; it cannot block login.
* The agent only sees what `lib/public-api.json` lists; tokens, shop ids and the network are not in its `ctx`.

## Flow

1. **Scoped access.** Give the service a token that can touch **this repo only** (a fine-grained deploy/write token for
   the merchant's repo, nothing else; no access to `ecommerce`, Cloudflare or any secret store). The admin now lives in
   `admin/` of the merchant repo, next to the storefront, so a token cannot separate them: the **scope check is what
   keeps them apart**. An admin session may change only `admin/design/**`, a storefront session only the storefront
   design-layer files; enforce it from the repo root with `node scripts/check-scope.mjs admin --base "$BASE"` (or
   `storefront`). Give each site its own agent session. Pushing `main` deploys the storefront, so the service must
   never push `main` of this repo directly; use branches and review.
2. **Branch per request.** For each merchant request: record `BASE=$(git rev-parse main)`, create `ai/<shop>/<request-id>`
   from it. The agent works in a checkout of that branch with file tools scoped to `design/` (reject writes elsewhere
   up front; the scope check is the backstop).
3. **Gate before any preview, and again before publish.** After each agent turn:
   `node scripts/check-design.mjs --base "$BASE"`. Non-zero: do **not** deploy a preview. Feed the stderr report back to the
   agent (it names rule, file, line) for a bounded number of retries. Reject, do not "fix up", out-of-scope diffs: discard
   the branch state outside `design/` (`git checkout "$BASE" -- . ':!design'` is not enough; simply refuse and ask the agent
   to redo) and tell the merchant nothing was changed.
4. **Preview.** Deploy only the static files of the branch (`index.html app.js config*.js styles.css lib core ui vendor design
   design-defaults`) to a throwaway preview host that is **same-origin with a proxy to the shop's API** (see README "部署"),
   registered as an admin origin for that shop, behind the same Cloudflare Access policy as production. Serve it with the CSP
   below. The merchant previews at phone and desktop width, logged in as themselves.
5. **Approval.** Publishing = merge/fast-forward the branch into `main` (or the deploy branch) **by the service, after an
   explicit merchant click**, after re-running the gate on the exact commit being published. Keep the previous commit so
   "undo" is one revert. Never let the agent push to the production branch.
6. **Audit.** Store per request: merchant, prompt, base and head SHAs, the diff, the guard report, the preview URL, who
   approved and when.

## Strict CSP for every environment that serves the admin

```
default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self';
img-src 'self' data: <image-public-domain>; connect-src 'self' <r2-direct-upload-origin>; frame-ancestors 'none';
base-uri 'none'; form-action 'none'; object-src 'none'
```

With this, a design change that slipped past the scan still cannot send data anywhere except the API origin and the
bucket, cannot run dynamic code (`eval`/`Function` are blocked) and cannot be framed. (`connect-src` must include the R2
direct-upload origin because image upload PUTs there; `img-src` the public image domain.) No inline scripts exist in
the core, so no `'unsafe-inline'` is needed for scripts.

## Budget and limits

* Cap tokens and tool calls per request and per shop per day; cap retries after a guard failure (3 is plenty); cap diff
  size (the guard already caps files: 300 files, 4 MiB, 128 KiB per JS file, 512 KiB per asset).
* Time-box each agent turn; a request that does not pass the gate within the budget is abandoned and the merchant told.
* Run the agent without network access except to the model API and the repo remote.

## Things the service must NOT do

* Run the agent with a token that can reach other repos, the platform API, or production hosting.
* Publish when the gate fails, when the diff touches anything outside `design/`, or without the merchant's approval.
* Run `check-design.mjs --update` (it rewrites the core manifest). Only a human, in a reviewed core change, does that.
* Trust the scan as a sandbox: it is defence in depth (see "Known limits" in `docs/DESIGN-LAYER.md`). Human approval of the
  preview and the CSP are part of the design.

## Optional extras worth building

* Run `e2e/design.mjs`-style smoke checks (log in as owner and staff, open every route, assert no console errors other than
  `[design]` warnings and no horizontal overflow at 390px) against the preview before showing it.
* Surface `[design]` console warnings from the preview to the agent as feedback ("your view `reports` threw, the built-in
  screen is showing instead").
* Offer the merchant a "reset to defaults" button: `git checkout <initial-commit> -- design/`.
