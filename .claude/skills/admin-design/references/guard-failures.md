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
| `schema/copy` (names `cannot be defined` / `FIXED`) | `copy: "confirm.cancelOrder.warning" ignored: the warning of an irreversible confirmation is FIXED by the core` | delete that key; reword only `title`, `text` and the buttons. (The old `confirm.<id>.message` is not a failure: the guard prints `note (not a failure) ... retired and ignored` telling you to rename it to `.text` and drop the warning part, which the core shows anyway.) |
| `deploy/csp-*` (`csp-missing`, `csp-weak`, `csp-always`, `csp-dockerfile`) | the admin hosting files in `deploy/` lack or weaken the CSP | not a design problem: `deploy/` is core; stop and tell a human |
| `css/hides-dialog` | `a rule on "..." hides or disables a dialog / confirmation control` | do not hide `dialog`, `.dlg*`, `::backdrop`, confirm controls; restyle them instead (this includes the fixed warning, `.dlg__warning` / `[data-testid=confirm-warning]`: colour and weight are fine, hiding or zero size is not) |
| `css/size`, `js/size`, `asset/size`, `asset/type`, `asset/magic`, `asset/svg-active` | size or type limits (JS 128 KiB, asset 512 KiB, 300 files, 4 MiB total; allowed asset types svg png jpg jpeg webp gif ico avif woff2; real content; passive SVG) | shrink, convert, or drop; SVG without scripts, handlers or external references |
| `js/string-concat` | `concatenating string literals is refused` | write the string whole, or use a `copy.js` entry with `{placeholders}` |
| `js/computed-access` | `computed member access with a non-trivial expression is refused` | use a plain identifier, index or string literal (`obj[key]` ok, `ctx.ui["h"+x]` not) |
| `js/banned-string` | `the string "..." names a forbidden API` | do not spell forbidden API names even as strings |
| `js/import` | `import "..." is not allowed: design code may only import other files under design/ by relative path` | `import { x } from "../parts/x.js"` only |
| `js/dynamic-import`, `js/event-handler-string`, `js/event-handler-assignment`, `js/timer-string`, `js/form-action` | dynamic import, string `on*` handlers, `.onclick =`, `setTimeout("code")`, form `action` | pass functions: `h("button", { onclick: fn })` |
| `js/data-not-pure` | `identifier/operator ... is not allowed in a data file` (`copy.js`, `routes.js`) | only literals: `export default { "key": "text" }`; no calls, spreads, templates with `${}` |
| `js/dialog-api` | `"showModal" is not allowed` (also `showPopover`, `requestFullscreen`, `requestPointerLock`, `.show(`, `.close(`) | open dialogs only with `ctx.ui.showDialog({ title, content, actions })`; close one with the `{ close }` argument of an action's `onClick` |
| `js/dialog-element` | `the string "dialog" names the dialog tag` (also `popover`, `inert`, `<dialog` in a template) | do not build a `dialog` element; the core owns every dialog (`ctx.ui.showDialog`). At runtime `h("dialog")` throws and the screen falls back to the built-in one |
| `js/popover-inert` | `"popover" is not allowed` (also `inert`, `popovertarget`) | no popover or inert regions: use a normal element, a card or `ctx.ui.showDialog`. At runtime these attributes make `h()` throw |
| `js/synthetic-input` | `.click is allowed only on a hidden file input ...`, `"dispatchEvent" is not allowed`, `new MouseEvent`, `.submit`, `requestSubmit` | call the function the button calls instead of clicking it; the only `.click()` allowed is on `const f = h("input", { type: "file", ... })` behind an upload button. A core confirmation can never be confirmed by code: only a real user click counts |
| `js/core-ui-selector` | `the string "confirm-yes" refers to a core confirmation control` | do not name the core's confirmation controls (`confirm-yes`, `confirm-warning`, ...); give your own elements other `data-testid` values |
| `js/dom-escape` | `"parentNode" is not allowed` (also `ownerDocument`, `getRootNode`, `firstChild`, `childNodes`, `nextElementSibling`, `getElementById`, `.closest(`), `.querySelector( is allowed only on an element this file created`, `$( queries the whole document` | keep a variable for each element you need and use it; search only inside an element you built (`const card = h(...)`, then `card.querySelector(...)`) or inside `root`; `ctx.ui.$(sel, element)` needs the element; replace `el.closest(".x")` with the variable of that ancestor; replace `list.childNodes.length` with a counter, `el.firstChild` with a variable (`.children` is fine) |
| `js/ctx-shadow` | `a nested function parameter named ctx hides the real one` (also `const ctx`, `ctx = ...`, `ctx =>`) | name it differently (`context`, `c`); only the module's own top-level function takes `ctx` |
| `js/ambiguous-slash` | `more than 4 places where a "/" could start a regex or divide` | add semicolons or parentheses so each `/` is unambiguous (`const f = () => {};` before a line that starts with `/`; do not use `of`, `yield` or `await` as variable names before a division) |
| `js/ctx-unknown` (new forms) | `computed access on ctx.ui is refused`, `Object.values over ctx or one of its namespaces is refused`, `spreading ctx ... is refused` | call `ctx.ui.x` by name; do not enumerate or spread `ctx`, `ctx.ui`, `ctx.actions` |
| `copy/missing` and copy-key check | an unknown key or a key used in views but absent | use known keys from `design-defaults/copy.js`; a brand new key is a core change (it must be added in both copy files) |
| copy warnings (runtime, `[design]` in console) | `uses unknown placeholder(s) {x}; default used` | use only placeholders the default text has (fewer is fine); max 600 characters |
| `ctx/manifest`, core manifest, defaults, layers | the manifest or core files differ | you touched something outside `design/`, or the checkout is damaged: restore it. Never run `--update` |

## Runtime problems the guard cannot see

- Console `[design] ...` warnings: the named entry was refused and the default used. Fix that entry.
- A screen looks like the factory one although you changed the view: the view threw, hung (20 s) or failed to load and the core mounted the built-in. Read the console error.
- Navigation shows fewer items for staff: expected, permissions come from the platform.
- A form refuses to save after you hid a field: you removed a required one (title, slug, SKU code). Put it back.
- A button does nothing: you replaced a core action call with your own handler. Call the `ctx.actions` function.
