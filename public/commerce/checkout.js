/* ============================================================
   commerce/checkout.js — LOCKED COMMERCE LAYER (do not edit from design work).

   Guest checkout, payment creation + redirect (ECPay redirect_form POST or
   redirect_url), and the order-status lookup. Price is decided by the
   server; the client sends no amounts. The design layer owns all screens,
   copy and field-level messages; it only consumes the plain results below.
   ============================================================ */
(function (root) {
  'use strict';
  var C = root.ShopCommerce;
  var apiFetch = C._internal.apiFetch;

  var ORDER_TOKEN_KEY = 'shopcommerce:orderAccessToken';
  var ORDER_ID_KEY = 'shopcommerce:orderAccessOrderId';

  function storeOrderAccess(token, orderId) {
    try {
      if (token) sessionStorage.setItem(ORDER_TOKEN_KEY, token);
      if (orderId != null) sessionStorage.setItem(ORDER_ID_KEY, String(orderId));
    } catch (e) { /* sessionStorage unavailable (privacy mode etc.): non-fatal */ }
  }

  function getOrderToken() {
    try { return sessionStorage.getItem(ORDER_TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function submitPaymentForm(f) {
    var form = document.createElement('form');
    form.method = f.method;
    form.action = f.action;
    Object.keys(f.fields || {}).forEach(function (name) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = f.fields[name];
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  }

  C.checkout = {
    // Fresh idempotency key for one checkout attempt.
    newKey: function () {
      if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
      // randomUUID needs a secure context; fall back for non-secure local previews.
      return 'k-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    },

    getOrderToken: getOrderToken,

    // opts: { key, form: {email,name,phone,addr,date}, shipId }  (items come from the cart store)
    // -> { kind:'created', order:{id,subtotal,shipFee,total}, token }
    //  | { kind:'error', status, code, details:[{pointer,message}], message }
    // On 'created' the cart is cleared here: the order exists server-side
    // whether or not the caller still cares about the response.
    placeOrder: function (opts) {
      var f = opts.form;
      var body = {
        email: f.email,
        items: C.cart.lines().map(function (l) {
          return { sku_id: l.skuId, quantity: l.qty, gift_message: l.msg || '' };
        }),
        shipping_address: { recipient_name: f.name, phone: f.phone, line1: f.addr },
        shipping_method_id: opts.shipId || null,
        requested_delivery_date: f.date || null
      };
      return apiFetch('/api/v1/shop/guest/checkout', {
        method: 'POST', headers: { 'Idempotency-Key': opts.key }, body: body
      }).then(function (r) {
        if (r.status === 201 && r.data && r.data.order) {
          var o = r.data.order, token = r.data.order_access_token || '';
          C.cart.clear();
          storeOrderAccess(token, o.id);
          return {
            kind: 'created',
            order: { id: o.id, subtotal: o.subtotal_amount, shipFee: o.shipping_fee, total: o.total_amount },
            token: token
          };
        }
        var err = (r.data && r.data.error) || {};
        return { kind: 'error', status: r.status, code: err.code || '', details: err.details || [], message: err.message || '' };
      });
    },

    // -> { kind:'form', form } | { kind:'url', url } | { kind:'failed' }
    startPayment: function (token) {
      return apiFetch('/api/v1/shop/guest/order/payments', { method: 'POST', auth: token }).then(function (r) {
        var d = r.status === 201 && r.data;
        if (d && d.redirect_form) return { kind: 'form', form: d.redirect_form };
        if (d && d.redirect_url) return { kind: 'url', url: d.redirect_url };
        return { kind: 'failed' };
      });
    },

    // Leaves the page: POSTs the ECPay form, or navigates to the URL.
    redirectToPayment: function (result) {
      if (result.kind === 'form') submitPaymentForm(result.form);
      else if (result.kind === 'url') root.location.href = result.url;
    },

    // -> { ok:true, order } | { ok:false, reason:'no_token' | 'api', error }
    loadOrderStatus: function () {
      var token = getOrderToken();
      if (!token) return Promise.resolve({ ok: false, reason: 'no_token', error: '' });
      return apiFetch('/api/v1/shop/guest/order', { auth: token }).then(function (r) {
        if (r.status === 200 && r.data) return { ok: true, order: r.data };
        return { ok: false, reason: 'api', error: C.describeApiError(r) };
      });
    }
  };

  Object.freeze(C.cart);
  Object.freeze(C.checkout);
  Object.freeze(C);
})(window);
