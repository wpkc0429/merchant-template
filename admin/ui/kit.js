// UI kit: the safe DOM builder and the shared components (buttons, fields, dialogs, toasts,
// responsive lists, empty/loading/error states). Presentation primitives only: no API paths here.
//
// h() is the ONLY way design code builds DOM, so it refuses what could run code or leak data:
// raw HTML (innerHTML/outerHTML/srcdoc), string event handlers, script-like tags, form actions and
// URLs that are not same-origin / relative / an allowed image origin. Refusals are dropped with a warning.
import { t } from "../lib/design.js";
import { CORE_DIALOG_CSS } from "./core-dialog-css.js";

const PROPS = new Set(["value", "checked", "disabled", "hidden", "selected", "indeterminate", "textContent"]);
const BLOCKED_TAGS = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "base", "meta", "link", "style", "applet", "portal", "noscript"]);
const BLOCKED_ATTRS = new Set(["innerhtml", "outerhtml", "srcdoc", "action", "formaction", "ping", "http-equiv", "is", "xlink:href"]);
// D12 (v0.4.2): the design layer can neither create its own dialog / popover / inert region nor wire a control to one. The tag and these
// attributes make h() THROW (a design error: the view fails to mount and the core shows the built-in view), they are not silently dropped.
// Only the core creates dialogs, with document.createElement in showDialog below, never through h().
const TOP_LAYER_ATTRS = new Set(["popover", "popovertarget", "popovertargetaction", "inert", "commandfor", "command", "interestfor"]);
export class DesignError extends Error { constructor(msg) { super(msg); this.name = "DesignError"; } }
const URL_ATTRS = new Set(["src", "href", "poster", "srcset", "data", "cite"]);
const allowedOrigins = new Set();

/** The core calls this with the media public base and branding logo hosts so <img> may point at them. */
export function allowImageOrigin(url) {
  try { allowedOrigins.add(new URL(url).origin); } catch { /* not a URL */ }
}
// ONE extra link target, for href only (never img src): the origin of the version preview the person asked for (core/version-preview.js).
// A single slot, replaced by the next preview, so the global image/link allowlist above is not widened.
let previewLinkOrigin = "";
export function allowPreviewLinkOrigin(url) {
  try { previewLinkOrigin = url ? new URL(url).origin : ""; } catch { previewLinkOrigin = ""; }
}
const refuse = (what) => console.warn(`[design] ui: refused ${what}`);

