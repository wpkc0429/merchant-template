// Orders list: server-side filters (payment, fulfilment, order status, delivery date, search), newest
// first, paged. Filtering must happen on the server: the list is paged, so a client-side filter would
// only see the current page.
import { orderCard } from "../parts/order-parts.js";

const blank = () => ({ q: "", payment: "", fulfillment: "", status: "", from: "", to: "", page: 1 });
// Filters survive going into an order and back.
const f = blank();

export default async function orders(root, ctx) {
  const { h, clear, pageHeader, button, input, select, field, loading, errorState, emptyState, pager } = ctx.ui;
  const { t, data, format } = ctx;

  const q = input({ type: "search", placeholder: t("orders.search.placeholder"), value: f.q, "data-testid": "order-search", "aria-label": t("orders.search.aria") });
  const payment = select([{ value: "", label: t("orders.payment.all") }, { value: "0", label: t("payment.0") }, { value: "1", label: t("payment.1") }, { value: "2", label: t("payment.2") }, { value: "3", label: t("payment.3") }], f.payment,
    { "data-testid": "order-payment", "aria-label": t("orders.payment.aria") });
  const fulfillment = select([{ value: "", label: t("orders.fulfillment.all") }, { value: "0", label: t("fulfillment.0") }, { value: "4", label: t("fulfillment.4") }, { value: "1", label: t("fulfillment.1") }, { value: "2", label: t("fulfillment.2") }, { value: "3", label: t("fulfillment.3") }], f.fulfillment,
    { "data-testid": "order-fulfillment", "aria-label": t("orders.fulfillment.aria") });
  const status = select([{ value: "", label: t("orders.status.all") }, { value: "0", label: t("orders.status.processing") }, { value: "1", label: t("order.cancelled") }], f.status,
    { "data-testid": "order-status", "aria-label": t("orders.status.aria") });
  const from = input({ type: "date", value: f.from, "data-testid": "order-from" });
  const to = input({ type: "date", value: f.to, "data-testid": "order-to" });
  const note = h("p", { class: "field__hint", hidden: true, "data-testid": "date-note" }, t("orders.dateNote"));
  const area = h("div", { class: "list-area" });

  root.append(
    pageHeader(t("orders.title"), { eyebrow: "ORDERS", actions: h("a", { class: "btn btn--sm", href: "#/deliveries", "data-testid": "to-deliveries" }, t("orders.toDeliveries")) }),
    h("div", { class: "filters" },
      h("div", { class: "filters__search" }, q),
      h("div", { class: "filters__row" }, payment, fulfillment, status),
      h("div", { class: "filters__row filters__dates" }, field(t("orders.dateFrom"), from), field(t("orders.dateTo"), to)),
      button(t("orders.clear"), { small: true, "data-testid": "order-clear", onClick: reset })),
    note, area);

  let seq = 0;
  async function load() {
    const my = ++seq;
    note.hidden = !(f.from || f.to);
    clear(area).append(loading());
    let r;
    try { r = await data.listOrders(f); } catch (e) { if (ctx.alive() && my === seq) clear(area).append(errorState(e, load)); return; }
    if (!ctx.alive() || my !== seq) return;
    clear(area);
    if (!r.orders.length) {
      area.append(emptyState(t("orders.empty.title"), f.q || f.payment || f.fulfillment || f.status || f.from || f.to ? t("orders.empty.filtered") : t("orders.empty.none")));
      return;
    }
    area.append(
      h("p", { class: "count", "data-testid": "order-count" }, t("orders.count", { n: format.number(r.total) })),
      h("div", { class: "ocards" }, r.orders.map((o) => orderCard(ctx, o))),
      pager(r.page, r.total, r.pageSize, (p) => { f.page = p; load(); ctx.scrollTop(); }));
  }

  function reset() {
    Object.assign(f, blank());
    q.value = ""; from.value = ""; to.value = "";
    for (const s of [payment, fulfillment, status]) s.value = "";
    load();
  }
  const refilter = () => { f.page = 1; load(); };
  let timer;
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { f.q = q.value; refilter(); }, 300); });
  for (const [el, key] of [[payment, "payment"], [fulfillment, "fulfillment"], [status, "status"], [from, "from"], [to, "to"]]) {
    el.addEventListener("change", () => { f[key] = el.value; refilter(); });
  }
  await load();
}
