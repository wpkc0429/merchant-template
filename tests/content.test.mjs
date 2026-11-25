// Tests for the storefront content store consumer (public/commerce/content.js, content-allowlist.*) and its safety helpers.
// Node only: a tiny DOM shim (tests/mini-dom.mjs) stands in for the browser; the real-browser run is tests/e2e/content-storefront.mjs.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import path from 'node:path';
import { TEMPLATE } from './helpers.mjs';
import { makeWindow, parseHtml, MiniDocument } from './mini-dom.mjs';

const COMMERCE = path.join(TEMPLATE, 'public', 'commerce');
const rd = (f) => readFileSync(path.join(COMMERCE, f), 'utf8').replace(/\r\n/g, '\n');
// sha256 of the platform's api/internal/cms/richtext/allowlist.json (ecommerce repo), recorded when it was copied (2026-11-25).
const PLATFORM_ALLOWLIST_SHA256 = '61b53075c279364f7d1382f877c6a8d0d3d23e50b837e5c3c80d337e1c528541';
const sha = (t) => createHash('sha256').update(t).digest('hex');

/** content.js loaded in a vm context with the DOM shim and a fake apiFetch. */
function load(opts = {}) {
  const calls = [];
  const apiFetch = opts.apiFetch
    ? (p, o) => { calls.push({ path: p, headers: { ...(o && o.headers) } }); return Promise.resolve().then(() => opts.apiFetch(p, o, calls.length)); }
    : () => Promise.resolve({ status: 0, data: null });
  const w = makeWindow({ ...opts, apiFetch });
  vm.createContext(w.win);
  vm.runInContext(rd('content-allowlist.js'), w.win, { filename: 'content-allowlist.js' });
  vm.runInContext(rd('content.js'), w.win, { filename: 'content.js' });
  return { ...w, C: w.win.ShopCommerce.content, calls, AL: w.win.ShopCommerce._internal.allowlist };
}
const docs = (o) => ({ documents: Object.entries(o).map(([key, content]) => ({ key, type_key: key, title: key, published_at: null, etag: '"x"', content, meta: {} })) });
const ok = (data, etag = '"e1"') => ({ status: 200, data, etag });

describe('allowlist copy', () => {
  test('content-allowlist.json is a byte copy of the platform file (recorded sha256)', () => {
    assert.equal(sha(rd('content-allowlist.json')), PLATFORM_ALLOWLIST_SHA256, 'allowlist.json changed: re-copy it from ecommerce api/internal/cms/richtext/allowlist.json, regenerate content-allowlist.js, update the recorded hash here and in the js header');
    assert.match(rd('content-allowlist.js'), new RegExp(PLATFORM_ALLOWLIST_SHA256));
  });
  test('the platform checkout (when present) still has the same file', { skip: !existsSync(path.resolve(TEMPLATE, '../ecommerce/api/internal/cms/richtext/allowlist.json')) }, () => {
    const p = readFileSync(path.resolve(TEMPLATE, '../ecommerce/api/internal/cms/richtext/allowlist.json'), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(sha(p), sha(rd('content-allowlist.json')), 'the platform allowlist changed: sync it');
  });
  test('the embedded JS object equals the JSON file', () => {
    const { AL } = load();
    assert.deepEqual(JSON.parse(JSON.stringify(AL)), JSON.parse(rd('content-allowlist.json')));
  });
  test('sanity of the copy: no h1, no style/class/id/on* attribute anywhere', () => {
    const { AL } = load();
    assert.equal('h1' in AL.elements, false);
    for (const [tag, attrs] of Object.entries(AL.elements)) for (const a of attrs) assert.ok(!/^(on|style$|class$|id$)/.test(a), `${tag}.${a}`);
  });
});

describe('content.schema.json vs the allowlist (drift)', () => {
  const schema = JSON.parse(readFileSync(path.join(TEMPLATE, 'public', 'content.schema.json'), 'utf8'));
  const KINDS = ['text', 'textarea', 'richtext', 'image', 'link', 'color', 'select', 'list', 'sections'];
  const fields = [];
  (function walk(n, p) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'string' || n.type === 'array') fields.push({ p, n });
    for (const [k, v] of Object.entries(n.properties || {})) walk(v, `${p}/${k}`);
    if (n.items) walk(n.items, `${p}/*`);
    for (const b of n.oneOf || []) walk(b, `${p}/oneOf`);
  })({ type: 'object', properties: Object.fromEntries(Object.entries(schema.types).map(([k, t]) => [k, t.schema])) }, '');

  test('every x-editor kind is one the platform allows', () => {
    for (const { p, n } of fields) if (n['x-editor']) assert.ok(KINDS.includes(n['x-editor']), `${p}: x-editor ${n['x-editor']}`);
  });
  test('richtext fields: maxLength within the platform bound and defaults only use allowlisted markup', () => {
    const { AL } = load();
    for (const { p, n } of fields.filter((f) => f.n['x-editor'] === 'richtext')) {
      assert.ok(n.maxLength && n.maxLength <= 50000, `${p}: richtext maxLength`);
      const walk = (node) => {
        for (const c of node.childNodes) {
          if (c.nodeType !== 1) continue;
          assert.ok(Object.hasOwn(AL.elements, c.localName), `${p}: default uses <${c.localName}>, which the allowlist lacks`);
          for (const a of c.attrs.keys()) assert.ok(AL.elements[c.localName].includes(a), `${p}: default uses ${c.localName}[${a}], which the allowlist lacks`);
          walk(c);
        }
      };
      walk(parseHtml(new MiniDocument(), String(n.default || '')).body);
    }
  });
  test('every text field of the shop-owned copy is plain text: no markup in a textarea/text default', () => {
    for (const { p, n } of fields.filter((f) => f.n.type === 'string' && f.n['x-editor'] !== 'richtext' && f.n.default)) assert.doesNotMatch(n.default, /<[a-z/]/i, `${p}: default contains markup but the field is plain text`);
  });
});

