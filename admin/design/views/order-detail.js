// Order detail: gift message first (staff write the card from it), delivery, items, amounts,
// payment, shipments with their actions, and the timeline. Actions are offered by permission AND by
// state here, but the CORE re-checks permission, state, validation and shows the confirmation dialog for
// every irreversible one (ctx.actions.*); the API remains the authority.
import { orderChips, paymentChip, shipmentLabel, paymentRecordLabel, deliveryLabel, shippingAddressText } from "../parts/order-parts.js";

const sizeOf = (sku) => (/-(S|M|L)$/.exec(sku || "") || [])[1] || "";

export default async function orderDetail(root, ctx) {
  const { h, clear, button, input, field, applyFieldErrors, setFieldError, pageHeader, card, toast, showDialog, loading, errorState, badge } = ctx.ui;
  const { t, can, data, logic, format, actions, errorMessage } = ctx;
  const id = Number(ctx.route.params.id);

  const kv = (k, v, attrs) => h("div", { class: "kv", ...(attrs || {}) }, h("span", { class: "kv__k" }, k), h("span", { class: "kv__v" }, v));
  const ERR_SHIP = { 409: t("order.err.ship409"), 422: t("order.err.ship422") };
  const ERR_ADVANCE = { 409: t("err.shipmentChanged"), 403: t("err.403") };
  const ERR_CANCEL = { 409: t("err.cancelBlocked") };

  const body = h("div", { class: "view" });
  root.append(body);

  async function load() {
    let order, payments = [], shipments = [], payErr = null, shipErr = null;
    try { order = await data.getOrder(id); } catch (e) {
      if (ctx.alive()) clear(body).append(h("a", { class: "backlink", href: "#/orders" }, t("order.back")), errorState(e, load));
      return;
    }
    const jobs = [];
    if (can("payment.view")) jobs.push(data.listOrderPayments(id).then((r) => { payments = r; }).catch((e) => { payErr = e; }));
    if (can("shipment.view")) jobs.push(data.listOrderShipments(id).then((r) => { shipments = r; }).catch((e) => { shipErr = e; }));
    await Promise.all(jobs);
    if (ctx.alive()) draw(order, payments, shipments, { payErr, shipErr });
  }

  function draw(o, payments, shipments, errs) {
    const a = o.shipping_address || {};
    const gifts = (o.items || []).filter((i) => (i.gift_message || "").trim());
    clear(body).append(
      h("a", { class: "backlink", href: "#/orders", "data-testid": "back-orders" }, t("order.back")),
      pageHeader(t("order.title", { id: o.id }), { eyebrow: format.dateTime(o.created_at) }),
      h("div", { class: "detail-chips", "data-testid": "detail-chips" }, orderChips(ctx, o)),

      // Gift message: large, first, impossible to miss.
      gifts.length
        ? card(h("div", { class: "card__head" }, h("h2", {}, t("order.gift.title"))),
          ...gifts.map((i) => h("blockquote", { class: "gift", "data-testid": "gift-message" },
            h("p", { class: "gift__text" }, i.gift_message),
            h("footer", { class: "gift__for" }, t("order.gift.for", { title: i.product_title, size: sizeOf(i.sku_code) ? `　${sizeOf(i.sku_code)}` : "", qty: i.quantity })))))
        : h("p", { class: "muted", "data-testid": "no-gift" }, t("order.gift.none")),

      card(h("div", { class: "card__head" }, h("h2", {}, t("order.delivery.title"))),
        h("div", { class: "kvs" },
          kv(t("order.delivery.date"), h("strong", { class: "bigdate", "data-testid": "delivery-date" }, deliveryLabel(ctx, o.requested_delivery_date))),
          kv(t("order.delivery.recipient"), a.recipient_name || "—", { "data-testid": "recipient" }),
          kv(t("order.delivery.phone"), a.phone ? h("a", { href: `tel:${a.phone}` }, a.phone) : "—"),
          kv(t("order.delivery.address"), shippingAddressText(a) || "—"),
          kv(t("order.delivery.method"), o.shipping_method_name || "—"))),

      card(h("div", { class: "card__head" }, h("h2", {}, t("order.items.title"))),
        h("div", { class: "lines", "data-testid": "items" }, (o.items || []).map((i) => h("div", { class: "line", "data-sku": i.sku_code },
          h("div", { class: "line__main" },
            h("strong", {}, i.product_title),
            h("span", { class: "muted" }, `${t("order.items.sku", { sku: i.sku_code })}${sizeOf(i.sku_code) ? t("order.items.size", { size: sizeOf(i.sku_code) }) : ""}`)),
          h("div", { class: "line__qty" }, `${format.money(i.price_amount)} × ${i.quantity}`, h("small", { "data-testid": "shipped-qty" }, t("order.items.shipped", { shipped: i.shipped_quantity || 0, qty: i.quantity }))),
          h("div", { class: "line__total" }, format.money(i.line_total)))))),

      card(h("div", { class: "card__head" }, h("h2", {}, t("order.amounts.title"))),
        h("div", { class: "kvs", "data-testid": "amounts" },
          kv(t("order.amounts.subtotal"), format.money(o.subtotal_amount), { "data-testid": "amt-subtotal" }),
          Number(o.discount_amount) > 0 ? kv(t("order.amounts.discount", { tier: o.member_tier_name ? t("order.amounts.discountTier", { name: o.member_tier_name }) : "" }), `－${format.money(o.discount_amount)}`, { "data-testid": "amt-discount" }) : "",
          kv(t("order.amounts.shipping"), format.money(o.shipping_fee), { "data-testid": "amt-shipping" }),
          kv(t("order.amounts.total"), h("strong", {}, format.money(o.total_amount)), { "data-testid": "amt-total" }))),

      paymentCard(o, payments, errs.payErr),
      shipmentsCard(o, shipments, errs.shipErr),
      timelineCard(o, payments, shipments),
      cancelCard(o));
  }

  function paymentCard(o, payments, err) {
    const parts = [h("div", { class: "card__head" }, h("h2", {}, t("order.payment.title")), paymentChip(ctx, o))];
    if (!can("payment.view")) return card(...parts);
    if (err) parts.push(h("p", { class: "form-error" }, errorMessage(err)));
    else if (!payments.length) parts.push(h("p", { class: "muted" }, t("order.payment.none")));
    else parts.push(h("div", { class: "lines", "data-testid": "payments" }, payments.map((p) => h("div", { class: "line", "data-testid": "payment-row" },
      h("div", { class: "line__main" }, h("strong", {}, `${p.provider}　${paymentRecordLabel(ctx, p.status) ?? p.status}`), h("span", { class: "muted mono" }, p.provider_reference)),
      h("div", { class: "line__qty" }, format.dateTime(p.paid_at || p.created_at)),
      h("div", { class: "line__total" }, format.money(p.amount))))));
    parts.push(h("p", { class: "field__hint" }, t("order.payment.note")));
    return card(...parts);
  }

  function shipmentsCard(o, shipments, err) {
    const parts = [h("div", { class: "card__head" }, h("h2", {}, t("order.shipments.title")))];
    if (!can("shipment.view") && !can("shipment.create")) return card(...parts, h("p", { class: "muted" }, t("order.shipments.noView")));
    if (err) return card(...parts, h("p", { class: "form-error" }, errorMessage(err)));
    const byID = new Map((o.items || []).map((i) => [i.id, i]));
    if (!shipments.length) parts.push(h("p", { class: "muted", "data-testid": "no-shipments" }, t("order.shipments.none")));
    for (const s of shipments) parts.push(parcel(o, s, byID));

    if (can("shipment.create")) {
      const why = logic.shipBlocker(o, shipments);
      if (why) parts.push(h("p", { class: "notice", "data-testid": "ship-blocker" }, t(`shipBlocker.${why}`)));
      else {
        const outstanding = (o.items || []).filter((i) => logic.remainingQty(i) > 0);
        const pieces = outstanding.reduce((n, i) => n + logic.remainingQty(i), 0);
        parts.push(h("div", { class: "actions" },
          button(t("order.ship.all"), { kind: "primary", "data-testid": "ship-all", onClick: () => shipDialog(o, null) }),
          pieces > 1 ? button(t("order.ship.partial"), { "data-testid": "ship-partial", onClick: () => shipDialog(o, outstanding) }) : ""));
      }
    }
    return card(...parts);
  }

  function parcel(o, s, byID) {
    const acts = [];
    if (s.status === ctx.enums.SHIPMENT.SHIPPED && can("shipment.update")) {
      acts.push(button(t("order.parcel.markDelivered"), { kind: "primary", small: true, "data-testid": "mark-delivered", onClick: () => advance(o, s, "delivered") }));
      if (can("shipment.return")) acts.push(button(t("order.parcel.markReturned"), { kind: "danger-ghost", small: true, "data-testid": "mark-returned", onClick: () => advance(o, s, "returned") }));
    }
    return h("div", { class: "parcel", "data-testid": "parcel", "data-shipment-id": String(s.id) },
      h("div", { class: "parcel__head" }, h("strong", {}, t("order.parcel.title", { id: s.id })), badge(shipmentLabel(ctx, s.status) ?? s.status, s.status === 3 ? "bad" : "ok")),
      h("div", { class: "kvs" },
        kv(t("order.parcel.carrier"), s.carrier || "—"),
        kv(t("order.parcel.tracking"), s.tracking_number ? h("span", { class: "mono" }, s.tracking_number) : "—"),
        kv(t("order.parcel.shippedAt"), format.dateTime(s.shipped_at)),
        s.delivered_at ? kv(t("order.parcel.deliveredAt"), format.dateTime(s.delivered_at)) : ""),
      h("ul", { class: "parcel__items" }, (s.items || []).map((si) => {
        const it = byID.get(si.order_item_id);
        return h("li", {}, t("order.parcel.item", { title: it ? it.product_title : t("order.parcel.unknownItem", { id: si.order_item_id }), qty: si.quantity }));
      })),
      acts.length ? h("div", { class: "actions" }, acts) : "");
  }

  function shipDialog(o, partialItems) {
    const carrier = input({ value: o.shipping_method_name || "", maxlength: "100", "data-testid": "ship-carrier", autocomplete: "off", placeholder: t("order.ship.carrierPlaceholder") });
    const tracking = input({ maxlength: "100", "data-testid": "ship-tracking", autocomplete: "off", placeholder: t("order.ship.trackingPlaceholder") });
    const wCarrier = field(t("order.ship.carrier"), carrier, { pointer: "/carrier" });
    const wTrack = field(t("order.ship.tracking"), tracking);
    const rows = (partialItems || []).map((i) => {
      const qty = input({ value: String(logic.remainingQty(i)), inputmode: "numeric", "data-testid": "ship-qty", "data-item": String(i.id), "aria-label": t("order.ship.qtyAria", { title: i.product_title }) });
      return { i, qty, w: field(t("order.ship.qtyLabel", { title: i.product_title, n: logic.remainingQty(i) }), qty, { pointer: `/qty/${i.id}` }) };
    });
    const content = h("div", { class: "form" },
      partialItems ? h("p", { class: "dlg__msg" }, t("order.ship.partialHint"))
        : h("p", { class: "dlg__msg" }, t("order.ship.allHint")),
      wCarrier, wTrack, ...rows.map((r) => r.w));
    showDialog({
      title: partialItems ? t("order.ship.partial") : t("order.ship.all"),
      content,
      actions: [
        { label: t("common.cancel"), kind: "ghost" },
        { label: t("order.ship.confirm"), kind: "primary", testid: "ship-confirm", onClick: async () => {
          for (const w of [wCarrier, ...rows.map((r) => r.w)]) setFieldError(w, "");
          const quantities = partialItems ? Object.fromEntries(rows.map((r) => [r.i.id, r.qty.value])) : null;
          try {
            await actions.createShipment(o.id, { carrier: carrier.value, tracking: tracking.value, quantities });
            toast(t("order.ship.created"));
            await load();
          } catch (e) {
            if (e.fields) {
              const unplaced = applyFieldErrors(content, e.fields);
              for (const m of unplaced) toast(m, "error");
            } else toast(errorMessage(e, ERR_SHIP), "error");
            return false;
          }
        } },
      ],
    });
    carrier.focus();
  }

  async function advance(o, s, target) {
    const returned = target === "returned";
    try {
      const r = await actions.advanceShipment(o.id, s.id, target);
      if (r.cancelled) return;
      toast(returned ? t("order.parcel.returnedToast") : t("order.parcel.deliveredToast"));
      await load();
    } catch (e) { toast(errorMessage(e, ERR_ADVANCE), "error"); }
  }

  function timelineCard(o, payments, shipments) {
    return card(h("div", { class: "card__head" }, h("h2", {}, t("order.timeline.title"))),
      h("ol", { class: "timeline", "data-testid": "timeline" }, logic.timeline(o, payments, shipments).map((e) =>
        h("li", {}, h("span", { class: "timeline__at" }, format.dateTime(e.at)), h("span", {}, t(`order.timeline.${e.kind}`, { provider: e.provider ?? "", id: e.id ?? "", carrier: e.carrier ?? "" }))))));
  }

  function cancelCard(o) {
    if (!can("order.cancel") || o.status === ctx.enums.ORDER_STATUS.CANCELLED) return "";
    if (!logic.canCancelOrder(o)) return h("p", { class: "field__hint", "data-testid": "cancel-note" }, t("order.cancel.note"));
    return card(h("div", { class: "card__head" }, h("h2", {}, t("order.cancel.title"))),
      h("p", { class: "muted" }, t("order.cancel.text")),
      h("div", { class: "actions" }, button(t("order.cancel.button"), { kind: "danger-ghost", "data-testid": "cancel-order", onClick: async () => {
        try {
          const r = await actions.cancelOrder(o.id);
          if (r.cancelled) return;
          toast(t("order.cancel.done"));
          await load();
        } catch (e) { toast(errorMessage(e, ERR_CANCEL), "error"); }
      } })));
  }

  body.append(loading());
  await load();
}
