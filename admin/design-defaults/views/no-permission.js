// Shown by the core INSTEAD of a screen whose permission nodes are not all granted.
export default function noPermission(root, ctx) {
  const empty = ctx.ui.emptyState(ctx.t("noPermission.title"), ctx.t("noPermission.hint"));
  empty.dataset.testid = "no-permission";
  root.append(empty);
}
