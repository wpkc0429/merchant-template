// Content documents: the core's actions and the dry-run (everything the design layer can do with the platform
// content store). Each function checks its permission INSIDE, before any request, binds the current shop, validates
// with the locked schema logic (lib/content-schema.js) and maps API failures to ActionErrors:
//   412 -> ActionError kind "stale"  (someone else saved first: reload), 428 -> kind "internal" (a programming error, logged),
//   422 -> kind "invalid" with e.fields {JSON Pointer -> message}.
//
// REGISTERING A SCHEMA IS A HUMAN ACTION (docs/DECISIONS.md D6). registerContentSchema() takes NO arguments, always
// reads the same-origin content.schema.json itself, always runs a dry run first and always asks the human through a
// confirmation dialog (ask) that shows the report and the FIXED warning; nothing the design layer passes can skip
// it. The dry run (dryRunContentSchema) is read-only: it only ever sends `?dry_run=true`.
//
// The confirmation function is injected (core/actions.js passes its ask()) so scripts/test-content.mjs can prove
// that no registering request goes out unless the dialog resolved true.
import { session } from "../lib/session.js";
import * as content from "../lib/content.js";
import { validate, hasRemovals, reportLines, hydrate, mapServerDetails } from "../lib/content-schema.js";
import { mediaConfig, mediaEnabled, uploadContentImage as libUploadContentImage } from "../lib/upload.js";
import { t } from "../lib/design.js";
import { need } from "./guard.js";
import { ActionError, invalid, blocked, denied } from "./errors.js";

const S = () => session.shopID;
const CANCELLED = Object.freeze({ cancelled: true });
const keyOK = (key) => typeof key === "string" && content.KEY_RE.test(key);
const requireKey = (key) => { if (!keyOK(key)) throw new ActionError("state", t("err.404"), { reason: "gone", status: 404 }); };

/** ContentError (lib/content.js) -> the ActionError the screens understand. Anything else is returned untouched. */
export function toActionError(e, schemaNode) {
  if (!(e instanceof content.ContentError)) return e;
  switch (e.kind) {
    case "stale": {
      const a = new ActionError("stale", t("cf.err.stale"), { reason: "stale" });
      a.currentRev = e.currentRev;
      return a;
    }
    case "precondition_required":
      console.error("[content] 428 precondition_required: a save went out without If-Match / If-None-Match (programming error)");
      return new ActionError("internal", t("cf.err.internal"), { reason: "precondition_required" });
    case "invalid": {
      const fields = mapServerDetails(e.details, schemaNode);
      return invalid(Object.keys(fields).length ? fields : { "": t("err.422") });
    }
    case "forbidden": return denied();
    case "not_found": return new ActionError("state", t("err.404"), { reason: "gone", status: 404 });
    case "conflict": return new ActionError("state", e.code === "removals_require_confirmation" ? t("cf.err.removals") : t("cf.err.conflict"), { reason: "conflict" });
    case "rate_limited": return new ActionError("limit", t("err.429"), { reason: "rate_limited", status: 429 });
    default: return e.cause || e;
  }
}

const guarded = async (fn, schemaNode) => { try { return await fn(); } catch (e) { throw toActionError(e, schemaNode); } };

const SCHEMA_FILE_ERR = { bad_url: "cf.err.schemaFile.missing", missing: "cf.err.schemaFile.missing", network: "cf.err.schemaFile.missing", too_large: "cf.err.schemaFile.bad", not_json: "cf.err.schemaFile.bad" };
async function readSchemaFile() {
  try { return await content.readSchemaFile(content.schemaUrl()); } catch (e) {
    throw new ActionError("state", t(SCHEMA_FILE_ERR[e.code] || "cf.err.schemaFile.missing"), { reason: "schemaFile" });
  }
}

/** The schema node (JSON Schema) of a document's type in a registered schema; null when unknown. */
function typeNode(schemaDoc, typeKey) {
  const types = schemaDoc?.schema?.types;
  return (types && types[typeKey] && types[typeKey].schema) || null;
}

// ── dry run (READ-ONLY) ────────────────────────────────────────────────
/** Reads the storefront's schema file and asks the platform what registering it WOULD do. Writes nothing. */
export async function dryRunContentSchema() {
  need("content.manage");
  const doc = await readSchemaFile();
  const r = await guarded(() => content.putSchema(S(), doc, { dryRun: true }));
  return summarizeRegister(r);
}
const summarizeRegister = (r) => ({
  version: r.version, wouldRegisterVersion: r.would_register_version ?? 0, changed: Boolean(r.changed), dryRun: Boolean(r.dry_run),
  report: r.report || { documents: [] }, lines: reportLines(r.report), hasRemovals: hasRemovals(r.report),
});

