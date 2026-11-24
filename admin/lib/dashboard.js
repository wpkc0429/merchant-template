// Home-screen numbers, computed from the admin APIs that exist.
import { listAllProducts } from "./catalog.js";

/** A SKU at or below this stock level counts as "low". */
export const LOW_STOCK_THRESHOLD = 5;

/** Active SKUs of active products at or below the threshold, lowest stock first. */
export async function lowStockSkus(shopID, threshold = LOW_STOCK_THRESHOLD) {
  const products = await listAllProducts(shopID, { status: 1 });
  const out = [];
  for (const p of products) {
    for (const s of p.skus || []) {
      if (s.is_active && Number(s.stock_qty) <= threshold) out.push({ productID: p.id, title: p.title, size: s.options?.size || "", sku: s.sku_code, stock: Number(s.stock_qty) });
    }
  }
  return out.sort((a, b) => a.stock - b.stock || a.title.localeCompare(b.title));
}
