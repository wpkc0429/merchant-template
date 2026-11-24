// Permission helper. The node list comes from GET /admin/shops/{id}/me (the
// contract's single source for "what can this person do in this shop"; the
// platform-level /admin/me only carries platform_permissions).
//
// This is experience-layer gating ONLY. The API's RBAC is the authority; every
// action here that is hidden is also refused by the server.

let granted = new Set();

export function setPermissions(nodes) { granted = new Set(nodes || []); }
export function clearPermissions() { granted = new Set(); }

/** can("product.edit") -> boolean. Several nodes: all must be granted. */
export function can(...nodes) { return nodes.every((n) => granted.has(n)); }
/** True if at least one of the nodes is granted. */
export function canAny(...nodes) { return nodes.some((n) => granted.has(n)); }
export function allPermissions() { return [...granted].sort(); }
