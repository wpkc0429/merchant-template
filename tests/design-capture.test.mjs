// Unit tests of scripts/design-capture.mjs (pure parts + a fake platform for the upload rules). No browser, no network beyond loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as dc from '../scripts/design-capture.mjs';

const ENV = {
  sandbox: true, dataset: 'sandbox-v1', api_origin: 'http://127.0.0.1:18080', admin_origin: 'http://127.0.0.1:13001',
  allowed_api_origins: ['http://127.0.0.1:18080', 'http://localhost:18080'],
  design_sandbox_origins: ['http://127.0.0.1:13001', 'http://localhost:13001', 'http://127.0.0.1:18080', 'http://localhost:18080'],
  logins: { owner: { email: 'demo-owner@example.com', password: 'pw-owner-secret' }, staff: { email: 'demo-staff@example.com', password: 'pw-staff-secret' } },
};
const allow = () => dc.buildAllowlist({ env: ENV, process_env: {} });
const refuses = (fn, re) => assert.throws(fn, (e) => e instanceof dc.Refusal && e.exitCode === 2 && (!re || re.test(e.message)));
const scrubber = () => dc.makeScrubber(new Set());

test('origins: canonical form, no path / query / credentials', () => {
  assert.equal(dc.parseOrigin('HTTP://127.0.0.1:13001/'), 'http://127.0.0.1:13001');
  refuses(() => dc.parseOrigin('http://127.0.0.1:13001/admin'));
  refuses(() => dc.parseOrigin('http://127.0.0.1:13001/?x=1'));
  refuses(() => dc.parseOrigin('http://u:p@127.0.0.1:13001'));
  refuses(() => dc.parseOrigin('ftp://x'));
  refuses(() => dc.parseOrigin('nonsense'));
});

test('only sandbox origins pass; production-looking, main-stack and unlisted origins are refused', () => {
  assert.equal(dc.assertSandboxOrigin('admin', 'http://127.0.0.1:13001', allow()), 'http://127.0.0.1:13001');
  for (const bad of ['https://admin.example-merchant.com', 'https://api.platform.example', 'http://127.0.0.1:8080', 'http://localhost:3001', 'http://127.0.0.1:18081', 'http://10.0.0.5:13001'])
    refuses(() => dc.assertSandboxOrigin('x', bad, allow()), /refused/);
});

test('no allowlist at all means refuse (fail closed)', () => {
  refuses(() => dc.assertSandboxOrigin('api', 'http://127.0.0.1:18080', new Set()), /allowlist/);
  refuses(() => dc.assertSandboxOrigin('api', 'http://127.0.0.1:18080', null));
});

test('cleartext http is allowed only on loopback even when listed', () => {
  const a = dc.buildAllowlist({ env: {}, process_env: { DESIGN_CAPTURE_ALLOWED_ORIGINS: 'http://sandbox.internal:9000,https://sandbox.example.test' } });
  refuses(() => dc.assertSandboxOrigin('api', 'http://sandbox.internal:9000', a), /loopback/);
  assert.equal(dc.assertSandboxOrigin('api', 'https://sandbox.example.test', a), 'https://sandbox.example.test');
});

test('logins must be synthetic example.com accounts', () => {
  dc.assertSyntheticLogin('owner', ENV.logins.owner);
  refuses(() => dc.assertSyntheticLogin('owner', { email: 'me@gmail.com', password: 'x' }), /synthetic/);
  refuses(() => dc.assertSyntheticLogin('owner', { email: 'a@example.com.evil.io', password: 'x' }));
  refuses(() => dc.assertSyntheticLogin('owner', {}));
});

test('secrets are never accepted on argv and never survive the scrubber', () => {
  for (const f of ['--service-key', '--password', '--owner-password', '--token']) refuses(() => dc.parseArgs(['upload', f, 'dsk_abcdefgh12345']), /environment/);
  const s = dc.makeScrubber(new Set(['pw-owner-secret']));
  const out = s('login pw-owner-secret failed with Bearer abcdefghijklmnopqrstuv and dsk_ABCDEFGH12345678 X-Amz-Signature=deadbeef01');
  assert.ok(!/pw-owner-secret|abcdefghijklmnop|ABCDEFGH1234|deadbeef/.test(out), out);
});

