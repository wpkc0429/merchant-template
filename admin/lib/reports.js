// Sales reports. Period boundaries are the shop's local calendar days; the server decides which
// orders count (see SalesReport in the OpenAPI document) and this layer never recomputes totals.
import { takeApi } from "./api.js";

const { api } = takeApi(); // boot phase only: sealed before the design layer loads (lib/api.js)
import { taipeiDate, addDays, monthStart, daysBetween } from "./dates.js";

const base = (shopID) => `/admin/shops/${shopID}`;

export const getSalesReport = (shopID, { from, to, groupBy = "day" }) =>
  api("GET", `${base(shopID)}/reports/sales?${new URLSearchParams({ from, to, group_by: groupBy })}`);
export const getProductReport = (shopID, { from, to, limit = 10 }) =>
  api("GET", `${base(shopID)}/reports/products?${new URLSearchParams({ from, to, limit: String(limit) })}`);

/** Range presets, in the shop's day. */
export function presetRange(key) {
  const today = taipeiDate();
  switch (key) {
    case "today": return { from: today, to: today };
    case "7d": return { from: addDays(today, -6), to: today };
    case "30d": return { from: addDays(today, -29), to: today };
    case "month": return { from: monthStart(today), to: today };
    default: return null;
  }
}

/** Largest range the API accepts per grouping (day: 366 days, month: 1830 days). */
export const maxDays = (groupBy) => (groupBy === "month" ? 1830 : 366);
export const rangeDays = (from, to) => daysBetween(from, to) + 1;

/** Zero-fill missing days between from..to for the CHART only (a day with no counted orders is truly 0). */
export function fillDays(buckets, from, to) {
  const byPeriod = new Map(buckets.map((b) => [b.period, b]));
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(byPeriod.get(d) || { period: d, total_amount: 0, order_count: 0 });
  return out;
}
