/* ============================================================
   commerce/content.js — LOCKED COMMERCE LAYER (do not edit from design work).

   Platform content store consumer: the published content documents (GET /api/v1/shop/content?include=content),
   plus the SAFE RENDERING HELPERS the design layer must use to put content on the page.

   Loading   ShopCommerce.content.ready(keys?) starts ONE request (publishable key, If-None-Match revalidation with the
             ETag, 6 s timeout) and resolves, never rejects, when it settled or failed. Failure (network, 5xx, 429,
             timeout, bad shape) keeps the last good content, or nothing: the design layer then falls back to its own
             defaults (public/content.js). A missing key is not an error: get(key) is simply null.
   Cache     in memory, plus a 5 minute sessionStorage copy of the PUBLISHED response (shape-validated on read, per shop,
             key "shopcommerce:content:<shop hash>"). Preview responses are never cached, persisted or revalidated.
   Preview   ?content_preview=<token> is removed from the URL at once (history.replaceState), kept in memory only, and sent
             as the X-Preview-Token header to GET /api/v1/shop/content/{key}/preview for every key that is published or
             that the design layer asked for in ready(keys). A banner (#shop-preview-banner) is shown.
   Safety    text(el, v) textContent only; richText(el, html) rebuilds the DOM from the platform allowlist
             (commerce/content-allowlist.js); link/safeHref accept http, https, mailto, tel and relative paths only;
             image/safeImageSrc accept only the image origins the platform itself returned (catalogue image URLs) or
             SHOP_CONFIG.imageOrigin. Content is never put into script, event attributes or style.
   ============================================================ */
