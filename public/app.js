/* ============================================================
   Default merchant storefront (neutral template design).
   Zero-build vanilla JS. State -> HTML string -> #app, with
   event delegation. No dependencies.

   DESIGN LAYER. Views and state only. Everything that talks to the
   platform API (catalogue fetch, cart store, checkout, payment redirect)
   lives in the locked layer public/commerce/** and is reached ONLY through
   window.ShopCommerce (documented in commerce/public-api.json; enforced by
   scripts/check-layers.mjs). Static copy lives in content.js; deployment
   settings (API base URL, publishable key) in config.js / config.local.js.

   PLATFORM CONTENT (v0.3.0): the shop's editable copy is read at runtime from the platform content store through
   ShopCommerce.content (documents global, home, story, faq, product-info; see content.schema.json). content.js stays the
   DEFAULT copy: a field with no published platform value renders the content.js value. First paint waits at most
   CONTENT_BUDGET_MS for the content request (a repeat visit within 5 minutes has it from the session cache at once), so
   there is normally no flash of the defaults; a slow network renders the defaults and swaps when the content arrives.
   Content values only ever enter the page through esc() (text), never as HTML.

   Product/SKU/shipping/category/image data comes from the `ecommerce`
   platform's public storefront API at runtime — a network dependency, not a
   build dependency; the site ships as-is with no bundler and no package.json.
   ============================================================ */
