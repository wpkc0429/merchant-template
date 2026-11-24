// Display formatting. Money is TWD whole dollars (the API's minor unit for TWD is 1 dollar:
// price_amount 3400 means NT$3,400). It is never scaled.
export const TZ = "Asia/Taipei";

const nf = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
export const formatNumber = (n) => nf.format(Number(n) || 0);
export const formatMoney = (n) => `NT$${formatNumber(n)}`;

export function formatRange(min, max) {
  if (min === null || min === undefined) return "—";
  return min === max ? formatMoney(min) : `${formatMoney(min)} – ${formatMoney(max)}`;
}

const dateFmt = new Intl.DateTimeFormat("zh-TW", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat("zh-TW", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

export function formatDate(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d);
}
export function formatDateTime(v) {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : dateTimeFmt.format(d);
}

/** "12" -> 12; blank/garbage -> NaN (callers validate). Whole numbers only. */
export function parseInteger(text) {
  const t = String(text).trim();
  return /^\d+$/.test(t) ? Number(t) : NaN;
}

const slugRe = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const isValidSlug = (s) => slugRe.test(s);
export const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
