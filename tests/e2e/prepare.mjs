#!/usr/bin/env node
// After importing catalog/catalog.sample.json into the THROWAWAY stack: hides the platform demo seed's own sample products
// (status 0) so only the template's sample catalogue is visible in the storefront. Throwaway stack only.
// Credentials: the demo shop owner's public documented demo account (override with E2E_OWNER_PASSWORD).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = process.env.E2E_API_BASE_URL || 'http://127.0.0.1:8180';
const sample = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../catalog/catalog.sample.json'), 'utf8'));
const keep = new Set(sample.products.map((p) => p.slug));
const call = async (m, p, tok, body) => {
  const r = await fetch(`${API}/api/v1/admin${p}`, { method: m, headers: { ...(tok ? { Authorization: 'Bearer ' + tok } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); if (!r.ok) throw new Error(`${m} ${p} ${r.status} ${t.slice(0, 200)}`); return t ? JSON.parse(t) : null;
};
const tok = (await call('POST', '/auth/login', null, { email: 'demo-owner@example.com', password: process.env.E2E_OWNER_PASSWORD || 'demo-owner-change-me' })).access_token;
const list = (await call('GET', '/shops/1/products?page_size=100', tok)).products;
for (const p of list) if (!keep.has(p.slug) && p.status !== 0) { await call('PUT', `/shops/1/products/${p.id}`, tok, { status: 0 }); console.log('hidden demo product:', p.slug); }
