# CLAUDE.md

商家後台：繁體中文，無建置的靜態站（原生 ES modules），透過 `../../ecommerce`（平台 repo）的後台 API 運作。**本目錄是商家 repo／範本的 `admin/`**（店面在上層的 `public/`，由根目錄的 `CLAUDE.md` 管；兩種工作階段的規則——設計層 vs 鎖定核心——也在那裡）。設計語彙來自店面（`../public/styles.css` 的 tokens）。**不要修改 ecommerce**，後台工作階段也不要動店面（`../public/`、`../scripts/`）；發現 API 缺口或 bug 只描述、不修。以下指令一律在 `admin/` 目錄下執行；範圍規則的根目錄入口是 `node ../scripts/check-scope.mjs admin --base <ref>`（AI 只能改 `admin/design/**`）。README.md 有結構、執行、測試、部署的完整說明，這裡只記慣例。

## 指令

```bash
node scripts/serve.mjs [--proxy http://127.0.0.1:8080]   # 開發伺服器（127.0.0.1:3001）
node scripts/check-design.mjs --base <ref>               # 設計層守門員（範圍、掃描、schema、ctx 清單、核心雜湊、分層）；0／1／2
node scripts/check-design.mjs --update                   # 只有有意的核心變更後才跑，重寫 scripts/core.manifest.json
node scripts/test-guard.mjs                              # 守門員測試
node scripts/check-layers.mjs                            # 分層檢查
node e2e/run.mjs                                         # 端對端（含 e2e/design.mjs；需拋棄式環境，見 README「測試」）
node e2e/parity.mjs capture <dir> | compare <a> <b>      # 390／1280 逐頁截圖與逐像素比對
```

沒有 build、沒有 npm 相依、沒有 linter。Playwright 借用 `../../ecommerce/e2e/node_modules`（`ecommerce` 與本 repo 同層；可用 `ECOMMERCE_DIR` 覆寫）。`check-design.mjs --base` 在子目錄 `admin/` 內運作：admin 以外的任何變更（店面、repo 根）一律算範圍違規。

## 分層規則：鎖定的核心 vs 設計層

商家要能用 AI 對話改後台，AI **只能改 `design/`**。其餘全是鎖定的核心（`scripts/core.manifest.json` 保護；改核心 = 人工審過的「核心變更」，之後才跑 `--update`）。完整契約與 AI 操作手冊：`docs/DESIGN-LAYER.md`；日後 AI 服務的需求：`docs/AI-EDIT-SERVICE-NOTES.md`。

- **核心**：`lib/`（API／驗證／權限／設計層載入器 `design.js`／`design-schema.js`／`public-api.json`）、`core/`（ctx、動作、查詢、auth、路由表、host）、`ui/`（安全 DOM 建構器與對話框等原件）、`app.js`、`index.html`、`config*.js`、`styles.css`、`vendor/`、`design-defaults/`（原廠備份畫面）。
- **設計層** `design/`：`tokens.css`、`theme.css`、`copy.js`（所有文案）、`routes.js`（路由 id → 畫面檔）、`views/`（所有畫面，含登入／設定密碼／接受邀請／導覽外框）、`parts/`、`assets/`。畫面只透過 `ctx`（`lib/public-api.json`）做事，不得 import 核心、不得出現 fetch／storage／eval／document／innerHTML 等。
- **安全相關一律在核心的動作裡**（`core/actions.js`），不可搬進畫面：權限檢查、狀態規則（`shipBlocker`、可取消條件）、驗證（密碼長度、slug、金額整數…）、商品 SKU 保護與過期寫入保護、上傳上限與 HEIC、**不可逆動作的確認對話框**（設計層只提供 `confirm.*` 文案）。資料函式（`ctx.data`）在核心先檢查權限、綁定目前的 shop。
- 新增 `ctx` 的函式 = 核心變更：改 `core/`、更新 `lib/public-api.json`、`--update`、更新 `docs/DESIGN-LAYER.md`。**不要**讓設計層繞過去。新增文案 key = 同時加進 `design/copy.js` 與 `design-defaults/copy.js`。
- 改了預設畫面後，要把 `design/views|parts` 同步到 `design-defaults/`（`cp`），再 `--update`；`check-design` 會掃描兩邊。
- `lib/` 不得 import `ui/`、`core/`、`design/`、`app.js`，不建 DOM；`ui/`、`core/`、`app.js` 不得 `fetch`／XHR／碰 token 或 storage／寫 `/api/v1`（`scripts/check-layers.mjs`）。

## 不可破壞的約定