function urlOK(v, attr = "") {
  const s = String(v).trim();
  if (/^(#|\/(?!\/)|\.{1,2}\/|\?)/.test(s)) return true;
  if (/^(mailto:|tel:|blob:)/i.test(s)) return true;
  if (/^data:image\/(png|jpe?g|webp|gif|avif|svg\+xml)[;,]/i.test(s)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith("//")) {
    try { const u = new URL(s, location.href); return /^https?:$/.test(u.protocol) && (u.origin === location.origin || allowedOrigins.has(u.origin) || (attr === "href" && u.protocol === "https:" && previewLinkOrigin !== "" && u.origin === previewLinkOrigin)); } catch { return false; }
  }
  return true; // plain relative path
}

export function h(tag, attrs, ...kids) {
  if (typeof tag !== "string") throw new DesignError("h(): the tag must be a string literal name");
  const name = tag.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new DesignError(`h(): "${tag}" is not a plain lower-case tag name`);
  if (name === "dialog") throw new DesignError("h(): <dialog> is created by the core only (use ctx.ui.showDialog)");
  if (BLOCKED_TAGS.has(name)) { refuse(`<${name}> element`); return document.createComment(`blocked <${name}>`); }
  const el = document.createElement(name);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    const lk = k.toLowerCase();
    if (TOP_LAYER_ATTRS.has(lk)) throw new DesignError(`h(): the "${k}" attribute is refused (popover / inert / command attributes)`);
    if (lk.startsWith("on")) {
      if (typeof v === "function") el.addEventListener(lk.slice(2), v); else refuse(`string event handler "${k}"`);
      continue;
    }
    if (BLOCKED_ATTRS.has(lk)) { refuse(`attribute "${k}"`); continue; }
    if (URL_ATTRS.has(lk)) {
      const parts = lk === "srcset" ? String(v).split(",").map((p) => p.trim().split(/\s+/)[0]) : [String(v)];
      if (!parts.every((x) => urlOK(x, lk))) { refuse(`${k}="${String(v).slice(0, 60)}"`); continue; }
    }
    if (k === "class") el.className = v;
    else if (k === "style") {
      if (v && typeof v === "object") { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith("--")) el.style.setProperty(sk, String(sv)); else el.style[sk] = sv; } }
      else refuse("string style attribute (use an object)");
    }
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  append(el, kids);
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const SVG_TAGS = new Set(["svg", "g", "path", "rect", "line", "circle", "ellipse", "polyline", "polygon", "text", "tspan", "title", "defs", "linearGradient", "stop"]);
/** Safe SVG element builder (allowlisted tags; no handlers, links or style strings). */
export function svg(tag, attrs = {}, text) {
  if (!SVG_TAGS.has(tag)) { refuse(`svg <${tag}>`); return document.createComment("blocked svg"); }
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    const lk = k.toLowerCase();
    if (lk.startsWith("on") || lk === "href" || lk === "xlink:href" || lk === "style") { refuse(`svg attribute "${k}"`); continue; }
    el.setAttribute(k, String(v));
  }
  if (text !== undefined) el.textContent = text;
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
export function clear(el) { el.replaceChildren(); return el; }
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── What the design layer gets (ctx.ui.$, $$, showDialog): restricted views of the helpers above ──
const isCoreNode = (el) => Boolean(el.closest("dialog") || el.closest("#toasts") || el.closest("[data-core]") || el.closest("#core-preview-banner, #core-preview-banner-spacer"));
/** True when `root` is an element the design layer may search: not the document, html, body, or anything inside / containing core UI. */
function searchableRoot(root) {
  if (!(root instanceof Element)) return false;
  if (root === document.documentElement || root === document.body) return false;
  if (root.closest("dialog")) return false; // a dialog's content is built by the dialog's owner; design code searches its own screen
  return !(root.querySelector("dialog, #toasts, [data-core], #core-preview-banner, #core-preview-banner-spacer"));
}
/** ctx.ui.$: needs an explicit root element; never reaches outside it and never returns a node of a core dialog, toast or banner. */
export function designQuery(sel, root) {
  if (!searchableRoot(root)) { console.warn("[design] ui.$ refused: pass an element you created (not document, body or a container of core UI)"); return null; }
  const el = root.querySelector(String(sel));
  return el && !isCoreNode(el) ? el : null;
}
export function designQueryAll(sel, root) {
  if (!searchableRoot(root)) { console.warn("[design] ui.$$ refused: pass an element you created (not document, body or a container of core UI)"); return []; }
  return [...root.querySelectorAll(String(sel))].filter((el) => !isCoreNode(el));
}
/** ctx.ui.showDialog for design code: the same dialog, but only {close} comes back (no element to click, query or edit).
 *  While a CORE dialog (a confirmation or the design review) is open nothing is opened: a design cannot stack a decoy above or beside it. */
export function designShowDialog(opts) {
  if (coreDialogsOpen > 0) { console.warn("[design] ui.showDialog refused: a core dialog is open"); return { close() {} }; }
  const { close } = showDialog(opts);
  return { close };
}

// ── Branding (data from lib/session.js -> CSS variables; core applies it after every screen mount) ─
const HEX = /^#[0-9a-fA-F]{6}$/;
export function applyBranding(branding, name) {
  const root = document.documentElement;
  const b = branding || {};
  // Unset = remove the override so the design tokens (design/tokens.css) apply.
  for (const [prop, val] of [["--brand-primary", b.primary_color], ["--accent", b.accent_color]]) {
    if (HEX.test(val || "")) root.style.setProperty(prop, val);
    else root.style.removeProperty(prop);
  }
  const logoOK = /^https?:\/\//.test(b.logo_url || "");
  if (logoOK) allowImageOrigin(b.logo_url);
  for (const img of $$(".brand-logo")) {
    img.hidden = !logoOK;
    if (logoOK) img.src = b.logo_url; else img.removeAttribute("src");
  }
  for (const n of $$(".brand-name")) n.textContent = name || t("app.name");
  document.title = name ? t("app.titleNamed", { name }) : t("app.name");
}

// ── Buttons & busy state ───────────────────────────────────────────────
export function button(label, { kind = "ghost", onClick, type = "button", small = false, ...rest } = {}) {
  return h("button", { type, class: `btn btn--${kind}${small ? " btn--sm" : ""}`, onclick: onClick, ...rest }, label);
}

/** Runs fn with the button disabled; always re-enables. */
export async function busy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("is-busy");
  try { return await fn(); } finally { btn.disabled = false; btn.classList.remove("is-busy"); }
}

