// Small presentation helpers shared by the customer screens. Points are POINTS, never money: they never
// go through format.money. Customers who only ever checked out as guests are labelled 訪客 (via copy), not 會員.
export const formatPoints = (ctx, n) => ctx.t("points.format", { n: ctx.format.number(n) });

export const identity = (ctx, m) => (m.registered ? ctx.ui.badge(ctx.t("member.registered"), "ok") : ctx.ui.badge(ctx.t("member.guest")));

export const memberTabs = (ctx, on) => (ctx.can("member_tier.view")
  ? ctx.ui.segmented([
    { label: ctx.t("members.seg.members"), href: "#/members", on: on === "list", testid: "seg-members" },
    { label: ctx.t("members.seg.tiers"), href: "#/members/tiers", on: on === "tiers", testid: "seg-tiers" },
  ])
  : "");
