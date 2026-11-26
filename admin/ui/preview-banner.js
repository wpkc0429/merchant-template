// The CORE-OWNED preview banner (CORE, locked). On a preview host (lib/preview.js) every page carries a fixed bar that says
// this is a preview, which version, and when it expires. The design layer cannot remove or restyle it:
//   * the element is created and owned here, appended to <body> OUTSIDE the #app container the design layer renders into,
//     with no copy key (the wording is fixed below, like core/warnings.js);
//   * its styles are set through the CSSOM with `!important` (an inline !important declaration beats any stylesheet rule, and
//     CSSOM writes are allowed under the strict CSP);
//   * a load-time consistency check (verifyBanner) and a throttled MutationObserver plus a timer re-check it: if the element was
//     removed, reworded, hidden (also through an ancestor, opacity, filter, clip, text-indent, text-fill, content-visibility), shrunk,
//     covered (document.elementFromPoint) or moved out of <body> it is rebuilt, and if it still cannot be made visible, or keeps
//     needing a rebuild (rate limit), the page FAILS CLOSED once (the app is removed from the page and a plain message is shown);
//   * styles are compared with the browser's own serialization of the same declarations, never with the strings written here.
// It has no design-layer input at all except what the host wrote into preview-config.js (lib/preview.js).
import { previewMode } from "../lib/preview.js";

export const BANNER_ID = "core-preview-banner";
const KIND_LABEL = { version: "版本預覽", change: "改版預覽" };
const STYLE = {
  display: "block", visibility: "visible", opacity: "1", position: "sticky", top: "0", left: "0", right: "0", width: "auto", "min-height": "2.25rem",
  margin: "0", padding: "0.5rem 1rem", "z-index": "2147483647", background: "#fff3c4", color: "#3b2f00", "border-bottom": "2px solid #b58900",
  font: "600 14px/1.4 system-ui, sans-serif", "text-align": "center", transform: "none", translate: "none", rotate: "none", scale: "none",
  filter: "none", "clip-path": "none", clip: "auto", "mask-image": "none", "mix-blend-mode": "normal", "pointer-events": "auto",
  "content-visibility": "visible", "text-indent": "0", "-webkit-text-fill-color": "#3b2f00", "letter-spacing": "normal", "text-transform": "none",
  "text-shadow": "none", "text-overflow": "clip", "white-space": "normal", "line-height": "1.4", "font-size": "14px",
  overflow: "visible", height: "auto", "max-height": "none", "box-sizing": "border-box",
};
// Limits of the self-repair (a design layer that fights the banner must end in ONE fail-closed, never a loop or a crash).
const REBUILD_MAX = 4;          // rebuilds allowed ...
const REBUILD_WINDOW_MS = 3000; // ... within this window; one more fails closed
const CHECK_MIN_MS = 200;       // at most one check per this many ms from the observer (the 1 s timer is separate)

/** The banner text for a mode (pure; tested). `now` makes the expiry check testable. */
export function bannerText(mode, now = Date.now()) {
  if (mode.configFailed) return "預覽設定未載入（唯讀，已停止）";
  const label = KIND_LABEL[mode.kind] || KIND_LABEL.version;
  const parts = [`${label}（非正式版本，唯讀）`];
  if (mode.tag) parts.push(`版本：${mode.tag}`);
  if (mode.expiresAt) {
    const t = Date.parse(mode.expiresAt);
    if (t <= now) parts.push("已到期");
    else {
      let when = mode.expiresAt;
      try { when = new Date(t).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }); } catch { /* keep ISO */ }
      parts.push(`到期時間：${when}`);
    }
  }
  return parts.join("｜");
}

let el = null;
let observer = null;
let timer = null;
let expected = null;   // the fixed styles as the BROWSER serializes them (see expectedStyles)
let busy = false;      // re-entrancy: our own rebuild must not start another check
let failed = false;    // fail-closed happened: stop everything, do it only once
let rebuilds = [];     // timestamps of recent rebuilds (rate limit)
let lastCheck = 0;
let scheduled = false;
const OBSERVE = { childList: true, attributes: true, characterData: true };

/**
 * The fixed styles as the browser normalizes them (`#fff3c4` is read back as `rgb(255, 243, 196)`, shorthands are re-serialized).
 * They are obtained ONCE by setting the same declarations on a detached probe element and reading them back, so the comparison with
 * the real banner never depends on how a value was spelled. A property this browser does not know is dropped by the probe too
 * (value "" and priority ""), and then it is not required on the banner either.
 */
