import { can } from "../lib/perm.js";
import { isReadOnly } from "../lib/preview.js";
import { t } from "../lib/design.js";
import { denied, ActionError } from "./errors.js";

/** Throws a 403-style ActionError unless every node is granted. The check happens BEFORE any request. */
export function need(...nodes) {
  if (!can(...nodes)) throw denied();
}

/** The error every write-capable action throws on a preview host (lib/preview.js): read-only, nothing was sent. */
export const readOnlyError = () => new ActionError("state", t("err.readOnly"), { reason: "read_only", status: 403 });

/**
 * Wraps every function of an action table so that, in preview mode, it throws readOnlyError() BEFORE anything else (permission
 * check, confirmation dialog, request). The wrapper is applied by core/actions.js to the whole table, so a new action cannot be
 * forgotten and the design layer cannot opt out.
 */
export function readOnlyGuarded(table) {
  const out = {};
  for (const [name, fn] of Object.entries(table)) {
    out[name] = async (...args) => { if (isReadOnly()) throw readOnlyError(); return fn(...args); };
  }
  return Object.freeze(out);
}
