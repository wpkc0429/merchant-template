// Design history API (platform change design-history): the READ routes the core uses (PR1 of T1-T4, docs/DECISIONS.md D13).
//   GET /admin/shops/{id}/design/requests                  -> a page of request summaries
//   GET /admin/shops/{id}/design/requests/{requestId}      -> one request (+ ETag, kept INSIDE this module, never handed out)
//   GET /admin/shops/{id}/design/requests/{requestId}/events
//   GET /admin/shops/{id}/design/state                     -> the current design per site + pending_approval_count
// Everything the design layer receives is a plain camelCase object built by the normalize functions below: unknown keys are
// dropped (a new platform field never leaks through), no shop id, no token, no ETag, no signed URL, no raw response.
// All text fields are DATA: the screens must render them as text. This file builds no DOM and checks no permission (core/design-history.js does).
import { api, apiRaw } from "./api.js";
import { isId, safeOrigin } from "./versionpreview.js";

export { isId };
export const SITES = ["storefront", "admin"];
export const KINDS = ["change", "revert"];
export const STATUSES = ["drafting", "previewing", "awaiting_approval", "approved", "published", "rejected", "failed", "cancelled", "reverted"];
export const FLAGS = ["email", "phone", "card_like"];
export const EVENT_LIMIT = 100;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

const base = (shopID) => `/admin/shops/${shopID}/design`;

// The review basis (ETag, head and candidate sha) stays here. A later approve call reads it through reviewBasis(); the design layer never sees it.
const BASIS_MAX = 64;
const basis = new Map();
function remember(shopID, id, etag, d) {
  const key = `${shopID}:${id}`;
  basis.delete(key);
  basis.set(key, { etag: String(etag || ""), rev: d.rev, headSha: String(d.head_sha || ""), candidateSha: d.candidate_sha ? String(d.candidate_sha) : "" });
  while (basis.size > BASIS_MAX) basis.delete(basis.keys().next().value);
}
/** Core-internal: what the last read of this request saw. Not exported through ctx. */
export const reviewBasis = (shopID, id) => basis.get(`${shopID}:${id}`) || null;
/** Core-internal: forget everything (sign-out, tests). */
export const clearReviewBasis = () => basis.clear();

// query validation (before any request)
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
/** The list filter -> a query string, or null when any value is invalid. Only known keys are read. */
export function listQuery(f = {}) {
  const o = f && typeof f === "object" ? f : {};
  const page = o.page === undefined ? 1 : o.page;
  const pageSize = o.pageSize === undefined ? DEFAULT_PAGE_SIZE : o.pageSize;
  if (!intIn(page, 1, 10000) || !intIn(pageSize, 1, MAX_PAGE_SIZE)) return null;
  const p = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  for (const [key, allowed] of [["site", SITES], ["status", STATUSES], ["kind", KINDS]]) {
    const v = o[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v !== "string" || !allowed.includes(v)) return null;
    p.set(key, v);
  }
  return p.toString();
}
export const validSite = (v) => v === undefined || v === null || v === "" || SITES.includes(v);

// API calls
export const fetchRequests = (shopID, query) => api("GET", `${base(shopID)}/requests?${query}`);
export const fetchEvents = (shopID, id) => api("GET", `${base(shopID)}/requests/${id}/events?page=1&page_size=${EVENT_LIMIT}`);
export const fetchState = (shopID) => api("GET", `${base(shopID)}/state`);
/** Reads one request and remembers its ETag and shas inside this module. Returns the RAW body (normalize it before it leaves the core). */
export async function fetchRequest(shopID, id) {
  const { data, headers } = await apiRaw("GET", `${base(shopID)}/requests/${id}`);
  remember(shopID, id, headers && headers.get ? headers.get("ETag") : "", data || {});
  return data || {};
}

// normalize
const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const strOrNull = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : null);
const idOrNull = (v) => (isId(v) ? v : null);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const count = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), 1e9) : 0);
const date = (v) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : null);
const RULE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const sha = (v) => (typeof v === "string" && SHA_RE.test(v) ? v : "");
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,99}$/;
const tag = (v) => (typeof v === "string" && TAG_RE.test(v) ? v : "");
const ver = (v) => (typeof v === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(v) ? v : "");

