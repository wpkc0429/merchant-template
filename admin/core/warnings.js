// FIXED WARNINGS for the confirmation of irreversible actions. CORE-OWNED and LOCKED (hash manifest).
//
// Each irreversible action's confirm dialog is composed of:
//   * an editable part from design/copy.js: confirm.<id>.title, confirm.<id>.text (lead-in, may be empty), the button labels
//   * the FIXED warning below, which the dialog always renders (ui/kit.js confirmDialog({warning}))
// The warning is deliberately NOT in design-defaults/copy.js or design/copy.js and has no copy key, so a design
// cannot weaken, reword or remove it: lib/design-schema.js validateCopy() rejects any attempt to define one, and
// scripts/check-design.mjs fails on it. Changing a warning is a human-reviewed core change (.claude/skills/core-change).
// {name} placeholders are filled from the same params the action passes to its copy.
import { WARNED_CONFIRM_IDS } from "../lib/design-schema.js";

const W = {
  cancelOrder: "庫存會歸還，取消後無法復原。",
  shipDelivered: "出貨 #{id} 標記為已送達後無法再變更。",
  shipReturned: "出貨 #{id} 標記為退貨後，這筆訂單已核發的點數會全部扣回（即使這箱只裝了部分品項），而且這筆訂單之後不能再建立任何出貨。退貨無法復原。",
  deleteProduct: "商品、規格與所有照片都會被刪除，無法復原。",
  deleteImage: "刪除後無法復原，前台會立即不再顯示。",
  deleteCategory: "刪除後無法復原。",
  disableMember: "{email} 會立刻無法使用本店後台（他下一個動作就會被登出）。之後可以再啟用。",
  revokeInvite: "撤回後，寄給 {email} 的邀請連結會立刻失效。",
  publishContent: "發佈後，這份內容會出現在公開的店面上（瀏覽器快取最多再延遲約 1 分鐘）。",
  unpublishContent: "下架後，店面這一塊會改回預設文案；草稿與版本歷史仍會保留。",
  deleteContent: "這份內容與它的版本歷史會被永久刪除，無法復原。",
  restoreContent: "只會把這個版本放回草稿，不會發佈；目前的草稿內容會被取代。",
  registerContentSchema: "內容結構會改成這份檔案的版本，之後所有內容文件都依它驗證。這是店主的操作，不能由 AI 或自動化代為進行。",
  registerContentSchemaRemovals: "這份檔案會讓上面列出的欄位值不再顯示，或讓文件失去類型。值會留在版本快照裡，但店面不會再讀到它們。確認後才會送出。",
  // design history (T1-T4 PR2, D14; wording approved by the owner 2026-11-27)
  approveDesign: "核准後，這次的設計改動會在數分鐘內對所有{siteName}使用者上線，無法在這裡撤回；要回到舊版，只能再提出一個「還原」請求並再次核准。你核准的是畫面上這個版本（{sha}、{n} 個檔案），之後若有新版本需要重新審閱。",
  approveRevert: "核准後，{siteName}會在數分鐘內換回「{tag}」這個舊版設計，所有人立刻看到。內容文件不受影響；舊設計若讀不到現在的內容，會顯示預設文案。要再換回來，需要再提出一個還原請求。",
  rejectDesign: "拒絕後這次改版就結束，這個版本不會上線，也無法重新開啟；想繼續要重新提出需求。如果只是想請 AI 再調整，請改按「要求修改」。",
  cancelDesign: "取消後這次改版就結束，進行中的預覽會被丟棄，無法重新開啟。",
  revertDesign: "這只會建立一個新的還原請求，不會馬上改變{siteName}；之後仍要通過檢查、預覽，並由你再次核准才會上線。內容文件不受影響，也不會重新註冊內容結構。",
};
export const FIXED_WARNINGS = Object.freeze(W);

/** The confirm ids (the `<id>` in confirm.<id>.*) that carry a fixed warning. */
export const WARNED_CONFIRMS = Object.freeze([...WARNED_CONFIRM_IDS]);

/** The fixed warning text for a warning id, placeholders filled. Throws on an unknown id (a programming error, never silent). */
// Every warned confirmation must have a fixed warning, and vice versa (checked when the module loads).
for (const id of WARNED_CONFIRM_IDS) if (!W[id]) throw new Error(`core/warnings.js: no fixed warning for ${id}`);
for (const id of Object.keys(W)) if (!WARNED_CONFIRM_IDS.includes(id)) throw new Error(`core/warnings.js: ${id} is not in WARNED_CONFIRM_IDS`);

export function fixedWarning(id, params = {}) {
  const s = W[id];
  if (typeof s !== "string" || !s) throw new Error(`no fixed warning for "${id}"`);
  return s.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}
