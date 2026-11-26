// Preview mode of THIS page (CORE, locked). A preview host (a version preview or a change preview of the AI edit service)
// is deployed with `window.ADMIN_CONFIG.preview = {kind, tag, expiresAt}` written by deploy/ (preview-config.js); the design
// layer cannot set it. The value is read ONCE when this module loads and frozen, so nothing that runs later can switch it off.
// Fail closed: ANY non-empty value means preview mode. In preview mode every write-capable ctx.actions function is refused
// (core/actions.js) and lib/api.js refuses every non-GET request: the platform reports `read_only: true` on every preview
// (version previews) and `preview_read_only: true` on requests, and the service must deploy previews read-only.
// It imports nothing.
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,99}$/;

function snapshot() {
  let raw = null;
  try { raw = typeof window !== "undefined" && window.ADMIN_CONFIG ? window.ADMIN_CONFIG.preview : null; } catch { raw = null; }
  if (raw === null || raw === undefined || raw === false || raw === 0 || raw === "") return null;
  const o = raw && typeof raw === "object" ? raw : {};
  const t = Date.parse(String(o.expiresAt || ""));
  return Object.freeze({
    kind: o.kind === "change" ? "change" : "version",
    tag: typeof o.tag === "string" && TAG_RE.test(o.tag) ? o.tag : "",
    expiresAt: Number.isFinite(t) ? new Date(t).toISOString() : "",
  });
}

/** null (a normal page) or {kind: "version"|"change", tag, expiresAt}; frozen. */
export const previewMode = snapshot();
/** True on a preview host: no write may go out. */
export const isReadOnly = () => previewMode !== null;
