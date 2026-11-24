// Product list: search, active / in-stock filters, thumbnail, subtitle, price range.
const PAGE = 20;
// Filters survive navigating into a product and back.
const filters = { q: "", status: "", inStock: false, page: 1 };

export default async function products(root, ctx) {
  const { h, clear, pageHeader, button, input, select, toggle, dataTable, loading, errorState, emptyState, badge, icon } = ctx.ui;
  const { t, can, data, format } = ctx;

  const list = h("div", { class: "list-area" });
  const q = input({ type: "search", placeholder: t("products.search.placeholder"), value: filters.q, "data-testid": "product-search", "aria-label": t("products.search.aria") });
  const status = select([{ value: "", label: t("products.status.all") }, { value: "1", label: t("status.active") }, { value: "0", label: t("status.inactive") }], filters.status,
    { "data-testid": "product-status", "aria-label": t("products.status.aria") });
  const stock = toggle(t("products.inStock"), filters.inStock, { onChange: (v) => { filters.inStock = v; filters.page = 1; draw(); } });
  stock.input.dataset.testid = "product-instock";

  root.append(
    pageHeader(t("products.title"), { eyebrow: "PRODUCTS", actions: can("product.create") ? button(t("products.new"), { kind: "primary", onClick: () => ctx.navigate("/products/new"), "data-testid": "product-new" }) : null }),
    h("div", { class: "toolbar" }, q, status, stock.el),
    list);

  let all = [];
  let timer;
  async function fetchAll() {
    clear(list).append(loading());
    try {
      all = await data.listProducts({ q: filters.q.trim(), status: filters.status });
    } catch (e) {
      if (!ctx.alive()) return;
      clear(list).append(errorState(e, fetchAll));
      return;
    }
    if (ctx.alive()) draw();
  }

  function thumb(p) {
    const img = (p.images || [])[0];
    return h("span", { class: "thumb" }, img ? h("img", { src: img.urls.thumb, alt: img.alt || "", loading: "lazy" }) : icon("image", 22));
  }

  function draw() {
    const rows = all.filter((p) => !filters.inStock || ctx.logic.summarizeSkus(p.skus).inStock);
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    filters.page = Math.min(filters.page, pages);
    const slice = rows.slice((filters.page - 1) * PAGE, filters.page * PAGE);
    clear(list);
    if (!rows.length) {
      const filtered = filters.q || filters.status !== "" || filters.inStock;
      list.append(filtered
        ? emptyState(t("products.empty.filtered.title"), t("products.empty.filtered.hint"))
        : emptyState(t("products.empty.none.title"), can("product.create") ? t("products.empty.none.hintCreate") : t("products.empty.none.hintView")));
      return;
    }
    list.append(
      h("p", { class: "count", "data-testid": "product-count" }, t("products.count", { n: format.number(rows.length) })),
      dataTable({
        rows: slice,
        rowAttrs: (p) => ({ "data-slug": p.slug, "data-testid": "product-row" }),
        onRowClick: (p) => ctx.navigate(`/products/${p.id}`),
        columns: [
          { label: t("products.col.product"), primary: true, class: "col-product", render: (p) => h("a", { class: "pcell", href: `#/products/${p.id}` },
            thumb(p), h("span", { class: "pcell__text" }, h("strong", {}, p.title), p.subtitle ? h("span", { class: "pcell__sub" }, p.subtitle) : "")) },
          { label: t("products.col.price"), render: (p) => format.range(ctx.logic.summarizeSkus(p.skus).min, ctx.logic.summarizeSkus(p.skus).max) },
          { label: t("products.col.stock"), render: (p) => { const s = ctx.logic.summarizeSkus(p.skus); return s.inStock ? format.number(s.stock) : badge(t("products.noStock"), "warn"); } },
          { label: t("products.col.status"), render: (p) => p.status === 1 ? badge(t("status.active"), "ok") : badge(t("status.inactive")) },
        ],
      }),
      pages > 1 ? h("div", { class: "pager" },
        button(t("pager.prev"), { small: true, disabled: filters.page <= 1, onClick: () => { filters.page--; draw(); ctx.scrollTop(); } }),
        h("span", {}, `${filters.page} / ${pages}`),
        button(t("pager.next"), { small: true, disabled: filters.page >= pages, onClick: () => { filters.page++; draw(); ctx.scrollTop(); } })) : "");
  }

  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { filters.q = q.value; filters.page = 1; fetchAll(); }, 300); });
  status.addEventListener("change", () => { filters.status = status.value; filters.page = 1; fetchAll(); });
  await fetchAll();
}
