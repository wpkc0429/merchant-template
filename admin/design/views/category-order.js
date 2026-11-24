// Manual product order inside one category (#/categories/:id/order).
export default async function categoryOrder(root, ctx) {
  const { h, clear, button, busy, pageHeader, toast, emptyState, badge, card, icon } = ctx.ui;
  const { t, can, data, logic, actions, errorMessage } = ctx;

  const id = Number(ctx.route.params.id);
  const [tree, products] = await Promise.all([data.categoryTree(), data.getProductOrder(id)]);
  if (!ctx.alive()) return;
  const cat = logic.flattenTree(tree).find((c) => c.id === id);
  if (!cat) { root.append(emptyState(t("catOrder.notFound.title"), t("catOrder.notFound.hint"), h("a", { class: "btn btn--ghost", href: "#/categories" }, t("catOrder.notFound.back")))); return; }
  const canEdit = can("category.edit");
  let order = products.map((p) => ({ ...p }));
  let dirty = false;
  const listEl = h("ol", { class: "order-list", "data-testid": "order-list" });
  const save = button(t("catOrder.save"), { kind: "primary", disabled: true, "data-testid": "order-save", onClick: (ev) => busy(ev.currentTarget, async () => {
    try {
      order = (await actions.setProductOrder(id, order.map((p) => p.product_id))).map((p) => ({ ...p }));
      dirty = false; toast(t("catOrder.saved")); draw();
    } catch (e) { toast(errorMessage(e), "error"); }
  }) });

  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    order.splice(j, 0, order.splice(i, 1)[0]);
    dirty = true; draw();
  }
  function draw() {
    clear(listEl);
    order.forEach((p, i) => listEl.append(h("li", { class: "order-item", "data-product-id": p.product_id, "data-testid": "order-item" },
      h("span", { class: "order-item__n" }, i + 1),
      h("span", { class: "order-item__t" }, p.title, p.status === 1 ? "" : badge(t("status.inactive"))),
      canEdit ? h("span", { class: "order-item__tools" },
        button(icon("up", 18), { small: true, "aria-label": t("cat.up", { name: p.title }), disabled: i === 0, onClick: () => move(i, -1), "data-testid": "order-up" }),
        button(icon("down", 18), { small: true, "aria-label": t("cat.down", { name: p.title }), disabled: i === order.length - 1, onClick: () => move(i, 1), "data-testid": "order-down" })) : null)));
    save.disabled = !dirty;
  }
  draw();
  root.append(
    h("a", { class: "backlink", href: "#/categories" }, t("catOrder.back")),
    pageHeader(t("catOrder.title", { name: cat.name }), { eyebrow: "PRODUCT ORDER" }),
    order.length
      ? card(h("p", { class: "field__hint" }, t("catOrder.hint")), listEl)
      : emptyState(t("catOrder.empty.title"), t("catOrder.empty.hint")),
    canEdit && order.length ? h("div", { class: "savebar" }, button(t("common.cancel"), { onClick: () => ctx.navigate("/categories") }), save) : "");
}
