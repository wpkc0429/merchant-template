// Shared e2e helpers. The suite runs against a THROWAWAY stack (see README "Testing").
// Credentials: the demo owner/staff are the seed's public documented demo accounts; the super
// admin is read from the ecommerce .env at run time and never printed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export const API = process.env.E2E_API_BASE_URL || "http://127.0.0.1:8180";
export const SITE = process.env.E2E_SITE_URL || "http://localhost:3001";
export const OUT = process.env.E2E_OUT || resolve(import.meta.dirname, "out");
export const ECOMMERCE = process.env.ECOMMERCE_DIR || resolve(import.meta.dirname, "../../../ecommerce");

export const OWNER = { email: "demo-owner@example.com", password: process.env.E2E_OWNER_PASSWORD || "demo-owner-change-me" };
export const STAFF = { email: "demo-staff@example.com", password: process.env.E2E_STAFF_PASSWORD || "demo-staff-change-me" };

// Playwright lives in ecommerce/e2e/node_modules; reuse it instead of installing a second copy.
export function loadPlaywright() {
  const require = createRequire(resolve(ECOMMERCE, "e2e/package.json"));
  return require("playwright");
}

export function superAdmin() {
  const env = readFileSync(resolve(ECOMMERCE, ".env"), "utf8");
  const get = (k) => (env.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim().replace(/^["']|["']$/g, "");
  return { email: get("SEED_ADMIN_EMAIL"), password: get("SEED_ADMIN_PASSWORD") };
}

let failures = 0;
export const failureCount = () => failures;
export function check(name, cond, extra = "") {
  if (cond) console.log(`  ok  ${name}`);
  else { failures++; console.error(`  FAIL ${name} ${extra}`); }
  return Boolean(cond);
}
export const section = (t) => console.log(`\n${t}`);

export async function req(method, path, { token, body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}/api/v1${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json, headers: res.headers };
}

export async function apiLogin({ email, password }) {
  const r = await req("POST", "/admin/auth/login", { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status}`);
  return r.json.access_token;
}

/** An EDITOR member of shop 1 (content.view + content.edit, no publish): invited by the owner through the API and accepted. */
export async function ensureEditor(ownerToken, tag) {
  const email = `content-editor-${tag}@example.com`;
  const password = "e2e-editor-pass-12";
  const roles = (await req("GET", "/admin/shops/1/roles", { token: ownerToken })).json.roles;
  const role = roles.find((r) => r.name === "editor");
  if (!role) throw new Error("no editor role in the demo shop");
  const inv = await req("POST", "/admin/shops/1/invitations", { token: ownerToken, body: { email, role_id: role.id } });
  const token = /accept-invite\/([^/?#]+)/.exec(inv.json?.invite_url || "")?.[1];
  if (inv.status !== 201 || !token) throw new Error(`editor invitation failed: ${inv.status}`);
  const acc = await req("POST", "/admin/auth/invitations/accept", { body: { token, password } });
  if (acc.status >= 300) throw new Error(`editor invitation accept failed: ${acc.status}`);
  return { email, password };
}
