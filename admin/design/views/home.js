// Home: what needs doing today. Staff see today's deliveries and unshipped orders; owners also see
// low stock. Every number comes from a data function the person is allowed to call; one that fails is left out.
import { orderCard, sortDeliveries } from "../parts/order-parts.js";

const SHOWN = 5;

export default async function home(root, ctx) {
  const { h, pageHeader, card, icon } = ctx.ui;
  const { t, can, data, format } = ctx;

  function tile({ href, iconName, key, testid }) {
    return h("a", { class: "tile", href, "data-testid": testid },
      h("span", { class: "tile__icon" }, icon(iconName, 26)),
      h("span", { class: "tile__body" }, h("strong", {}, t(`home.tile.${key}.title`)), h("span", {}, t(`home.tile.${key}.text`))));
  }
  const stat = (label, value, sub, href, testid) => h("a", { class: "stat stat--link", href, "data-testid": testid },
    h("div", { class: "stat__label" }, label), h("div", { class: "stat__value" }, value), h("div", { class: "stat__sub" }, sub));

  const stats = h("div", { class: "stats", "data-testid": "home-stats" });
  const today = h("div", {});
  const stock = h("div", {});
  root.append(
    pageHeader(t("home.greeting", { shop: ctx.session.shopName || t("home.shopFallback") }), { eyebrow: format.date(new Date()) }),
    stats, today, stock,
    h("div", { class: "tiles" },
      can("order.view") && tile({ href: "#/orders", iconName: "orders", key: "orders", testid: "tile-orders" }),
      can("order.view") && tile({ href: "#/deliveries", iconName: "shipments", key: "deliveries", testid: "tile-deliveries" }),
      can("product.view") && tile({ href: "#/products", iconName: "products", key: "products", testid: "tile-products" }),
      can("category.view") && tile({ href: "#/categories", iconName: "categories", key: "categories", testid: "tile-categories" }),
      can("shipping_method.view") && tile({ href: "#/shipping-methods", iconName: "shippingMethods", key: "shipping", testid: "tile-shipping" }),
      can("member.view") && tile({ href: "#/members", iconName: "members", key: "members", testid: "tile-members" }),
      can("report.view") && tile({ href: "#/reports", iconName: "reports", key: "reports", testid: "tile-reports" }),
      can("user.manage_members") && tile({ href: "#/team", iconName: "team", key: "team", testid: "tile-team" })));

  const jobs = [];
  if (can("order.view")) {
    jobs.push(data.deliveriesOn().then((list) => {
      stats.prepend(stat(t("home.stat.today.label"), format.number(list.length), t("home.stat.today.sub"), "#/deliveries", "stat-today"));
      today.append(card(h("div", { class: "card__head" }, h("h2", {}, t("home.deliveries.title")), h("a", { href: "#/deliveries" }, t("home.deliveries.all"))),
        list.length
          ? h("div", { class: "ocards", "data-testid": "home-deliveries" }, sortDeliveries(ctx, list).slice(0, SHOWN).map((o) => orderCard(ctx, o)))
          : h("p", { class: "muted", "data-testid": "home-no-deliveries" }, t("home.deliveries.none")),
        list.length > SHOWN ? h("a", { href: "#/deliveries" }, t("home.deliveries.more", { n: list.length - SHOWN })) : ""));
    }));
    jobs.push(data.unshippedPaidCount().then((n) => {
      stats.append(stat(t("home.stat.unshipped.label"), format.number(n), t("home.stat.unshipped.sub"), "#/orders", "stat-unshipped"));
    }));
  }
  if (can("product.view")) {
    jobs.push(data.lowStockSkus().then((list) => {
      stats.append(stat(t("home.stat.lowstock.label"), format.number(list.length), t("home.stat.lowstock.sub", { n: ctx.enums.LOW_STOCK_THRESHOLD }), "#/products", "stat-lowstock"));
      if (!list.length) return;
      stock.append(card(h("div", { class: "card__head" }, h("h2", {}, t("home.lowstock.title"))),
        h("div", { class: "lines", "data-testid": "home-lowstock" }, list.slice(0, 8).map((s) => h("a", { class: "line", href: `#/products/${s.productID}`, "data-testid": "lowstock-row" },
          h("div", { class: "line__main" }, h("strong", {}, s.title), h("span", { class: "muted" }, `${s.size ? t("home.lowstock.size", { size: s.size }) : ""}${s.sku}`)),
          h("div", { class: "line__total" }, s.stock === 0 ? t("home.lowstock.soldOut") : t("home.lowstock.left", { n: s.stock })))))));
    }));
    jobs.push(data.productCount(1).then((n) => stats.append(stat(t("home.stat.products.label"), format.number(n), t("home.stat.products.sub"), "#/products", "stat-products"))));
  }
  if (can("shipping_method.view") && !can("product.view")) {
    jobs.push(data.listShippingMethods().then((list) => stats.append(stat(t("home.stat.ship.label"), format.number(list.length), t("home.stat.ship.sub", { n: list.filter((m) => m.is_active).length }), "#/shipping-methods", "stat-ship"))));
  }
  await Promise.allSettled(jobs);
}
