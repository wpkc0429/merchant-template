// Session state: who is logged in, which shop, what they may do.
import { api, publicApi, login as apiLogin, logout as apiLogout, restoreSession } from "./api.js";
import { setPermissions, clearPermissions } from "./perm.js";

export const session = { user: null, shopID: null, shopIDs: [], shopName: "", branding: null };

/** After tokens exist: load /admin/me then the shop's permissions and branding. */
export async function loadSession(preferredShopID) {
  const me = await api("GET", "/admin/me");
  const ids = me.sids || [];
  session.user = { id: me.id, email: me.email, platformPermissions: me.platform_permissions || [] };
  session.shopIDs = ids;
  if (ids.length === 0) {
    session.shopID = null;
    clearPermissions();
    return session;
  }
  session.shopID = ids.includes(preferredShopID) ? preferredShopID : ids[0];
  const perms = await api("GET", `/admin/shops/${session.shopID}/me`);
  setPermissions(perms.permissions);
  try {
    const b = await api("GET", `/admin/shops/${session.shopID}/branding`);
    session.shopName = b.name || "";
    session.branding = b.branding || null;
  } catch {
    session.shopName = "";
    session.branding = null;
  }
  return session;
}

export async function login(email, password) {
  await apiLogin(email, password);
}

export async function logout() {
  await apiLogout();
  clearSession();
}

export function clearSession() {
  session.user = null;
  session.shopID = null;
  session.shopIDs = [];
  session.shopName = "";
  session.branding = null;
  clearPermissions();
}

export { restoreSession };

// ── Pre-login branding (data only; the ui layer applies it) ────────────
/** {name, branding} for this admin host, or null if the host is not registered. */
export async function fetchHostBranding() {
  try { return await publicApi("GET", "/admin/branding"); } catch { return null; }
}

// ── Password setup / invitations (unauthenticated) ─────────────────────
export const passwordSetup = {
  inspect: (token) => publicApi("POST", "/admin/auth/password-setup/inspect", { token }),
  submit: (token, password) => publicApi("POST", "/admin/auth/password-setup", { token, password }),
};
export const invitations = {
  inspect: (token) => publicApi("POST", "/admin/auth/invitations/inspect", { token }),
  acceptNew: (token, password) => publicApi("POST", "/admin/auth/invitations/accept", { token, password }),
  acceptLoggedIn: (token) => api("POST", "/admin/invitations/accept", { token }),
};
