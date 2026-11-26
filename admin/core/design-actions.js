// Design history ACTIONS (T1-T4 PR2, docs/DECISIONS.md D14; the three ctx.actions the owner approved in D12/D13):
//   openDesignReview(id)               -> {outcome: "approved"|"rejected"|"changesRequested"|"closed", request}
//   requestDesignRevert(id, {reason?}) -> {request} | {cancelled: true}
//   cancelDesignRequest(id)            -> {request} | {cancelled: true}
// None of them takes a head sha, an ETag, a URL or any credential from the design layer.
//
// The review is CORE-DRAWN: ui/design-review.js builds the dialog from data THIS module read itself. Approving is bound to what the
// person saw: the review pins the ETag and the candidate sha of the read it displays (lib/design-history.js fetchRequestForReview) and the
// approve call sends exactly those. When the platform answers head_moved / 412 / 428 (or the pinned basis no longer matches what the core
// last read, or it was cleared by a sign-out or a user change) the review RELOADS and the person must look again: nothing is ever
// retried or re-sent automatically. Screenshot URLs live only in this closure and the dialog: never in a return value, a log or a URL.
// Every function sits in the actions table, so preview hosts refuse all of them (core/guard.js readOnlyGuarded).
import { session } from "../lib/session.js";
import { ApiError } from "../lib/api.js";
import { can } from "../lib/perm.js";
import { isReadOnly } from "../lib/preview.js";
import * as dh from "../lib/design-history.js";
import * as rv from "../lib/design-review.js";
import { t } from "../lib/design.js";
import { coreText } from "../lib/fixed-text.js";
import { formatDateTime } from "../ui/format.js";
import { fixedWarning } from "./warnings.js";
import { need, readOnlyError } from "./guard.js";
import { ActionError, invalid } from "./errors.js";
import { genericError, toActionError as readError } from "./design-history.js";

const S = () => session.shopID;
const siteName = () => session.shopName || coreText("rv.thisShop");
const CANCELLED = Object.freeze({ cancelled: true });
const gone = () => new ActionError("state", t("err.404"), { reason: "gone", status: 404 });
const requireId = (v) => { if (!dh.isId(v)) throw gone(); };
const TERMINAL = new Set(["published", "rejected", "failed", "cancelled", "reverted"]);
const err = (kind, key, reason, status, params) => new ActionError(kind, coreText(key, params), { reason, status });

/** ApiError of a review / write call -> ActionError with a reason. Unmapped cases become a generic error (no ApiError, no body). */
export function reviewError(e) {
  if (e && e.isActionError) return e;
  if (!(e instanceof ApiError)) return genericError(e);
  if (e.status === 409) {
    switch (e.code) {
      case "head_moved": return err("stale", "rv.err.headMoved", "head_moved", 409);
      case "approval_expired": return err("state", "rv.err.approvalExpired", "approval_expired", 409);
      case "revert_below_core_floor": return err("state", "rv.err.belowFloor", "revert_below_core_floor", 409);
      case "already_current": return err("state", "rv.err.alreadyCurrent", "already_current", 409);
      case "request_in_progress": return err("state", "rv.err.inProgress", "request_in_progress", 409);
      case "invalid_state": return err("state", "rv.err.invalidState", "invalid_state", 409);
      case "site_state_unknown": return err("state", "rv.err.siteUnknown", "site_state_unknown", 409);
      default: return err("state", "rv.err.conflict", "conflict", 409);
    }
  }
  if (e.status === 412) return err("stale", "rv.err.stale", "precondition_failed", 412);
  if (e.status === 428) return err("stale", "rv.err.stale", "precondition_required", 428);
  return readError(e);
}
/** Failures after which the review must be reloaded and looked at again (never retried by the core). */
const needsReload = (e) => e && e.isActionError && ["head_moved", "precondition_failed", "precondition_required", "invalid_state"].includes(e.reason);

const params = (req) => ({
  siteName: siteName(), sha: (req.candidateSha || req.headSha || "").slice(0, 7), n: req.diff.filesChanged,
  tag: req.revertTargetTag || coreText("rv.unknownTag"),
});

/**
 * The actions. `ask` is core/actions.js's confirmation helper (copy title/text/yes + the FIXED warning), `review` shows the dialog
 * (ui/design-review.js; injected so the logic is testable without a DOM), `notify` shows a status text (a toast).
 */
