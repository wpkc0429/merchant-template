// Session state: who is logged in, which shop, what they may do.
import { takeApi } from "./api.js";

const { api, publicApi, login: apiLogin, logout: apiLogout } = takeApi(); // boot phase only (lib/api.js)
import { takePermissions } from "./perm.js";
import { clearReviewBasis } from "./design-history.js";
import { capability } from "./boot.js";

const { setPermissions, clearPermissions } = takePermissions(); // boot phase only (lib/boot.js)

// The state object is private. `session` (exported) is a frozen READ-ONLY view of it, and every mutator is handed out only in the boot phase
// through takeSession() (D19), so a module imported later can neither change who is signed in nor sign anyone in or out.
const state = { user: null, shopID: null, shopIDs: [], shopName: "", branding: null };
export const session = Object.freeze({
  get user() { return state.user; }, get shopID() { return state.shopID; }, get shopIDs() { return state.shopIDs; },
  get shopName() { return state.shopName; }, get branding() { return state.branding; },
});

/** After tokens exist: load /admin/me then the shop's permissions and branding. */
async function loadSession(preferredShopID) {
  clearReviewBasis(); // a new sign-in or a restored session never inherits what an earlier user's review had read (design review, D14)
  const me = await api("GET", "/admin/me");
  const ids = me.sids || [];
  state.user = Object.freeze({ id: me.id, email: me.email, platformPermissions: Object.freeze([...(me.platform_permissions || [])]) });
  state.shopIDs = ids;
  if (ids.length === 0) {
    state.shopID = null;
    clearPermissions();
    return session;
  }
  state.shopID = ids.includes(preferredShopID) ? preferredShopID : ids[0];
  const perms = await api("GET", `/admin/shops/${state.shopID}/me`);
  setPermissions(perms.permissions);
  try {
    const b = await api("GET", `/admin/shops/${state.shopID}/branding`);
    state.shopName = b.name || "";
    state.branding = b.branding || null;
  } catch {
    state.shopName = "";
    state.branding = null;
  }
  return session;
}

async function login(email, password) {
  await apiLogin(email, password);
}

async function logout() {
  await apiLogout();
  clearSession();
}

function clearSession() {
  clearReviewBasis(); // sign-out, session loss, user change: no review basis survives
  state.user = null;
  state.shopID = null;
  state.shopIDs = [];
  state.shopName = "";
  state.branding = null;
  clearPermissions();
}

// ── Pre-login branding (data only; the ui layer applies it) ────────────
/** {name, branding} for this admin host, or null if the host is not registered. */
export async function fetchHostBranding() {
  try { return await publicApi("GET", "/admin/branding"); } catch { return null; }
}

// ── Password setup / invitations (unauthenticated) ─────────────────────
const passwordSetup = {
  inspect: (token) => publicApi("POST", "/admin/auth/password-setup/inspect", { token }),
  submit: (token, password) => publicApi("POST", "/admin/auth/password-setup", { token, password }),
};
const invitations = {
  inspect: (token) => publicApi("POST", "/admin/auth/invitations/inspect", { token }),
  acceptNew: (token, password) => publicApi("POST", "/admin/auth/invitations/accept", { token, password }),
  acceptLoggedIn: (token) => api("POST", "/admin/invitations/accept", { token }),
};

/** Every session mutator and the unauthenticated link calls, for the boot phase only (lib/boot.js, D19). `state` is the mutable object (offline tests set it up through it). */
export const takeSession = capability("session", Object.freeze({ state, loadSession, login, logout, clearSession, passwordSetup: Object.freeze(passwordSetup), invitations: Object.freeze(invitations) }));