test('the view set is fixed: admin 10 views x 2 viewports, storefront anon only, keys fit the platform slot rules', () => {
  assert.equal(dc.viewSet('admin').length, 10);
  assert.deepEqual(dc.viewSet('admin').filter((v) => v.role === 'staff').map((v) => v.view_key), ['home', 'orders']);
  assert.ok(dc.viewSet('storefront').every((v) => v.role === 'anon'));
  for (const site of ['admin', 'storefront']) for (const v of dc.viewSet(site)) assert.match(v.view_key, /^[a-z0-9-]{1,40}$/);
  assert.equal(dc.SET_VERSION, 1);
  assert.ok(dc.viewSet('admin').length * 2 * 2 <= dc.SLOT_CAP, 'both phases fit the 80 slot cap');
  assert.equal(dc.shotName('after', 'owner', 390, 'orders'), 'after-owner-390-orders.png');
  assert.deepEqual(dc.parseShotName('before-anon-1280-home.png'), { phase: 'before', role: 'anon', viewport: 1280, view_key: 'home' });
  assert.equal(dc.parseShotName('../evil.png'), null);
  assert.equal(dc.parseShotName('after-owner-800-home.png'), null);
  refuses(() => dc.viewSet('mobile'));
});

test('the capture manifest carries the origin, the sandbox dataset, and stays under 2 KiB', () => {
  const m = JSON.parse(Buffer.from(dc.captureManifestHeader({ site: 'admin', origin: 'http://127.0.0.1:13001' }), 'base64'));
  assert.equal(m.dataset, 'sandbox-v1'); assert.equal(m.api_origin_class, 'sandbox'); assert.equal(m.origin, 'http://127.0.0.1:13001');
  assert.equal(m.set_version, 1); assert.equal(m.tool, 'design-capture'); assert.ok(!Number.isNaN(Date.parse(m.captured_at)));
});

test('pixelDiffPpm uses the parity rule (sum of channel differences > 6)', () => {
  const a = new Uint8ClampedArray(4 * 1000).fill(100), b = a.slice();
  assert.equal(dc.pixelDiffPpm(a, b), 0);
  for (let p = 0; p < 10; p++) b[p * 4] = 107;
  assert.equal(dc.pixelDiffPpm(a, b), 10000);
  const c = a.slice(); c[0] = 106;
  assert.equal(dc.pixelDiffPpm(a, c), 0);
  assert.equal(dc.pixelDiffPpm(a, new Uint8ClampedArray(8)), null);
});

test('upload planning: slot cap, attempt cap, and already-stored slots are skipped', () => {
  const shot = (i, sha = 's' + i) => ({ phase: 'after', role: 'owner', viewport: 390, view_key: 'v' + i, sha256: sha });
  const many = Array.from({ length: 81 }, (_, i) => shot(i));
  assert.throws(() => dc.planUpload(many, { slots: {} }), (e) => e.exitCode === 3 && /slot/.test(e.message));
  const few = [shot(1), shot(2)];
  const ledger = { slots: { [dc.slotKey(few[0])]: { sha256: 's1', attempts: 1 } } };
  const p = dc.planUpload(few, ledger);
  assert.equal(p.todo.length, 1); assert.equal(p.skipped, 1);
  const loop = { slots: { x: { sha256: 'z', attempts: 239 } } };
  assert.throws(() => dc.planUpload(few, loop), (e) => e.exitCode === 3 && /attempt/.test(e.message));
  const retake = dc.planUpload([shot(1, 'new')], ledger);
  assert.equal(retake.todo.length, 1, 'a retake of an existing slot is planned without a new slot');
});

test('response classes follow the service contract', () => {
  const c = dc.classifyUpload;
  assert.equal(c(201).action, 'ok'); assert.equal(c(200).action, 'ok');
  for (const s of [429, 502, 500, 503]) assert.equal(c(s, '').action, 'retry');
  assert.equal(c(503, 'design_storage_not_configured').action, 'abandon');
  for (const code of ['slot_cap_exceeded', 'attempt_cap_exceeded', 'quota_exceeded']) assert.equal(c(409, code).action, 'abandon');
  assert.equal(c(409, 'head_moved').action, 'recapture');
  assert.equal(c(422, 'live_data_capture_refused').action, 'abandon');
  assert.equal(c(404).action, 'abandon');
});

