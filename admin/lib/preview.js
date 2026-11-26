// Preview mode of THIS page (CORE, locked). A preview host (a version preview or a change preview of the AI edit service)
// is deployed with `window.ADMIN_CONFIG.preview = {kind, tag, expiresAt}` written by deploy/ (preview-config.js); the design
// layer cannot set it. The value is read ONCE when this module loads and frozen, so nothing that runs later can switch it off.
// Fail closed: ANY non-empty value means preview mode. In preview mode every write-capable ctx.actions function is refused
// (core/actions.js) and lib/api.js refuses every non-GET request: the platform reports `read_only: true` on every preview
// (version previews) and `preview_read_only: true` on requests, and the service must deploy previews read-only.
// Fail closed on a missing config: a host that is not localhost always serves preview-config.js (config-loader.js loads it; the
// host writes `window.ADMIN_CONFIG.previewConfig = true` as the LAST statement of a complete file, and writes `preview = null` on a
// normal host). If that marker is missing the file did not load or did not run to its end (404, truncated, syntax error): this host
// may be a preview host whose config is lost, so the page is treated as a read-only preview with `configFailed: true` and the banner
// module stops the app (ui/preview-banner.js). localhost (dev, config.local.js) and test stubs without a location are exempt.
// It imports nothing.
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._/+-]{0,99}$/;

const LOCAL = ["localhost", "127.0.0.1", "[::1]"];
function configMissing() {
  try {
    if (typeof location === "undefined" || !location || typeof location.hostname !== "string") return false;
    if (LOCAL.includes(location.hostname)) return false;
    return !(typeof window !== "undefined" && window.ADMIN_CONFIG && window.ADMIN_CONFIG.previewConfig === true);
  } catch { return true; }
}

function snapshot() {
  let raw = null;
  try { raw = typeof window !== "undefined" && window.ADMIN_CONFIG ? window.ADMIN_CONFIG.preview : null; } catch { raw = null; }
  if (configMissing()) return Object.freeze({ kind: "version", tag: "", expiresAt: "", configFailed: true });
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
