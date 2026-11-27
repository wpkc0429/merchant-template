// The personal profile (CORE, docs/DECISIONS.md D21): the page where each signed-in person sets their own display name, and the one-time hint
// above the design history. Both are CORE-OWNED: no ctx function, no route id the design layer can map a view to, no copy key (the wording is
// in lib/fixed-text.js). This module is the controller; ui/profile.js draws. The API calls come from the boot-phase capability of lib/profile.js.
import { ApiError } from "../lib/api.js";
import { takeProfileApi, validateDisplayName, NAME_MAX, nameLength, hintDismissed, dismissHint, lacksDisplayName } from "../lib/profile.js";
import { isReadOnly } from "../lib/preview.js";
import { can } from "../lib/perm.js";
import { coreText } from "../lib/fixed-text.js";
import { t } from "../lib/design.js";
import { ActionError } from "./errors.js";
import { profilePage, profileHint } from "../ui/profile.js";

const { loadMe, saveName } = takeProfileApi(); // boot phase only (lib/boot.js, D19)

const fail = (message, reason, status) => new ActionError("state", message, { reason, status });
/** An API or network failure -> an ActionError with calm fixed wording. The platform's own message, the request and the value never leave here. */
export function friendly(e, what = "save") {
  const load = what === "load";
  if (e && e.isActionError) return e;
  if (!(e instanceof ApiError)) return fail(coreText(load ? "pf.err.load" : "pf.err.network"), "network", 0);
  if (e.status === 401) return fail(t("err.401"), "unauthorized", 401);
  if (e.status === 403) return fail(e.code === "preview_read_only" || e.code === "read_only" ? coreText("pv.readOnly") : t("err.403"), "denied", 403);
  if (e.status === 422 && !load) return fail(coreText("pf.err.rejected"), "invalid", 422);
  if (e.status === 429) return fail(t("err.429Wait", { minutes: Math.max(1, Math.ceil((e.retryAfter || 60) / 60)) }), "rate_limited", 429);
  if (e.status >= 500) return fail(coreText(load ? "pf.err.load" : "pf.err.server"), "server_error", e.status);
  return fail(coreText(load ? "pf.err.load" : "pf.err.generic"), "error", e.status);
}

/** The message for a failed validation (validateDisplayName). */
export const validationMessage = (r) => coreText(`pf.err.${["too_long", "multiline", "email", "phone", "card_like"].includes(r.code) ? r.code : "type"}`, { n: r.length, max: NAME_MAX });

/** What the page needs from the core. `alive` says whether the route is still the current one. */
export const controller = (alive) => Object.freeze({
  readOnly: isReadOnly(),
  max: NAME_MAX,
  alive,
  length: (raw) => (typeof raw === "string" ? nameLength(validateDisplayName(raw).value) : 0),
  validate: (raw) => { const r = validateDisplayName(raw); return r.ok ? { ok: true, value: r.value } : { ok: false, code: r.code, message: validationMessage(r) }; },
  load: async () => { try { return await loadMe(); } catch (e) { throw friendly(e, "load"); } },
  save: async (raw) => {
    if (isReadOnly()) throw fail(coreText("pv.readOnly"), "read_only", 403); // nothing is sent from a preview host
    const r = validateDisplayName(raw); // the platform checks again; this is the same rule
    if (!r.ok) throw fail(validationMessage(r), "invalid", 422);
    try { return await saveName(r.value); } catch (e) { throw friendly(e, "save"); }
  },
});

/** The profile page element (it loads itself). */
export const mountProfile = (alive = () => true) => profilePage(controller(alive));

/** The one-time hint for the design history screens, or null. Shown only to a person with design.view whom the platform says has no name yet. */
export function designHint(onGone) {
  if (isReadOnly() || !can("design.view") || !lacksDisplayName() || hintDismissed()) return null;
  return profileHint({ onDismiss: () => { dismissHint(); if (onGone) onGone(); } });
}
