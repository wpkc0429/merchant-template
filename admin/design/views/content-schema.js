// Content schema status (store owner only: content.manage). Shows the registered version, runs the READ-ONLY dry run
// of the storefront's content.schema.json and offers the registration. Registering is a core action that always shows
// the report and a fixed warning in a confirmation dialog; this screen cannot register without it.
export default async function contentSchema(root, ctx) {
  const { h, clear, pageHeader, button, busy, toast, dataTable, loading, errorState, emptyState, card } = ctx.ui;
  const { t, data, actions, format, errorMessage } = ctx;

  const statusBox = h("div", { "data-testid": "schema-status" });
  const reportBox = h("div", { "data-testid": "schema-report" });
  const versionsBox = h("div", { "data-testid": "schema-versions" });
  const dryBtn = button(t("content.schema.dryrun"), { kind: "ghost", "data-testid": "schema-dryrun", onClick: (e) => busy(e.currentTarget, dryRun) });
  const regBtn = button(t("content.schema.register"), { kind: "primary", "data-testid": "schema-register", onClick: (e) => busy(e.currentTarget, register) });
  root.append(
    pageHeader(t("content.schema.title"), { eyebrow: t("content.eyebrow"), actions: button(t("content.back"), { kind: "ghost", onClick: () => ctx.navigate("/content") }) }),
    card(h("p", { class: "muted" }, t("content.schema.intro")), statusBox, h("div", { class: "cf-flags" }, dryBtn, regBtn), reportBox),
    card(h("div", { class: "card__head" }, h("h2", {}, t("content.schema.versions"))), versionsBox));

  async function load() {
    clear(statusBox).append(loading());
    let active;
    let versions;
    try { [active, versions] = await Promise.all([data.getContentSchema(), data.listContentSchemaVersions()]); } catch (e) { if (ctx.alive()) clear(statusBox).append(errorState(e, load)); return; }
    if (!ctx.alive()) return;
    clear(statusBox).append(h("p", { "data-testid": "schema-active", "data-version": String(active ? active.version : 0) }, active ? t("content.schema.active", { version: active.version }) : t("content.schema.none")));
    clear(versionsBox).append(dataTable({
      rows: versions,
      rowAttrs: (v) => ({ "data-testid": "schema-version-row", "data-version": String(v.version) }),
      empty: emptyState(t("content.schema.none")),
      columns: [
        { label: t("content.schema.col.version"), primary: true, render: (v) => h("strong", {}, `v${v.version}`) },
        { label: t("content.schema.col.when"), render: (v) => format.dateTime(v.created_at) },
        { label: t("content.schema.col.source"), render: (v) => v.source || "" },
      ],
    }));
  }

  function showReport(r) {
    clear(reportBox);
    reportBox.append(h("h3", {}, t("content.schema.reportTitle")),
      h("p", { "data-testid": "schema-dryrun-summary" }, r.changed ? t("content.schema.dryrunChange", { version: r.wouldRegisterVersion }) : t("content.schema.dryrunSame")),
      h("pre", { class: "dlg__detail", "data-testid": "schema-dryrun-report" }, r.lines.length ? r.lines.join("\n") : t("content.schema.reportNone")));
  }

  async function dryRun() {
    try { showReport(await data.dryRunContentSchema()); } catch (e) { toast(errorMessage(e), "error"); }
  }

  async function register() {
    try {
      const r = await actions.registerContentSchema();
      if (r.cancelled) return;
      toast(r.unchanged ? t("content.schema.unchanged") : t("content.schema.registered", { version: r.version }));
      clear(reportBox);
      await load();
    } catch (e) { toast(errorMessage(e), "error"); }
  }

  await load();
}
