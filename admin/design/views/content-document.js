// Content document editor. The form (fields, validation, uploads) is built by the core from the platform's schema:
// this file only lays the screen out and calls the core's actions, which check the permissions, validate again,
// handle the optimistic lock (a stale save asks for a reload) and map server errors to fields.
export default async function contentDocument(root, ctx) {
  const { h, clear, pageHeader, button, busy, toast, loading, errorState, badge, card, showDialog } = ctx.ui;
  const { t, data, actions, can, errorMessage } = ctx;
  const key = ctx.route.params.key;

  const editable = can("content.edit");
  const area = h("div", { "data-testid": "content-editor" });
  root.append(area);
  let doc = null;
  let form = null;

  async function load() {
    clear(area).append(loading());
    try { doc = await data.getContentDocument(key); } catch (e) { if (ctx.alive()) clear(area).append(errorState(e, load)); return; }
    if (!ctx.alive()) return;
    draw();
  }

  const dirty = () => Boolean(form) && JSON.stringify(form.read()) !== JSON.stringify(doc.draft);

  function draw() {
    clear(area);
    if (!doc.schemaNode) { area.append(card(h("p", { class: "notice" }, t("cf.err.noType")))); return; }
    form = ctx.ui.contentForm(doc.schemaNode, doc.draft, { readOnly: !editable });
    const saveBtn = editable ? button(t("content.save"), { kind: "primary", "data-testid": "content-save", onClick: (e) => busy(e.currentTarget, save) }) : "";
    const pubBtn = can("content.publish") ? button(t("content.publish"), { kind: "ghost", "data-testid": "content-publish", disabled: doc.needsAttention, onClick: (e) => busy(e.currentTarget, publish) }) : "";
    const unpubBtn = can("content.publish") && doc.isPublished ? button(t("content.unpublish"), { kind: "ghost", "data-testid": "content-unpublish", onClick: (e) => busy(e.currentTarget, unpublish) }) : "";
    const delBtn = can("content.publish") ? button(t("content.delete"), { kind: "danger-ghost", "data-testid": "content-delete", onClick: (e) => busy(e.currentTarget, remove) }) : "";
    const previewBtn = button(t("content.preview"), { kind: "ghost", "data-testid": "content-preview", onClick: (e) => busy(e.currentTarget, preview) });
    const revBtn = button(t("content.revisions"), { kind: "ghost", "data-testid": "content-revisions-link", onClick: () => ctx.navigate(`/content/${key}/revisions`) });
    area.append(
      pageHeader(doc.title || doc.key, { eyebrow: t("content.eyebrow"), actions: h("div", { class: "cf-flags" }, saveBtn, pubBtn, unpubBtn, previewBtn, revBtn, delBtn) }),
      card(
        h("div", { class: "cf-flags" },
          doc.isPublished ? badge(t("content.status.published"), "ok") : badge(t("content.status.draft")),
          h("span", { "data-testid": "content-rev", "data-rev": String(doc.rev) }, badge(t("content.rev.label", { rev: doc.rev }))),
          doc.needsAttention ? h("span", { "data-testid": "content-flag-attention" }, badge(t("content.flag.attention"), "warn")) : "",
          doc.declared ? "" : h("span", { "data-testid": "content-flag-orphan" }, badge(t("content.flag.orphan"), "bad"))),
        doc.needsAttention ? h("p", { class: "notice", "data-testid": "content-banner-attention" }, t("content.banner.attention")) : "",
        doc.declared ? "" : h("p", { class: "notice" }, t("content.banner.orphan")),
        editable ? "" : h("p", { class: "notice", "data-testid": "content-readonly" }, t("content.banner.readOnly")),
        form.el,
        h("p", {}, h("a", { href: "#/content", "data-testid": "content-back" }, t("content.back")))));
  }

  // The form is always rebuilt from the SERVER's response: rich text is rewritten by the server.
  const replaceWith = (next) => { doc = next; draw(); };

  function stale() {
    showDialog({
      title: t("content.stale.title"),
      content: h("p", { class: "dlg__msg", "data-testid": "content-stale" }, t("content.stale.text")),
      actions: [{ label: t("content.stale.reload"), kind: "primary", testid: "content-stale-reload", onClick: async () => { await load(); } }],
    });
  }

  async function save() {
    const v = form.validate();
    if (!v.ok) { form.focusFirstError(); return; }
    try {
      const r = await actions.saveContentDocument(key, form.read(), { rev: doc.rev });
      replaceWith(r.doc);
      toast(t("content.saved"));
    } catch (e) {
      if (e.kind === "stale") { stale(); return; }
      if (e.fields) { const left = form.setErrors(e.fields); if (left.length) toast(left.join(" "), "error"); return; }
      toast(errorMessage(e), "error");
    }
  }

  async function publish() {
    if (dirty()) { toast(t("content.dirtyFirst"), "error"); return; }
    try {
      const r = await actions.publishContentDocument(key, { rev: doc.rev });
      if (r.cancelled) return;
      toast(t("content.published"));
      await load();
    } catch (e) {
      if (e.kind === "stale") { stale(); return; }
      if (e.fields) { form.setErrors(e.fields); return; }
      toast(errorMessage(e), "error");
    }
  }

  async function unpublish() {
    try {
      const r = await actions.unpublishContentDocument(key);
      if (r.cancelled) return;
      toast(t("content.unpublished"));
      await load();
    } catch (e) { toast(errorMessage(e), "error"); }
  }

  async function remove() {
    try {
      const r = await actions.deleteContentDocument(key);
      if (r.cancelled) return;
      toast(t("content.deleted"));
      ctx.navigate("/content");
    } catch (e) { toast(errorMessage(e), "error"); }
  }

  async function preview() {
    if (!data.contentSite().previewEnabled) { toast(t("content.previewOff"), "error"); return; }
    try {
      const r = await actions.previewContentDocument(key);
      toast(r.opened ? t("content.previewOpened") : t("content.previewBlocked"), r.opened ? "ok" : "error");
    } catch (e) { toast(errorMessage(e), "error"); }
  }

  await load();
}