/** A request in a list: no prompt text. `promptExcerpt` is plain text. Names are display names (never an email). */
export function normalizeSummary(d) {
  d = d && typeof d === "object" ? d : {};
  return {
    id: idOrNull(d.id) || "",
    site: oneOf(d.site, SITES, "storefront"),
    kind: oneOf(d.kind, KINDS, "change"),
    status: oneOf(d.status, STATUSES, "failed"),
    promptExcerpt: str(d.prompt_excerpt, 200),
    promptFlags: Array.isArray(d.prompt_flags) ? d.prompt_flags.filter((f) => FLAGS.includes(f)) : [],
    proposedByName: str(d.proposed_by_name, 120),
    approvedByName: strOrNull(d.approved_by_name, 120),
    rejectedByName: strOrNull(d.rejected_by_name, 120),
    isCurrent: d.is_current === true,
    revertTargetTag: tag(d.revert_target_tag) || null,
    publishedTag: tag(d.published_tag) || null,
    publishTag: tag(d.publish_tag) || null,
    headSha: sha(d.head_sha), candidateSha: sha(d.candidate_sha) || null, publishedSha: sha(d.published_sha) || null,
    approvedHeadSha: sha(d.approved_head_sha) || null,
    coreVersion: ver(d.core_version), designFloorVersion: ver(d.design_floor_version),
    restoresRequestId: idOrNull(d.restores_request_id), revertedByRequestId: idOrNull(d.reverted_by_request_id),
    failureCode: strOrNull(d.failure_code, 80),
    createdAt: date(d.created_at) || "", updatedAt: date(d.updated_at) || "",
    previewRegisteredAt: date(d.preview_registered_at), previewExpiresAt: date(d.preview_expires_at),
    approvedAt: date(d.approved_at), approvalExpiresAt: date(d.approval_expires_at), publishedAt: date(d.published_at),
  };
}

export function normalizePage(d) {
  d = d && typeof d === "object" ? d : {};
  const requests = (Array.isArray(d.requests) ? d.requests : []).slice(0, MAX_PAGE_SIZE).map(normalizeSummary).filter((r) => r.id);
  return { requests, page: count(d.page) || 1, pageSize: count(d.page_size) || DEFAULT_PAGE_SIZE, total: count(d.total) };
}

function normalizeDiff(d) {
  d = d && typeof d === "object" && !Array.isArray(d) ? d : {};
  const files = (Array.isArray(d.files) ? d.files : []).slice(0, 300).map((f) => ({
    path: str(f && f.path, 300), status: str(f && f.status, 20), additions: count(f && f.additions), deletions: count(f && f.deletions),
  })).filter((f) => f.path);
  return { filesChanged: count(d.files_changed), additions: count(d.additions), deletions: count(d.deletions), files };
}

/** The gatekeeper's verdict AS THE SERVICE CLAIMED it (not platform-verified). null when there is none. */
function normalizeGuard(g) {
  if (!g || typeof g !== "object" || Array.isArray(g)) return null;
  return {
    passed: g.passed === true,
    checkedSha: sha(g.checked_sha),
    ruleIds: Array.isArray(g.rule_ids) ? g.rule_ids.filter((x) => typeof x === "string" && RULE_RE.test(x)).slice(0, 50) : [],
    violationCount: count(g.violation_count),
    guardVersion: ver(g.guard_version),
    checkedAt: date(g.checked_at),
  };
}

export function normalizeEvent(e) {
  e = e && typeof e === "object" ? e : {};
  return {
    seq: count(e.seq), kind: str(e.kind, 60), fromStatus: str(e.from_status, 30), toStatus: str(e.to_status, 30),
    actorType: oneOf(e.actor_type, ["service", "user", "system"], "system"), actorName: strOrNull(e.actor_name, 120),
    headSha: sha(e.head_sha), createdAt: date(e.created_at) || "",
  };
}

/**
 * One request in full. Fields the service CLAIMS (promptText, headSha, diff, guard, previewOrigin) are separate from the platform's own
 * record (status, approver, approval time, approved sha, tag) so a screen can label them. `previewOrigin` only if it is a plain https origin.
 * promptText is already redacted by the platform and is null after retention. `events` (at most 100, ascending seq) is added by the core.
 */
export function normalizeRequest(d, events = []) {
  d = d && typeof d === "object" ? d : {};
  return {
    ...normalizeSummary(d),
    promptText: strOrNull(d.prompt_text, 20000),
    changeNote: strOrNull(d.change_note, 600),
    rejectReason: strOrNull(d.reject_reason, 600),
    failureDetail: strOrNull(d.failure_detail, 300),
    diff: normalizeDiff(d.diff_summary),
    guard: normalizeGuard(d.guard),
    previewOrigin: safeOrigin(d.preview_origin),
    previewReadOnly: true,
    rejectedAt: date(d.rejected_at),
    events: (Array.isArray(events) ? events : []).slice(0, EVENT_LIMIT).map(normalizeEvent),
  };
}

export function normalizeState(d, site) {
  d = d && typeof d === "object" ? d : {};
  const sites = (Array.isArray(d.sites) ? d.sites : []).map((s) => {
    s = s && typeof s === "object" ? s : {};
    return {
      site: oneOf(s.site, SITES, "storefront"),
      current: { requestId: idOrNull(s.current_request_id), tag: tag(s.current_tag), coreVersion: ver(s.core_version) },
      designFloorVersion: ver(s.design_floor_version),
      untracked: count(s.untracked_changes),
      pendingApproval: count(s.pending_approval_count),
      updatedAt: date(s.updated_at),
    };
  }).filter((s) => !site || s.site === site);
  const total = Number.isFinite(d.pending_approval_count) ? count(d.pending_approval_count) : sites.reduce((n, s) => n + s.pendingApproval, 0);
  return { sites, pendingApproval: site ? sites.reduce((n, s) => n + s.pendingApproval, 0) : total };
}
