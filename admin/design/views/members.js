// Customers list: search by email / id. Points are POINTS, never money (see parts/member-parts.js).
import { formatPoints, identity, memberTabs } from "../parts/member-parts.js";

const search = { q: "", page: 1 };

export default async function members(root, ctx) {
  const { h, clear, pageHeader, input, dataTable, loading, errorState, emptyState, pager } = ctx.ui;
  const { t, data, format } = ctx;

  const q = input({ type: "search", placeholder: t("members.search.placeholder"), value: search.q, "data-testid": "member-search", "aria-label": t("members.search.aria") });
  const area = h("div", { class: "list-area" });
  root.append(pageHeader(t("members.title"), { eyebrow: "MEMBERS" }), memberTabs(ctx, "list"), h("div", { class: "toolbar toolbar--one" }, q), area);
  let seq = 0;
  async function load() {
    const my = ++seq;
    clear(area).append(loading());
    let r;
    try { r = await data.listMembers(search); } catch (e) { if (ctx.alive() && my === seq) clear(area).append(errorState(e, load)); return; }
    if (!ctx.alive() || my !== seq) return;
    clear(area).append(
      h("p", { class: "count", "data-testid": "member-count" }, t("members.count", { n: format.number(r.total) })),
      dataTable({
        rows: r.members,
        rowAttrs: (m) => ({ "data-testid": "member-row", "data-member-id": String(m.id) }),
        onRowClick: (m) => ctx.navigate(`/members/${m.id}`),
        empty: emptyState(t("members.empty.title"), search.q ? t("members.empty.searched") : t("members.empty.none")),
        columns: [
          { label: t("members.col.customer"), primary: true, render: (m) => h("a", { href: `#/members/${m.id}` }, h("strong", {}, m.email || t("members.fallbackName", { id: m.id }))) },
          { label: t("members.col.identity"), render: (m) => identity(ctx, m) },
          { label: t("members.col.level"), render: (m) => m.level?.name || "—" },
          { label: t("members.col.points"), render: (m) => formatPoints(ctx, m.points) },
          { label: t("members.col.joined"), render: (m) => format.dateTime(m.created_at) },
        ],
      }),
      pager(r.page, r.total, ctx.enums.MEMBERS_PAGE_SIZE, (p) => { search.page = p; load(); ctx.scrollTop(); }));
  }
  let timer;
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { search.q = q.value; search.page = 1; load(); }, 300); });
  await load();
}
