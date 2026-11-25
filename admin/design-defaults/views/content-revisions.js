// Revision history of one document, with restore. Restoring only puts a version back into the DRAFT (it never
// publishes): the screen says so. The confirmation (with its fixed warning) is the core's.
export default async function contentRevisions(root, ctx) {
  const { h, clear, pageHeader, button, busy, toast, dataTable, loading, errorState, emptyState, badge, card, showDialog } = ctx.ui;
  const { t, data, actions, can, format, errorMessage } = ctx;
  const key = ctx.route.params.key;

  const box = h("div", { class: "list-area", "data-testid": "content-revisions" });
  const notice = h("div", { "data-testid": "content-restored-slot" });
  root.append(
    pageHeader(t("content.rev.title"), { eyebrow: key, actions: button(t("content.rev.openEditor"), { kind: "ghost", "data-testid": "content-rev-back", onClick: () => ctx.navigate(`/content/${key}`) }) }),
    card(h("p", { class: "muted" }, t("content.rev.intro")), notice, box));

  async function load() {
    clear(box).append(loading());
    let list;
    try { list = await data.listContentRevisions(key); } catch (e) { if (ctx.alive()) clear(box).append(errorState(e, load)); return; }
    if (!ctx.alive()) return;
    clear(box).append(dataTable({
      rows: list,
      rowAttrs: (r) => ({ "data-testid": "rev-row", "data-rev": String(r.rev) }),
      empty: emptyState(t("content.rev.empty")),
      columns: [
        { label: t("content.rev.col.rev"), primary: true, render: (r) => h("strong", {}, `#${r.rev}`) },
        { label: t("content.rev.col.kind"), render: (r) => badge(t(`content.rev.kind.${r.kind}`), r.kind === "publish" ? "ok" : "warn") },
        { label: t("content.rev.col.schema"), render: (r) => `v${r.schemaVersion}` },
        { label: t("content.rev.col.when"), render: (r) => format.dateTime(r.createdAt) },
        { label: "", class: "col-actions", render: (r) => h("span", { class: "cf-flags" },
          button(t("content.rev.view"), { small: true, "data-testid": "rev-view", onClick: () => view(r) }),
          can("content.edit") ? button(t("content.rev.restore"), { small: true, kind: "ghost", "data-testid": "rev-restore", onClick: (e) => busy(e.currentTarget, () => restore(r)) }) : "") },
      ],
    }));
  }

  async function view(r) {
    let full;
    let node;
    try {
      [full, node] = await Promise.all([data.getContentRevision(key, r.rev), data.getContentDocument(key)]);
    } catch (e) { toast(errorMessage(e), "error"); return; }
    const body = node.schemaNode
      ? ctx.ui.contentForm(node.schemaNode, full.content, { readOnly: true }).el
      : h("p", { class: "notice" }, t("cf.err.noType"));
    showDialog({ title: t("content.rev.viewTitle", { rev: r.rev }), content: h("div", { "data-testid": "rev-content" }, body), wide: true, actions: [{ label: t("content.rev.close"), kind: "ghost" }] });
  }

  async function restore(r) {
    try {
      const res = await actions.restoreContentRevision(key, r.rev);
      if (res.cancelled) return;
      const msg = res.restoredValid ? t("content.rev.restored") : t("content.rev.restoredInvalid");
      clear(notice).append(h("p", { class: "notice", role: "status", "data-testid": "content-restored" }, msg, " ",
        h("a", { href: `#/content/${key}`, "data-testid": "content-restored-edit" }, t("content.rev.openEditor"))));
      toast(msg);
    } catch (e) { toast(errorMessage(e), "error"); }
  }

  await load();
}
