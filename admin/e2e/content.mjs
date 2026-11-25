// E2E for the content screens (platform content store): schema dry run and registration through the confirmation dialog,
// editing, optimistic lock (412), publish, revisions and restore-to-draft, preview tab, gating for the editor and staff roles,
// 390 / 1280 layout. Run by e2e/run.mjs, or alone: node e2e/content.mjs. THROWAWAY stack only (README "測試"): the schema of
// the demo shop IS registered here (the human-in-the-loop step, done through the same dialog a store owner uses).
//
// Needs: the storefront's public/content.schema.json (served same-origin by scripts/serve.mjs), admin/config.local.js from the
// example (siteOrigin), the sample platform demo seed, `node e2e/setup.mjs` done.
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadPlaywright, SITE, OUT, OWNER, STAFF, API, req, apiLogin, ensureEditor, check, section, failureCount } from "./lib.mjs";
import { PUBLISHABLE_KEY } from "./data.mjs";

mkdirSync(OUT, { recursive: true });
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const T = (page, id) => page.locator(`[data-testid="${id}"]`);
const F = (page, ptr) => page.locator(`[data-testid="cf:${ptr}"]`);
const runId = Date.now().toString(36);
const shot = async (page, name) => { await page.waitForTimeout(300); await page.screenshot({ path: resolve(OUT, `content-${name}.png`), fullPage: true }); };
const overflow = (page) => page.evaluate(() => { const w = window.innerWidth; let worst = document.documentElement.scrollWidth - w; for (const el of document.querySelectorAll("body *")) { if (el.closest("svg") || el.closest("dialog:not([open])")) continue; const r = el.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(el).position === "fixed") continue; worst = Math.max(worst, Math.ceil(r.right - w), Math.ceil(-r.left)); } return worst; });

