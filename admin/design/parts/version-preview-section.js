// The "preview this version" section of the design history (platform change design-history, D25). One section per past published design
// (a request id). The history list / detail screens embed it; the screen design-version-preview.js shows it on its own.
//   * "預覽此版本" calls ctx.actions.requestVersionPreview(requestId) (design.view; the core checks it and maps 409 / 429 to ActionError
//     with `reason`: revert_below_core_floor, already_current, hourly_cap_reached, daily_cap_reached; `retryAfter` in seconds).
//   * the states waiting / ready / failed (with failureRuleIds) / expired come from ctx.data.getVersionPreview(id), polled while waiting.
//   * the limits text is FIXED and core-owned (t("vp.limits"): copy cannot change it); keep it next to the button.
//   * "改成這個版本" is shown only to people who hold design.revert and only leads INTO the existing revert flow via onRevert(requestId):
//     a preview is not an approval and shortens nothing.
const POLL_MS = 3000;
const POLL_MAX = 100; // about 5 minutes, then the person can press the button again

export function versionPreviewSection(ctx, { requestId, tag = "", onRevert }) {
  const { h, clear, button, busy, toast, badge, loading } = ctx.ui;
  const { t, data, actions, can, format, errorMessage } = ctx;
  const body = h("div", { "data-testid": "vp-body" });
  const box = h("section", { class: "vp", "data-testid": "vp-section", "data-request": requestId }, body);
  let preview = null;
  let polls = 0;

  const when = (iso) => format.dateTime(iso);

  function revertButton() {
    if (!can("design.revert") || typeof onRevert !== "function") return "";
    return h("div", { class: "vp__revert" },
      button(t("vp.revert"), { kind: "ghost", "data-testid": "vp-revert", onClick: () => onRevert(requestId) }),
      h("p", { class: "muted" }, t("vp.revert.note")));
  }

  function draw(error) {
    clear(body);
    const state = preview ? preview.state : "none";
    const label = tag || (preview && preview.tag) || "";
    const start = button(state === "none" ? t("vp.button") : t("vp.button.again"), {
      kind: state === "none" ? "primary" : "ghost", "data-testid": "vp-request", disabled: state === "waiting",
      onClick: (e) => busy(e.currentTarget, request),
    });
    const lines = [];
    if (label) lines.push(h("p", { class: "muted", "data-testid": "vp-tag" }, t("vp.tag", { tag: label })));
    if (state === "waiting") lines.push(h("div", { "data-testid": "vp-waiting" }, loading(t("vp.waiting"))));
    if (state === "ready") {
      lines.push(h("p", { "data-testid": "vp-ready" }, badge(t("vp.ready"), "ok"), " ", t("vp.expiresAt", { time: when(preview.expiresAt) })));
      if (preview.origin) lines.push(h("p", {}, h("a", { href: preview.origin, target: "_blank", rel: "noopener noreferrer", "data-testid": "vp-open" }, t("vp.open"))));
    }
    if (state === "failed") {
      lines.push(h("div", { class: "notice", role: "alert", "data-testid": "vp-failed" },
        h("p", {}, t("vp.failed")),
        preview.failureDetail ? h("p", { "data-testid": "vp-failed-detail" }, preview.failureDetail) : "",
        preview.failureRuleIds.length ? h("p", { "data-testid": "vp-failed-rules" }, t("vp.failed.rules", { rules: preview.failureRuleIds.join(", ") })) : "",
        preview.failureCode ? h("p", { class: "muted" }, t("vp.failed.code", { code: preview.failureCode })) : ""));
    }
    if (state === "expired") lines.push(h("p", { class: "notice", "data-testid": "vp-expired" }, preview.superseded ? t("vp.superseded") : t("vp.expired")));
    if (error) lines.push(h("p", { class: "notice", role: "alert", "data-testid": "vp-error", "data-reason": error.reason || "" }, errorMessage(error)));
    body.append(h("div", { class: "cf-flags" }, start), ...lines,
      h("p", { class: "muted", "data-testid": "vp-limits" }, t("vp.limits")), revertButton());
  }

  async function poll() {
    if (!preview || preview.state !== "waiting" || !ctx.alive() || polls >= POLL_MAX) return;
    polls++;
    setTimeout(async () => {
      if (!ctx.alive() || !preview || preview.state !== "waiting") return;
      try { preview = await data.getVersionPreview(preview.id); draw(); } catch (e) { toast(errorMessage(e), "error"); return; }
      poll();
    }, POLL_MS);
  }

  async function request() {
    polls = 0;
    try { preview = await actions.requestVersionPreview(requestId); draw(); poll(); } catch (e) { draw(e); }
  }

  draw();
  return box;
}