function expectedStyles() {
  if (expected) return expected;
  const probe = document.createElement("div");
  const list = [];
  for (const [k, v] of Object.entries(STYLE)) {
    probe.style.setProperty(k, v, "important");
    list.push([k, probe.style.getPropertyValue(k), probe.style.getPropertyPriority(k)]);
  }
  expected = list;
  return expected;
}

function build(mode) {
  const b = document.createElement("div");
  b.setAttribute("id", BANNER_ID);
  b.setAttribute("role", "status");
  b.setAttribute("data-testid", "preview-banner");
  b.setAttribute("data-kind", mode.kind);
  b.textContent = bannerText(mode);
  for (const [k, v] of Object.entries(STYLE)) b.style.setProperty(k, v, "important");
  return b;
}

const px = (v) => parseFloat(v) || 0;
const alpha = (c) => {
  const m = /^rgba?\(([^)]*)\)$/.exec(String(c).trim());
  if (!m) return 1;
  const p = m[1].split(/[ ,/]+/).filter(Boolean);
  return p.length > 3 ? Number(p[3]) : 1;
};
const hiddenBy = (c) => (c.contentVisibility || "visible") !== "visible" || (c.filter || "none") !== "none" || (c.transform || "none") !== "none"
  || (c.clipPath || "none") !== "none" || (c.maskImage || c.webkitMaskImage || "none") !== "none"
  || (c.translate || "none") !== "none" || (c.rotate || "none") !== "none" || (c.scale || "none") !== "none";

/** Is the element really visible to a person? Computed styles of the banner and its ancestors, geometry, and what is on top of it. */
function visible(b) {
  try {
    if (typeof getComputedStyle !== "function") return true; // no layout engine (offline tests): presence and text are still checked
    const cs = getComputedStyle(b);
    if (cs.display === "none" || cs.visibility !== "visible" || Number(cs.opacity) < 1 || hiddenBy(cs)) return false;
    if (cs.clip && cs.clip !== "auto") return false;
    if (px(cs.textIndent) !== 0 || px(cs.fontSize) < 12 || (cs.mixBlendMode || "normal") !== "normal") return false;
    if (cs.color === cs.backgroundColor || alpha(cs.color) < 1 || alpha(cs.backgroundColor) < 1) return false;
    if (cs.webkitTextFillColor && cs.webkitTextFillColor !== cs.color) return false;
    for (const pseudo of ["::before", "::after"]) {
      const c = getComputedStyle(b, pseudo).content;
      if (c && c !== "none" && c !== "normal") return false; // generated content could paint over or add to the text
    }
    const fl = getComputedStyle(b, "::first-line");
    if (fl && (fl.visibility !== "visible" || Number(fl.opacity) < 1 || fl.color === cs.backgroundColor || (fl.webkitTextFillColor && fl.webkitTextFillColor !== fl.color) || px(fl.fontSize) < 12)) return false;
    // ancestors: opacity, filter, transform, content-visibility, clip, mask or display on <body>/<html> hide or move the banner as well
    for (let a = b.parentElement; a; a = a.parentElement) {
      const ac = getComputedStyle(a);
      if (ac.display === "none" || ac.visibility !== "visible" || Number(ac.opacity) < 1 || hiddenBy(ac)) return false;
    }
    const r = b.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (r.height < 16 || r.width < 8 || (vw && r.width < vw * 0.8)) return false;
    if (vw && vh && (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh)) return false; // moved out of the viewport
    if (typeof document.elementFromPoint === "function" && vw && vh) {
      // covered? the top element in the middle and near both ends of the bar must be the banner (or something inside it)
      const y = Math.min(Math.max(r.top + r.height / 2, 1), vh - 1);
      for (const x of [r.left + r.width / 2, r.left + 6, r.right - 6]) {
        const top = document.elementFromPoint(Math.min(Math.max(x, 1), vw - 1), y);
        if (!top || !(top === b || b.contains(top))) return false;
      }
    }
    return true;
  } catch { return true; }
}

