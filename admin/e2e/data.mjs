// Test-data helpers: real orders through the PUBLIC guest-checkout API (mock payment, then the signed mock
// webhook marks them paid), exactly as the storefront does it. Throwaway stack only.
import { createHmac, randomUUID } from "node:crypto";
import { API, req } from "./lib.mjs";

export const PUBLISHABLE_KEY = process.env.E2E_PUBLISHABLE_KEY || "pk_demoseedstorefrontkeynotsecret";
const WEBHOOK_SECRET = process.env.E2E_MOCK_WEBHOOK_SECRET || "e2e-mock-webhook-secret-for-throwaway-stack-only-0001";

async function shop(method, path, { token, body, headers = {} } = {}) {
  const h = { "X-Publishable-Key": PUBLISHABLE_KEY, ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* */ }
  return { status: res.status, json };
}

/** Taipei calendar date (YYYY-MM-DD) offset by `days` from today. */
export function taipeiDate(days = 0) {
  const t = new Date(Date.now() + days * 86400000);
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei" }).format(t);
}

/** items: [{sku_id, quantity, gift_message?}]. Returns {order, token}. */
export async function placeOrder({ email, items, name = "測試收件人", phone = "0912345678", addr = "台北市大安區復興南路一段 100 號 5 樓", date = null, shipId = null }) {
  const r = await shop("POST", "/shop/guest/checkout", {
    headers: { "Idempotency-Key": randomUUID() },
    body: {
      email, items,
      shipping_address: { recipient_name: name, phone, line1: addr },
      shipping_method_id: shipId, requested_delivery_date: date,
    },
  });
  if (r.status !== 201) throw new Error(`guest checkout failed: ${r.status} ${JSON.stringify(r.json)}`);
  return { order: r.json.order, token: r.json.order_access_token };
}

/** Starts a mock payment and delivers the signed "succeeded" webhook. */
export async function payOrder(token) {
  const p = await shop("POST", "/shop/guest/order/payments", { token, body: {} });
  if (p.status !== 201) throw new Error(`initiate payment failed: ${p.status} ${JSON.stringify(p.json)}`);
  const body = JSON.stringify({ provider_reference: p.json.provider_reference, status: "succeeded" });
  const sig = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
  const res = await fetch(`${API}/api/v1/webhooks/payments/mock`, { method: "POST", headers: { "Content-Type": "application/json", "X-Payment-Signature": sig }, body });
  if (res.status >= 300) throw new Error(`webhook failed: ${res.status} ${await res.text()}`);
  const o = await shop("GET", "/shop/guest/order", { token });
  return o.json;
}

/** Test catalogue lookup through the admin API: returns {sku: {size -> sku_id}, shipping: id}. */
export async function catalog(ownerToken) {
  const prods = (await req("GET", "/admin/shops/1/products?page_size=100&status=1", { token: ownerToken })).json.products;
  const skus = [];
  for (const p of prods.filter((x) => x.title.includes("｜"))) for (const s of p.skus || []) if (s.is_active && s.stock_qty > 5) skus.push({ id: s.id, product: p.title, size: s.options?.size, price: s.price_amount, code: s.sku_code });
  const ship = (await req("GET", "/admin/shops/1/shipping-methods", { token: ownerToken })).json.shipping_methods.filter((m) => m.is_active);
  return { skus, ship };
}

/** Makes the test products plentiful again so reruns on the same throwaway DB behave the same. */
export async function restockStock(ownerToken, qty = 50) {
  const prods = (await req("GET", "/admin/shops/1/products?page_size=100&status=1", { token: ownerToken })).json.products.filter((x) => x.title.includes("｜"));
  for (const p of prods) {
    await req("PUT", `/admin/shops/1/products/${p.id}`, { token: ownerToken, body: { skus: p.skus.map((s) => ({ ...s, stock_qty: qty, is_active: true })) } });
  }
  return prods.length;
}
