// Design history (route id design, /design, needs design.view): every AI design change of the shop, newest first.
// A table on desktop and stacked cards on phones (the same dataTable markup), a site tab (storefront | admin), a status filter and paging
// in the URL, a "currently in use" marker per row and the state line (current design, untracked changes). Open a row for the detail.
// Everything shown is data from ctx.data.listDesignRequests / getDesignState; the three different empty states are distinct on purpose.
import { STATUSES, statusChip, kindLabel, personName, when, currentMark } from "../parts/design-history-parts.js";

const PAGE_SIZE = 20;

export default async function designHistory(root, ctx) {
  const { h, clear, pageHeader, loading, errorState, emptyState, segmented, select, dataTable, pager, badge } = ctx.ui;
  const { t, data } = ctx;
  const query = ctx.route.query;
  const site = query.site === "admin" ? "admin" : "storefront";
  const status = STATUSES.includes(query.status) ? query.status : "";
  const page = Math.max(1, Math.min(10000, parseInt(query.page, 10) || 1));
  const path = (o) => {
    const p = new URLSearchParams({ site: o.site ?? site });
    const s = o.status ?? status;
    if (s) p.set("status", s);
    if ((o.page ?? 1) > 1) p.set("page", String(o.page));
    return `/design?${p.toString()}`;
  };

  const filter = select([{ value: "", label: t("dh.filter.all") }, ...STATUSES.map((s) => ({ value: s, label: t(`dh.status.${s}`) }))], status,
    { "aria-label": t("dh.filter.aria"), "data-testid": "dh-status", onchange: (e) => ctx.navigate(path({ status: e.currentTarget.value, page: 1 })) });
  const area = h("div", { class: "list-area dh-area", "data-testid": "dh-area" });
  const stateLine = h("div", { "data-testid": "dh-state" });
  root.append(
    pageHeader(t("dh.title"), { eyebrow: t("dh.eyebrow") }),
    h("div", { class: "dh-tools" },
      segmented([
        { label: t("dh.site.storefront"), href: `#${path({ site: "storefront", page: 1 })}`, on: site === "storefront", testid: "dh-site-storefront" },
        { label: t("dh.site.admin"), href: `#${path({ site: "admin", page: 1 })}`, on: site === "admin", testid: "dh-site-admin" },
      ]),
      filter),
    stateLine, area);

  function drawState(state) {
    clear(stateLine);
    const s = state && state.sites.find((x) => x.site === site);
    if (!s) return;
    stateLine.append(h("p", { class: "dh-state notice" },
      h("span", { "data-testid": "dh-current" }, s.current.tag ? t("dh.current.line", { tag: s.current.tag }) : t("dh.current.none")),
      s.untracked > 0 ? h("span", { "data-testid": "dh-untracked" }, " · " + t("dh.untracked", { n: s.untracked })) : ""));
  }

  const columns = () => [
    { label: t("dh.col.status"), primary: true, render: (r) => h("div", { class: "dh-main" },
      h("div", { class: "dh-chips" }, statusChip(ctx, r.status), r.kind === "revert" ? badge(kindLabel(ctx, r.kind)) : "", r.isCurrent ? currentMark(ctx) : ""),
      h("p", { class: "dh-prompt", "data-testid": "dh-prompt" }, r.promptExcerpt || (r.kind === "revert" && r.revertTargetTag ? t("dh.restores", { tag: r.revertTargetTag }) : t("dh.noPrompt"))),
      r.publishedTag ? h("p", { class: "muted dh-tag" }, r.publishedTag) : "",
      r.failureCode ? h("p", { class: "muted dh-tag" }, t("vp.failed.code", { code: r.failureCode })) : "") },
    { label: t("dh.col.by"), render: (r) => personName(ctx, r.proposedByName) },
    { label: t("dh.col.time"), render: (r) => when(ctx, r.createdAt) },
    { label: "", render: (r) => h("a", { class: "dh-open", href: `#/design/${r.id}`, "data-testid": "dh-open", "aria-label": t("dh.open.aria", { who: personName(ctx, r.proposedByName) }) }, t("dh.open")) },
  ];

  let busy = false, moved = false; // a page change is asked for once: clicks while loading or after one was sent are ignored
  const goPage = (n) => { if (busy || moved) return; moved = true; ctx.navigate(path({ page: n })); };

  async function load() {
    busy = true;
    clear(area).append(loading());
    let list, state = null;
    try {
      const [l, st] = await Promise.all([
        data.listDesignRequests({ site, status: status || undefined, page, pageSize: PAGE_SIZE }),
        data.getDesignState().catch(() => null),
      ]);
      list = l; state = st;
      if (!ctx.alive()) return;
      busy = false;
      drawState(state);
    } catch (e) {
      busy = false;
      if (!ctx.alive()) return;
      clear(area).append(e && e.reason === "design_storage_not_configured"
        ? emptyState(t("dh.empty.storage.title"), t("dh.empty.storage.hint"))
        : errorState(e, load));
      return;
    }
    clear(area);
    // A page past the end (for example a hand-typed ?page=99999): jump to the last page instead of "N rows" over an empty table.
    if (list.total > 0 && !list.requests.length && page > 1) { moved = true; ctx.navigate(path({ page: Math.max(1, Math.ceil(list.total / (list.pageSize || PAGE_SIZE))) }), { replace: true }); return; }
    if (!list.total && !status && state && state.designEnabled === false) {
      // Not an error: AI edit is simply not switched on for this shop and there is nothing to show yet.
      area.append(h("div", { "data-testid": "dh-disabled" }, emptyState(t("dh.empty.disabled.title"), t("dh.empty.disabled.hint"))));
      return;
    }
    if (!list.total && !list.requests.length) {
      area.append(status
        ? emptyState(t("dh.empty.filtered.title"), t("dh.empty.filtered.hint"))
        : emptyState(t("dh.empty.none.title"), t("dh.empty.none.hint")));
      return;
    }
    area.append(
      h("p", { class: "count", "data-testid": "dh-count" }, t("dh.count", { n: list.total })),
      h("div", { "data-testid": "dh-list" }, dataTable({
        columns: columns(), rows: list.requests,
        onRowClick: (r) => ctx.navigate(`/design/${r.id}`),
        rowAttrs: (r) => ({ "data-testid": "dh-row", "data-id": r.id, "data-status": r.status, "data-current": r.isCurrent ? "1" : "0" }),
      })),
      pager(list.page, list.total, list.pageSize, goPage));
  }
  await load();
}
