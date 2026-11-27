// The calm note shown when the design layer is switched off because the isolation could not be verified (CORE, D19). It is drawn by the core outside #app,
// with fixed wording (lib/fixed-text.js, no copy key). It is a courtesy for the owner, not a security control: nothing depends on it staying visible.
import { coreText } from "../lib/fixed-text.js";

export function showIsolationNotice() {
  if (document.getElementById("core-isolation-note")) return;
  const el = document.createElement("div");
  el.id = "core-isolation-note";
  el.setAttribute("role", "status");
  el.textContent = coreText("iso.disabled");
  const set = { display: "block", padding: "0.5rem 1rem", background: "#f4f1ea", color: "#3d3a33", "border-bottom": "1px solid #d8d2c4", font: "14px/1.5 system-ui, sans-serif", "text-align": "center" };
  for (const [k, v] of Object.entries(set)) el.style.setProperty(k, v, "important"); // CSSOM: allowed by style-src 'self'
  document.body.prepend(el);
}
