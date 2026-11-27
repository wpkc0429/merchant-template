// The signed-in person's own DISPLAY NAME (CORE, docs/DECISIONS.md D21). The name teammates see in the design history instead of an email.
//   GET   /admin/me                 -> {..., display_name: string | null}
//   PATCH /admin/me {display_name}  -> {id, display_name}     "" (or null) clears; 422 for an email, a phone number, a card-like number, a line break or > 80 characters
// Three things live here, and nothing of it is reachable from the design layer (no ctx function; the import map of D19 refuses design modules this file):
//   1. the validation, a faithful mirror of the platform's design.CleanDisplayName (the platform stays the authority; this only saves a round trip and gives a calm message),
//   2. the API calls, which are NOT exported by name: they sit behind a boot-phase capability (takeProfileApi), like the API client itself (D18, D19),
//   3. what the shell needs to know: does this person have a name yet, and was the one-time hint dismissed (sessionStorage, a bare marker: no name, no token, no id).
// No logging of any value here or in the callers: a display name is personal data.
import { takeApi } from "./api.js";
import { capability } from "./boot.js";

const { api } = takeApi(); // boot phase only (lib/api.js)

export const NAME_MAX = 80;

// ── validation ─────────────────────────────────────────────────────────
// SanitizeText of the platform: control characters (Unicode Cc) are dropped except newline and tab, as are the bidirectional overrides and isolates and the implicit direction marks.
const DROP = new RegExp("[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]", "g");
// Go's strings.TrimSpace (unicode.IsSpace), not JavaScript's trim() (which also strips U+FEFF and keeps U+0085).
const SPACE = "\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000";
const EDGE = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "g");
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const DIGIT_RUN = /\+?\d(?:[ -]?\d)*/g;
const PHONE = /^(?:09\d{8}|\+?8869\d{8})$/;

/** The text as the platform stores it: unwanted characters dropped, edges trimmed. */
export const cleanName = (s) => String(s).replace(DROP, "").replace(EDGE, "");
/** Length in characters (code points), as the platform counts. */
export const nameLength = (s) => { let n = 0; for (const _ of String(s)) n++; return n; }; // eslint-disable-line no-unused-vars

function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}
function classifyDigits(m) {
  const digits = m.replace(/[^0-9]/g, "");
  if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return "card_like";
  if (PHONE.test(m.replace(/[ -]/g, ""))) return "phone";
  return "";
}
/** The classes of personal data the platform would redact in `s` (design.RedactPII), in the platform's order: "email", "phone", "card_like". */
export function piiFlags(s) {
  const flags = new Set();
  let v = String(s).replace(EMAIL, () => { flags.add("email"); return "[redacted]"; });
  v = v.replace(DIGIT_RUN, (m) => {
    const c = classifyDigits(m);
    if (c) { flags.add(c); return "[redacted]"; }
    if (!m.includes(" ")) return m;
    return m.split(" ").map((p) => { const k = classifyDigits(p); if (k) { flags.add(k); return "[redacted]"; } return p; }).join(" ");
  });
  return ["email", "phone", "card_like"].filter((f) => flags.has(f));
}

/**
 * The platform's rules for a display name, in the platform's order. Returns
 *   {ok: true, value}                       value is what to send ("" clears the name)
 *   {ok: false, code, value, length}        code: "too_long" | "multiline" | "email" | "phone" | "card_like" | "type"
 * `raw` null / undefined counts as empty (clear).
 */
export function validateDisplayName(raw) {
  if (raw === null || raw === undefined) return { ok: true, value: "" };
  if (typeof raw !== "string") return { ok: false, code: "type", value: "", length: 0 };
  const value = cleanName(raw);
  const length = nameLength(value);
  if (length > NAME_MAX) return { ok: false, code: "too_long", value, length };
  if (/[\r\n\t]/.test(value)) return { ok: false, code: "multiline", value, length };
  const flags = piiFlags(value);
  if (flags.length) return { ok: false, code: flags[0], value, length };
  return { ok: true, value };
}

// ── what the shell needs to know ───────────────────────────────────────
// `known` is true only when the platform answered with a display_name field (a string or null): an older platform without the field leaves it unknown and the hint stays away.
let known = false;
let name = "";
/** Remembers what GET /admin/me or a save said. Anything that is not a string or null counts as unknown. */
export function noteDisplayName(v) {
  if (typeof v === "string") { known = true; name = cleanName(v); } else if (v === null) { known = true; name = ""; } else { known = false; name = ""; }
}
export const hasDisplayName = () => known && name !== "";
/** True when the platform said this person has NO name yet. */
export const lacksDisplayName = () => known && name === "";

const HINT_KEY = "admin.hint.profile";
let hintMemory = false; // when sessionStorage is not usable
export function hintDismissed() {
  if (hintMemory) return true;
  try { return sessionStorage.getItem(HINT_KEY) === "1"; } catch { return false; }
}
export function dismissHint() {
  hintMemory = true;
  try { sessionStorage.setItem(HINT_KEY, "1"); } catch { /* memory only */ }
}
/** Sign-out, session loss, user change: nothing about the previous person survives (lib/session.js calls it). */
export function clearProfile() {
  known = false; name = ""; hintMemory = false;
  try { sessionStorage.removeItem(HINT_KEY); } catch { /* ignore */ }
}

// ── the API calls (boot-phase capability) ──────────────────────────────
const fromApi = (v) => (typeof v === "string" ? cleanName(v) : "");
async function loadMe() {
  const d = await api("GET", "/admin/me");
  const v = d && typeof d === "object" ? d.display_name : undefined;
  noteDisplayName(v);
  return fromApi(v);
}
/** `value` has passed validateDisplayName; "" clears. Resolves to the name the platform stored ("" when cleared). */
async function saveName(value) {
  const d = await api("PATCH", "/admin/me", { display_name: value });
  const stored = d && typeof d === "object" && Object.hasOwn(d, "display_name") ? fromApi(d.display_name) : value;
  noteDisplayName(stored === "" ? null : stored);
  return stored;
}
/** Boot phase only (lib/boot.js, D19): core/profile.js takes it once. After the seal nothing can read or change a display name through here. */
export const takeProfileApi = capability("profile api", Object.freeze({ loadMe, saveName }));
