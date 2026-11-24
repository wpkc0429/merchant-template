// Categories: tree list with create / rename / reparent / reorder / delete. The manual product order
// inside a category is a separate screen (category-order.js). The core validates, re-reads the tree before
// moving, and asks the confirmation before deleting.
export default async function categories(root, ctx) {
  const { h, clear, button, busy, field, input, select, pageHeader, toast, showDialog, loading, errorState, emptyState, showFormError, applyFieldErrors, setFieldError, icon } = ctx.ui;
  const { t, can, data, logic, actions, errorMessage } = ctx;

  const area = h("div", { class: "list-area" });
  const canCreate = can("category.create");
  const canEdit = can("category.edit");
  const canDelete = can("category.delete");
  root.append(
    pageHeader(t("cat.title"), { eyebrow: "CATEGORIES", actions: canCreate ? button(t("cat.new"), { kind: "primary", "data-testid": "cat-new", onClick: () => openForm(null, null) }) : null }),
    area);

  let tree = [];
  async function load() {
    clear(area).append(loading());
    try { tree = await data.categoryTree(); } catch (e) { if (ctx.alive()) clear(area).append(errorState(e, load)); return; }
    if (ctx.alive()) draw();
  }

  const siblingsOf = (node) => (node.parent ? node.parent.children : tree);

  function draw() {
    clear(area);
    const flat = logic.flattenTree(tree);
    if (!flat.length) { area.append(emptyState(t("cat.empty.title"), canCreate ? t("cat.empty.hint") : "")); return; }
    const list = h("ul", { class: "cat-list", "data-testid": "cat-list" });
    for (const n of flat) {
      const sibs = siblingsOf(n);
      const idx = sibs.findIndex((s) => s.id === n.id);
      const mv = (d) => (ev) => busy(ev.currentTarget, async () => {
        try { await actions.moveCategory(n.id, d); await load(); } catch (e) { toast(errorMessage(e), "error"); }
      });
      list.append(h("li", { class: "cat-item", style: { "--depth": n.depth }, "data-slug": n.slug, "data-testid": "cat-item" },
        h("div", { class: "cat-item__main" }, h("strong", { class: "cat-name" }, n.name), h("span", { class: "mono cat-slug" }, n.slug)),
        h("div", { class: "cat-item__tools" },
          canEdit ? [
            button(icon("up", 18), { small: true, "aria-label": t("cat.up", { name: n.name }), title: t("cat.upTitle"), disabled: idx === 0, onClick: mv(-1), "data-testid": "cat-up" }),
            button(icon("down", 18), { small: true, "aria-label": t("cat.down", { name: n.name }), title: t("cat.downTitle"), disabled: idx === sibs.length - 1, onClick: mv(1), "data-testid": "cat-down" }),
          ] : null,
          h("a", { class: "btn btn--ghost btn--sm", href: `#/categories/${n.id}/order`, "data-testid": "cat-products" }, t("cat.sortProducts")),
          canCreate ? button(t("cat.addChild"), { small: true, onClick: () => openForm(null, n), "data-testid": "cat-add-child" }) : null,
          canEdit ? button(t("cat.edit"), { small: true, onClick: () => openForm(n, null), "data-testid": "cat-edit" }) : null,
          canDelete ? button(t("cat.delete"), { small: true, kind: "danger-ghost", "data-testid": "cat-delete", onClick: () => remove(n) }) : null)));
    }
    area.append(list);
  }

  async function remove(n) {
    try {
      const r = await actions.deleteCategory(n.id);
      if (r.cancelled) return;
      toast(t("cat.toast.deleted"));
      await load();
    } catch (e) { toast(errorMessage(e), "error"); }
  }

  // node = category being edited (or null to create); under = preset parent category when creating.
  function openForm(node, under) {
    const flat = logic.flattenTree(tree);
    const banned = new Set();
    if (node) { (function walk(c) { banned.add(c.id); (c.children || []).forEach(walk); })(node); }
    const parentSel = select([{ value: "", label: t("cat.form.top") }].concat(flat.filter((c) => !banned.has(c.id)).map((c) => ({ value: c.id, label: `${"　".repeat(c.depth)}${c.name}` }))), node ? (node.parent_id ?? "") : (under?.id ?? ""));
    parentSel.dataset.testid = "cat-f-parent";
    const name = input({ value: node?.name ?? "", maxlength: "100", "data-testid": "cat-f-name", autocomplete: "off" });
    const slug = input({ value: node?.slug ?? "", "data-testid": "cat-f-slug", autocapitalize: "none", spellcheck: "false", autocomplete: "off" });
    const wrapName = field(t("cat.form.name"), name, { pointer: "/name" });
    const wrapSlug = field(t("cat.form.slug"), slug, { pointer: "/slug", hint: t("cat.form.slugHint") });
    const content = h("div", { class: "form" }, wrapName, wrapSlug, field(t("cat.form.parent"), parentSel));
    showDialog({
      title: node ? t("cat.form.editTitle") : (under ? t("cat.form.childTitle", { name: under.name }) : t("cat.form.newTitle")),
      content,
      actions: [
        { label: t("common.cancel"), kind: "ghost" },
        { label: node ? t("cat.form.save") : t("cat.form.create"), kind: "primary", testid: "cat-f-save", onClick: async () => {
          setFieldError(wrapName, ""); setFieldError(wrapSlug, "");
          const body = { name: name.value, slug: slug.value, parentId: parentSel.value === "" ? null : Number(parentSel.value) };
          try {
            if (node) await actions.updateCategory(node.id, body);
            else await actions.createCategory(body);
            toast(node ? t("cat.toast.saved") : t("cat.toast.created"));
            await load();
          } catch (e) {
            if (e.fields) applyFieldErrors(content, e.fields);
            else if (e.status === 409) setFieldError(wrapSlug, t("cat.err.slugUsed"));
            else if (!(e.status === 422 && showFormError(content, e))) toast(errorMessage(e), "error");
            return false;
          }
        } },
      ],
    });
    name.focus();
  }

  await load();
}
