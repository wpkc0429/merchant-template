// Product images section. Images are a sub-resource with their own endpoints and take effect
// immediately; they are NOT part of the product save (the product PUT ignores images).
// The core enforces the permission, the per-product limit, the size limit and the HEIC -> JPEG
// conversion inside ctx.actions.uploadProductImage; this file only draws.
const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";

export function imagesSection(ctx, { product, canEdit }) {
  const { h, clear, button, busy, card, toast, input, icon } = ctx.ui;
  const { t, data, actions, errorMessage } = ctx;
  const media = data.media();
  const maxImages = media.maxImages;

  let images = [...(product.images || [])];
  const grid = h("div", { class: "img-grid", "data-testid": "image-grid" });
  const queue = h("div", { class: "upload-queue", "data-testid": "upload-queue" });
  const note = h("p", { class: "field__hint" });
  let working = false;

  const sectionHead = h("div", { class: "card__head" }, h("h2", {}, t("img.title")),
    h("span", { class: "muted", "data-testid": "image-count" }, ""));

  function draw() {
    sectionHead.querySelector(".muted").textContent = `${images.length} / ${maxImages}`;
    clear(grid);
    if (!images.length) grid.append(h("p", { class: "muted img-empty" }, t("img.empty")));
    images.forEach((img, i) => {
      const alt = input({ value: img.alt || "", maxlength: "300", placeholder: t("img.alt.placeholder"), "aria-label": t("img.alt.aria"), disabled: !canEdit, "data-testid": "image-alt" });
      let saved = img.alt || "";
      alt.addEventListener("change", async () => {
        try { await actions.setImageAlt(product.id, img.id, alt.value.trim()); saved = alt.value.trim(); img.alt = saved; toast(t("img.alt.saved")); }
        catch (e) { alt.value = saved; toast(errorMessage(e), "error"); }
      });
      const move = (d) => (ev) => run(ev.currentTarget, async () => { images = await actions.moveImage(product.id, img.id, d); draw(); });
      grid.append(h("figure", { class: `img-card${i === 0 ? " is-cover" : ""}`, "data-image-id": img.id, "data-testid": "image-card" },
        h("div", { class: "img-card__pic" }, h("img", { src: img.urls.thumb, alt: img.alt || "", width: img.width, height: img.height }),
          i === 0 ? h("span", { class: "chip chip--cover" }, t("img.cover")) : ""),
        alt,
        canEdit ? h("div", { class: "img-card__tools" },
          button(icon("left", 18), { small: true, "aria-label": t("img.moveLeft"), title: t("img.moveLeft"), disabled: i === 0, onClick: move(-1), "data-testid": "image-left" }),
          button(icon("right", 18), { small: true, "aria-label": t("img.moveRight"), title: t("img.moveRight"), disabled: i === images.length - 1, onClick: move(1), "data-testid": "image-right" }),
          h("span", { class: "grow" }),
          button(t("img.delete"), { small: true, kind: "danger-ghost", "data-testid": "image-delete", onClick: async (ev) => {
            await run(ev.target, async () => {
              const r = await actions.deleteImage(product.id, img.id);
              if (r.cancelled) return;
              images = r.images; draw(); toast(t("img.deleted"));
            });
          } })) : ""));
    });
    uploadBtn.disabled = !canEdit || images.length >= maxImages;
    note.textContent = images.length >= maxImages ? t("img.maxReached", { max: maxImages }) : "";
  }

  async function run(btn, fn) {
    if (working) return;
    working = true;
    try { await busy(btn, fn); } catch (e) { toast(errorMessage(e), "error"); try { images = await data.listImages(product.id); draw(); } catch { /* keep screen */ } }
    finally { working = false; }
  }

  const fileIn = h("input", { type: "file", accept: ACCEPT, multiple: true, hidden: true, "data-testid": "image-file", onchange: () => { const f = [...fileIn.files]; fileIn.value = ""; enqueue(f); } });
  const uploadBtn = button(t("img.pick"), { kind: "primary", onClick: () => fileIn.click(), "data-testid": "image-upload-btn" });

  async function enqueue(files) {
    if (!files.length) return;
    const room = maxImages - images.length;
    if (room <= 0) { toast(t("img.full", { have: images.length, max: maxImages }), "error"); return; }
    let take = files;
    if (files.length > room) {
      take = files.slice(0, room);
      toast(t("img.truncated", { max: maxImages, have: images.length, room, skipped: files.length - room }), "error");
    }
    uploadBtn.disabled = true;
    const items = take.map((file) => {
      const barFill = h("span", {});
      const bar = h("div", { class: "bar" }, barFill);
      const status = h("span", { class: "upl__status" }, t("img.queue.waiting"));
      const row = h("div", { class: "upl", "data-testid": "upload-item" }, h("div", { class: "upl__name" }, file.name), status, bar);
      queue.append(row);
      return { file, row, bar: barFill, status };
    });
    for (const it of items) {
      try {
        await actions.uploadProductImage(product.id, it.file, {
          onStage: (s) => { it.status.textContent = s === "converting" ? t("img.queue.converting") : s === "uploading" ? t("img.queue.uploading") : t("img.queue.saving"); },
          onProgress: (r) => { it.bar.style.width = `${Math.round(r * 100)}%`; },
        });
        it.bar.style.width = "100%";
        it.row.classList.add("is-done");
        it.status.textContent = t("img.queue.done");
        setTimeout(() => it.row.remove(), 1500);
      } catch (e) {
        it.row.classList.add("is-error");
        it.status.textContent = uploadMessage(e);
        it.row.append(button(t("nav.close"), { small: true, onClick: () => it.row.remove() }));
      }
    }
    try { images = await data.listImages(product.id); } catch { /* keep */ }
    draw();
  }

  function uploadMessage(e) {
    if (e.isActionError) return e.message;
    if (e && typeof e.status === "number") {
      if (e.status === 409) return t("img.err.409");
      if (e.status === 422) return t("img.err.422");
      return errorMessage(e);
    }
    return e.message;
  }

  const body = [sectionHead];
  if (!media.enabled) {
    body.push(h("p", { class: "notice", "data-testid": "media-off" }, t("img.mediaOff")));
  } else {
    body.push(h("p", { class: "field__hint" }, t("img.hint", { mib: (media.maxBytes / 1048576).toFixed(0), max: maxImages })));
    if (canEdit) body.push(h("div", { class: "upload-bar" }, uploadBtn, fileIn), note);
  }
  body.push(queue, grid);
  draw();
  const sec = card(...body);
  sec.dataset.testid = "images-section";
  return sec;
}
