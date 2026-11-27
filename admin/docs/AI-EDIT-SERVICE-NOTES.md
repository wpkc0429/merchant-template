# Notes for the future AI edit service (not built yet)

The service lets a merchant chat with an AI agent that edits **only the admin's design layer**, shows a preview, and
publishes only after the merchant approves. This repo is ready for it; these are the requirements it can rely on and
the things it must do. The agent's own instructions are `docs/DESIGN-LAYER.md` (give it that file verbatim).

## What this repo guarantees

* Everything the agent may change is under `design/` (admin sessions) or the storefront design paths (storefront sessions, never in the same session). Everything else is locked and hash-manifested
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

## Strict CSP for every environment that serves the admin: REQUIRED, NOT OPTIONAL

**Decided by the user on 2026-11-25 (`../../docs/DECISIONS.md` D1): the strict CSP below is a deployment requirement for production AND for every AI-edit preview environment.** A preview that is served without it must not be shown to a merchant, and the service must not publish a preview it has not served under the CSP. `deploy/nginx.conf.template` has it on by default (no switch), `deploy/Dockerfile` installs it, and `scripts/check-design.mjs` fails when either is missing it. The storefront equivalent is `public/_headers`. A preview host that is not built from `deploy/` must reproduce the policy exactly (it may add its own preview and API origins to `connect-src` / `img-src`, never `unsafe-inline` / `unsafe-eval` for scripts).

```
default-src 'self'; script-src 'self' 'sha256-<hash of the import map text in index.html, decision D19>'; style-src 'self'; font-src 'self';
img-src 'self' data: <image-public-domain>; connect-src 'self' <r2-direct-upload-origin>; frame-ancestors 'none';
base-uri 'none'; form-action 'none'; object-src 'none'
```

With this, a design change that slipped past the scan still cannot send data anywhere except the API origin and the
bucket, cannot run dynamic code (`eval`/`Function` are blocked) and cannot be framed. (`connect-src` must include the R2
direct-upload origin because image upload PUTs there; `img-src` the public image domain.) No inline scripts exist in
the core, so no `'unsafe-inline'` is needed for scripts.

## Preview hosts (version previews and change previews): read-only, noindex, banner

A preview host is the same image with `ADMIN_PREVIEW_MODE=version|change` (and optionally `ADMIN_PREVIEW_TAG`, `ADMIN_PREVIEW_EXPIRES`, an RFC 3339 UTC time); `deploy/preview-config.sh` writes `/preview-config.js` and the container refuses bad values. The platform reports `read_only: true` on every version preview and `preview_read_only: true` on requests: the service MUST deploy previews with this mode. Then the core (not the design layer) disables every write-capable `ctx.actions` function, refuses every non-GET API request and shows its own banner (preview kind, tag, expiry) that the design layer cannot remove. The preview is served with the same strict CSP, `X-Frame-Options: DENY` / `frame-ancestors 'none'` and `X-Robots-Tag: noindex, nofollow` as production (nginx.conf.template sets them on every response). A preview host that is not started with the mode is NOT read-only: do not serve one to a merchant. Since D18 the platform also enforces read-only on the server for the preview ORIGIN (registered by the platform operator in `ADMIN_PREVIEW_ORIGINS`, a different origin from the normal admin): the preview host logs in against its own origin and gets a `scope: "preview_ro"` session of at most 30 minutes; a session without that scope is dropped by the core, a 403 `preview_read_only` shows a calm message, and the client flags are user experience only. See DESIGN-LAYER.md "Preview hosts: what the operator sets".

## Budget and limits

* Cap tokens and tool calls per request and per shop per day; cap retries after a guard failure (3 is plenty); cap diff
  size (the guard already caps files: 300 files, 4 MiB, 128 KiB per JS file, 512 KiB per asset).
* Time-box each agent turn; a request that does not pass the gate within the budget is abandoned and the merchant told.
* Run the agent without network access except to the model API and the repo remote.

## Things the service must NOT do

* Run the agent with a token that can reach other repos, the platform API, or production hosting.
* Publish when the gate fails, when the diff touches anything outside `design/`, or without the merchant's approval.
* Run `check-design.mjs --update` (it rewrites the core manifest). Only a human, in a reviewed core change (`.claude/skills/core-change`), does that. The same goes for adding anything to `ctx`: that is a human-reviewed core change.
* Serve a preview (or any host that serves the admin) without the SAME strict CSP including the `'sha256-...'` of the import map, the `/deny/` 404 and the encoded-slash and double-slash refusal of `deploy/nginx.conf.template` (decision D19): use the same image. Without them the core's start-up canary turns the custom design OFF (the preview then shows the built-in screens and a note): safe, but the preview is not showing the agent's work. The agent must not edit `index.html` (the import map), `lib/` or `deploy/`; after a map change a human runs `check-design.mjs --update`.
* Serve a preview without the strict CSP, or let the agent change `deploy/`, `public/_headers`, `core/warnings.js` or `styles.css`.
* Register the storefront's content schema (`public/content.schema.json`) on the platform, or hold credentials that could: registration is a human step.
* Trust the scan as a sandbox: it is defence in depth (see "Known limits" in `docs/DESIGN-LAYER.md`). Human approval of the
  preview and the CSP are part of the design.

## Optional extras worth building

* Run `e2e/design.mjs`-style smoke checks (log in as owner and staff, open every route, assert no console errors other than
  `[design]` warnings and no horizontal overflow at 390px) against the preview before showing it.
* Surface `[design]` console warnings from the preview to the agent as feedback ("your view `reports` threw, the built-in
  screen is showing instead").
* Offer the merchant a "reset to defaults" button: `git checkout <initial-commit> -- design/`.
