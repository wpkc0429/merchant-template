/* ============================================================
   commerce/cart.js — LOCKED COMMERCE LAYER (do not edit from design work).

   Cart store. Lines are snapshots (name / thumb url / size / unit price)
   persisted in localStorage under a key namespaced per shop, because the
   SKU ids inside belong to exactly one shop. After the catalogue loads,
   reconcile() drops lines whose SKU no longer exists or can't be bought.
   ============================================================ */
(function (root) {
  'use strict';
  var C = root.ShopCommerce;
  var CONFIG = C._internal.config;

  var LEGACY_KEY = 'shopcommerce:cart';   // pre-namespace key: unscoped, cannot be trusted

  // FNV-1a over the publishable key -> short stable suffix (not a secret).
  function shopSuffix() {
    var s = String(CONFIG.publishableKey || ''), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h.toString(36);
  }
  var KEY = 'shopcommerce:cart:' + shopSuffix();

  // Untrusted browser storage: validate shape line by line.
  function isValidCartLine(l) {
    return !!l && typeof l === 'object' &&
      typeof l.key === 'string' && l.key.length > 0 &&
      typeof l.skuId === 'number' &&
      typeof l.name === 'string' &&
      (l.img === null || typeof l.img === 'string') &&
      typeof l.size === 'string' &&
      typeof l.unitPrice === 'number' && l.unitPrice >= 0 &&
      typeof l.qty === 'number' && l.qty >= 1 &&
      typeof l.msg === 'string';
  }

  function load() {
    // One-time cleanup: the old un-namespaced cart cannot be attributed to a
    // shop, so it is discarded rather than migrated.
    try { localStorage.removeItem(LEGACY_KEY); } catch (e) { /* storage unavailable */ }
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isValidCartLine) : [];
    } catch (e) { return []; }
  }

  var lines = load();

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(lines)); }
    catch (e) { /* storage full / private mode: cart still works in memory */ }
  }

  function find(key) {
    for (var i = 0; i < lines.length; i++) if (lines[i].key === key) return lines[i];
    return null;
  }

  function capFor(sku) { return typeof sku.stock_qty === 'number' ? sku.stock_qty : null; }

  C.cart = {
    lines: function () { return lines.slice(); },
    count: function () { return lines.reduce(function (a, l) { return a + l.qty; }, 0); },
    subtotal: function () { return lines.reduce(function (a, l) { return a + l.unitPrice * l.qty; }, 0); },
    isEmpty: function () { return lines.length === 0; },

    // -> { ok: true } | { ok: false, reason: 'sold_out' | 'stock_limit' | 'no_sku' }
    add: function (product, sku, sizeKey, qty, msg, img) {
      if (!sku) return { ok: false, reason: 'no_sku' };
      if (!C.isSkuSellable(sku)) return { ok: false, reason: 'sold_out' };
      msg = msg || '';
      // merge key = sku_id + gift_message, same as the platform's cart merge key
      var key = sku.id + '::' + msg;
      var existing = find(key);
      var cap = capFor(sku);
      if (cap !== null && (existing ? existing.qty : 0) + qty > cap) return { ok: false, reason: 'stock_limit' };
      if (existing) { existing.qty += qty; existing.max = cap; }
      else {
        lines.push({
          key: key, skuId: sku.id, productId: product.id, slug: product.slug,
          name: product.title, img: img || null, size: sizeKey,
          unitPrice: sku.price_amount, qty: qty, msg: msg, max: cap
        });
      }
      persist();
      return { ok: true };
    },
    inc: function (key) {
      var l = find(key);
      if (l && (typeof l.max !== 'number' || l.qty < l.max)) l.qty += 1;
      persist();
    },
    dec: function (key) { var l = find(key); if (l) l.qty = Math.max(1, l.qty - 1); persist(); },
    remove: function (key) { lines = lines.filter(function (l) { return l.key !== key; }); persist(); },
    clear: function () { lines = []; persist(); },

    // Reconcile with the freshly loaded catalogue. Lines whose SKU id does
    // not exist in this shop's catalogue are discarded silently (stale data
    // from another shop / deleted SKU). Lines whose SKU exists but is sold
    // out are dropped and counted; surviving lines get current price/stock.
    // -> { removed: n, soldOut: n }
    reconcile: function (products) {
      var skus = {};
      products.forEach(function (p) {
        (p.skus || []).forEach(function (s) { skus[s.id] = { sku: s, product: p }; });
      });
      var removed = 0, soldOut = 0;
      lines = lines.filter(function (l) {
        var hit = skus[l.skuId];
        if (!hit) { removed++; return false; }
        if (!C.isSkuSellable(hit.sku)) { soldOut++; return false; }
        l.unitPrice = hit.sku.price_amount;
        l.max = capFor(hit.sku);
        if (typeof l.max === 'number' && l.qty > l.max) l.qty = l.max;
        l.name = hit.product.title;
        return true;
      });
      if (removed || soldOut) persist();
      return { removed: removed, soldOut: soldOut };
    }
  };
})(window);
