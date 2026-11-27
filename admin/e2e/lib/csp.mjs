// TEST-ONLY helper shared by the browser suites that serve index.html under the production CSP. The CSP of admin/deploy/nginx.conf.template allows ONE inline
// script through a hash (decision D19): the import map in index.html. The suites compute that hash from the file they serve, so they run the same policy
// the guard verifies in the template (scripts/check-design.mjs). Without the hash the browser ignores the import map and the app switches the design layer off.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importMapHash } from "../../scripts/check-design.mjs";

const ADMIN = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const MAP_HASH = importMapHash(readFileSync(resolve(ADMIN, "index.html"), "utf8"));
/** The script-src directive of the production policy. */
export const SCRIPT_SRC = `script-src 'self' 'sha256-${MAP_HASH}'`;
