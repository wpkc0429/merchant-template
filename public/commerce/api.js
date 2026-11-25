/* ============================================================
   commerce/api.js — LOCKED COMMERCE LAYER (do not edit from design work).

   Platform API client: publishable key, timeout, never-throws fetch
   wrapper, catalogue loading, money formatting, SKU availability.
   Exposes the documented surface on window.ShopCommerce (see
   commerce/public-api.json). Nothing outside public/commerce/ may touch
   the API directly, or read config.apiBase / config.publishableKey.
   ============================================================ */
(function (root) {
  'use strict';
  var C = root.ShopCommerce = root.ShopCommerce || {};
  var CONFIG = root.SHOP_CONFIG || {};

  function apiUrl(path) { return String(CONFIG.apiBase || '').replace(/\/+$/, '') + path; }

  // Shared fetch wrapper: injects the publishable key, an optional bearer
  // token or extra headers, JSON-encodes a body, applies a 15s timeout (opts.timeoutMs overrides) and
  // never throws. Callers get {status, data}; status 0 = network failure /
  // timeout / unparseable response. (Internal: shared via C._internal.)
  function apiFetch(path, opts) {
    opts = opts || {};
    var headers = { 'X-Publishable-Key': CONFIG.publishableKey };
    if (opts.headers) { for (var k in opts.headers) headers[k] = opts.headers[k]; }
    if (opts.auth) headers['Authorization'] = 'Bearer ' + opts.auth;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    var controller = root.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, opts.timeoutMs || 15000);

    return fetch(apiUrl(path), {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller ? controller.signal : undefined
    }).then(function (res) {
      // 304 and other bodiless answers have no JSON: data stays null. `etag` lets the content loader revalidate.
      return res.json().catch(function () { return null; }).then(function (data) {
        return { status: res.status, data: data, etag: res.headers && res.headers.get ? res.headers.get('ETag') : null };
      });
    }).catch(function () {
      return { status: 0, data: null };
    }).then(function (r) {
      clearTimeout(timer);
      return r;
    });
  }

  function describeApiError(r) {
    if (r.status === 404) return '商店設定有誤（publishable key 無效），請聯絡網站管理者';
    if (r.status === 503) return '商店目前無法使用，請稍後再試';
    if (r.status === 0) return '網路連線失敗，請檢查網路後重新整理';
    return '伺服器發生錯誤，請稍後再試';
  }

  function money(n) { return 'NT$' + n.toLocaleString('en-US'); }

  // A SKU can be bought when the platform says it is active and has stock.
  // The public API exposes both `is_active` and `stock_qty` on every SKU.
  // (stock_qty is a snapshot, not a reservation: checkout can still 422.)
  function isSkuSellable(sku) {
    return !!sku && sku.is_active !== false && !(typeof sku.stock_qty === 'number' && sku.stock_qty <= 0);
  }

  // Flat list of categories derived from the products themselves; used only
  // when GET /shop/categories is unavailable.
  function categoriesFromProducts(products) {
    var seen = {}, out = [];
    products.forEach(function (p) {
      (p.categories || []).forEach(function (c) {
        if (!seen[c.slug]) {
          seen[c.slug] = true;
          out.push({ id: c.id, name: c.name, slug: c.slug, parent_id: null, position: out.length, children: [] });
        }
      });
    });
    return out;
  }

  // Origins of the product images the platform returned. The content loader treats them, plus the optional
  // SHOP_CONFIG.imageOrigin, as the only hosts an `image` content value may point to.
  var imageOrigins = {};
  function noteImageOrigins(products) {
    products.forEach(function (p) {
      (p.images || []).forEach(function (im) {
        var u = im && im.urls;
        if (!u) return;
        ['thumb', 'large'].forEach(function (k) {
          try { var o = new URL(u[k]); if (o.protocol === 'https:' || o.protocol === 'http:') imageOrigins[o.origin] = true; } catch (e) { /* not a URL */ }
        });
      });
    });
  }

  function fetchAllProducts() {
    var all = [];
    function page(n) {
      return apiFetch('/api/v1/shop/products?page_size=100&page=' + n).then(function (r) {
        if (r.status !== 200 || !r.data || !Array.isArray(r.data.products)) return { failed: r };
        all = all.concat(r.data.products);
        if (r.data.products.length && all.length < (r.data.total || 0) && n < 20) return page(n + 1);
        return { products: all };
      });
    }
    return page(1);
  }

  // Resolves to { ok, products, shippingMethods, categories, featuredSlugs, error }.
  // `categories` is the public category tree (CategoryNode[]).
  C.loadCatalog = function () {
    return Promise.all([
      fetchAllProducts(),
      apiFetch('/api/v1/shop/shipping-methods'),
      apiFetch('/api/v1/shop/categories'),
      // Ordered product slugs of the featured category (server-side order,
      // includes subcategories). Failure just means "no featured picks".
      apiFetch('/api/v1/shop/products?page_size=12&category=' + encodeURIComponent(CONFIG.featuredCategory || ''))
    ]).then(function (res) {
      var pr = res[0], sr = res[1], cr = res[2], fr = res[3];
      if (pr.failed) return { ok: false, error: describeApiError(pr.failed) };
      noteImageOrigins(pr.products);
      if (!(sr.status === 200 && sr.data && Array.isArray(sr.data.shipping_methods))) {
        return { ok: false, error: describeApiError(sr) };
      }
      var cats = (cr.status === 200 && cr.data && Array.isArray(cr.data.categories))
        ? cr.data.categories : categoriesFromProducts(pr.products);
      var featured = (fr.status === 200 && fr.data && Array.isArray(fr.data.products))
        ? fr.data.products.map(function (p) { return p.slug; }) : [];
      return {
        ok: true, products: pr.products, shippingMethods: sr.data.shipping_methods,
        categories: cats, featuredSlugs: featured, error: ''
      };
    });
  };

  C.money = money;
  C.describeApiError = describeApiError;
  C.isSkuSellable = isSkuSellable;
  C._internal = { apiFetch: apiFetch, config: CONFIG, imageOrigins: imageOrigins };
})(window);
