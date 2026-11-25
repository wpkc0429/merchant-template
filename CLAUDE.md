# CLAUDE.md

這個 repo 是「預設商家範本」（或從它建立的某一家商家的網站）：**店面 + 後台在同一個 repo**，零建置流程的靜態站，沒有自己的後端——商品目錄、SKU 價格、配送方式與訂單全部來自平台（電商 SaaS）的 API。範本與每個商家 repo 的檔案配置、守門員、技能（`.claude/skills/`）完全相同；差別只在 `template.json`（`isTemplate`）與商家自己的設計層／`public/config.js`。

先判斷這次是哪一種工作，**規則完全不同**：

## A. 設計工作階段（AI 或做設計的人）：只改設計層，改完停下來等核可

1. **只能改設計層**：
   - 店面：`public/app.js`、`public/content.js`、`public/content.schema.json`、`public/styles.css`、`public/index.html`、`public/assets/**`
   - 後台：`admin/design/**`（只有 `tokens.css`、`theme.css` 等設計層檔案；`admin/styles.css` 是**鎖定**的，要改外觀請用 tokens／theme，做不到就升級給人類）
   一個工作階段只動**一個站**，不得碰另一個站、鎖定的商務層／核心層、`public/config.js`、`wrangler.jsonc`、`template.json`、`.template-version`、雜湊清單（`scripts/commerce.manifest.json`、`admin/scripts/core.manifest.json`）、`scripts/**`、`.github/**`、`.claude/**`、repo 根的檔案。要改這些＝**升級（escalate）**：說明需求、列出涉及的鎖定檔案、提出給人類審查的最小方案，然後停下，不要繞過。
2. **分支**：從目前的 `HEAD` 開 `design/storefront-<名稱>` 或 `design/admin-<名稱>`（分支前綴決定 CI 跑哪一種範圍檢查）。不要在 `main` 上工作。
3. **跑守門員**（每次有意義的修改後、交付前一定要跑）：
   ```bash
   BASE=$(git rev-parse HEAD)     # 開分支之前記下
   node scripts/check-scope.mjs storefront --base "$BASE"   # 店面：範圍 + scripts/check-layers.mjs --check
   node scripts/check-scope.mjs admin --base "$BASE"        # 後台：範圍 + admin/scripts/check-design.mjs --base
   ```
   0 通過／1 違規（照訊息修正再跑）／2 用法或環境錯誤（什麼都沒判斷）。**絕不執行任何 `--update`**（那會重寫雜湊清單，只有人類在「核心變更」時才能做；AI 不論理由都不做），**絕不執行 `scripts/sync-core.mjs`、`scripts/new-merchant.mjs`**。
   **內容 schema（`public/content.schema.json`）：註冊是「只有人類」的步驟。** 改這個檔案不會註冊任何東西；AI、CI、部署 hook、無人值守的腳本**絕不**呼叫平台的註冊端點（`PUT /api/v1/admin/shops/{id}/content/schema`），也不持有、不要求 `content.manage` 的帳密。AI 最多改檔、跑 `node scripts/check-content-schema.mjs --lint`（離線），再交給人類做 dry run 與註冊（`.claude/skills/merchant-onboarding`）。schema 的每個字串要有 `default` 與 `maxLength`、每個陣列要有 `maxItems`、每個物件 `additionalProperties:false`；欄位要與 `content.js` 對得上。
   **嚴格 CSP 是部署的硬性要求**（`public/_headers`、`admin/deploy/`，皆鎖定）：設計層不得需要內嵌 `<script>`、`on*=` 屬性、`eval` 或第三方腳本／字型；`index.html` 不可加行內 script。
   **不可逆動作的確認對話框，其警告文字固定在核心**（`admin/core/warnings.js`），後台設計層只能改標題、前導文字與按鈕字樣（`confirm.<id>.title/.text/.yes`），不能定義、改寫或隱藏警告；任何想這麼做的需求都是升級事項。
