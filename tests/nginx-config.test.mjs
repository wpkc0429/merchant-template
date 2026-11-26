// The admin hosting config (admin/deploy): what the nginx template says after envsubst, and the start-up origin checks.
// No nginx needed: the template is rendered the way the nginx image does (only the defined variables are substituted).
// A real-nginx run was done by hand when this was written (see docs/CORE-CHANGELOG.md v0.3.0); these tests keep the properties.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TEMPLATE } from './helpers.mjs';

const DEPLOY = path.join(TEMPLATE, 'admin', 'deploy');
const tpl = readFileSync(path.join(DEPLOY, 'nginx.conf.template'), 'utf8');
const ENV = { ADMIN_IMG_ORIGIN: 'https://img.example.com', ADMIN_UPLOAD_ORIGIN: 'https://u.example.com', ADMIN_SITE_ORIGIN: 'https://www.example.com', ADMIN_RESOLVER: '10.0.0.2' };
const render = (env = ENV) => tpl.replace(/\$\{([A-Z_]+)\}/g, (m, n) => (n in env ? env[n] : m));
const strip = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
/** The body of `location <head> { ... }` (no nested braces except limit_except, which is handled by depth). */
function location(conf, head) {
  const i = conf.indexOf(`location ${head} {`);
  assert.ok(i >= 0, `location ${head} missing`);
  let depth = 0, j = conf.indexOf('{', i);
  const start = j;
  for (; j < conf.length; j++) { if (conf[j] === '{') depth++; else if (conf[j] === '}' && --depth === 0) break; }
  return conf.slice(start + 1, j);
}
const REQUIRED = ['X-Robots-Tag', 'Content-Security-Policy', 'Referrer-Policy', 'X-Content-Type-Options', 'X-Frame-Options', 'Strict-Transport-Security', 'Permissions-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy', 'Cache-Control'];
const headers = (block) => [...block.matchAll(/add_header\s+([A-Za-z-]+)\s/g)].map((m) => m[1]);

