# Merchant admin

> **這個目錄是商家 repo（或範本）的 `admin/`。** 店面在上層 `public/`，部署目標不同：店面由推上 `main` 自動部署到 Cloudflare；**後台不會被那個部署發布**（`wrangler.jsonc` 只發布 `public/`），而是與 API 同源、置於 Cloudflare Access 之後（見「部署」，hosting 檔案在 `deploy/`）。本文所有指令都在 `admin/` 目錄下執行。

繁體中文的商家後台，外觀沿用[店面](../public/styles.css)的設計語彙（中性灰階加一個強調色、系統字型、膠囊按鈕），透過電商平台（`ecommerce` repo）的後台 API 管理商店。平台自己的後台（`ecommerce/admin`）仍用於平台管理，不在這裡。

無建置步驟：純 HTML／CSS／原生 ES modules，沒有打包器、沒有框架、沒有 npm 相依。

## 現況（Phase A + B）

- 登入／登出、`#/set-password/{token}`、`#/accept-invite/{token}`（新帳號設密碼；既有帳號先登入再加入）
- 依權限分流的導覽：手機底部分頁列、桌機側欄
- **首頁**：今日配送、待出貨（已付款但沒出完貨）的數量；店主另有庫存偏低（<= `LOW_STOCK_THRESHOLD`＝5，`lib/dashboard.js`）。店員只看前兩項。
- **訂單**：列表（付款／出貨／訂單狀態／配送日篩選、搜尋訂單編號・收件人・電話、新到舊、分頁；手機是卡片）；詳情（**卡片訊息放最前面、字很大**，配送日、收件資料、品項含 SKU 尺寸與數量、金額、付款紀錄〔`payment.view`〕、出貨、進度時間軸）；動作依權限與狀態出現：全部出貨／部分出貨、標記已送達、標記退貨（`shipment.return`，只有店主）、取消訂單（`order.cancel`，只有店主，且只限尚未付款、尚未出貨的訂單）。不可逆的動作都有確認對話框，API 的 4xx 以中文顯示。
- **今日配送**（`#/deliveries`）：指定配送日是今天（Asia/Taipei）、還沒送達的訂單；可切到明天。
- **顧客與會員等級**（`member.view`／`member_tier.*`）：顧客列表（email 或編號搜尋、訪客與註冊要分）、詳情（點數、等級、訂單數、累計消費、最近訂單、點數紀錄）；會員等級新增／編輯。
- **報表**（`report.view`）：日期範圍＋預設（今天／近 7 天／近 30 天／本月）、數字卡片、純 SVG 長條圖、逐日（月）明細、熱銷商品。沒有圖表函式庫。
- **成員管理**（`user.manage_members`，店主）：成員與狀態、待接受邀請、邀請（只能選 `merchant_assignable` 的角色，`delivery:"manual"` 時顯示一次性連結與複製鈕，`"email"` 時只說已寄出）、撤回邀請、停用／啟用成員資格（確認對話框；店主與自己的按鈕停用）。被停用的成員下一個動作就被登出並看到中文說明。
- 商品：列表（搜尋含**英文副標**〔API 的 `q` 不搜副標，前端另行比對〕、上架／有庫存篩選、縮圖、價格區間）、新增／編輯（S/M/L 規格〔範本假設，見 `../docs/TEMPLATE-NOTES.md`〕、分類、「本季新品」開關）、刪除（有確認）、照片（HEIC 轉檔、排序等）；狀態字樣為「上架中／已下架」
- 分類管理、運送方式

使用者：店主（全部功能）與店員（訂單、今日配送）。介面依 `GET /admin/shops/{id}/me` 的權限節點隱藏功能，**但從不依賴隱藏**：授權一律由 API 的 RBAC 決定。

## 檔案結構與分層規則：鎖定的核心 + 可改的設計層

商家要能用 AI 對話改後台的外觀，所以程式在實體上分成兩層（和店面的「商務層／設計層」同一個模型，見上層 `CLAUDE.md`）：