// ── Toasts ─────────────────────────────────────────────────────────────
export function toast(message, kind = "ok") {
  let host = $("#toasts");
  if (!host) { host = h("div", { id: "toasts", role: "status", "aria-live": "polite" }); document.body.append(host); }
  const el = h("div", { class: `toast toast--${kind}` }, message);
  host.append(el);
  setTimeout(() => el.classList.add("is-out"), kind === "error" ? 6000 : 3200);
  setTimeout(() => el.remove(), kind === "error" ? 6400 : 3600);
}

// ── Dialogs (native <dialog>; a bottom sheet on phones) ────────────────
/** Returns {dialog, close}. `content` is a Node; actions are [{label, kind, onClick}] (onClick may return false to stay open). */
export function showDialog(opts) { return buildDialog(opts, (dialog) => { document.body.append(dialog); }); }

// ── CORE dialogs: confirmations and the design review live in a CLOSED shadow root ──
// The design layer's CSS (selectors, universal rules, ::before / ::after, filters, fonts, positions) cannot cross a shadow boundary, and the
// HOST carries inline `all: initial !important` so nothing INHERITED from the page (font-size, color, text-indent, visibility, ...) reaches the text.
// The stylesheet is constructed from ui/core-dialog-css.js (adoptedStyleSheets: allowed by style-src 'self') and uses no design token.
// The root is closed: no document.querySelector, no shadowRoot property, no event retargeting trick reaches in. Native <dialog>.showModal() is kept.
let coreDialogsOpen = 0;
/** True while a core dialog is open (ctx.ui.showDialog refuses meanwhile). */
export const coreDialogOpen = () => coreDialogsOpen > 0;
let coreSheet = null;
const supportsShadow = () => { try { return typeof CSSStyleSheet === "function" && "replaceSync" in CSSStyleSheet.prototype && typeof Element.prototype.attachShadow === "function"; } catch { return false; } };
const HOST_STYLE = [["all", "initial"], ["display", "block"], ["position", "static"], ["visibility", "visible"], ["opacity", "1"], ["filter", "none"], ["transform", "none"],
  ["clip-path", "none"], ["mask", "none"], ["direction", "ltr"], ["unicode-bidi", "normal"], ["zoom", "1"], ["pointer-events", "auto"], ["contain", "none"]];
export function showCoreDialog(opts) {
  if (!supportsShadow()) return showDialog(opts); // an old browser: the light dialog (styled by styles.css), without the isolation
  const host = document.createElement("div");
  host.setAttribute("data-core", "dialog");
  for (const [k, v] of HOST_STYLE) host.style.setProperty(k, v, "important"); // CSSOM, so it is allowed by style-src 'self' and beats any author !important
  const root = host.attachShadow({ mode: "closed" });
  if (!coreSheet) { coreSheet = new CSSStyleSheet(); coreSheet.replaceSync(CORE_DIALOG_CSS); }
  root.adoptedStyleSheets = [coreSheet];
  coreDialogsOpen++;
  let counted = true;
  const release = () => { if (counted) { counted = false; coreDialogsOpen--; } };
  try {
    const r = buildDialog({ ...opts, onClose: (v) => { release(); host.remove(); opts.onClose?.(v); } }, (dialog) => { root.append(dialog); document.body.append(host); });
    // A CSS `zoom` on html / body compounds into the dialog whatever the host says: measure it (layout width vs painted width) and cancel it out.
    try {
      const { dialog } = r, w = dialog.offsetWidth, painted = dialog.getBoundingClientRect().width;
      if (w > 0 && painted > 0 && Math.abs(painted / w - 1) > 0.02) dialog.style.setProperty("zoom", String(w / painted), "important");
    } catch { /* no layout (a test DOM) */ }
    return r;
  } catch (e) { release(); host.remove(); throw e; }
}

