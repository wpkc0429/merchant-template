// Dev static server with an OPTIONAL same-origin API proxy (mirrors the production topology:
// the reverse proxy sends ^/api/v1/admin to the API and everything else to these files).
//
//   node scripts/serve.mjs                       # static only, http://127.0.0.1:3001
//   node scripts/serve.mjs --proxy http://127.0.0.1:8080   # + /api/v1/admin -> API (same-origin, cookie mode)
//   PORT=3001 HOST=127.0.0.1 also work.
// No dependencies. Not used in production.
import { createServer, request as httpRequest } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || "127.0.0.1";
const proxyIdx = process.argv.indexOf("--proxy");
const proxy = proxyIdx > 0 ? new URL(process.argv[proxyIdx + 1]) : null;

// Only the files the site needs are served; repo files (docs, e2e, git) are not.
const ALLOW = /^\/(index\.html|app\.js|config\.js|config-loader\.js|config\.local\.js|styles\.css|(lib|ui|core|vendor)\/[^/]+|(design|design-defaults)\/([a-z0-9_-]+\/)*[A-Za-z0-9._-]+\.(js|css|svg|png|jpe?g|webp|gif|ico|avif|woff2|txt|md))$/;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon", ".avif": "image/avif", ".woff2": "font/woff2" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (proxy && url.pathname.startsWith("/api/v1/admin")) {
    const up = httpRequest({ host: proxy.hostname, port: proxy.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => { res.writeHead(502); res.end("bad gateway"); });
    req.pipe(up);
    return;
  }
  // Dev stand-in for the production proxy (deploy/nginx.conf.template): the storefront's schema file, same-origin.
  if (url.pathname === "/content.schema.json") {
    try {
      const body = await readFile(join(root, "..", "public", "content.schema.json"));
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(body);
    } catch { res.writeHead(404); res.end("not found"); }
    return;
  }
  let path = normalize(decodeURIComponent(url.pathname));
  if (path === "/" || path === "\\") path = "/index.html";
  path = path.replace(/\\/g, "/");
  if (!ALLOW.test(path)) { res.writeHead(404); res.end("not found"); return; }
  try {
    if (path.includes("..")) throw new Error("bad path");
    const file = join(root, path);
    await stat(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404); res.end("not found");
  }
}).listen(port, host, () => console.log(`merchant admin on http://${host}:${port}${proxy ? ` (proxy -> ${proxy.origin})` : ""}`));