// ---- a fake platform: the upload command end to end ----
const png = (seed) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24), Buffer.from('seed' + seed)]);
async function fakePlatform(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => { seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) }); handler(seen.length, res); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, api: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}
function captureDir(n = 3) {
  const dir = mkdtempSync(join(tmpdir(), 'dcap-'));
  const shots = [];
  for (let i = 0; i < n; i++) {
    const bytes = png(i); const file = dc.shotName('after', 'owner', 390, 'view-' + i);
    writeFileSync(join(dir, file), bytes);
    shots.push({ file, phase: 'after', role: 'owner', viewport: 390, view_key: 'view-' + i, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, diff_ppm: i === 0 ? 1234 : undefined });
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ tool: 'design-capture', tool_version: '1', set_version: 1, site: 'admin', phase: 'after', dataset: 'sandbox-v1', api_origin_class: 'sandbox', origin: 'http://127.0.0.1:13001', captured_at: new Date().toISOString(), shots, skipped: [] }));
  return dir;
}
const KEY = 'dsk_TESTKEYTESTKEYTESTKEY1234';
const REQ = '123e4567-e89b-12d3-a456-426614174000';
async function withKey(fn) {
  const old = process.env.DESIGN_SERVICE_KEY; process.env.DESIGN_SERVICE_KEY = KEY;
  try { return await fn(); } finally { if (old === undefined) delete process.env.DESIGN_SERVICE_KEY; else process.env.DESIGN_SERVICE_KEY = old; }
}
const up = (dir, api, extra = {}) => dc.runUpload({ dir, api, shop: '7', request: REQ }, { log: () => {}, scrub: scrubber(), sleep: async () => {}, ...extra });

test('upload: slot path, bearer, manifest with origin, sha and diff headers; the key is never logged; a rerun skips stored slots', async () => {
  const dir = captureDir(3);
  const fp = await fakePlatform((n, res) => { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ attempt: 1 })); });
  try {
    await withKey(async () => {
      const lines = [];
      const r = await up(dir, fp.api, { log: (...a) => lines.push(a.join(' ')) });
      assert.equal(r.uploaded, 3); assert.equal(fp.seen.length, 3);
      const first = fp.seen[0];
      assert.equal(first.url, `/api/v1/design-service/shops/7/requests/${REQ}/screenshots/after/owner/390/view-0`);
      assert.equal(first.headers.authorization, `Bearer ${KEY}`);
      assert.equal(first.headers['content-type'], 'image/png');
      assert.equal(first.headers['x-diff-ppm'], '1234');
      assert.equal(first.headers['x-content-sha256'], createHash('sha256').update(first.body).digest('hex'));
      const m = JSON.parse(Buffer.from(first.headers['x-capture-manifest'], 'base64'));
      assert.equal(m.origin, 'http://127.0.0.1:13001'); assert.equal(m.dataset, 'sandbox-v1');
      assert.ok(!lines.join('\n').includes(KEY));
      const again = await up(dir, fp.api);
      assert.equal(again.uploaded, 0); assert.equal(fp.seen.length, 3, 'identical slots are not sent again');
    });
  } finally { await fp.close(); }
});

test('upload: cap, live-data and head_moved responses stop at once without retrying', async () => {
  for (const [status, code, exit] of [[409, 'slot_cap_exceeded', 3], [409, 'head_moved', 5], [422, 'live_data_capture_refused', 3], [409, 'quota_exceeded', 3]]) {
    const dir = captureDir(2);
    const fp = await fakePlatform((n, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code, message: 'x' } })); });
    try {
      await withKey(async () => {
        await assert.rejects(up(dir, fp.api), (e) => e.exitCode === exit, code);
        assert.equal(fp.seen.length, 1, `${code}: not retried`);
      });
    } finally { await fp.close(); }
  }
});

test('upload: 429 / 502 are retried (Retry-After first) then succeed; a persistent 502 gives up with exit 4 after 5 retries', async () => {
  const a = await fakePlatform((n, res) => {
    if (n === 1) { res.writeHead(429, { 'retry-after': '1' }); res.end('{}'); } else if (n === 2) { res.writeHead(502); res.end('{}'); } else { res.writeHead(201); res.end('{"attempt":1}'); }
  });
  const sleeps = [];
  try {
    await withKey(async () => {
      const r = await up(captureDir(1), a.api, { sleep: async (ms) => { sleeps.push(ms); } });
      assert.equal(r.uploaded, 1); assert.equal(sleeps[0], 1000);
    });
  } finally { await a.close(); }
  const b = await fakePlatform((n, res) => { res.writeHead(502); res.end('{}'); });
  let slept = 0;
  try {
    await withKey(async () => {
      await assert.rejects(up(captureDir(1), b.api, { sleep: async () => { slept++; } }), (e) => e.exitCode === 4);
      assert.equal(b.seen.length, 6); assert.equal(slept, 5);
    });
  } finally { await b.close(); }
});

