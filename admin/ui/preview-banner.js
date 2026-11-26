// The CORE-OWNED preview banner (CORE, locked). On a preview host (lib/preview.js) every page carries a fixed bar that says
// this is a preview, which version, and when it expires. The design layer cannot remove or restyle it:
//   * the element is created and owned here, appended to <body> OUTSIDE the #app container the design layer renders into,
//     with no copy key (the wording is fixed below, like core/warnings.js);
//   * its styles are set through the CSSOM with `!important` (an inline !important declaration beats any stylesheet rule, and
//     CSSOM writes are allowed under the strict CSP);
//   * a load-time consistency check (verifyBanner) and a MutationObserver plus a timer re-check it: if the element was removed,
//     reworded, hidden, shrunk, covered or moved out of <body> it is rebuilt, and if it still cannot be made visible the page
//     FAILS CLOSED (the app is replaced by a plain message).
// It has no design-layer input at all except what the host wrote into preview-config.js (lib/preview.js).
import { previewMode } from "../lib/preview.js";

export const BANNER_ID = "core-preview-banner";
const KIND_LABEL = { version: "版本預覽", change: "改版預覽" };
const STYLE = {
  display: "block", visibility: "visible", opacity: "1", position: "sticky", top: "0", left: "0", right: "0", width: "auto", "min-height": "2.25rem",
  margin: "0", padding: "0.5rem 1rem", "z-index": "2147483647", background: "#fff3c4", color: "#3b2f00", "border-bottom": "2px solid #b58900",
  font: "600 14px/1.4 system-ui, sans-serif", "text-align": "center", transform: "none", filter: "none", "clip-path": "none", "pointer-events": "auto",
  overflow: "visible", height: "auto", "max-height": "none",
};

/** The banner text for a mode (pure; tested). `now` makes the expiry check testable. */
export function bannerText(mode, now = Date.now()) {
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

function visible(b) {
  try {
    if (typeof getComputedStyle !== "function") return true; // no layout engine (offline tests): presence and text are still checked
    const cs = getComputedStyle(b);
    if (cs.display === "none" || cs.visibility !== "visible" || Number(cs.opacity) < 1) return false;
    const r = b.getBoundingClientRect();
    return r.height >= 8 && r.width >= 8;
  } catch { return true; }
}

/** Is the banner exactly as the core made it? (in <body>, the right id, the right text, every fixed style still set, visible.) */
export function bannerIntact(b, mode) {
  if (!b || !b.parentNode || b.parentNode !== document.body) return false;
  if (b.getAttribute("id") !== BANNER_ID || b.textContent !== bannerText(mode)) return false;
  for (const [k, v] of Object.entries(STYLE)) if (b.style.getPropertyValue(k) !== v || b.style.getPropertyPriority(k) !== "important") return false;
  return visible(b);
}

function failClosed() {
  try {
    const app = document.getElementById("app");
    if (app) app.replaceChildren(Object.assign(document.createElement("p"), { textContent: "這個預覽畫面無法顯示必要的預覽橫幅，已停止顯示。請關閉後重新開啟預覽。" }));
  } catch { /* nothing more can be done */ }
}

/** The consistency check: rebuilds the banner when it is not intact; fails closed when a rebuilt one still is not. Returns true when intact. */
export function verifyBanner(mode = previewMode) {
  if (!mode) return true;
  if (bannerIntact(el, mode)) return true;
  try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch { /* ignore */ }
  el = build(mode);
  document.body.prepend(el);
  if (bannerIntact(el, mode)) return true;
  failClosed();
  return false;
}

/** Called once at boot (app.js). A normal page (no preview mode) does nothing at all. */
export function installPreviewBanner(mode = previewMode) {
  if (!mode) return false;
  verifyBanner(mode);
  const check = () => verifyBanner(mode);
  if (typeof MutationObserver === "function" && !observer) {
    observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  }
  if (!timer && typeof setInterval === "function") timer = setInterval(check, 1000);
  return true;
}
