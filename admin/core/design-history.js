// Design history READ layer (platform change design-history; owner-approved plan T1-T4, docs/DECISIONS.md D13; this is PR1).
// The three ctx.data functions: listDesignRequests({site?, status?, kind?, page, pageSize}), getDesignRequest(id), getDesignState({site?}).
// All need design.view, checked here BEFORE any request; the shop is bound here; ids and filters are checked for shape before they go
// into a URL; every API failure becomes an ActionError the screens understand; the design layer receives only the plain objects
// lib/design-history.js builds (no signed URL, no token, no shop id, no ETag). They are GETs, so they work in preview mode too.
// The ctx ACTIONS (open review, request revert, cancel) are not part of this change.
import { session } from "../lib/session.js";
import { ApiError } from "../lib/api.js";
import * as dh from "../lib/design-history.js";
import { allowPreviewLinkOrigin } from "../ui/kit.js";
import { t } from "../lib/design.js";
import { need } from "./guard.js";
import { ActionError, denied, invalid } from "./errors.js";

const S = () => session.shopID;
const gone = () => new ActionError("state", t("err.404"), { reason: "gone", status: 404 });
const requireId = (v) => { if (!dh.isId(v)) throw gone(); };

/**
 * What the design layer gets for a failure it has no special case for: a plain ActionError with fixed wording. It never carries an
 * ApiError (its `body` is the platform's raw response) or any network error text.
 */
export function genericError(e) {
  if (e && e.isActionError) return e;
  if (e instanceof ApiError) {
    if (e.status === 401) return new ActionError("state", t("err.401"), { reason: "unauthorized", status: 401 });
    if (e.status >= 500) return new ActionError("state", t("err.5xx"), { reason: "server_error", status: e.status });
    return new ActionError("state", t("err.generic"), { reason: "error", status: e.status });
  }
  return new ActionError("state", t("err.network"), { reason: "network", status: 0 });
}

/** ApiError -> ActionError. Everything unmapped becomes a generic ActionError (genericError), never the raw ApiError. */
export function toActionError(e) {
  if (e && e.isActionError) return e;
  if (!(e instanceof ApiError)) return genericError(e);
  const detail = String(e.body?.error?.message || "").slice(0, 300);
  const mk = (kind, key, reason, status, params) => { const a = new ActionError(kind, t(key, params), { reason, status }); a.detail = detail; return a; };
  if (e.status === 403) return denied();
  if (e.status === 404) return gone();
  if (e.status === 422) return mk("invalid", "err.422", "invalid", 422);
  if (e.status === 429) {
    const a = mk("limit", "err.429Wait", "rate_limited", 429, { minutes: Math.max(1, Math.ceil((e.retryAfter || 60) / 60)) });
    a.retryAfter = e.retryAfter || 0;
    return a;
  }
  if (e.status === 503) return mk("state", "err.503", e.code || "unavailable", 503);
  return genericError(e);
}

/** ctx.data.listDesignRequests({site?, status?, kind?, page, pageSize}) -> {requests[], page, pageSize, total}. Needs design.view. */
export async function listDesignRequests(filters) {
  need("design.view");
  const query = dh.listQuery(filters);
  if (query === null) throw invalid({});
  try { return dh.normalizePage(await dh.fetchRequests(S(), query)); } catch (e) { throw toActionError(e); }
}

/** ctx.data.getDesignRequest(id) -> the request in full with its first 100 events. Needs design.view. The ETag stays in lib/design-history.js. */
export async function getDesignRequest(id) {
  need("design.view");
  requireId(id);
  const shopID = S();
  try {
    const [d, ev] = await Promise.all([dh.fetchRequest(shopID, id), dh.fetchEvents(shopID, id)]);
    const request = dh.normalizeRequest(d, ev && ev.events);
    // The change-preview link on the request screen: ONE href-only slot (ui/kit.js), the origin of the request just read; never a global allowlist.
    allowPreviewLinkOrigin(request.previewOrigin || "");
    return request;
  } catch (e) { throw toActionError(e); }
}

/** ctx.data.getDesignState({site?}) -> {sites: [{site, current: {requestId, tag, coreVersion}, untracked, pendingApproval, ...}], pendingApproval}. Needs design.view. */
export async function getDesignState(opts) {
  need("design.view");
  const o = opts && typeof opts === "object" ? opts : {};
  if (!dh.validSite(o.site)) throw invalid({});
  try { return dh.normalizeState(await dh.fetchState(S()), o.site || ""); } catch (e) { throw toActionError(e); }
}
