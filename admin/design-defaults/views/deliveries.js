// Today's deliveries: orders whose requested delivery date is the chosen day (Asia/Taipei) and that are
// not yet delivered (cancelled and returned ones are left out). The florist's working screen.
import { orderCard, deliveryLabel, deliveryRank, sortDeliveries } from "../parts/order-parts.js";

export default async function deliveries(root, ctx) {
  const { h, clear, pageHeader, loading, errorState, emptyState, segmented } = ctx.ui;
  const { t, data, format } = ctx;

  const today = format.taipeiDate();
  const day = ctx.route.query.day === "tomorrow" ? format.addDays(today, 1) : today;
  const area = h("div", { class: "list-area" });
  root.append(
    pageHeader(day === today ? t("deliveries.title.today") : t("deliveries.title.tomorrow"), { eyebrow: deliveryLabel(ctx, day) }),
    segmented([
      { label: t("deliveries.seg.today"), href: "#/deliveries", on: day === today, testid: "day-today" },
      { label: t("deliveries.seg.tomorrow"), href: "#/deliveries?day=tomorrow", on: day !== today, testid: "day-tomorrow" },
    ]),
    area);

  async function load() {
    clear(area).append(loading());
    let list;
    try { list = await data.deliveriesOn(day); } catch (e) { if (ctx.alive()) clear(area).append(errorState(e, load)); return; }
    if (!ctx.alive()) return;
    clear(area);
    if (!list.length) { area.append(emptyState(day === today ? t("deliveries.empty.today") : t("deliveries.empty.tomorrow"), t("deliveries.empty.hint"))); return; }
    const todo = list.filter((o) => deliveryRank(ctx, o) === 0).length;
    const shipped = list.filter((o) => deliveryRank(ctx, o) === 1).length;
    const unpaid = list.filter((o) => deliveryRank(ctx, o) === 2).length;
    area.append(
      h("p", { class: "count", "data-testid": "deliveries-summary" }, t("deliveries.summary", { n: list.length, todo, shipped, unpaid })),
      h("div", { class: "ocards", "data-testid": "deliveries" }, sortDeliveries(ctx, list).map((o) => orderCard(ctx, o))));
  }
  await load();
}