export function createDesignActions({ ask, review, notify = () => {} }) {
  /** One read of a request, plus the basis that read pinned. Everything the dialog shows comes from this. */
  async function readForReview(shopID, id) {
    const { data, basis } = await dh.fetchRequestForReview(shopID, id);
    return { request: dh.normalizeRequest(data, []), basis };
  }

  function stateOf(request, basis) {
    const status = request.status;
    let cannot = "";
    if (!can("design.approve")) cannot = coreText("rv.cannot.permission");
    else if (isReadOnly()) cannot = coreText("rv.cannot.preview");
    else if (status !== "awaiting_approval") cannot = coreText("rv.cannot.state", { status: coreText(`rv.status.${status}`) });
    else if (!basis.etag || !request.candidateSha || basis.candidateSha !== request.candidateSha || basis.headSha !== basis.candidateSha) cannot = coreText("rv.cannot.stale");
    return { canApprove: cannot === "", cannotReason: cannot };
  }

  async function openDesignReview(id) {
    need("design.view");
    requireId(id);
    const shopID = S();
    let cur;
    try { cur = await readForReview(shopID, id); } catch (e) { throw reviewError(e); }
    let result = null;      // the outcome, set by a handler that succeeded
    let inflight = false;   // one write at a time (a double press never sends two)
    let spent = false;      // the pinned review was used for an approve
    let shots = null;       // {items[], state, refreshing}: signed URLs live ONLY here and in the dialog
    let disposed = false;

    const model = () => {
      const { request, basis } = cur;
      const isRevert = request.kind === "revert";
      const id2 = isRevert ? "approveRevert" : "approveDesign";
      const p = params(request);
      return {
        request,
        shopName: siteName(),
        ...stateOf(request, basis),
        canReject: can("design.approve") && !isReadOnly() && request.status === "awaiting_approval",
        approve: { title: t(`confirm.${id2}.title`, p), text: t(`confirm.${id2}.text`, p), yes: t(`confirm.${id2}.yes`, p), warning: fixedWarning(id2, p), danger: true },
        reject: { title: t("confirm.rejectDesign.title", p), text: t("confirm.rejectDesign.text", p), yes: t("confirm.rejectDesign.yes", p), warning: fixedWarning("rejectDesign", p) },
      };
    };

    // ── screenshots ──
    const dropShots = () => { shots = null; };
    async function refreshShots() {
      if (disposed) throw new rv.ImageError("failed");
      if (shots && shots.pending) return shots.pending;
      const pending = rv.fetchScreenshots(shopID, id).then((items) => { shots = { items }; return shots; });
      shots = { ...(shots || { items: [] }), pending };
      try { return await pending; } catch (e) { shots = { items: [] }; throw e; }
    }
    /** The list for the dialog: one GET when the review opens (and again only when an image URL expired). */
    async function loadShots() {
      try { return { state: "ok", items: (await refreshShots()).items.map(({ url, urlExpiresAt, ...pub }) => pub) }; } catch (e) {
        if (e instanceof ApiError && e.status === 503) return { state: "notConfigured", items: [] };
        return { state: "error", items: [] };
      }
    }
    const find = (sid) => (shots ? shots.items.find((s) => s.id === sid) : null);
    /** One screenshot as a PNG blob. A 403 / expired URL is retried ONCE with a fresh URL; then ImageError("expired"|"failed"). */
    async function image(sid) {
      let s = find(sid);
      if (!s) throw new rv.ImageError("failed");
      if (s.purged || !s.url) throw new rv.ImageError("purged");
      try {
        if (s.urlExpiresAt && s.urlExpiresAt - 5000 <= Date.now()) { await refreshShots(); s = find(sid); if (!s || s.purged || !s.url) throw new rv.ImageError(s && s.purged ? "purged" : "failed"); }
        return await rv.fetchImageBlob(s.url);
      } catch (e) {
        if (!(e instanceof rv.ImageError) || e.kind === "bad" || e.kind === "purged") throw e instanceof rv.ImageError ? e : new rv.ImageError("failed");
        try { await refreshShots(); } catch { throw new rv.ImageError("failed"); }
        const again = find(sid);
        if (!again || again.purged || !again.url) throw new rv.ImageError(again && again.purged ? "purged" : "failed");
        return rv.fetchImageBlob(again.url);
      }
    }

    // ── handlers (only the dialog holds them) ──
    const done = (outcome, request, key, p) => {
      result = { outcome, request };
      return { kind: "done", outcome, message: coreText(key, p) };
    };
    const fail = (e) => {
      const a = reviewError(e);
      if (needsReload(a)) { dh.forgetReviewBasis(shopID, id); return { kind: "reload", message: a.message }; }
      return { kind: "error", message: a.message };
    };
    const guardWrite = () => { need("design.approve"); if (isReadOnly()) throw readOnlyError(); };
    const exclusive = async (fn) => {
      if (inflight) return { kind: "error", message: coreText("rv.err.busy") };
      inflight = true;
      try { return await fn(); } finally { inflight = false; }
    };

    async function approve({ acknowledged } = {}) {
      return exclusive(async () => {
        try { guardWrite(); } catch (e) { return { kind: "error", message: e.message }; }
        if (acknowledged !== true) return { kind: "error", message: coreText("rv.err.ackNeeded") };
        const pinned = cur.basis;
        if (spent || !stateOf(cur.request, pinned).canApprove) return { kind: "reload", message: coreText("rv.err.headMoved") };
        // The pinned basis must still be what the core last read (a sign-out, a user change or a newer read of this request changes it).
        const live = dh.reviewBasis(shopID, id);
        if (!live || live.etag !== pinned.etag || live.candidateSha !== pinned.candidateSha || live.headSha !== pinned.headSha) {
          dh.forgetReviewBasis(shopID, id);
          return { kind: "reload", message: coreText("rv.err.headMoved") };
        }
        spent = true;
        try {
          const { data } = await rv.approveRequest(shopID, id, { etag: pinned.etag, headSha: pinned.candidateSha });
          dh.forgetReviewBasis(shopID, id);
          const request = dh.normalizeRequest(data, []);
          const when = request.approvalExpiresAt ? formatDateTime(request.approvalExpiresAt) : "";
          return done("approved", request, when ? "rv.done.approved" : "rv.done.approvedNoTime", { time: when });
        } catch (e) { const r = fail(e); if (r.kind === "error") spent = false; return r; } // only a stale review stays spent
      });
    }
    async function reject({ reason } = {}) {
      return exclusive(async () => {
        try { guardWrite(); } catch (e) { return { kind: "error", message: e.message }; }
        if (cur.request.status !== "awaiting_approval") return { kind: "reload", message: coreText("rv.err.invalidState") };
        if (typeof reason === "string" && reason.length > rv.NOTE_MAX) return { kind: "error", message: coreText("rv.err.noteLong") };
        try {
          const request = dh.normalizeRequest(await rv.rejectRequest(shopID, id, reason), []);
          dh.forgetReviewBasis(shopID, id);
          return done("rejected", request, "rv.done.rejected");
        } catch (e) { return fail(e); }
      });
    }
    async function requestChanges({ note } = {}) {
      return exclusive(async () => {
        try { guardWrite(); } catch (e) { return { kind: "error", message: e.message }; }
        if (cur.request.status !== "awaiting_approval") return { kind: "reload", message: coreText("rv.err.invalidState") };
        if (typeof note !== "string" || !rv.cleanNote(note)) return { kind: "error", message: coreText("rv.err.noteNeeded") };
        if (note.trim().length > rv.NOTE_MAX) return { kind: "error", message: coreText("rv.err.noteLong") };
        try {
          const request = dh.normalizeRequest(await rv.requestChanges(shopID, id, note), []);
          dh.forgetReviewBasis(shopID, id);
          return done("changesRequested", request, "rv.done.changes");
        } catch (e) { return fail(e); }
      });
    }
    /** A new read: a new pinned basis, new screenshots. The checkbox starts unticked again (the dialog re-renders from the new model). */
    async function reload() {
      try { cur = await readForReview(shopID, id); spent = false; dropShots(); return { kind: "ok", model: model() }; } catch (e) { return { kind: "error", message: reviewError(e).message }; }
    }
    const dispose = () => { disposed = true; dropShots(); };

    await review(model(), { approve, reject, requestChanges, reload, loadShots, image, dispose });
    dispose();
    return result || { outcome: "closed", request: cur.request };
  }

  /** The target's tag, read by the core (never given by the design layer). */
  const readTarget = async (id) => { try { return dh.normalizeRequest(await dh.fetchRequest(S(), id), []); } catch (e) { throw reviewError(e); } };
  const reasonOf = (opts) => {
    const r = opts && typeof opts === "object" && Object.hasOwn(opts, "reason") ? opts.reason : undefined;
    if (r === undefined || r === null || r === "") return "";
    if (typeof r !== "string" || r.length > rv.NOTE_MAX) throw invalid({ "/reason": coreText("rv.err.noteLong") });
    return r;
  };

  async function requestDesignRevert(id, opts) {
    need("design.revert");
    requireId(id);
    const reason = reasonOf(opts);
    const target = await readTarget(id);
    if (target.status !== "published" && target.status !== "reverted") throw err("state", "rv.err.notPublished", "invalid_state", 409);
    if (!(await ask("confirm.revertDesign", { siteName: siteName(), tag: target.publishedTag || target.publishTag || coreText("rv.unknownTag") }, { danger: false }))) return CANCELLED;
    try {
      const request = dh.normalizeRequest(await rv.revertRequest(S(), id, reason), []);
      notify(coreText("rv.done.revert"));
      return { request };
    } catch (e) { throw reviewError(e); }
  }

  async function cancelDesignRequest(id) {
    need("design.request");
    requireId(id);
    const target = await readTarget(id);
    if (TERMINAL.has(target.status)) throw err("state", "rv.err.terminal", "invalid_state", 409);
    if (!(await ask("confirm.cancelDesign", { siteName: siteName() }))) return CANCELLED;
    try {
      const request = dh.normalizeRequest(await rv.cancelRequest(S(), id), []);
      notify(coreText("rv.done.cancelled"));
      return { request };
    } catch (e) { throw reviewError(e); }
  }

  // Declared with one (or two) parameters on purpose: nothing else can be passed in, and extra arguments are ignored.
  return { openDesignReview: (id) => openDesignReview(id), requestDesignRevert: (id, opts) => requestDesignRevert(id, opts), cancelDesignRequest: (id) => cancelDesignRequest(id) };
}
