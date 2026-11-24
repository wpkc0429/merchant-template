// Product create / edit (route ids productNew and productEdit). One save button sends the whole product.
// The CORE owns what must not be bypassed: ctx.actions.saveProduct validates every field, never drops a
// SKU, re-reads the product right before the PUT and refuses a stale form; ctx.actions.deleteProduct asks
// the confirmation itself. This file only decides how the form looks and in what order the sections are.
// Images are a separate sub-resource section (parts/images-section.js).
import { imagesSection } from "../parts/images-section.js";

export default async function productEdit(root, ctx) {
  const { h, clear, button, busy, field, input, textarea, toggle, card, pageHeader, toast, showDialog, applyFieldErrors, clearFieldErrors, showFormError, setFieldError, badge } = ctx.ui;
  const { t, can, data, logic, format, actions, errorMessage } = ctx;
  const SIZES = ctx.enums.SIZES;
  const NEW_ARRIVALS_SLUG = ctx.enums.NEW_ARRIVALS_SLUG;

  const isNew = ctx.route.id === "productNew";
  const canSee = can("category.view");
  const [product, tree] = await Promise.all([
    isNew ? null : data.getProduct(ctx.route.params.id),
    canSee ? data.categoryTree().catch(() => null) : null,
  ]);
  if (!ctx.alive()) return;
  const cats = tree ? logic.flattenTree(tree) : null;
  render(product, cats);

  function render(product, cats) {
    clear(root);
    const isNew = !product;
    const editable = isNew ? can("product.create") : can("product.edit");
    const dis = !editable;

    // ── Basics ─────────────────────────────────────────────────────────
    const title = input({ value: product?.title ?? "", maxlength: "200", disabled: dis, "data-testid": "f-title", autocomplete: "off" });
    const subtitle = input({ value: product?.subtitle ?? "", maxlength: "200", disabled: dis, placeholder: t("product.subtitlePlaceholder"), "data-testid": "f-subtitle", autocomplete: "off" });
    const slug = input({ value: product?.slug ?? "", disabled: dis, placeholder: "canvas-tote-bag", "data-testid": "f-slug", autocomplete: "off", autocapitalize: "none", spellcheck: "false" });
    const desc = textarea({ value: product?.description ?? "", disabled: dis, "data-testid": "f-description", rows: 5 });
    const active = toggle(t("product.active"), (product?.status ?? 0) === 1, { hint: t("product.activeHint") });
    active.input.disabled = dis;
    active.input.dataset.testid = "f-active";

    let slugTouched = Boolean(product);
    slug.addEventListener("input", () => { slugTouched = true; });
    subtitle.addEventListener("input", () => {
      if (!slugTouched && isNew) { slug.value = format.slugify(subtitle.value); syncCodes(); }
    });

    const basics = card(h("div", { class: "card__head" }, h("h2", {}, t("product.basics"))),
      field(t("product.title"), title, { pointer: "/title" }),
      field(t("product.subtitle"), subtitle, { pointer: "/subtitle", hint: t("product.subtitleHint") }),
      field(t("product.slug"), slug, { pointer: "/slug", hint: t("product.slugHint") }),
      field(t("product.description"), desc, { pointer: "/description" }),
      active.el);

    // ── Sizes ──────────────────────────────────────────────────────────
    const rows = {};
    const sizeCard = card(h("div", { class: "card__head" }, h("h2", {}, t("product.sizes.title"))),
      h("p", { class: "field__hint" }, t("product.sizes.hint")));
    for (const size of SIZES) {
      const sku = product ? logic.skuForSize(product, size) : null;
      const exists = Boolean(sku);
      const on = toggle(t("product.sizes.offer"), exists || (isNew && size === "M"), { onChange: (v) => { body.hidden = !v; if (v && !rows[size].code.value) rows[size].autoCode(); } });
      on.input.disabled = dis || exists;
      on.input.dataset.testid = `size-${size}-enabled`;
      const code = input({ value: sku?.sku_code ?? "", disabled: dis, "data-testid": `size-${size}-code`, autocomplete: "off", autocapitalize: "characters" });
      const price = input({ value: sku ? String(sku.price_amount) : "", inputmode: "numeric", pattern: "[0-9]*", disabled: dis, "data-testid": `size-${size}-price` });
      const stock = input({ value: sku ? String(sku.stock_qty) : "0", inputmode: "numeric", pattern: "[0-9]*", disabled: dis, "data-testid": `size-${size}-stock` });
      const sell = toggle(t("product.sizes.sell"), sku ? sku.is_active : true);
      sell.input.disabled = dis;
      sell.input.dataset.testid = `size-${size}-active`;
      const preview = h("span", { class: "field__hint" });
      const upd = () => { const n = format.parseInteger(price.value); preview.textContent = Number.isNaN(n) ? "" : format.money(n); };
      price.addEventListener("input", upd); upd();
      let codeTouched = exists;
      code.addEventListener("input", () => { codeTouched = true; });
      const body = h("div", { class: "size__body", hidden: !(exists || (isNew && size === "M")) },
        h("div", { class: "grid-2" },
          field(t("product.sizes.code"), code, { pointer: `/skus/${size}` }),
          field(t("product.sizes.price"), price, { hint: "", pointer: `/skus/${size}/price` })),
        preview,
        h("div", { class: "grid-2" }, field(t("product.sizes.stock"), stock, { pointer: `/skus/${size}/stock` }), h("div", { class: "field" }, sell.el)));
      rows[size] = { on, code, price, stock, sell, body, preview, sku, autoCode: () => { if (!codeTouched) code.value = slug.value ? `${slug.value}-${size}` : ""; } };
      sizeCard.append(h("div", { class: "size", "data-size": size },
        h("div", { class: "size__head" }, h("span", { class: "size__tag" }, t(`product.sizes.tag.${size}`)), on.el), body));
    }
    const syncCodes = () => SIZES.forEach((s) => rows[s].autoCode());
    slug.addEventListener("input", syncCodes);
    if (isNew) syncCodes();
    const extras = (product?.skus || []).filter((s) => !SIZES.includes(s.options?.size));
    if (extras.length) {
      sizeCard.append(h("p", { class: "notice" }, t("product.sizes.extras", { n: extras.length, codes: extras.map((s) => s.sku_code).join("、") })));
    }

    // ── Categories ─────────────────────────────────────────────────────
    let newArrivals = cats ? cats.find((c) => c.slug === NEW_ARRIVALS_SLUG) || null : null;
    const picked = new Set(product?.category_ids ?? []);
    const naToggle = toggle(t("product.newArrival"), newArrivals ? picked.has(newArrivals.id) : false, {
      hint: t("product.newArrivalHint"),
      onChange: async (on) => {
        if (!on) return;
        if (!newArrivals) {
          if (!can("category.create")) { toast(t("product.newArrival.noPerm"), "error"); naToggle.input.checked = false; return; }
          try {
            const c = await actions.createNewArrivalsCategory();
            if (c.cancelled) { naToggle.input.checked = false; return; }
            newArrivals = { ...c, depth: 0, children: [] };
            toast(t("product.newArrival.created"));
          } catch (e) {
            toast(e.status === 422 ? t("product.newArrival.exists", { slug: NEW_ARRIVALS_SLUG }) : errorMessage(e), "error");
            naToggle.input.checked = false;
          }
        }
      },
    });
    naToggle.input.disabled = dis || !cats;
    naToggle.input.dataset.testid = "f-new-arrival";
    const catBoxes = [];
    const catCard = card(h("div", { class: "card__head" }, h("h2", {}, t("product.categories.title"))));
    if (!cats) {
      catCard.append(h("p", { class: "muted" }, t("product.categories.noView")));
    } else {
      catCard.append(naToggle.el);
      const list = h("div", { class: "cat-pick", "data-testid": "cat-pick" });
      for (const c of cats.filter((x) => x.slug !== NEW_ARRIVALS_SLUG)) {
        const box = h("input", { type: "checkbox", checked: picked.has(c.id), disabled: dis, "data-cat-id": c.id });
        catBoxes.push({ id: c.id, box });
        list.append(h("label", { class: "check", style: { paddingLeft: `${c.depth * 18}px` } }, box, h("span", {}, c.name)));
      }
      catCard.append(list.childNodes.length ? list : h("p", { class: "muted" }, t("product.categories.none")));
    }

    // ── Collect / save ─────────────────────────────────────────────────
    const formEl = h("div", { class: "form-body" }, basics, sizeCard, catCard);

    function collect() {
      const form = {
        title: title.value, subtitle: subtitle.value, slug: slug.value, description: desc.value, status: active.input.checked ? 1 : 0,
        sizes: {}, category_ids: null,
      };
      for (const size of SIZES) {
        const r = rows[size];
        form.sizes[size] = { enabled: r.on.input.checked, sku_code: r.code.value, price: r.price.value, stock: r.stock.value, is_active: r.sell.input.checked };
      }
      if (cats) {
        const ids = catBoxes.filter((c) => c.box.checked).map((c) => c.id);
        if (naToggle.input.checked && newArrivals) ids.push(newArrivals.id);
        form.category_ids = ids;
      }
      return form;
    }

    async function onSave(ev) {
      clearFieldErrors(formEl);
      await busy(ev.currentTarget, async () => {
        try {
          const saved = await actions.saveProduct(product, collect());
          if (isNew) { toast(t("product.toast.created")); ctx.navigate(`/products/${saved.id}`, { replace: true }); }
          else { toast(t("product.toast.saved")); if (ctx.alive()) render(saved, cats); }
        } catch (e) {
          if (e.fields) {
            for (const m of applyFieldErrors(formEl, e.fields)) toast(m, "error");
            formEl.querySelector(".has-error input, .has-error textarea")?.focus();
          } else if (e.name === "StaleProductError") {
            showDialog({
              title: t("product.stale.title"),
              content: h("p", { class: "dlg__msg" }, t("product.stale.text")),
              actions: [{ label: t("product.stale.later"), kind: "ghost" }, { label: t("product.stale.reload"), kind: "primary", onClick: () => { ctx.navigate(`/products/${product.id}`, { replace: true }); } }],
            });
          } else if (e.status === 422 || e.status === 409) {
            if (e.status === 409) { setFieldError(slug.closest(".field"), t("product.err.dup")); toast(t("product.err.dupToast"), "error"); }
            else showFormError(formEl, e);
          } else toast(errorMessage(e), "error");
        }
      });
    }

    // ── Page ───────────────────────────────────────────────────────────
    root.append(
      h("a", { class: "backlink", href: "#/products" }, t("product.back")),
      pageHeader(isNew ? t("product.titleNew") : (product.title || t("product.titleEdit")), {
        eyebrow: isNew ? "NEW PRODUCT" : "EDIT PRODUCT",
        actions: !isNew ? (product.status === 1 ? badge(t("status.active"), "ok") : badge(t("status.inactive"))) : null,
      }),
      formEl);

    if (isNew) {
      root.append(card(h("p", { class: "muted" }, t("product.newHint"))));
    } else {
      root.append(imagesSection(ctx, { product, canEdit: can("product.edit") }));
      if (can("product.delete")) {
        root.append(card(h("div", { class: "card__head" }, h("h2", {}, t("product.danger.title"))),
          h("p", { class: "field__hint" }, t("product.danger.hint")),
          button(t("product.danger.delete"), { kind: "danger-ghost", "data-testid": "product-delete", onClick: async (ev) => {
            await busy(ev.target, async () => {
              try {
                const r = await actions.deleteProduct(product.id);
                if (r.cancelled) return;
                toast(t("product.toast.deleted")); ctx.navigate("/products");
              } catch (e) { toast(errorMessage(e), "error"); }
            });
          } })));
      }
    }

    if (editable) {
      root.append(h("div", { class: "savebar" },
        button(t("common.cancel"), { kind: "ghost", onClick: () => ctx.navigate("/products"), "data-testid": "product-cancel" }),
        button(isNew ? t("product.save.create") : t("product.save.update"), { kind: "primary", onClick: onSave, "data-testid": "product-save" })));
    }
  }
}
