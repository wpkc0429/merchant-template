// The routes the CORE defines: ids, URL patterns and the permission nodes each needs. The design layer
// only chooses how a route LOOKS (design/routes.js maps route ids to view modules); it cannot add routes,
// change a pattern or loosen a permission. A route whose permissions are not all granted never mounts
// its view: the core mounts "noPermission" instead.

// perm: nodes that must ALL be granted. public: reachable without a session (auth screens).
const BASE_ROUTES = [
  { id: "login", pattern: "/login", public: true },
  { id: "setPassword", pattern: "/set-password/:token", public: true },
  { id: "acceptInvite", pattern: "/accept-invite/:token", public: true },
  { id: "home", pattern: "/", perm: [], nav: "home" },
  { id: "orders", pattern: "/orders", perm: ["order.view"], nav: "orders" },
  { id: "orderDetail", pattern: "/orders/:id", perm: ["order.view"], nav: "orders" },
  { id: "deliveries", pattern: "/deliveries", perm: ["order.view"], nav: "deliveries" },
  { id: "members", pattern: "/members", perm: ["member.view"], nav: "members" },
  { id: "tiers", pattern: "/members/tiers", perm: ["member.view", "member_tier.view"], nav: "members" },
  { id: "memberDetail", pattern: "/members/:id", perm: ["member.view"], nav: "members" },
  { id: "reports", pattern: "/reports", perm: ["report.view"], nav: "reports" },
  { id: "team", pattern: "/team", perm: ["user.manage_members"], nav: "team" },
  { id: "products", pattern: "/products", perm: ["product.view"], nav: "products" },
  { id: "productNew", pattern: "/products/new", perm: ["product.create"], nav: "products" },
  { id: "productEdit", pattern: "/products/:id", perm: ["product.view"], nav: "products" },
  { id: "categories", pattern: "/categories", perm: ["category.view"], nav: "categories" },
  { id: "categoryOrder", pattern: "/categories/:id/order", perm: ["category.view"], nav: "categories" },
  { id: "shipping", pattern: "/shipping-methods", perm: ["shipping_method.view"], nav: "shipping" },
  // Content documents (platform content store). "/content-schema" is a distinct path on purpose: "schema" is a valid document key.
  { id: "content", pattern: "/content", perm: ["content.view"], nav: "content" },
  { id: "contentSchema", pattern: "/content-schema", perm: ["content.manage"], nav: "content" },
  { id: "contentRevisions", pattern: "/content/:key/revisions", perm: ["content.view"], nav: "content" },
  { id: "contentDocument", pattern: "/content/:key", perm: ["content.view"], nav: "content" },
  // Version preview of a past published design (platform change design-history, D25). No nav entry: the history screen links here.
  { id: "designVersionPreview", pattern: "/design/:id/version-preview", perm: ["design.view"], nav: "" },
];
// Design history routes (T1-T4, docs/DECISIONS.md D13, D15). Defined here with `ready`: a route is registered (ROUTES), listed in
// lib/design-schema.js ROUTE_IDS and offered in NAV only together with its default views (design-defaults/views/design-history.js and
// design-request.js, routed in design-defaults/routes.js). PR3 (D15) shipped the views, so both are ready; a registered route without a
// view would make mountView throw for a legitimate user and a nav item would be a dead link
// (tests/design-history-read-layer.test.mjs and tests/design-history-screens.test.mjs fail if only part of that is true).
export const DESIGN_HISTORY_ROUTES = [
  { id: "design", pattern: "/design", perm: ["design.view"], nav: "design", ready: true },
  { id: "designRequest", pattern: "/design/:id", perm: ["design.view"], nav: "design", ready: true },
];
export const DESIGN_HISTORY_READY = DESIGN_HISTORY_ROUTES.every((r) => r.ready);

/** The routes the app registers: the base table plus every design-history route whose views exist (none yet). */
export const ROUTES = [...BASE_ROUTES, ...DESIGN_HISTORY_ROUTES.filter((r) => r.ready).map(({ ready, ...r }) => r)];

// Navigation destinations. `perm` decides who SEES the item; the design layer can reorder, restyle or
// omit items but can never add one the permissions do not allow (the core filters before the shell sees them).
export const NAV = [
  { key: "home", icon: "home", href: "#/", perm: [] },
  { key: "orders", icon: "orders", href: "#/orders", perm: ["order.view"] },
  { key: "deliveries", icon: "shipments", href: "#/deliveries", perm: ["order.view"] },
  { key: "products", icon: "products", href: "#/products", perm: ["product.view"] },
  { key: "categories", icon: "categories", href: "#/categories", perm: ["category.view"] },
  { key: "shipping", icon: "shippingMethods", href: "#/shipping-methods", perm: ["shipping_method.view"] },
  { key: "members", icon: "members", href: "#/members", perm: ["member.view"] },
  { key: "reports", icon: "reports", href: "#/reports", perm: ["report.view"] },
  { key: "content", icon: "content", href: "#/content", perm: ["content.view"] },
  { key: "design", icon: "image", href: "#/design", perm: ["design.view"] },
  { key: "team", icon: "team", href: "#/team", perm: ["user.manage_members"] },
];
