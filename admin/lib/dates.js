// Calendar-date helpers in the shop's day (Asia/Taipei). A "date" here is always a YYYY-MM-DD
// string (the API's requested_delivery_date and report from/to are calendar days, not instants).
export const SHOP_TZ = "Asia/Taipei";

const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: SHOP_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's Taipei calendar date, shifted by `days`. */
export function taipeiDate(days = 0, now = new Date()) {
  const base = fmt.format(now);
  return days ? addDays(base, days) : base;
}

/** YYYY-MM-DD + n days (pure calendar math, no timezone involved). */
export function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Whole days from a to b (b - a). */
export function daysBetween(a, b) {
  const t = (s) => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((t(b) - t(a)) / 86400000);
}

export const monthStart = (date) => `${date.slice(0, 7)}-01`;
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !Number.isNaN(Date.parse(s));
