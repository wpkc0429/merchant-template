// The design REVIEW dialog (T1-T4 PR2, docs/DECISIONS.md D14). CORE-DRAWN: core/design-actions.js opens it with a model built from data
// the core read itself; the design layer passes nothing in and gets no element back. Everything displayed is drawn with text nodes
// (h() children, textContent): prompt, paths, names, reasons are DATA. Wording comes from lib/fixed-text.js CORE_TEXT (no copy key, so a
// design cannot swap "before" and "after" or reword the screenshot note) plus the fixed warning from core/warnings.js.
//
// Screenshots: handlers.image(id) returns a PNG blob (the core fetched the signed URL and retried once on expiry). The object URL is
// created HERE and revoked when the image leaves the screen or the dialog closes; no URL is ever shown, logged or stored.
// Only a real person approves: the approve / reject / request-changes buttons ignore events with isTrusted !== true, and the
// acknowledgement checkbox must be ticked by a real click before the approve button is enabled. The button disables the instant it is pressed.
// D18: the approve button (and the reject confirmation) also stays disabled for DELAY_MS after the dialog is shown, with a visible countdown; and the
// service-claims region carries the SCAN REPORT (guard verdict, rule ids, checked sha, the full list of changed paths), labelled as not verified by the platform.
import { h, showCoreDialog, button, textarea, toast } from "./kit.js";
import { coreText as ct } from "../lib/fixed-text.js";
import { safeOrigin } from "../lib/versionpreview.js";
import { formatDateTime } from "./format.js";
import { now, matchMedia as mq } from "../lib/natives.js";

/** Irreversible confirmations of the review dialog become usable this long after the dialog (or the panel) appeared. */
export const DELAY_MS = 1000;
const pctOf = (ppm) => (ppm / 10000).toFixed(2).replace(/\.?0+$/, "") || "0";
const narrow = () => { try { return mq("(max-width: 640px)").matches; } catch { return false; } };

/** Latest attempt per (role, view, viewport, phase) -> [{key, role, viewKey, vps: {390: {before, after}, 1280: {...}}}]. */
function groupShots(items) {
  const slots = new Map();
  for (const s of items) {
    const key = `${s.role}|${s.viewKey}`;
    if (!slots.has(key)) slots.set(key, { key, role: s.role, viewKey: s.viewKey, vps: {} });
    const vp = (slots.get(key).vps[s.viewport] ||= {});
    if (!vp[s.phase] || s.attempt >= vp[s.phase].attempt) vp[s.phase] = s;
  }
  return [...slots.values()];
}