function buildDialog({ title, content, actions = [], onClose, wide = false }, mount) {
  const dialog = document.createElement("dialog");
  dialog.className = `dlg${wide ? " dlg--wide" : ""}`;
  const close = (result) => { dialog.close(result); };
  const foot = h("div", { class: "dlg__foot" });
  for (const a of actions) {
    const b = button(a.label, {
      kind: a.kind || "ghost",
      type: "button",
      onClick: async (ev) => {
        // D12: only a real person confirms. A synthetic click (el.click(), dispatchEvent) has isTrusted === false and is ignored.
        if (!ev || ev.isTrusted !== true) return;
        const keep = a.onClick ? await busy(b, () => a.onClick({ close })) : undefined;
        if (keep !== false && a.close !== false) close(a.label);
      },
    });
    if (a.testid) b.dataset.testid = a.testid;
    foot.append(b);
  }
  dialog.append(h("div", { class: "dlg__body" }, h("h2", { class: "dlg__title" }, title), content), actions.length ? foot : "");
  dialog.addEventListener("close", () => { dialog.remove(); onClose?.(dialog.returnValue); });
  mount(dialog);
  dialog.showModal();
  return { dialog, close };
}

/** Promise<boolean>. This is the core's confirmation primitive: action functions call it themselves. */
export function confirmDialog({ title, message, warning = "", detail = "", confirmText = t("common.confirm"), cancelText = t("common.cancel"), danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    showCoreDialog({
      title,
      // `warning` is the core's FIXED text (core/warnings.js) for an irreversible action: it is always rendered, in its
      // own element, and is never taken from the design layer's copy.
      // `detail` is plain text computed by the core (for example a schema dry-run report); it is shown with textContent in a <pre>.
      content: h("div", {}, h("p", { class: "dlg__msg" }, message, warning ? h("span", { class: "dlg__warning", "data-testid": "confirm-warning" }, warning) : ""), detail ? h("pre", { class: "dlg__detail", "data-testid": "confirm-detail" }, detail) : ""),
      actions: [
        { label: cancelText, kind: "ghost" },
        { label: confirmText, kind: danger ? "danger" : "primary", testid: "confirm-yes", onClick: () => { answer = true; } },
      ],
      onClose: () => resolve(answer),
    });
  });
}

// ── Form helpers ───────────────────────────────────────────────────────
/** Labelled field with an error slot. Returns the wrapper; `.input` is the control. */
export function field(label, input, { hint, pointer } = {}) {
  const wrap = h("label", { class: "field", "data-pointer": pointer },
    h("span", { class: "field__label" }, label),
    input,
    hint ? h("span", { class: "field__hint" }, hint) : "",
    h("span", { class: "field__error", role: "alert" }));
  wrap.input = input;
  return wrap;
}
export function setFieldError(wrap, message) {
  const slot = $(".field__error", wrap);
  if (slot) slot.textContent = message || "";
  wrap.classList.toggle("has-error", Boolean(message));
}
export function clearFieldErrors(root) {
  for (const f of $$(".field", root)) setFieldError(f, "");
}
/**
 * Shows {pointer: message} (from an ActionError or fieldErrors(err)) on the matching `.field[data-pointer]`
 * wrappers inside root. Returns the messages that found no field, so the caller can toast them.
 */