/** Is the banner exactly as the core made it? (in <body>, the right id, the right text, every fixed style still set, visible.) */
export function bannerIntact(b, mode) {
  if (!b || !b.parentNode || b.parentNode !== document.body) return false;
  if (b.getAttribute("id") !== BANNER_ID || b.textContent !== bannerText(mode)) return false;
  // The inline styles are compared with the browser's own serialization of the same declarations, never with the strings written here.
  for (const [k, v, p] of expectedStyles()) if (b.style.getPropertyValue(k) !== v || b.style.getPropertyPriority(k) !== p) return false;
  return visible(b);
}

/** ONE message, then nothing more is done: the app is removed from the page (a later render goes into a detached node) and the checks stop. */
function failClosed() {
  if (failed) return;
  failed = true;
  try { if (observer) observer.disconnect(); } catch { /* ignore */ }
  try { if (timer && typeof clearInterval === "function") clearInterval(timer); } catch { /* ignore */ }
  observer = null; timer = null;
  try {
    const msg = document.createElement("p");
    msg.textContent = "這個預覽畫面無法顯示必要的預覽橫幅，已停止顯示。請關閉後重新開啟預覽。";
    msg.setAttribute("data-testid", "preview-failed-closed");
    msg.setAttribute("role", "alert");
    const app = document.getElementById("app");
    if (app) app.replaceChildren();
    if (document.body && typeof document.body.replaceChildren === "function") document.body.replaceChildren(msg);
    else if (app) app.replaceChildren(msg);
    if (document.documentElement && document.documentElement.setAttribute) document.documentElement.setAttribute("data-preview-failed-closed", "1");
  } catch { /* nothing more can be done */ }
}
/** True once the page failed closed. */
export const hasFailedClosed = () => failed;

/** The consistency check: rebuilds the banner when it is not intact; fails closed when a rebuilt one still is not, or when it keeps needing a rebuild. Returns true when intact. */
export function verifyBanner(mode = previewMode) {
  if (!mode) return true;
  if (failed) return false;
  if (busy) return true; // our own rebuild is running; its caller decides
  busy = true;
  try {
    if (bannerIntact(el, mode)) return true;
    const now = Date.now();
    rebuilds = rebuilds.filter((t) => now - t < REBUILD_WINDOW_MS);
    if (rebuilds.length >= REBUILD_MAX) { failClosed(); return false; } // something keeps undoing the banner: stop, do not loop
    rebuilds.push(now);
    try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch { /* ignore */ }
    el = build(mode);
    document.body.prepend(el);
    if (observer) { observer.observe(el, { ...OBSERVE, subtree: true }); if (typeof observer.takeRecords === "function") observer.takeRecords(); } // our own DOM change is not news
    if (bannerIntact(el, mode)) return true;
    failClosed();
    return false;
  } finally { busy = false; }
}

/** Called once at boot (app.js). A normal page (no preview mode) does nothing at all. */
export function installPreviewBanner(mode = previewMode) {
  if (!mode) return false;
  if (mode.configFailed) { // the preview host's config script did not load (lib/preview.js): never run the app
    verifyBanner(mode);
    failClosed();
    return true;
  }
  verifyBanner(mode);
  if (failed) return true;
  // Observer callbacks are coalesced (one check per animation frame, at most one per CHECK_MIN_MS) so page animation or polling cannot
  // force a layout on every mutation. The scope is what can hide the banner: <html>/<body> attributes and children, the banner itself,
  // and <head> (stylesheets). Changes deeper in #app cannot touch the banner except by covering it, which the 1 s timer catches.
  const run = () => {
    scheduled = false;
    if (failed) return;
    const wait = lastCheck + CHECK_MIN_MS - Date.now();
    if (wait > 0) { scheduled = true; setTimeout(run, wait); return; }
    lastCheck = Date.now();
    verifyBanner(mode);
  };
  const check = () => {
    if (busy || failed || scheduled) return;
    scheduled = true;
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run); else setTimeout(run, 0);
  };
  if (typeof MutationObserver === "function" && !observer) {
    observer = new MutationObserver(check);
    const opts = OBSERVE;
    observer.observe(document.documentElement, opts);
    observer.observe(document.body, opts);
    if (document.head) observer.observe(document.head, { ...opts, subtree: true });
    if (el) observer.observe(el, { ...opts, subtree: true });
  }
  if (!timer && typeof setInterval === "function") timer = setInterval(() => { lastCheck = Date.now(); verifyBanner(mode); }, 1000);
  return true;
}
