// Unknown address.
export default function notFound(root, ctx) {
  root.append(ctx.ui.emptyState(ctx.t("notFound.title"), ctx.t("notFound.hint")));
}
