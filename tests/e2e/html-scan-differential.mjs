// Differential test of the HTML tokenizer that the guard scans of index.html use (scripts/lib/html-scan.mjs, D24) against a real browser
// (Playwright Chromium, scripting on). For every case the browser parses the HTML into a DOM and the test compares what the scanner said:
//   * the list of <script> elements the DOM holds (document order, templates included): has-src and exact text of each, must equal scanHtml().scripts
//   * the number of comment nodes, must equal the number of comment tokens
//   * which script markers R(n) really ran: every one that ran must be in a script the scanner reports as inline (soundness: nothing live is hidden)
// Cases with an element the scanner marks ambiguous (svg, math, select, frameset) are only checked for the "ambiguous is reported" part.
// Corpus: the D23 documented variants, hand-written cases of every tokenizer state, and seeded random sequences of HTML fragments.
//   node tests/e2e/html-scan-differential.mjs [--n 4000] [--seed 1]      needs PLAYWRIGHT_DIR (SKIPs without it, or FAILs under REQUIRE_BROWSER_TESTS=1)
import { createRequire } from "node:module";
import { join } from "node:path";
import { scanHtml as scanStore } from "../../scripts/lib/html-scan.mjs";
import { scanHtml as scanAdmin } from "../../admin/scripts/lib/html-scan.mjs";
import { skipOrFail } from "../../admin/e2e/lib/require-browser.mjs";

