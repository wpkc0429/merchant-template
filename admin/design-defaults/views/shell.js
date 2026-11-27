// The app shell: bottom tab bar on phones, sidebar on desktop, the "more" sheet, the content area.
// ctx.nav.items already holds ONLY the destinations the person's permissions allow (the core filters
// them): this file may reorder, relabel, restyle or omit items but cannot add one the core did not list.
// Must return { main, setActive(navKey) }; `main` is where the core mounts each screen.
const TAB_KEYS = ["home", "orders", "deliveries", "products"]; // the primary phone destinations, in order

export default function shell(root, ctx) {
  const { h, icon, showDialog, clear } = ctx.ui;
  const { t } = ctx;
  const items = ctx.nav.items;
  const tabs = TAB_KEYS.map((k) => items.find((n) => n.key === k)).filter(Boolean);
  // The design history item is hidden until the platform says AI edit is on for this shop (getDesignState().designEnabled === true) and the
  // person has design.view (the core only lists the item for them). Until then, or after any failure, the shell is exactly the one without it.
  let designOn = false;
  const shown = (n) => n.key !== "design" || designOn;
  // The design item goes LAST: showing it after the state call resolves never moves an item that was already there.
  // The personal profile item (D21) is listed by the core for everyone; this shell shows it in the account area (sidebar foot, "more" sheet), not in the main list.
  const profileItem = items.find((n) => n.key === "profile");
  const ordered = [...items.filter((n) => n.key !== "design" && n.key !== "profile"), ...items.filter((n) => n.key === "design")];
  const restItems = () => ordered.filter((n) => !tabs.includes(n) && shown(n));
  const shopName = ctx.session.shopName || t("app.name");

  let pending = 0, counting = false;
  const badges = new Map(); // link -> its badge element
  function paintOne(a) {
    const old = badges.get(a);
    if (old) { old.remove(); badges.delete(a); }
    if (pending <= 0) return;
    const b = h("span", { class: "nav-badge", "data-testid": "nav-design-badge", "aria-label": t("dh.nav.pending", { n: pending }) }, String(pending > 99 ? "99+" : pending));
    badges.set(a, b);
    a.append(b);
  }
  let current = "", sideDesign = null;
  const designLinks = []; // every link to the design history (sidebar, tab bar, "more" sheet): they carry the pending-approval badge
  const navLink = (n, cls) => {
    const a = h("a", { class: cls, href: n.href, "data-nav": n.key, "data-testid": `nav-${n.key}` }, icon(n.icon), h("span", {}, t(`nav.${n.key}`)));
    if (n.key === "design") { designLinks.push(a); paintOne(a); }
    return a;
  };
  const brand = () => h("a", { class: "brand", href: "#/" }, h("img", { class: "brand-logo", alt: "", hidden: true }), h("span", { class: "brand-name" }, shopName));

  const sideList = h("div", { class: "sidebar__list" });
  function drawSide() {
    if (sideDesign) { const i = designLinks.indexOf(sideDesign); if (i >= 0) designLinks.splice(i, 1); badges.delete(sideDesign); sideDesign = null; }
    clear(sideList);
    for (const n of ordered.filter(shown)) {
      const a = navLink(n, "navlink" + (n.key === current ? " is-on" : ""));
      if (n.key === "design") sideDesign = a;
      sideList.append(a);
    }
  }
  drawSide();
  const sidebar = h("nav", { class: "sidebar", "aria-label": t("nav.aria") }, brand(),
    sideList,
    h("div", { class: "sidebar__foot" },
      h("div", { class: "who", title: ctx.session.userEmail }, ctx.session.userEmail),
      profileItem ? navLink(profileItem, "navlink") : "",
      h("button", { class: "navlink navlink--btn", type: "button", "data-testid": "logout", onclick: () => ctx.auth.logout() }, icon("logout"), h("span", {}, t("nav.logout")))));

  const moreBtn = h("button", { class: "tab", type: "button", "data-testid": "tab-more", onclick: openMore }, icon("more"), h("span", {}, t("nav.more")));
  const tabbar = h("nav", { class: "tabbar", "aria-label": t("nav.aria") }, tabs.map((n) => navLink(n, "tab")), moreBtn);

  const topbar = h("header", { class: "topbar" }, brand());
  const main = h("main", { class: "main", id: "main" });
  root.append(h("div", { class: "shell" }, sidebar, h("div", { class: "content" }, topbar, main), tabbar));

  // The design history item shows how many designs wait for approval. Loaded lazily (only when the item exists); a failure is ignored.
  async function refreshBadge() {
    if (counting || !items.some((n) => n.key === "design") || !ctx.can("design.view")) return;
    counting = true;
    let on = false, n = 0;
    try { const st = await ctx.data.getDesignState(); on = st.designEnabled === true; n = on ? st.pendingApproval : 0; } catch { on = false; }
    counting = false;
    pending = n;
    if (on !== designOn) { designOn = on; drawSide(); }
    for (const a of designLinks) paintOne(a);
  }
  refreshBadge();

  function openMore() {
    const list = h("div", { class: "sheet-list" },
      restItems().map((n) => navLink(n, "sheet-link")),
      profileItem ? navLink(profileItem, "sheet-link") : "",
      h("div", { class: "sheet-who" }, ctx.session.userEmail),
      h("button", { class: "sheet-link", type: "button", "data-testid": "logout-sheet", onclick: () => ctx.auth.logout() }, icon("logout"), h("span", {}, t("nav.logout"))));
    const { close } = showDialog({ title: t("nav.more"), content: list, actions: [{ label: t("nav.close"), kind: "ghost" }] });
    for (const a of list.querySelectorAll("a")) a.addEventListener("click", () => close());
  }

  function setActive(key) {
    current = key;
    for (const a of sidebar.querySelectorAll("[data-nav]")) a.classList.toggle("is-on", a.dataset.nav === key);
    for (const a of tabbar.querySelectorAll("[data-nav]")) a.classList.toggle("is-on", a.dataset.nav === key);
    moreBtn.classList.toggle("is-on", restItems().some((n) => n.key === key) || key === "profile");
    if (key === "design") refreshBadge();
  }

  return { main, setActive };
}