```
index.html  app.js  config.js  config-loader.js  styles.css  (config.local.js 不進版控)

【核心：鎖定，AI 不可改，由 scripts/core.manifest.json 的雜湊保護】
lib/    API／驗證／權限／設計層載入器：api.js（token、refresh、Access 重導、成員資格被停用的偵測）、session.js、perm.js、
        router.js、catalog.js、upload.js（HEIC 與直傳）、orders.js、members.js、reports.js、team.js、dashboard.js、dates.js、
        design.js（唯一的設計層載入器：文案、路由登錄、備援）、design-schema.js（設計層契約，載入器與守門員共用）、
        public-api.json（設計層可使用的 ctx 清單）
core/   ctx 與動作：context.js（組出給設計層的 ctx）、actions.js（每個動作在核心內檢查權限、狀態規則、驗證、SKU／過期保護、
        不可逆動作的確認對話框）、data.js（查詢，先檢查權限）、auth.js（登入與密碼規則、連結 token 只留在核心）、
        routes.js（路由 id、網址、所需權限節點）、host.js（掛載畫面，設計層壞了就退回內建）、errors.js、guard.js
ui/     UI 原件：kit.js（安全 DOM 建構器 h()、對話框與 confirm、toast、表格…）、format.js、icons.js
vendor/ heic2any 0.0.4（MIT）
design-defaults/  設計層的「原廠備份」：設計層的畫面壞了或不見時，核心改用這裡的畫面（同樣被雜湊保護）

【設計層：design/ 是 AI 與設計師唯一能改的地方】
design/tokens.css  顏色、字型、圓角、間距（CSS 變數；店家品牌色仍由核心疊在上面）
design/theme.css   自由 CSS，最後載入（預設是空的）
design/copy.js     所有不牽涉行為的繁體中文文字（nav 標籤、標題、按鈕、說明、空狀態、確認對話框用語、錯誤訊息用語）
design/routes.js   路由 id → 畫面檔
design/views/      每個畫面一個檔（含登入、設定密碼、接受邀請、導覽外框）：export default function (root, ctx)
design/parts/      畫面共用的小零件
design/assets/     圖片、icon、字型

app.js  = 啟動、路由、權限閘門（路由的權限節點沒全給就掛「沒有權限」畫面，不掛設計層的畫面）
```

- **設計層只透過 `ctx` 做事**（`lib/public-api.json` 列出的函式與物件）：查詢（`ctx.data`，先在核心檢查權限）、動作（`ctx.actions`，在核心內檢查權限、狀態規則、驗證與確認）、`ctx.can`、格式化、UI 原件（`ctx.ui`，`h()` 會拒絕 innerHTML、字串事件、script 類標籤、跨站網址）、文案 `ctx.t`。沒有 token、沒有 shop id、沒有網路、沒有儲存。
- 設計層**不得** import 核心，也不得出現 `fetch`、`localStorage`、`eval`、`document`、`innerHTML` 等（見 `docs/DESIGN-LAYER.md`）。`node scripts/check-design.mjs --base <ref>` 一次檢查範圍（只有 `design/` 可變）、靜態掃描、schema、ctx 清單、核心雜湊、分層。
- 設計層的畫面載入失敗、丟錯或卡住 20 秒：核心改掛 `design-defaults/` 的內建畫面並在 console 警告，**不會擋住登入**。
- `lib/` 是資料層：不得 import `ui/`、`core/`、`design/`、`app.js`，不建 DOM。`ui/`、`core/`、`app.js` 不得 `fetch`／碰 token 或 storage／寫 `/api/v1`，一律經 `lib/`。`node scripts/check-layers.mjs` 檢查。
- 改設計：[docs/DESIGN-LAYER.md](docs/DESIGN-LAYER.md)（也是給 AI agent 的操作手冊）；日後的 AI 編輯服務：[docs/AI-EDIT-SERVICE-NOTES.md](docs/AI-EDIT-SERVICE-NOTES.md)。

### 指令

```bash
node scripts/check-design.mjs --base <ref>   # 設計層守門員：範圍＋掃描＋schema＋ctx＋核心雜湊＋分層（0 通過／1 違規／2 用法錯誤）
node scripts/check-design.mjs --update       # 只有「有意的核心變更」之後才跑：重寫 scripts/core.manifest.json
node scripts/test-guard.mjs                  # 守門員自己的測試（每條規則都有違規樣本）
node scripts/check-layers.mjs                # 分層檢查
```

### 必要的 CSP（伺服器標頭；核心沒有行內 script，不需要 unsafe-inline）

