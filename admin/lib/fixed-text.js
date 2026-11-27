// FIXED, core-owned wording that has a copy key only so the built-in views can show it with ctx.t(). The text lives HERE,
// not in design/copy.js: lib/design.js t() always answers with this table for these keys and drops any override
// from design/copy.js (with a console warning), and loadDesign() fails closed when the built-in copy disagrees with
// it. Changing a text is a human-reviewed core change (.claude/skills/core-change), like the fixed warnings in core/warnings.js.
// It imports nothing.
export const FIXED_COPY = Object.freeze({
  // Shown next to every "preview this version" button (decided with the platform change design-history, D25 point 11).
  "vp.limits": "版本預覽是用「目前的核心與目前的資料」即時畫出來、用來幫你決定的畫面，不是那一版當時被核准內容的紀錄：它可能和那一版當時的樣子不同，會在到期後消失，也不會被保存。歷史紀錄以並排截圖為準。預覽是唯讀的，不能儲存任何變更。",
});

// Wording of the CORE-DRAWN design review dialog and its outcomes (T1-T4 PR2, D14). Unlike FIXED_COPY these have NO copy key at all
// (validateCopy rejects unknown keys), so a design layer cannot reword, relabel or swap "before" and "after". Only core/ and ui/ read it.
// {name} placeholders are filled by coreText().
export const CORE_TEXT = Object.freeze({
  "rv.thisShop": "本店",
  "rv.role.owner": "店主帳號", "rv.role.staff": "店員帳號", "rv.role.anon": "訪客",
  "rv.site.storefront": "店面", "rv.site.admin": "後台",
  "rv.kind.change": "改版", "rv.kind.revert": "還原",
  "rv.status.drafting": "修改中", "rv.status.previewing": "預覽中", "rv.status.awaiting_approval": "等待核准", "rv.status.approved": "已核准",
  "rv.status.published": "已發佈", "rv.status.rejected": "已拒絕", "rv.status.failed": "失敗", "rv.status.cancelled": "已取消", "rv.status.reverted": "已被還原",
  "rv.version": "版本 {sha}（{n} 個檔案）",
  "rv.noSha": "（沒有可核准的版本）",
  "rv.claims": "服務聲稱的內容（平台未驗證）",
  "rv.record": "平台的記錄",
  "rv.prompt": "需求原文",
  "rv.noPrompt": "（沒有需求原文，可能已超過保存期限）",
  "rv.files": "變更的檔案：{n} 個，+{add} -{del}",
  "rv.guard.pass": "守門員：通過（服務回報）", "rv.guard.fail": "守門員：未通過（服務回報）", "rv.guard.none": "守門員：沒有結果",
  // The scan report shown to the approver (D18): the service's own guard run, NOT verified by the platform.
  "rv.scan.heading": "掃描報告",
  "rv.scan.unverified": "守門員由服務自己執行，平台沒有驗證這份結果；它只是參考，不是保證。",
  "rv.scan.rules": "觸發的規則：{ids}", "rv.scan.noRules": "沒有觸發任何規則", "rv.scan.violations": "違規項目：{n} 個",
  "rv.scan.sha": "守門員檢查的版本：{sha}", "rv.scan.shaMismatch": "注意：守門員檢查的版本和這次要核准的版本不同，不能當作對這個版本的檢查結果。",
  "rv.scan.noSha": "守門員檢查的版本：（沒有）",
  "rv.scan.candidate": "要核准的版本：{sha}", "rv.scan.version": "守門員版本：{v}", "rv.scan.at": "檢查時間：{time}",
  "rv.scan.count": "共 {n} 個檔案被變更", "rv.scan.listed": "（只列出前 {m} 個）", "rv.scan.fileList": "完整的變更檔案清單（{m} 個，點一下展開）",
  "rv.delay": "為了避免誤按，這個按鈕 {s} 秒後才能使用。",
  "rv.delay.over": "等待時間已過，現在可以按下按鈕。",
  // Preview host (D18): the platform enforces read-only sessions there; these are the calm messages.
  "iso.disabled": "自訂設計已停用：這個瀏覽器或伺服器設定無法確保隔離，目前顯示的是內建畫面。功能不受影響；請聯絡管理員。",
  "pv.readOnly": "這是預覽畫面，不能在這裡修改。想編輯請回到正常的後台。",
  "pv.expired": "預覽已到期（預覽登入最長 30 分鐘），請重新登入。",
  "pv.scopeMissing": "這個網址沒有設定成預覽主機（平台沒有把它登記為預覽網域），所以不能在這裡登入。請聯絡管理員。",
  "rv.status": "狀態", "rv.approvedBy": "核准者", "rv.approvedAt": "核准時間", "rv.proposedBy": "提出者",
  "rv.shots.heading": "前後對照",
  "rv.shots.note": "截圖由服務擷取，不是證明：平台無法確認這些畫面真的來自這個版本。請同時開啟改版預覽，自己確認。",
  "rv.shots.view": "畫面", "rv.shots.viewport": "寬度", "rv.shots.mode": "顯示方式",
  "rv.shots.mode.single": "單張", "rv.shots.mode.side": "並排", "rv.shots.mode.slider": "滑桿",
  "rv.shots.before": "前", "rv.shots.after": "後",
  "rv.shots.sliderLabel": "拖曳比較前後（左邊是後、右邊是前）",
  "rv.shots.diff": "差異約 {pct}%（服務自報）",
  "rv.shots.loading": "載入截圖中…", "rv.shots.imageLoading": "圖片載入中…",
  "rv.shots.expired": "圖片已過期，按重試", "rv.shots.failed": "圖片載入失敗，按重試", "rv.shots.retry": "重試",
  "rv.shots.blocked": "無法載入截圖：網路問題，或截圖主機未被後台的安全設定（CSP）允許（需要管理員檢查 ADMIN_UPLOAD_ORIGIN）。按重試。",
  "rv.shots.purged": "此截圖已依保存期限清除", "rv.shots.missing": "這一側沒有截圖",
  "rv.shots.none": "還沒有可看的截圖（可能尚未上傳，或已超過保存期限）。",
  "rv.shots.notConfigured": "截圖儲存尚未設定，目前看不到截圖。",
  "rv.shots.error": "截圖清單載入失敗。",
  "rv.shots.region": "截圖（可捲動）",
  "rv.preview.link": "開啟改版預覽（新分頁，唯讀）", "rv.preview.expires": "預覽到期：{time}", "rv.preview.none": "沒有可用的改版預覽網址。",
  "rv.preview.heading": "改版預覽",
  "rv.ack": "我已經看過前後對照和預覽。",
  "rv.ack.hint": "勾選後才能按核准。",
  "rv.btn.reject": "拒絕…", "rv.btn.changes": "要求修改…", "rv.btn.close": "關閉", "rv.btn.back": "返回", "rv.btn.reload": "重新載入並再看一次",
  "rv.changes.title": "要求修改", "rv.changes.label": "給服務的修改說明（必填，最多 500 字）", "rv.changes.send": "送出修改要求",
  "rv.changes.hint": "這個請求會退回修改；你現在看到的版本之後不能再被核准。",
  "rv.reject.label": "拒絕原因（選填，最多 500 字）",
  "rv.cannot.permission": "你可以查看這個請求，但沒有核准的權限。",
  "rv.cannot.state": "目前狀態是「{status}」，現在不能核准。",
  "rv.cannot.stale": "這個版本的資料不完整，無法核准。請重新載入。",
  "rv.cannot.preview": "預覽畫面是唯讀的，不能核准。",
  "rv.reviewing": "審閱中…",
  "rv.loadFailed": "載入失敗。",
  "rv.err.headMoved": "這個設計在你審閱後被更新了，請重新載入並再看一次。",
  "rv.err.stale": "你看到的畫面已過期，請重新載入並再看一次。",
  "rv.err.approvalExpired": "這次核准已經逾期，不能再上線。需要的話請重新提出改版。",
  "rv.err.belowFloor": "這個版本早於一次需要設計層一起更新的核心升級，無法還原。",
  "rv.err.alreadyCurrent": "這已經是目前使用中的設計。",
  "rv.err.inProgress": "這個站台已經有進行中的改版，請先完成或取消它。",
  "rv.err.invalidState": "這個請求現在的狀態不允許這個操作，請重新載入看看。",
  "rv.err.siteUnknown": "目前還查不到這個站台的設計狀態，請稍後再試。",
  "rv.err.conflict": "現在無法完成這個操作，請重新載入後再試。",
  "rv.err.ackNeeded": "請先勾選「我已經看過前後對照和預覽」。",
  "rv.err.busy": "上一個操作還在進行中。",
  "rv.err.noteNeeded": "請填寫修改說明。",
  "rv.err.noteLong": "說明太長，最多 500 字。",
  "rv.err.terminal": "這個請求已經結束，不能取消。",
  "rv.err.notPublished": "只有曾經發佈的設計可以還原。",
  "rv.done.approved": "已核准，正在上線（核准有效至 {time}）",
  "rv.done.approvedNoTime": "已核准，正在上線。",
  "rv.done.rejected": "已拒絕這個版本。",
  "rv.done.changes": "已要求修改，這個請求退回修改中。",
  "rv.done.cancelled": "已取消這次改版。",
  "rv.done.revert": "已建立還原請求。它還要通過檢查、預覽，並由你再次核准才會上線。",
  "rv.unknownTag": "（未知）",
  // The title and button labels of the five design-history confirmations (T1-T4, D14 hardening). CORE-OWNED, NO copy key at all:
  // a design layer that could set these could label the real approve button "Cancel" or the title "Reject this version?".
  "cf.approveDesign.title": "核准這個設計？", "cf.approveDesign.yes": "核准並上線",
  "cf.approveRevert.title": "核准還原到「{tag}」？", "cf.approveRevert.yes": "核准並上線",
  "cf.rejectDesign.title": "拒絕這個版本？", "cf.rejectDesign.yes": "拒絕這個版本",
  "cf.cancelDesign.title": "取消這次改版？", "cf.cancelDesign.yes": "取消這次改版",
  "cf.revertDesign.title": "改成「{tag}」這個版本？", "cf.revertDesign.yes": "建立還原請求",
  "cf.no": "先不要",
  "dlg.display": "這個視窗的顯示被改動了（縮放或位置不正常），為了安全沒有送出。請重新載入頁面後再操作。",
  "cf.cancelTarget": "要取消的請求（核心讀取）",
  "cf.cancelTarget.line": "需求：{prompt}｜狀態：{status}｜版本：{sha}",
  "cf.noPrompt": "（沒有需求原文）", "cf.noVersion": "（無）",
});
/** Confirmation ids whose title and button labels are CORE text (above), not copy. They have no copy key at all. */
export const CORE_CONFIRM_IDS = Object.freeze(["approveDesign", "approveRevert", "rejectDesign", "cancelDesign", "revertDesign"]);
/** CORE_TEXT lookup with {name} placeholders. Throws on an unknown key (a programming error). */
export function coreText(key, params) {
  const s = CORE_TEXT[key];
  if (typeof s !== "string") throw new Error(`no core text "${key}"`);
  return params ? s.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (m, name) => (name in params ? String(params[name]) : m)) : s;
}
