// A tiny DOM + HTML parser for the Node tests of public/commerce/content.js (no jsdom: the template has no dependencies).
// Only what content.js touches: parseFromString(html).body, element/text nodes, attributes, appendChild/removeChild,
// textContent, getElementById on the document. The parser is lenient (not spec-complete) and good enough for the cases
// the sanitiser tests feed it: nested tags, void elements, raw-text elements, comments, entities, unclosed tags.
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return String.fromCodePoint(n); }
  return Object.hasOwn(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m;
});

export class Node_ {
  constructor(doc, nodeType) { this.ownerDocument = doc; this.nodeType = nodeType; this.childNodes = []; this.parentNode = null; }
  get firstChild() { return this.childNodes[0] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { while (this.firstChild) this.removeChild(this.firstChild); if (v !== '') this.appendChild(this.ownerDocument.createTextNode(String(v))); }
}
export class Text_ extends Node_ { constructor(doc, data) { super(doc, 3); this.data = data; } }
export class El extends Node_ {
  constructor(doc, name) { super(doc, 1); this.localName = name.toLowerCase(); this.nodeName = name.toUpperCase(); this.attrs = new Map(); }
  setAttribute(n, v) { this.attrs.set(n.toLowerCase(), String(v)); }
  getAttribute(n) { return this.attrs.has(n.toLowerCase()) ? this.attrs.get(n.toLowerCase()) : null; }
  hasAttribute(n) { return this.attrs.has(n.toLowerCase()); }
  removeAttribute(n) { this.attrs.delete(n.toLowerCase()); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  set className(v) { this.setAttribute('class', v); }
  get className() { return this.getAttribute('class') || ''; }
  // Serialise (for assertions): <tag a="b">children</tag>
  get html() {
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inner = this.childNodes.map((c) => (c.nodeType === 3 ? esc(c.data) : c.html)).join('');
    if (VOID.has(this.localName)) return `<${this.localName}${attrStr(this)}>`;
    return `<${this.localName}${attrStr(this)}>${inner}</${this.localName}>`;
  }
  get innerHTML() { return this.childNodes.map((c) => (c.nodeType === 3 ? c.data.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : c.html)).join(''); }
}
const attrStr = (e) => [...e.attrs].map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');

export class MiniDocument {
  constructor() {
    this.listeners = {};
    this.readyState = 'complete';
    this.visibilityState = 'visible';
    this.body = new El(this, 'body');
  }
  createElement(n) { return new El(this, n); }
  createTextNode(t) { return new Text_(this, t); }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  getElementById(id) {
    const walk = (n) => { for (const c of n.childNodes) { if (c.nodeType === 1) { if (c.id === id) return c; const r = walk(c); if (r) return r; } } return null; };
    return walk(this.body);
  }
}

export function parseHtml(doc, html) {
  const body = new El(doc, 'body');
  const stack = [body];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const text = (t) => { if (t) top().appendChild(new Text_(doc, decode(t))); };
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { text(html.slice(i)); break; }
    text(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? html.length : e + 3; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'<>\/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>`]+))?)*)\s*(\/?)>/.exec(html.slice(lt));
    if (!m) { text('<'); i = lt + 1; continue; }
    i = lt + m[0].length;
    const [, close, rawName, attrText, selfClose] = m;
    const name = rawName.toLowerCase();
    if (close) {
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].localName === name) { stack.length = k; break; }
      continue;
    }
    const el = new El(doc, name);
    for (const a of attrText.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/g)) {
      const v = a[2] ?? a[3] ?? a[4] ?? '';
      if (!el.hasAttribute(a[1])) el.setAttribute(a[1], decode(v));
    }
    top().appendChild(el);
    if (VOID.has(name) || selfClose) continue;
    if (RAW.has(name)) {
      const e = html.toLowerCase().indexOf(`</${name}`, i);
      const end = e < 0 ? html.length : e;
      if (end > i) el.appendChild(new Text_(doc, html.slice(i, end)));
      const gt = html.indexOf('>', end);
      i = e < 0 ? html.length : gt + 1;
      continue;
    }
    stack.push(el);
  }
  return { body };
}

/** A window-like global for content.js: DOM, location/history stubs and an in-memory sessionStorage. */
export function makeWindow({ href = 'http://localhost:8788/', apiFetch, config = {}, imageOrigins = {}, allowlist, session = {} } = {}) {
  const doc = new MiniDocument();
  const store = new Map(Object.entries(session));
  const calls = { replaceState: [] };
  const win = {
    document: doc, JSON, Promise, Date, Math, Object, Array, String, Number, RegExp, URL, encodeURIComponent, setTimeout, clearTimeout,
    location: { href }, history: { state: null, replaceState: (...a) => { calls.replaceState.push(a); win.location.href = new URL(a[2], win.location.href).href; } },
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } },
    DOMParser: class { parseFromString(html) { return parseHtml(doc, html); } },
    SHOP_CONFIG: config
  };
  win.window = win;
  win.ShopCommerce = { _internal: { apiFetch, config, imageOrigins, imageOriginListeners: [], allowlist } };
  return { win, doc, store, calls };
}
