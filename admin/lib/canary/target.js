// Isolation canary, NEGATIVE target (CORE, docs/DECISIONS.md D19). lib/canary/probe.js tries to import this file from INSIDE the probe's import-map scope,
// where the map sends everything except lib/canary/allowed/ok.js to /deny/ (a URL that always answers 404). If this file ever LOADS, the import map is not in
// effect (the CSP hash is missing or wrong, the browser ignores import maps, the map text was changed) and the design layer must stay off.
// It has no imports and no behaviour.
export default "canary-target-reached";
