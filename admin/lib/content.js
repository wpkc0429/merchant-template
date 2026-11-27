// Content documents API (change headless-content-store): schema read, documents, revisions, preview token.
// Contract: ecommerce docs/content-store.md, docs/content-schema.md and api/openapi/openapi.yaml.
// All URLs, the ETag / If-Match / If-None-Match handling and the error classification live here; views never build paths.
//
// Optimistic lock: a document has `draft_rev` (also the response header `ETag: "<draft_rev>"`).
//   update  -> PUT with `If-Match: "<rev>"`        mismatch: 412 precondition_failed (details.current_rev)
//   create  -> PUT with `If-None-Match: *`         key exists: 412
//   neither -> 428 precondition_required           (a programming error here: we always send one)
// Failures are thrown as ContentError with a `kind` the core turns into a localized ActionError.
import { takeApi, ApiError } from "./api.js";

const { api, apiRaw } = takeApi(); // boot phase only (lib/api.js)

const base = (shopID) => `/admin/shops/${shopID}/content`;
const docPath = (shopID, key) => `${base(shopID)}/documents/${encodeURIComponent(key)}`;
const cfg = () => (typeof window !== "undefined" && window.ADMIN_CONFIG) || {};
/** The storefront origin for the preview tab (ADMIN_CONFIG.siteOrigin, injected by the host or config.local.js). "" = not configured. */
export function siteOrigin() {
  try { const u = new URL(String(cfg().siteOrigin || "")); return /^https?:$/.test(u.protocol) ? u.origin : ""; } catch { return ""; }
}
/** Same-origin path of the storefront's content.schema.json (default /content.schema.json). Anything else is ignored. */
export function schemaUrl() {
  const u = String(cfg().contentSchemaUrl || "/content.schema.json");
  return u.startsWith("/") && !u.startsWith("//") ? u : "/content.schema.json";
}
export const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class ContentError extends Error {
  /** kind: stale | precondition_required | invalid | confirm_removals | not_found | forbidden | conflict | rate_limited | other */
  constructor(kind, cause, extra = {}) {
    super(cause?.message || kind);
    this.name = "ContentError";
    this.kind = kind;
    this.status = cause?.status ?? 0;
    this.code = cause?.code || "";
    this.cause = cause;
    this.currentRev = extra.currentRev ?? null;
    this.details = extra.details || [];
    this.report = extra.report || null;
  }
}

/** Classifies an ApiError (anything else is rethrown untouched: a network failure is not a content error). */
export function classify(err) {
  if (!(err instanceof ApiError)) return err;
  const raw = err.body?.error?.details;
  const obj = raw && !Array.isArray(raw) && typeof raw === "object" ? raw : {};
  if (err.status === 412) return new ContentError("stale", err, { currentRev: Number.isFinite(Number(obj.current_rev)) ? Number(obj.current_rev) : null });
  if (err.status === 428) return new ContentError("precondition_required", err);
  if (err.status === 422) return new ContentError("invalid", err, { details: Array.isArray(raw) ? raw : [] });
  if (err.status === 409 && err.code === "removals_require_confirmation") return new ContentError("confirm_removals", err, { report: obj.report || null });
  if (err.status === 409) return new ContentError("conflict", err);
  if (err.status === 404) return new ContentError("not_found", err);
  if (err.status === 403) return new ContentError("forbidden", err);
  if (err.status === 429) return new ContentError("rate_limited", err);
  return new ContentError("other", err);
}
const wrap = async (p) => { try { return await p; } catch (e) { throw classify(e); } };

// ── ETag helpers ───────────────────────────────────────────────────────
/** `"3"` or `W/"3"` -> 3, anything else -> null. */
export function parseEtag(value) {
  const m = /^(?:W\/)?"(\d+)"$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) : null;
}
/** The header value for a revision: `"3"` (quoted, as the platform requires). */
export const etagOf = (rev) => `"${Number(rev)}"`;

// ── Normalisation (API snake_case -> the shape the screens use) ────────
export function normalizeSummary(d) {
  return {
    key: d.key, type: d.type_key, title: d.title || "", status: d.status, isPublished: d.status === 1,
    needsAttention: Boolean(d.needs_attention), declared: d.declared !== false,
    rev: d.draft_rev, publishedRev: d.published_rev, schemaVersion: d.schema_version, publishedSchemaVersion: d.published_schema_version,
    updatedAt: d.updated_at, publishedAt: d.published_at || null,
  };
}
export function normalizeDocument(d, etagHeader) {
  const fromHeader = parseEtag(etagHeader);
  return {
    ...normalizeSummary(d),
    rev: fromHeader ?? d.draft_rev,
    typeTitle: d.type_title || "",
    draft: d.draft || {}, published: d.published ?? null, meta: d.meta || {},
    schemaNode: d.schema_node ?? null,
    restoredValid: d.restored_valid,
  };
}

// ── Schema ─────────────────────────────────────────────────────────────
/** The active (or given) schema version: {version, format, sha256, createdAt, schema}; null when none is registered. */
export async function getSchema(shopID, version) {
  try {
    const q = version ? `?version=${Number(version)}` : "";
    const d = await api("GET", `${base(shopID)}/schema${q}`);
    return { version: d.version, format: d.format, sha256: d.sha256, source: d.source, createdAt: d.created_at, schema: d.schema };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw classify(e);
  }
}
export async function listSchemaVersions(shopID) {
  try { return (await api("GET", `${base(shopID)}/schema/versions`)).versions || []; } catch (e) {
    if (e instanceof ApiError && e.status === 404) return [];
    throw classify(e);
  }
}
/**
 * PUT the schema document. dryRun=true writes NOTHING (report only). Without dryRun this REGISTERS the schema;
 * only core/content-actions.js (behind the human confirmation dialog) calls it that way.
 */
