// One design request (route id designRequest, /design/:id, needs design.view).
// Two regions that are kept apart on purpose: what the design SERVICE claims (prompt, gatekeeper report, change summary, preview link:
// the platform does not verify them) and the PLATFORM record (state, who proposed / approved, times, the approved version, the tag).
// The buttons follow can(): "review before / after" opens the core-owned review (ctx.actions.openDesignReview; approving and rejecting
// happen only there), "cancel" and, for a published design, "preview this version" with "change to this version" (design.revert).
// On a read-only preview host (ctx.route.state.readOnly) every action is left out. All dynamic text is data and goes in as text.
import { versionPreviewSection } from "../parts/version-preview-section.js";
import { CANCELLABLE, NO_SHOTS_YET, statusChip, siteLabel, kindLabel, personName, when, shortSha, currentMark, longText, factList } from "../parts/design-history-parts.js";

const FILES_SHOWN = 40;
const RELOAD_REASONS = ["head_moved", "precondition_failed", "precondition_required", "invalid_state"];

export default async function designRequest(root, ctx) {
  const { h, clear, button, busy, toast, pageHeader, loading, errorState, emptyState, badge, card } = ctx.ui;
  const { t, data, actions, can, errorMessage } = ctx;
  const id = ctx.route.params.id;
  const readOnly = ctx.route.state.readOnly === true;
  const area = h("div", { class: "dh-detail", "data-testid": "dh-detail" });
  const back = h("a", { class: "dh-back", href: "#/design", "data-testid": "dh-back" }, t("dh.back"));
  root.append(back, pageHeader(t("dh.detail.title"), { eyebrow: t("dh.eyebrow") }), area);

  let locked = false; // set when an action answers "read only": every action button is disabled from then on
  const actionButtons = [];
  const lock = () => { locked = true; for (const b of actionButtons) b.disabled = true; };
  async function run(btn, fn, after) {
    await busy(btn, async () => {
      try { await fn(); if (after) await after(); } catch (e) {
        if (!ctx.alive()) return;
        toast(errorMessage(e), "error");
        if (e && e.reason === "read_only") lock();
        else if (e && RELOAD_REASONS.includes(e.reason)) await load();
      }
    });
  }

  function claims(req) {
    const g = req.guard;
    const guard = !g ? h("p", { class: "muted", "data-testid": "dh-guard" }, t("dh.guard.none"))
      : h("div", { "data-testid": "dh-guard" },
        h("p", {}, badge(g.passed ? t("dh.guard.pass") : t("dh.guard.fail", { n: g.violationCount }), g.passed ? "ok" : "bad"), " ", t("dh.guard.sha", { sha: shortSha(g.checkedSha) || "—" })),
        g.ruleIds.length ? h("p", { class: "muted" }, t("dh.guard.rules", { rules: g.ruleIds.join(", ") })) : "",
        g.guardVersion ? h("p", { class: "muted" }, t("dh.guard.version", { v: g.guardVersion })) : "");
    const d = req.diff;
    const files = d.files.slice(0, FILES_SHOWN);
    const diff = !d.filesChanged && !files.length ? h("p", { class: "muted", "data-testid": "dh-diff" }, t("dh.diff.none"))
      : h("div", { "data-testid": "dh-diff" },
        h("p", {}, t("dh.diff.summary", { files: d.filesChanged, add: d.additions, del: d.deletions })),
        files.length ? h("ul", { class: "dh-files" }, files.map((f) => h("li", {}, h("span", { class: "dh-path" }, f.path), h("span", { class: "muted" }, ` +${f.additions} -${f.deletions}`)))) : "",
        d.files.length > files.length ? h("p", { class: "muted" }, t("dh.diff.more", { n: d.files.length - files.length })) : "");
    let link = "";
    if (req.previewOrigin) {
      const a = h("a", { href: req.previewOrigin, target: "_blank", rel: "noopener noreferrer", "data-testid": "dh-preview-link" }, t("dh.preview.open"));
      link = a.hasAttribute("href") ? h("p", {}, a, h("span", { class: "muted dh-origin" }, " " + req.previewOrigin)) : h("p", { class: "muted", "data-testid": "dh-preview-link" }, t("dh.preview.unavailable"));
    } else link = h("p", { class: "muted", "data-testid": "dh-preview-link" }, t("dh.preview.none"));
    return h("section", { class: "dh-region dh-region--claims", "aria-labelledby": "dh-claims-h", "data-testid": "dh-claims" },
      h("h2", { id: "dh-claims-h" }, t("dh.claims.title")),
      h("p", { class: "muted" }, t("dh.claims.note")),
      h("h3", {}, t("dh.prompt")),
      req.promptText ? longText(ctx, req.promptText, { max: 280, testid: "dh-prompt-text" }) : h("p", { class: "muted", "data-testid": "dh-prompt-text" }, t("dh.prompt.gone")),
      h("h3", {}, t("dh.guard")), guard,
      h("h3", {}, t("dh.diff")), diff,
      h("h3", {}, t("dh.preview")), link);
  }

  function record(req) {
    const status = h("span", {}, statusChip(ctx, req.status), req.isCurrent ? " " : "", req.isCurrent ? currentMark(ctx) : "");
    return h("section", { class: "dh-region dh-region--record", "aria-labelledby": "dh-record-h", "data-testid": "dh-record" },
      h("h2", { id: "dh-record-h" }, t("dh.record.title")),
      h("p", { class: "muted" }, t("dh.record.note")),
      factList(ctx, [
        [t("dh.rec.state"), status, "dh-rec-state"],
        [t("dh.rec.kind"), `${kindLabel(ctx, req.kind)} · ${siteLabel(ctx, req.site)}`],
        [t("dh.rec.proposer"), personName(ctx, req.proposedByName), "dh-rec-proposer"],
        [t("dh.rec.created"), when(ctx, req.createdAt)],
        [t("dh.rec.approver"), req.approvedByName ? personName(ctx, req.approvedByName) : "", "dh-rec-approver"],
        [t("dh.rec.approvedAt"), req.approvedAt ? when(ctx, req.approvedAt) : ""],
        [t("dh.rec.approvalExpires"), req.approvalExpiresAt && req.status === "approved" ? when(ctx, req.approvalExpiresAt) : ""],
        [t("dh.rec.approvedSha"), shortSha(req.approvedHeadSha), "dh-rec-sha"],
        [t("dh.rec.tag"), req.publishedTag || req.publishTag || "", "dh-rec-tag"],
        [t("dh.rec.publishedAt"), req.publishedAt ? when(ctx, req.publishedAt) : ""],
        [t("dh.rec.core"), req.coreVersion],
        [t("dh.rec.revertTarget"), req.kind === "revert" ? req.revertTargetTag || "" : ""],
        [t("dh.rec.rejectedBy"), req.rejectedByName ? personName(ctx, req.rejectedByName) : ""],
        [t("dh.rec.rejectedAt"), req.rejectedAt ? when(ctx, req.rejectedAt) : ""],
        [t("dh.rec.rejectReason"), req.rejectReason ? longText(ctx, req.rejectReason, { max: 200, testid: "dh-reject-reason" }) : ""],
        [t("dh.rec.changeNote"), req.changeNote ? longText(ctx, req.changeNote, { max: 200, testid: "dh-change-note" }) : ""],
        [t("dh.rec.failure"), [req.failureCode, req.failureDetail].filter(Boolean).join(" · ")],
      ], "dh-facts"));
  }

  function timeline(req) {
    const label = (s) => (s ? (t(`dh.status.${s}`) === `dh.status.${s}` ? s : t(`dh.status.${s}`)) : "");
    return h("section", { class: "dh-region", "aria-labelledby": "dh-timeline-h", "data-testid": "dh-timeline" },
      h("h2", { id: "dh-timeline-h" }, t("dh.timeline")),
      req.events.length
        ? h("ol", { class: "dh-events" }, req.events.map((e) => h("li", { class: "dh-event", "data-testid": "dh-event" },
          h("span", { class: "dh-event__what" }, e.toStatus ? `${label(e.fromStatus)} → ${label(e.toStatus)}` : e.kind),
          h("span", { class: "muted" }, ` · ${t(`dh.actor.${e.actorType}`)}${e.actorName ? " " + e.actorName : ""} · ${when(ctx, e.createdAt)}`))))
        : h("p", { class: "muted" }, t("dh.timeline.none")));
  }

  function actionBar(req) {
    if (readOnly) return h("p", { class: "notice", "data-testid": "dh-readonly" }, t("dh.act.readOnly"));
    const bar = h("div", { class: "dh-actions", "data-testid": "dh-actions" });
    const add = (b) => { actionButtons.push(b); if (locked) b.disabled = true; bar.append(b); return b; };
    if (req.status === "awaiting_approval" && can("design.view")) {
      add(button(t("dh.act.review"), { kind: "primary", "data-testid": "dh-review", onClick: (e) => run(e.currentTarget, () => actions.openDesignReview(id), load) }));
    }
    if (CANCELLABLE.includes(req.status) && can("design.request")) {
      add(button(t("dh.act.cancel"), { kind: "ghost", "data-testid": "dh-cancel", onClick: (e) => run(e.currentTarget, () => actions.cancelDesignRequest(id), load) }));
    }
    const hint = req.status === "awaiting_approval" ? (can("design.approve") ? t("dh.act.review.hint") : t("dh.act.viewOnly")) : "";
    return h("div", {}, actionButtons.length ? bar : "", hint ? h("p", { class: "muted", "data-testid": "dh-act-hint" }, hint) : "",
      NO_SHOTS_YET.includes(req.status) ? h("p", { class: "muted", "data-testid": "dh-no-shots" }, t("dh.empty.noShots.hint")) : "");
  }

  async function revert() {
    if (locked) return;
    try {
      const r = await actions.requestDesignRevert(id);
      if (r && r.request && r.request.id) { toast(t("dh.revert.created")); ctx.navigate(`/design/${r.request.id}`); }
    } catch (e) {
      if (!ctx.alive()) return;
      toast(errorMessage(e), "error");
      if (e && e.reason === "read_only") lock();
    }
  }

  function published(req) {
    if (req.status !== "published" && req.status !== "reverted") return "";
    if (readOnly) return h("p", { class: "muted", "data-testid": "dh-vp-off" }, t("dh.act.readOnly"));
    // the section shows "change to this version" only to people who hold design.revert, and only when onRevert is given
    const section = versionPreviewSection(ctx, { requestId: id, tag: req.publishedTag || req.publishTag || "", onRevert: req.isCurrent ? undefined : revert });
    return h("section", { class: "dh-region", "aria-labelledby": "dh-vp-h", "data-testid": "dh-published" },
      h("h2", { id: "dh-vp-h" }, t("dh.published.title")), req.isCurrent ? h("p", { class: "muted" }, t("dh.published.current")) : "", section);
  }

  async function load() {
    actionButtons.length = 0;
    clear(area).append(loading());
    let req;
    try { req = await data.getDesignRequest(id); } catch (e) {
      if (!ctx.alive()) return;
      clear(area).append(e && e.reason === "design_storage_not_configured" ? emptyState(t("dh.empty.storage.title"), t("dh.empty.storage.hint")) : errorState(e, load));
      return;
    }
    if (!ctx.alive()) return;
    back.href = `#/design?site=${req.site}`;
    clear(area).append(
      h("div", { class: "dh-head", "data-testid": "dh-head" }, statusChip(ctx, req.status), req.isCurrent ? currentMark(ctx) : "",
        h("span", { class: "muted" }, `${siteLabel(ctx, req.site)} · ${kindLabel(ctx, req.kind)}`),
        req.status === "previewing" || req.status === "awaiting_approval" ? h("span", { class: "muted" }, req.previewExpiresAt ? t("dh.previewUntil", { time: when(ctx, req.previewExpiresAt) }) : "") : ""),
      actionBar(req),
      h("div", { class: "dh-regions" }, claims(req), record(req)),
      published(req),
      card(timeline(req)));
  }
  await load();
}