**嚴格 CSP 是部署的硬性要求（2026-11-25 使用者決定，見 `../docs/DECISIONS.md`）：正式環境與每一個 AI 改版預覽環境都必須帶上它，不是建議、不可關閉。** `deploy/nginx.conf.template` 預設就帶（沒有任何開關可以關掉），`deploy/Dockerfile` 會安裝它；`node scripts/check-design.mjs`（步驟 "deploy"）在 `deploy/` 缺少 CSP、放寬 `script-src`（`unsafe-inline`／`unsafe-eval`／萬用字元）、少了 `object-src`／`base-uri`／`frame-ancestors 'none'`、沒有 `always`，或 Dockerfile 沒安裝／刪掉它時會失敗。repo 外的自訂主機設定不在守門員範圍內，必須由人類照樣帶上。

範本不載入任何第三方字型（`index.html` 已移除 Google Fonts），所以 `style-src` 與 `font-src` 只有 `'self'`：

```
default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self';
img-src 'self' data: https://<IMAGE_PUBLIC_BASE_URL 網域>; connect-src 'self' https://<R2 直傳網域>; frame-ancestors 'none';
base-uri 'none'; form-action 'none'; object-src 'none'
```

這樣即使有設計變更逃過掃描，也無法把資料送到 API 與圖片桶以外的地方、無法動態執行程式（`eval`／`Function` 被擋）。`deploy/nginx.conf.template` 已套用這份 CSP（另加 `blob:` 圖片與 `worker-src blob:` 給 HEIC 轉檔），網域由環境變數 `ADMIN_IMG_ORIGIN`、`ADMIN_UPLOAD_ORIGIN` 帶入。

## 本機執行

```bash
# 1) 指向 API：建立 gitignored 的 config.local.js（範本：config.local.js.example）
cp config.local.js.example config.local.js     # apiBase = location.origin（搭配下面的 --proxy）
# 跨源：echo 'window.ADMIN_CONFIG.apiBase = "http://localhost:8080";' > config.local.js

# 2) 靜態伺服器（http://127.0.0.1:3001，要用 localhost:3001 開）
node scripts/serve.mjs
```

非 localhost 時 API base 一律是 `location.origin`（`config.local.js` 不會被載入、也會被忽略）。

跨源（上面的設定）使用 body 模式 refresh：refresh token 存在 sessionStorage（僅本機開發）。要在本機測**正式的同源＋cookie 模式**：

```bash
node scripts/serve.mjs --proxy http://127.0.0.1:8080   # /api/v1/admin 轉給 API，其餘為靜態檔
echo 'window.ADMIN_CONFIG.apiBase = location.origin;' > config.local.js
```

兩種情況都要在 API 端把 `http://localhost:3001` 登記成該商家的 `purpose=admin` origin（見下）。注意 API 對同源 GET（沒有 Origin 標頭）以 `https://{Host}` 判斷，所以純 http 的 localhost 測試要多登記 `https://localhost:3001`；正式環境只有 https，不受影響。

## 測試

端對端測試用 headless Chromium，**只在拋棄式環境跑**（絕不碰主資料庫、tunnel、Cloudflare）：

1. 在 ecommerce：`CREATE DATABASE merchant_template_dev`，用覆寫的 `DATABASE_URL` 跑 `go run ./cmd/migrate` 與 `go run ./cmd/seed -demo`。
2. 起拋棄式 API：`API_ADDR=127.0.0.1:8180 REDIS_DB=1 PAYMENT_DEFAULT_PROVIDER=mock`、同一個 `DATABASE_URL`、`R2_BUCKET=ecommerce-media-e2e`、`IMAGE_PUBLIC_BASE_URL=http://127.0.0.1:9000/ecommerce-media-e2e`（其餘 MinIO／R2 變數用 `.env`），並把 `RATE_LIMIT_LOGIN_BROAD_LIMIT`、`RATE_LIMIT_LOGIN_TIGHT_LIMIT`、`RATE_LIMIT_GUEST_CHECKOUT_BROAD_LIMIT`、`RATE_LIMIT_GUEST_CHECKOUT_TIGHT_LIMIT`、`RATE_LIMIT_REFRESH_LIMIT` 調高（套件登入與下單次數多）；`PAYMENT_MOCK_WEBHOOK_SECRET` 設成 `e2e-mock-webhook-secret-for-throwaway-stack-only-0001`（或用環境變數 `E2E_MOCK_WEBHOOK_SECRET` 告訴測試）。
3. `node scripts/serve.mjs --proxy http://127.0.0.1:8180`，`config.local.js` 設 `apiBase = location.origin`。
4. `node e2e/setup.mjs`（登記 admin origin；超級管理員帳密從 `../../ecommerce/.env` 讀取，不會印出）。
   另外要先用 `../scripts/import-catalog.mjs ../catalog/catalog.sample.json`（從 `admin/` 執行）灌入 8 款範例商品（S/M/L SKU、標題含「｜」、運送方式「宅配到府」，套件靠這些辨識測試商品）、分類、運送方式與圖片（環境變數 `IMPORT_API_BASE=http://127.0.0.1:8180`、`IMPORT_ADMIN_EMAIL`、`IMPORT_ADMIN_PASSWORD`，帳密用 demo 店主，不放進任何檔案）。套件自己會透過公開的訪客結帳 API 建立真實訂單（mock 付款＋簽章 webhook）、會員等級、低庫存 SKU，不需手動造資料。
