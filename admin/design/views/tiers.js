// Member tiers: list, create, edit. Validation and the permission checks run in the core (ctx.actions).
import { formatPoints, memberTabs } from "../parts/member-parts.js";

export default async function tiers(root, ctx) {
  const { h, clear, pageHeader, button, input, field, toast, showDialog, dataTable, loading, errorState, emptyState, applyFieldErrors, setFieldError } = ctx.ui;
  const { t, can, data, actions, errorMessage } = ctx;

  const canCreate = can("member_tier.create");
  const canEdit = can("member_tier.edit");
  const area = h("div", { class: "list-area" });
  root.append(
    pageHeader(t("tiers.title"), { eyebrow: "TIERS", actions: canCreate ? button(t("tiers.new"), { kind: "primary", "data-testid": "tier-new", onClick: () => openForm(null) }) : null }),
    memberTabs(ctx, "tiers"),
    h("p", { class: "field__hint" }, t("tiers.hint")),
    area);
  let list = [];
  async function load() {
    clear(area).append(loading());
    try { list = await data.listMemberTiers(); } catch (e) { if (ctx.alive()) clear(area).append(errorState(e, load)); return; }
    if (!ctx.alive()) return;
    clear(area).append(dataTable({
      rows: list,
      rowAttrs: (r) => ({ "data-testid": "tier-row", "data-name": r.name }),
      empty: emptyState(t("tiers.empty.title"), t("tiers.empty.hint")),
      columns: [
        { label: t("tiers.col.name"), primary: true, render: (r) => h("strong", {}, r.name) },
        { label: t("tiers.col.threshold"), render: (r) => formatPoints(ctx, r.min_points) },
        { label: t("tiers.col.discount"), render: (r) => (r.discount_percent ? `${r.discount_percent}%` : t("tiers.noDiscount")) },
        { label: "", class: "col-actions", render: (r) => (canEdit ? button(t("tiers.edit"), { small: true, "data-testid": "tier-edit", onClick: () => openForm(r) }) : "") },
      ],
    }));
  }
  function openForm(tier) {
    const name = input({ value: tier?.name ?? "", maxlength: "100", "data-testid": "tier-f-name", autocomplete: "off" });
    const pts = input({ value: tier ? String(tier.min_points) : "0", inputmode: "numeric", "data-testid": "tier-f-points" });
    const pct = input({ value: tier?.discount_percent ? String(tier.discount_percent) : "0", inputmode: "numeric", "data-testid": "tier-f-percent" });
    const wName = field(t("tiers.form.name"), name, { pointer: "/name" });
    const wPts = field(t("tiers.form.points"), pts, { pointer: "/min_points" });
    const wPct = field(t("tiers.form.percent"), pct, { pointer: "/discount_percent", hint: t("tiers.form.percentHint") });
    const content = h("div", { class: "form" }, wName, wPts, wPct);
    showDialog({
      title: tier ? t("tiers.form.editTitle") : t("tiers.form.newTitle"), content,
      actions: [{ label: t("common.cancel"), kind: "ghost" }, { label: tier ? t("tiers.form.save") : t("tiers.form.create"), kind: "primary", testid: "tier-f-save", onClick: async () => {
        for (const w of [wName, wPts, wPct]) setFieldError(w, "");
        const body = { name: name.value, minPoints: pts.value, discountPercent: pct.value };
        try {
          if (tier) await actions.updateMemberTier(tier.id, body); else await actions.createMemberTier(body);
          toast(tier ? t("tiers.toast.saved") : t("tiers.toast.created"));
          await load();
        } catch (e) {
          if (e.fields) { applyFieldErrors(content, e.fields); return false; }
          if (!(e.status === 422 && ctx.ui.showFormError(content, e))) toast(errorMessage(e, { 409: t("tiers.err.409"), 422: t("tiers.err.422") }), "error");
          return false;
        }
      } }],
    });
    name.focus();
  }
  await load();
}
