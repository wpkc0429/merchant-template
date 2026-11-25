// Content documents: the list of editable content of the storefront (platform content store).
// The core decides who gets here (content.view); the form, validation and every write live in the core.
export default async function content(root, ctx) {
  const { h, clear, pageHeader, button, dataTable, loading, errorState, emptyState, badge, card } = ctx.ui;
  const { t, data, format, can } = ctx;

  const box = h("div", { class: "list-area", "data-testid": "content-list" });
  const actions = can("content.manage")
    ? button(t("content.schemaLink"), { kind: "ghost", "data-testid": "content-schema-link", onClick: () => ctx.navigate("/content-schema") })
    : "";
  root.append(pageHeader(t("content.title"), { eyebrow: t("content.eyebrow"), actions }), card(box));

  async function load() {
    clear(box).append(loading());
    let schema;
    let docs;
    try {
      schema = await data.getContentSchema();
      docs = schema ? await data.listContentDocuments() : [];
    } catch (e) { if (ctx.alive()) clear(box).append(errorState(e, load)); return; }
    if (!ctx.alive()) return;
    if (!schema) {
      clear(box).append(emptyState(t("content.notRegistered.title"), t("content.notRegistered.hint"),
        can("content.manage") ? button(t("content.notRegistered.cta"), { kind: "primary", "data-testid": "content-to-schema", onClick: () => ctx.navigate("/content-schema") }) : ""));
      return;
    }
    clear(box).append(dataTable({
      rows: docs,
      rowAttrs: (d) => ({ "data-testid": "content-row", "data-key": d.key }),
      empty: emptyState(t("content.empty.title"), t("content.empty.hint")),
      onRowClick: (d) => ctx.navigate(`/content/${d.key}`),
      columns: [
        { label: t("content.col.name"), primary: true, render: (d) => h("a", { href: `#/content/${d.key}`, "data-testid": "content-open" }, h("strong", {}, d.title || d.key), h("small", { class: "muted" }, ` ${d.key}`)) },
        { label: t("content.col.type"), render: (d) => d.type },
        { label: t("content.col.status"), render: (d) => h("span", { class: "cf-flags" },
          d.isPublished ? badge(t("content.status.published"), "ok") : badge(t("content.status.draft")),
          d.needsAttention ? h("span", { "data-testid": "content-flag-attention" }, badge(t("content.flag.attention"), "warn")) : "",
          d.declared ? "" : h("span", { "data-testid": "content-flag-orphan" }, badge(t("content.flag.orphan"), "bad"))) },
        { label: t("content.col.updated"), render: (d) => format.dateTime(d.updatedAt) },
      ],
    }));
  }
  await load();
}
