// Spelling helpers for the scanner regression fixtures and the fuzz test (decision D17). Everything is built with
// String.fromCharCode / String.raw-free code on purpose, so no source line here contains an escape sequence the editor or a
// tool could silently turn into the real character.
export const BS = String.fromCharCode(92); // the backslash
export const LS = String.fromCharCode(0x2028); // line separator
export const PS = String.fromCharCode(0x2029); // paragraph separator
export const NBSP = String.fromCharCode(0xa0);
export const BOM = String.fromCharCode(0xfeff);
export const ZWJ = String.fromCharCode(0x200d);
export const ZWNJ = String.fromCharCode(0x200c);

const hex = (cp, min = 4) => cp.toString(16).padStart(min, "0");
/** \uXXXX (or \u{...} when brace is true) for one character of an identifier. */
export const uEsc = (ch, brace = false) => BS + "u" + (brace ? "{" + hex(ch.codePointAt(0), 1) + "}" : hex(ch.codePointAt(0)));
/** Identifier spelling with escapes: `which` = "all" | "first" | "last" | "mid" (every other char) | an array of indexes; brace picks \u{..}. */
export function idEsc(name, which = "all", brace = false) {
  const chars = [...name];
  const pick = (i) => which === "all" || (which === "first" && i === 0) || (which === "last" && i === chars.length - 1) || (which === "mid" && i % 2 === 1) || (Array.isArray(which) && which.includes(i));
  return chars.map((c, i) => (pick(i) ? uEsc(c, brace) : c)).join("");
}
/** String-literal body spelling: kind "x" (\xHH), "u" (\uHHHH), "brace" (\u{..}), "octal" (\ooo), "mixed" cycles through them. */
export function strEsc(s, kind = "u", which = "all") {
  const chars = [...s];
  const kinds = ["x", "u", "brace", "octal"];
  return chars.map((c, i) => {
    const on = which === "all" || (which === "first" && i === 0) || (which === "mid" && i % 2 === 1) || (Array.isArray(which) && which.includes(i));
    if (!on) return c;
    const k = kind === "mixed" ? kinds[i % 4] : kind, cp = c.codePointAt(0);
    if (k === "x" && cp < 256) return BS + "x" + hex(cp, 2);
    if (k === "octal" && cp < 256) return BS + cp.toString(8).padStart(3, "0");
    if (k === "brace") return BS + "u{" + hex(cp, 1) + "}";
    return BS + "u" + hex(cp);
  }).join("");
}
