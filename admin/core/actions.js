// Action functions handed to the design layer (ctx.actions). Each one enforces, inside the core and BEFORE
// any request goes out: the permission, the state rule, validation, the stale-write/SKU guards (via lib/)
// and, for irreversible actions, the confirmation dialog. The design layer supplies only the input values
// and (through design/copy.js) the wording. A declined confirmation returns {cancelled: true}.
import { session } from "../lib/session.js";
import * as catalog from "../lib/catalog.js";
import * as orders from "../lib/orders.js";
import * as members from "../lib/members.js";
import * as team from "../lib/team.js";
import * as upload from "../lib/upload.js";
import { t } from "../lib/design.js";
import { confirmDialog, toast } from "../ui/kit.js";
import { showReview } from "../ui/design-review.js";
import { fixedWarning, WARNED_CONFIRMS } from "./warnings.js";
import { parseInteger, isValidSlug } from "../ui/format.js";
import { need, readOnlyGuarded } from "./guard.js";
import { requestVersionPreview } from "./version-preview.js";
import { createContentActions } from "./content-actions.js";
import { createDesignActions } from "./design-actions.js";
import { ActionError, invalid, blocked } from "./errors.js";

const S = () => session.shopID;
const CANCELLED = Object.freeze({ cancelled: true });
// Confirmation = editable wording from copy (title, lead-in text, button labels) + the core's FIXED warning for the
// irreversible actions (core/warnings.js; not a copy key, so a design cannot weaken or remove it). `key` is
// "confirm.<id>"; an id in WARNED_CONFIRMS always renders its fixed warning, any other id is a plain confirm
// whose message is the copy key `.message`.
const ask = (key, params, { danger = true, cancelKey, textKey, detail = "" } = {}) => {
  const id = key.split(".")[1];
  const warned = WARNED_CONFIRMS.includes(id);
  return confirmDialog({
    title: t(`${key}.title`, params),
    message: t(warned ? (textKey || `${key}.text`) : `${key}.message`, params),
    ...(warned ? { warning: fixedWarning(id, params) } : {}),
    ...(detail ? { detail: String(detail) } : {}),
    confirmText: t(`${key}.yes`, params),
    ...(cancelKey ? { cancelText: t(cancelKey) } : {}), danger,
  });
};
const must = (fields) => { if (Object.keys(fields).length) throw invalid(fields); };
const idOrNull = (v) => (v === null || v === "" || v === undefined ? null : Number(v));

// ── Products ───────────────────────────────────────────────────────────
/**
 * form = { title, subtitle, slug, description, status (0|1),
 *          sizes: { S: {enabled, sku_code, price, stock, is_active}, M: ..., L: ... }   (price/stock are the raw text)
 *          category_ids: number[] | null }
 * original = the product as the form loaded it, or null when creating. Stale-write and SKU-drop guards run in lib/catalog.js.
 */
async function saveProduct(original, form) {
  need(original ? "product.edit" : "product.create");
  const f = {};
  const title = String(form.title ?? "").trim();
  const subtitle = String(form.subtitle ?? "").trim();
  const slug = String(form.slug ?? "").trim();
  if (!title) f["/title"] = t("v.title.required");
  if (subtitle.length > 200) f["/subtitle"] = t("v.subtitle.long");
  if (!slug) f["/slug"] = t("v.slug.required");
  else if (!isValidSlug(slug)) f["/slug"] = t("v.slug.invalid");
  const sizes = {};
  let enabled = 0;
  for (const size of catalog.SIZES) {
    const e = form.sizes?.[size];
    if (!e || !e.enabled) {
      // A size that already exists can never be switched off or dropped through the form: a screen that omits
      // it (or sends enabled:false) leaves that SKU exactly as it is.
      const have = original ? catalog.skuForSize(original, size) : null;
      sizes[size] = have
        ? { enabled: true, sku_code: have.sku_code, price_amount: have.price_amount, stock_qty: have.stock_qty, is_active: have.is_active }
        : { enabled: false };
      continue;
    }
    enabled++;
    const out = { enabled: true, sku_code: String(e.sku_code ?? "").trim(), price_amount: parseInteger(e.price), stock_qty: parseInteger(e.stock), is_active: Boolean(e.is_active) };
    if (!out.sku_code) f[`/skus/${size}`] = t("v.sku.code", { size });
    if (Number.isNaN(out.price_amount)) f[`/skus/${size}/price`] = t("v.sku.price", { size });
    if (Number.isNaN(out.stock_qty)) f[`/skus/${size}/stock`] = t("v.sku.stock", { size });
    sizes[size] = out;
  }
  if (!original && enabled === 0) f["/skus"] = t("v.sku.none");
  must(f);
  return catalog.saveProduct(S(), original, {
    title, subtitle, slug, description: String(form.description ?? ""), status: form.status === 1 ? 1 : 0,
    sizes, category_ids: Array.isArray(form.category_ids) ? form.category_ids.map(Number) : null,
  });
}