async function newPage(w = 1280, h = 860, creds = OWNER) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  page.errors = [];
  page.puts = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/status of (401|404|403|409|412|422)/.test(m.text())) page.errors.push(m.text()); });
  page.on("request", (r) => { if (r.method() === "PUT" && /\/content\/documents\//.test(r.url())) page.puts.push(r.url()); });
  await page.goto(SITE + "/#/login");
  await T(page, "login-email").fill(creds.email);
  await T(page, "login-password").fill(creds.password);
  await T(page, "login-submit").click();
  await page.locator(".shell").waitFor();
  return page;
}
async function waitToast(page, re) {
  await page.waitForFunction((s) => [...document.querySelectorAll(".toast")].some((t) => new RegExp(s).test(t.textContent)), re.source, { timeout: 10000 })
    .catch(async () => { throw new Error(`toast ${re} not seen: ${JSON.stringify(await page.locator(".toast").allInnerTexts())}`); });
}
const clearToasts = (page) => page.evaluate(() => document.querySelectorAll(".toast").forEach((t) => t.remove()));
const openDoc = async (page, key) => { await page.goto(`${SITE}/#/content/${key}`); await T(page, "content-form").waitFor(); await page.waitForTimeout(200); };
/** Confirms the core's dialog (it always shows the fixed warning); returns the warning text. */
async function confirmDialog(page, { yes = true } = {}) {
  const dlg = page.locator("dialog[open]");
  await dlg.waitFor();
  const warning = await T(page, "confirm-warning").innerText();
  if (yes) await T(page, "confirm-yes").click(); else await dlg.getByRole("button", { name: "取消" }).click();
  await dlg.waitFor({ state: "detached" });
  return warning;
}
const publicDoc = async (key) => {
  const r = await fetch(`${API}/api/v1/shop/content/${key}`, { headers: { "X-Publishable-Key": PUBLISHABLE_KEY, "Cache-Control": "no-cache" } });
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
};

const ownerToken = await apiLogin(OWNER);
const editorCreds = await ensureEditor(ownerToken, runId);

// ───────────────────────────────────────────────────────────────────────
section("C1. Schema screen: dry run is read-only, registration needs the owner's confirmation in the core's dialog");
{
  const page = await newPage();
  check("the owner sees the content entry in the navigation", (await T(page, "nav-content").count()) > 0);
  await page.goto(SITE + "/#/content-schema");
  await T(page, "schema-status").waitFor();
  await page.waitForTimeout(500);
  const before = await req("GET", "/admin/shops/1/content/schema/versions", { token: ownerToken });
  const versionsBefore = before.json?.versions?.length ?? 0;
  await T(page, "schema-dryrun").click();
  await T(page, "schema-dryrun-summary").waitFor();
  check("the dry run shows a report", (await T(page, "schema-dryrun-report").innerText()).length > 0);
  const after = await req("GET", "/admin/shops/1/content/schema/versions", { token: ownerToken });
  check("the dry run registered nothing (version count unchanged)", (after.json?.versions?.length ?? 0) === versionsBefore);
  await shot(page, "schema-1280");

  const alreadySame = /相同/.test(await T(page, "schema-dryrun-summary").innerText()); // a rerun on the same throwaway DB: nothing to register
  if (!alreadySame) {
    // cancel first: nothing is registered
    await T(page, "schema-register").click();
    const warning = await confirmDialog(page, { yes: false });
    check("the registration dialog carries the core's fixed warning", /店主|AI|自動化/.test(warning), warning);
    await page.waitForTimeout(400);
    const cancelled = await req("GET", "/admin/shops/1/content/schema/versions", { token: ownerToken });
    check("cancelling the dialog registers nothing", (cancelled.json?.versions?.length ?? 0) === versionsBefore);
  }
  // now confirm (a second dialog may follow when the platform wants the removals confirmed)
  await clearToasts(page);
  await T(page, "schema-register").click();
  if (!alreadySame) {
    await page.locator("dialog[open]").waitFor();
    check("the dialog shows the dry-run report as plain text next to the fixed warning", (await T(page, "confirm-detail").count()) === 1 && (await T(page, "confirm-warning").count()) === 1);
    await T(page, "confirm-yes").click();
    await page.waitForTimeout(800);
    if (await page.locator("dialog[open]").count()) {
      check("a second explicit confirmation is asked when removals need confirming", (await T(page, "confirm-warning").innerText()).length > 0);
      await T(page, "confirm-yes").click();
    }
  }
  await waitToast(page, /已註冊為|不需要註冊/);
  const reg = await req("GET", "/admin/shops/1/content/schema", { token: ownerToken });
  check("the shop now has the template's format-2 schema registered", reg.status === 200 && reg.json.format === 2 && !!reg.json.schema.types.home, JSON.stringify(reg.json)?.slice(0, 80));
  await page.goto(SITE + "/#/content");
  await T(page, "content-row").first().waitFor();
  const keys = await T(page, "content-row").evaluateAll((els) => els.map((e) => e.dataset.key));
  check("the documents the schema declares are listed (global, home, story, faq, product-info)", ["global", "home", "story", "faq", "product-info"].every((k) => keys.includes(k)), keys.join(","));
  check("no page errors on the schema and list screens", page.errors.length === 0, page.errors.join("|"));
  await page.context().close();
}

// ───────────────────────────────────────────────────────────────────────
section("C2. Edit, validate, save, publish (the storefront API serves it)");
const TITLE = `標題 ${runId}`;
{
  const page = await newPage();
  await openDoc(page, "home");
  const rev0 = Number(await T(page, "content-rev").getAttribute("data-rev"));
  check("the editor opens with fields built from the schema (hero title is a textarea)", (await F(page, "/hero/title").count()) === 1 && (await F(page, "/hero/eyebrow").count()) === 1);
  // client-side validation: too long -> shown on the field, nothing is sent
  await F(page, "/hero/eyebrow").fill("x".repeat(150));
  await T(page, "content-save").click();
  await page.waitForTimeout(400);
  check("an over-long value is refused by the core's validation, on that field, with no request", (await page.locator('.field[data-pointer="/hero/eyebrow"].has-error').count()) === 1 && page.puts.length === 0);
  await F(page, "/hero/eyebrow").fill("NEW COLLECTION");
  await F(page, "/hero/title").fill(TITLE);
  await clearToasts(page);
  await T(page, "content-save").click();
  await waitToast(page, /草稿已儲存/);
  check("saving bumps the draft revision and rebuilds the form from the server's response", Number(await T(page, "content-rev").getAttribute("data-rev")) === rev0 + 1 && (await F(page, "/hero/title").inputValue()) === TITLE);
  check("the draft is not public yet (unpublished or old content)", (await publicDoc("home")).json?.content?.hero?.title !== TITLE);
  await clearToasts(page);
  await T(page, "content-publish").click();
  const warning = await confirmDialog(page);
  check("publishing asks for confirmation with a fixed warning", /店面/.test(warning), warning);
  await waitToast(page, /已發佈/);
  const pub = await publicDoc("home");
  check("the public /shop/content/home now serves the edited title", pub.status === 200 && pub.json.content.hero.title === TITLE, JSON.stringify(pub.json?.content?.hero));
  await shot(page, "editor-home-1280");
  check("no page errors while editing", page.errors.length === 0, page.errors.join("|"));
  await page.context().close();
}

// ───────────────────────────────────────────────────────────────────────
section("C3. Lists: add, reorder, remove items (the story paragraphs, the FAQ question/answer blocks)");
{
  const page = await newPage();
  await openDoc(page, "faq");
  const n0 = await T(page, "cf-item").count();
  await page.locator('[data-testid="cf-add:/items"]').click();
  check("adding an item appends a block", (await T(page, "cf-item").count()) === n0 + 1);
  await F(page, `/items/${n0}/q`).fill("Q new");
  await F(page, `/items/${n0}/a`).fill("A new");
  await T(page, "cf-item-up").last().click();
  check("moving the last item up renumbers the pointers", (await F(page, `/items/${n0 - 1}/q`).inputValue()) === "Q new");
  await clearToasts(page);
  await T(page, "content-save").click();
  await waitToast(page, /草稿已儲存/);
  check("the saved FAQ contains the new item at the new position", (await F(page, `/items/${n0 - 1}/q`).inputValue()) === "Q new");
  await T(page, "cf-item-remove").nth(n0 - 1).click();
  check("removing an item drops its block", (await T(page, "cf-item").count()) === n0);
  await T(page, "content-save").click();
  await waitToast(page, /草稿已儲存/);
  await page.context().close();
}

// ───────────────────────────────────────────────────────────────────────
section("C4. Optimistic lock: a second session saved first -> 412 -> reload prompt, nothing overwritten");
{
  const a = await newPage();
  const b = await newPage();
  await openDoc(a, "story");
  await openDoc(b, "story");
  await F(a, "/eyebrow").fill(`A ${runId}`);
  await clearToasts(a);
  await T(a, "content-save").click();
  await waitToast(a, /草稿已儲存/);
  await F(b, "/eyebrow").fill(`B ${runId}`);
  await T(b, "content-save").click();
  await T(b, "content-stale").waitFor();
  check("a stale save shows the 'updated by someone else' prompt", /別人更新|重新載入/.test(await T(b, "content-stale").innerText()));
  await T(b, "content-stale-reload").click();
  await b.waitForTimeout(500);
  check("reloading shows the other session's value (the stale save did not overwrite it)", (await F(b, "/eyebrow").inputValue()) === `A ${runId}`);
  check("no page errors from the 412 flow", b.errors.length === 0, b.errors.join("|"));
  await a.context().close();
  await b.context().close();
}

// ───────────────────────────────────────────────────────────────────────
section("C5. Revisions and restore: a restore only puts the version back into the DRAFT");
{
  const page = await newPage();
  await openDoc(page, "home");
  const TITLE2 = `第二版 ${runId}`;
  await F(page, "/hero/title").fill(TITLE2);
  await clearToasts(page);
  await T(page, "content-save").click();
  await waitToast(page, /草稿已儲存/);
  await T(page, "content-publish").click();
  await confirmDialog(page);
  await waitToast(page, /已發佈/);
  await page.goto(`${SITE}/#/content/home/revisions`);
  await T(page, "rev-row").first().waitFor();
  const rows = await T(page, "rev-row").count();
  check("each publish left a revision", rows >= 2, String(rows));
  await shot(page, "revisions-1280");
  const pubRows = T(page, "rev-row").filter({ hasText: "發佈" });
  await pubRows.last().locator('[data-testid="rev-view"]').click();
  await T(page, "rev-content").waitFor();
  check("a revision can be viewed read-only", (await T(page, "rev-content").locator("input:not([disabled]), textarea:not([disabled])").count()) === 0);
  await page.keyboard.press("Escape");
  await page.locator("dialog[open]").waitFor({ state: "detached" });
  await pubRows.nth(1).locator('[data-testid="rev-restore"]').click();
  const warning = await confirmDialog(page);
  check("restoring asks first, and its fixed warning says it is only a draft", /草稿/.test(warning) && /不會發佈/.test(warning), warning);
  await T(page, "content-restored").waitFor();
  check("the screen says: restored to draft, not published yet", /尚未發佈/.test(await T(page, "content-restored").innerText()));
  const stillPublic = await publicDoc("home");
  check("the public content is unchanged by the restore (still the newest published version)", stillPublic.json.content.hero.title === TITLE2, stillPublic.json?.content?.hero?.title);
  await T(page, "content-restored-edit").click();
  await T(page, "content-form").waitFor();
  check("the editor now holds the restored draft (the first version's title)", (await F(page, "/hero/title").inputValue()) === TITLE, await F(page, "/hero/title").inputValue());
  await page.context().close();
}

// ───────────────────────────────────────────────────────────────────────
section("C6. Preview opens the storefront with a short-lived token (the token is not in the admin URL)");
{
  const page = await newPage();
  await openDoc(page, "home");
  const seen = [];
  page.context().on("request", (r) => { if (/content_preview=/.test(r.url())) seen.push(r.url()); });
  const popup = page.context().waitForEvent("page", { timeout: 15000 });
  await T(page, "content-preview").click();
  const tab = await popup;
  await tab.waitForLoadState("load").catch(() => {});
  await page.waitForTimeout(1500);
  // the storefront removes the token from its own URL (history.replaceState) once read, so assert on the request
  check("a new tab requests {siteOrigin}/?content_preview=<token>", seen.some((u) => /^http:\/\/localhost:8788\/\?content_preview=[^&]+/.test(u)), JSON.stringify(seen));
  check("the admin page URL carries no token", !/content_preview/.test(page.url()));
  await tab.close().catch(() => {});
  await page.context().close();
}

// ───────────────────────────────────────────────────────────────────────
section("C7. Gating: editor (view + edit) and staff (nothing)");
{
  const ed = await newPage(1280, 860, editorCreds);
  check("the editor sees the content entry", (await T(ed, "nav-content").count()) > 0);
  await openDoc(ed, "home");
  check("the editor can edit and save", (await T(ed, "content-save").count()) === 1);
  check("the editor has no publish, unpublish or delete buttons", (await T(ed, "content-publish").count()) === 0 && (await T(ed, "content-unpublish").count()) === 0 && (await T(ed, "content-delete").count()) === 0);
  await F(ed, "/hero/eyebrow").fill(`ED ${runId}`);
  await clearToasts(ed);
  await T(ed, "content-save").click();
  await waitToast(ed, /草稿已儲存/);
  check("an editor save succeeds", true);
  await ed.goto(SITE + "/#/content");
  await T(ed, "content-row").first().waitFor();
  check("the editor does not get the schema link", (await T(ed, "content-schema-link").count()) === 0);
  await ed.goto(SITE + "/#/content-schema");
  await ed.waitForTimeout(800);
  check("the schema screen is blocked for the editor (no dry run, no register)", (await T(ed, "schema-dryrun").count()) === 0 && (await T(ed, "schema-register").count()) === 0 && /沒有開啟這個功能|權限/.test(await ed.locator("body").innerText()));
  const edToken = await apiLogin(editorCreds);
  const pubTry = await req("POST", "/admin/shops/1/content/documents/home/publish", { token: edToken, body: {} });
  check("the API agrees: the editor cannot publish (403)", pubTry.status === 403, String(pubTry.status));
  const regTry = await req("PUT", "/admin/shops/1/content/schema?dry_run=true", { token: edToken, body: { format: 2, types: {} } });
  check("the API agrees: the editor cannot register or dry-run a schema (403)", regTry.status === 403, String(regTry.status));
  await shot(ed, "editor-1280");
  await ed.context().close();

  const st = await newPage(1280, 860, STAFF);
  check("staff sees no content entry", (await T(st, "nav-content").count()) === 0);
  await st.goto(SITE + "/#/content");
  await st.waitForTimeout(800);
  check("staff cannot open the content list (blocked by the core)", (await T(st, "content-list").count()) === 0 && (await T(st, "content-row").count()) === 0);
  await st.goto(SITE + "/#/content/home");
  await st.waitForTimeout(800);
  check("staff cannot open a document (no form)", (await T(st, "content-form").count()) === 0);
  await st.goto(SITE + "/#/content-schema");
  await st.waitForTimeout(800);
  check("staff cannot open the schema screen", (await T(st, "schema-register").count()) === 0);
  await st.context().close();
}

// ───────────────────────────────────────────────────────────────────────
section("C8. Layout at 390px and 1280px (no horizontal overflow)");
for (const [label, w, h] of [["phone", 390, 844], ["desktop", 1280, 860]]) {
  const page = await newPage(w, h);
  for (const [name, path, sel] of [["list", "/content", '[data-testid="content-row"]'], ["editor-home", "/content/home", '[data-testid="content-form"]'], ["editor-faq", "/content/faq", '[data-testid="content-form"]'], ["revisions", "/content/home/revisions", '[data-testid="rev-row"]'], ["schema", "/content-schema", '[data-testid="schema-active"]']]) {
    await page.goto(SITE + "/#" + path);
    await page.locator(sel).first().waitFor();
    await page.waitForTimeout(300);
    check(`${label} ${name}: no horizontal overflow`, (await overflow(page)) <= 0, String(await overflow(page)));
    await shot(page, `${label}-${name}`);
  }
  check(`no page errors (${label})`, page.errors.length === 0, page.errors.join("|"));
  await page.context().close();
}

await browser.close();
if (process.argv[1] && process.argv[1].endsWith("content.mjs")) {
  console.log(`\n${failureCount() === 0 ? "CONTENT E2E PASSED" : failureCount() + " FAILED"}`);
  process.exit(failureCount() ? 1 : 0);
}
