// Shared pieces of the design history screens (views/design-history.js, views/design-request.js). Presentation only: every function takes
// the ctx the view received and imports nothing from the core. All text from the platform or the design service (prompts, names, paths,
// reasons) is DATA and goes in through textContent (h() children), never as HTML.

export const STATUSES = ["awaiting_approval", "drafting", "previewing", "approved", "published", "rejected", "failed", "cancelled", "reverted"];
const STATUS_KIND = { awaiting_approval: "warn", approved: "ok", published: "ok", failed: "bad", rejected: "bad" };
export const CANCELLABLE = ["drafting", "previewing", "awaiting_approval"];
export const NO_SHOTS_YET = ["drafting", "previewing", "failed", "cancelled"];

export const statusLabel = (ctx, status) => (STATUSES.includes(status) ? ctx.t(`dh.status.${status}`) : "—");
export const statusChip = (ctx, status) => ctx.ui.badge(statusLabel(ctx, status), STATUS_KIND[status] || "");
export const siteLabel = (ctx, site) => ctx.t(site === "admin" ? "dh.site.admin" : "dh.site.storefront");
export const kindLabel = (ctx, kind) => ctx.t(kind === "revert" ? "dh.kind.revert" : "dh.kind.change");
export const personName = (ctx, name) => name || ctx.t("dh.unknownPerson");
export const when = (ctx, iso) => (iso ? ctx.format.dateTime(iso) : "—");
export const shortSha = (sha) => (sha ? sha.slice(0, 7) : "");

/** The "currently in use" marker of a row (the platform's isCurrent). */
export const currentMark = (ctx) => ctx.ui.badge(ctx.t("dh.current"), "gift");

/** Plain text, shortened to `max` characters with a keyboard-operable expand / collapse button. */
export function longText(ctx, text, { max = 240, testid = "" } = {}) {
  const { h, button } = ctx.ui;
  const chars = Array.from(String(text || ""));
  const long = chars.length > max;
  const body = h("p", { class: "dh-text", "data-testid": testid });
  let open = false;
  const toggle = long ? button("", { kind: "ghost", "data-testid": `${testid || "text"}-toggle`, onClick: () => { open = !open; draw(); } }) : "";
  function draw() {
    body.textContent = open || !long ? chars.join("") : chars.slice(0, max).join("") + "…";
    if (toggle) { toggle.textContent = open ? ctx.t("dh.collapse") : ctx.t("dh.expand"); }
  }
  draw();
  return h("div", { class: "dh-long" }, body, toggle);
}

/** A label / value list; entries with an empty value are left out. rows: [[label, value(Node|string), testid?]] */
export function factList(ctx, rows, testid = "") {
  const { h } = ctx.ui;
  const items = rows.filter(([, v]) => v !== "" && v !== null && v !== undefined);
  return h("dl", { class: "dh-facts", "data-testid": testid || null }, items.map(([label, value, id]) =>
    h("div", { class: "dh-fact", "data-testid": id || null }, h("dt", {}, label), h("dd", {}, value))));
}