async function deleteProduct(id) {
  need("product.delete");
  const p = await catalog.getProduct(S(), id);
  if (!(await ask("confirm.deleteProduct", { title: p.title }))) return CANCELLED;
  await catalog.deleteProduct(S(), id);
  return { ok: true };
}

/** Offers to create the new-arrivals category (slug new-arrivals) after confirmation. Returns the category, or {cancelled}. */
async function createNewArrivalsCategory() {
  need("category.create");
  if (!(await ask("confirm.createNewArrivals", { slug: catalog.NEW_ARRIVALS_SLUG }, { danger: false }))) return CANCELLED;
  return catalog.createCategory(S(), { name: catalog.NEW_ARRIVALS_NAME, slug: catalog.NEW_ARRIVALS_SLUG });
}

// ── Product images (limits and HEIC conversion live in lib/upload.js) ──
async function uploadProductImage(productId, file, hooks) {
  need("product.edit");
  const have = (await catalog.listImages(S(), productId)).length;
  if (have >= upload.maxImages()) throw new ActionError("limit", t("img.limit", { max: upload.maxImages() }), { reason: "limit" });
  return upload.uploadProductImage(S(), productId, file, { onStage: hooks?.onStage, onProgress: hooks?.onProgress });
}
const setImageAlt = async (productId, imageId, alt) => { need("product.edit"); return catalog.setImageAlt(S(), productId, imageId, String(alt ?? "").slice(0, 300)); };
async function deleteImage(productId, imageId) {
  need("product.edit");
  if (!(await ask("confirm.deleteImage"))) return CANCELLED;
  await catalog.deleteImage(S(), productId, imageId);
  return { ok: true, images: await catalog.listImages(S(), productId) };
}
const moveImage = async (productId, imageId, delta) => { need("product.edit"); return catalog.moveImage(S(), productId, imageId, delta < 0 ? -1 : 1); };

// ── Categories ─────────────────────────────────────────────────────────
function categoryFields(name, slug) {
  const f = {};
  if (!name) f["/name"] = t("v.category.name");
  if (!isValidSlug(slug)) f["/slug"] = t("v.slug.short");
  return f;
}
/** input = {name, slug, parentId: number|null}. */
async function createCategory({ name, slug, parentId = null }) {
  need("category.create");
  const body = { name: String(name ?? "").trim(), slug: String(slug ?? "").trim() };
  must(categoryFields(body.name, body.slug));
  const tree = await catalog.categoryTree(S());
  const flat = catalog.flattenTree(tree);
  const pid = idOrNull(parentId);
  return catalog.createCategory(S(), { ...body, parent_id: pid, position: pid === null ? tree.length : (flat.find((c) => c.id === pid)?.children.length ?? 0) });
}
async function updateCategory(id, { name, slug, parentId = null }) {
  need("category.edit");
  const body = { name: String(name ?? "").trim(), slug: String(slug ?? "").trim() };
  must(categoryFields(body.name, body.slug));
  const node = catalog.flattenTree(await catalog.categoryTree(S())).find((c) => c.id === id);
  if (!node) throw new ActionError("state", t("err.404"), { reason: "gone", status: 404 });
  const pid = idOrNull(parentId);
  if (pid === null) { if (node.parent_id !== null) body.clear_parent = true; }
  else if (pid !== node.parent_id) body.parent_id = pid;
  return catalog.updateCategory(S(), id, body);
}
async function deleteCategory(id) {
  need("category.delete");
  const node = catalog.flattenTree(await catalog.categoryTree(S())).find((c) => c.id === id);
  if (!node) throw new ActionError("state", t("err.404"), { reason: "gone", status: 404 });
  const sub = (node.children || []).length;
  if (!(await ask("confirm.deleteCategory", { name: node.name, n: sub }, { textKey: sub ? "confirm.deleteCategory.textSub" : "confirm.deleteCategory.text" }))) return CANCELLED;
  await catalog.deleteCategory(S(), id);
  return { ok: true };
}
/** Moves a category among its siblings; the sibling list comes from a fresh read, never from the screen. */
async function moveCategory(id, delta) {
  need("category.edit");
  const tree = await catalog.categoryTree(S());
  const node = catalog.flattenTree(tree).find((c) => c.id === id);
  if (!node) return;
  await catalog.moveCategory(S(), node.parent ? node.parent.children : tree, id, delta < 0 ? -1 : 1);
}
async function setProductOrder(categoryId, productIds) {
  need("category.edit");
  return catalog.setProductOrder(S(), categoryId, productIds.map(Number));
}

