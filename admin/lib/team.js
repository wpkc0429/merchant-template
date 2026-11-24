// Team: shop members, roles, invitations. A merchant caller can't act on a merchant owner or on
// themselves (the API answers 403 / 409); `blockedReason` mirrors that so the UI can disable buttons.
import { api } from "./api.js";

const base = (shopID) => `/admin/shops/${shopID}`;

export const listTeam = async (shopID) => (await api("GET", `${base(shopID)}/users`)).users || [];
export const listRoles = async (shopID) => (await api("GET", `${base(shopID)}/roles`)).roles || [];
export const listInvitations = async (shopID) => (await api("GET", `${base(shopID)}/invitations`)).invitations || [];
/** -> {delivery: "manual"|"email", invite_url?, expires_at, invitation_id}. Check `delivery` first, not the URL. */
export const inviteMember = (shopID, email, roleID) => api("POST", `${base(shopID)}/invitations`, { email, role_id: roleID });
export const revokeInvitation = (shopID, id) => api("DELETE", `${base(shopID)}/invitations/${id}`);
export const disableMember = (shopID, userID) => api("POST", `${base(shopID)}/users/${userID}/disable`);
export const enableMember = (shopID, userID) => api("POST", `${base(shopID)}/users/${userID}/enable`);

/** A member holding any non-delegable role (e.g. the owner) can't be touched by a merchant caller. */
export const isProtected = (member) => (member.roles || []).some((r) => r.merchant_assignable === false);
/** "" when the caller may disable/enable this member, otherwise a reason code ("self" | "protected"; wording in the copy). */
export function blockedReason(member, selfID) {
  if (member.user_id === selfID) return "self";
  if (isProtected(member)) return "protected";
  return "";
}
