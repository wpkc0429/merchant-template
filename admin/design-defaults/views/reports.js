// Sales report: date range with presets, totals as cards, an inline-SVG bar chart (no chart library),
// the per-day/month table and the product ranking. All numbers come from the API as-is; the only
// derived thing is the chart's zero-filled days (a day with no counted orders really is 0).
// The core validates the range (dates, order, maximum length) before any request.
const PRESETS = ["today", "7d", "30d", "month"];

let state = null; // survives leaving and coming back

export default async function reports(root, ctx) {
  const { h, svg, clear, pageHeader, button, input, field, select, loading, errorState, emptyState, toast, card, dataTable } = ctx.ui;
  const { t, data, logic, format, errorMessage } = ctx;
  if (!state) state = { ...logic.presetRange("30d"), groupBy: "day", preset: "30d" };

  const from = input({ type: "date", value: state.from, "data-testid": "rep-from" });
  const to = input({ type: "date", value: state.to, "data-testid": "rep-to", max: format.taipeiDate() });
  const group = select([{ value: "day", label: t("reports.group.day") }, { value: "month", label: t("reports.group.month") }], state.groupBy,
    { "data-testid": "rep-group", "aria-label": t("reports.group.aria") });
  const presetBtns = PRESETS.map((key) => button(t(`reports.preset.${key}`), { small: true, "data-testid": `rep-preset-${key}`, class: "btn btn--sm chipbtn", onClick: () => { Object.assign(state, logic.presetRange(key), { preset: key }); sync(); load(); } }));
  const out = h("div", { class: "view" });
  root.append(
    pageHeader(t("reports.title"), { eyebrow: "REPORTS" }),
    card(h("div", { class: "presets" }, presetBtns),
      h("div", { class: "rep-range" }, field(t("reports.from"), from), field(t("reports.to"), to), field(t("reports.groupLabel"), group)),
      button(t("reports.run"), { kind: "primary", "data-testid": "rep-run", onClick: () => { state.from = from.value; state.to = to.value; state.groupBy = group.value; state.preset = ""; sync(); load(); } })),
    out);

  function sync() {
    from.value = state.from; to.value = state.to; group.value = state.groupBy;
    presetBtns.forEach((b, i) => b.classList.toggle("is-on", PRESETS[i] === state.preset));
  }
  sync();

  let seq = 0;
  async function load() {
    const my = ++seq;
    const prev = [...out.children];
    clear(out).append(loading());
    let sales, products = null, prodErr = null;
    try {
      [sales, products] = await Promise.all([
        data.salesReport(state),
        data.productReport(state).catch((e) => { prodErr = e; return null; }),
      ]);
    } catch (e) {
      if (!(ctx.alive() && my === seq)) return;
      if (e.isActionError && e.kind === "invalid") { out.replaceChildren(...prev); toast(e.message, "error"); return; }
      clear(out).append(errorState(e, load));
      return;
    }
    if (!ctx.alive() || my !== seq) return;
    clear(out);
    out.append(h("p", { class: "field__hint", "data-testid": "rep-note" },
      t("reports.note", { from: state.from, to: state.to, tz: sales.timezone?.name || "Asia/Taipei" })));
    if (!sales.currencies.length) {
      out.append(h("div", { "data-testid": "rep-empty" }, emptyState(t("reports.empty.title"), t("reports.empty.hint"))));
      return;
    }
    for (const c of sales.currencies) out.append(...currencyBlock(c, sales.currencies.length > 1));
    out.append(productBlock(products, prodErr));
  }
  const stat = (label, value, sub, testid) => h("div", { class: "stat", "data-testid": testid }, h("div", { class: "stat__label" }, label), h("div", { class: "stat__value stat__value--sm" }, value), h("div", { class: "stat__sub" }, sub));

  function currencyBlock(c, many) {
    const s = c.summary;
    const money = (n) => (c.currency === "TWD" ? format.money(n) : `${c.currency} ${format.number(n)}`);
    const cards = h("div", { class: "stats stats--tri", "data-testid": "rep-cards" },
      stat(t("reports.stat.orders"), format.number(s.order_count), "", "rep-orders"),
      stat(t("reports.stat.total"), money(s.total_amount), t("reports.stat.totalSub"), "rep-total"),
      stat(t("reports.stat.subtotal"), money(s.subtotal_amount), "", "rep-subtotal"),
      stat(t("reports.stat.discount"), money(s.discount_amount), t("reports.stat.discountSub"), "rep-discount"),
      stat(t("reports.stat.shipping"), money(s.shipping_fee), "", "rep-shipping"),
      stat(t("reports.stat.net"), money(s.net_amount), "", "rep-net"));
    const side = h("div", { class: "stats stats--quiet", "data-testid": "rep-other" },
      stat(t("reports.side.returned"), t("reports.side.count", { n: format.number(s.returned_order_count) }), t("reports.side.returnedSub", { amount: money(s.returned_total_amount) }), "rep-returned"),
      stat(t("reports.side.cancelled"), t("reports.side.count", { n: format.number(s.cancelled_order_count) }), "", "rep-cancelled"),
      stat(t("reports.side.unpaid"), t("reports.side.count", { n: format.number(s.unpaid_order_count) }), "", "rep-unpaid"));
    const unit = state.groupBy === "month" ? t("reports.unit.month") : t("reports.unit.day");
    const chartCard = card(h("div", { class: "card__head" }, h("h2", {}, t("reports.chart.title", { unit }))), chart(c, money),
      h("p", { class: "field__hint" }, state.groupBy === "day" ? t("reports.chart.hintDay") : t("reports.chart.hintMonth")));
    const table = dataTable({
      rows: c.buckets,
      rowAttrs: (b) => ({ "data-testid": "rep-row", "data-period": b.period }),
      columns: [
        { label: state.groupBy === "month" ? t("reports.col.month") : t("reports.col.date"), primary: true, render: (b) => h("strong", {}, b.period) },
        { label: t("reports.col.orders"), render: (b) => format.number(b.order_count) },
        { label: t("reports.col.subtotal"), render: (b) => money(b.subtotal_amount) },
        { label: t("reports.col.discount"), render: (b) => money(b.discount_amount) },
        { label: t("reports.col.shipping"), render: (b) => money(b.shipping_fee) },
        { label: t("reports.col.total"), render: (b) => h("strong", {}, money(b.total_amount)) },
      ],
    });
    return [many ? h("h2", { class: "sec" }, c.currency) : "", cards, side, chartCard, table];
  }

  /** Simple vertical bars of total_amount. viewBox scales to any width, so it fits a 390px phone. */
  function chart(c, money) {
    const rows = state.groupBy === "day" ? logic.fillDays(c.buckets, state.from, state.to) : c.buckets;
    const W = 640, H = 220, padL = 8, padR = 8, padT = 12, padB = 26;
    const max = Math.max(1, ...rows.map((b) => b.total_amount));
    const slot = (W - padL - padR) / rows.length;
    const bw = Math.max(1, Math.min(34, slot * 0.7));
    const el = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": t("reports.chart.aria"), "data-testid": "rep-chart" });
    el.append(svg("line", { x1: padL, x2: W - padR, y1: H - padB, y2: H - padB, class: "chart__axis" }));
    rows.forEach((b, i) => {
      const hgt = b.total_amount > 0 ? Math.max(2, (b.total_amount / max) * (H - padT - padB)) : 0;
      const x = padL + i * slot + (slot - bw) / 2;
      const bar = svg("rect", { x, y: H - padB - hgt, width: bw, height: hgt, rx: Math.min(3, bw / 2), class: "chart__bar", "data-period": b.period, "data-amount": b.total_amount });
      bar.append(svg("title", {}, t("reports.chart.bar", { period: b.period, amount: money(b.total_amount), n: format.number(b.order_count) })));
      el.append(bar);
    });
    const ticks = Math.min(rows.length, 6);
    for (let k = 0; k < ticks; k++) {
      const i = ticks === 1 ? 0 : Math.round((k * (rows.length - 1)) / (ticks - 1));
      const label = rows[i].period.length > 7 ? rows[i].period.slice(5) : rows[i].period;
      el.append(svg("text", { x: padL + i * slot + slot / 2, y: H - 8, class: "chart__tick", "text-anchor": k === 0 && ticks > 1 ? "start" : k === ticks - 1 && ticks > 1 ? "end" : "middle" }, label));
    }
    el.append(svg("text", { x: padL, y: 10, class: "chart__tick" }, t("reports.chart.max", { amount: money(max) })));
    return h("div", { class: "chart-wrap" }, el);
  }

  function productBlock(products, err) {
    const head = h("div", { class: "card__head" }, h("h2", {}, t("reports.products.title")));
    if (err) return card(head, h("p", { class: "form-error" }, errorMessage(err)));
    const cur = products?.currencies?.[0];
    if (!cur || !cur.items.length) return card(head, h("p", { class: "muted", "data-testid": "rep-products-empty" }, t("reports.products.none")));
    return card(head,
      dataTable({
        rows: cur.items,
        rowAttrs: () => ({ "data-testid": "rep-product-row" }),
        columns: [
          { label: t("reports.products.col.product"), primary: true, render: (r) => h("span", { class: "pcell__text" }, h("strong", {}, r.product_title), h("span", { class: "pcell__sub" }, r.sku_code)) },
          { label: t("reports.products.col.qty"), render: (r) => format.number(r.quantity) },
          { label: t("reports.products.col.sales"), render: (r) => format.money(r.gross_amount) },
        ],
      }),
      h("p", { class: "field__hint" }, t("reports.products.note")));
  }

  await load();
}