- **契約**：遵守 ecommerce `docs/admin-frontend-integration.md`。access token 只在記憶體；同源（非 localhost）用 cookie 模式（登入 `refresh_transport:"cookie"`，refresh／logout 送 `{}` ＋ `X-Admin-Refresh: 1`）；單飛 refresh；Access 過期（fetch TypeError 或 HTML 回應）整頁重載一次（30 秒防迴圈）；403 後探測 `/admin/me`。非 localhost 一律 `location.origin`，`config.local.js` 只在 localhost 載入（gitignored）。
- **連結 token**（set-password／accept-invite）只在記憶體、讀到就 `history.replaceState` 清掉、不寫任何儲存。
- **權限**：`can(node)` 來自 `GET /admin/shops/{id}/me`；導覽與路由依最終 view 需要的節點限制。這只是體驗層，API 才是授權。
- **商品 PUT 是 SKU 全量取代**：UI 絕不提供刪除 SKU（不賣就 `is_active=false`）；`lib/catalog.js` 的 `saveProduct` 在 PUT 前重讀商品，與表單載入時的 SKU 不同即拒絕（`StaleProductError`），payload 以剛讀到的 SKU 為底，並斷言每個既有 SKU id 都在；`ctx.actions.saveProduct` 另外保證畫面省略或關掉既有尺寸時該 SKU 原封不動。不得繞過它。
- **圖片是子資源**，走專屬端點、即時生效，不在商品 PUT 裡。重排的順序從伺服器剛讀到的列表算。HEIC 必須在瀏覽器轉 JPEG，轉檔後重驗大小。
- **金額**是 TWD 整數（`price_amount` 3400＝NT$3,400），絕不縮放。時間用台北時區顯示。
- SKU 尺寸對應店面：`SKU.options.size` 為 `S`／`M`／`L`（範本假設，見 `../docs/TEMPLATE-NOTES.md` 已知限制）。「本季新品」＝分類 slug `new-arrivals`。
- 介面文字一律繁體中文；螢幕寬 390px 與桌機都要能用（e2e 會逐頁檢查水平溢出）。

## Phase B 的約定

- **訂單／出貨**（`lib/orders.js`）：出貨是品項層級、可多筆；`items` 省略＝出貨全部未出品項（API 的定義，前端不展開）。取消只限未付款且未出貨（API 對已付款／已出貨回 409）；退貨另需 `shipment.return`（店員沒有）。付款狀態只由金流 webhook 推進，後台不提供手動標記。UI 依權限**與**狀態決定給不給按鈕，但 API 才是授權。
- **日期**是台北日曆日字串（`lib/dates.js`）；配送日篩選、報表區間都是日曆日，不做時區換算。「今天」＝`taipeiDate()`。
- **點數不是金額**：點數用「N 點」，絕不經 `formatMoney`；折扣是百分比。訪客（`registered=false`）與註冊會員要分開顯示。
- **報表**不重算 API 的數字；唯一的衍生是圖表的零值日（沒有符合條件的訂單 ＝ 0）。口徑與「不是現金流量表」要寫在畫面上。
- **邀請連結**：先看 `delivery`（`manual` 才有 `invite_url`，只顯示一次；`email` 不含連結）。只能邀 `merchant_assignable` 角色。店主與自己不可停用（按鈕停用、API 回 403／409）。
- **成員資格被停用**：`api.js` 在 403 後探測 `/admin/me`（帳號）與 `/admin/shops/{id}/me`（成員資格），任一失效就登出並顯示「帳號已被停用」；單純缺權限的 403 不登出。
- 錯誤中文化：`ctx.errorMessage(err, {409: "…"})` 讓各動作覆寫通用訊息；核心拒絕（權限／狀態／驗證）是 `ActionError`（`isActionError`、`kind`、`fields`），訊息已本地化。
- 首頁數字：低庫存門檻是常數 `LOW_STOCK_THRESHOLD`（`lib/dashboard.js`）；店員看不到庫存（沒有 `product.view`）。

## 測試注意

- 訪客結帳也有限流（`RATE_LIMIT_GUEST_CHECKOUT_*`），拋棄式 API 要調高；webhook 簽章用 `E2E_MOCK_WEBHOOK_SECRET`。

- 套件登入次數多，拋棄式 API 要調高登入限流；每次跑前清 Redis DB 1。
- 絕不碰主 `ecommerce` 資料庫、使用者的 tunnel／Cloudflare；絕不 `docker compose down -v`。
- 截圖放 scratchpad／`E2E_OUT`，不進 git。
- e2e 要用 `http://localhost:3001`（MinIO CORS）；`e2e/design.mjs` 會暫時改 `design/` 的檔案並在結束時還原，跑到一半被殺掉要用 `git status design` 檢查並還原。