5. 每次跑之前清 Redis DB 1（`FLUSHDB`，只有 DB 1），然後 `E2E_OUT=<截圖目錄> node e2e/run.mjs`。

收尾：停掉程序、`DROP DATABASE merchant_template_dev`、`FLUSHDB`（DB 1）、只清空 MinIO `ecommerce-media-e2e` 桶。**不要** `docker compose down -v`。

內容畫面（`e2e/content.mjs`，由 `run.mjs` 在設計層之前執行，也可單獨跑 `node e2e/content.mjs`；需要 `config.local.js` 的 `siteOrigin`，`serve.mjs` 會把 `../public/content.schema.json` 以同源的 `/content.schema.json` 提供）：用確認對話框註冊範本的內容 schema（先 dry run、取消不註冊、固定警告）、編輯與前端驗證、儲存（以伺服器回應重建表單）、發佈（公開 `/shop/content` 立即回新內容）、清單項目新增／排序／刪除、兩個分頁同時儲存的 412 提示與重新載入、版本歷史與還原（只放回草稿、公開內容不變）、預覽分頁、editor（可編輯、無發佈／刪除／schema）與 staff（無入口、進不去）的權限，以及 390／1280 的版面與溢出檢查。

另外有：`node e2e/parity.mjs capture <dir>`（390px 與 1280px 逐頁截圖，新舊各跑一次再 `compare`，確認畫面逐像素一致）、`node scripts/test-guard.mjs`（守門員測試）。**要用 http://localhost:3001 開**（MinIO 的 CORS 只登記這個 origin，圖片直傳才會成功）；全新資料庫的第一次執行，套件會自己先建一筆已付款訂單。

套件涵蓋（Phase A）：登入／登出／錯誤密碼／鎖定、cookie 與 body 兩種 refresh、設定密碼與邀請連結、店員看不到商品、商品完整生命週期（含真實 HEIC 樣本、上限、重排、本季新品、下架、過期表單保護、英文副標搜尋）、分類與排序、運送方式。

設計層（`e2e/design.mjs`，由 `run.mjs` 最後執行，用暫時的設計檔、結束後還原）：改文案（導覽、標題、登入、確認對話框用語）、改 token 顏色、theme.css 生效、整個換掉導覽外框（重排、隱藏，店員看不到也到不了被禁的項目）、把訂單列表換成表格、把商品表單換成極簡版（必填欄位無法移除、SKU 不會被刪、確認／權限／狀態規則仍由核心執行）、新的首頁小工具（店員看不到無權限的資料）、設計層的畫面壞掉／不見／語法錯誤／routes.js 與 copy.js 無效時退回內建畫面且仍可登入、守門員拒絕違規設計、惡意畫面以店員身分呼叫所有受限函式全被核心拒絕、嚴格 CSP 下整個後台（含圖片上傳）可用。

Phase B：訪客結帳造單、訂單列表（卡片、篩選、搜尋、分頁、新到舊）、訂單詳情與卡片訊息、今日配送與首頁數字、全部／部分出貨→送達→退貨、退貨與取消的權限（店員無按鈕、強送 API 回 403）、顧客與會員等級、報表（預設、空狀態、範圍上限）、成員管理（邀請、新帳號接受、既有帳號接受、撤回、停用／啟用、被停用者下一個請求即登出、店主與自己不可操作）、店員導覽，以及 390px 手機逐頁溢出檢查與截圖、桌機截圖。

### 預覽橫幅的真瀏覽器測試（v0.4.0）

