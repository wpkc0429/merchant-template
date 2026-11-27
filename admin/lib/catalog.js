// Catalog + shipping data access (products, SKUs, images, categories, shipping methods).
// All URLs and payload-shape rules live here so views never build API paths.
//
// THE SKU RULE (read before editing saveProduct): the product PUT is full-replace for SKUs
// ("existing SKUs missing from the payload are DELETED"). Therefore:
//   * the UI never offers SKU deletion (a size is turned off with is_active=false);
//   * saveProduct re-reads the product right before the PUT, refuses if its SKUs differ from
//     what the form was loaded with (stale), and builds the payload from the FRESH list so
//     every existing SKU id is always present;
//   * a final assertion throws if any fresh SKU id is missing from the payload.
import { takeApi } from "./api.js";

const { api } = takeApi(); // boot phase only: sealed before the design layer loads (lib/api.js)

export const SIZES = ["S", "M", "L"];
export const NEW_ARRIVALS_SLUG = "new-arrivals";
/** Name given to the category the core creates on request (data, not UI wording; the slug is what matters). */
export const NEW_ARRIVALS_NAME = "本季新品";

const base = (shopID) => `/admin/shops/${shopID}`;

export class StaleProductError extends Error {
  constructor() { super("stale product"); this.name = "StaleProductError"; }
}

// ── Products ───────────────────────────────────────────────────────────
/**
 * All products matching the filters (paged internally, 100 per request). The API's `q` does not search
 * the English subtitle, so with a keyword the full list is also filtered client-side on the subtitle
 * and the two result sets are merged (in the full list's order).
 */
export async function listAllProducts(shopID, { q = "", status = "" } = {}) {
  if (!q) return fetchAllProducts(shopID, { status });
  const [byApi, full] = await Promise.all([fetchAllProducts(shopID, { q, status }), fetchAllProducts(shopID, { status })]);
  const ids = new Set(byApi.map((p) => p.id));
  const needle = q.toLowerCase();
  const merged = full.filter((p) => ids.has(p.id) || (p.subtitle || "").toLowerCase().includes(needle));
  const seen = new Set(merged.map((p) => p.id));
  return [...merged, ...byApi.filter((p) => !seen.has(p.id))];
}

async function fetchAllProducts(shopID, { q = "", status = "" } = {}) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const p = new URLSearchParams({ page: String(page), page_size: "100" });
    if (q) p.set("q", q);
    if (status !== "") p.set("status", String(status));
    const data = await api("GET", `${base(shopID)}/products?${p}`);
    out.push(...(data.products || []));
    if (out.length >= (data.total ?? 0) || !(data.products || []).length) break;
  }
  return out;
}

export const productCount = async (shopID, status) => {
  const p = new URLSearchParams({ page: "1", page_size: "1" });
  if (status !== undefined) p.set("status", String(status));
  return (await api("GET", `${base(shopID)}/products?${p}`)).total ?? 0;
};

export const getProduct = (shopID, id) => api("GET", `${base(shopID)}/products/${id}`);
export const deleteProduct = (shopID, id) => api("DELETE", `${base(shopID)}/products/${id}`);

/** Active-SKU price range and stock summary for list display. */
export function summarizeSkus(skus) {
  const list = skus || [];
  const active = list.filter((s) => s.is_active);
  const shown = active.length ? active : list;
  const prices = shown.map((s) => s.price_amount);
  return {
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
    stock: active.reduce((n, s) => n + (Number(s.stock_qty) || 0), 0),
    inStock: active.some((s) => Number(s.stock_qty) > 0),
  };
}

/** The S/M/L SKU of a product, or undefined. Matches the storefront's SKU.options.size. */
export const skuForSize = (product, size) => (product?.skus || []).find((s) => s.options?.size === size);

const sameSku = (a, b) => a.id === b.id && a.sku_code === b.sku_code && a.price_amount === b.price_amount &&
  a.stock_qty === b.stock_qty && a.is_active === b.is_active && JSON.stringify(a.options || {}) === JSON.stringify(b.options || {});

function isStale(loaded, fresh) {
  const a = loaded?.skus || [];
  const b = fresh?.skus || [];
  if (a.length !== b.length) return true;
  return b.some((f) => { const l = a.find((x) => x.id === f.id); return !l || !sameSku(l, f); });
}

/**
 * form = {
 *   title, subtitle, slug, description, status (0|1),
 *   sizes: { S: {enabled, sku_code, price_amount, stock_qty, is_active}, M: ..., L: ... },
 *   category_ids: number[] | null   // null = do not touch (no category.view permission)
 * }
 * original = product as loaded into the form, or null when creating.
 */