4. **不推送、不部署、不合併、不開 PR**：推上 `main` 會自動部署店面。完成後**停在商家核可這一步**：回報變更檔案、白話摘要、守門員輸出、預覽方式與做不到的部分，等人核可。
5. 不要把帳密、`config.local.js`、截圖、`node_modules` 放進 git。暫存檔放 scratchpad，**不要放進 `public/`**（整個目錄會被公開發布）。
6. 操作手冊：`.claude/skills/storefront-design`（店面）、`.claude/skills/admin-design`（後台，另見 `admin/docs/DESIGN-LAYER.md`）。

## B. 鎖定核心的維護者（人類）：核心變更流程

鎖定核心 = `template.json` 的 `lockedPaths`（店面 `public/commerce/**`、`public/config.js`、守門員腳本；後台 `admin/` 的 `lib/ core/ ui/ vendor/ design-defaults/ scripts/` 與外殼檔案；`.github/`、`.claude/`、本檔）。只有範本 repo 的維護者改它，之後經版本與 `scripts/sync-core.mjs` 送到各商家 repo：

1. 在範本 repo 的分支上改核心。**不要為商家客製**：核心對所有商家一致，客製放設計層或 `config.js`。
   **新增或改動設計層 `ctx` 的函式／動作（或任何其他鎖定核心的變更）一律是「人類審查的核心變更」**，流程寫在 `.claude/skills/core-change`；AI 工作階段不得做，只能提出方案後停下。**只有人類能跑雜湊清單的 `--update`。**
2. 新增核心能力（新的 `ShopCommerce` 函式、`SHOP_CONFIG` 鍵、後台 `ctx` 函式或文案鍵）：同步更新 `public/commerce/public-api.json` 或 `admin/lib/public-api.json`、相關文件與技能、預設設計層（新文案鍵要同時加進 `admin/design/copy.js` 與 `admin/design-defaults/copy.js`；改了預設畫面要把 `admin/design/views|parts` 同步（`cp`）到 `admin/design-defaults/`）。
3. 重鎖雜湊：`node scripts/check-layers.mjs --update`（店面）、`node admin/scripts/check-design.mjs --update`（後台）。不要用 `--update` 去「讓守門員過關」而不看它擋下了什麼。
4. 在 `docs/CORE-CHANGELOG.md` 新增版本段落。若這個版本要求商家設計層跟進（新 ctx 函式、新設定鍵、移除或改名），加一行 `Design-layer action: ...`，`sync-core` 會把它變成「需要設計層動作」的阻擋通知。
5. 提升 `template.json` 的 `version`，跑全部測試（見下），提交，**打 annotated tag `vX.Y.Z`**（`git tag -a`；流程見 `.claude/skills/template-release-and-sync`）。商家 repo 一律用 `scripts/new-merchant.mjs` 建立（GitHub 的「Use this template」按鈕只用來找到範本）；核心同步由人類逐一商家執行：`node scripts/sync-core.mjs --from <範本 checkout，HEAD 正好在該 tag> --dry-run` 預覽，再 `--yes` 套用。**同步來源只能是 tag**：HEAD 不在 annotated `vX.Y.Z`（或工作樹不乾淨）時 `sync-core` 拒絕，除非人類明確加 `--allow-untagged`（輸出會大聲標示，並記錄在商家 repo 的 `.template-version` 歷史）。
   決策紀錄在 `docs/DECISIONS.md`（嚴格 CSP、`admin/styles.css` 鎖定、固定警告、tag-only 同步、內容 schema 只由人類註冊）。
6. `public/config.js` 在範本裡**必須保持 `REPLACE_WITH_*` 佔位值**（`template.json` 的 `isTemplate: true` 啟用這項檢查）。商家 repo 的真實值由 `scripts/new-merchant.mjs` 或人類編輯寫入，再由人類 `--update`；`sync-core` 永遠不覆寫它。

## 指令（都在 repo 根目錄執行；後台指令見 `admin/README.md`、`admin/CLAUDE.md`）

