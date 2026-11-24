// App bootstrap (CORE): boot, routing, the session lifecycle and the permission gate. Every screen,
// including the shell (navigation) and the login / set-password / accept-invite screens, is a design-layer
// view mounted through core/host.js with a ctx from core/context.js. This file decides WHICH screen
// shows and WHETHER the person may see it; the design layer decides only how it looks.
import { onUnauthorized } from "./lib/api.js";
import { route, start, navigate, scrub } from "./lib/router.js";
import { session, loadSession, logout, restoreSession, clearSession, fetchHostBranding } from "./lib/session.js";
import { can } from "./lib/perm.js";
import { loadMediaConfig, mediaConfig } from "./lib/upload.js";
import { loadDesign, t } from "./lib/design.js";
import { h, clear, applyBranding, allowImageOrigin, errorMessage, loading, emptyState } from "./ui/kit.js";
import { ROUTES, NAV } from "./core/routes.js";
import { makeContext } from "./core/context.js";
import { makeAuth } from "./core/auth.js";
import { mountView } from "./core/host.js";

const visibleNav = () => NAV.filter((n) => n.perm.every((p) => can(p)));

const root = document.getElementById("app");
let shell = null;          // {main, setActive}
let viewToken = 0;         // invalidates in-flight view renders on navigation
let pendingPath = "/";     // where to go after login
let hostBranding = null;
let bootState = "pending"; // pending | in | out | error

const holder = () => h("div", { class: "view" });
const fragment = () => document.createDocumentFragment();

// ── Routes (ids, patterns and permissions are the core's; see core/routes.js) ──
for (const r of ROUTES) route(r.pattern, r);

// ── Auth hooks handed to the screens through ctx.auth ──────────────────
const hooks = {
  onLoggedIn: async () => {
    await enterApp();
    const to = pendingPath || "/";
    pendingPath = "/";
    navigate(to, { replace: true });
  },
  onLogout: () => doLogout(),
  goLogin: (email, notice) => showLogin({ email, notice }),
  afterJoin: async () => { await enterApp(); navigate("/", { replace: true }); },
};
const authFor = (linkToken) => makeAuth({ linkToken, hooks });

// ── Boot ───────────────────────────────────────────────────────────────
async function boot() {
  await loadDesign();
  onUnauthorized((why) => { showLogin({ notice: why === "membership" || why === "account" ? t("login.notice.disabled") : t("login.notice.expired") }); });
  fetchHostBranding().then((b) => { hostBranding = b; if (!session.user) applyBranding(b?.branding, b?.name); });
  start(onRoute);
}

async function establishSession() {
  try {
    if (await restoreSession()) {
      await enterApp();
      return true;
    }
    return false;
  } catch (e) {
    bootState = "error";
    const { root: r } = await mountView("bootError", fragment, () => makeContext({ routeId: "bootError", state: { error: errorMessage(e) } }));
    root.replaceChildren(r);
    return null;
  }
}

async function enterApp() {
  await loadSession();
  await loadMediaConfig();
  const base = mediaConfig().public_base_url;
  if (base) allowImageOrigin(base);
  applyBranding(session.branding, session.shopName);
  bootState = "in";
  await buildShell();
}

async function onRoute(m) {
  const token = ++viewToken;
  if (!m) { // unknown route
    if (session.user) return renderIn(token, { id: "notFound", perm: [], nav: "" }, {});
    return showLogin({});
  }
  const def = m.handler;
  // Link screens never need a session; the link token stays in the core (it is scrubbed from the URL at once).
  if (def.id === "setPassword" || def.id === "acceptInvite") {
    teardownShell();
    const linkToken = m.params.token;
    scrub(def.id === "setPassword" ? "/set-password" : "/accept-invite");
    const { root: r } = await mountView(def.id, fragment, () => makeContext({ routeId: def.id, auth: authFor(linkToken) }));
    if (token !== viewToken) return;
    root.replaceChildren(r);
    applyBranding(hostBranding?.branding, hostBranding?.name);
    return;
  }
  if (!session.user) {
    if (bootState === "pending" || bootState === "out") {
      if (bootState === "pending") {
        const ok = await establishSession();
        if (ok === null) return;
        if (token !== viewToken) return;
        if (!ok) { bootState = "out"; pendingPath = m.path === "/login" ? "/" : m.path; return showLogin({}); }
      } else {
        pendingPath = m.path === "/login" ? "/" : m.path;
        return showLogin({});
      }
    }
  }
  if (!session.user) return;
  if (def.id === "login") return navigate("/", { replace: true });
  if (!shell) await buildShell();
  if (token !== viewToken) return;
  renderIn(token, def, m);
}

async function renderIn(token, def, m) {
  const main = clear(shell.main);
  shell.setActive(def.nav || "");
  window.scrollTo(0, 0);
  main.append(loading());
  // The permission gate is the core's: a route whose nodes are not all granted never mounts its own view.
  const allowed = (def.perm || []).every((p) => can(p));
  const id = allowed ? def.id : "noPermission";
  const ctxFor = () => makeContext({ routeId: id, params: m.params, query: m.query, alive: () => token === viewToken, nav: visibleNav(), auth: authFor(null) });
  try {
    const { root: view } = await mountView(id, holder, ctxFor);
    if (token !== viewToken) return;
    shell.main.replaceChildren(view);
  } catch (e) {
    if (token !== viewToken) return;
    shell.main.replaceChildren(h("div", { class: "view" }, emptyState(t("state.error"), errorMessage(e))));
  }
}

// ── Login / shell ──────────────────────────────────────────────────────
async function showLogin({ email = "", notice = "" }) {
  const token = ++viewToken;
  clearSession();
  teardownShell();
  applyBranding(hostBranding?.branding, hostBranding?.name);
  bootState = "out";
  if (location.hash !== "#/login" && !/set-password|accept-invite/.test(location.hash)) history.replaceState(null, "", "#/login");
  const { root: r } = await mountView("login", fragment, () => makeContext({ routeId: "login", state: { email, notice }, auth: authFor(null) }));
  if (token !== viewToken) return;
  root.replaceChildren(r);
  applyBranding(hostBranding?.branding, hostBranding?.name);
}

function teardownShell() { shell = null; }

async function buildShell() {
  const { root: r, result } = await mountView("shell", fragment,
    () => makeContext({ routeId: "shell", nav: visibleNav(), auth: authFor(null) }),
    { validate: (res, frag) => Boolean(res && res.main instanceof HTMLElement && typeof res.setActive === "function" && frag.contains(res.main)) });
  root.replaceChildren(r);
  shell = { main: result.main, setActive: result.setActive };
  applyBranding(session.branding, session.shopName);
}

async function doLogout() {
  document.querySelectorAll("dialog").forEach((d) => d.close());
  await logout();
  bootState = "out";
  pendingPath = "/";
  showLogin({ notice: t("login.notice.loggedOut") });
}

boot();