// ── Shipping methods ───────────────────────────────────────────────────
function shippingBody(f) {
  const body = { name: String(f.name ?? "").trim(), carrier: String(f.carrier ?? "").trim(), flat_rate: parseInteger(f.flatRate), is_active: Boolean(f.isActive) };
  const e = {};
  if (!body.name) e["/name"] = t("v.ship.name");
  if (!body.carrier) e["/carrier"] = t("v.ship.carrier");
  if (Number.isNaN(body.flat_rate)) e["/flat_rate"] = t("v.ship.rate");
  must(e);
  return body;
}
const createShippingMethod = async (f) => { need("shipping_method.create"); return catalog.createShippingMethod(S(), shippingBody(f)); };
const updateShippingMethod = async (id, f) => { need("shipping_method.edit"); return catalog.updateShippingMethod(S(), id, shippingBody(f)); };
const setShippingActive = async (id, isActive) => { need("shipping_method.edit"); return catalog.updateShippingMethod(S(), id, { is_active: Boolean(isActive) }); };

// ── Member tiers ───────────────────────────────────────────────────────
function tierBody(f) {
  const body = { name: String(f.name ?? "").trim(), min_points: parseInteger(f.minPoints), discount_percent: parseInteger(f.discountPercent) };
  const e = {};
  if (!body.name) e["/name"] = t("v.tier.name");
  if (Number.isNaN(body.min_points)) e["/min_points"] = t("v.tier.points");
  if (Number.isNaN(body.discount_percent) || body.discount_percent > 100) e["/discount_percent"] = t("v.tier.percent");
  must(e);
  return body;
}
const createMemberTier = async (f) => { need("member_tier.create"); return members.createMemberTier(S(), tierBody(f)); };
const updateMemberTier = async (id, f) => { need("member_tier.edit"); return members.updateMemberTier(S(), id, tierBody(f)); };

// ── Orders and shipments ───────────────────────────────────────────────
async function cancelOrder(id) {
  need("order.cancel");
  const o = await orders.getOrder(S(), id);
  if (!orders.canCancelOrder(o)) throw blocked("notCancellable", t("err.cancelBlocked"));
  if (!(await ask("confirm.cancelOrder", { id: o.id }, { cancelKey: "confirm.cancelOrder.no" }))) return CANCELLED;
  await orders.cancelOrder(S(), o.id);
  return { ok: true };
}

/** input = {carrier, tracking, quantities: null (ship everything outstanding) | {orderItemId: "text"}}. */
async function createShipment(orderId, { carrier, tracking = "", quantities = null }) {
  need("shipment.create");
  if (!String(carrier ?? "").trim()) throw invalid({ "/carrier": t("v.ship.carrierName") }); // no request needed to know this
  const [o, shipments] = await Promise.all([orders.getOrder(S(), orderId), orders.listOrderShipments(S(), orderId)]);
  const why = orders.shipBlocker(o, shipments);
  if (why) throw blocked(why, t(`shipBlocker.${why}`));
  const f = {};
  const name = String(carrier ?? "").trim();
  if (!name) f["/carrier"] = t("v.ship.carrierName");
  let items;
  if (quantities) {
    items = [];
    for (const it of (o.items || []).filter((i) => orders.remainingQty(i) > 0)) {
      const raw = quantities[it.id] ?? quantities[String(it.id)] ?? "0";
      const n = parseInteger(raw);
      if (Number.isNaN(n)) { f[`/qty/${it.id}`] = t("v.qty.int"); continue; }
      if (n > orders.remainingQty(it)) { f[`/qty/${it.id}`] = t("v.qty.max", { n: orders.remainingQty(it) }); continue; }
      if (n > 0) items.push({ order_item_id: it.id, quantity: n });
    }
    if (!Object.keys(f).length && !items.length) f["/items"] = t("v.qty.none");
  }
  must(f);
  return orders.createShipment(S(), orderId, { carrier: name, tracking: String(tracking ?? "").trim(), items });
}

