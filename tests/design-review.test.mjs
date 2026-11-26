// D14 (PR2 of the T1-T4 design history, v0.5.0 unreleased): the decision is recorded, exactly three ctx.actions and nothing else were
// added to ctx, the five fixed warnings are in place with the approved texts, the review code never logs or injects HTML, and the real
// Chromium test of the review dialog runs (it skips cleanly without Playwright). Template-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { TEMPLATE } from './helpers.mjs';

const f = (p) => readFileSync(path.join(TEMPLATE, p), 'utf8').replace(/\r\n/g, '\n');
const code = (p) => f(p).split('\n').filter((l) => !['//', '/*', '*'].some((c) => l.trim().startsWith(c))).join('\n');

test('D14 is recorded whole in docs/DECISIONS.md, newest first, and names the approvals and what is not in PR2', () => {
  const lines = f('docs/DECISIONS.md').split('\n');
  const ids = lines.map((l) => /^### (D\d+)\./.exec(l)).filter(Boolean).map((m) => m[1]);
  assert.equal(ids[0], 'D14');
  assert.equal(new Set(ids).size, ids.length);
  const start = lines.findIndex((l) => l.startsWith('### D14.'));
  let end = lines.findIndex((l, i) => i > start && /^##/.test(l)); if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n');
  for (const n of ['openDesignReview', 'requestDesignRevert', 'cancelDesignRequest', 'approveDesign', 'approveRevert', 'rejectDesign', 'cancelDesign', 'revertDesign', 'WARNED_CONFIRM_IDS', 'checkbox, not a password', 'blobs', 'head_moved', 'Not in this PR', 'clearReviewBasis']) assert.ok(body.includes(n), n);
  assert.match(body.trim(), /\.$/, 'ends with a full stop (not cut off)');
});

test('CORE-CHANGELOG describes step 2 under the unreleased v0.5.0; template.json is NOT bumped', () => {
  const log = f('docs/CORE-CHANGELOG.md');
  assert.match(log, /^## v0\.5\.0 \(UNRELEASED/m);
  assert.ok(log.includes('Design history, step 2 of 4 (decision D14'));
  assert.equal(JSON.parse(f('template.json')).version, '0.4.2');
});

test('ctx: exactly the three actions were added; ctx.ui and every other namespace is unchanged', () => {
  const api = JSON.parse(f('admin/lib/public-api.json'));
  for (const n of ['openDesignReview', 'requestDesignRevert', 'cancelDesignRequest']) assert.ok(api['ctx.actions'].includes(n), n);
  assert.equal(api['ctx.actions'].length, 35, 'the 32 actions of v0.4.2 plus exactly three');
  assert.equal(api['ctx.data'].length, 37);
  assert.ok(!api['ctx.ui'].some((n) => /design|review|shot|image/i.test(n)), 'no ui function for screenshots or the review');
  assert.equal(api.ctx.length, 20);
  const doc = f('admin/docs/DESIGN-LAYER.md');
  for (const n of ['openDesignReview(requestId)', 'requestDesignRevert(requestId', 'cancelDesignRequest(requestId)']) assert.ok(doc.includes('`' + n), n);
});

test('the five fixed warnings carry the approved texts, are in WARNED_CONFIRM_IDS, and the dialog title / button labels are core text with no copy key', async () => {
  const { FIXED_WARNINGS } = await import('../admin/core/warnings.js');
  const { WARNED_CONFIRM_IDS } = await import('../admin/lib/design-schema.js');
  const want = {
    approveDesign: '核准後，這次的設計改動會在數分鐘內對所有{siteName}使用者上線，無法在這裡撤回；要回到舊版，只能再提出一個「還原」請求並再次核准。你核准的是畫面上這個版本（{sha}、{n} 個檔案），之後若有新版本需要重新審閱。',
    approveRevert: '核准後，{siteName}會在數分鐘內換回「{tag}」這個舊版設計，所有人立刻看到。內容文件不受影響；舊設計若讀不到現在的內容，會顯示預設文案。要再換回來，需要再提出一個還原請求。',
    rejectDesign: '拒絕後這次改版就結束，這個版本不會上線，也無法重新開啟；想繼續要重新提出需求。如果只是想請 AI 再調整，請改按「要求修改」。',
    cancelDesign: '取消後這次改版就結束，進行中的預覽會被丟棄，無法重新開啟。',
    revertDesign: '這只會建立一個新的還原請求，不會馬上改變{siteName}；之後仍要通過檢查、預覽，並由你再次核准才會上線。內容文件不受影響，也不會重新註冊內容結構。',
  };
  for (const [id, text] of Object.entries(want)) {
    assert.equal(FIXED_WARNINGS[id], text, id);
    assert.ok(WARNED_CONFIRM_IDS.includes(id), id);
    for (const part of ['title', 'text', 'yes']) { const k = `confirm.${id}.${part}`; assert.ok(!f('admin/design-defaults/copy.js').includes(`"${k}"`) && !f('admin/design/copy.js').includes(`"${k}"`), `${k} must NOT be a copy key (core text)`); }
    assert.ok(!new RegExp(`confirm\\.${id}\\.(warn|message)`).test(f('admin/design-defaults/copy.js') + f('admin/design/copy.js')), `${id} has no warning or message copy key`);
  }
  assert.equal(WARNED_CONFIRM_IDS.length, 14 + 5);
});

test('review code: no console output, no HTML injection, nothing that can put a signed URL into storage, an address or a log', () => {
  for (const p of ['admin/ui/design-review.js', 'admin/core/design-actions.js', 'admin/lib/design-review.js']) {
    const c = code(p);
    assert.ok(!/console\./.test(c), `${p} must not log`);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(c), `${p} must not inject HTML`);
    assert.ok(!/localStorage|sessionStorage|\bhistory\.(push|replace)State|\blocation\.|document\.cookie|postMessage/.test(c), `${p} must not store or publish anything`);
  }
  const ui = code('admin/ui/design-review.js');
  assert.match(ui, /ev\.isTrusted === true/, 'buttons ignore untrusted events');
  assert.match(ui, /URL\.revokeObjectURL/);
  assert.match(code('admin/lib/design-review.js'), /cache: "no-store", referrerPolicy: "no-referrer", credentials: "omit", redirect: "error"/);
  assert.ok(!/reviewBasis|clearReviewBasis/.test(code('admin/core/context.js')) && !/reviewBasis/.test(code('admin/core/data.js')), 'the basis is not reachable from ctx');
  assert.match(code('admin/lib/session.js'), /clearReviewBasis\(\)/);
});

test('design review in a real Chromium (skips cleanly without Playwright)', { timeout: 290000 }, () => {
  const r = spawnSync(process.execPath, [path.join(TEMPLATE, 'admin', 'e2e', 'design-review.mjs')], { encoding: 'utf8', timeout: 280000 });
  process.stdout.write(r.stdout || '');
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
});

test('hardening: the five confirmations have CORE titles and labels; the core dialogs are closed shadow roots; showDialog is refused meanwhile', async () => {
  const { CORE_TEXT, CORE_CONFIRM_IDS } = await import('../admin/lib/fixed-text.js');
  for (const id of ['approveDesign', 'approveRevert', 'rejectDesign', 'cancelDesign', 'revertDesign']) {
    assert.ok(CORE_CONFIRM_IDS.includes(id), id);
    assert.equal(typeof CORE_TEXT['cf.' + id + '.title'], 'string');
    assert.equal(typeof CORE_TEXT['cf.' + id + '.yes'], 'string');
  }
  const kit = f('admin/ui/kit.js');
  assert.match(kit, /attachShadow\(\{ mode: "closed" \}\)/);
  assert.match(kit, /adoptedStyleSheets/);
  assert.match(kit, /\["all", "initial"\]/);
  assert.match(kit, /coreDialogsOpen > 0\) \{ console\.warn\("\[design\] ui\.showDialog refused/);
  assert.match(kit, /showCoreDialog\(\{\s*title,/, 'confirmDialog uses the core dialog');
  assert.match(f('admin/ui/design-review.js'), /showCoreDialog\(\{/);
  const css = f('admin/ui/core-dialog-css.js');
  const { buildCoreCss } = await import('../admin/ui/core-dialog-css.js');
  const { resolveTheme } = await import('../admin/ui/core-theme.js');
  const built = buildCoreCss(resolveTheme({ color: () => null, raw: () => '' }));
  assert.ok(!/var\(|(^|[\s;{(,])--[a-z]/.test(built) && !/\{[a-z-]+\}/.test(built.replace(/@media[^{]*\{/g, '')), 'the built stylesheet has no var(), no custom property and no unreplaced marker: only validated literals');
  assert.ok(!/(^|[\s;{])content\s*:/m.test(css.split('\n').filter((l) => !l.startsWith('//')).join('\n')), 'no generated content in the core dialog stylesheet');
});

test('hardening: ADMIN_UPLOAD_ORIGIN covering the signed screenshot host is documented in D14, the README, the nginx template and the onboarding docs', () => {
  for (const [p, re] of [['docs/DECISIONS.md', /ADMIN_UPLOAD_ORIGIN MUST cover that host/], ['admin/README.md', /ADMIN_UPLOAD_ORIGIN.{1,3}必須同時涵蓋/], ['admin/deploy/nginx.conf.template', /MUST ALSO COVER THE HOST OF THE PLATFORM/],
    ['.claude/skills/merchant-onboarding/references/checklist.md', /signed design-review screenshot URLs/], ['.claude/skills/merchant-onboarding/references/env-reference.md', /signed design-review screenshot host/]]) assert.match(f(p), re, p);
});

test('core theme: muted text passes 4.5:1 on the card AND the band, a dark card gets a readable red, a pastel brand colour is moved along its hue', async () => {
  const { resolveTheme, contrast, DEFAULTS } = await import('../admin/ui/core-theme.js');
  const theme = (tokens, raw = {}) => resolveTheme({ color: (n) => tokens[n] || null, raw: (n) => raw[n] || '' });
  // the defaults
  let t = theme({});
  assert.deepEqual(t.ink, DEFAULTS.ink);
  for (const [name, c] of [['muted', t.muted], ['soft', t.soft], ['ink', t.ink]]) assert.ok(contrast(c, t.card) >= 4.5 && contrast(c, t.band) >= 4.5, name + ' on card and band');
  // a validated pair that is exactly at the 7:1 limit: the old 70% mix gave about 3.4:1
  t = theme({ '--ink': [89, 89, 89], '--card': [255, 255, 255] });
  assert.ok(contrast(t.ink, t.card) >= 7);
  for (const c of [t.muted, t.soft]) assert.ok(contrast(c, t.card) >= 4.5 && contrast(c, t.band) >= 4.5, 'muted at the 7:1 limit');
  // a dark design without --error: the red is lightened along its hue until it reads
  t = theme({ '--ink': [240, 240, 240], '--card': [18, 18, 24] });
  assert.ok(contrast(t.err, t.card) >= 3 && t.errText && contrast(t.errText, t.err) >= 4.5, 'dark card: readable red with a readable label');
  assert.ok(t.err[0] > t.err[1] + 30 && t.err[0] > t.err[2] + 30, 'it is still a red');
  assert.ok(contrast(t.prim, t.card) >= 3 && t.primText && contrast(t.primText, t.prim) >= 4.5, 'dark card: readable primary');
  for (const c of [t.muted, t.soft]) assert.ok(contrast(c, t.card) >= 4.5 && contrast(c, t.band) >= 4.5, 'dark card muted');
  // a pastel brand colour on a cream card (about 2:1): the nearest passing shade of the SAME hue, not the default
  t = theme({ '--brand-primary': [201, 164, 106], '--card': [247, 244, 238], '--ink': [30, 30, 30] });
  assert.ok(contrast(t.prim, t.card) >= 3 && contrast(t.primText, t.prim) >= 4.5, 'pastel primary now passes');
  assert.ok(t.prim[0] > t.prim[1] && t.prim[1] > t.prim[2], 'still the brand (warm) hue, not the default grey');
  assert.notDeepEqual(t.prim, DEFAULTS.prim);
  // hostile or broken tokens read as defaults
  t = theme({ '--ink': [250, 250, 250], '--card': [255, 255, 255], '--error': [255, 255, 255] });
  assert.deepEqual(t.ink, DEFAULTS.ink); assert.deepEqual(t.card, DEFAULTS.card); assert.ok(contrast(t.err, t.card) >= 3);
  t = theme({}, { '--r-sm': '400px', '--r-lg': '9px', '--f-sans': 'Some Named Font, serif' });
  assert.equal(t.rsm, DEFAULTS.rsm); assert.equal(t.rlg, '9px'); assert.equal(t.font, DEFAULTS.font);
  assert.equal(theme({}, { '--f-sans': 'serif' }).font, 'serif');
  // the approve (danger) and the primary button never collapse into the card or each other's label
  t = theme({ '--brand-primary': [255, 255, 255], '--error': [255, 255, 255] });
  assert.ok(contrast(t.prim, t.card) >= 3 && contrast(t.err, t.card) >= 3);
});
