// Customer detail: points, tier, orders. Customers who only ever checked out as guests are labelled 訪客.
import { orderCard } from "../parts/order-parts.js";
import { formatPoints, identity } from "../parts/member-parts.js";

export default async function memberDetail(root, ctx) {
  const { h, clear, pageHeader, errorState, badge, card } = ctx.ui;
  const { t, can, data, format, errorMessage } = ctx;
  const id = Number(ctx.route.params.id);

  let m;
  try { m = await data.getMember(id); } catch (e) {
    root.append(h("a", { class: "backlink", href: "#/members" }, t("member.back")), errorState(e, () => ctx.reload()));
    return;
  }
  const stat = (label, value, sub, testid) => h("div", { class: "stat", "data-testid": testid }, h("div", { class: "stat__label" }, label), h("div", { class: "stat__value stat__value--sm" }, value), h("div", { class: "stat__sub" }, sub || ""));
  const stats = h("div", { class: "stats", "data-testid": "member-stats" });
  const ordersBox = h("div", { class: "ocards", "data-testid": "member-orders" });
  const pointsBox = h("div", { class: "lines", "data-testid": "member-points" });
  root.append(
    h("a", { class: "backlink", href: "#/members" }, t("member.back")),
    pageHeader(m.email || t("members.fallbackName", { id: m.id }), { eyebrow: `MEMBER #${m.id}` }),
    h("div", { class: "detail-chips" }, identity(ctx, m), m.status === 1 ? badge(t("status.enabled"), "ok") : badge(t("status.disabled"), "bad")),
    stats,
    card(h("div", { class: "card__head" }, h("h2", {}, t("member.orders.title"))), ordersBox),
    can("point.view") ? card(h("div", { class: "card__head" }, h("h2", {}, t("member.points.title"))), pointsBox) : "");
  stats.append(
    stat(t("member.stat.points"), formatPoints(ctx, m.points), t("member.stat.pointsSub"), "stat-points"),
    stat(t("member.stat.tier"), m.level?.name || t("member.stat.noTier"),
      m.level ? `${t("member.stat.threshold", { points: formatPoints(ctx, m.level.min_points) })}${m.level.discount_percent ? t("member.stat.discount", { pct: m.level.discount_percent }) : ""}` : "", "stat-tier"));

  const jobs = [];
  if (can("order.view")) {
    jobs.push(data.memberOrderSummary(id).then((s) => {
      stats.append(stat(t("member.stat.orders"), format.number(s.orderCount), t("member.stat.ordersSub", { n: format.number(s.paidCount) }), "stat-orders"),
        stat(t("member.stat.spend"), format.money(s.spend), s.complete ? t("member.stat.spendSub") : t("member.stat.spendCapped"), "stat-spend"));
      clear(ordersBox);
      if (!s.recent.length) ordersBox.append(h("p", { class: "muted" }, t("member.orders.none")));
      else ordersBox.append(...s.recent.map((o) => orderCard(ctx, o)));
    }).catch((e) => { clear(ordersBox).append(h("p", { class: "form-error" }, errorMessage(e))); }));
  } else clear(ordersBox).append(h("p", { class: "muted" }, t("member.orders.noPerm")));
  if (can("point.view")) {
    jobs.push(data.listPointTransactions(id).then((r) => {
      clear(pointsBox);
      if (!r.items.length) pointsBox.append(h("p", { class: "muted" }, t("member.points.none")));
      for (const tx of r.items) {
        pointsBox.append(h("div", { class: "line", "data-testid": "point-row" },
          h("div", { class: "line__main" }, h("strong", {}, [0, 1, 2].includes(tx.kind) ? t(`member.points.kind.${tx.kind}`) : t("member.points.kindOther")), h("span", { class: "muted" }, tx.reason || (tx.order_id ? t("member.points.order", { id: tx.order_id }) : ""))),
          h("div", { class: "line__qty" }, format.dateTime(tx.created_at)),
          h("div", { class: "line__total" }, t("points.format", { n: `${tx.points_delta > 0 ? "+" : ""}${format.number(tx.points_delta)}` }))));
      }
    }).catch((e) => { clear(pointsBox).append(h("p", { class: "form-error" }, errorMessage(e))); }));
  }
  await Promise.allSettled(jobs);
}
