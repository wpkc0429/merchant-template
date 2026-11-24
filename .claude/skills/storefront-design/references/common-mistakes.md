# Common mistakes (storefront)

| Mistake | Why it fails | Do instead |
|---|---|---|
| Calling `fetch` or reading `localStorage` to "just load" something | `check-layers.mjs` fails (`fetch(`, `localStorage`, `/api/v1`); also bypasses the commerce layer | Use a function from `public-api.json`; if none fits, escalate |
| Using `ShopCommerce._internal`, or aliasing then calling a name not in `public-api.json` | guard: "is not in commerce/public-api.json" | Only listed names; bare `Commerce` or bare `SHOP_CONFIG` is also rejected |
| Reading `SHOP_CONFIG.apiBase` / `publishableKey` (even in a comment-free string) | forbidden words anywhere in design code | Not needed in design; the commerce layer owns them |
| Writing prices, product names, categories or images into `app.js` / `content.js` | the platform is the only authority; they drift silently | Render from `state.catalog` |
| Doing price math (tax, discount, shipping) in the design layer | the server prices orders; client numbers are estimates only | Show `Commerce.money(...)` of cart `subtotal()`; after submit show the server's totals |
| Editing only the desktop tree | mobile is a separate tree | Change `desktopPage()` and `mobilePage()` (and their CSS) together |
| New `<input>` without `data-k` | caret and focus jump on redraw | add `data-k` |
| Putting a click handler with `addEventListener` | breaks delegation and redraw | `data-act` plus an `actions` entry |
| Changing `state.route` directly or using `href` that JS intercepts | breaks hash routing and sharing | `go('#/...')` or a real `href="#/..."` |
| Interpolating server or user text without `esc()` | XSS | wrap in `esc()` |
| Hard-coded hex colours in a component | tokens are the contract | `var(--token)` or add a token in `:root` |
| Handling only the "ready" catalogue state in a new screen | loading and error then show an empty page | render all three states, both layouts |
| Renaming a file in `public/assets/` or adding a huge image | filenames are a contract; weight hurts mobile | keep names; follow README image guidance |
| Editing `public/config.js` to put in a key or API URL | locked and hash-protected (in the template it must stay `REPLACE_WITH_*`; in a merchant repo it holds the real values a human wrote) | local values only in gitignored `public/config.local.js`; deployment config is a human change |
| Running `node scripts/check-layers.mjs --update` to "fix" a failure | it rewrites the lock and hides a real violation | never in a design task; only a human after a reviewed commerce change |
| Adding `package.json`, a bundler, a tracking snippet or any external script (swapping the font stylesheet link is fine, see examples) | the site is zero-build and the commerce path must stay clean | escalate; propose a human-reviewed change |
| Leaving screenshots or notes under `public/` | everything in `public/` is published | keep them outside the repo (scratch directory) |
| Committing on `main`, pushing, or asking to push | a push to `main` deploys production | branch only; the merchant or developer decides |
| Treating a passing guard as approval | the guard checks structure, not looks, copy or mobile | still preview at 390 px and 1280 px and wait for approval |
| Removing or reordering the `<script>` tags in `public/index.html` (`config.js`, the localhost-only `config.local.js` loader, `commerce/api.js`, `cart.js`, `checkout.js`, `content.js`, `app.js`) | `index.html` is a design file but this load order is how the layers connect; a missing or late script is a blank site | Edit markup, meta and fonts; leave the script block as is; add no other scripts |
