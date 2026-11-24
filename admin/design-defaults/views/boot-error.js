// Shown when the session cannot be restored because the server is unreachable. ctx.route.state.error holds the message.
export default function bootError(root, ctx) {
  const { h, button, emptyState } = ctx.ui;
  root.append(h("div", { class: "boot-error" },
    emptyState(ctx.t("bootError.title"), ctx.route.state.error, button(ctx.t("common.retry"), { kind: "primary", onClick: () => ctx.reload() }))));
}