/** Read-only helpers for core/data.js: every read goes through the same error mapping. */
export const reads = {
  schema: () => guarded(() => content.getSchema(S())),
  schemaVersions: () => guarded(() => content.listSchemaVersions(S())),
  documents: () => guarded(() => content.listDocuments(S())),
  document: (key) => { requireKey(key); return guarded(async () => { const d = await content.getDocument(S(), key); return { ...d, draft: d.schemaNode ? hydrate(d.schemaNode, d.draft) : d.draft }; }); },
  revisions: (key) => { requireKey(key); return guarded(() => content.listRevisions(S(), key)); },
  revision: (key, rev) => { requireKey(key); return guarded(() => content.getRevision(S(), key, Number(rev))); },
};

// ── actions ────────────────────────────────────────────────────────────
/** deps: { ask(key, params, opts) -> Promise<boolean> }. */
export function createContentActions({ ask }) {
  /**
   * values = the whole content object the form read (contentForm().read()). opts = {rev, create, typeKey, meta}.
   * Update needs the draft_rev the form was loaded with (sent as If-Match). Returns {ok, document}: the document AS THE
   * SERVER STORED IT; rebuild the form from doc.draft (rich text is rewritten by the server).
   */
  async function saveContentDocument(key, values, opts = {}) {
    need("content.edit");
    requireKey(key);
    const create = Boolean(opts.create);
    const rev = Number(opts.rev);
    if (!create && !(Number.isInteger(rev) && rev > 0)) throw new ActionError("internal", t("cf.err.internal"), { reason: "no_rev" });
    // The schema node comes from the platform (never from the screen), so a screen cannot loosen the validation.
    let node;
    if (create) {
      const typeKey = String(opts.typeKey || "");
      node = typeNode(await guarded(() => content.getSchema(S())), typeKey);
      if (!node) throw invalid({ "": t("cf.err.noType") });
    } else {
      const cur = await guarded(() => content.getDocument(S(), key));
      node = cur.schemaNode;
      if (!node) throw blocked("noType", t("cf.err.noType"));
    }
    const errors = validate(node, values, { root: node, imagePrefix: mediaConfig().public_base_url || "" });
    if (Object.keys(errors).length) throw invalid(errors);
    const doc = await guarded(() => content.saveDocument(S(), key, { content: values, ...(opts.meta !== undefined ? { meta: opts.meta } : {}), ...(create && opts.typeKey ? { typeKey: String(opts.typeKey) } : {}) }, { rev, create }), node);
    // The save response has no schema_node (only GET does): carry the node we validated with, so the screen can rebuild the form.
    return { ok: true, doc: { ...doc, schemaNode: doc.schemaNode || node, draft: hydrate(doc.schemaNode || node, doc.draft) } };
  }

  /** opts.rev = the draft_rev the person reviewed (If-Match). A document that needs attention cannot be published. */
  async function publishContentDocument(key, opts = {}) {
    need("content.publish");
    requireKey(key);
    const cur = await guarded(() => content.getDocument(S(), key));
    if (cur.needsAttention) throw blocked("needsAttention", t("cf.err.needsAttention"));
    if (!(await ask("confirm.publishContent", { key, title: cur.title || key }, { danger: false }))) return CANCELLED;
    const rev = Number.isInteger(Number(opts.rev)) && Number(opts.rev) > 0 ? Number(opts.rev) : cur.rev;
    const doc = await guarded(() => content.publishDocument(S(), key, rev), cur.schemaNode);
    return { ok: true, doc: doc };
  }

  async function unpublishContentDocument(key) {
    need("content.publish");
    requireKey(key);
    const cur = await guarded(() => content.getDocument(S(), key));
    if (!(await ask("confirm.unpublishContent", { key, title: cur.title || key }))) return CANCELLED;
    return { ok: true, doc: await guarded(() => content.unpublishDocument(S(), key)) };
  }

  async function deleteContentDocument(key) {
    need("content.publish");
    requireKey(key);
    const cur = await guarded(() => content.getDocument(S(), key));
    if (!(await ask("confirm.deleteContent", { key, title: cur.title || key }))) return CANCELLED;
    await guarded(() => content.deleteDocument(S(), key));
    return { ok: true };
  }

  /** Puts a revision back into the DRAFT. It never publishes: the result says so (restoredToDraft). */
  async function restoreContentRevision(key, rev, opts = {}) {
    need("content.edit");
    requireKey(key);
    const n = Number(rev);
    if (!Number.isInteger(n) || n < 1) throw invalid({ "": t("err.422") });
    if (!(await ask("confirm.restoreContent", { key, rev: n }))) return CANCELLED;
    const doc = await guarded(() => content.restoreRevision(S(), key, n, Number(opts.rev) || undefined));
    // The restore response has no schema_node either: re-read the document (also gives the ETag revision) for the screen.
    const fresh = await guarded(() => content.getDocument(S(), key));
    return { ok: true, restoredToDraft: true, restoredValid: doc.restoredValid !== false, doc: { ...fresh, draft: fresh.schemaNode ? hydrate(fresh.schemaNode, fresh.draft) : fresh.draft } };
  }

  /** file: a File picked in the form. Returns {url (the large variant: the field value), thumb, width, height}. */
  async function uploadContentImage(file, hooks) {
    need("content.edit");
    if (!mediaEnabled()) throw new ActionError("state", t("err.mediaOff"), { reason: "mediaOff", status: 503 });
    const r = await libUploadContentImage(S(), file, { onStage: hooks?.onStage, onProgress: hooks?.onProgress });
    return { url: r.urls?.large || "", thumb: r.urls?.thumb || "", width: r.width, height: r.height };
  }

  /**
   * Issues a short-lived preview token and opens {siteOrigin}/?content_preview=<token> in a new tab. The tab is opened
   * first (inside the click) so popup blockers allow it; the token only travels in that URL, never in storage.
   * Returns {opened: true} or {opened: false} when the browser refused the tab.
   */
  async function previewContentDocument(key, opts = {}) {
    need("content.view");
    requireKey(key);
    const origin = content.siteOrigin();
    if (!origin) throw new ActionError("state", t("cf.err.noSite"), { reason: "noSite" });
    const win = typeof window !== "undefined" && window.open ? window.open("about:blank", "_blank") : null;
    try {
      const tok = await guarded(() => content.createPreviewToken(S(), key, opts.scope === "shop" ? "shop" : "document"));
      if (!win) return { opened: false };
      try { win.opener = null; } catch { /* cross-origin already */ }
      win.location.href = `${origin}/?content_preview=${encodeURIComponent(tok.token)}`;
      return { opened: true, expiresIn: tok.expiresIn };
    } catch (e) { try { win && win.close(); } catch { /* ignore */ } throw e; }
  }

  /**
   * REGISTERS the storefront's content.schema.json as the shop's content schema. Takes no arguments (nothing a caller
   * passes can change what happens): reads the same-origin file, dry-runs it, shows the report in a confirmation dialog
   * with the core's fixed warning, and only after the human confirms sends the real PUT. When the platform answers
   * 409 removals_require_confirmation, a SECOND dialog shows that report and only then is confirm_removals sent.
   */
  async function registerContentSchema() {
    need("content.manage");
    const doc = await readSchemaFile();
    const dry = summarizeRegister(await guarded(() => content.putSchema(S(), doc, { dryRun: true })));
    if (!dry.changed) return { ok: true, unchanged: true, version: dry.version, report: dry.report, lines: dry.lines };
    const detail = dry.lines.length ? dry.lines.join("\n") : t("cf.report.none");
    if (!(await ask("confirm.registerContentSchema", { version: dry.wouldRegisterVersion }, { danger: dry.hasRemovals, detail }))) return CANCELLED;
    let res;
    try { res = await content.putSchema(S(), doc, {}); } catch (e) {
      if (!(e instanceof content.ContentError) || e.kind !== "confirm_removals") throw toActionError(e);
      const again = reportLines(e.report || dry.report);
      if (!(await ask("confirm.registerContentSchemaRemovals", { version: dry.wouldRegisterVersion }, { danger: true, detail: again.join("\n") || detail }))) return CANCELLED;
      res = await guarded(() => content.putSchema(S(), doc, { confirmRemovals: true }));
    }
    const sum = summarizeRegister(res);
    return { ok: true, version: sum.version, changed: sum.changed, report: sum.report, lines: sum.lines };
  }

  return { saveContentDocument, publishContentDocument, unpublishContentDocument, deleteContentDocument, restoreContentRevision, uploadContentImage, previewContentDocument, registerContentSchema };
}
