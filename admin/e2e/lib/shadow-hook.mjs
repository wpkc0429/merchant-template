// TEST-ONLY. The core dialogs (confirmations and the design review) live in a CLOSED shadow root in production (ui/kit.js showCoreDialog).
// A closed root cannot be reached by Playwright locators or document.querySelector, so every browser e2e suite installs this hook in ITS test
// browser: an init script that wraps Element.prototype.attachShadow so roots are created OPEN and recorded. Production code never reads a test
// flag and has no hook (tests/shadow-hook-guard.test.mjs checks that); the hook exists only in the page the test browser creates.
// Usage:  const browser = hookBrowser(await chromium.launch());   then, as before, browser.newContext() / browser.newPage().
// In page code use __dq(selector) / __dqa(selector) / __active() instead of document.querySelector / querySelectorAll / activeElement.
// Playwright locators (page.locator, getByRole, waitForSelector) pierce the open roots by themselves.
export const SHADOW_HOOK_SCRIPT = "(() => { if (window.__shadowHook) return; window.__shadowHook = true; const roots = []; const orig = Element.prototype.attachShadow;"
  + " Element.prototype.attachShadow = function (o) { const r = orig.call(this, { ...o, mode: 'open' }); roots.push(r); return r; };"
  + " window.__dq = (q) => document.querySelector(q) || roots.map((r) => r.querySelector(q)).find(Boolean) || null;"
  + " window.__dqa = (q) => [...document.querySelectorAll(q), ...roots.flatMap((r) => [...r.querySelectorAll(q)])];"
  + " window.__active = () => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a; };"
  + " window.__html = () => document.documentElement.outerHTML + roots.map((r) => r.innerHTML).join(''); })();";

/** Installs the hook on a context or page (before any page script runs). */
export const installShadowHook = (target) => target.addInitScript(SHADOW_HOOK_SCRIPT);

/** Makes every context / page this browser creates carry the hook. Returns the same browser. */
export function hookBrowser(browser) {
  const nc = browser.newContext.bind(browser), np = browser.newPage.bind(browser);
  browser.newContext = async (...a) => { const c = await nc(...a); await installShadowHook(c); return c; };
  browser.newPage = async (...a) => { const c = await np(...a); await installShadowHook(c); return c; };
  return browser;
}

/** The open core dialog's confirm button (works for the review and for every confirmation). */
export const confirmYes = (page) => page.locator('dialog[open] [data-testid="confirm-yes"]');
/** The visible text of the open core dialog (title, warning, message, buttons). */
export const coreDialogText = (page) => page.locator("dialog[open]").first().innerText();
