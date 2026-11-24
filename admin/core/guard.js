import { can } from "../lib/perm.js";
import { denied } from "./errors.js";

/** Throws a 403-style ActionError unless every node is granted. The check happens BEFORE any request. */
export function need(...nodes) {
  if (!can(...nodes)) throw denied();
}