export async function saveProduct(shopID, original, form) {
  const head = {
    title: form.title, subtitle: form.subtitle, slug: form.slug,
    description: form.description, status: form.status,
  };
  if (form.category_ids) head.category_ids = form.category_ids;

  if (!original) {
    const skus = SIZES.filter((s) => form.sizes[s]?.enabled).map((s) => newSku(s, form.sizes[s]));
    return api("POST", `${base(shopID)}/products`, { ...head, skus });
  }

  const fresh = await getProduct(shopID, original.id);
  if (isStale(original, fresh)) throw new StaleProductError();

  const touched = new Set();
  const skus = (fresh.skus || []).map((sku) => {
    const size = SIZES.find((s) => sku.options?.size === s && !touched.has(s));
    const edit = size && form.sizes[size];
    if (!edit) return { ...sku }; // unknown/extra SKU: send back exactly as read
    touched.add(size);
    return {
      ...sku,
      sku_code: edit.sku_code,
      price_amount: edit.price_amount,
      stock_qty: edit.stock_qty,
      is_active: edit.is_active,
    };
  });
  for (const s of SIZES) {
    if (!touched.has(s) && form.sizes[s]?.enabled) skus.push(newSku(s, form.sizes[s]));
  }
  for (const f of fresh.skus || []) {
    if (!skus.some((x) => x.id === f.id)) throw new Error("refusing to save: a SKU would be dropped");
  }
  return api("PUT", `${base(shopID)}/products/${original.id}`, { ...head, skus });
}

function newSku(size, e) {
  return {
    sku_code: e.sku_code,
    options: { size },
    price_amount: e.price_amount,
    currency: "TWD",
    stock_qty: e.stock_qty,
    is_active: e.is_active,
  };
}

// ── Product images (sub-resource; never part of the product PUT) ───────
const imgBase = (shopID, pid) => `${base(shopID)}/products/${pid}/images`;
export const listImages = async (shopID, pid) => (await api("GET", imgBase(shopID, pid))).images || [];
export const setImageAlt = (shopID, pid, imageID, alt) => api("PUT", `${imgBase(shopID, pid)}/${imageID}`, { alt });
export const deleteImage = (shopID, pid, imageID) => api("DELETE", `${imgBase(shopID, pid)}/${imageID}`);
/** Moves one image; the new order is computed from a fresh server list, never from the screen. */
export async function moveImage(shopID, pid, imageID, delta) {
  const fresh = await listImages(shopID, pid);
  const ids = fresh.map((i) => i.id);
  const from = ids.indexOf(imageID);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return fresh;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  await api("PUT", `${imgBase(shopID, pid)}/order`, { image_ids: ids });
  return listImages(shopID, pid);
}

// ── Categories ─────────────────────────────────────────────────────────
export async function categoryTree(shopID) { return (await api("GET", `${base(shopID)}/categories`)).categories || []; }
export const createCategory = (shopID, body) => api("POST", `${base(shopID)}/categories`, body);
export const updateCategory = (shopID, id, body) => api("PUT", `${base(shopID)}/categories/${id}`, body);
export const deleteCategory = (shopID, id) => api("DELETE", `${base(shopID)}/categories/${id}`);
export const getProductOrder = async (shopID, id) => (await api("GET", `${base(shopID)}/categories/${id}/product-order`)).products || [];
export const setProductOrder = async (shopID, id, productIDs) =>
  (await api("PUT", `${base(shopID)}/categories/${id}/product-order`, { product_ids: productIDs })).products || [];

/** Flattens the tree into [{...node, depth, parent}] in display order. */
export function flattenTree(nodes, depth = 0, parent = null, out = []) {
  for (const n of nodes) {
    out.push({ ...n, depth, parent });
    flattenTree(n.children || [], depth + 1, n, out);
  }
  return out;
}

/**
 * Re-numbers the siblings of `id` after moving it by delta, PUTting only the changed positions.
 * Positions can all be equal (0) on a fresh shop, so we always assign 0..n-1.
 */
export async function moveCategory(shopID, siblings, id, delta) {
  const ids = siblings.map((c) => c.id);
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  for (let i = 0; i < ids.length; i++) {
    const c = siblings.find((x) => x.id === ids[i]);
    if (c.position !== i) await updateCategory(shopID, c.id, { position: i });
  }
}

// ── Shipping methods ───────────────────────────────────────────────────
export const listShippingMethods = async (shopID) => (await api("GET", `${base(shopID)}/shipping-methods`)).shipping_methods || [];
export const createShippingMethod = (shopID, body) => api("POST", `${base(shopID)}/shipping-methods`, body);
export const updateShippingMethod = (shopID, id, body) => api("PUT", `${base(shopID)}/shipping-methods/${id}`, body);