describe('safe helpers', () => {
  const { C, win } = load({ imageOrigins: { 'https://img.example.com': true, 'http://127.0.0.1:9000': true }, config: { imageOrigin: 'https://cdn.example.org/path' } });
  test('text() uses textContent only', () => {
    const el = win.document.createElement('p');
    C.text(el, '<img src=x onerror=alert(1)>');
    assert.equal(el.childNodes.length, 1); assert.equal(el.childNodes[0].nodeType, 3);
    assert.equal(el.textContent, '<img src=x onerror=alert(1)>');
    C.text(el, null); assert.equal(el.textContent, '');
  });
  test('safeHref accepts http, https, mailto, tel, site paths, fragments and relative paths', () => {
    for (const v of ['https://a.example/x', 'http://a.example', 'mailto:a@b.co', 'tel:+886212345678', '/shop', '#/story', 'about', '?q=1', 'MAILTO:a@b.co', 'HTTPS://A.EXAMPLE']) assert.equal(C.safeHref(v), v, v);
  });
  test('safeHref refuses script-ish, protocol-relative, control-character and oversized values', () => {
    const bad = ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:x', 'blob:https://a/b', 'file:///etc/passwd',
      '//evil.example/x', '/\\evil.example', '\\\\evil.example', 'https://a.example/\u0000', ' https://a.example', 'https://a.example ', '', null, undefined, 5, {}, 'x'.repeat(2049), 'ftp://a.example'];
    for (const v of bad) assert.equal(C.safeHref(v), '', String(v));
  });
  test('link() sets href only when the value passes, otherwise removes it', () => {
    const a = win.document.createElement('a');
    assert.equal(C.link(a, 'https://a.example'), true); assert.equal(a.getAttribute('href'), 'https://a.example');
    assert.equal(C.link(a, 'javascript:alert(1)'), false); assert.equal(a.hasAttribute('href'), false);
  });
  test('image(): only origins the platform returned (catalogue or SHOP_CONFIG.imageOrigin); no relative, no data:, no credentials', () => {
    for (const v of ['https://img.example.com/a.webp', 'http://127.0.0.1:9000/b/a.webp', 'https://cdn.example.org/other/x.png']) assert.equal(C.safeImageSrc(v), v, v);
    for (const v of ['https://evil.example/a.webp', 'https://img.example.com.evil.example/a.webp', 'http://img.example.com/a.webp', '/assets/a.png', 'assets/a.png', '//img.example.com/a.png', 'data:image/png;base64,AAAA', 'javascript:alert(1)',
      'https://user:pw@img.example.com/a.webp', 'https://img.example.com/a b', '', null]) assert.equal(C.safeImageSrc(v), '', String(v));
    const im = win.document.createElement('img');
    assert.equal(C.image(im, 'https://img.example.com/a.webp'), true); assert.equal(im.getAttribute('src'), 'https://img.example.com/a.webp');
    assert.equal(C.image(im, 'https://evil.example/x'), false); assert.equal(im.hasAttribute('src'), false);
  });
});

