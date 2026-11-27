// Isolation canary, POSITIVE control (CORE, docs/DECISIONS.md D19). lib/canary/probe.js imports this file and it MUST load: the import map in
// index.html maps it to itself inside the probe's scope. If it does not load, something other than the isolation is wrong (network, server), and the
// probe reports "not isolated" so the design layer stays off. It has no imports and no behaviour.
export default "canary-ok";