```bash
python3 -m http.server 8080 --directory public            # 店面預覽 → http://localhost:8080（--directory public 不可省略）
cd admin && node scripts/serve.mjs --proxy <API>          # 後台預覽 → http://localhost:3001

node scripts/check-layers.mjs [--check]                   # 店面分層守門員（--check 另比對雜湊清單）
node admin/scripts/check-design.mjs [--base <ref>]        # 後台設計層守門員
node admin/scripts/test-guard.mjs                         # 後台守門員自測
node scripts/check-scope.mjs <storefront|admin> --base <ref>
node scripts/check-locked.mjs --base <ref> [--head <ref>] # design/* 分支不得動鎖定路徑
node scripts/import-catalog.mjs catalog/catalog.json --dry-run   # 通用冪等目錄匯入（憑證只從環境變數）
node scripts/check-content-schema.mjs --lint              # 內容 schema 離線檢查（AI 可跑）；不加 --lint 會對平台做 dry run，需要人類的 CONTENT_* 環境變數，且永遠不註冊

# 僅範本 repo（templateOnlyPaths，不會複製到商家 repo）
node scripts/new-merchant.mjs <dir> --name "<店名>" --slug <slug> [--api-base ...] [--publishable-key ...]
node tests/run.mjs                                        # new-merchant / sync-core / import-catalog 的測試
# 僅商家 repo
node scripts/sync-core.mjs --from <範本 checkout，HEAD 在 annotated vX.Y.Z tag> [--dry-run] [--yes]   # 人類執行，AI 絕不執行；來源只能是 tag
```

沒有測試框架、沒有 linter、沒有 build、沒有 `package.json`。內容相關的單元測試在 `tests/content*.test.mjs`；店面的驗證方式是在瀏覽器實際操作（含結帳三步驟與送出訂單、搜尋輸入時的游標保留、窄視窗下的版型切換）；`scripts/*.mjs` 與 `tests/*.mjs` 是不依賴任何套件的開發工具，不被部署。

## Monorepo：店面 + 後台

```
public/    店面（唯一被 Cloudflare 發布的目錄）   scripts/  守門員、匯入、同步與 check-scope.mjs
admin/     後台（獨立的無建置靜態站，有自己的 CLAUDE.md / README.md / scripts/ / e2e/ / deploy/）
catalog/   目錄資料（import-catalog.mjs 的輸入；範本附佔位範例）
```

- **推上 `main` 會自動部署店面**（`wrangler.jsonc` 的 `assets.directory` = `./public`）。`admin/` 在發布邊界之外；後台與 API 同源、置於 Cloudflare Access 之後（`admin/README.md`「部署」，hosting 檔案在 `admin/deploy/`）。**不要把 `assets.directory` 改成 repo 根或任何包含 `admin/` 的目錄。**
- **發布邊界是 `public/`**：放進去的任何檔案都會公開。專案根的 `CLAUDE.md`、`README.md`、`.claude/`、`admin/`、`catalog/` 都在邊界之外。
- 本機測試用 **gitignored 的 `public/config.local.js` / `admin/config.local.js`**（複製各自的 `.example`）；店面版只在 localhost / 127.0.0.1 載入，用 `Object.assign(window.SHOP_CONFIG, { apiBase, publishableKey })` 覆寫。不要為了本機測試改任何被追蹤的檔案。
- API 契約的權威在平台 repo（`api/openapi/openapi.yaml`、`docs/storefront-integration.md`、`docs/admin-frontend-integration.md`）。**不要把那些文件抄進這裡**，直接引用；平台 repo 對本 repo 是唯讀的。

## 分層：設計層與鎖定的商務層

程式碼在實體上分成兩層（經典 `<script>`，無打包、無 ES module；全域只有 `window.ShopCommerce`、`window.SHOP_CONFIG`、`window.SHOP_CONTENT`）：

