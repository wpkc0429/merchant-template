// Version preview (platform change design-history, D25; decided by the owner 2026-11-26, docs/DECISIONS.md D11).
// The two functions the design layer gets for it: ctx.actions.requestVersionPreview(requestId) and ctx.data.getVersionPreview(previewId).
// The LOGIC is the core's: the permission (design.view) is checked here before any request, the shop is bound here, ids are checked
// for shape before they go into a URL, every API failure is mapped to an ActionError the screens understand, and the design layer
// receives only the plain object lib/versionpreview.js normalize() returns (no token, no shop id, no raw response).
// The design layer only renders. The preview itself is read-only (lib/preview.js) and a version preview is NOT an approval.
import { session } from "../lib/session.js";
import { ApiError } from "../lib/api.js";
import * as vp from "../lib/versionpreview.js";
import { t } from "../lib/design.js";
import { allowPreviewLinkOrigin } from "../ui/kit.js";
import { need } from "./guard.js";
import { ActionError, denied, previewDenied } from "./errors.js";
import { genericError } from "./design-history.js";

const S = () => session.shopID;
const gone = () => new ActionError("state", t("err.404"), { reason: "gone", status: 404 });
const requireId = (v) => { if (!vp.isId(v)) throw gone(); };
// A ready preview's origin (https, scheme + host, checked in lib/versionpreview.js) may be used as a LINK target (href only, not an image
// source) by the screens: the safe DOM builder drops hrefs to unknown origins, so the core registers exactly this one in a single slot
// that the next preview replaces. The global image/link allowlist is not touched. (The CSP still decides what any page may load.)
const shown = (p) => { if (p.origin) allowPreviewLinkOrigin(p.origin); return p; };
const detailOf = (e) => String(e.body?.error?.message || "").slice(0, 300);

/** ApiError -> ActionError. 409 reasons and 429 caps keep their machine code in `reason`; 429 carries `retryAfter` (seconds). Anything else
 * becomes the generic ActionError of core/design-history.js (fixed wording; never the ApiError, its response body or a raw network message). */
export function toActionError(e) {
  if (e && e.isActionError) return e;
  if (!(e instanceof ApiError)) return genericError(e);
  const mk = (kind, key, reason, params, status) => {
    const a = new ActionError(kind, t(key, params), { reason, status });
    a.detail = detailOf(e);
    return a;
  };
  if (e.status === 403) return e.code === "preview_read_only" ? previewDenied() : denied();
  if (e.status === 404) return gone();
  if (e.status === 409) {
    switch (e.code) {
      case "revert_below_core_floor": return mk("state", "vp.err.belowFloor", "revert_below_core_floor", undefined, 409);
      case "already_current": return mk("state", "vp.err.alreadyCurrent", "already_current", undefined, 409);
      case "invalid_state": return mk("state", "vp.err.invalidState", "invalid_state", undefined, 409);
      case "site_state_unknown": return mk("state", "vp.err.siteUnknown", "site_state_unknown", undefined, 409);
      default: return mk("state", "vp.err.conflict", e.code || "conflict", undefined, 409);
    }
  }
  if (e.status === 429) {
    const hourly = e.code === "hourly_cap_reached";
    const daily = e.code === "daily_cap_reached";
    const minutes = Math.max(1, Math.ceil((e.retryAfter || 60) / 60));
    const a = mk("limit", hourly ? "vp.err.hourlyCap" : daily ? "vp.err.dailyCap" : "err.429Wait", hourly || daily ? e.code : "rate_limited", { minutes }, 429);
    a.retryAfter = e.retryAfter || 0;
    return a;
  }
  return genericError(e);
}

/** ctx.data.getVersionPreview(previewId): the preview's state. Needs design.view. `origin` is set only for the person who asked, while it is ready. */
export async function getVersionPreview(previewId) {
  need("design.view");
  requireId(previewId);
  try { return shown(vp.normalize(await vp.fetchVersionPreview(S(), previewId))); } catch (e) { throw toActionError(e); }
}

/** ctx.actions.requestVersionPreview(requestId): asks for a preview of a past published design. Needs design.view. Refused in preview mode (core/actions.js). */
export async function requestVersionPreview(requestId) {
  need("design.view");
  requireId(requestId);
  try { return shown(vp.normalize(await vp.createVersionPreview(S(), requestId))); } catch (e) { throw toActionError(e); }
}
