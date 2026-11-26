// Design history READ layer (platform change design-history; owner-approved plan T1-T4, docs/DECISIONS.md D13; this is PR1).
// The three ctx.data functions: listDesignRequests({site?, status?, kind?, page, pageSize}), getDesignRequest(id), getDesignState({site?}).
// All need design.view, checked here BEFORE any request; the shop is bound here; ids and filters are checked for shape before they go
// into a URL; every API failure becomes an ActionError the screens understand; the design layer receives only the plain objects
// lib/design-history.js builds (no signed URL, no token, no shop id, no ETag). They are GETs, so they work in preview mode too.
// The ctx ACTIONS (open review, request revert, cancel) are not part of this change.
import { session } from "../lib/session.js";
import { ApiError } from "../lib/api.js";
import * as dh from "../lib/design-history.js";
import { t } from "../lib/design.js";
import { need } from "./guard.js";
import { ActionError, denied, invalid } from "./errors.js";

const S = () => session.shopID;
const gone = () => new ActionError("state", t("err.404"), { reason: "gone", status: 404 });
const requireId = (v) => { if (!dh.isId(v)) throw gone(); };

/** ApiError -> ActionError. Anything that is not an ApiError is returned untouched. */
export function toActionError(e) {
  if (!(e instanceof ApiError)) return e;
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
  return e;
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
    return dh.normalizeRequest(d, ev && ev.events);
  } catch (e) { throw toActionError(e); }
}

/** ctx.data.getDesignState({site?}) -> {sites: [{site, current: {requestId, tag, coreVersion}, untracked, pendingApproval, ...}], pendingApproval}. Needs design.view. */
export async function getDesignState(opts) {
  need("design.view");
  const o = opts && typeof opts === "object" ? opts : {};
  if (!dh.validSite(o.site)) throw invalid({});
  try { return dh.normalizeState(await dh.fetchState(S()), o.site || ""); } catch (e) { throw toActionError(e); }
}