| 層 | 檔案 | 誰可以改 |
| --- | --- | --- |
| **鎖定的商務層** | `public/commerce/**`（`api.js` API client 與目錄載入、`cart.js` 購物袋、`checkout.js` 結帳／付款導向／訂單狀態、`local-config.js` localhost 才載入的本機覆寫、`public-api.json` 公開面清單）、`public/config.js`（`apiBase`、`publishableKey`、`showPrices`、`featuredCategory`）、`public/_headers`（嚴格 CSP） | **AI agent 與做設計的人都不得修改**；只有人類的「核心變更」（B）才能動，並需 `--update` 重鎖雜湊 |
| **設計層** | `public/app.js`（畫面、狀態、路由）、`public/content.js`（靜態文案與設計常數）、`public/content.schema.json`（內容欄位 schema，平台註冊只能由人類做）、`public/styles.css`、`public/index.html`、`public/assets/` | 可自由修改 |

規則（由 `scripts/check-layers.mjs` 強制，改完設計檔請跑它）：

- 設計層**只能**透過 `window.ShopCommerce` 使用 `commerce/public-api.json` 列出的函式（`loadCatalog`、`money`、`describeApiError`、`isSkuSellable`、`cart.*`、`checkout.*`、`content.*`），只能讀 `SHOP_CONFIG.showPrices` / `featuredCategory`。不得出現 `fetch`、`localStorage`/`sessionStorage`、`/api/v1`、`apiBase`、`publishableKey`、`_internal`、`shopcommerce:` 開頭的儲存鍵、`import`。
- 商務層不知道任何畫面：它回傳純資料（`{kind:'created'|'error', …}`），文案與欄位錯誤對應留在設計層。需要新的商務能力是**商務變更**（B）；後台的內容編輯（`ctx.data/actions/ui` 的 content 函式、表單建構器、`registerContentSchema` 的人工確認對話框）全在核心，見 `admin/docs/DESIGN-LAYER.md`，不要從設計層繞過去。
- 購物袋（`shopcommerce:cart:<shop hash>`）依 publishable key 分店存放；載入目錄後 `cart.reconcile()` 丟掉不屬於這個目錄的 SKU 行。購物袋行是快照，庫存為 0 的 SKU 加不進去、`reconcile` 也會移除。
- 靜態文案（FAQ、門市資訊、品牌故事、promo、`pinfo`）集中在 `content.js`，**不要**把文案散回 `app.js`。標題欄位（`hero.title`、`storyTeaser.title`、`story.title`）是**純文字**，換行 `\n` 由 `app.js` 的 `lines()` 轉成 `<br>`（先 `esc()`，不收 HTML）。`public/content.schema.json` 是同一份內容的欄位 schema（`content.js` 的預設值要和 schema 的 `default` 一致，範本的測試會檢查）；**自 v0.3.0 起店面讀平台內容**：鎖定核心 `ShopCommerce.content`（`public/commerce/content.js`）在執行期抓 `GET /shop/content?include=content`（ETag、快取、失敗退回預設、`?content_preview=<token>` 預覽模式），設計層在 `app.js` 的 `applyPlatformContent()` 把已發佈文件覆蓋在 `content.js` 的預設值上（首繪最多等 600 ms；沒發佈或失敗＝用預設，不是錯誤）。**設計層仍不得自己 `fetch`**；內容值只能經 `esc()` 當文字，或經核心的 `ShopCommerce.content.text/richText/link/image`（richtext 用核心依平台 allowlist 建的消毒器、link 只進 href 並檢查 scheme、image 只進 src 且限已知圖片網域），**不得 `innerHTML`**。`content.schema.json` 註冊仍只由人做。商品／價格／圖片／副標／分類／精選一律來自 API，不要寫死在任何一層。
- **`config.js` 的注入**：範本裡是佔位值（`isTemplate: true` 時 `check-layers` 強制）；商家 repo 裡是真實值，只靠雜湊清單保護（`isTemplate: false`，佔位值殘留只是警告）。它對 AI 鎖定、對核心同步（`sync-core`）也是商家自有、不覆寫。

## 架構約束

### 單一渲染迴圈

`public/app.js` 是一個 IIFE。所有 UI 都經由 `state → view() → app.innerHTML` 全量重繪，沒有 diff、沒有元件實例。任何狀態變更後都要呼叫 `render()`。

因為是全量重繪，`render()` 承擔兩個必要的保留工作 — **新增互動元素時必須配合**：