describe('nginx.conf.template after envsubst', () => {
  const conf = strip(render());
  test('every variable is substituted (nothing of ours is left as ${...})', () => {
    assert.doesNotMatch(conf, /\$\{ADMIN_/);
    assert.match(conf, /img-src 'self' data: blob: https:\/\/img\.example\.com;/);
    assert.match(conf, /resolver 10\.0\.0\.2 /);
  });
  test('the server block has every security header', () => {
    const server = conf.slice(0, conf.indexOf('location ~'));
    for (const h of REQUIRED) assert.ok(headers(server).includes(h), `server-level ${h}`);
  });
  test('every location that sets add_header repeats all security headers (nginx does not inherit them otherwise)', () => {
    for (const head of ['= /site-config.js', '= /content.schema.json']) {
      const hs = headers(location(conf, head));
      for (const h of REQUIRED) assert.ok(hs.includes(h), `${head} lacks ${h}`);
      assert.ok(hs.every((h, i) => hs.indexOf(h) === i), `${head}: a header is set twice`);
    }
    assert.match(location(conf, '= /site-config.js'), /add_header Content-Security-Policy "[^"]*script-src 'self'[^"]*" always;/);
  });
  test('schema location: nothing of the admin session is forwarded, GET only, no redirects, short timeout', () => {
    const b = location(conf, '= /content.schema.json');
    for (const h of ['Cookie', 'Authorization', 'Cf-Access-Jwt-Assertion', 'CF_Authorization']) assert.match(b, new RegExp(`proxy_set_header ${h} "";`), h);
    assert.match(b, /limit_except GET \{\s*deny all;\s*\}/);
    assert.match(b, /proxy_redirect off;/);
    assert.match(b, /proxy_read_timeout 5s;/);
    assert.match(b, /proxy_pass_request_body off;/);
    assert.match(b, /proxy_hide_header Set-Cookie;/);
    assert.match(b, /proxy_hide_header Content-Type;/);
    assert.match(b, /default_type application\/json;/);
    assert.match(b, /add_header Content-Type "application\/json" always;/);
    assert.doesNotMatch(b, /proxy_set_header Cookie [^"]/);
    assert.doesNotMatch(b, /proxy_pass_header|proxy_set_header Cookie \$/);
  });
  test('schema upstream is a variable (resolved per request, so the admin starts without DNS for the storefront)', () => {
    const b = location(conf, '= /content.schema.json');
    assert.match(b, /set \$schema_upstream "https:\/\/www\.example\.com\/content\.schema\.json";/);
    assert.match(b, /proxy_pass \$schema_upstream;/);
  });
  test('the dot-file / local-override block is still there', () => {
    assert.match(conf, /location ~ \/\(config\\\.local\\\.js\|\\\.\|scripts\/\|e2e\/\|docs\/\|deploy\/\) \{ return 404; \}/);
  });
});

describe('start-up checks (deploy/require-origins.sh)', () => {
  const sh = spawnSync('sh', ['-c', 'true']);
  const skip = sh.error ? 'no sh on this machine' : false;
  const run = (env) => spawnSync('sh', [path.join(DEPLOY, 'require-origins.sh')], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const base = { ADMIN_IMG_ORIGIN: ENV.ADMIN_IMG_ORIGIN, ADMIN_UPLOAD_ORIGIN: ENV.ADMIN_UPLOAD_ORIGIN, ADMIN_SITE_ORIGIN: ENV.ADMIN_SITE_ORIGIN };
  test('good origins pass', { skip }, () => {
    assert.equal(run(base).status, 0, run(base).stderr);
    assert.equal(run({ ...base, ADMIN_SITE_ORIGIN: 'https://shop.example.com:8443' }).status, 0);
  });
  test('ADMIN_SITE_ORIGIN: missing, trailing slash, path, quotes, semicolon, http, uppercase, space, injection all fail with a message', { skip }, () => {
    const bad = [undefined, '', 'https://www.example.com/', 'https://www.example.com/x', 'http://www.example.com', 'https://WWW.example.com', 'https://a.b"; return 200', 'https://a.b;', "https://a.b'", 'https://a.b c', 'https://a.b$x', 'https://a.b{x}', 'www.example.com', 'https://a.b:80a'];
    for (const v of bad) {
      const env = { ...base }; if (v === undefined) delete env.ADMIN_SITE_ORIGIN; else env.ADMIN_SITE_ORIGIN = v;
      const r = run(env);
      assert.notEqual(r.status, 0, `accepted ${JSON.stringify(v)}`);
      assert.match(r.stderr, /ADMIN_SITE_ORIGIN/, `message for ${JSON.stringify(v)}`);
    }
  });
  test('image and upload origins with quotes, semicolons or paths fail too (they are written into the CSP)', { skip }, () => {
    for (const k of ['ADMIN_IMG_ORIGIN', 'ADMIN_UPLOAD_ORIGIN']) {
      for (const v of ['https://a.b; script-src *', "https://a.b'", 'https://a.b/path', 'https://a.b"']) assert.notEqual(run({ ...base, [k]: v }).status, 0, `${k}=${v}`);
      assert.notEqual(run({ ...base, [k]: '' }).status, 0);
    }
  });
  test('preview hosts: the Dockerfile installs preview-config.sh; it writes null on a normal host, a frozen-shape config on a preview host, and rejects bad values', { skip }, () => {
    const d = readFileSync(path.join(DEPLOY, 'Dockerfile'), 'utf8');
    assert.match(d, /COPY deploy\/preview-config\.sh \/docker-entrypoint\.d\/07-preview-config\.sh/);
    const script = readFileSync(path.join(DEPLOY, 'preview-config.sh'), 'utf8').replace('/usr/share/nginx/html/preview-config.js', '$OUTFILE');
    const dir = mkdtempSync(path.join(tmpdir(), 'pvc-'));
    const f = path.join(dir, 'preview-config.js');
    const go = (env) => spawnSync('sh', ['-c', script], { env: { PATH: process.env.PATH, OUTFILE: f, ...env }, encoding: 'utf8' });
    try {
      assert.equal(go({}).status, 0); assert.match(readFileSync(f, 'utf8'), /preview = null;/);
      assert.equal(go({ ADMIN_PREVIEW_MODE: 'version', ADMIN_PREVIEW_TAG: 'design-2026-10-01', ADMIN_PREVIEW_EXPIRES: '2026-11-27T12:00:00Z' }).status, 0);
      assert.match(readFileSync(f, 'utf8'), /preview = \{"kind":"version","tag":"design-2026-10-01","expiresAt":"2026-11-27T12:00:00Z"\};/);
      for (const bad of [{ ADMIN_PREVIEW_MODE: 'x' }, { ADMIN_PREVIEW_MODE: 'change', ADMIN_PREVIEW_TAG: 'a"; alert(1)' }, { ADMIN_PREVIEW_MODE: 'change', ADMIN_PREVIEW_EXPIRES: 'tomorrow' }]) assert.notEqual(go(bad).status, 0, JSON.stringify(bad));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test('the Dockerfile installs the check and the resolver script', () => {
    const d = readFileSync(path.join(DEPLOY, 'Dockerfile'), 'utf8');
    assert.match(d, /COPY deploy\/require-origins\.sh \/docker-entrypoint\.d\/05-require-origins\.sh/);
    assert.match(d, /COPY deploy\/resolver\.envsh \/docker-entrypoint\.d\/06-resolver\.envsh/);
  });
});