test('upload refuses without a dsk_ key, on a tampered file, and over plain http to a non-loopback API', async () => {
  const dir = captureDir(1);
  const old = process.env.DESIGN_SERVICE_KEY; delete process.env.DESIGN_SERVICE_KEY;
  await assert.rejects(up(dir, 'http://127.0.0.1:1'), (e) => e.exitCode === 2);
  await withKey(async () => {
    await assert.rejects(up(dir, 'http://platform.example.com'), /https/);
    writeFileSync(join(dir, 'after-owner-390-view-0.png'), png(99));
    await assert.rejects(up(dir, 'http://127.0.0.1:1'), /sha256/);
  });
  if (old !== undefined) process.env.DESIGN_SERVICE_KEY = old;
});

test('upload refuses a manifest that is not a sandbox design-capture manifest', async () => {
  const dir = captureDir(1);
  const mf = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); mf.dataset = 'public-live';
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(mf));
  await withKey(() => assert.rejects(up(dir, 'http://127.0.0.1:1'), /not a sandbox/));
});

test('CLI: a non-sandbox origin or a real login exits 2 before anything starts and prints no secret', () => {
  const envFile = join(mkdtempSync(join(tmpdir(), 'dcap-env-')), 'env.json');
  writeFileSync(envFile, JSON.stringify(ENV));
  const outDir = join(mkdtempSync(join(tmpdir(), 'dcap-out-')), 'o');
  const run = (args) => spawnSync(process.execPath, [join(import.meta.dirname, '../scripts/design-capture.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
  const base = ['capture', '--site', 'admin', '--phase', 'before', '--out', outDir];
  const live = run([...base, '--sandbox-env', envFile, '--admin-origin', 'https://admin.real-merchant.com']);
  assert.equal(live.status, 2); assert.match(live.stderr, /not a sandbox origin/);
  assert.equal(run([...base, '--sandbox-env', envFile, '--api', 'https://api.real-platform.com']).status, 2);
  assert.equal(run(['capture', '--site', 'storefront', '--phase', 'before', '--out', outDir]).status, 2);
  assert.equal(run(['capture', '--site', 'storefront', '--phase', 'before', '--out', outDir, '--sandbox-env', envFile, '--storefront-origin', 'https://shop.real.com']).status, 2);
  writeFileSync(envFile, JSON.stringify({ ...ENV, logins: { owner: { email: 'real.owner@gmail.com', password: 'REALPASSWORD-123' }, staff: ENV.logins.staff } }));
  const bad = run([...base, '--sandbox-env', envFile]);
  assert.equal(bad.status, 2); assert.ok(!(bad.stdout + bad.stderr).includes('REALPASSWORD-123'));
  assert.ok(!existsSync(join(outDir, 'manifest.json')));
  const views = run(['views', '--site', 'storefront']);
  assert.equal(views.status, 0); assert.match(views.stdout, /storefront anon 390 home/);
});

test('scrubber: short, URL-encoded and JSON-escaped secrets, tokens and control characters', () => {
  const secrets = new Set(); const s = dc.makeScrubber(secrets);
  s.add('pw'); s.add('abc!defg"h'); s.add('tok-ENV-123456789');
  const out = s('a pw b abc!defg\\"h c abc!defg%22h d tok-ENV-123456789 e [31mred');
  for (const bad of ['pw', 'defg', 'tok-ENV']) assert.ok(!out.includes(bad), bad + ' leaked: ' + out);
  assert.ok(!/[ -]/.test(out));
  assert.ok(s('x'.repeat(10000)).length < 4100);
});

test('allowlist: a main-stack port is refused even when it is explicitly listed', () => {
  const list = dc.buildAllowlist({ env: { design_sandbox_origins: ['http://127.0.0.1:8080'] } });
  refuses(() => dc.assertSandboxOrigin('x', 'http://127.0.0.1:8080', list), /main-stack/);
});

test('upload hardening: symlink, non-PNG, bad origin, duplicate and bad caps are refused before any request', async () => {
  const b = await fakePlatform((n, res) => { res.statusCode = 201; res.end('{}'); });
  try {
    await withKey(async () => {
      // symlink in place of a shot
      const d1 = captureDir(1); const f = join(d1, 'after-owner-390-view-0.png'); const bytes = readFileSync(f); const other = join(d1, 'real.bin');
      writeFileSync(other, bytes); rmSync(f);
      let linked = true; try { symlinkSync(other, f); } catch { linked = false; }
      if (linked) await assert.rejects(up(d1, b.api), /not a regular file/);
      // not a PNG
      const d2 = captureDir(1); writeFileSync(join(d2, 'after-owner-390-view-0.png'), Buffer.from('x'.repeat(40)));
      await assert.rejects(up(d2, b.api), /not a PNG/);
      // manifest origin malformed / with a path
      const d3 = captureDir(1); const m3 = JSON.parse(readFileSync(join(d3, 'manifest.json'), 'utf8')); m3.origin = 'http://127.0.0.1:13001/evil?x=1';
      writeFileSync(join(d3, 'manifest.json'), JSON.stringify(m3)); await assert.rejects(up(d3, b.api), /origin/);
      // traversal and duplicate entries
      const d4 = captureDir(1); const m4 = JSON.parse(readFileSync(join(d4, 'manifest.json'), 'utf8'));
      m4.shots[0].file = '../after-owner-390-view-0.png'; writeFileSync(join(d4, 'manifest.json'), JSON.stringify(m4)); await assert.rejects(up(d4, b.api), /does not match/);
      const d5 = captureDir(1); const m5 = JSON.parse(readFileSync(join(d5, 'manifest.json'), 'utf8')); m5.shots.push(m5.shots[0]);
      writeFileSync(join(d5, 'manifest.json'), JSON.stringify(m5)); await assert.rejects(up(d5, b.api), /duplicate/);
      // caps
      for (const v of ['abc', '0', '-1', '99999']) await assert.rejects(dc.runUpload({ dir: captureDir(1), api: b.api, shop: '7', request: REQ, 'slot-cap': v }, { log: () => {}, scrub: scrubber() }), /integer from 1/);
    });
    assert.equal(b.seen.length, 0);
  } finally { await b.close(); }
});

test('upload: a redirect is not followed (the PNG and headers never reach another origin) and Retry-After is capped', async () => {
  const target = await fakePlatform((n, res) => { res.statusCode = 201; res.end('{}'); });
  const b = await fakePlatform((n, res) => { res.statusCode = 307; res.setHeader('Location', target.api + '/x'); res.end(); });
  const c = await fakePlatform((n, res) => { if (n === 1) { res.statusCode = 429; res.setHeader('Retry-After', '1000000'); res.end('{}'); } else { res.statusCode = 201; res.end('{}'); } });
  try {
    await withKey(async () => {
      await assert.rejects(up(captureDir(1), b.api), (e) => e.exitCode === 4);
      assert.equal(target.seen.length, 0);
      const sleeps = []; await up(captureDir(1), c.api, { sleep: async (ms) => { sleeps.push(ms); } });
      assert.deepEqual(sleeps, [60000]);
    });
  } finally { await b.close(); await target.close(); await c.close(); }
});

test('upload: hostile error code and key echoed by the server never reach the message unscrubbed', async () => {
  const b = await fakePlatform((n, res) => { res.statusCode = 409; res.end(JSON.stringify({ error: { code: '[31m' + KEY } })); });
  try {
    await withKey(async () => {
      await assert.rejects(up(captureDir(1), b.api), (e) => !e.message.includes(KEY) && !//.test(e.message));
    });
  } finally { await b.close(); }
});

test('scrubber: longest secret first, C1 and bidi controls removed', () => {
  const s = dc.makeScrubber(new Set()); s.add('ab'); s.add('xxabyy-TOKENTOKEN');
  const out = s('t xxabyy-TOKENTOKEN \u009b[31m ‮ x');
  assert.ok(!out.includes('TOKEN') && !/[\u009b‮]/.test(out), out);
});

test('media origin: sandbox minio on loopback is fenced in without being on the allowlist; remote or main-stack ports are refused', () => {
  assert.equal(dc.sandboxMediaOrigin('http://127.0.0.1:19000'), 'http://127.0.0.1:19000');
  refuses(() => dc.sandboxMediaOrigin('https://cdn.real.com'), /loopback/);
  refuses(() => dc.sandboxMediaOrigin('http://127.0.0.1:8080'), /main-stack/);
});