- **輸入游標**：每個 `<input>` / `<textarea>` 都要有 `data-k="<key>"`。`render()` 靠它在重繪後還原 focus 與 `selectionStart/End`。漏了就會在打字時游標跳掉（搜尋框每個按鍵都會觸發重繪，最容易踩到）。
- **捲動位置**：手機版內容區有 `data-scroll="app-body"`，重繪後會還原 `scrollTop`。

### 事件委派與 `data-act`

`#app` 上掛了 `click` 與 `input` 兩個委派監聽器。

- 點擊行為寫 `data-act="<actionName>"`，對應 `actions` 物件裡的同名函式；參數用 `data-a`。
- 輸入行為寫 `data-act="input:<target>"`（`input:q`、`input:email`、`input:msg`、`input:form:<field>`），在 `input` 監聽器裡處理。
- **click 監聽器會判斷 `href`**：`href` 是真實路徑時放行讓瀏覽器導航；`href="#"` 或 `<button>` 才 `preventDefault()`。所以導覽一律用真實的 `href="#/..."` 連結（可存取、可分享），不要用 JS 攔截。手機商品卡的收藏鈕是包在 `<a>` 裡的 `<span data-act="fav">`，靠這個 `preventDefault()` 才不會連帶觸發卡片導航。

新增 action 時同時更新 `actions` 物件即可，不需碰事件綁定。

### 路由是 route/cat/pslug 的唯一來源

hash 路由。`applyHash()` 從 `location.hash` 推導 `state.route` / `state.cat` / `state.pslug`，`hashchange` 觸發重繪。導航用 `go(hash)` 或直接給 `<a href>`，**不要直接改 `state.route`**。商品路由用平台的 `slug`（`#/product/<slug>`），不是數字 id——本站不再擁有商品身份，平台在不同環境（mock／正式）會給同一個商品不同的數字 id，只有 `slug` 是穩定的。

副作用寫在 `applyHash()` 裡，改動時要留意：進入 `product` 路由（或換 `pslug`）會重設商品設定器（`qty` / `size` / `msg` / `pinfo` / `pImg`）；離開 `checkout` 會清掉 `done`、`errors` 與 `submit`；進入 `order-status` 會觸發 `loadOrderStatus()`。

排序與搜尋是暫時狀態，刻意不進網址。

### 兩套版型共存

`view()` 依 `state.mode` 在 `desktopPage()`（網頁版）與 `mobilePage()`（手機 App 版）之間切換 — 這是兩棵獨立的畫面樹，各自有一套 `m-` 前綴的 CSS，**不是同一份 markup 的響應式變體**。改動商品卡、分類、尺寸選擇這類雙邊都有的元件時，兩邊都要改。

- `MOBILE_BP`（720）是**唯一**的切換依據 —— `state.mode` 只由視窗寬度決定，沒有任何 UI 能覆寫它。不要重新引入手動切換器（沒有任何 UI 可以覆寫版型）。
- `DESKTOP_ONLY`（`checkout` / `order-status`）這兩個路由手機 App 版沒有設計，即使在 mobile mode 也會落回網頁版型（該版型已針對窄螢幕收合）。新增路由時要決定它屬於哪一邊。`story`（品牌故事）與 `store`（門市與配送）都已有手機原生畫面（`mStoryView()` / `mStoreView()`），不在這份名單裡。
- `mobilePage()` 只有滿版一種形態，直接吃視窗高度（`100dvh`）。沒有手機外框、假狀態列或 home indicator —— 那些隨切換器一起移除了。改動手機版時記得它現在直接面對真實裝置，`env(safe-area-inset-bottom)` 這類值要留著。

### 商品目錄是平台資料，不是本地陣列

`state.catalog`（`{ status, products, shippingMethods, categories, featuredSlugs, error }`，`status: idle | loading | ready | error`）在開站時透過 `Commerce.loadCatalog()` 載入一次，是這個站第二個非同步狀態（見下方「非同步提交」開頭）。商品、SKU 價格、圖片、副標、分類樹、配送方式都不寫死在前端——舊版的 `P` / `SIZES` / `SHIPS` / `PRODUCT_META` / `FEATURED_SLUGS` / `CATS` / `NAV` 都已刪除。

