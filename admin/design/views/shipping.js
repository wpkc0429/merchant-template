// Shipping methods: list, create, edit, activate/deactivate (name, carrier, flat rate in NT$).
// flat_rate is copied into an order's shipping_fee at checkout, so the number here is what
// customers pay; it is an integer and never scaled. Validation runs in the core (ctx.actions).
export default async function shipping(root, ctx) {
  const { h, clear, button, field, input, toggle, pageHeader, toast, showDialog, dataTable, loading, errorState, emptyState, applyFieldErrors, showFormError, setFieldError, badge } = ctx.ui;
  const { t, can, data, format, actions, errorMessage } = ctx;

  const canCreate = can("shipping_method.create");
  const canEdit = can("shipping_method.edit");
  const area = h("div", { class: "list-area" });
  root.append(
    pageHeader(t("shipping.title"), { eyebrow: "SHIPPING", actions: canCreate ? button(t("shipping.new"), { kind: "primary", "data-testid": "ship-new", onClick: () => openForm(null) }) : null }),
    h("p", { class: "field__hint" }, t("shipping.hint")),
    area);

  let list = [];
  async function load() {
    clear(area).append(loading());
    try { list = await data.listShippingMethods(); } catch (e) { if (ctx.alive()) clear(area).append(errorState(e, load)); return; }
    if (ctx.alive()) draw();
  }

  function draw() {
    clear(area).append(dataTable({
      rows: list,
      rowAttrs: (m) => ({ "data-name": m.name, "data-testid": "ship-row" }),
      empty: emptyState(t("shipping.empty.title"), t("shipping.empty.hint")),
      columns: [
        { label: t("shipping.col.name"), primary: true, render: (m) => h("strong", {}, m.name) },
        { label: t("shipping.col.carrier"), render: (m) => m.carrier || "—" },
        { label: t("shipping.col.rate"), render: (m) => m.flat_rate === 0 ? t("shipping.free") : format.money(m.flat_rate) },
        { label: t("shipping.col.status"), render: (m) => canEdit
          ? (() => { const tg = toggle(m.is_active ? t("status.enabled") : t("status.disabled"), m.is_active, { onChange: (v) => setActive(m, v, tg), ariaLabel: t("shipping.activeAria", { name: m.name }) }); tg.input.dataset.testid = "ship-active"; return tg.el; })()
          : (m.is_active ? badge(t("status.enabled"), "ok") : badge(t("status.disabled"))) },
        { label: "", class: "col-actions", render: (m) => canEdit ? button(t("shipping.edit"), { small: true, "data-testid": "ship-edit", onClick: () => openForm(m) }) : "" },
      ],
    }));
  }

  async function setActive(m, value, tg) {
    tg.input.disabled = true;
    try {
      const saved = await actions.setShippingActive(m.id, value);
      Object.assign(m, saved);
      toast(value ? t("shipping.toast.on", { name: m.name }) : t("shipping.toast.off", { name: m.name }));
      draw();
    } catch (e) { tg.input.checked = !value; tg.input.disabled = false; toast(errorMessage(e), "error"); }
  }

  function openForm(m) {
    const name = input({ value: m?.name ?? "", maxlength: "100", "data-testid": "ship-f-name", autocomplete: "off" });
    const carrier = input({ value: m?.carrier ?? "", maxlength: "100", placeholder: t("shipping.form.carrierPlaceholder"), "data-testid": "ship-f-carrier", autocomplete: "off" });
    const rate = input({ value: m ? String(m.flat_rate) : "0", inputmode: "numeric", pattern: "[0-9]*", "data-testid": "ship-f-rate" });
    const active = toggle(t("shipping.form.active"), m ? m.is_active : true);
    active.input.dataset.testid = "ship-f-active";
    const wName = field(t("shipping.form.name"), name, { pointer: "/name" });
    const wCarrier = field(t("shipping.form.carrier"), carrier, { pointer: "/carrier" });
    const wRate = field(t("shipping.form.rate"), rate, { pointer: "/flat_rate", hint: t("shipping.form.rateHint") });
    const content = h("div", { class: "form" }, wName, wCarrier, wRate, active.el);
    showDialog({
      title: m ? t("shipping.form.editTitle") : t("shipping.form.newTitle"),
      content,
      actions: [
        { label: t("common.cancel"), kind: "ghost" },
        { label: m ? t("shipping.form.save") : t("shipping.form.create"), kind: "primary", testid: "ship-f-save", onClick: async () => {
          for (const w of [wName, wCarrier, wRate]) setFieldError(w, "");
          const body = { name: name.value, carrier: carrier.value, flatRate: rate.value, isActive: active.input.checked };
          try {
            if (m) await actions.updateShippingMethod(m.id, body); else await actions.createShippingMethod(body);
            toast(m ? t("shipping.toast.saved") : t("shipping.toast.created"));
            await load();
          } catch (e) {
            if (e.fields) { applyFieldErrors(content, e.fields); return false; }
            if (!(e.status === 422 && showFormError(content, e))) toast(errorMessage(e), "error");
            return false;
          }
        } },
      ],
    });
    name.focus();
  }

  await load();
}
