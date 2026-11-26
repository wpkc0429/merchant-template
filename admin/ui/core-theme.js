// The theme of the CORE dialogs, as PURE logic (no DOM): which of the design's tokens are accepted and what palette the dialogs are painted with.
// ui/kit.js reads the design tokens (getComputedStyle on the host, colours normalised through a probe element) and calls resolveTheme(); the
// result is a set of LITERAL values that ui/core-dialog-css.js substitutes straight into the dialog's stylesheet. Nothing the design can influence
// (custom properties, @property registrations, inheritance) takes part in the final painting: a token that is missing, registered with an
// incompatible syntax (so it reads as an initial value such as 0px) or hostile simply reads as invalid and the default is used.
//
// Accepted tokens (all others are ignored): --ink + --card (opaque, contrast >= 7:1 together, else both default), --brand-primary, --error,
// --accent (opaque; a colour that is too close to the card is NOT dropped but moved along its own hue, in lightness, to the nearest shade that
// passes: >= 3:1 against the card, and for the two button colours also >= 4.5:1 for the automatically chosen white or black label), --r-sm and
// --r-lg (px, at most 24 and 28), --f-sans (honoured only as a generic keyword: a named font may be a design-supplied @font-face).
// Muted and secondary text are solid ink-derived colours that pass 4.5:1 on BOTH the card and the tinted band. On a dark card the default red is
// lightened along its hue until it reads (>= 3:1), so a destructive button still looks destructive.
export const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** `a` weighted t (0..1) over `b`, rounded to integers (an sRGB mix, like color-mix(in srgb)). */
export const mix = (a, b, t) => a.map((v, i) => Math.round(v * t + b[i] * (1 - t)));
export const GENERIC_FONTS = Object.freeze(["serif", "sans-serif", "system-ui", "monospace", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded"]);
export const DEFAULTS = Object.freeze({ ink: [28, 28, 30], card: [255, 255, 255], prim: [28, 28, 30], err: [179, 38, 30], acc: [47, 93, 138], rsm: "8px", rlg: "16px", font: "system-ui, sans-serif" });

function toHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function fromHsl([h, s, l]) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m].map((v) => Math.max(0, Math.min(255, Math.round(v * 255))));
}
/** The label colour (white or black) for a button background, or null when neither reaches 4.5:1. */
export const labelFor = (bg) => { const w = [255, 255, 255], k = [0, 0, 0], best = contrast(w, bg) >= contrast(k, bg) ? w : k; return contrast(best, bg) >= 4.5 ? best : null; };
/** `c` itself when it passes `ok`, else the nearest shade of the same hue (HSL lightness moved away from the card), else null. */
function fit(c, card, ok) {
  if (ok(c)) return c;
  const [h, s, l] = toHsl(c);
  const dir = lum(card) > 0.4 ? -1 : 1; // light card: darken; dark card: lighten
  for (let i = 1; i <= 100; i++) {
    const cand = fromHsl([h, s, Math.max(0, Math.min(1, l + dir * i / 100))]);
    if (ok(cand)) return cand;
  }
  return null;
}

/**
 * read = { color(name) -> [r,g,b] | null  (opaque colour of the token, null when absent / invalid / not opaque), raw(name) -> trimmed string }
 * Returns the palette of literal values (arrays are [r, g, b]).
 */
export function resolveTheme(read) {
  let ink = DEFAULTS.ink, card = DEFAULTS.card;
  const ci = read.color("--ink"), cc = read.color("--card");
  if ((ci || cc) && contrast(ci || DEFAULTS.ink, cc || DEFAULTS.card) >= 7) { ink = ci || DEFAULTS.ink; card = cc || DEFAULTS.card; }
  else if (contrast(DEFAULTS.ink, card) < 7) card = DEFAULTS.card;
  const against = (c) => contrast(c, card) >= 3;
  const button = (c) => against(c) && labelFor(c) !== null;
  const buttonColor = (custom, def) => {
    for (const c of [custom, def]) { if (!c) continue; const f = fit(c, card, button); if (f) return f; }
    return fit(ink, card, button) || ink;
  };
  const prim = buttonColor(read.color("--brand-primary"), DEFAULTS.prim);
  const err = buttonColor(read.color("--error"), DEFAULTS.err);
  let acc = null;
  for (const c of [read.color("--accent"), DEFAULTS.acc]) { if (!c) continue; acc = fit(c, card, against); if (acc) break; }
  acc = acc || ink;
  const px = (n, max) => { const m = /^(\d{1,2}(?:\.\d+)?)px$/.exec(read.raw(n)); return m && Number(m[1]) <= max ? m[1] + "px" : null; };
  const f = read.raw("--f-sans").toLowerCase();
  const band = mix(ink, card, 0.08);
  // secondary text: the weakest ink mix that reaches 4.5:1 on the card AND on the band
  const text = (start) => { for (let t = start; t <= 1.0001; t += 0.02) { const c = mix(ink, card, Math.min(t, 1)); if (contrast(c, card) >= 4.5 && contrast(c, band) >= 4.5) return c; } return ink; };
  let warnbg = mix(err, card, 0.09);
  if (contrast(ink, warnbg) < 4.5) warnbg = band;
  return {
    ink, card, band, soft: text(0.85), muted: text(0.7), line: mix(ink, card, 0.22), edge: mix(ink, card, 0.48), warnbg, errline: mix(err, card, 0.45),
    prim, primText: labelFor(prim), err, errText: labelFor(err), acc,
    rsm: px("--r-sm", 24) || DEFAULTS.rsm, rlg: px("--r-lg", 28) || DEFAULTS.rlg, font: GENERIC_FONTS.includes(f) ? f : DEFAULTS.font,
  };
}