export function applyFieldErrors(root, fields) {
  const unplaced = [];
  for (const [ptr, msg] of Object.entries(fields || {})) {
    const f = $(`.field[data-pointer="${CSS.escape(ptr)}"]`, root);
    if (f) setFieldError(f, msg); else unplaced.push(msg);
  }
  return unplaced;
}

export function input(opts = {}) { return h("input", { class: "input", type: "text", ...opts }); }
export function textarea(opts = {}) { return h("textarea", { class: "input input--area", rows: 4, ...opts }); }
export function select(options, value, attrs = {}) {
  const s = h("select", { class: "input", ...attrs });
  for (const o of options) s.append(h("option", { value: String(o.value), selected: String(o.value) === String(value) }, o.label));
  return s;
}

/** Switch toggle. Returns {el, input}. */
export function toggle(label, checked, { onChange, hint, ariaLabel } = {}) {
  const box = h("input", { type: "checkbox", class: "switch__box", checked: Boolean(checked), "aria-label": ariaLabel, onchange: (e) => onChange?.(e.target.checked) });
  const el = h("label", { class: "switch" }, box, h("span", { class: "switch__track" }),
    h("span", { class: "switch__text" }, h("span", {}, label), hint ? h("small", {}, hint) : ""));
  return { el, input: box };
}

export const badge = (text, kind = "") => h("span", { class: `badge ${kind ? "badge--" + kind : ""}` }, text);

// ── States ─────────────────────────────────────────────────────────────
export const loading = (text = t("state.loading")) => h("div", { class: "state state--loading", role: "status" }, h("span", { class: "spinner" }), text);

export function emptyState(title, hint, action) {
  return h("div", { class: "state state--empty" }, h("div", { class: "state__mark", "aria-hidden": "true" }, "✿"),
    h("h3", {}, title), hint ? h("p", {}, hint) : "", action || "");
}

export function errorState(err, retry) {
  return h("div", { class: "state state--error", role: "alert" },
    h("h3", {}, t("state.loadFailed")), h("p", {}, errorMessage(err)),
    retry ? button(t("common.retry"), { kind: "ghost", onClick: retry }) : "");
}

export function pageHeader(title, { eyebrow, actions } = {}) {
  return h("header", { class: "page-head" },
    h("div", {}, eyebrow ? h("div", { class: "eyebrow" }, eyebrow) : "", h("h1", { class: "page-title" }, title)),
    actions ? h("div", { class: "page-head__actions" }, actions) : "");
}

export function card(...kids) { return h("section", { class: "card" }, ...kids); }

// ── Responsive list: a table on desktop, stacked cards on phones ───────
/**
 * columns: [{label, render(row) -> Node|string, class?, primary?}]. `primary` columns form the
 * card header on phones; the rest become label/value lines (CSS only, same markup).
 */
export function dataTable({ columns, rows, onRowClick, rowAttrs, empty }) {
  if (!rows.length) return empty || emptyState(t("table.empty"));
  const head = h("tr", {}, columns.map((c) => h("th", { class: c.class || "" }, c.label)));
  const body = h("tbody", {}, rows.map((row) => {
    const tr = h("tr", { class: onRowClick ? "is-click" : "", ...(rowAttrs ? rowAttrs(row) : {}),
      tabindex: onRowClick ? "0" : null,
      onclick: onRowClick ? (e) => { if (!e.target.closest("button, a, input, label, select")) onRowClick(row); } : null,
      onkeydown: onRowClick ? (e) => { if (e.key === "Enter" && e.target === tr) onRowClick(row); } : null,
    }, columns.map((c) => h("td", { class: `${c.class || ""}${c.primary ? " is-primary" : ""}`, "data-label": c.label }, c.render(row))));
    return tr;
  }));
  return h("div", { class: "table-wrap" }, h("table", { class: "rt" }, h("thead", {}, head), body));
}