/** Opens the dialog; resolves when it is closed. `handlers` come from core/design-actions.js and never leave the core. */
export function showReview(initial, handlers) {
  return new Promise((resolve) => {
    let model = initial;
    let busy = false;
    let mode = "review"; // review | reject | changes | reload
    let gen = 0;         // bumped on every full render: late answers of an older render are ignored
    const urls = new Map(); // screenshot id -> object URL (created and revoked in this file)
    const revoke = (id) => { const u = urls.get(id); if (u) { URL.revokeObjectURL(u); urls.delete(id); } };

    const alertBox = h("div", { class: "dlg-rv__alert", role: "alert", tabindex: "-1", hidden: true, "data-testid": "confirm-rv-alert" });
    const main = h("div", { class: "dlg-rv__main" });
    const panel = h("div", { class: "dlg-rv__panel", "data-testid": "confirm-rv-panel" });
    const root = h("div", { class: "dlg-rv" }, main, panel);
    const titleOf = () => (model.canApprove ? model.approve.title : ct("rv.reviewing"));
    // A CLOSED shadow root with its own stylesheet (ui/kit.js showCoreDialog): the design layer's CSS cannot restyle, hide or rewrite anything in here.
    const { dialog, close, sane } = showCoreDialog({
      title: titleOf(), content: root, actions: [], wide: true,
      onClose: () => { gen++; stopTimer(); for (const id of [...urls.keys()]) revoke(id); handlers.dispose(); resolve(); },
    });
    dialog.classList.add("dlg--review");
    dialog.setAttribute("aria-label", titleOf());
    dialog.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); }); // Esc does not close the dialog mid-request

    const say = (msg) => { alertBox.textContent = msg || ""; alertBox.hidden = !msg; if (msg) alertBox.focus(); };
    const lock = (on) => { for (const el of panel.querySelectorAll("button, input, textarea")) el.disabled = on; };

    // ── facts ──
    function scanReport() {
      const r = model.request;
      const g = r.guard;
      const kids = [h("h4", {}, ct("rv.scan.heading")), h("p", { "data-testid": "confirm-rv-guard" }, g ? (g.passed ? ct("rv.guard.pass") : ct("rv.guard.fail")) : ct("rv.guard.none"))];
      if (g) {
        kids.push(h("p", { "data-testid": "confirm-rv-scan-rules" }, g.ruleIds.length ? ct("rv.scan.rules", { ids: g.ruleIds.join(", ") }) : ct("rv.scan.noRules")));
        if (g.violationCount) kids.push(h("p", {}, ct("rv.scan.violations", { n: g.violationCount })));
        kids.push(h("p", { class: "mono", "data-testid": "confirm-rv-scan-sha" }, g.checkedSha ? ct("rv.scan.sha", { sha: g.checkedSha }) : ct("rv.scan.noSha")));
        if (r.candidateSha) kids.push(h("p", { class: "mono", "data-testid": "confirm-rv-scan-candidate" }, ct("rv.scan.candidate", { sha: r.candidateSha })));
        if (r.candidateSha && g.checkedSha !== r.candidateSha) kids.push(h("p", { class: "dlg__warning", "data-testid": "confirm-rv-scan-mismatch" }, ct("rv.scan.shaMismatch")));
        if (g.guardVersion) kids.push(h("p", { class: "muted" }, ct("rv.scan.version", { v: g.guardVersion })));
        if (g.checkedAt) kids.push(h("p", { class: "muted" }, ct("rv.scan.at", { time: formatDateTime(g.checkedAt) })));
      }
      kids.push(h("p", { class: "muted", "data-testid": "confirm-rv-scan-note" }, ct("rv.scan.unverified")));
      const listed = r.diff.files.length;
      const sum = ct("rv.files", { n: r.diff.filesChanged, add: r.diff.additions, del: r.diff.deletions });
      kids.push(h("p", { "data-testid": "confirm-rv-scan-count" }, ct("rv.scan.count", { n: r.diff.filesChanged }) + (listed < r.diff.filesChanged ? " " + ct("rv.scan.listed", { m: listed }) : "")));
      kids.push(listed
        ? h("details", { class: "dlg-rv__files", "data-testid": "confirm-rv-files" }, h("summary", {}, ct("rv.scan.fileList", { m: listed })),
          h("ul", {}, r.diff.files.map((f) => h("li", {}, h("span", { class: "mono" }, f.path), ` ${f.status} +${f.additions} -${f.deletions}`))))
        : h("p", {}, sum));
      return h("section", { class: "dlg-rv__scan", "data-testid": "confirm-rv-scan" }, kids);
    }

    function facts() {
      const r = model.request;
      const rec = [[ct("rv.status"), ct(`rv.status.${r.status}`)], [ct("rv.proposedBy"), r.proposedByName || "—"], [ct("rv.approvedBy"), r.approvedByName || "—"],
        [ct("rv.approvedAt"), r.approvedAt ? formatDateTime(r.approvedAt) : "—"]];
      return h("div", { class: "dlg-rv__facts" },
        h("p", { class: "dlg-rv__ver", "data-testid": "confirm-rv-version" },
          h("span", { class: "badge" }, `${ct(`rv.site.${r.site}`)} · ${ct(`rv.kind.${r.kind}`)}`), " ",
          r.candidateSha ? ct("rv.version", { sha: r.candidateSha.slice(0, 7), n: r.diff.filesChanged }) : ct("rv.noSha")),
        h("h3", {}, ct("rv.claims")),
        h("p", { class: "dlg-rv__prompt", "data-testid": "confirm-rv-prompt" }, r.promptText || r.promptExcerpt || ct("rv.noPrompt")),
        scanReport(),
        h("h3", {}, ct("rv.record")),
        h("dl", { class: "dlg-rv__rec" }, rec.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])));
    }

    // ── preview link ──
    function previewBlock() {
      const r = model.request;
      const origin = safeOrigin(r.previewOrigin);
      const kids = [h("h3", {}, ct("rv.preview.heading"))];
      if (!origin) kids.push(h("p", {}, ct("rv.preview.none")));
      else {
        const a = document.createElement("a"); // core-built: the href is a checked https origin, opened without opener or referrer
        a.href = origin; a.target = "_blank"; a.rel = "noopener noreferrer"; a.className = "btn btn--ghost btn--sm"; a.dataset.testid = "confirm-rv-preview";
        a.textContent = ct("rv.preview.link");
        kids.push(a, h("p", { class: "muted" }, origin));
        if (r.previewExpiresAt) kids.push(h("p", { class: "muted" }, ct("rv.preview.expires", { time: formatDateTime(r.previewExpiresAt) })));
      }
      return h("div", { class: "dlg-rv__preview" }, kids);
    }

    // ── screenshots ──
    function shotsBlock(myGen) {
      const body = h("div", { class: "dlg-rv__shotsbody", "data-testid": "confirm-rv-shots" }, h("p", { class: "muted" }, ct("rv.shots.loading")));
      const box = h("section", { class: "dlg-rv__shots" }, h("h3", {}, ct("rv.shots.heading")),
        h("p", { class: "dlg-rv__note", "data-testid": "confirm-rv-shots-note" }, ct("rv.shots.note")), body);
      const start = () => {
        body.replaceChildren(h("p", { class: "muted" }, ct("rv.shots.loading")));
        handlers.loadShots().then(({ state, items }) => {
          if (myGen !== gen) return;
          if (state !== "ok") {
            body.replaceChildren(h("p", { class: "dlg-rv__msg" }, ct(state === "notConfigured" ? "rv.shots.notConfigured" : "rv.shots.error")),
              state === "error" ? button(ct("rv.shots.retry"), { small: true, onClick: start }) : "");
          } else if (!items.length) body.replaceChildren(h("p", { class: "dlg-rv__msg" }, ct("rv.shots.none")));
          else body.replaceChildren(picker(items, myGen));
        });
      };
      start();
      return box;
    }

    function picker(items, myGen) {
      const slots = groupShots(items);
      const st = { slot: slots[0], vp: 0, mode: narrow() ? "single" : "side", phase: "after", slide: 50 };
      const vpsOf = (slot) => [390, 1280].filter((v) => slot.vps[v]);
      const pickVp = () => { const have = vpsOf(st.slot); const want = narrow() ? 390 : 1280; st.vp = have.includes(want) ? want : have[0]; };
      pickVp();
      const wrap = h("div", { class: "dlg-rv__pick" });
      const slotLabel = (s) => `${s.viewKey || "—"} · ${ct(`rv.role.${s.role}`)}`;

      function holder(shot, label) {
        const box = h("div", { class: "dlg-rv__img" });
        if (!shot) { box.append(h("p", { class: "dlg-rv__msg" }, ct("rv.shots.missing"))); return box; }
        if (shot.purged) { box.append(h("p", { class: "dlg-rv__msg", "data-testid": "confirm-rv-purged" }, ct("rv.shots.purged"))); return box; }
        const fail = (kind) => box.replaceChildren(h("p", { class: "dlg-rv__msg", "data-testid": "confirm-rv-imgerr" }, ct(kind === "purged" ? "rv.shots.purged" : kind === "expired" ? "rv.shots.expired" : kind === "bad" ? "rv.shots.failed" : "rv.shots.blocked")),
          kind === "purged" ? "" : button(ct("rv.shots.retry"), { small: true, "data-testid": "confirm-rv-retry", onClick: () => { revoke(shot.id); load(); } }));
        // an image the browser cannot decode (a PNG signature followed by garbage) shows the error state with a retry, never a broken-image icon
        const put = (u) => box.replaceChildren(h("img", { src: u, alt: label, class: "dlg-rv__pic", decoding: "async", onerror: () => { if (myGen === gen) { revoke(shot.id); fail("bad"); } } }));
        const load = () => {
          if (urls.has(shot.id)) { put(urls.get(shot.id)); return; }
          box.replaceChildren(h("p", { class: "muted dlg-rv__skel" }, ct("rv.shots.imageLoading")));
          handlers.image(shot.id).then((blob) => {
            if (myGen !== gen || !wrap.isConnected) return;
            if (!urls.has(shot.id)) urls.set(shot.id, URL.createObjectURL(blob));
            put(urls.get(shot.id));
          }).catch((e) => {
            if (myGen !== gen) return;
            fail(e && e.kind);
          });
        };
        load();
        return box;
      }

      function draw() {
        const slot = st.slot, pair = slot.vps[st.vp] || {};
        const visible = new Set();
        const sel = h("select", { class: "input", "aria-label": ct("rv.shots.view"), "data-testid": "confirm-rv-view", onchange: (e) => { st.slot = slots[Number(e.target.value)]; pickVp(); draw(); } },
          slots.map((s, i) => h("option", { value: String(i), selected: s === slot }, slotLabel(s))));
        const toggles = (label, opts, cur, set, tid) => h("div", { class: "dlg-rv__tog", role: "group", "aria-label": label },
          opts.map(([v, text]) => button(text, { small: true, kind: cur === v ? "primary" : "ghost", "aria-pressed": String(cur === v), "data-testid": `${tid}-${v}`, onClick: () => { set(v); draw(); } })));
        const controls = h("div", { class: "dlg-rv__ctl" }, sel,
          toggles(ct("rv.shots.viewport"), vpsOf(slot).map((v) => [v, String(v)]), st.vp, (v) => { st.vp = v; }, "confirm-rv-vp"),
          toggles(ct("rv.shots.mode"), [["single", ct("rv.shots.mode.single")], ["side", ct("rv.shots.mode.side")], ["slider", ct("rv.shots.mode.slider")]], st.mode, (v) => { st.mode = v; }, "confirm-rv-mode"));
        const want = (shot) => { if (shot) visible.add(shot.id); return shot; };
        const lbl = (p) => `${ct(p === "before" ? "rv.shots.before" : "rv.shots.after")} ${slot.viewKey}`;
        let stage;
        if (st.mode === "single") {
          const shot = want(pair[st.phase]);
          stage = h("div", {}, toggles(ct("rv.shots.mode"), [["before", ct("rv.shots.before")], ["after", ct("rv.shots.after")]], st.phase, (v) => { st.phase = v; }, "confirm-rv-phase"),
            h("div", { class: "dlg-rv__stage", tabindex: "0", role: "region", "aria-label": ct("rv.shots.region") }, holder(shot, lbl(st.phase))));
        } else if (st.mode === "side") {
          const b = want(pair.before), a = want(pair.after);
          stage = h("div", { class: "dlg-rv__stage dlg-rv__stage--side", tabindex: "0", role: "region", "aria-label": ct("rv.shots.region") },
            h("figure", {}, h("figcaption", {}, ct("rv.shots.before")), holder(b, lbl("before"))),
            h("figure", {}, h("figcaption", {}, ct("rv.shots.after")), holder(a, lbl("after"))));
        } else {
          const b = want(pair.before), a = want(pair.after);
          const over = holder(a, lbl("after")); over.classList.add("dlg-rv__over");
          const clip = () => { over.style.clipPath = `inset(0 ${100 - st.slide}% 0 0)`; };
          clip();
          const range = h("input", { type: "range", min: "0", max: "100", step: "1", value: String(st.slide), class: "dlg-rv__range", "aria-label": ct("rv.shots.sliderLabel"), "data-testid": "confirm-rv-slider",
            oninput: (e) => { st.slide = Number(e.target.value); clip(); } });
          stage = h("div", {}, h("div", { class: "dlg-rv__stage", tabindex: "0", role: "region", "aria-label": ct("rv.shots.region") }, h("div", { class: "dlg-rv__cmp" }, holder(b, lbl("before")), over)), range);
        }
        const ppm = pair.after && pair.after.diffPpm !== null ? pair.after.diffPpm : pair.before ? pair.before.diffPpm : null;
        for (const id of [...urls.keys()]) if (!visible.has(id)) revoke(id); // an image that left the screen frees its object URL
        wrap.replaceChildren(controls, stage, ppm === null ? "" : h("p", { class: "muted", "data-testid": "confirm-rv-diff" }, ct("rv.shots.diff", { pct: pctOf(ppm) })));
      }
      draw();
      return wrap;
    }

    // ── actions panel ──
    let ack = null, approveBtn = null, ackTrusted = false, clickTrusted = false; // ackTrusted: the box was ticked by a real (isTrusted) change event
    // The 1-second delay (D18): armed whenever an irreversible confirmation appears; a visible hint counts it down.
    let unlockAt = 0, timer = 0, hintEl = null, announceEl = null, shownSecs = -1, rejectBtn = null;
    const waiting = () => now() < unlockAt;
    const stopTimer = () => { if (timer) { clearInterval(timer); timer = 0; } };
    // aria-disabled, not the disabled attribute, while the button is only "not yet": it stays focusable and reachable for assistive technology, is
    // described by the hint next to it, and every handler below refuses to act (the isTrusted and delay gates do not depend on the attribute).
    // The real disabled attribute is used only while a request is in flight (lock()).
    const setWait = (btn, wait) => { btn.setAttribute("aria-disabled", wait ? "true" : "false"); btn.classList.toggle("is-wait", wait); };
    const syncAck = () => { if (approveBtn) setWait(approveBtn, !(ack && ack.checked && ackTrusted) || waiting() || displayBad); if (rejectBtn) setWait(rejectBtn, waiting()); };
    const refreshGate = () => {
      const left = Math.max(0, unlockAt - now());
      // the visible countdown changes once per second and is NOT a live region (a 100 ms rewrite would be read out again and again); one polite
      // announcement is made when the wait is over
      if (hintEl) { const secs = left > 0 ? Math.max(1, Math.ceil(left / 1000)) : 0; if (secs !== shownSecs) { shownSecs = secs; hintEl.textContent = secs ? ct("rv.delay", { s: secs }) : ""; hintEl.hidden = !secs; if (!secs && announceEl) announceEl.textContent = ct("rv.delay.over"); } }
      if (!busy) syncAck();
      if (left <= 0) stopTimer();
    };
    const armDelay = () => { unlockAt = now() + DELAY_MS; shownSecs = -1; if (announceEl) announceEl.textContent = ""; stopTimer(); timer = setInterval(refreshGate, 100); refreshGate(); };
    async function run(fn) {
      if (busy) return;
      busy = true; lock(true); // disabled at once, before anything is awaited
      let r;
      try { r = await fn(); } catch { r = { kind: "error", message: ct("rv.err.conflict") }; }
      busy = false;
      if (r.kind === "done") { toast(r.message, "ok"); close(); return; }
      if (r.kind === "ok") { model = r.model; mode = "review"; say(""); render(); return; }
      say(r.message);
      if (r.kind === "reload") { mode = "reload"; renderPanel(); } else { lock(false); refreshGate(); }
    }
    let displayBad = false;
    // Every submitting button: a real click AND the dialog shown at its normal scale, fully on screen (a design cannot zoom or move it later).
    // Otherwise nothing is sent, the approve button stays disabled and the person is asked to reload.
    const trusted = (fn) => (ev) => {
      if (!(ev && ev.isTrusted === true)) return;
      if (sane && !sane()) { displayBad = true; say(ct("dlg.display")); displayBad = true; syncAck(); return; }
      fn();
    };
    const back = () => { mode = "review"; say(""); renderPanel(); };
    const closeBtn = () => button(ct("rv.btn.close"), { onClick: () => { if (!busy) close(); }, "data-testid": "confirm-rv-close" });

    function renderPanel() {
      ack = null; approveBtn = null; rejectBtn = null; hintEl = null; announceEl = null; shownSecs = -1; ackTrusted = false; clickTrusted = false;
      const kids = [];
      const delayHint = () => { hintEl = h("p", { class: "muted", id: "dlg-rv-delayhint", "data-testid": "confirm-rv-delay" }); announceEl = h("span", { class: "dlg-rv__sr", role: "status", "aria-live": "polite", "data-testid": "confirm-rv-ready" }); return h("div", {}, hintEl, announceEl); };
      if (mode === "reload") {
        kids.push(h("div", { class: "dlg__foot dlg-rv__btns" }, button(ct("rv.btn.reload"), { kind: "primary", "data-testid": "confirm-rv-reload", onClick: trusted(() => run(() => handlers.reload())) }), closeBtn()));
      } else if (mode === "reject") {
        const reason = textarea({ maxlength: 500, rows: 3, "aria-label": ct("rv.reject.label"), "data-testid": "confirm-rv-reason" });
        kids.push(h("p", {}, h("span", { class: "dlg__warning", "data-testid": "confirm-warning" }, model.reject.warning)),
          h("label", { class: "field" }, h("span", { class: "field__label" }, ct("rv.reject.label")), reason),
          delayHint(),
          h("div", { class: "dlg__foot dlg-rv__btns" }, button(ct("rv.btn.back"), { onClick: () => { if (!busy) back(); } }),
            rejectBtn = button(model.reject.yes, { kind: "danger", "aria-disabled": "true", "aria-describedby": "dlg-rv-delayhint", "data-testid": "confirm-yes", onClick: trusted(() => { if (waiting() || busy) return; run(() => handlers.reject({ reason: reason.value })); }) })));
        armDelay();
      } else if (mode === "changes") {
        const note = textarea({ maxlength: 500, rows: 3, "aria-label": ct("rv.changes.label"), "data-testid": "confirm-rv-note" });
        kids.push(h("p", { class: "muted" }, ct("rv.changes.hint")),
          h("label", { class: "field" }, h("span", { class: "field__label" }, ct("rv.changes.label")), note),
          h("div", { class: "dlg__foot dlg-rv__btns" }, button(ct("rv.btn.back"), { onClick: () => { if (!busy) back(); } }),
            button(ct("rv.changes.send"), { kind: "primary", "data-testid": "confirm-yes", onClick: trusted(() => run(() => handlers.requestChanges({ note: note.value }))) })));
      } else {
        const side = [];
        if (model.canReject) {
          side.push(button(ct("rv.btn.changes"), { "data-testid": "confirm-rv-changes", onClick: () => { if (!busy) { mode = "changes"; say(""); renderPanel(); } } }),
            button(ct("rv.btn.reject"), { kind: "danger-ghost", "data-testid": "confirm-rv-reject", onClick: () => { if (!busy) { mode = "reject"; say(""); renderPanel(); } } }));
        }
        side.push(closeBtn());
        if (model.canApprove) {
          ack = h("input", { type: "checkbox", "data-testid": "confirm-rv-ack", "aria-describedby": "dlg-rv-ackhint",
            // el.click() makes the browser fire a TRUSTED change event, so the tick counts only when the CLICK that caused it was a real one
            // (isTrusted on the click: a pointer press or Space / Enter on the focused box); anything else is undone.
            onclick: (ev) => { clickTrusted = ev.isTrusted === true; },
            onchange: (ev) => { if (ev.isTrusted === true && clickTrusted) ackTrusted = ack.checked; else ack.checked = ackTrusted; clickTrusted = false; syncAck(); } });
          approveBtn = button(model.approve.yes, { kind: "danger", "aria-disabled": "true", "aria-describedby": "dlg-rv-ackhint dlg-rv-delayhint", "data-testid": "confirm-yes",
            onClick: trusted(() => { if (busy || waiting() || displayBad || !ack.checked || !ackTrusted) return; run(() => handlers.approve({ acknowledged: ack.checked })); }) });
          if (model.approve.text) kids.push(h("p", { class: "dlg__msg" }, model.approve.text));
          kids.push(h("p", {}, h("span", { class: "dlg__warning", "data-testid": "confirm-warning" }, model.approve.warning)),
            h("label", { class: "check dlg-rv__ack" }, ack, h("span", {}, ct("rv.ack"))),
            h("p", { class: "muted", id: "dlg-rv-ackhint" }, ct("rv.ack.hint")),
            delayHint(),
            h("div", { class: "dlg__foot dlg-rv__btns" }, ...side, approveBtn));
        } else {
          kids.push(h("p", { class: "notice", "data-testid": "confirm-rv-cannot" }, model.cannotReason), h("div", { class: "dlg__foot dlg-rv__btns" }, ...side));
        }
      }
      panel.replaceChildren(...kids);
      if (approveBtn) armDelay(); else if (!rejectBtn) { stopTimer(); unlockAt = 0; }
    }

    function render() {
      const myGen = ++gen;
      for (const id of [...urls.keys()]) revoke(id);
      const title = dialog.querySelector(".dlg__title");
      if (title) title.textContent = titleOf();
      main.replaceChildren(alertBox, facts(), shotsBlock(myGen), previewBlock());
      renderPanel();
    }
    render();
  });
}
