// FIXED, core-owned wording that has a copy key only so the built-in views can show it with ctx.t(). The text lives HERE,
// not in design/copy.js: lib/design.js t() always answers with this table for these keys and drops any override
// from design/copy.js (with a console warning), and loadDesign() fails closed when the built-in copy disagrees with
// it. Changing a text is a human-reviewed core change (.claude/skills/core-change), like the fixed warnings in core/warnings.js.
// It imports nothing.
export const FIXED_COPY = Object.freeze({
  // Shown next to every "preview this version" button (decided with the platform change design-history, D25 point 11).
  "vp.limits": "版本預覽是用「目前的核心與目前的資料」即時畫出來、用來幫你決定的畫面，不是那一版當時被核准內容的紀錄：它可能和那一版當時的樣子不同，會在到期後消失，也不會被保存。歷史紀錄以並排截圖為準。預覽是唯讀的，不能儲存任何變更。",
});