/** target: "delivered" | "returned". Re-reads the shipments so a stale screen cannot advance a finished parcel. */
async function advanceShipment(orderId, shipmentId, target) {
  need("shipment.update");
  if (target !== "delivered" && target !== "returned") throw invalid({}, t("err.generic"));
  if (target === "returned") need("shipment.return");
  const s = (await orders.listOrderShipments(S(), orderId)).find((x) => x.id === shipmentId);
  if (!s || s.status !== orders.SHIPMENT.SHIPPED) throw blocked("shipmentChanged", t("err.shipmentChanged"));
  if (!(await ask(target === "returned" ? "confirm.shipReturned" : "confirm.shipDelivered", { id: shipmentId }, { danger: target === "returned" }))) return CANCELLED;
  await orders.advanceShipment(S(), orderId, shipmentId, target);
  return { ok: true };
}

// ── Team ───────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
async function inviteMember({ email, roleId }) {
  need("user.manage_members");
  const addr = String(email ?? "").trim();
  const f = {};
  if (!EMAIL_RE.test(addr)) throw invalid({ "/email": t("v.email") }); // no request needed to know this
  const role = (await team.listRoles(S())).find((r) => r.id === Number(roleId));
  if (!role || !role.merchant_assignable) f["/role"] = t("v.role");
  must(f);
  return team.inviteMember(S(), addr, role.id);
}
async function revokeInvitation(id) {
  need("user.manage_members");
  const inv = (await team.listInvitations(S())).find((i) => i.id === id);
  if (!inv) throw new ActionError("state", t("err.inviteGone"), { reason: "gone", status: 404 });
  if (!(await ask("confirm.revokeInvite", { email: inv.email }))) return CANCELLED;
  await team.revokeInvitation(S(), id);
  return { ok: true };
}
async function setMemberActive(userId, active) {
  need("user.manage_members");
  const m = (await team.listTeam(S())).find((x) => x.user_id === userId);
  if (!m) throw new ActionError("state", t("err.404"), { reason: "gone", status: 404 });
  const why = team.blockedReason(m, session.user.id);
  if (why) throw blocked(why, t(`memberBlocked.${why}`));
  if (!(await ask(active ? "confirm.enableMember" : "confirm.disableMember", { email: m.email }, { danger: !active }))) return CANCELLED;
  await (active ? team.enableMember : team.disableMember)(S(), userId);
  return { ok: true };
}

const contentActions = createContentActions({ ask });
// openDesignReview / requestDesignRevert / cancelDesignRequest (D14): the review dialog is drawn by the core (ui/design-review.js).
const designActions = createDesignActions({ ask, review: showReview, notify: (m) => toast(m, "ok") });

// EVERY function in this table is wrapped by readOnlyGuarded(): on a preview host (lib/preview.js) each one throws ActionError
// reason "read_only" before doing anything. requestVersionPreview is in the table too (no preview from inside a preview).
export const actions = readOnlyGuarded({
  ...contentActions,
  requestVersionPreview,
  ...designActions,
  saveProduct, deleteProduct, createNewArrivalsCategory,
  uploadProductImage, setImageAlt, deleteImage, moveImage,
  createCategory, updateCategory, deleteCategory, moveCategory, setProductOrder,
  createShippingMethod, updateShippingMethod, setShippingActive,
  createMemberTier, updateMemberTier,
  cancelOrder, createShipment, advanceShipment,
  inviteMember, revokeInvitation, setMemberActive,
});
