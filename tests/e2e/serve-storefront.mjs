#!/usr/bin/env node
// Static server for public/ with a VIRTUAL config.local.js (nothing is written to disk). Template-only test helper.
//   E2E_API_BASE_URL=http://127.0.0.1:8180 E2E_PUBLISHABLE_KEY=pk_... node tests/e2e/serve-storefront.mjs [port]
// Serves http://localhost:<port> (default 8788); index.html only requests config.local.js on localhost.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');
const port = Number(process.argv[2] || 8788);
const API = process.env.E2E_API_BASE_URL || 'http://127.0.0.1:8180';
const KEY = process.env.E2E_PUBLISHABLE_KEY || 'pk_demoseedstorefrontkeynotsecret';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg' };

http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/config.local.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
    return res.end(`Object.assign(window.SHOP_CONFIG, { apiBase: ${JSON.stringify(API)}, publishableKey: ${JSON.stringify(KEY)} });`);
  }
  const rel = p === '/' ? 'index.html' : p.slice(1);
  const f = path.resolve(ROOT, rel);
  if (!f.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const buf = await readFile(f);
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`storefront on http://localhost:${port} (api ${API})`));