- **每個讀目錄的畫面都要處理三種狀態**：`loading`／`error`（共用 `catalogStatusBlock()`，套用既有的 `.empty-state` / `.m-empty` CSS）與 `ready`。**桌機版與手機版都要處理**，漏掉一邊是這個 repo 已知會發生的錯——新增讀目錄的畫面時兩棵樹都要檢查。
- **尺寸是獨立的 SKU，價格是絕對值**：`unit(product, size)` 呼叫慣例不變，但內部改成查 SKU 的 `price_amount`（`skuFor()`），不是本地算 delta。一個商品實際有哪些尺寸由 `productSizeKeys(p)` 從它的 `skus[].options.size` 推導：S/M/L 依序在前，其他值（例如 `Free`、`500ml`）照原文接在後面；**範本假設變體選項鍵是 `size`**（見 `docs/TEMPLATE-NOTES.md` 已知限制）。
- **呈現資料來自 API**：圖片 `images[]`（列表／卡片用 `urls.thumb`，詳情頁與主視覺用 `urls.large`，詳情縮圖用商品自己的 `images`）、`subtitle`（英文副標）、`categories`（商品所屬分類）與 `GET /shop/categories`（分類樹，首頁分類列／導覽／篩選 chips 都由它產生；分類篩選含子分類，在前端以樹走訪、不重打 API）。`state.cat` 是**分類 slug**（`''` ＝ 全部），網址 `#/shop/<slug>`。沒有任何商品的分類不顯示；`SHOP_CONFIG.featuredCategory`（預設 `new-arrivals`）是首頁精選區塊（標題在 `content.js` 的 `featuredTitle`），不當作貨架分類，空的時候退回前 3 項商品（順序以 `?category=` 的伺服器排序為準，`featuredSlugs`）。首頁主視覺與 IG 格從「有圖片的商品」挑選，不指定 slug。**沒有圖片的商品要正常顯示**：媒體框一律有 `--placeholder` 底色，圖片載入失敗也只是留下這個底色（CSS `background` 本身就是 fallback，不需要 `onerror`）。
- **庫存／停用**：公開 API 的 SKU 帶 `is_active` 與 `stock_qty`；`Commerce.isSkuSellable()` 是唯一判斷。不可買的尺寸按鈕 disabled 並標「售完」，整個商品不可買時卡片按鈕與加入購物袋按鈕 disabled。`stock_qty` 只是快照；結帳回 422（`/items/N`）時 `recoverFromCartRejection()` 重讀目錄、修正購物袋並提示，不再顯示「購物袋內容有誤」。
- **購物袋列是加入當下的快照**（`{skuId, productId, slug, name, img(縮圖URL), size, unitPrice, qty, msg, max}`），由商務層的 `Commerce.cart` 持有與持久化，不是對 `state.catalog` 的即時參照——目錄之後載入失敗也不影響已在購物袋裡的品項顯示與結帳。儲存鍵依 publishable key 分店（見「分層」），讀回時驗證形狀，因為那是未經信任的瀏覽器儲存。

### 非同步提交（結帳送出）

`state.submit`（`{ status, key, error, order, paymentIssue }`）曾經是全站唯一的非同步狀態；現在多了 `state.catalog`（商品／SKU／配送方式，見「商品目錄是平台資料，不是本地陣列」）——這是本站刻意等到「第二個非同步需求出現」才做的抽象化，而且做法仍是各自一組獨立的 state，不是共用的請求層。兩者都經由商務層的 `apiFetch()` 包裝（注入 `X-Publishable-Key`、選用的 `Authorization` / 自訂標頭、15 秒逾時；設計層看不到它，只呼叫 `Commerce.loadCatalog()` / `Commerce.checkout.*`），但狀態形狀各自維護。

