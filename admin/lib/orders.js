// Orders, payments and shipments (data access + the state rules the UI mirrors).
// The API is the authority for every rule below; these helpers only decide what to OFFER.
import { api } from "./api.js";
import { taipeiDate } from "./dates.js";

const base = (shopID) => `/admin/shops/${shopID}`;

// Enumerations (the API owns them; see the Order schema in the OpenAPI document).
export const ORDER_STATUS = { PROCESSING: 0, CANCELLED: 1 };
export const PAYMENT = { UNPAID: 0, PAID: 1, REFUNDED: 2, PARTIAL_REFUND: 3 };
export const FULFILLMENT = { NONE: 0, SHIPPED: 1, DELIVERED: 2, RETURNED: 3, PARTIAL: 4 };
export const SHIPMENT = { SHIPPED: 1, DELIVERED: 2, RETURNED: 3 };

export const ORDERS_PAGE_SIZE = 20;

/** Filters: {page, status, payment, fulfillment, from, to, q, memberID}; blank values are omitted. */
export async function listOrders(shopID, f = {}) {
  const p = new URLSearchParams({ page: String(f.page || 1), page_size: String(f.pageSize || ORDERS_PAGE_SIZE) });
  const put = (k, v) => { if (v !== "" && v !== undefined && v !== null) p.set(k, String(v)); };
  put("status", f.status); put("payment_status", f.payment); put("fulfillment_status", f.fulfillment);
  put("delivery_from", f.from); put("delivery_to", f.to); put("member_id", f.memberID);
  if (f.q && f.q.trim()) p.set("q", f.q.trim());
  const d = await api("GET", `${base(shopID)}/orders?${p}`);
  return { orders: d.orders || [], total: d.total ?? 0, page: d.page ?? 1, pageSize: d.page_size ?? ORDERS_PAGE_SIZE };
}

export const getOrder = (shopID, id) => api("GET", `${base(shopID)}/orders/${id}`);
export const listOrderPayments = async (shopID, id) => (await api("GET", `${base(shopID)}/orders/${id}/payments`)).payments || [];
export const listOrderShipments = async (shopID, id) => (await api("GET", `${base(shopID)}/orders/${id}/shipments`)).shipments || [];
export const cancelOrder = (shopID, id) => api("POST", `${base(shopID)}/orders/${id}/cancel`);

/** items omitted = ship everything not yet shipped (the server's definition); otherwise [{order_item_id, quantity}]. */
export function createShipment(shopID, orderID, { carrier, tracking, items }) {
  const body = { carrier };
  if (tracking) body.tracking_number = tracking;
  if (items) body.items = items;
  return api("POST", `${base(shopID)}/orders/${orderID}/shipments`, body);
}
/** target: "delivered" | "returned" (returned also needs shipment.return, enforced by the API). */
export const advanceShipment = (shopID, orderID, shipmentID, target) =>
  api("PUT", `${base(shopID)}/orders/${orderID}/shipments/${shipmentID}`, { status: target });

// ── State rules (what to offer; the API still decides) ─────────────────
export const remainingQty = (item) => Math.max(0, Number(item.quantity) - Number(item.shipped_quantity || 0));
export const hasUnshipped = (order) => (order.items || []).some((i) => remainingQty(i) > 0);

/** The API refuses to cancel an order that is paid or shipped (409). */
export const canCancelOrder = (o) => o.status === ORDER_STATUS.PROCESSING && o.payment_status === PAYMENT.UNPAID && o.fulfillment_status === FULFILLMENT.NONE;

/** "" when shipping may be offered; otherwise the reason code ("cancelled" | "returned" | "unpaid" | "allShipped"). Wording lives in the copy (shipBlocker.<code>). */
export function shipBlocker(o, shipments) {
  if (o.status === ORDER_STATUS.CANCELLED) return "cancelled";
  if (shipments.some((s) => s.status === SHIPMENT.RETURNED) || o.fulfillment_status === FULFILLMENT.RETURNED) return "returned";
  if (o.payment_status === PAYMENT.UNPAID) return "unpaid";
  if (!hasUnshipped(o)) return "allShipped";
  return "";
}

/** A delivery still to be done: not cancelled, not delivered, not returned. */
export const isOpenDelivery = (o) => o.status === ORDER_STATUS.PROCESSING &&
  o.fulfillment_status !== FULFILLMENT.DELIVERED && o.fulfillment_status !== FULFILLMENT.RETURNED;

// ── Quick views ────────────────────────────────────────────────────────
/** Orders with this requested delivery date (default today, Asia/Taipei) that are not yet delivered. */
export async function deliveriesOn(shopID, date = taipeiDate()) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const r = await listOrders(shopID, { from: date, to: date, status: ORDER_STATUS.PROCESSING, page, pageSize: 100 });
    out.push(...r.orders);
    if (out.length >= r.total || !r.orders.length) break;
  }
  return out.filter(isOpenDelivery);
}

/** Paid orders that still have nothing shipped, or only part of it. */
export async function unshippedPaidCount(shopID) {
  const one = (fulfillment) => listOrders(shopID, { payment: PAYMENT.PAID, status: ORDER_STATUS.PROCESSING, fulfillment, pageSize: 1 }).then((r) => r.total);
  const [none, partial] = await Promise.all([one(FULFILLMENT.NONE), one(FULFILLMENT.PARTIAL)]);
  return none + partial;
}

/** Chronological events for the timeline (all timestamps come from the API). kind: created | paid | shipped | delivered | returned | cancelled. */
export function timeline(order, payments, shipments) {
  const ev = [{ at: order.created_at, kind: "created" }];
  // paid_at is null on the mock provider's successful payments (status 1), so fall back to updated_at.
  for (const p of payments || []) if (p.status === 1) ev.push({ at: p.paid_at || p.updated_at, kind: "paid", provider: p.provider });
  for (const s of shipments || []) {
    if (s.shipped_at) ev.push({ at: s.shipped_at, kind: "shipped", id: s.id, carrier: s.carrier });
    if (s.delivered_at) ev.push({ at: s.delivered_at, kind: "delivered", id: s.id });
    if (s.status === SHIPMENT.RETURNED) ev.push({ at: s.updated_at, kind: "returned", id: s.id });
  }
  if (order.cancelled_at) ev.push({ at: order.cancelled_at, kind: "cancelled" });
  return ev.sort((x, y) => new Date(x.at) - new Date(y.at));
}
