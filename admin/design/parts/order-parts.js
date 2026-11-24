// Order vocabulary for display: status chips and the order card shared by the orders list, today's
// deliveries, the home screen and the customer detail. Presentation only; every function takes the ctx
// the view received (this file imports nothing from the core).

const PAY_KIND = { 0: "warn", 1: "ok", 2: "bad", 3: "warn" };
const FUL_KIND = { 0: "", 1: "ok", 2: "ok", 3: "bad", 4: "warn" };

export const paymentLabel = (ctx, n) => ctx.t(`payment.${n}`);
export const fulfillmentLabel = (ctx, n) => ctx.t(`fulfillment.${n}`);
export const shipmentLabel = (ctx, n) => ctx.t(`shipment.${n}`);
export const paymentRecordLabel = (ctx, n) => ctx.t(`paymentRecord.${n}`);

export const paymentChip = (ctx, o) => ctx.ui.badge(paymentLabel(ctx, o.payment_status), PAY_KIND[o.payment_status] ?? "");
export const fulfillmentChip = (ctx, o) => ctx.ui.badge(fulfillmentLabel(ctx, o.fulfillment_status), FUL_KIND[o.fulfillment_status] ?? "");
export const hasGift = (o) => (o.items || []).some((i) => (i.gift_message || "").trim());

/** Chips for an order: cancelled replaces the others' meaning but we still show payment. */
export function orderChips(ctx, o) {
  const { h, badge } = ctx.ui;
  return h("span", { class: "chips" },
    o.status === 1 ? badge(ctx.t("order.cancelled"), "bad") : "",
    paymentChip(ctx, o), fulfillmentChip(ctx, o),
    hasGift(o) ? badge(ctx.t("order.hasGift"), "gift") : "");
}

/** "2026-11-24" -> "11/24（二）"; adds 今天 / 明天 when it is. Date strings are calendar days, no timezone. */
export function deliveryLabel(ctx, date) {
  if (!date) return ctx.t("delivery.unspecified");
  const [y, m, d] = date.split("-").map(Number);
  const dayIndex = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const wd = ctx.t("delivery.weekdays")[dayIndex];
  const today = ctx.format.taipeiDate();
  const tag = date === today ? ctx.t("delivery.todayTag") : date === ctx.format.addDays(today, 1) ? ctx.t("delivery.tomorrowTag") : "";
  return ctx.t("delivery.format", { tag, m, d, wd });
}

export function shippingAddressText(a) {
  return [a?.postal_code, a?.city, a?.line1, a?.line2].filter(Boolean).join(" ");
}

/** A tappable card summarising one order. */
export function orderCard(ctx, o) {
  const { h } = ctx.ui;
  const a = o.shipping_address || {};
  const today = o.requested_delivery_date === ctx.format.taipeiDate();
  return h("a", { class: `ocard${o.status === 1 ? " is-cancelled" : ""}`, href: `#/orders/${o.id}`, "data-testid": "order-card", "data-order-id": String(o.id) },
    h("div", { class: "ocard__top" },
      h("strong", { class: "ocard__no" }, `#${o.id}`),
      orderChips(ctx, o),
      h("span", { class: "ocard__total" }, ctx.format.money(o.total_amount))),
    h("div", { class: "ocard__mid" },
      h("span", { class: "ocard__who" }, a.recipient_name || "—", a.phone ? h("span", { class: "muted" }, `　${a.phone}`) : ""),
      h("span", { class: `ocard__date${today ? " is-today" : ""}` }, ctx.t("orderCard.deliveryPrefix"), deliveryLabel(ctx, o.requested_delivery_date))),
    hasGift(o) ? h("div", { class: "ocard__gift" }, ctx.t("orderCard.giftPrefix"), (o.items.find((i) => (i.gift_message || "").trim()) || {}).gift_message) : "");
}

// ── Deliveries ordering (shared by the deliveries screen and the home screen) ──
/** 0 = still to prepare, 1 = already shipped, 2 = unpaid. */
export const deliveryRank = (ctx, o) => {
  const { PAYMENT, FULFILLMENT } = ctx.enums;
  return o.payment_status === PAYMENT.UNPAID ? 2 : (o.fulfillment_status === FULFILLMENT.NONE || o.fulfillment_status === FULFILLMENT.PARTIAL) ? 0 : 1;
};
/** To prepare first, then already shipped, then unpaid; newest first inside each group. */
export const sortDeliveries = (ctx, list) => [...list].sort((a, b) => deliveryRank(ctx, a) - deliveryRank(ctx, b) || b.id - a.id);
