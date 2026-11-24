# Guard failures and fixes

Format of a violation line: `x [rule] file:line  reason`. The rules below are the ids emitted by `admin/scripts/check-design.mjs` (`lib/design-scan.mjs`, `lib/ctx-surface.mjs`); the first five messages were reproduced by running the guard on deliberately bad files in a scratch copy. If a message differs from this table, trust the message. Never fix by editing the scanner, `lib/public-api.json`, or the manifest.

| Rule | Real message (shortened) | Fix |
|---|---|---|
| `scope/outside-design` | a changed file is not under `admin/design/` (also from `check-scope.mjs`: `SCOPE CHECK FAILED (admin)`) | revert that file (`git checkout <BASE> -- <file>`); remove stray untracked files. If the request really needs that file, escalate |
| `js/forbidden-identifier` | `"fetch" is not allowed in design code` (same for `innerHTML`, `document`, `window`, `localStorage`, `eval`, `setAttribute`, `createElement`, ...) | use `ctx.data` / `ctx.actions` / `ctx.ui.h`; if there is no ctx function for it, escalate |
| `js/html-or-url-in-string` | `a string contains markup, a script scheme or an external URL` | no `<tags>`, `javascript:` or `https://` inside strings; build DOM with `ctx.ui.h`; images from `ctx.asset("name.svg")` |
| `js/ctx-unknown` | `ctx.data.nonexistent is not in lib/public-api.json` | use only listed names; a missing one is a core change: escalate |
| `css/url` | `url(https://...) must be a file under design/assets/ (or a data:image URI)` | add the file under `design/assets/` and reference `url(assets/x.svg)` |
| `css/import`, `css/expression`, `css/behavior`, `css/escape`, `css/markup` | forbidden CSS constructs | remove `@import`, `expression()`, `behavior:`/`-moz-binding`, escapes outside strings |
| `css/hides-dialog` | `a rule on "..." hides or disables a dialog / confirmation control` | do not hide `dialog`, `.dlg*`, `::backdrop`, confirm controls; restyle them instead |
| `css/size`, `js/size`, `asset/size`, `asset/type`, `asset/magic`, `asset/svg-active` | size or type limits (JS 128 KiB, asset 512 KiB, 300 files, 4 MiB total; allowed asset types svg png jpg jpeg webp gif ico avif woff2; real content; passive SVG) | shrink, convert, or drop; SVG without scripts, handlers or external references |
| `js/string-concat` | `concatenating string literals is refused` | write the string whole, or use a `copy.js` entry with `{placeholders}` |
| `js/computed-access` | `computed member access with a non-trivial expression is refused` | use a plain identifier, index or string literal (`obj[key]` ok, `ctx.ui["h"+x]` not) |
| `js/banned-string` | `the string "..." names a forbidden API` | do not spell forbidden API names even as strings |
| `js/import` | `import "..." is not allowed: design code may only import other files under design/ by relative path` | `import { x } from "../parts/x.js"` only |
| `js/dynamic-import`, `js/event-handler-string`, `js/event-handler-assignment`, `js/timer-string`, `js/form-action` | dynamic import, string `on*` handlers, `.onclick =`, `setTimeout("code")`, form `action` | pass functions: `h("button", { onclick: fn })` |
| `js/data-not-pure` | `identifier/operator ... is not allowed in a data file` (`copy.js`, `routes.js`) | only literals: `export default { "key": "text" }`; no calls, spreads, templates with `${}` |
| `copy/missing` and copy-key check | an unknown key or a key used in views but absent | use known keys from `design-defaults/copy.js`; a brand new key is a core change (it must be added in both copy files) |
| copy warnings (runtime, `[design]` in console) | `uses unknown placeholder(s) {x}; default used` | use only placeholders the default text has (fewer is fine); max 600 characters |
| `ctx/manifest`, core manifest, defaults, layers | the manifest or core files differ | you touched something outside `design/`, or the checkout is damaged: restore it. Never run `--update` |

## Runtime problems the guard cannot see

- Console `[design] ...` warnings: the named entry was refused and the default used. Fix that entry.
- A screen looks like the factory one although you changed the view: the view threw, hung (20 s) or failed to load and the core mounted the built-in. Read the console error.
- Navigation shows fewer items for staff: expected, permissions come from the platform.
- A form refuses to save after you hid a field: you removed a required one (title, slug, SKU code). Put it back.
- A button does nothing: you replaced a core action call with your own handler. Call the `ctx.actions` function.