(function () {
  'use strict';

  /* ---------- Layers ---------- */

  var Commerce = window.ShopCommerce;   // locked commerce layer (public/commerce/)
  var DEFAULTS = window.SHOP_CONTENT;   // default copy and design constants (content.js)
  var CONTENT = DEFAULTS;               // what the views read: the defaults overlaid with published platform content
  // Shop-level switches from config.js. (The API endpoint settings are never read here.)
  var SHOP_SETTINGS = {
    showPrices: window.SHOP_CONFIG.showPrices !== false,
    featuredCategory: window.SHOP_CONFIG.featuredCategory || 'new-arrivals'
  };
  var CONFIG = { accent: CONTENT.accent, showPrices: SHOP_SETTINGS.showPrices };

  // Below this the phone layout takes over, full-bleed. This is the only thing
  // that decides the layout — visitors cannot pin one.
  // Kept under tablet-portrait width so iPads get the web layout, not a
  // stretched phone app.
  var MOBILE_BP = 720;

  /* ---------- Display logic ---------- */

  // The template assumes the variant option key is `size` (S / M / L). Each
  // size is a literal platform SKU with an absolute price (SKU.options.size +
  // SKU.price_amount). This list only drives display order and labels;
  // productSizeKeys()/skuFor() derive what actually exists per-product from
  // the SKUs the API returns. Any other value of options.size (e.g. "Free",
  // "XL", "500ml") is still listed, after S/M/L, labelled with the raw value.
  // See docs/TEMPLATE-NOTES.md, known limitations.
  var SIZE_ORDER = ['S', 'M', 'L'];
  var SIZE_LABELS = { S: 'S · 小', M: 'M · 標準', L: 'L · 加大' };

  var SORTS = CONTENT.sorts;

  var TABS = [
    { k: 'home', icon: '⌂', label: '首頁', href: '#/' },
    { k: 'shop', icon: '⌕', label: '探索', href: '#/shop' },
    { k: 'fav', icon: '♡', label: '收藏', href: '#/favourites' },
    { k: 'me', icon: '☺', label: '我的', href: '#/account' }
  ];

  /* ---------- State ---------- */

  var state = {
    route: 'home',
    cat: '',   // category slug; '' = all
    pslug: '',
    mode: window.innerWidth < MOBILE_BP ? 'mobile' : 'desktop',
    sort: '推薦',
    cartOpen: false,
    fav: [],
    qty: 1,
    size: 'M',
    pImg: 0,
    msg: '',
    faq: null,
    pinfo: null,
    step: 0,
    ship: null,
    done: false,
    toast: '',
    searchOpen: false,
    q: '',
    email: '',
    emailMsg: '',
    emailOk: false,
    form: { email: '', name: '', phone: '', addr: '', date: '' },
    errors: {},
    // status: idle | pending | redirecting | error. `key` doubles as the
    // Idempotency-Key sent with guest checkout AND as the test for whether
    // an in-flight response still belongs to the current checkout attempt
    // (see handleCheckoutResponse). `order` holds the server's authoritative
    // amounts once an order exists, for the confirmation screen.
    // `paymentIssue`: '' | 'no-token' | 'init-failed' — see initiatePayment().
    submit: { status: 'idle', key: '', error: '', order: null, paymentIssue: '' },
    // Catalog: products + shipping methods sourced from the platform API.
    // status: idle | loading | ready | error. Fetched once at boot — see
    // loadCatalog().
    catalog: { status: 'idle', products: [], shippingMethods: [], categories: [], featuredSlugs: [], error: '' },
    // Populated by loadOrderStatus() for the #/order-status route.
    orderStatus: { status: 'idle', order: null, error: '' }
  };

  /* ---------- Helpers ---------- */

  var app = document.getElementById('app');
  var toastTimer = null;

  // Multi-line text (title fields): escape, then turn each newline into <br>. Never insert content as raw HTML.
  function lines(s) {
    return esc(s).replace(/\r?\n/g, '<br>');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  var money = Commerce.money;

  /* ---------- Platform content (ShopCommerce.content) over the defaults ---------- */

  // Content document key -> what it feeds. Keys are the ones declared in content.schema.json "documents".
  var CONTENT_KEYS = ['global', 'home', 'story', 'faq', 'product-info'];
  var CONTENT_BUDGET_MS = 600;     // longest first paint waits for the content request
  var booted = false;              // render() does nothing before the first paint decision

  function str(v, d) { return typeof v === 'string' ? v : d; }
  function sub(src, def, keys) {
    var o = {};
    keys.forEach(function (k) { o[k] = str(src && src[k], def[k]); });
    return o;
  }
  function pairs(src, d) {
    if (!src || !Array.isArray(src.items)) return d;
    return src.items.filter(function (x) { return x && typeof x.q === 'string' && typeof x.a === 'string'; })
      .map(function (x) { return { q: x.q, a: x.a }; });
  }

  // CONTENT = DEFAULTS with every published platform field laid over it. A document that is not published (or whose
  // field is missing or of the wrong type) leaves the content.js default in place. Pure function of the two inputs.
  function buildPlatformContent() {
    var g = Commerce.content.get('global'), h = Commerce.content.get('home'), st = Commerce.content.get('story');
    var D = DEFAULTS;
    var next = {};
    Object.keys(D).forEach(function (k) { next[k] = D[k]; });
    if (g) {
      next.accent = /^#[0-9a-fA-F]{6}$/.test(g.accent || '') ? g.accent : D.accent;
      next.brand = sub(g.brand, D.brand, ['name', 'footer']);
      next.searchPlaceholder = str(g.searchPlaceholder, D.searchPlaceholder);
      next.noteLabel = str(g.noteLabel, D.noteLabel);
      next.featuredTitle = str(g.featuredTitle, D.featuredTitle);
      next.instagram = sub(g.instagram, D.instagram, ['handle']);
      next.store = sub(g.store, D.store, ['name', 'address', 'addressShort', 'hours', 'hoursShort', 'tel']);
      next.newsletter = sub(g.newsletter, D.newsletter, ['title', 'success']);
      next.promo = sub(g.promo, D.promo, ['title', 'sub', 'cta']);
    }
    if (h) {
      next.hero = sub(h.hero, D.hero, ['eyebrow', 'title', 'lede']);
      next.storyTeaser = sub(h.storyTeaser, D.storyTeaser, ['eyebrow', 'title', 'lede']);
    }
    if (st) {
      var o = sub(st, D.story, ['eyebrow', 'title']);
      o.paragraphs = Array.isArray(st.paragraphs) ? st.paragraphs.filter(function (t) { return typeof t === 'string'; }) : D.story.paragraphs;
      next.story = o;
    }
    next.faq = pairs(Commerce.content.get('faq'), D.faq);
    next.pinfo = pairs(Commerce.content.get('product-info'), D.pinfo);
    return next;
  }
  // Malformed platform content must never blank the page: any failure while overlaying keeps the shipped defaults.
  function applyPlatformContent() {
    try {
      var next = buildPlatformContent();
      document.documentElement.style.setProperty('--accent', next.accent);
      CONTENT = next;
    } catch (e) {
      CONTENT = DEFAULTS;
      try { document.documentElement.style.setProperty('--accent', DEFAULTS.accent); } catch (e2) { /* nothing more to do */ }
    }
  }

  // Product images are API URLs (CSS background). A URL that fails to load
  // simply leaves the `--placeholder` colour the stylesheet already paints
  // behind every media box, so a broken or missing image is a neutral tile.
  function imgCss(url) {
    if (!url) return '';
    var safe = encodeURI(url).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
    return 'background-image:url(' + esc(safe) + ')';
  }

  function find(arr, fn) {
    for (var i = 0; i < arr.length; i++) if (fn(arr[i])) return arr[i];
    return null;
  }

  function cls() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) if (arguments[i]) out.push(arguments[i]);
    return out.join(' ');
  }

  function shopHref(cat) {
    return cat ? '#/shop/' + encodeURIComponent(cat) : '#/shop';
  }

  function flash(text) {
    clearTimeout(toastTimer);
    state.toast = text;
    render();
    toastTimer = setTimeout(function () { state.toast = ''; render(); }, 2200);
  }

  /* ---------- Catalog (products / SKUs / categories / shipping methods) ---------- */

  // The fetching itself is the commerce layer's job (Commerce.loadCatalog).
  function loadCatalog() {
    state.catalog.status = 'loading';
    Commerce.loadCatalog().then(function (r) {
      if (r.ok) {
        state.catalog.products = r.products;
        state.catalog.shippingMethods = r.shippingMethods;
        state.catalog.categories = r.categories;
        state.catalog.featuredSlugs = r.featuredSlugs;
        state.catalog.status = 'ready';
        state.catalog.error = '';
        if (state.ship == null && state.catalog.shippingMethods.length) {
          state.ship = state.catalog.shippingMethods[0].id;
        }
        // Drop cart lines that don't belong to this catalogue (stale / other shop / sold out).
        var rc = Commerce.cart.reconcile(r.products);
        if (rc.soldOut) { flash('購物袋中有商品已售完，已為你移除'); return; }
      } else {
        state.catalog.status = 'error';
        state.catalog.error = r.error;
      }
      render();
    });
  }

  // Shared loading/error partial for every catalog-reading view, in both
  // the desktop and mobile trees — reuses the existing empty-state CSS
  // (no new stylesheet surface needed). Only called when status !== 'ready'.
  function catalogStatusBlock(mobile) {
    var boxClass = mobile ? 'm-empty' : 'empty-state';
    if (state.catalog.status === 'error') {
      return '<div class="' + boxClass + '">' + esc(state.catalog.error || '商品載入失敗，請稍後再試。') +
        '<br><a class="rule-link" style="margin-top:16px" href="#" data-act="retryCatalog">重新載入</a></div>';
    }
    return '<div class="' + boxClass + '">商品載入中…</div>';
  }

  function productBySlug(slug) {
    return find(state.catalog.products, function (p) { return p.slug === slug; });
  }

  // ---- images: product.images[] -> urls.thumb (lists) / urls.large (detail, hero)
  function productImages(p) { return (p && p.images) || []; }
  function imgUrl(im, variant) { return im && im.urls ? (im.urls[variant] || null) : null; }
  function thumbOf(p) { return imgUrl(productImages(p)[0], 'thumb'); }
  function largeOf(p) { return imgUrl(productImages(p)[0], 'large'); }

  // ---- categories: tree from GET /shop/categories, membership from product.categories
  function findCat(nodes, slug) {
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].slug === slug) return nodes[i];
      var hit = findCat(nodes[i].children || [], slug);
      if (hit) return hit;
    }
    return null;
  }

  function catSlugs(node, out) {
    out = out || [];
    out.push(node.slug);
    (node.children || []).forEach(function (c) { catSlugs(c, out); });
    return out;
  }

  // Products in a category or any of its subcategories, in catalogue order.
  function productsInCat(slug) {
    var node = findCat(state.catalog.categories, slug);
    var set = node ? catSlugs(node) : [slug];
    return state.catalog.products.filter(function (p) {
      return (p.categories || []).some(function (c) { return set.indexOf(c.slug) >= 0; });
    });
  }

  function catName(slug) {
    var node = findCat(state.catalog.categories, slug);
    return node ? node.name : '';
  }

  // Top-level categories worth showing: the featured category is a home-page
  // block, not a shelf, and empty categories are hidden.
  function shopCategories() {
    if (state.catalog.status !== 'ready') return [];
    return state.catalog.categories.filter(function (c) {
      return c.slug !== SHOP_SETTINGS.featuredCategory && productsInCat(c.slug).length > 0;
    });
  }

  function primaryCatName(p) {
    var c = find((p && p.categories) || [], function (x) { return x.slug !== SHOP_SETTINGS.featuredCategory; });
    return c ? c.name : '';
  }

  function chipCats() {
    return [{ slug: '', name: '全部' }].concat(shopCategories());
  }

  function catTitle() {
    return state.cat ? (catName(state.cat) || '…') : '全部';
  }

  function navItems() {
    return shopCategories().map(function (c) { return { label: c.name, cat: c.slug }; }).concat(CONTENT.navPages);
  }

  // Home "本季新品": the featured category (server order); first 3 products if it is empty.
  function featuredProducts() {
    if (state.catalog.status !== 'ready') return [];
    var picked = state.catalog.featuredSlugs.map(productBySlug).filter(Boolean);
    return (picked.length ? picked : state.catalog.products).slice(0, 3);
  }

  // Hero and Instagram-style grid are picked from products that have images.
  function imagePool() {
    if (state.catalog.status !== 'ready') return [];
    return state.catalog.products.filter(function (p) { return productImages(p).length > 0; });
  }
  function heroPicks() { var pool = imagePool(); return [pool[0] || null, pool[1] || pool[0] || null]; }
  function gridPicks() { var pool = imagePool(); return (pool.length >= 6 ? pool.slice(2, 6) : pool.slice(0, 4)); }

  function productHref(p) { return p ? '#/product/' + encodeURIComponent(p.slug) : '#/shop'; }

  // Sizes present on a given product, in the S/M/L display order first, derived
  // from the SKUs the API actually returned (never assumes S/M/L all exist).
  function productSizeKeys(p) {
    var present = {};
    ((p && p.skus) || []).forEach(function (sku) {
      if (sku.options && sku.options.size) present[sku.options.size] = true;
    });
    var keys = SIZE_ORDER.filter(function (k) { return present[k]; });
    Object.keys(present).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); });
    return keys;
  }

  function sizeLabel(k) { return SIZE_LABELS[k] || k; }

  function skuFor(p, sizeKey) {
    return find((p && p.skus) || [], function (s) { return s.options && s.options.size === sizeKey; });
  }

  function sizeSellable(p, k) { return Commerce.isSkuSellable(skuFor(p, k)); }

  function anySellable(p) {
    return ((p && p.skus) || []).some(function (s) { return Commerce.isSkuSellable(s); });
  }

  function firstSellableSize(p) {
    var keys = productSizeKeys(p);
    for (var i = 0; i < keys.length; i++) if (sizeSellable(p, keys[i])) return keys[i];
    return null;
  }

  // Chosen size, falling back to the first size that exists, then to a size
  // that can actually be bought (sold-out sizes are disabled in the UI).
  function pickSize(p) {
    var keys = productSizeKeys(p);
    var cand = keys.indexOf(state.size) >= 0 ? state.size : (keys[0] || state.size);
    if (keys.length && !sizeSellable(p, cand)) return firstSellableSize(p) || cand;
    return cand;
  }

  function cardPrice(p) {
    var sku = skuFor(p, 'M') || ((p && p.skus && p.skus[0]) || null);
    return sku ? sku.price_amount : null;
  }

  function priceOf(p) {
    if (!CONFIG.showPrices) return '—';
    var amt = cardPrice(p);
    return amt == null ? '—' : money(amt);
  }

  /* ---------- Derived values ---------- */

  function cartCount() { return Commerce.cart.count(); }

  function searchMatches() {
    if (!state.q) return [];
    var q = state.q, lq = q.toLowerCase();
    return state.catalog.products.filter(function (p) {
      return p.title.indexOf(q) >= 0 ||
             (p.subtitle && p.subtitle.toLowerCase().indexOf(lq) >= 0) ||
             (p.categories || []).some(function (c) { return c.name.indexOf(q) >= 0; });
    });
  }

  function visibleList() {
    var list;
    if (state.q) list = searchMatches();
    else if (!state.cat) list = state.catalog.products.slice();
    else list = productsInCat(state.cat);

    if (state.sort === '價格低→高') list = list.slice().sort(function (a, b) { return (cardPrice(a) || 0) - (cardPrice(b) || 0); });
    if (state.sort === '價格高→低') list = list.slice().sort(function (a, b) { return (cardPrice(b) || 0) - (cardPrice(a) || 0); });
    return list;
  }

  // Cart lines are self-contained snapshots owned by the commerce layer
  // (Commerce.cart): rendering the cart never depends on the catalogue.
  function cartLines() {
    return Commerce.cart.lines().map(function (l) {
      return {
        key: l.key,
        name: l.name,
        img: l.img,
        qty: l.qty,
        meta: sizeLabel(l.size) + ' · ' + money(l.unitPrice),
        lineText: money(l.unitPrice * l.qty)
      };
    });
  }

  function subtotal() { return Commerce.cart.subtotal(); }

  function shipObj() {
    if (state.ship == null) return null;
    return find(state.catalog.shippingMethods, function (s) { return s.id === state.ship; });
  }

  function shipFee() {
    if (Commerce.cart.isEmpty()) return 0;
    var s = shipObj();
    return s ? s.flat_rate : 0;
  }

  /* ---------- Routing ---------- */

  // Entering checkout always starts a new attempt: step 1, no leftover
  // submit/done/error state, and a fresh idempotency key. Contact fields
  // are NOT touched here — see applyHash().
  function resetCheckout() {
    state.step = 0;
    state.done = false;
    state.errors = {};
    state.submit = { status: 'idle', key: Commerce.checkout.newKey(), error: '', order: null, paymentIssue: '' };
  }

  function applyHash() {
    var raw = location.hash.replace(/^#\/?/, '');
    var parts = raw.split('/').filter(Boolean).map(function (s) {
      try { return decodeURIComponent(s); } catch (e) { return s; }
    });
    var seg = parts[0] || 'home';
    var prevRoute = state.route, prevSlug = state.pslug;

    if (seg === 'shop') {
      state.route = 'shop';
      state.cat = parts[1] || '';
    } else if (seg === 'product') {
      state.route = 'product';
      state.pslug = parts[1] || '';
    } else if (['checkout', 'story', 'store', 'cart', 'favourites', 'account', 'order-status'].indexOf(seg) >= 0) {
      state.route = seg;
    } else {
      state.route = 'home';
    }

    // Opening a product resets its configurator, as in the prototype.
    if (state.route === 'product' && (prevRoute !== 'product' || prevSlug !== state.pslug)) {
      state.qty = 1;
      state.size = 'M';
      state.msg = '';
      state.pinfo = null;
      state.pImg = 0;
    }
    // Entering checkout (button or direct URL — same code path either way)
    // always resets the flow. See resetCheckout().
    if (state.route === 'checkout' && prevRoute !== 'checkout') resetCheckout();
    if (state.route !== 'checkout') {
      state.done = false;
      state.errors = {};
      // key: '' is how an in-flight response recognises it's been abandoned.
      state.submit = { status: 'idle', key: '', error: '', order: null, paymentIssue: '' };
    }
    if (state.route === 'order-status' && prevRoute !== 'order-status') loadOrderStatus();

    state.cartOpen = false;
    if (prevRoute !== state.route || prevSlug !== state.pslug) window.scrollTo(0, 0);
  }

  function go(hash) {
    if (location.hash === hash) { applyHash(); render(); }
    else location.hash = hash;
  }

  /* ---------- Cart mutations ---------- */

  // Persistence, merge keys and stock limits are the commerce layer's job.
  // Returns true when the line was added.
  function addToCart(p, qty, sizeKey, msg) {
    var r = Commerce.cart.add(p, skuFor(p, sizeKey), sizeKey, qty, msg, thumbOf(p));
    if (!r.ok) {
      flash(r.reason === 'sold_out' ? '這個尺寸已售完'
        : r.reason === 'stock_limit' ? '已達庫存上限' : '這個尺寸目前無法購買');
      return false;
    }
    flash('已加入購物袋 · ' + p.title);
    return true;
  }

  /* ============================================================
     Shared partials
     ============================================================ */

  function accordion(items, openIndex, action, extraClass) {
    return '<div class="' + cls('acc', extraClass) + '">' + items.map(function (f, i) {
      var open = openIndex === i;
      return '<div class="acc__item">' +
        '<a class="acc__q" href="#" data-act="' + action + '" data-a="' + i + '" ' +
           'aria-expanded="' + (open ? 'true' : 'false') + '">' +
          esc(f.q) + '<span>' + (open ? '−' : '＋') + '</span>' +
        '</a>' +
        (open ? '<p class="acc__a">' + esc(f.a) + '</p>' : '') +
      '</div>';
    }).join('') + '</div>';
  }

  function productCard(p, opts) {
    opts = opts || {};
    var href = '#/product/' + encodeURIComponent(p.slug);
    return '<div' + (opts.style ? ' style="' + opts.style + '"' : '') + '>' +
      '<div style="position:relative">' +
        '<a class="card__media" href="' + href + '" style="' + imgCss(thumbOf(p)) + '" ' +
           'aria-label="' + esc(p.title) + '"></a>' +
        (opts.fav
          ? '<button class="' + cls('fav-btn', state.fav.indexOf(p.id) >= 0 && 'is-on') + '" ' +
              'data-act="fav" data-a="' + p.id + '" ' +
              'aria-pressed="' + (state.fav.indexOf(p.id) >= 0) + '" ' +
              'aria-label="收藏 ' + esc(p.title) + '">♡</button>'
          : '') +
      '</div>' +
      '<div class="' + cls('card__foot', opts.fav && 'card__foot--shop') + '">' +
        '<div>' +
          '<div class="card__name">' + esc(p.title) + '</div>' +
          '<div class="card__price">' + esc(priceOf(p)) + '</div>' +
        '</div>' +
        (anySellable(p)
          ? '<button class="btn-add" data-act="quickAdd" data-a="' + esc(p.slug) + '">加入</button>'
          : '<button class="btn-add" disabled>售完</button>') +
      '</div>' +
    '</div>';
  }

  /* ============================================================
     Desktop views
     ============================================================ */

  function header() {
    var count = cartCount();
    var navHtml = navItems().map(function (n) {
      var active = (n.cat && state.route === 'shop' && state.cat === n.cat) ||
                   (n.route && state.route === n.route);
      var href = n.cat ? shopHref(n.cat) : '#/' + n.route;
      return '<a class="' + cls(active && 'is-active') + '" href="' + href + '">' + esc(n.label) + '</a>';
    }).join('');

    return '<header class="site-header">' +
      '<div class="header-inner">' +
        '<a class="brand" href="#/">' + esc(CONTENT.brand.name) + '</a>' +
        '<nav class="nav">' + navHtml + '</nav>' +
        '<div class="header-meta">' +
          '<a href="#" data-act="toggleSearch" aria-expanded="' + state.searchOpen + '">SEARCH</a>' +
          '<a href="#/favourites">FAV (' + state.fav.length + ')</a>' +
          '<a class="is-cart" href="#" data-act="openCart">CART (' + count + ')</a>' +
        '</div>' +
      '</div>' +
      (state.searchOpen ? searchBar() : '') +
    '</header>';
  }

  function searchBar() {
    var hint = state.q ? searchMatches().length + ' 項符合' : '輸入關鍵字';
    return '<div class="search-bar"><div class="search-bar__inner">' +
      '<input class="search-input" data-k="q" data-act="input:q" value="' + esc(state.q) + '" ' +
        'placeholder="' + esc(CONTENT.searchPlaceholder) + '" aria-label="搜尋商品">' +
      '<span class="search-hint">' + esc(hint) + '</span>' +
    '</div></div>';
  }

  function homeView() {
    var offsets = [0, 56, 22];
    var catalogReady = state.catalog.status === 'ready';
    var hero = heroPicks();
    var cats = shopCategories();

    return '<div class="wrap">' +
      '<section class="hero">' +
        '<a class="hero__img" href="' + productHref(hero[0]) + '" style="' + imgCss(largeOf(hero[0])) + '"' +
          (hero[0] ? ' aria-label="' + esc(hero[0].title) + '"' : ' aria-label="商品列表"') + '></a>' +
        '<div class="hero__copy">' +
          '<div class="eyebrow">' + esc(CONTENT.hero.eyebrow) + '</div>' +
          '<h1>' + lines(CONTENT.hero.title) + '</h1>' +
          '<p class="lede">' + esc(CONTENT.hero.lede) + '</p>' +
          '<a class="rule-link" href="#/shop">SHOP NOW</a>' +
        '</div>' +
        '<a class="hero__img hero__img--b" href="' + productHref(hero[1]) + '" style="' + imgCss(largeOf(hero[1])) + '"' +
          (hero[1] ? ' aria-label="' + esc(hero[1].title) + '"' : ' aria-label="商品列表"') + '></a>' +
      '</section>' +

      (cats.length
        ? '<nav class="cat-rails">' + cats.map(function (c, i) {
            return '<a class="cat-rail" href="' + shopHref(c.slug) + '"><span class="cat-rail__name">' + esc(c.name) +
              '</span><span class="cat-rail__no">' + ('0' + (i + 1)).slice(-2) + '</span></a>';
          }).join('') + '</nav>'
        : '') +

      '<section class="featured">' +
        '<div class="section-head">' +
          '<h2>' + esc(CONTENT.featuredTitle) + '</h2>' +
          '<a class="section-head__more" href="#/shop">ALL' + (catalogReady ? ' ' + state.catalog.products.length : '') + ' →</a>' +
        '</div>' +
        (catalogReady
          ? '<div class="grid-3">' +
              featuredProducts().map(function (p, i) {
                return productCard(p, { style: 'margin-top:' + (offsets[i] || 0) + 'px' });
              }).join('') +
            '</div>'
          : catalogStatusBlock()) +
      '</section>' +
    '</div>' +

    '<section class="story-teaser">' +
      '<div class="story-teaser__img" style="' + imgCss(CONTENT.storyImage) + '"></div>' +
      '<div>' +
        '<div class="eyebrow eyebrow--tight">' + esc(CONTENT.storyTeaser.eyebrow) + '</div>' +
        '<h3>' + lines(CONTENT.storyTeaser.title) + '</h3>' +
        '<p class="lede">' + esc(CONTENT.storyTeaser.lede) + '</p>' +
        '<a class="rule-link" href="#/story">READ MORE</a>' +
      '</div>' +
    '</section>' +

    '<section class="ig">' +
      '<div class="ig__head"><h3>' + esc(CONTENT.instagram.handle) + '</h3><span>FOLLOW</span></div>' +
      '<div class="ig__grid">' +
        gridPicks().map(function (p) {
          return '<div class="ig__tile" style="' + imgCss(thumbOf(p)) + '"></div>';
        }).join('') +
      '</div>' +
    '</section>' +

    '<section class="info-band"><div class="info-band__inner">' +
      '<div>' +
        '<div class="eyebrow eyebrow--tight eyebrow--clay">STORE</div>' +
        '<h4>' + esc(CONTENT.store.name) + '</h4>' +
        '<p class="lede">' + esc(CONTENT.store.address) + '<br>' + esc(CONTENT.store.hours) + '</p>' +
        '<a class="info-band__link" href="#/store">門市與配送</a>' +
      '</div>' +
      '<div>' +
        '<div class="eyebrow eyebrow--tight eyebrow--clay">FAQ</div>' +
        accordion(CONTENT.faq, state.faq, 'toggleFaq') +
      '</div>' +
    '</div></section>' +

    '<section class="newsletter">' +
      '<div>' +
        '<div class="eyebrow eyebrow--tight">NEWSLETTER</div>' +
        '<h4>' + esc(CONTENT.newsletter.title) + '</h4>' +
      '</div>' +
      '<div class="newsletter__form">' +
        '<div class="newsletter__row">' +
          '<input class="newsletter__input" data-k="email" data-act="input:email" ' +
            'value="' + esc(state.email) + '" placeholder="your@email.com" ' +
            'inputmode="email" aria-label="電子郵件">' +
          '<button class="btn-pill" data-act="subscribe">訂閱</button>' +
        '</div>' +
        '<div class="' + cls('newsletter__msg', state.emailOk && 'is-ok') + '" role="status">' +
          esc(state.emailMsg) +
        '</div>' +
      '</div>' +
    '</section>';
  }

  function shopView() {
    var ready = state.catalog.status === 'ready';
    var list = ready ? visibleList() : [];

    return '<div class="shop">' +
      '<div class="eyebrow eyebrow--muted">SHOP / ' + esc(catTitle()) + '</div>' +
      '<div class="shop__head">' +
        '<h1>' + esc(catTitle()) + '</h1>' +
        (ready ? '<div class="shop__count">' + list.length + ' 件商品</div>' : '') +
      '</div>' +
      '<div class="filter-row">' +
        '<div class="chips">' +
          chipCats().map(function (c) {
            return '<a class="' + cls('chip', state.cat === c.slug && 'is-on') + '" href="' + shopHref(c.slug) + '" ' +
              'data-act="pickCat">' + esc(c.name) + '</a>';
          }).join('') +
        '</div>' +
        '<div class="sorts">' +
          SORTS.map(function (s) {
            return '<a class="' + cls(state.sort === s && 'is-on') + '" href="#" ' +
              'data-act="setSort" data-a="' + esc(s) + '">' + esc(s) + '</a>';
          }).join('') +
        '</div>' +
      '</div>' +
      (ready
        ? '<div class="grid-3 grid-3--shop">' +
            list.map(function (p) { return productCard(p, { fav: true }); }).join('') +
          '</div>' +
          (list.length === 0 ? '<div class="empty-state">這個分類目前沒有商品。</div>' : '')
        : catalogStatusBlock()) +
    '</div>';
  }

  function productView() {
    if (state.catalog.status !== 'ready') {
      return '<div class="pdp">' + catalogStatusBlock() + '</div>';
    }
    var p = productBySlug(state.pslug);
    if (!p) {
      return '<div class="pdp"><div class="empty-state">找不到這項商品，可能已下架。<br>' +
        '<a class="rule-link" style="margin-top:16px" href="#/shop">回到商品列表</a></div></div>';
    }

    var imgs = productImages(p);
    var thumbs = imgs.length ? imgs : [null];
    var mainImg = imgUrl(thumbs[state.pImg] || thumbs[0], 'large');
    var sizeKeys = productSizeKeys(p);
    var activeSize = pickSize(p);
    var sku = skuFor(p, activeSize);
    var u = sku ? sku.price_amount : null;
    var canBuy = !!sku && Commerce.isSkuSellable(sku);
    var related = state.catalog.products.filter(function (x) { return x.id !== p.id; }).slice(0, 3);

    return '<div class="pdp">' +
      '<div class="crumbs"><a href="#/shop">SHOP</a> / ' + esc(primaryCatName(p) || '商品') + ' / ' + esc(p.title) + '</div>' +
      '<div class="pdp__cols">' +
        '<div>' +
          '<div class="pdp__main" style="' + imgCss(mainImg) + '"></div>' +
          '<div class="pdp__thumbs">' +
            thumbs.map(function (im, i) {
              var img = imgUrl(im, 'thumb');
              return '<a class="' + cls('pdp__thumb', i === state.pImg && 'is-on') + '" href="#" ' +
                'data-act="setPImg" data-a="' + i + '" style="' + imgCss(img) + '" ' +
                'aria-label="檢視圖片 ' + (i + 1) + '"></a>';
            }).join('') +
          '</div>' +
        '</div>' +
        '<div class="pdp__side">' +
          (p.subtitle ? '<div class="eyebrow eyebrow--tight">' + esc(p.subtitle) + '</div>' : '') +
          '<h1>' + esc(p.title) + '</h1>' +
          '<div class="pdp__price">' + esc(CONFIG.showPrices && u != null ? money(u) : '—') + '</div>' +
          '<p class="lede">' + esc(p.description) + '</p>' +

          (sizeKeys.length
            ? '<div class="pdp__group"><div class="field-cap">SIZE</div>' +
                '<div class="size-row">' +
                  sizeKeys.map(function (k) {
                    return '<button class="' + cls('size-btn', activeSize === k && 'is-on') + '" ' +
                      'data-act="setSize" data-a="' + esc(k) + '" aria-pressed="' + (activeSize === k) + '"' +
                      (sizeSellable(p, k) ? '' : ' disabled') + '>' +
                      esc(sizeLabel(k)) + (sizeSellable(p, k) ? '' : ' · 售完') + '</button>';
                  }).join('') +
                '</div>' +
              '</div>'
            : '') +

          '<div class="pdp__group--tight" style="margin-top:28px">' +
            '<div class="field-cap">NOTE</div>' +
            '<textarea class="card-msg" data-k="msg" data-act="input:msg" ' +
              'placeholder="' + esc(CONTENT.noteLabel) + '（選填）" aria-label="' + esc(CONTENT.noteLabel) + '">' + esc(state.msg) + '</textarea>' +
          '</div>' +

          '<div class="buy-row">' +
            '<div class="stepper">' +
              '<button data-act="decQty" aria-label="減少數量">−</button>' +
              '<span class="stepper__n">' + state.qty + '</span>' +
              '<button data-act="incQty" aria-label="增加數量">＋</button>' +
            '</div>' +
            '<button class="btn-primary" data-act="addCurrent"' + (canBuy ? '' : ' disabled') + '>' +
              (canBuy ? '加入購物袋 · ' + esc(CONFIG.showPrices && u != null ? money(u * state.qty) : '—') : '已售完') + '</button>' +
          '</div>' +

          accordion(CONTENT.pinfo, state.pinfo, 'togglePInfo', 'pdp__acc') +
        '</div>' +
      '</div>' +

      (related.length
        ? '<section class="related">' +
            '<h3>你可能也喜歡</h3>' +
            '<div class="grid-3">' +
              related.map(function (r) {
                return '<div>' +
                  '<a class="card__media" href="#/product/' + encodeURIComponent(r.slug) + '" style="' + imgCss(thumbOf(r)) + '" ' +
                     'aria-label="' + esc(r.title) + '"></a>' +
                  '<div class="related__name">' + esc(r.title) + '</div>' +
                  '<div class="card__price">' + esc(priceOf(r)) + '</div>' +
                '</div>';
              }).join('') +
            '</div>' +
          '</section>'
        : '') +
    '</div>';
  }

  function submitLocked() { return state.submit.status === 'pending' || state.submit.status === 'redirecting'; }

  function field(label, key, opts) {
    opts = opts || {};
    var err = state.errors[key];
    var disabled = submitLocked();
    return '<div>' +
      '<div class="field-label">' + esc(label) + '</div>' +
      '<input class="' + cls('field-input', opts.mono && 'field-input--mono', opts.date && 'field-input--date') + '" ' +
        (opts.date ? 'type="date" ' : '') +
        'data-k="' + key + '" data-act="input:form:' + key + '" ' +
        'value="' + esc(state.form[key]) + '" ' +
        (opts.placeholder ? 'placeholder="' + esc(opts.placeholder) + '" ' : '') +
        (opts.inputmode ? 'inputmode="' + opts.inputmode + '" ' : '') +
        'aria-label="' + esc(label) + '" ' +
        (disabled ? 'disabled ' : '') +
        (err ? 'aria-invalid="true"' : '') + '>' +
      (err ? '<div class="field-error">' + esc(err) + '</div>' : '') +
    '</div>';
  }

  function orderSummary() {
    var lines = cartLines();
    var sub = subtotal();
    var fee = shipFee();
    return '<aside class="summary">' +
      '<div class="field-cap">ORDER</div>' +
      '<div class="summary__lines">' +
        lines.map(function (l) {
          return '<div class="summary__line">' +
            '<div class="summary__thumb" style="' + imgCss(l.img) + '"></div>' +
            '<div style="flex:1">' +
              '<div class="summary__name">' + esc(l.name) + '</div>' +
              '<div class="summary__meta">' + esc(l.meta) + '</div>' +
            '</div>' +
            '<div class="summary__amt">' + esc(l.lineText) + '</div>' +
          '</div>';
        }).join('') +
      '</div>' +
      '<div class="summary__totals">' +
        '<div class="summary__row"><span>小計</span><span class="mono">' + esc(money(sub)) + '</span></div>' +
        '<div class="summary__row"><span>運費</span><span class="mono">' + esc(fee ? money(fee) : '免運') + '</span></div>' +
        '<div class="summary__row summary__row--total"><span>合計</span><span class="mono">' + esc(money(sub + fee)) + '</span></div>' +
        '<div class="summary__row" style="opacity:.6;font-size:11px">送出後將由系統計算實際金額</div>' +
      '</div>' +
    '</aside>';
  }

  function checkoutView() {
    if (state.submit.status === 'redirecting') {
      return '<div class="checkout"><div class="confirm">' +
        '<div class="eyebrow">ORDER CONFIRMED</div>' +
        '<h1>訂單已送出</h1>' +
        '<p class="lede" role="status" aria-live="polite">正在前往付款頁…</p>' +
      '</div></div>';
    }

    if (state.done) {
      var o = state.submit.order;
      var issue = state.submit.paymentIssue;
      var issueMsg = issue === 'no-token'
        ? '系統暫時無法建立付款連結。請以你填寫的 email 註冊會員即可查詢訂單，或與我們聯繫完成付款。'
        : issue === 'init-failed'
          ? '導向付款時發生問題。請與我們聯繫完成付款，或稍後至「訂單查詢」重新確認狀態。'
          : '我們會以 email 與你確認到貨時段。';
      return '<div class="checkout"><div class="confirm">' +
        '<div class="eyebrow">ORDER CONFIRMED</div>' +
        '<h1>謝謝你，我們已收到訂單</h1>' +
        '<p class="lede">訂單編號 ' + esc(o ? o.id : '') + '。' + esc(issueMsg) + '</p>' +
        '<a class="rule-link" href="#/">BACK TO HOME</a>' +
      '</div></div>';
    }

    var stepNames = ['收件資訊', '配送方式', '付款'];
    var locked = submitLocked();
    var hasCart = !Commerce.cart.isEmpty();
    var body = '';

    if (state.step === 0) {
      body = '<div><h2>收件資訊</h2><div class="fields">' +
        field('Email', 'email', { placeholder: 'you@example.com', inputmode: 'email' }) +
        field('收件人', 'name') +
        field('手機', 'phone', { placeholder: '09xxxxxxxx', inputmode: 'tel' }) +
        field('配送地址', 'addr') +
      '</div></div>';
    } else if (state.step === 1) {
      var methods = state.catalog.shippingMethods;
      body = '<div><h2>配送方式</h2>' +
        (state.catalog.status !== 'ready'
          ? catalogStatusBlock()
          : (methods.length
            ? '<div class="ships">' +
                methods.map(function (s) {
                  return '<a class="' + cls('ship', state.ship === s.id && 'is-on') + '" href="#" ' +
                    'data-act="setShip" data-a="' + s.id + '">' +
                    '<div><div class="ship__label">' + esc(s.name) + '</div>' +
                    '<div class="ship__note">' + esc(s.carrier) + '</div></div>' +
                    '<div class="ship__fee">' + esc(s.flat_rate ? money(s.flat_rate) : '免運') + '</div>' +
                  '</a>';
                }).join('') +
              '</div>'
            : '<p class="lede" style="font-size:13px">目前沒有設定配送方式，將以免運處理。</p>')) +
        '<div style="margin-top:26px">' + field('希望到貨日', 'date', { date: true }) + '</div>' +
      '</div>';
    } else {
      body = '<div><h2>確認送出</h2>' +
        '<p class="lede" style="margin-top:6px;font-size:13px;line-height:1.9">送出後會建立訂單並導向付款頁完成付款；完成付款後我們會以 email 與您確認到貨時段。</p>' +
      '</div>';
    }

    // role=status / aria-live announces both "still working" and the
    // failure reason — the full-rerender architecture has no other way to
    // let a screen reader notice the change (see design.md Risks).
    var statusMsg = state.submit.status === 'pending' ? '送出中，請稍候…' : state.submit.error;
    var statusHtml = statusMsg
      ? '<div class="submit-status' + (state.submit.status === 'pending' ? ' is-pending' : ' is-error') + '" role="status" aria-live="polite">' +
          esc(statusMsg) +
        '</div>'
      : '';

    var showSubmitBtn = state.step !== 2 || hasCart;
    var submitLabel = state.step !== 2
      ? '下一步'
      : (state.submit.status === 'pending' ? '送出中…' : (state.submit.status === 'error' ? '重新送出' : '送出訂單'));

    return '<div class="checkout">' +
      '<div class="steps">' +
        stepNames.map(function (l, i) {
          return '<div class="' + cls('step', i === state.step && 'is-on') + '">' +
            '<span class="step__n">0' + (i + 1) + '</span>' + esc(l) + '</div>';
        }).join('') +
      '</div>' +
      '<div class="checkout__cols">' +
        '<div>' + body + statusHtml +
          '<div class="checkout__nav">' +
            (showSubmitBtn
              ? '<button class="btn-primary" data-act="nextStep"' + (locked ? ' disabled' : '') + '>' + esc(submitLabel) + '</button>'
              : '<span class="lede" style="font-size:13px">購物袋是空的</span>') +
            '<a class="' + cls('checkout__back', locked && 'is-disabled') + '" href="#" data-act="prevStep"' +
              (locked ? ' aria-disabled="true"' : '') + '>' +
              (state.step === 0 ? '回到購物' : '上一步') + '</a>' +
          '</div>' +
        '</div>' +
        orderSummary() +
      '</div>' +
    '</div>';
  }

  function storyView() {
    return '<article class="story-page">' +
      '<div class="eyebrow">' + esc(CONTENT.story.eyebrow) + '</div>' +
      '<h1>' + lines(CONTENT.story.title) + '</h1>' +
      '<div class="story-page__img" style="' + imgCss(CONTENT.storyImage) + '"></div>' +
      CONTENT.story.paragraphs.map(function (t) { return '<p>' + esc(t) + '</p>'; }).join('') +
      '<a class="rule-link" href="#/shop">VIEW COLLECTION</a>' +
    '</article>';
  }

  function storeView() {
    return '<div class="store-page">' +
      '<div class="eyebrow">STORE &amp; DELIVERY</div>' +
      '<h1>門市與配送</h1>' +
      '<div class="store-page__cols">' +
        '<div>' +
          '<div class="map-ph">MAP PLACEHOLDER</div>' +
          '<h4>' + esc(CONTENT.store.name) + '</h4>' +
          '<p class="lede">' + esc(CONTENT.store.address) + '<br>' + esc(CONTENT.store.hours) + '<br>' + esc(CONTENT.store.tel) + '</p>' +
        '</div>' +
        '<div>' + accordion(CONTENT.faq, state.faq, 'toggleFaq') + '</div>' +
      '</div>' +
    '</div>';
  }

  function favouritesView() {
    if (state.catalog.status !== 'ready') {
      return '<div class="simple-page">' +
        '<div class="eyebrow eyebrow--muted">FAVOURITES</div>' +
        '<h1>收藏</h1>' +
        catalogStatusBlock() +
      '</div>';
    }
    var list = state.catalog.products.filter(function (p) { return state.fav.indexOf(p.id) >= 0; });
    return '<div class="simple-page">' +
      '<div class="eyebrow eyebrow--muted">FAVOURITES</div>' +
      '<h1>收藏</h1>' +
      (list.length
        ? '<div class="grid-3 grid-3--shop">' +
            list.map(function (p) { return productCard(p, { fav: true }); }).join('') +
          '</div>'
        : '<div class="empty-state">還沒有收藏的商品。<br>' +
          '<a class="rule-link" style="margin-top:16px" href="#/shop">去看看商品</a></div>') +
    '</div>';
  }

  function accountView() {
    return '<div class="simple-page">' +
      '<div class="eyebrow eyebrow--muted">ACCOUNT</div>' +
      '<h1>我的</h1>' +
      '<div class="account-card">' +
        '<h4>訪客</h4>' +
        '<p class="lede" style="font-size:13.5px">登入後可查看訂單與收藏。</p>' +
        '<div class="account-rows">' +
          '<div class="account-row"><span>購物袋</span><span>' + cartCount() + ' 件</span></div>' +
          '<div class="account-row"><span>收藏</span><span>' + state.fav.length + ' 件</span></div>' +
          '<div class="account-row"><span>門市</span><span>' + esc(CONTENT.store.addressShort) + '</span></div>' +
        '</div>' +
        '<a class="rule-link" style="margin-top:24px" href="#/store">門市與配送</a>' +
      '</div>' +
    '</div>';
  }

  var PAY_LABELS = ['未付款', '已付款', '已退款', '部分退款'];
  var FULFILL_LABELS = ['未出貨', '已出貨', '已送達', '已退回'];

  function orderStatusView() {
    var s = state.orderStatus;
    if (s.status !== 'ready') {
      return '<div class="simple-page">' +
        '<div class="eyebrow eyebrow--muted">ORDER STATUS</div><h1>訂單查詢</h1>' +
        (s.status === 'error'
          ? '<div class="empty-state">' + esc(s.error || '查詢失敗，請稍後再試。') + '<br>' +
              '<a class="rule-link" style="margin-top:16px" href="#/">回到首頁</a></div>'
          : '<div class="empty-state">查詢中…</div>') +
      '</div>';
    }
    var o = s.order;
    return '<div class="simple-page">' +
      '<div class="eyebrow eyebrow--muted">ORDER STATUS</div>' +
      '<h1>訂單 #' + esc(o.id) + '</h1>' +
      '<div class="account-card">' +
        '<div class="account-rows">' +
          '<div class="account-row"><span>付款狀態</span><span>' + esc(PAY_LABELS[o.payment_status] || '未知') + '</span></div>' +
          '<div class="account-row"><span>出貨狀態</span><span>' + esc(FULFILL_LABELS[o.fulfillment_status] || '未知') + '</span></div>' +
          '<div class="account-row"><span>合計</span><span>' + esc(money(o.total_amount)) + '</span></div>' +
        '</div>' +
        '<a class="rule-link" style="margin-top:24px" href="#/">回到首頁</a>' +
      '</div>' +
    '</div>';
  }

  function footer() {
    return '<footer class="site-footer"><div class="site-footer__inner">' +
      '<span>' + esc(CONTENT.brand.footer) + '</span><span>© ' + new Date().getFullYear() + '</span>' +
    '</div></footer>';
  }

  function desktopPage() {
    var main;
    switch (state.route) {
      case 'shop': main = shopView(); break;
      case 'product': main = productView(); break;
      case 'checkout': main = checkoutView(); break;
      case 'story': main = storyView(); break;
      case 'store': main = storeView(); break;
      case 'favourites': main = favouritesView(); break;
      case 'account': main = accountView(); break;
      case 'order-status': main = orderStatusView(); break;
      case 'cart': main = favouritesView(); break; // desktop uses the drawer
      default: main = homeView();
    }
    return '<div class="page">' + header() + '<main>' + main + '</main>' + footer() + '</div>';
  }

  /* ============================================================
     Mobile app views
     ============================================================ */

  function mCats() {
    return '<div class="m-cats">' + chipCats().map(function (c) {
      return '<a class="' + cls('m-chip', state.cat === c.slug && 'is-on') + '" href="' + shopHref(c.slug) + '">' +
        esc(c.name) + '</a>';
    }).join('') + '</div>';
  }

  function mCard(p, opts) {
    opts = opts || {};
    return '<div>' +
      '<a class="m-card__media" href="#/product/' + encodeURIComponent(p.slug) + '" style="' + imgCss(thumbOf(p)) + '" ' +
         'aria-label="' + esc(p.title) + '">' +
        (opts.fav
          ? '<span class="' + cls('m-fav', state.fav.indexOf(p.id) >= 0 && 'is-on') + '" ' +
              'data-act="fav" data-a="' + p.id + '" role="button" ' +
              'aria-label="收藏 ' + esc(p.title) + '">♡</span>'
          : '') +
      '</a>' +
      '<div class="' + cls('m-card__name', opts.small && 'm-card__name--shop') + '">' + esc(p.title) + '</div>' +
      '<div class="m-card__price">' + esc(priceOf(p)) + '</div>' +
    '</div>';
  }

  function mHomeView() {
    var catalogReady = state.catalog.status === 'ready';
    var mHero = heroPicks()[1];
    return mCats() +
      '<a class="m-hero" href="' + productHref(mHero) + '" style="' + imgCss(largeOf(mHero)) + '">' +
        '<div class="m-hero__cap">' +
          '<div class="eyebrow">' + esc(CONTENT.hero.eyebrow) + '</div>' +
          '<h1>' + lines(CONTENT.hero.title) + '</h1>' +
        '</div>' +
      '</a>' +
      '<div class="m-sec-head"><h2>' + esc(CONTENT.featuredTitle) + '</h2><a href="#/shop">全部 ›</a></div>' +
      (catalogReady
        ? '<div class="m-grid">' + featuredProducts().map(function (p) { return mCard(p, { fav: true }); }).join('') + '</div>'
        : catalogStatusBlock(true)) +
      '<div class="m-promo">' +
        '<div>' +
          '<div class="m-promo__t">' + esc(CONTENT.promo.title) + '</div>' +
          '<div class="m-promo__s">' + esc(CONTENT.promo.sub) + '</div>' +
        '</div>' +
        '<a class="m-promo__cta" href="#/story">' + esc(CONTENT.promo.cta) + '</a>' +
      '</div>';
  }

  function mShopView() {
    if (state.catalog.status !== 'ready') return mCats() + catalogStatusBlock(true);
    var list = visibleList();
    return mCats() +
      '<div class="m-count">' + list.length + ' 件商品</div>' +
      '<div class="m-grid m-grid--shop">' +
        list.map(function (p) { return mCard(p, { small: true, fav: true }); }).join('') +
      '</div>' +
      (list.length === 0 ? '<div class="m-empty">這個分類目前沒有商品。</div>' : '');
  }

  function mProductView() {
    if (state.catalog.status !== 'ready') return catalogStatusBlock(true);
    var p = productBySlug(state.pslug);
    if (!p) return '<div class="m-empty">找不到這項商品，可能已下架。</div>';

    var sizeKeys = productSizeKeys(p);
    var activeSize = pickSize(p);
    var sku = skuFor(p, activeSize);
    var u = sku ? sku.price_amount : null;

    return '<div class="m-pdp__img" style="' + imgCss(largeOf(p)) + '"></div>' +
      '<div class="m-pdp__body">' +
        (p.subtitle ? '<div class="eyebrow">' + esc(p.subtitle) + '</div>' : '') +
        '<h1>' + esc(p.title) + '</h1>' +
        '<div class="m-pdp__price">' + esc(CONFIG.showPrices && u != null ? money(u) : '—') + '</div>' +
        '<p class="lede">' + esc(p.description) + '</p>' +
        (sizeKeys.length
          ? '<div class="m-sizes">' +
              sizeKeys.map(function (s) {
                return '<button class="' + cls('m-size', activeSize === s && 'is-on') + '" ' +
                  'data-act="setSize" data-a="' + esc(s) + '" aria-pressed="' + (activeSize === s) + '"' +
                  (sizeSellable(p, s) ? '' : ' disabled') + '>' +
                  esc(sizeLabel(s)) + (sizeSellable(p, s) ? '' : ' · 售完') + '</button>';
              }).join('') +
            '</div>'
          : '') +
        '<div class="m-pdp__pad"></div>' +
      '</div>';
  }

  function mCartView() {
    var lines = cartLines();
    var sub = subtotal();
    return '<div class="m-cart">' +
      '<h2>購物袋</h2>' +
      lines.map(function (l) {
        return '<div class="m-cart__line">' +
          '<div class="m-cart__thumb" style="' + imgCss(l.img) + '"></div>' +
          '<div style="flex:1">' +
            '<div class="m-cart__name">' + esc(l.name) + '</div>' +
            '<div class="m-cart__meta">' + esc(l.meta) + '</div>' +
            '<div class="m-qty">' +
              '<button data-act="lineDec" data-a="' + esc(l.key) + '" aria-label="減少數量">−</button>' +
              '<span>' + l.qty + '</span>' +
              '<button data-act="lineInc" data-a="' + esc(l.key) + '" aria-label="增加數量">＋</button>' +
            '</div>' +
          '</div>' +
          '<div class="m-cart__amt">' + esc(l.lineText) + '</div>' +
        '</div>';
      }).join('') +
      (lines.length === 0 ? '<div class="m-empty">購物袋是空的</div>' : '') +
      '<div class="m-cart__total"><span>合計</span><span class="mono">' +
        esc(money(sub + shipFee())) + '</span></div>' +
      (lines.length
        ? '<button class="btn-primary" data-act="goCheckout" ' +
            'style="width:100%;margin-top:20px;height:50px;border-radius:100px">前往結帳</button>'
        : '') +
    '</div>';
  }

  function mFavView() {
    if (state.catalog.status !== 'ready') {
      return '<div class="m-cart"><h2>收藏</h2></div>' + catalogStatusBlock(true);
    }
    var list = state.catalog.products.filter(function (p) { return state.fav.indexOf(p.id) >= 0; });
    return '<div class="m-cart"><h2>收藏</h2></div>' +
      (list.length
        ? '<div class="m-grid m-grid--shop">' +
            list.map(function (p) { return mCard(p, { small: true, fav: true }); }).join('') +
          '</div>'
        : '<div class="m-empty">還沒有收藏的商品。</div>');
  }

  function mAccountView() {
    return '<div class="m-cart">' +
      '<h2>我的</h2>' +
      '<div class="m-cart__line"><div style="flex:1">' +
        '<div class="m-cart__name">訪客</div>' +
        '<div class="m-cart__meta">登入後可查看訂單與收藏</div>' +
      '</div></div>' +
      '<div class="m-cart__line"><div style="flex:1">' +
        '<div class="m-cart__name">購物袋</div></div>' +
        '<div class="m-cart__amt">' + cartCount() + ' 件</div>' +
      '</div>' +
      '<div class="m-cart__line"><div style="flex:1">' +
        '<div class="m-cart__name">收藏</div></div>' +
        '<div class="m-cart__amt">' + state.fav.length + ' 件</div>' +
      '</div>' +
      '<div class="m-cart__line"><div style="flex:1">' +
        '<div class="m-cart__name">門市與配送</div>' +
        '<div class="m-cart__meta">' + esc(CONTENT.store.addressShort + ' · ' + CONTENT.store.hoursShort) + '</div>' +
      '</div><a class="m-cart__amt" href="#/store">›</a></div>' +
    '</div>';
  }

  function mStoryView() {
    return '<div class="m-story__head">' +
        '<div class="eyebrow">' + esc(CONTENT.story.eyebrow) + '</div>' +
        '<h1>' + lines(CONTENT.story.title) + '</h1>' +
      '</div>' +
      '<div class="m-story__img" style="' + imgCss(CONTENT.storyImage) + '"></div>' +
      '<div class="m-story__body">' +
        CONTENT.story.paragraphs.map(function (t) { return '<p>' + esc(t) + '</p>'; }).join('') +
        '<a class="rule-link" href="#/shop">VIEW COLLECTION</a>' +
      '</div>';
  }

  function mStoreView() {
    return '<div class="m-store__head">' +
        '<div class="eyebrow">STORE &amp; DELIVERY</div>' +
        '<h1>門市與配送</h1>' +
      '</div>' +
      '<div class="m-store__map">MAP PLACEHOLDER</div>' +
      '<div class="m-store__card">' +
        '<div class="m-store__cardHead">' +
          '<h4>' + esc(CONTENT.store.name) + '</h4>' +
          '<a class="m-store__nav" href="#" data-act="noop">導航 ›</a>' +
        '</div>' +
        '<div class="m-store__rows">' +
          '<div class="m-store__row"><span>ADDR</span><span>' + esc(CONTENT.store.address) + '</span></div>' +
          '<div class="m-store__row"><span>HOURS</span><span>' + esc(CONTENT.store.hours) + '</span></div>' +
          '<div class="m-store__row"><span>TEL</span><span class="m-store__tel">' + esc(CONTENT.store.tel) + '</span></div>' +
        '</div>' +
      '</div>' +
      '<div class="m-store__faq">' +
        '<div class="eyebrow eyebrow--muted">FAQ</div>' +
        accordion(CONTENT.faq, state.faq, 'toggleFaq') +
      '</div>';
  }

  function currentCanBuy() {
    var p = productBySlug(state.pslug);
    return !!p && Commerce.isSkuSellable(skuFor(p, pickSize(p)));
  }

  function mobilePage() {
    var route = state.route;
    var body, activeTab = '';

    switch (route) {
      case 'shop': body = mShopView(); activeTab = 'shop'; break;
      case 'product': body = mProductView(); activeTab = 'shop'; break;
      case 'cart': body = mCartView(); break;
      case 'favourites': body = mFavView(); activeTab = 'fav'; break;
      case 'account': body = mAccountView(); activeTab = 'me'; break;
      case 'story': body = mStoryView(); activeTab = 'home'; break;
      case 'store': body = mStoreView(); activeTab = 'home'; break;
      default: body = mHomeView(); activeTab = 'home';
    }

    var showBack = ['product', 'shop', 'cart', 'story', 'store'].indexOf(route) >= 0;

    return '<div class="phone">' +
      '<div class="app-header">' +
        (showBack
          ? '<a class="app-back" href="#/" aria-label="返回">‹</a>'
          : '<span class="app-back app-back--ghost" aria-hidden="true"></span>') +
        '<span class="app-header__brand">' + esc(CONTENT.brand.name) + '</span>' +
        '<a class="app-cart" href="#/cart" aria-label="購物袋">' + cartCount() + '</a>' +
      '</div>' +

      '<div class="app-body" data-scroll="app-body">' + body + '</div>' +

      (route === 'product'
        ? '<div class="m-buybar">' +
            '<div class="m-stepper">' +
              '<button data-act="decQty" aria-label="減少數量">−</button>' +
              '<span>' + state.qty + '</span>' +
              '<button data-act="incQty" aria-label="增加數量">＋</button>' +
            '</div>' +
            '<button class="btn-primary" data-act="addCurrent"' + (currentCanBuy() ? '' : ' disabled') + '>' +
              (currentCanBuy() ? '加入購物袋' : '已售完') + '</button>' +
          '</div>'
        : '') +

      '<div class="tabbar">' +
        '<div class="tabbar__row">' +
          TABS.map(function (t) {
            return '<a class="' + cls('tab', activeTab === t.k && 'is-on') + '" href="' + t.href + '">' +
              '<span class="tab__icon">' + t.icon + '</span>' +
              '<span class="tab__label">' + esc(t.label) + '</span>' +
            '</a>';
          }).join('') +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ============================================================
     Overlays
     ============================================================ */

  function cartDrawer() {
    var lines = cartLines();
    var sub = subtotal();
    var fee = shipFee();

    return '<div class="drawer-root" role="dialog" aria-modal="true" aria-label="購物袋">' +
      '<button class="drawer-scrim" data-act="closeCart" aria-label="關閉購物袋"></button>' +
      '<div class="drawer">' +
        '<div class="drawer__head">' +
          '<span class="drawer__title">購物袋 (' + cartCount() + ')</span>' +
          '<a class="drawer__close" href="#" data-act="closeCart" aria-label="關閉">×</a>' +
        '</div>' +
        '<div class="drawer__body">' +
          lines.map(function (l) {
            return '<div class="drawer__line">' +
              '<div class="drawer__thumb" style="' + imgCss(l.img) + '"></div>' +
              '<div style="flex:1">' +
                '<div class="drawer__lineTop">' +
                  '<span class="drawer__name">' + esc(l.name) + '</span>' +
                  '<a class="drawer__remove" href="#" data-act="lineRemove" data-a="' + esc(l.key) + '">REMOVE</a>' +
                '</div>' +
                '<div class="drawer__meta">' + esc(l.meta) + '</div>' +
                '<div class="drawer__qtyRow">' +
                  '<div class="qty-sq">' +
                    '<button data-act="lineDec" data-a="' + esc(l.key) + '" aria-label="減少數量">−</button>' +
                    '<span>' + l.qty + '</span>' +
                    '<button data-act="lineInc" data-a="' + esc(l.key) + '" aria-label="增加數量">＋</button>' +
                  '</div>' +
                  '<span class="drawer__amt">' + esc(l.lineText) + '</span>' +
                '</div>' +
              '</div>' +
            '</div>';
          }).join('') +
          (lines.length === 0
            ? '<div class="empty-state">購物袋是空的<br>' +
              '<a class="rule-link" style="margin-top:16px" href="#/shop" data-act="closeCart">去看看商品</a></div>'
            : '') +
        '</div>' +
        '<div class="drawer__foot">' +
          '<div class="drawer__sub"><span>小計</span><span class="mono">' + esc(money(sub)) + '</span></div>' +
          '<div class="drawer__total"><span>合計</span><span class="mono">' + esc(money(sub + fee)) + '</span></div>' +
          '<button class="btn-primary" data-act="goCheckout">前往結帳</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  /* ============================================================
     Render
     ============================================================ */

  // Routes the phone UI doesn't define — fall back to the (responsive) web layout.
  var DESKTOP_ONLY = ['checkout', 'order-status'];

  function view() {
    var useMobile = state.mode === 'mobile' && DESKTOP_ONLY.indexOf(state.route) < 0;
    return (useMobile ? mobilePage() : desktopPage()) +
      (state.cartOpen ? cartDrawer() : '') +
      (state.toast ? '<div class="toast" role="status">' + esc(state.toast) + '</div>' : '');
  }

  function render() {
    if (!booted) return;
    // Preserve caret + scroll across the re-render.
    var active = document.activeElement;
    var focusKey = active && active.dataset ? active.dataset.k : null;
    var selStart = null, selEnd = null;
    if (focusKey && 'selectionStart' in active) {
      try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (e) { /* unsupported type */ }
    }
    var scroller = app.querySelector('[data-scroll="app-body"]');
    var scrollTop = scroller ? scroller.scrollTop : 0;

    app.innerHTML = view();

    if (focusKey) {
      var el = app.querySelector('[data-k="' + focusKey + '"]');
      if (el) {
        el.focus();
        if (selStart != null) { try { el.setSelectionRange(selStart, selEnd); } catch (e) { /* noop */ } }
      }
    }
    var newScroller = app.querySelector('[data-scroll="app-body"]');
    if (newScroller && scrollTop) newScroller.scrollTop = scrollTop;
  }

  /* ============================================================
     Order submission

     The site's async flow, now talking to the `ecommerce` platform's
     guest-checkout + payment endpoints instead of a local worker. See
     (See CLAUDE.md, "Async submit".)
     state.submit.key is generated when checkout is entered (resetCheckout())
     and doubles as the Idempotency-Key request header AND as the test for
     whether a response still belongs to the current attempt.
     ============================================================ */

  var FIELD_MESSAGES = {
    email: '請填寫正確的 email',
    name: '請填寫收件人',
    phone: '請填寫正確的手機號碼',
    addr: '請填寫完整地址',
    date: '請填寫希望到貨日'
  };

  var POINTER_FIELD = {
    '/email': 'email',
    '/shipping_address/recipient_name': 'name',
    '/shipping_address/phone': 'phone',
    '/shipping_address/line1': 'addr',
    '/requested_delivery_date': 'date'
  };

  function todayStr() {
    var d = new Date();
    var mm = ('0' + (d.getMonth() + 1)).slice(-2);
    var dd = ('0' + d.getDate()).slice(-2);
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  function submitOrder() {
    if (Commerce.cart.isEmpty()) {
      flash('購物袋是空的');
      go('#/shop');
      return;
    }

    var key = state.submit.key;
    state.submit.status = 'pending';
    state.submit.error = '';
    render();

    // No amounts are sent: the platform is sole authority for computing the price.
    Commerce.checkout.placeOrder({ key: key, form: state.form, shipId: state.ship }).then(function (r) {
      handleCheckoutResponse(key, r);
    });
  }

  function handleCheckoutResponse(key, r) {
    // The visitor may have already left checkout (or retried, minting a new
    // key) by the time this resolves. An expired response never touches the
    // screen or the route — except a created order, whose cart the commerce
    // layer has already cleared.
    var expired = key !== state.submit.key;

    if (r.kind === 'created') {
      if (expired) {
        flash('訂單已送出 · 單號 ' + r.order.id);
        return;
      }
      state.submit.order = r.order;

      // The access token can legitimately be absent even on success (docs §5):
      // saying "your order failed" here would be the actual lie.
      if (!r.token) {
        state.submit.paymentIssue = 'no-token';
        state.submit.status = 'idle';
        state.done = true;
        render();
        window.scrollTo(0, 0);
        return;
      }

      initiatePayment(key, r.token);
      return;
    }

    if (expired) return;
    handleCheckoutError(r);
  }

  function initiatePayment(key, token) {
    Commerce.checkout.startPayment(token).then(function (res) {
      var expired = key !== state.submit.key;

      if (res.kind !== 'failed') {
        if (expired) { flash('訂單已送出，請至付款頁完成付款'); return; }
        state.submit.status = 'redirecting';
        render();
        Commerce.checkout.redirectToPayment(res);
        return;
      }

      if (expired) return;
      state.submit.paymentIssue = 'init-failed';
      state.submit.status = 'idle';
      state.done = true;
      render();
      window.scrollTo(0, 0);
    });
  }

  // A 422 pointing at /items/N or /cart means the server rejected a line
  // (sold out, deactivated, unknown SKU). Re-read the catalogue, let the
  // cart store drop what can't be bought, and tell the visitor plainly.
  function recoverFromCartRejection() {
    state.submit.status = 'idle';
    state.submit.error = '';
    Commerce.loadCatalog().then(function (r) {
      var rc = { removed: 0, soldOut: 0 };
      if (r.ok) {
        state.catalog.products = r.products;
        state.catalog.shippingMethods = r.shippingMethods;
        state.catalog.categories = r.categories;
        state.catalog.featuredSlugs = r.featuredSlugs;
        state.catalog.status = 'ready';
        rc = Commerce.cart.reconcile(r.products);
      }
      if (Commerce.cart.isEmpty()) {
        flash('購物袋中的商品已售完或下架，請重新挑選');
        go('#/shop');
        return;
      }
      state.step = 2;
      state.submit.status = 'error';
      state.submit.error = (rc.soldOut || rc.removed)
        ? '部分商品已售完或下架，已從購物袋移除，請確認後重新送出'
        : '部分商品庫存不足，已更新購物袋數量，請確認後重新送出';
      render();
    });
  }

  function handleCheckoutError(r) {
    var status = r.status, code = r.code, details = r.details || [];

    if (status === 422 && code === 'validation_failed' && details.length) {
      state.submit.status = 'idle';
      state.submit.error = '';
      var handledField = false, sendToShop = false, sendToShip = false;

      details.forEach(function (d) {
        var f = POINTER_FIELD[d.pointer];
        if (f) {
          state.errors[f] = FIELD_MESSAGES[f] || d.message || '請確認這個欄位';
          state.step = (f === 'date') ? 1 : 0;
          handledField = true;
        } else if (d.pointer === '/shipping_method_id') {
          sendToShip = true;
        } else if (d.pointer === '/cart' || /^\/items\//.test(d.pointer)) {
          sendToShop = true;
        }
      });

      if (sendToShop) { recoverFromCartRejection(); return; }
      if (sendToShip) { state.step = 1; flash('請重新選擇配送方式'); }
      if (!handledField && !sendToShip) state.submit.error = r.message || '請確認輸入內容';
      render();
      return;
    }

    if (status === 422 && code === 'checkout_unavailable') {
      state.submit.status = 'error';
      state.submit.error = '目前無法為此帳號完成結帳，請與我們聯繫';
      render();
      return;
    }

    if (status === 429) {
      state.submit.status = 'error';
      state.submit.error = '請求過於頻繁，請稍後再試';
      render();
      return;
    }

    // 404 unknown_publishable_key, 500/503, network failure, timeout: unknown
    // or configuration-level failure, retryable from the visitor's POV.
    state.submit.status = 'error';
    state.submit.error = '訂單送出失敗，請檢查網路連線後重試';
    render();
  }

  function loadOrderStatus() {
    state.orderStatus = { status: 'loading', order: null, error: '' };
    Commerce.checkout.loadOrderStatus().then(function (r) {
      if (state.route !== 'order-status') return; // visitor moved on — don't fight the current screen
      if (r.ok) {
        state.orderStatus = { status: 'ready', order: r.order, error: '' };
      } else if (r.reason === 'no_token') {
        state.orderStatus = {
          status: 'error', order: null,
          error: '找不到這筆訂單的存取資訊。若要查詢歷史訂單，請以下單時填寫的 email 註冊會員。'
        };
      } else {
        state.orderStatus = { status: 'error', order: null, error: r.error };
      }
      render();
    });
  }

  /* ============================================================
     Actions
     ============================================================ */

  var actions = {
    toggleSearch: function () {
      state.searchOpen = !state.searchOpen;
      render();
      if (state.searchOpen) {
        var el = app.querySelector('[data-k="q"]');
        if (el) el.focus();
      }
    },

    openCart: function () { state.cartOpen = true; render(); },
    closeCart: function () { state.cartOpen = false; render(); },

    // Dead links that exist for visual affordance only (e.g. mStoreView's
    // "導航 ›"). A plain `href="#"` with no data-act would slip past the
    // click delegate's preventDefault check and blank out the hash/route —
    // this gives it something to bind to instead.
    noop: function () {},

    // The href does the navigating; clearing the query keeps the chip honest
    // when a search is still active (and re-renders if the hash is unchanged).
    pickCat: function () { state.q = ''; render(); },

    setSort: function (s) { state.sort = s; render(); },
    setSize: function (k) { state.size = k; render(); },
    setPImg: function (i) { state.pImg = parseInt(i, 10) || 0; render(); },
    setShip: function (id) { state.ship = parseInt(id, 10); render(); },

    incQty: function () { state.qty += 1; render(); },
    decQty: function () { state.qty = Math.max(1, state.qty - 1); render(); },

    toggleFaq: function (i) { i = +i; state.faq = state.faq === i ? null : i; render(); },
    togglePInfo: function (i) { i = +i; state.pinfo = state.pinfo === i ? null : i; render(); },

    fav: function (id) {
      id = parseInt(id, 10);
      var i = state.fav.indexOf(id);
      if (i >= 0) state.fav.splice(i, 1); else state.fav.push(id);
      render();
    },

    quickAdd: function (slug) {
      var p = productBySlug(slug);
      if (!p) return;
      var size = firstSellableSize(p);
      if (!size) { flash('這項商品目前已售完'); return; }
      addToCart(p, 1, size, '');
      render();
    },

    addCurrent: function () {
      var p = productBySlug(state.pslug);
      if (!p) return;
      var added = addToCart(p, state.qty, pickSize(p), state.msg);
      state.cartOpen = added && state.mode === 'desktop';
      render();
    },

    lineInc: function (key) { Commerce.cart.inc(key); render(); },
    lineDec: function (key) { Commerce.cart.dec(key); render(); },
    lineRemove: function (key) { Commerce.cart.remove(key); render(); },

    goCheckout: function () {
      if (Commerce.cart.isEmpty()) { flash('購物袋是空的'); return; }
      // applyHash() resets the flow on entering checkout — same path as a
      // direct #/checkout URL, so both starts land in the same state.
      go('#/checkout');
    },

    prevStep: function () {
      if (submitLocked()) return;
      if (state.step === 0) { go('#/shop'); return; }
      state.step -= 1;
      state.errors = {};
      render();
    },

    nextStep: function () {
      if (submitLocked()) return;
      var f = state.form, er = {};

      if (state.step === 0) {
        if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(f.email)) er.email = FIELD_MESSAGES.email;
        if (!f.name.trim()) er.name = FIELD_MESSAGES.name;
        if (!/^09\d{8}$/.test(f.phone.replace(/[\s-]/g, ''))) er.phone = FIELD_MESSAGES.phone;
        if (f.addr.trim().length < 6) er.addr = FIELD_MESSAGES.addr;
      }

      if (state.step === 1) {
        if (state.catalog.status === 'ready' && state.catalog.shippingMethods.length && state.ship == null) {
          flash('請選擇配送方式');
          return;
        }
        if (!f.date) er.date = FIELD_MESSAGES.date;
        else if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) er.date = '日期格式不正確';
        else if (f.date < todayStr()) er.date = '到貨日不能是過去的日期';
      }

      state.errors = er;
      if (Object.keys(er).length) { render(); return; }

      if (state.step < 2) { state.step += 1; render(); return; }

      submitOrder();
    },

    retryCatalog: function () { loadCatalog(); render(); },

    subscribe: function () {
      var ok = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(state.email);
      state.emailOk = ok;
      state.emailMsg = ok ? CONTENT.newsletter.success : '請輸入有效的 email';
      if (ok) state.email = '';
      render();
    }
  };

  /* ============================================================
     Wiring
     ============================================================ */

  app.addEventListener('click', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;

    var act = el.dataset.act;
    if (act.indexOf('input:') === 0) return; // inputs handled below

    var fn = actions[act];
    if (!fn) return;

    // Let real links navigate; swallow the click for "#" placeholders and buttons.
    var href = el.getAttribute('href');
    var isRealLink = href && href !== '#';
    if (!isRealLink) e.preventDefault();

    fn(el.dataset.a);
  });

  app.addEventListener('input', function (e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var parts = el.dataset.act.split(':');
    if (parts[0] !== 'input') return;

    var val = el.value;

    if (parts[1] === 'form') {
      state.form[parts[2]] = val;
      if (state.errors[parts[2]]) { delete state.errors[parts[2]]; render(); }
      return; // no re-render needed while typing
    }

    if (parts[1] === 'q') {
      state.q = val;
      // A query searches the whole catalogue, so land on the unfiltered shop.
      if (val && (state.route !== 'shop' || state.cat !== '全部')) { go('#/shop'); return; }
      render();
      return;
    }

    if (parts[1] === 'email') { state.email = val; return; }
    if (parts[1] === 'msg') { state.msg = val; return; }
  });

  window.addEventListener('hashchange', function () { applyHash(); render(); });

  window.addEventListener('resize', function () {
    // The layout follows the viewport, and nothing else can pin it.
    var next = window.innerWidth < MOBILE_BP ? 'mobile' : 'desktop';
    if (next === state.mode) return;
    state.mode = next;
    // The phone layout has no search field, so never carry a query into it.
    if (next === 'mobile') { state.q = ''; state.searchOpen = false; }
    render();
  });

  /* ---------- Boot ---------- */

  document.documentElement.style.setProperty('--accent', CONFIG.accent);
  loadCatalog();

  // Content changes after boot (a slow first response, a revalidation, a preview) swap the copy and repaint.
  Commerce.content.onChange(function () { applyPlatformContent(); render(); });

  // First paint: wait for the content request, but at most CONTENT_BUDGET_MS, so the defaults are not shown and then
  // replaced when the network is healthy, and a dead API never blocks the page.
  function boot() {
    if (booted) return;
    booted = true;
    applyPlatformContent(); // never throws (falls back to the defaults)
    // A visitor bounced back from an off-site payment page with no more
    // specific return target lands here with a stored order-access token —
    // route them to the order-status check rather than the homepage.
    if (!location.hash) location.replace(Commerce.checkout.getOrderToken() ? '#/order-status' : '#/');
    applyHash();
    render();
  }
  Promise.race([
    Commerce.content.ready(CONTENT_KEYS),
    new Promise(function (resolve) { setTimeout(resolve, CONTENT_BUDGET_MS); })
  ]).then(boot, boot);
})();
