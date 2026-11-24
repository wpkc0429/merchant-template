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
