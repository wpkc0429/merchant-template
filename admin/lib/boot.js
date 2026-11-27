// The boot-phase gate (CORE, docs/DECISIONS.md D19). It imports nothing.
//
// Some core modules own state or factories that must never be reachable from a design module (permissions, session mutators, the dialog
// primitives, the action factories). Such a module does NOT export them by name. It exports one `take...()` built with capability():
// the core calls it ONCE while it is being evaluated (the "boot phase"), keeps the result in a closure, and app.js calls sealBoot()
// (through sealApi() in lib/api.js) after every core module was evaluated and BEFORE the design layer is imported. From then on every
// take...() throws, so importing the module afterwards (which the import map in index.html already refuses a design module) yields nothing
// privileged. Same pattern as takeApi in lib/api.js.
let open = true;

/** A take-function for `value` that works only during the boot phase. */
export function capability(name, value) {
  return () => {
    if (!open) throw new Error(`${name} is sealed`);
    return value;
  };
}

/** Closes the boot phase. Irreversible; lib/api.js sealApi() calls it. */
export function sealBoot() { open = false; }
