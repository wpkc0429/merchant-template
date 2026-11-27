// The screen registry: route id -> the view module that draws it. Plain data (no code).
// Route ids, URLs and the permissions each screen needs are defined by the CORE (core/routes.js); this file
// only chooses WHICH file draws a screen. Point an id at another file under design/views/ to replace a
// screen. Two ids may share a file (productNew and productEdit do). If a view is missing or throws, the
// core shows the built-in view for that route instead and logs a console warning.
export default {
  shell: "views/shell.js",
  login: "views/login.js",
  setPassword: "views/set-password.js",
  acceptInvite: "views/accept-invite.js",
  notFound: "views/not-found.js",
  noPermission: "views/no-permission.js",
  bootError: "views/boot-error.js",
  home: "views/home.js",
  orders: "views/orders.js",
  orderDetail: "views/order-detail.js",
  deliveries: "views/deliveries.js",
  members: "views/members.js",
  tiers: "views/tiers.js",
  memberDetail: "views/member-detail.js",
  reports: "views/reports.js",
  team: "views/team.js",
  products: "views/products.js",
  productNew: "views/product-edit.js",
  productEdit: "views/product-edit.js",
  categories: "views/categories.js",
  categoryOrder: "views/category-order.js",
  shipping: "views/shipping.js",
  content: "views/content.js",
  contentDocument: "views/content-document.js",
  contentRevisions: "views/content-revisions.js",
  contentSchema: "views/content-schema.js",
  design: "views/design-history.js",
  designRequest: "views/design-request.js",
  designVersionPreview: "views/design-version-preview.js",
};
