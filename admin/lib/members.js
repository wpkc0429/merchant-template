// Customers (members), their points, and member tiers.
import { takeApi } from "./api.js";

const { api } = takeApi(); // boot phase only: sealed before the design layer loads (lib/api.js)
import { listOrders } from "./orders.js";

const base = (shopID) => `/admin/shops/${shopID}`;
export const MEMBERS_PAGE_SIZE = 20;

export async function listMembers(shopID, { page = 1, q = "" } = {}) {
  const p = new URLSearchParams({ page: String(page), page_size: String(MEMBERS_PAGE_SIZE) });
  if (q.trim()) p.set("q", q.trim());
  const d = await api("GET", `${base(shopID)}/members?${p}`);
  return { members: d.members || [], total: d.total ?? 0, page: d.page ?? page, pageSize: d.page_size ?? MEMBERS_PAGE_SIZE };
}
export const getMember = (shopID, id) => api("GET", `${base(shopID)}/members/${id}`);

export async function listPointTransactions(shopID, id, page = 1) {
  const d = await api("GET", `${base(shopID)}/members/${id}/points/transactions?page=${page}&page_size=20`);
  const items = d.transactions || d.items || d.point_transactions || [];
  return { items, total: d.total ?? items.length };
}

/**
 * The API deliberately exposes no per-customer aggregates, so the detail view derives them from the
 * customer's orders (member_id filter): the order count is the server's own total; spend is the sum of
 * paid, not-cancelled orders (read page by page, capped). `complete` is false if the cap was hit.
 */
export async function memberOrderSummary(shopID, memberID, cap = 500) {
  let spend = 0, paidCount = 0, read = 0, complete = true, recent = [], total = 0;
  for (let page = 1; ; page++) {
    const r = await listOrders(shopID, { memberID, page, pageSize: 100 });
    if (page === 1) { recent = r.orders.slice(0, 10); total = r.total; }
    for (const o of r.orders) {
      read++;
      if (o.status === 0 && o.payment_status === 1) { spend += o.total_amount; paidCount++; }
    }
    if (read >= r.total || !r.orders.length) break;
    if (read >= cap) { complete = false; break; }
  }
  return { recent, orderCount: total, paidCount, spend, complete };
}

// ── Tiers ──────────────────────────────────────────────────────────────
export const listMemberTiers = async (shopID) => ((await api("GET", `${base(shopID)}/member-tiers`)).member_tiers || []).sort((a, b) => a.min_points - b.min_points);
export const createMemberTier = (shopID, body) => api("POST", `${base(shopID)}/member-tiers`, body);
export const updateMemberTier = (shopID, id, body) => api("PUT", `${base(shopID)}/member-tiers/${id}`, body);