- **`submit.key` 兼作回應歸屬判斷**：進入 `checkout` 路由時（`resetCheckout()`）產生新的冪等鍵，送出訂單時以 `Idempotency-Key` 請求標頭送給 `POST /api/v1/shop/guest/checkout`（平台 API，不是本站自己的端點）。回應抵達時比對 `key !== state.submit.key`；不等代表訪客已經離開這次結帳（換頁或已重試），該回應 MUST NOT 觸發重繪切換或改路由。唯一例外：過期但**成立**的訂單仍要清空購物袋並用 `flash()` 提示——訂單真的已經在伺服器成立了，購物袋留著才是錯的。離開 `checkout` 路由時 `submit.key` 重置為 `''`，這就是「已離開」的判斷依據。
- **`Idempotency-Key`**：標頭由商務層送出，平台對同一把鍵的處理以平台的 `docs/storefront-integration.md` 為準（不要在這裡假設保護程度）。
- **`submit.status === 'pending'` 或 `'redirecting'` 期間鎖表單**（`submitLocked()`）：送出按鈕、`prevStep`、所有欄位都要 `disabled`，避免飛行途中改動的內容與已送出的請求不一致。新增結帳步驟或輸入元素時記得接上這個狀態（`field()` 已處理既有欄位）。`redirecting` 是新狀態：guest checkout 成立、正要導向付款頁那段過渡期。
- **價格完全由伺服器計算，用戶端不送出、不主張任何金額**——這與舊版（`worker.js` 時期的 `agreedTotal` / 409 `PRICE_CHANGED` 重新確認流程）不同，那整套機制已經刪除，沒有替代品。結帳畫面顯示的小計／運費只是送出前的**估計值**（本機算的，用 `state.catalog` 的 SKU 價格與配送方式運費），送出後一律改用伺服器回應（`order.subtotal_amount` / `shipping_fee` / `total_amount`）。
- **付款是結帳之後的第二個請求**：`POST /api/v1/shop/guest/checkout` 成立後，若回應帶 `order_access_token`，接著呼叫 `POST /api/v1/shop/guest/order/payments` 取得 `redirect_url` 並導頁；沒有卡號欄位，本站從不收集任何卡片資訊。`order_access_token` 可能在成立的訂單上缺席（平台文件明載的已知邊界情況）——此時 UI 要能呈現「訂單已成立、付款需要另外處理」，不能說訂單失敗。`state.submit.paymentIssue`（`'no-token'` / `'init-failed'`）記錄這兩種情形，見 `checkoutView()` 的 `done` 分支。
- **`#/order-status`（`DESKTOP_ONLY`）是付款返回頁**：從 `sessionStorage` 讀回下單時存的 order-access token，重新查 `GET /api/v1/shop/guest/order` 看 `payment_status`。平台的付款轉導沒有 `return_url` 可控，所以這是盡力而為的設計，不是驗證過的整合。

### 其他約定

- **設計 token 集中在 `public/styles.css` 的 `:root`**，不要在元件裡寫死色值。`--accent` 由 `content.js` 的 `accent` 在啟動時寫入 `documentElement`。
- **價格一律走 `money()`（= `Commerce.money`）**，不要自己算。`showPrices`（`config.js`）為 `false` 時所有價格顯示 `—`（購物袋小計／合計仍顯示金額）。
- **所有插入 HTML 的字串都要過 `esc()`**，因為畫面是字串拼接出來的。伺服器回傳的內容（失敗訊息、訂單編號）也不例外。
- `public/assets/` 在範本裡只有程式產生的佔位圖（`og-cover.png`、`story.png`，由 `scripts/gen-placeholders.mjs` 產生）。商品圖來自 API，不放在這裡。


## 後台（`admin/`）

後台有自己的 `admin/CLAUDE.md`（慣例、不可破壞的約定）與 `admin/README.md`（結構、本機執行、測試、部署）；設計層契約與給 AI 的操作手冊是 `admin/docs/DESIGN-LAYER.md`。後台 AI 工作階段只能改 `admin/design/**`，指令與 e2e 都從 `admin/` 執行。

## 已知限制

見 `docs/TEMPLATE-NOTES.md`（僅範本 repo 有；內容包含命名對照表、已知限制與未決事項）。