const arg = (k, d) => { const i = process.argv.indexOf("--" + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const N = arg("n", 4000), SEED = arg("seed", 1);
function loadPlaywright() { for (const d of [process.env.PLAYWRIGHT_DIR].filter(Boolean)) { try { return createRequire(join(d, "package.json"))("playwright"); } catch { /* next */ } } return null; }
const pw = loadPlaywright();
if (!pw) skipOrFail("html-scan differential: Playwright not found (set PLAYWRIGHT_DIR)");
let browser;
try { browser = await pw.chromium.launch(); } catch (e) { skipOrFail(`html-scan differential: Chromium could not start (${String(e.message).split("\n")[0]})`); }

// ───────────── corpus ─────────────
const hand = [
  // the D23 documented bypass and its variants
  "<style><!-- </style><script>R(1)</script> --></style>",
  "<title><!-- </title><script>R(1)</script> --></title>",
  "<textarea><!-- </textarea><script>R(1)</script> --></textarea>",
  "<noscript><!-- </noscript><script>R(1)</script> --></noscript>",
  "<script src=a><!-- </script><script>R(1)</script> --></script>",
  "<xmp><!-- </xmp><script>R(1)</script> --></xmp>",
  "<iframe><!-- </iframe><script>R(1)</script> --></iframe>",
  "<noembed><!-- </noembed><script>R(1)</script> --></noembed>",
  "<noframes><!-- </noframes><script>R(1)</script> --></noframes>",
  "<STYLE><!-- </STYLE><SCRIPT>R(1)</SCRIPT> --></STYLE>",
  // comments
  "<!-- x --!><script>R(1)</script> -->",
  "<!--><script>R(1)</script>-->",
  "<!---><script>R(1)</script>-->",
  "<!----><script>R(1)</script>",
  "<!-- a --><script>R(1)</script>",
  "<!-- a -- !> <script>R(1)</script> -->",
  "<!-- a --!-> <script>R(1)</script> -->",
  "<!-- <!-- --><script>R(1)</script>",
  "<!--<!--><script>R(1)</script>",
  "<!-- a <!-- b --> <script>R(1)</script> -->",
  "<!-- --!--><script>R(1)</script>",
  "<!--x", "<!-- x --", "<!-- x --!", "<!--x--!x--><script>R(1)</script>",
  "<!x><script>R(1)</script>>", "<?php ?><script>R(1)</script>", "</ ><script>R(1)</script>", "</><script>R(1)</script>",
  "<![CDATA[ x ]]><script>R(1)</script>", "<!DOCTYPE html><script>R(1)</script>", "<!doctype html ' > <script>R(1)</script>",
  // script data escape states
  "<script><!--R(1)</script>", "<script><!--<script>R(1)</script>-->R(2)</script>", "<script><!--<script>R(1)</script>R(2)</script>R(3)",
  "<script><!-- <script> --></script><script>R(1)</script>", "<script><!--<SCRIPT >R(1)</SCRIPT>--></script><script>R(2)</script>",
  "<script><!--<script/>R(1)</script>R(2)</script>", "<script><!--<scripty>R(1)</scripty></script><script>R(2)</script>",
  "<script><!---->R(1)</script>", "<script><!--->R(1)</script>", "<script><!-->R(1)</script>", "<script><!--- ->R(1)</script>",
  "<script>R(1)</script ><script>R(2)</script/><script>R(3)</script x=y>", "<script>R(1)</scriptx><script>R(2)</script>",
  "<script>R(1)</script", "<script>R(1)", "<script", "<script src=x", "<script src=x>", "<script src=\"x\"></script>R(1)", "<script/src=x></script>",
  "<script type=importmap>{}</script><script>R(1)</script>", "<script src=a src>R(1)</script>", "<script src src=a>R(1)</script>", "<script type=a type=importmap>R(1)</script>", "<script TYPE=importmap type=b>R(1)</script>", "<script src=a SRC=b>R(1)</script>", "<script\ttype=importmap>{}</script>", "<script type='importmap'>{}</script >",
  "<script data-a='>'>R(1)</script>", "<script a=\">\" b='>'>R(1)</script>", "<script a=b>c>R(1)</script>",
  // raw text and RCDATA end tags
  "<style>R(1)</style x><script>R(2)</script>", "<style>a</style/><script>R(1)</script>", "<style>a</styles><script>R(1)</script></style>",
  "<title>a</title\n><script>R(1)</script>", "<textarea></TEXTAREA ><script>R(1)</script>", "<style></style><style><!--</style><script>R(1)</script>-->",
  "<plaintext><script>R(1)</script>", "<noscript><script>R(1)</script></noscript>",
  "<template><style><!--</style><script>R(1)</script>--></template>", "<template><script>R(1)</script></template>",
  "<div title='<!--'></div><script>R(1)</script>", "<div title=\"--></div>\"><script>R(1)</script>", "<a href=x onclick=R(1)>",
  "<a/><script>R(1)</script>", "<a b=c/><script>R(1)</script>", "<a b='c'd='e'><script>R(1)</script>", "<a =b><script>R(1)</script>", "<a b=><script>R(1)</script>",
  "<a b\n=\n'x'><script>R(1)</script>", "<a b c=d b=e><script>R(1)</script>", "< script>R(1)</script>", "<\0script>R(1)</script>",
  // foreign / select / frameset: only "ambiguous" has to be reported
  "<svg><style><!--</style><script>R(1)</script>--></style></svg>", "<svg><script>R(1)</script></svg>", "<math><style><!--</style><script>R(1)</script>--></math>",
  "<select><style><!--</style><script>R(1)</script>--></style></select>", "<frameset><style><!--</style><script>R(1)</script>--></frameset>",
];
// seeded random sequences of fragments
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const FR = [
  "<style>", "</style>", "<STYLE>", "</Style >", "<title>", "</title>", "<textarea>", "</textarea>", "<noscript>", "</noscript>", "<xmp>", "</xmp>", "<iframe>", "</iframe>", "<noembed>", "<noframes>",
  "<script>", "<script src=x>", "<script type=importmap>", "<script defer>", "<SCRIPT>", "</script>", "</SCRIPT >", "</script x>", "</script/>", "<script/>", "<script", "</scr", "</script",
  "<!--", "-->", "--!>", "<!-->", "<!--->", "--", "-", "!", "<!", "<!-", "<", "</", ">", "/>", "=", "\"", "'", "\n", " ", "\t", "\f", "<!x>", "<?x>", "</>", "</ >", "<![CDATA[", "]]>", "<!DOCTYPE html>", "<!doctype",
  "<a x=\">", "<a x='>", "<a x=", "<a x>", "<a ", "<b>", "</b>", "<p>", "<div>", "</div>", "<template>", "</template>", "<br>", "<plaintext>", "<table>", "<td>", "<body>", "<head>", "<html>",
  "<script><!--", "<scr", "ipt>", "R(", ")", "x", "y z", "<a onclick=", "on", "<img src=x onerror=",
];
function randomCase(r) {
  const len = 2 + Math.floor(r() * 12); let out = "", k = 0;
  for (let j = 0; j < len; j++) out += r() < 0.18 ? `R(${++k})` : FR[Math.floor(r() * FR.length)];
  return out;
}
const rand = rng(SEED);
const corpus = [...hand];
for (let i = 0; i < N; i++) corpus.push(randomCase(rand));
// a second stream made mostly of the comment / script / raw-text machinery, to reach the deep states
const DEEP = ["<!--", "-->", "--!>", "<script>", "</script>", "<script>R(1)", "<style>", "</style>", "<title>", "</title>", "<!--", "<script", ">", "R(2)", "-", "--", "<", "!", "/", " ", "<!-->", "<!--->", "<textarea>", "</textarea>", "<noscript>", "</noscript>", "x"];
for (let i = 0; i < Math.floor(N / 2); i++) { const len = 2 + Math.floor(rand() * 10); let s = ""; for (let j = 0; j < len; j++) s += DEEP[Math.floor(rand() * DEEP.length)]; corpus.push(s); }

// ───────────── browser side ─────────────
const page = await browser.newPage();
await page.goto("about:blank");
async function inBrowser(cases) {
  return page.evaluate(async (cases) => {
    const out = [];
    for (const html of cases) {
      const f = document.createElement("iframe");
      document.body.appendChild(f);
      const w = f.contentWindow, d = f.contentDocument;
      const ran = [];
      d.open(); w.R = (k) => ran.push(k); d.write(html); d.close();
      const scripts = [];
      const walk = (root) => { for (const s of root.querySelectorAll("script")) scripts.push({ src: s.hasAttribute("src"), text: s.textContent, srcv: s.getAttribute("src"), type: s.getAttribute("type") }); for (const t of root.querySelectorAll("template")) walk(t.content); };
      walk(d);
      let comments = 0;
      // Chromium makes a ProcessingInstruction (type 7) of <?x>
      const cw = (node) => { for (let c = node.firstChild; c; c = c.nextSibling) { if (c.nodeType === 8 || c.nodeType === 7) comments++; cw(c); if (c.nodeName === "TEMPLATE") cw(c.content); } };
      cw(d);
      out.push({ scripts, comments, ran });
      f.remove();
    }
    return out;
  }, cases);
}
let bad = 0, checked = 0, ambig = 0, shown = 0;
const fail = (m, html, extra) => { bad++; if (shown++ < 15) console.error(`  FAIL ${m}\n       html: ${JSON.stringify(html)}\n       ${extra}`); };
const BATCH = 100;
for (let at = 0; at < corpus.length; at += BATCH) {
  const part = corpus.slice(at, at + BATCH);
  const got = await inBrowser(part);
  part.forEach((html, j) => {
    const b = got[j];
    for (const [label, scan] of [["storefront", scanStore], ["admin", scanAdmin]]) {
      const r = scan(html);
      if (r.ambiguous.length) { ambig++; continue; }
      checked++;
      const mine = r.scripts.filter((s) => !s.eofInTag).map((s) => ({ src: s.attrs.has("src"), text: s.text, srcv: s.attrs.has("src") ? s.attrs.get("src") : null, type: s.attrs.has("type") ? s.attrs.get("type") : null }));
      const theirs = b.scripts.map((s) => ({ src: s.src, text: s.text, srcv: s.srcv, type: s.type }));
      if (JSON.stringify(mine) !== JSON.stringify(theirs)) { fail(`${label}: script elements differ`, html, `scanner: ${JSON.stringify(mine)}\n       browser: ${JSON.stringify(theirs)}`); continue; }
      const nComments = r.tokens.filter((t) => t.type === "comment").length;
      if (nComments !== b.comments) { fail(`${label}: comment count differs`, html, `scanner ${nComments}, browser ${b.comments}`); continue; }
      const inline = r.scripts.filter((s) => !s.attrs.has("src")).map((s) => s.text).join("\n");
      for (const k of b.ran) if (!inline.includes(`R(${k})`)) { fail(`${label}: a script ran that the scanner did not report as inline`, html, `ran R(${k})`); break; }
    }
  });
}
// the ambiguous elements must always be reported
for (const h of hand.filter((x) => /<(svg|math|select|frameset)/.test(x))) if (!scanStore(h).ambiguous.length) fail("ambiguous element not reported", h, "");
console.log(`html-scan differential: ${corpus.length} cases (seed ${SEED}), ${checked} scanner comparisons, ${ambig} ambiguous skipped, ${bad} mismatches`);
await browser.close();
if (bad) { console.error("FAILED"); process.exit(1); }
console.log("  ok  scanner equals the browser on every case");