`node e2e/preview-banner.mjs`（在 `admin/`）：不需要平台，用內建的 stub 伺服器在真的 Chromium 驗證預覽橫幅（不 fail closed、文字完整、設計層隱藏／覆蓋會剛好 fail closed 一次、非預覽頁沒有橫幅），並在 390／1280 截圖（`BANNER_SHOTS`，預設 `e2e/out/banner`）。Playwright 取自 `$PLAYWRIGHT_DIR` 或同層 `ecommerce/e2e`；找不到就印 `SKIP` 並以 0 結束。`tests/preview-banner-browser.test.mjs` 會呼叫它。

注意：版本預覽（`/design/:id/version-preview`）在歷史清單與還原流程（T1-T4）完成前，使用者沒有入口；預設畫面不顯示「改成這個版本」。

## 部署

這是一包靜態檔，部署在商家自己的後台網域（例如 `admin.<shop-domain>`），與 API **同源**：

```
瀏覽器 ──► admin.<shop-domain> ──(Cloudflare Access)──► tunnel
                  ├─ ^/api/v1/admin → API   127.0.0.1:8080
                  └─ 其餘           → 本站靜態檔（deploy/ 的 nginx，127.0.0.1:3001）
```

只需發佈：`index.html app.js styles.css config.js config-loader.js lib/ core/ ui/ design/ design-defaults/ vendor/`。`config.local.js` 不要部署（非 localhost 也不會載入）。`deploy/` 備有可直接使用的檔案（本 repo 不會替你部署任何東西）：

- `deploy/nginx.conf.template`：靜態檔 + **必要的**嚴格 CSP + 安全標頭，網域由環境變數帶入；
- `deploy/Dockerfile`：只複製要發布的檔案（從 `admin/` 目錄建置：`docker build -f deploy/Dockerfile -t merchant-admin .`）；
- `deploy/cloudflared-ingress.example.yml`：tunnel ingress 範例（手動合併進你的 tunnel 設定）。

`deploy/nginx.conf.template` 另需要環境變數 `ADMIN_SITE_ORIGIN`（店面的 origin）：用於內容的「預覽」按鈕（以 `/site-config.js` 提供給頁面）與 `/content.schema.json`（nginx 從店面讀取後以同源提供，後台才能 dry run／註冊內容結構，CSP 的 `connect-src` 仍只有 `'self'`）。

**`ADMIN_SITE_ORIGIN` 格式**：`https://主機[:埠]`（小寫、無結尾斜線、無路徑、無引號或分號），否則容器啟動時會明確報錯並結束（`deploy/require-origins.sh`）。`/content.schema.json` 用變數 `proxy_pass` + `resolver`（`ADMIN_RESOLVER`，預設取自 `/etc/resolv.conf`，可自行設定）在請求時才解析店面網域，所以店面網域尚未解析時後台仍能啟動；容器需要可用的 DNS。這個代讀不轉送 Cookie／Authorization／Cloudflare Access 憑證，只接受 GET。

依平台的 `docs/deploy/admin-exposure-runbook.md`（本專案不修改 tunnel／Cloudflare 設定，以下由你手動套用）：

1. tunnel ingress：該網域兩條規則，`path: ^/api/v1/admin` → API，其餘 → 靜態檔；path 規則排在同 hostname 的萬用規則之前（範例見 `deploy/cloudflared-ingress.example.yml` 與平台 `docs/deploy/cloudflared-admin.example.yml`）。公開 API 網域的 `^/api/v1/admin → 404` 不動。
2. Cloudflare Access：把這個網域加進商家 admin 的 Access 應用（One-time PIN），並確認 API 的 `CF_ACCESS_*` 已設定。
3. **登記 admin origin**（平台管理員、`shop.manage_client_origins`）：
   ```
   POST /api/v1/admin/shops/{shopID}/allowed-origins
   { "origin": "https://admin.<shop-domain>", "purpose": "admin" }
   ```
   （或在平台後台「前端接入」頁選「後台」。）登記後，登入前的 `GET /admin/branding` 才認得這個網域、邀請與設定密碼連結才會指向這裡、並啟用主機綁定。
4. 圖片上傳：bucket 的 CORS 要加入這個 origin（平台 `docs/media-r2-setup.md` 第 4 步），否則瀏覽器直傳會失敗。
5. 靜態伺服器**必須**帶上面「必要的 CSP」（`deploy/nginx.conf.template` 已帶，不可移除；上線後用 `curl -sI https://admin.<shop-domain>/ | grep -i content-security-policy` 確認）。店面的 CSP 是 `../public/_headers`（Cloudflare 從 `public/` 讀取）。

## 授權

vendor 的 heic2any 為 MIT（見 `vendor/heic2any.LICENSE.md`）。