(function (root) {
  'use strict';
  var C = root.ShopCommerce = root.ShopCommerce || {};
  var I = C._internal;
  var AL = I.allowlist;
  var CONFIG = I.config;
  var apiFetch = I.apiFetch;

  var FETCH_TIMEOUT_MS = 6000;
  var CACHE_TTL_MS = 5 * 60 * 1000;
  var REVALIDATE_AFTER_MS = 60 * 1000;
  var KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
  var MAX_PREVIEW_KEYS = 20;
  var MAX_RICHTEXT = 60000;
  var MAX_DEPTH = 100;

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /* ---------- preview token: take it out of the URL immediately ---------- */

  function takePreviewToken() {
    try {
      var u = new URL(root.location.href);
      if (!u.searchParams.has('content_preview')) return '';
      var t = u.searchParams.get('content_preview') || '';
      u.searchParams.delete('content_preview');
      root.history.replaceState(root.history.state, '', u.pathname + u.search + u.hash);
      return /^[A-Za-z0-9._~+\/=-]{8,4096}$/.test(t) ? t : '';
    } catch (e) { return ''; }
  }

  /* ---------- state ---------- */

  var docs = {};            // key -> { key, type_key, title, content }  (a preview doc replaces the published one)
  var listEtag = '';        // ETag of the last published response we hold (never set from preview)
  var lastCheck = 0;
  var started = false, startPromise = null, wantKeys = [];
  var listeners = [];
  var previewToken = takePreviewToken();
  var previewState = previewToken ? 'pending' : 'off';   // off | pending | active | failed

  /* ---------- URL checks (shared by link, richText, image) ---------- */

  function hasControl(s) { return /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s) || /^\s|\s$/.test(s); }

  // Returns the value when it is a safe link target, else ''. Allowed: the allowlist's url_schemes (http, https, mailto,
  // tel), "#fragment", "/site-path" and plain relative paths. Refused: javascript:, data:, vbscript:, any other scheme,
  // protocol-relative "//host" and "/\host", control characters, leading/trailing whitespace, > 2048 characters.
  function safeHref(v) {
    if (typeof v !== 'string' || !v || v.length > 2048 || hasControl(v)) return '';
    var c0 = v.charAt(0);
    if (c0 === '#') return v;
    if (c0 === '\\') return '';
    if (c0 === '/') return (v.charAt(1) === '/' || v.charAt(1) === '\\') ? '' : v;
    var m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(v);
    if (m) return (AL.url_schemes || []).indexOf(m[1].toLowerCase()) >= 0 ? v : '';
    if (/^[^/?#]*\\/.test(v)) return '';
    return AL.allow_relative_urls ? v : '';
  }

  function imageOriginAllowed(origin) {
    if (I.imageOrigins && has(I.imageOrigins, origin)) return true;
    try { if (CONFIG.imageOrigin && new URL(String(CONFIG.imageOrigin)).origin === origin) return true; } catch (e) { /* ignore */ }
    return false;
  }

  // An image URL is safe when it is absolute, http(s), and its origin is one the platform returned for its own images
  // (catalogue image URLs) or SHOP_CONFIG.imageOrigin. Relative paths and unknown hosts are refused.
  function safeImageSrc(v) {
    if (typeof v !== 'string' || !v || v.length > 2048 || hasControl(v) || /\s/.test(v)) return '';
    var u;
    try { u = new URL(v); } catch (e) { return ''; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    if (u.username || u.password) return '';
    if (!imageOriginAllowed(u.origin)) return '';
    return v;
  }

  /* ---------- safe rendering helpers ---------- */

  function text(el, value) {
    if (el) el.textContent = value == null ? '' : String(value);
    return el;
  }

  function link(el, value) {
    if (!el) return false;
    var h = safeHref(value);
    if (h) { el.setAttribute('href', h); return true; }
    el.removeAttribute('href');
    return false;
  }

  function image(el, value) {
    if (!el) return false;
    var s = safeImageSrc(value);
    if (s) { el.setAttribute('src', s); return true; }
    el.removeAttribute('src');
    return false;
  }

  function attrAllowed(tag, attr, val) {
    var pat = (AL.attribute_patterns || {})[tag + '.' + attr];
    if (pat && !new RegExp(pat).test(val)) return false;
    if (attr === 'href') return !!safeHref(val);
    if (attr === 'src') return !!safeImageSrc(val);
    return true;
  }

  // Rebuild `src` (an inert parsed node) into `dst` using only allowlisted elements/attributes. Unknown elements are
  // unwrapped (children kept), drop_with_content elements vanish with their content, <img> without an allowed src goes.
  function copyNode(src, dst, doc, depth) {
    var kids = src.childNodes || [];
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType === 3) { dst.appendChild(doc.createTextNode(n.data != null ? n.data : n.nodeValue)); continue; }
      if (n.nodeType !== 1) continue;
      var name = String(n.localName || n.nodeName).toLowerCase();
      if ((AL.drop_with_content || []).indexOf(name) >= 0) continue;
      if (depth >= MAX_DEPTH) continue;
      if (!has(AL.elements, name)) { copyNode(n, dst, doc, depth + 1); continue; }
      var out = doc.createElement(name), allowed = AL.elements[name];
      for (var j = 0; j < allowed.length; j++) {
        var an = allowed[j];
        if (!n.hasAttribute(an)) continue;
        var av = n.getAttribute(an);
        if (attrAllowed(name, an, av)) out.setAttribute(an, av);
      }
      if (name === 'img' && !out.hasAttribute('src')) continue;
      if (name === 'a' && out.hasAttribute('target')) out.setAttribute('rel', 'noopener noreferrer');
      copyNode(n, out, doc, depth + 1);
      dst.appendChild(out);
    }
  }

  // Replace the children of `target` with the sanitised rendering of `html`. Returns the target.
  function richText(target, html) {
    if (!target) return target;
    while (target.firstChild) target.removeChild(target.firstChild);
    if (typeof html !== 'string' || !html) return target;
    var doc = target.ownerDocument || root.document;
    var parsed;
    try {
      parsed = new root.DOMParser().parseFromString(html.slice(0, MAX_RICHTEXT), 'text/html');   // inert: nothing runs or loads
    } catch (e) { return target; }
    copyNode(parsed.body, target, doc, 0);
    return target;
  }

  /* ---------- fetching ---------- */

  function validDocs(data) {
    if (!data || !Array.isArray(data.documents)) return null;
    var out = {};
    data.documents.forEach(function (d) {
      if (isObj(d) && typeof d.key === 'string' && KEY_RE.test(d.key) && isObj(d.content)) {
        out[d.key] = { key: d.key, type_key: String(d.type_key || ''), title: String(d.title || ''), content: d.content };
      }
    });
    return out;
  }

  function sameDocs(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function notify() {
    listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { /* a listener must not break the loader */ } });
  }

  function shopSuffix() {
    var s = String(CONFIG.publishableKey || ''), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h.toString(36);
  }
  var CACHE_KEY = 'shopcommerce:content:' + shopSuffix();

  // Untrusted browser storage: validate the shape, the age and every document.
  function readCache() {
    try {
      var c = JSON.parse(root.sessionStorage.getItem(CACHE_KEY) || 'null');
      if (!isObj(c) || typeof c.t !== 'number' || typeof c.etag !== 'string' || !isObj(c.docs)) return null;
      if (Date.now() - c.t > CACHE_TTL_MS || c.t > Date.now() + 60000) return null;
      var out = {};
      Object.keys(c.docs).forEach(function (k) {
        var d = c.docs[k];
        if (KEY_RE.test(k) && isObj(d) && isObj(d.content)) out[k] = { key: k, type_key: String(d.type_key || ''), title: String(d.title || ''), content: d.content };
      });
      return { etag: c.etag, docs: out };
    } catch (e) { return null; }
  }

  function writeCache() {
    if (previewState !== 'off') return;
    try { root.sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), etag: listEtag, docs: docs })); } catch (e) { /* storage unavailable */ }
  }

  // One published-content request. Resolves 'updated' | 'same' | 'failed'. Never throws.
  function fetchPublished() {
    lastCheck = Date.now();
    var headers = {};
    if (listEtag && previewState === 'off') headers['If-None-Match'] = listEtag;
    return apiFetch('/api/v1/shop/content?include=content', { headers: headers, timeoutMs: FETCH_TIMEOUT_MS }).then(function (r) {
      if (r.status === 304) return 'same';
      if (r.status !== 200) return 'failed';                // 404 (unknown key), 429, 5xx, network (0): keep what we have
      var next = validDocs(r.data);
      if (!next) return 'failed';
      var changed = !sameDocs(next, docs) || listEtag !== (r.etag || '');
      docs = next;
      listEtag = r.etag || '';
      writeCache();
      return changed ? 'updated' : 'same';
    }).catch(function () { return 'failed'; });
  }

  function showBanner() {
    var d = root.document;
    if (!d || !d.body || previewState === 'off') return;
    var b = d.getElementById('shop-preview-banner');
    if (!b) {
      b = d.createElement('div');
      b.id = 'shop-preview-banner';
      b.className = 'shop-preview-banner';
      b.setAttribute('role', 'status');
      b.setAttribute('style', 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:8px 12px;background:#111;color:#fff;font:14px/1.4 sans-serif;text-align:center');
      d.body.appendChild(b);
    }
    b.textContent = previewState === 'failed'
      ? '預覽已失效或無法載入，目前顯示的是已發佈內容'
      : '預覽中：目前顯示的是尚未發佈的草稿內容';
  }

  // Preview: the published documents first (for the key list and as the fallback), then each draft with the token.
  function fetchPreview() {
    return fetchPublished().then(function () {
      var keys = Object.keys(docs).concat(wantKeys).filter(function (k, i, a) { return KEY_RE.test(k) && a.indexOf(k) === i; }).slice(0, MAX_PREVIEW_KEYS);
      return Promise.all(keys.map(function (k) {
        return apiFetch('/api/v1/shop/content/' + encodeURIComponent(k) + '/preview', { headers: { 'X-Preview-Token': previewToken }, timeoutMs: FETCH_TIMEOUT_MS })
          .then(function (r) { return { k: k, r: r }; });
      })).then(function (res) {
        var ok = 0, denied = 0;
        res.forEach(function (x) {
          if (x.r.status === 200 && x.r.data && isObj(x.r.data.content)) {
            docs[x.k] = { key: x.k, type_key: String(x.r.data.type_key || ''), title: String(x.r.data.title || ''), content: x.r.data.content };
            ok++;
          } else if (x.r.status === 401 || x.r.status === 403) denied++;
        });
        previewState = ok > 0 || !denied ? 'active' : 'failed';
        showBanner();
        return 'updated';
      });
    }).catch(function () { previewState = 'failed'; showBanner(); return 'failed'; });
  }

  function start() {
    if (previewToken) {
      // Preview responses are never written to the cache; the published fetch above runs with previewState !== 'off'.
      return fetchPreview().then(function () { notify(); });
    }
    var cached = readCache();
    if (cached) {
      docs = cached.docs; listEtag = cached.etag;
      // A fresh copy is used at once (no wait, no flash) and revalidated in the background.
      fetchPublished().then(function (s) { if (s === 'updated') notify(); });
      return Promise.resolve();
    }
    return fetchPublished().then(function (s) { if (s === 'updated') notify(); });
  }

  function ready(keys) {
    if (!started) {
      started = true;
      if (Array.isArray(keys)) wantKeys = keys.filter(function (k) { return typeof k === 'string'; });
      startPromise = start().catch(function () { /* never rejects */ });
      var d = root.document;
      if (d && d.addEventListener) {
        d.addEventListener('visibilitychange', function () {
          if (d.visibilityState === 'visible' && !previewToken && Date.now() - lastCheck > REVALIDATE_AFTER_MS) {
            fetchPublished().then(function (s) { if (s === 'updated') notify(); });
          }
        });
        if (previewToken) {
          if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', showBanner);
          else showBanner();
        }
      }
    }
    return startPromise;
  }

  function get(key) { return typeof key === 'string' && has(docs, key) ? docs[key].content : null; }
  function all() { var o = {}; Object.keys(docs).forEach(function (k) { o[k] = docs[k].content; }); return o; }
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () { var i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
  }
  function isPreview() { return previewState === 'active' || previewState === 'pending'; }

  C.content = {
    ready: ready, all: all, get: get, onChange: onChange, isPreview: isPreview,
    text: text, richText: richText, link: link, image: image,
    safeHref: safeHref, safeImageSrc: safeImageSrc
  };
})(window);