// ── Error text (Traditional Chinese; the wording lives in design/copy.js) ──
const POINTER_KEYS = {
  "/title": "field.title", "/slug": "field.slug", "/subtitle": "field.subtitle", "/description": "field.description",
  "/status": "field.status", "/skus": "field.skus", "/category_ids": "field.categories", "/name": "field.name", "/carrier": "field.carrier",
  "/flat_rate": "field.flatRate", "/password": "field.password", "/min_points": "field.minPoints", "/discount_percent": "field.discountPercent",
  "/email": "field.email", "/alt": "field.alt", "/position": "field.position",
};
const MESSAGE_KEYS = { required: "err.required", "must be unique": "err.unique", invalid: "err.invalid" };

/** Per-field messages from a 422 (or a core validation error): {"/title": "必填", ...}. */
export function fieldErrors(err) {
  if (err && err.fields && typeof err.fields === "object") return { ...err.fields };
  const out = {};
  for (const d of err?.details || []) {
    const ptr = String(d.pointer || "");
    const key = ptr.startsWith("/skus") ? "/skus" : ptr;
    const label = POINTER_KEYS[key] || POINTER_KEYS[ptr] ? t(POINTER_KEYS[key] || POINTER_KEYS[ptr]) : "";
    const text = MESSAGE_KEYS[d.message] ? t(MESSAGE_KEYS[d.message]) : d.message || t("err.invalid");
    out[key] = out[key] ? `${out[key]}；${text}` : (label ? `${label}：${text}` : text);
  }
  return out;
}

/** `over` maps a status to a context-specific message (e.g. {409: "..."}) that replaces the generic one. */
export function errorMessage(err, over = {}) {
  if (err && err.isActionError) return err.message;
  if (!err || typeof err.status !== "number") return t("err.network");
  if (over[err.status]) return over[err.status];
  switch (err.status) {
    case 401: return t("err.401");
    case 403: return t("err.403");
    case 404: return t("err.404");
    case 409: return t("err.409");
    case 422: {
      if (!(err.details || []).length && /already exists/.test(err.message)) return t("err.422Exists");
      const fe = Object.values(fieldErrors(err));
      return fe.length ? fe.join("；") : t("err.422");
    }
    case 429: return err.retryAfter ? t("err.429Wait", { minutes: Math.ceil(err.retryAfter / 60) }) : t("err.429");
    case 503: return err.code === "media_not_configured" ? t("err.mediaOff") : t("err.503");
    default: return err.status >= 500 ? t("err.5xx") : t("err.generic");
  }
}

/** Shows err on matching fields (422 or core validation) and returns true if any field took it; otherwise toasts. */
export function showFormError(root, err) {
  const fe = fieldErrors(err);
  let placed = false;
  for (const [ptr, msg] of Object.entries(fe)) {
    const f = $(`.field[data-pointer="${CSS.escape(ptr)}"]`, root);
    if (f) { setFieldError(f, msg); placed = true; }
  }
  if (!placed) toast(errorMessage(err), "error");
  else toast(t("err.fixFields"), "error");
  return placed;
}

// ── Paging and segmented controls ──────────────────────────────────────
/** Prev / next with "page / pages". onPage(n) is called with the new page. */
export function pager(page, total, pageSize, onPage) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return "";
  return h("div", { class: "pager", "data-testid": "pager" },
    button(t("pager.prev"), { small: true, disabled: page <= 1, "data-testid": "page-prev", onClick: () => onPage(page - 1) }),
    h("span", { "data-testid": "page-now" }, `${page} / ${pages}`),
    button(t("pager.next"), { small: true, disabled: page >= pages, "data-testid": "page-next", onClick: () => onPage(page + 1) }));
}

/** Link-style tabs: items [{label, href, on, testid}]. */
export function segmented(items) {
  return h("nav", { class: "seg", "aria-label": t("seg.aria") }, items.map((i) => h("a", { class: `seg__item${i.on ? " is-on" : ""}`, href: i.href, "data-testid": i.testid }, i.label)));
}

/** Copies text; resolves false when the browser refuses (the caller then tells the user to copy by hand). */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  try {
    const ta = h("textarea", { style: { position: "fixed", opacity: "0" } }); ta.value = text; document.body.append(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch { return false; }
}