export function putSchema(shopID, doc, { dryRun = false, confirmRemovals = false } = {}) {
  const p = new URLSearchParams();
  if (dryRun) p.set("dry_run", "true");
  if (confirmRemovals && !dryRun) p.set("confirm_removals", "true");
  const q = p.toString();
  return wrap(api("PUT", `${base(shopID)}/schema${q ? `?${q}` : ""}`, doc));
}

/** Reads the storefront's content.schema.json from the SAME origin (relative URL only). Throws an Error with .code. */
export async function readSchemaFile(url) {
  const u = String(url || "");
  if (!u.startsWith("/") || u.startsWith("//")) throw Object.assign(new Error("schema URL must be a same-origin path"), { code: "bad_url" });
  let res;
  try { res = await fetch(u, { headers: { Accept: "application/json" }, cache: "no-store", credentials: "same-origin" }); } catch { throw Object.assign(new Error("network"), { code: "network" }); }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: "missing" });
  const text = await res.text();
  if (text.length > 128 * 1024) throw Object.assign(new Error("too large"), { code: "too_large" });
  try { return JSON.parse(text); } catch { throw Object.assign(new Error("not JSON"), { code: "not_json" }); }
}

// ── Documents ──────────────────────────────────────────────────────────
export async function listDocuments(shopID) {
  try { return ((await api("GET", `${base(shopID)}/documents`)).documents || []).map(normalizeSummary); } catch (e) { throw classify(e); }
}
export async function getDocument(shopID, key) {
  try { const r = await apiRaw("GET", docPath(shopID, key)); return normalizeDocument(r.data, r.headers.get("ETag")); } catch (e) { throw classify(e); }
}
/**
 * Saves a draft. `rev` is the draft_rev the form was loaded with (If-Match); `create: true` sends If-None-Match: * instead.
 * Never sends without a precondition. Returns the document AS THE SERVER STORED IT (rich text is rewritten).
 * body: {content, meta?, title?, typeKey?}.
 */
export async function saveDocument(shopID, key, body, { rev, create = false } = {}) {
  if (!create && !(Number.isInteger(rev) && rev > 0)) throw new Error("saveDocument: a draft revision is required to update (If-Match)");
  const headers = create ? { "If-None-Match": "*" } : { "If-Match": etagOf(rev) };
  const payload = { content: body.content };
  if (body.meta !== undefined) payload.meta = body.meta;
  if (body.title !== undefined) payload.title = body.title;
  if (create && body.typeKey) payload.type_key = body.typeKey;
  try { const r = await apiRaw("PUT", docPath(shopID, key), payload, headers); return normalizeDocument(r.data, r.headers.get("ETag")); } catch (e) { throw classify(e); }
}
export async function publishDocument(shopID, key, rev) {
  const headers = Number.isInteger(rev) && rev > 0 ? { "If-Match": etagOf(rev) } : undefined;
  try { const r = await apiRaw("POST", `${docPath(shopID, key)}/publish`, {}, headers); return normalizeSummary(r.data); } catch (e) { throw classify(e); }
}
export async function unpublishDocument(shopID, key) {
  try { return normalizeSummary(await api("POST", `${docPath(shopID, key)}/unpublish`, {})); } catch (e) { throw classify(e); }
}
export async function deleteDocument(shopID, key) {
  try { await api("DELETE", docPath(shopID, key)); return { ok: true }; } catch (e) { throw classify(e); }
}

// ── Revisions ──────────────────────────────────────────────────────────
const normRevInfo = (r) => ({ rev: r.rev_no, kind: r.kind, title: r.title || "", schemaVersion: r.schema_version, actorUserId: r.actor_user_id ?? null, createdAt: r.created_at });
export async function listRevisions(shopID, key) {
  try { return ((await api("GET", `${docPath(shopID, key)}/revisions`)).revisions || []).map(normRevInfo); } catch (e) { throw classify(e); }
}
export async function getRevision(shopID, key, rev) {
  try {
    const r = await api("GET", `${docPath(shopID, key)}/revisions/${Number(rev)}`);
    return { ...normRevInfo(r), content: r.content || {}, publishedContent: r.published_content ?? null, meta: r.meta || {} };
  } catch (e) { throw classify(e); }
}
/** Puts a revision back into the DRAFT (never publishes). `ifRev` = the draft_rev the screen showed (If-Match, optional). */
export async function restoreRevision(shopID, key, rev, ifRev) {
  const headers = Number.isInteger(ifRev) && ifRev > 0 ? { "If-Match": etagOf(ifRev) } : undefined;
  try { const r = await apiRaw("POST", `${docPath(shopID, key)}/revisions/${Number(rev)}/restore`, {}, headers); return normalizeDocument(r.data, r.headers.get("ETag")); } catch (e) { throw classify(e); }
}

// ── Preview ────────────────────────────────────────────────────────────
export async function createPreviewToken(shopID, key, scope = "document") {
  try {
    const r = await api("POST", `${docPath(shopID, key)}/preview-token`, { scope });
    return { token: r.preview_token, expiresIn: r.expires_in, scope: r.scope, key: r.key };
  } catch (e) { throw classify(e); }
}