describe('richText sanitiser', () => {
  const { C, win } = load({ imageOrigins: { 'https://img.example.com': true } });
  const run = (html) => { const el = win.document.createElement('div'); C.richText(el, html); return el.innerHTML; };
  test('keeps allowlisted markup', () => {
    assert.equal(run('<p>Hi <strong>there</strong><br><em>x</em></p><ul><li>a</li></ul>'), '<p>Hi <strong>there</strong><br><em>x</em></p><ul><li>a</li></ul>');
    assert.equal(run('<h2>T</h2><blockquote>q</blockquote><table><tbody><tr><th scope="col" colspan="2">h</th><td rowspan="2">c</td></tr></tbody></table>'),
      '<h2>T</h2><blockquote>q</blockquote><table><tbody><tr><th colspan="2" scope="col">h</th><td rowspan="2">c</td></tr></tbody></table>');
  });
  test('drops script/style/iframe/svg/object/embed/template/textarea/select/title WITH their content', () => {
    for (const t of ['script', 'style', 'iframe', 'noscript', 'object', 'embed', 'template', 'svg', 'math', 'textarea', 'select', 'title']) {
      assert.equal(run(`<p>a</p><${t}>SECRET<b>x</b></${t}><p>b</p>`), '<p>a</p><p>b</p>', t);
    }
  });
  test('removes event handlers, style, class, id and unknown attributes', () => {
    assert.equal(run('<p onclick="x()" style="color:red" class="c" id="i" data-x="1">t</p>'), '<p>t</p>');
    assert.equal(run('<a href="https://a.example" onmouseover="x()" style="x">l</a>'), '<a href="https://a.example">l</a>');
  });
  test('unwraps unknown elements and h1 (children kept)', () => {
    assert.equal(run('<h1>Title</h1><div><span>in</span></div><font>f</font>'), 'Titleinf');
  });
  test('links: bad schemes lose the href, target=_blank gets rel noopener noreferrer, other targets drop', () => {
    assert.equal(run('<a href="javascript:alert(1)">x</a>'), '<a>x</a>');
    assert.equal(run('<a href="//evil.example">x</a>'), '<a>x</a>');
    assert.equal(run('<a href="data:text/html,x">x</a>'), '<a>x</a>');
    assert.equal(run('<a href="/shop" target="_blank">x</a>'), '<a href="/shop" target="_blank" rel="noopener noreferrer">x</a>');
    assert.equal(run('<a href="mailto:a@b.co" target="_self" title="t">x</a>'), '<a href="mailto:a@b.co" title="t">x</a>');
  });
  test('images: https from a known image origin only, otherwise the element is dropped; width/height must be digits', () => {
    assert.equal(run('<img src="https://img.example.com/a.webp" alt="a" width="10" height="x">'), '<img src="https://img.example.com/a.webp" alt="a" width="10">');
    for (const src of ['https://evil.example/a.webp', 'http://img.example.com/a.webp', '/a.png', 'data:image/png;base64,AA', 'javascript:alert(1)']) assert.equal(run(`<p>a<img src="${src}"></p>`), '<p>a</p>', src);
    assert.equal(run('<img alt="no src">'), '');
  });
  test('entities stay text; angle brackets cannot come back as markup', () => {
    assert.equal(run('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    const el = win.document.createElement('div'); C.richText(el, '<p>&lt;b&gt;</p>');
    assert.equal(el.childNodes[0].localName, 'p'); assert.equal(el.textContent, '<b>');
  });
  test('non-string and empty input yields an empty element; an old child is replaced', () => {
    const el = win.document.createElement('div'); C.text(el, 'old');
    C.richText(el, null); assert.equal(el.childNodes.length, 0);
    C.richText(el, '<p>x</p>'); C.richText(el, '<p>y</p>'); assert.equal(el.innerHTML, '<p>y</p>');
  });
  test('absurdly deep nesting does not blow the stack', () => {
    assert.doesNotThrow(() => run('<p>'.repeat(5000) + 'x'));
  });
});

describe('loader: ETag, cache, failure', () => {
  const GOOD = docs({ global: { brand: { name: 'Shop' } }, faq: { items: [] } });

  test('200 stores documents; get() returns content; missing key is null, not an error', async () => {
    const { C, calls } = load({ apiFetch: () => ok(GOOD) });
    await C.ready(['global']);
    assert.deepEqual(C.get('global'), { brand: { name: 'Shop' } });
    assert.equal(C.get('story'), null); assert.equal(C.get(5), null); assert.equal(C.get('__proto__'), null); assert.equal(C.get('constructor'), null);
    assert.deepEqual(Object.keys(C.all()).sort(), ['faq', 'global']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/api/v1/shop/content?include=content');
    assert.equal(calls[0].headers['If-None-Match'], undefined);
  });
  test('ready() is one request however often it is called', async () => {
    const { C, calls } = load({ apiFetch: () => ok(GOOD) });
    await Promise.all([C.ready(), C.ready(), C.ready()]);
    assert.equal(calls.length, 1);
  });
  test('a fresh session copy is used at once and revalidated with If-None-Match; 304 changes nothing and does not notify', async () => {
    const first = load({ apiFetch: () => ok(GOOD, '"abc"') });
    await first.C.ready();
    const key = [...first.store.keys()].find((k) => k.startsWith('shopcommerce:content:'));
    assert.ok(key, 'a session copy was written');
    const second = load({ session: { [key]: first.store.get(key) }, apiFetch: () => ({ status: 304, data: null, etag: '"abc"' }) });
    let changes = 0; second.C.onChange(() => changes++);
    await second.C.ready();
    assert.deepEqual(second.C.get('global'), { brand: { name: 'Shop' } }, 'content is there before the network answers');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(second.calls[0].headers['If-None-Match'], '"abc"');
    assert.equal(changes, 0);
  });
  test('a revalidation that returns new content notifies listeners once; unsubscribe works', async () => {
    const first = load({ apiFetch: () => ok(GOOD, '"abc"') });
    await first.C.ready();
    const key = [...first.store.keys()][0];
    const next = docs({ global: { brand: { name: 'Renamed' } } });
    const second = load({ session: { [key]: first.store.get(key) }, apiFetch: () => ok(next, '"def"') });
    let a = 0, b = 0; second.C.onChange(() => a++); const off = second.C.onChange(() => b++); off();
    await second.C.ready(); await new Promise((r) => setTimeout(r, 10));
    assert.equal(a, 1); assert.equal(b, 0);
    assert.equal(second.C.get('global').brand.name, 'Renamed');
  });
  test('network failure, 5xx, 429, 404, a rejected fetch and malformed bodies keep the (empty) defaults and never reject', async () => {
    for (const r of [{ status: 0, data: null }, { status: 500, data: {} }, { status: 429, data: {} }, { status: 404, data: {} }, { status: 200, data: { documents: 'x' }, etag: '"z"' }, { status: 200, data: null }]) {
      const { C } = load({ apiFetch: () => r });
      await C.ready(); assert.equal(C.get('global'), null);
    }
    const { C } = load({ apiFetch: () => { throw new Error('boom'); } });
    await assert.doesNotReject(C.ready());
    assert.equal(C.get('global'), null);
  });
  test('after a good load a later failure keeps the last good content', async () => {
    let n = 0;
    const { C, win, store } = load({ apiFetch: () => (++n === 1 ? ok(GOOD) : { status: 503, data: null }) });
    await C.ready();
    const key = [...store.keys()][0];
    const again = load({ session: { [key]: store.get(key) }, apiFetch: () => ({ status: 503, data: null }) });
    await again.C.ready(); await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(again.C.get('global'), { brand: { name: 'Shop' } });
    assert.ok(win);
  });
  test('documents with an invalid key or a non-object content are ignored', async () => {
    const data = { documents: [{ key: 'Bad Key', content: {} }, { key: 'ok', content: 'str' }, { key: 'fine', content: { a: 1 } }, { key: '__proto__', content: {} }, null, 3] };
    const { C } = load({ apiFetch: () => ok(data) });
    await C.ready(); assert.deepEqual(Object.keys(C.all()), ['fine']);
  });
  test('a tampered, stale or malformed session copy is ignored', async () => {
    const mk = (v) => load({ session: { 'shopcommerce:content:placeholder': JSON.stringify(v) }, apiFetch: () => ok(GOOD) });
    const probe = load({ apiFetch: () => ok(GOOD) }); await probe.C.ready();
    const key = [...probe.store.keys()][0];
    const good = JSON.parse(probe.store.get(key));
    for (const bad of [{ ...good, t: Date.now() - 6 * 60 * 1000 }, { ...good, t: 'x' }, { ...good, docs: [] }, { ...good, etag: 5 }, 'junk', null, { ...good, t: Date.now() + 3600e3 }]) {
      const l = load({ session: { [key]: typeof bad === 'string' ? bad : JSON.stringify(bad) }, apiFetch: () => ({ status: 0, data: null }) });
      await l.C.ready(); await new Promise((r) => setTimeout(r, 5));
      assert.equal(l.C.get('global'), null, JSON.stringify(bad)?.slice(0, 40));
      assert.equal(l.calls[0].headers['If-None-Match'], undefined);
    }
    assert.ok(mk);
  });
});

describe('preview mode', () => {
  const PUB = docs({ global: { brand: { name: 'Published' } }, home: { hero: { title: 'P' } } });
  const apiFetch = (p, o) => {
    if (p.startsWith('/api/v1/shop/content?')) return ok(PUB);
    const m = /^\/api\/v1\/shop\/content\/([a-z0-9-]+)\/preview$/.exec(p);
    if (m && o.headers['X-Preview-Token'] === 'tok-preview-1') return { status: 200, data: { key: m[1], type_key: m[1], title: m[1], schema_version: 1, content: { draft: m[1] }, meta: {}, status: 0, draft_rev: 2, preview: true } };
    return { status: 403, data: null };
  };

  test('the token leaves the URL at once (other params and the hash stay) and is never persisted or cached', async () => {
    const { C, win, calls, store, doc } = load({ href: 'http://localhost:8788/?content_preview=tok-preview-1&x=1#/story', apiFetch });
    assert.equal(win.location.href, 'http://localhost:8788/?x=1#/story');
    await C.ready(['global', 'story']);
    assert.equal(C.isPreview(), true);
    assert.deepEqual(C.get('global'), { draft: 'global' });
    assert.deepEqual(C.get('story'), { draft: 'story' });
    assert.equal(store.size, 0, 'nothing written to sessionStorage');
    assert.ok(calls.every((c) => c.headers['If-None-Match'] === undefined));
    const pv = calls.filter((c) => c.path.endsWith('/preview'));
    assert.deepEqual(pv.map((c) => c.path).sort(), ['/api/v1/shop/content/global/preview', '/api/v1/shop/content/home/preview', '/api/v1/shop/content/story/preview']);
    assert.ok(pv.every((c) => c.headers['X-Preview-Token'] === 'tok-preview-1'));
    assert.ok(!calls.some((c) => c.path.includes('tok-preview-1')), 'the token is never in a URL');
    const banner = doc.getElementById('shop-preview-banner');
    assert.ok(banner); assert.match(banner.textContent, /預覽中/);
  });
  test('a token the platform refuses falls back to the published content and says the preview failed', async () => {
    const { C, doc } = load({ href: 'http://localhost:8788/?content_preview=tok-expired-99', apiFetch });
    await C.ready();
    assert.equal(C.isPreview(), false);
    assert.deepEqual(C.get('global'), { brand: { name: 'Published' } });
    assert.match(doc.getElementById('shop-preview-banner').textContent, /失效/);
  });
  test('a malformed token is removed from the URL and ignored (no preview request, no banner)', async () => {
    const { C, win, calls, doc } = load({ href: 'http://localhost:8788/?content_preview=%3Cscript%3E', apiFetch });
    assert.equal(win.location.href, 'http://localhost:8788/');
    await C.ready();
    assert.equal(C.isPreview(), false);
    assert.ok(!calls.some((c) => c.path.endsWith('/preview')));
    assert.equal(doc.getElementById('shop-preview-banner'), null);
  });
  test('without a token there is no preview, no banner and the URL is untouched', async () => {
    const { C, calls, win } = load({ href: 'http://localhost:8788/?a=1', apiFetch });
    await C.ready();
    assert.equal(C.isPreview(), false); assert.equal(calls.calls?.length ?? 0, 0); assert.equal(win.location.href, 'http://localhost:8788/?a=1');
  });
});
