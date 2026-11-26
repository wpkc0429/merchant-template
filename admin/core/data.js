// Read-only data functions handed to the design layer (ctx.data) and the pure state-rule helpers
// (ctx.logic). Every query checks the permission it needs INSIDE the core, binds the current shop (the
// design layer never passes a shop id), and returns plain data. The API's RBAC remains the authority.
import { session } from "../lib/session.js";
import * as catalog from "../lib/catalog.js";
import * as orders from "../lib/orders.js";
import * as members from "../lib/members.js";
import * as reports from "../lib/reports.js";
import * as team from "../lib/team.js";
import * as dashboard from "../lib/dashboard.js";
import { isDate } from "../lib/dates.js";
import { mediaEnabled, maxImages, maxBytes } from "../lib/upload.js";
import { t } from "../lib/design.js";
import { need } from "./guard.js";
import { invalid } from "./errors.js";
import * as contentLib from "../lib/content.js";
import { dryRunContentSchema, reads as contentReads } from "./content-actions.js";
import { getVersionPreview } from "./version-preview.js";
import { listDesignRequests, getDesignRequest, getDesignState } from "./design-history.js";

const S = () => session.shopID;
const q = (perms, fn) => async (...args) => { need(...perms); return fn(S(), ...args); };

export const data = {
  // catalogue
  listProducts: q(["product.view"], (s, filters) => catalog.listAllProducts(s, filters)),
  productCount: q(["product.view"], (s, status) => catalog.productCount(s, status)),
  getProduct: q(["product.view"], (s, id) => catalog.getProduct(s, id)),
  listImages: q(["product.view"], (s, productId) => catalog.listImages(s, productId)),
  categoryTree: q(["category.view"], (s) => catalog.categoryTree(s)),
  getProductOrder: q(["category.view"], (s, categoryId) => catalog.getProductOrder(s, categoryId)),
  listShippingMethods: q(["shipping_method.view"], (s) => catalog.listShippingMethods(s)),
  lowStockSkus: q(["product.view"], (s) => dashboard.lowStockSkus(s)),
  // orders
  listOrders: q(["order.view"], (s, filters) => orders.listOrders(s, filters)),
  getOrder: q(["order.view"], (s, id) => orders.getOrder(s, id)),
  listOrderPayments: q(["payment.view"], (s, id) => orders.listOrderPayments(s, id)),
  listOrderShipments: q(["shipment.view"], (s, id) => orders.listOrderShipments(s, id)),
  deliveriesOn: q(["order.view"], (s, date) => orders.deliveriesOn(s, date)),
  unshippedPaidCount: q(["order.view"], (s) => orders.unshippedPaidCount(s)),
  // customers
  listMembers: q(["member.view"], (s, f) => members.listMembers(s, f)),
  getMember: q(["member.view"], (s, id) => members.getMember(s, id)),
  listPointTransactions: q(["member.view", "point.view"], (s, id, page) => members.listPointTransactions(s, id, page)),
  memberOrderSummary: q(["member.view", "order.view"], (s, id) => members.memberOrderSummary(s, id)),
  listMemberTiers: q(["member_tier.view"], (s) => members.listMemberTiers(s)),
  // reports (range rules are enforced here, before any request)
  salesReport: async (range) => { need("report.view"); checkRange(range); return reports.getSalesReport(S(), range); },
  productReport: async (range) => { need("report.view"); checkRange(range); return reports.getProductReport(S(), range); },
  // team
  listTeam: q(["user.manage_members"], (s) => team.listTeam(s)),
  listRoles: q(["user.manage_members"], (s) => team.listRoles(s)),
  listInvitations: q(["user.manage_members"], (s) => team.listInvitations(s)),
  // content documents (platform content store). Reads need content.view; the schema dry run needs content.manage and never writes.
  getContentSchema: async () => { need("content.view"); return contentReads.schema(); },
  listContentSchemaVersions: async () => { need("content.view"); return contentReads.schemaVersions(); },
  listContentDocuments: async () => { need("content.view"); return contentReads.documents(); },
  getContentDocument: async (key) => { need("content.view"); return contentReads.document(key); },
  listContentRevisions: async (key) => { need("content.view"); return contentReads.revisions(key); },
  getContentRevision: async (key, rev) => { need("content.view"); return contentReads.revision(key, rev); },
  dryRunContentSchema: async () => dryRunContentSchema(),
  contentSite: () => ({ previewEnabled: Boolean(contentLib.siteOrigin()) }),
  // version preview of a past design (needs design.view; read-only fact: its state, and the origin only for the person who asked)
  getVersionPreview,
  // design history (read layer, D13; needs design.view; GETs, so they also work on a read-only preview host)
  listDesignRequests, getDesignRequest, getDesignState,
  // media limits (read-only facts)
  media: () => ({ enabled: mediaEnabled(), maxImages: maxImages(), maxBytes: maxBytes() }),
};

function checkRange({ from, to, groupBy = "day" }) {
  if (!isDate(from) || !isDate(to)) throw invalid({}, t("report.err.badDate"));
  if (from > to) throw invalid({}, t("report.err.reversed"));
  if (reports.rangeDays(from, to) > reports.maxDays(groupBy)) throw invalid({}, groupBy === "day" ? t("report.err.tooLongDay") : t("report.err.tooLongMonth"));
}

// Pure helpers: what to OFFER given a state (the core's action functions re-check the same rules).
export const logic = {
  summarizeSkus: catalog.summarizeSkus,
  skuForSize: catalog.skuForSize,
  flattenTree: catalog.flattenTree,
  remainingQty: orders.remainingQty,
  hasUnshipped: orders.hasUnshipped,
  canCancelOrder: orders.canCancelOrder,
  shipBlocker: orders.shipBlocker,
  isOpenDelivery: orders.isOpenDelivery,
  timeline: orders.timeline,
  blockedReason: team.blockedReason,
  presetRange: reports.presetRange,
  fillDays: reports.fillDays,
  maxDays: reports.maxDays,
  rangeDays: reports.rangeDays,
  isDate,
};

export const enums = {
  ORDER_STATUS: orders.ORDER_STATUS, PAYMENT: orders.PAYMENT, FULFILLMENT: orders.FULFILLMENT, SHIPMENT: orders.SHIPMENT,
  SIZES: catalog.SIZES, NEW_ARRIVALS_SLUG: catalog.NEW_ARRIVALS_SLUG,
  LOW_STOCK_THRESHOLD: dashboard.LOW_STOCK_THRESHOLD,
  ORDERS_PAGE_SIZE: orders.ORDERS_PAGE_SIZE, MEMBERS_PAGE_SIZE: members.MEMBERS_PAGE_SIZE,
};
