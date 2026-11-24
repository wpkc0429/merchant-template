// The app shell: bottom tab bar on phones, sidebar on desktop, the "more" sheet, the content area.
// ctx.nav.items already holds ONLY the destinations the person's permissions allow (the core filters
// them): this file may reorder, relabel, restyle or omit items but cannot add one the core did not list.
// Must return { main, setActive(navKey) }; `main` is where the core mounts each screen.
const TAB_KEYS = ["home", "orders", "deliveries", "products"]; // the primary phone destinations, in order

export default function shell(root, ctx) {
  const { h, icon, showDialog } = ctx.ui;
  const { t } = ctx;
  const items = ctx.nav.items;
  const tabs = TAB_KEYS.map((k) => items.find((n) => n.key === k)).filter(Boolean);
  const rest = items.filter((n) => !tabs.includes(n));
  const shopName = ctx.session.shopName || t("app.name");

  const navLink = (n, cls) => h("a", { class: cls, href: n.href, "data-nav": n.key, "data-testid": `nav-${n.key}` }, icon(n.icon), h("span", {}, t(`nav.${n.key}`)));
  const brand = () => h("a", { class: "brand", href: "#/" }, h("img", { class: "brand-logo", alt: "", hidden: true }), h("span", { class: "brand-name" }, shopName));

  const sidebar = h("nav", { class: "sidebar", "aria-label": t("nav.aria") }, brand(),
    h("div", { class: "sidebar__list" }, items.map((n) => navLink(n, "navlink"))),
    h("div", { class: "sidebar__foot" },
      h("div", { class: "who", title: ctx.session.userEmail }, ctx.session.userEmail),
      h("button", { class: "navlink navlink--btn", type: "button", "data-testid": "logout", onclick: () => ctx.auth.logout() }, icon("logout"), h("span", {}, t("nav.logout")))));

  const moreBtn = h("button", { class: "tab", type: "button", "data-testid": "tab-more", onclick: openMore }, icon("more"), h("span", {}, t("nav.more")));
  const tabbar = h("nav", { class: "tabbar", "aria-label": t("nav.aria") }, tabs.map((n) => navLink(n, "tab")), moreBtn);

  const topbar = h("header", { class: "topbar" }, brand());
  const main = h("main", { class: "main", id: "main" });
  root.append(h("div", { class: "shell" }, sidebar, h("div", { class: "content" }, topbar, main), tabbar));

  function openMore() {
    const list = h("div", { class: "sheet-list" },
      rest.map((n) => navLink(n, "sheet-link")),
      h("div", { class: "sheet-who" }, ctx.session.userEmail),
      h("button", { class: "sheet-link", type: "button", "data-testid": "logout-sheet", onclick: () => ctx.auth.logout() }, icon("logout"), h("span", {}, t("nav.logout"))));
    const { close } = showDialog({ title: t("nav.more"), content: list, actions: [{ label: t("nav.close"), kind: "ghost" }] });
    list.addEventListener("click", (e) => { if (e.target.closest("a")) close(); });
  }

  function setActive(key) {
    for (const a of sidebar.querySelectorAll("[data-nav]")) a.classList.toggle("is-on", a.dataset.nav === key);
    for (const a of tabbar.querySelectorAll("[data-nav]")) a.classList.toggle("is-on", a.dataset.nav === key);
    moreBtn.classList.toggle("is-on", rest.some((n) => n.key === key));
  }

  return { main, setActive };
}
