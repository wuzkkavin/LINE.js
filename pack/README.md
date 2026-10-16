# AI寶 打包管線（pack/）

把 LINE.js 核心、helper 小幫手與啟動器打成**單一、免安裝、雙擊可執行**的 Windows x64 執行檔 `AI寶.exe`，使用 Node 官方的 Single Executable Applications（SEA）技術。

©Copyright 2026 By 吳治綱 繁體中文化
上游出處：原始專案 JS-PACKAGE/LINE.js（Apache License 2.0）與核心函式庫 @evex/linejs（evex-dev）。本目錄只新增打包相關檔案，**不修改任何上游檔案，也不修改 helper/ 既有檔案**。

---

## 1. 快速開始

```sh
# 前置（Repo 根目錄與 helper 的相依，build.mjs 會在缺失時自動補跑）
npm ci --include=dev && npm run build
cd helper && npm ci && cd ..

# 打包（在 pack/ 目錄）
cd pack
npm ci
node build.mjs            # 預設 --target win，產出 pack/out/AI寶.exe
node tools/verify-exe.mjs out/AI寶.exe   # 驗證成品
npm test                  # 啟動器支援模組的單元測試（28 項）
```

產出：

| 檔案 | 說明 |
|---|---|
| `pack/out/AI寶.exe` | 最終成品（約 98.5 MiB），單一檔案，免安裝 |
| `pack/build/build-report.json` | 每次打包的驗證報告（大小、PE/SEA 檢查、icon 與版本字串、版本對應） |
| `pack/build/selftest/AI寶-linux` | `--target current` 的本機平台自測版（僅供開發驗證，非交付物） |

## 2. 管線流程（build.mjs）

1. **相依與核心建置**：確認根目錄 `node_modules` 與 `dist/`（tsc + Vite）、`helper/node_modules` 存在，缺失才補跑。
2. **esbuild 打包四件 JS**：
   - 核心 `dist/main.js` → ESM bundle（資產鍵 `core/dist/main.js`）
   - 核心 CLI `scripts/cli.mjs` → ESM bundle（`core/scripts/cli.mjs`）
   - helper `src/main.mjs` → ESM bundle（`helper/src/main.mjs`）
   - 啟動器 `launcher/entry.mjs` → CJS bundle（`build/launcher.cjs`，即 SEA 的主程式）
   - ESM bundle 統一注入 `createRequire` banner：helper 與核心的 CJS 相依（如 `ws`）在 ESM 情境呼叫 `require()` 時才不會失敗（自測時實際踩到並已修正）。
3. **蒐集靜態資產**到 `build/assets/` 並產生 `manifest.json`（共 22 個檔案）：核心網頁（`dist/web`）、核心 `package.json` 與 `config.example.yaml`、helper 網頁、粉圓體字型與 OFL 授權、AI寶 圖示與頭像（見第 6 節）。
4. **產生 SEA blob**：`node --experimental-sea-config`（不使用 snapshot、不使用 code cache，避免建置機執行到啟動器邏輯）。
5. **基底 node**：下載官方 Node **v24.20.0** win-x64 的 `node.exe`（與開發環境同大版本，釘版；快取於 `pack/.cache/`），複製為 `AI寶.exe`。
6. **移除簽章**：以 `tools/strip-signature.mjs` 清除基底 node 的 Authenticode 憑證表（目錄項清零＋截掉檔尾憑證），讓成品是乾淨的未簽章狀態，避免留下失效簽章被工具誤判損壞。
7. **換 icon 與版本資訊**：以 resedit（純 JS 的 PE 資源編輯器，跨平台）把圖示換成 AI寶 icon（來源 `helper/assets/ai-bao-icon.png`，以 `tools/ico.mjs` 包成 ICO），版本字串寫入 ProductName「AI寶」、FileDescription 與 LegalCopyright 含「©Copyright 2026 By 吳治綱 繁體中文化」、FileVersion 對齊核心版本（1.6.5.0）。此步失敗時管線只警告、不中斷，並在報告中標記（本版實測成功，`metaApplied: true`）。
8. **注入 SEA blob**：以 postject 把 blob 注入 exe 的 `NODE_SEA_BLOB` 資源並翻轉 sentinel fuse。
9. **驗證**：`tools/verify-exe.mjs` 檢查 MZ/PE 檔頭、x64 machine、SEA fuse、icon 資源與版本字串，結果寫入 `build-report.json`。

已知現象：postject 在本管線會印出 `Relocation corrupted: BlockSize is out of bound` 的警告。已查證成品的 `.reloc`、`.data`、`.pdata` 區段與基底 node **位元組完全一致**（雜湊比對），`NODE_SEA_BLOB` 資源大小與 `sea.blob` **位元組數完全相等**，判定為 pe-library 解析驗證的雜訊而非實際損壞；最終仍以 Windows 實跑（見第 7 節）為準。

## 3. 啟動器行為（launcher/）

同一個 exe 以參數分飾多角（自己再啟動自己當子行程）：

| 模式 | 行為 |
|---|---|
| `AI寶.exe`（無參數） | 監督者：見下方流程 |
| `AI寶.exe --role core` | LINE.js 核心（HTTP/WS 3789），CWD 為資料目錄 |
| `AI寶.exe --role helper` | helper 控制台與機器人（HTTP 3790） |
| `AI寶.exe --role cli token` | 轉送核心 CLI（產生/撤銷機器人 Token、login/logout），參數原樣轉交 |
| `AI寶.exe --version` | 印出版本與資料目錄 |

監督者流程：

1. 解析資料目錄（Windows 為 `%LOCALAPPDATA%\HwLineHelper`；可用環境變數 `HWLINEHELPER_HOME` 覆寫，供測試）。
2. SEA 模式把內嵌資產解開到 `資料目錄/runtime/<核心版本>+<helper版本>/`（有完整標記時略過），並把核心網頁鏡像到 `資料目錄/dist/web/`（核心以 CWD 的 `dist/web` 提供網頁）、把 `config.example.yaml` 備妥到資料目錄（核心首次啟動會自動複製成 `config.yaml`）。舊版 runtime 目錄會自動清除。
3. session 靜置解密（僅 Windows，見第 5 節）。
4. 探測 3789/3790：**兩者都已在執行** → 只開啟瀏覽器並結束（避免重複啟動）；缺哪個就補啟哪個角色。
5. 子行程以同一個 exe 加 `--role` 啟動，stdout/stderr 導向 `logs/launcher-core.log`、`logs/launcher-helper.log`。
6. 等待兩埠就緒（上限 45 秒）後，自動開啟瀏覽器到控制台 `http://127.0.0.1:3790/`。
7. 收到 SIGINT/SIGTERM/SIGBREAK，或任一子行程結束 → 優雅關閉：結束其餘子行程、執行 session 靜置加密、結束監督者。

開發模式：直接以 `node pack/launcher/entry.mjs` 執行（非 SEA）時，核心與 helper 改從 Repo 原始檔案載入，其餘行為（資料目錄、探測、收尾）相同，方便本機除錯。

已知限制：Windows 上直接關閉監督者的主控台視窗屬於強制結束，子行程可能殘留（下次雙擊時會被第 4 步的探測接住，只開瀏覽器不重複啟動）；建議用 Ctrl+C 或關閉前先停止。要徹底避免殘留需 Job Object（原生模組），列為後續加強。

## 4. 資料落點

全部在 `%LOCALAPPDATA%\HwLineHelper\`，exe 旁邊不寫任何檔案：

| 路徑 | 內容 |
|---|---|
| `config.yaml`、`config.example.yaml` | 核心設定（首次自動由範本產生；`api.enabled` 預設關閉，啟用機器人 API 的步驟見第 8 節） |
| `session.json` | LINE 登入 session（執行中為明文，結束時加密，見第 5 節） |
| `session.json.dpapi` | DPAPI 加密後的 session（靜置狀態） |
| `api-token.json` | 機器人 Token 的 SHA-256 雜湊（核心維護，只存雜湊） |
| `settings.json`、`secrets.dev.json`（僅非 Windows 開發用）、`kb-index.json` | helper 設定、開發用機密檔、知識庫索引 |
| `logs/` | `launcher.log`、`launcher-core.log`、`launcher-helper.log` 與 helper 每日 log |
| `runtime\<版本>\` | SEA 解開的程式檔案（可隨版本自動汰換，非使用者資料） |
| `dist\web\` | 核心網頁鏡像（核心以 CWD 讀取，自動維護） |

## 5. 機密與 session 保護接線

- **API Key（helper）**：helper 的 `createSecretStore` 依 `process.platform` 自動選後端。在 exe 內執行時平台即為 win32，會自動選用 **Windows 認證管理員＋DPAPI** 後端（經 PowerShell 呼叫），啟動器不需額外傳參；非 Windows 自動退回 AES 檔案後端（開發用）並在 log 註明。exe 內的 helper 與開發版是同一份程式碼，選用邏輯一致。
- **session 靜置加密（啟動器 `launcher/vault.mjs`＋`dpapi.mjs`）**：
  - 啟動時：若存在 `session.json.dpapi` 且無明文 `session.json`，以 PowerShell 呼叫 `ProtectedData.Unprotect`（CurrentUser 範圍）解密回資料目錄供核心使用；解密失敗時**保留密文不動**、本次以未登入狀態啟動並寫 log。
  - 結束時：先把明文加密寫到暫存檔，成功且非空才覆蓋 `session.json.dpapi`，然後才刪明文；加密失敗時**保留明文**並寫 log，絕不讓 session 遺失（fail-safe）。
  - PowerShell 腳本固定寫死，檔案路徑只經環境變數 `HW_DPAPI_IN`/`HW_DPAPI_OUT` 傳遞，不把路徑或內容拼進命令字串。
  - 命令組裝與流程邏輯已由 `pack/test/` 的單元測試覆蓋（28 項，含假 runner 的加解密來回、失敗保留、非 Windows 跳過）；**真正的 DPAPI 加解密尚未在 Windows 實測**（開發 VM 為 Linux），列入第 7 節驗證清單。

## 6. 內嵌素材（現行定案）

| 資產鍵 | 來源 | 用途 |
|---|---|---|
| `helper/assets/ai-bao-icon.png` | 老吳提供（綠色 LINE 風格對話泡泡，233×232） | App 圖示：exe icon、控制台 favicon 與頁首 Logo |
| `helper/assets/ai-bao-avatar.png` | 原圖弄正去背＋米白底（480×480） | AI寶 頭像：控制台狀態卡與 LINE 次要帳號大頭貼來源 |
| `helper/assets/ai-bao-cutout.png` | 同原圖去背透明母檔（含白色貼紙邊，RGBA） | 透明母檔備用（控制台如需展示可用；helper 目前路由未引用） |
| `helper/assets/fonts/jf-openhuninn-2.1.ttf` ＋ `OFL.txt` | jf open 粉圓（SIL OFL 1.1） | 控制台字型 |

備份圖（`ai-bao-avatar-ai.png`、`ai-bao-avatar-photo.png`、`ai-bao-avatar-original.png`）**不打包**，只留在 `helper/assets/`。

## 7. 驗證證據與未驗證清單

已完成（2026-10-16，開發 VM：Linux / Node v24.20.0）：

- 打包管線跑通，產出 `pack/out/AI寶.exe`（103,270,400 bytes，約 98.5 MiB）。
- 成品結構驗證：PE32+ x86-64、SEA fuse 存在、`NODE_SEA_BLOB` 資源與 blob 位元組數一致、icon 資源已換成 AI寶 圖（PNG 位元組原樣存在於 exe 內）、版本字串含版權宣告、`.reloc/.data/.pdata` 與基底一致。
- **Linux SEA 自測版實跑通過**（`--target current`，與 Windows 版同一份啟動器與 bundle）：雙擊等效啟動 → 資產解開、核心與 helper 子行程啟動、3789 與 3790 皆回應 200（核心登入頁、控制台頁含版權宣告、頭像/圖示/字型路由皆 200 且頭像為新版 165,283 bytes）、第二次啟動只開瀏覽器不重複啟動、SIGTERM 優雅關閉且無殘留行程。開發模式（`node pack/launcher/entry.mjs`）同樣實跑通過。
- 測試全數通過：pack 單元測試 28/28、helper 測試 13/13、上游核心測試 207/207；`git status` 僅新增 `helper/` 與 `pack/`，上游檔案零修改。

**尚未驗證（VM 是 Linux，無法執行 Windows exe，不得視為已在 Windows 跑過）**：

1. `AI寶.exe` 在 Windows 上的實際啟動、SEA blob 讀取與三個角色行程的互動。
2. DPAPI 真正加解密（session 靜置保護）與認證管理員後端（API Key 存放）在 Windows 的行為。
3. resedit 改寫後的 icon 在 Windows 檔案總管/工作列的實際顯示、版本資訊頁籤內容。
4. 未簽章 exe 在 Windows 的 SmartScreen 提示行為（預期首次執行會跳「Windows 已保護您的電腦」，需按「其他資訊 → 仍要執行」；公司內部使用可接受，正式對外再考慮程式碼簽章）。
5. 核心 CLI 角色（`--role cli token`）在 Windows 對執行中服務產生 Token 的完整流程，以及啟用 `api.enabled` 後 helper 以 Token 連線核心的端到端（屬階段四範疇）。

## 8. 之後在 Windows 的驗證步驟

途徑 A：GitHub Actions（正式、乾淨環境）

1. 人工審核 `pack/build-windows.yml` 後，把它複製到 `.github/workflows/build-windows.yml`（放回 pack/ 不會被觸發）。
2. 在 GitHub 以 workflow_dispatch 手動執行，下載 artifact `aibao-windows-exe`（含 exe、兩張截圖、打包報告），核對截圖中核心登入頁與控制台正常、頁尾有版權宣告。

途徑 B：Windows 實機（雙擊驗收）

1. 把 `AI寶.exe` 放到任一資料夾（桌面或隨身碟），雙擊。
2. 確認主控台視窗出現啟動 log、瀏覽器自動開啟控制台（3790），且狀態卡顯示頭像為新版 AI寶。
3. 到 `%LOCALAPPDATA%\HwLineHelper` 確認資料落點（config.yaml 已產生、runtime 已解開、logs 有檔案），exe 旁邊沒有多出任何檔案。
4. 在核心頁（3789）以**次要帳號**掃 QR 登入（階段四範疇，需老吳在場）。
5. 關閉（Ctrl+C）後確認 `session.json` 已被加密成 `session.json.dpapi` 且明文消失；再次雙擊應能自動解密並維持登入狀態。
6. 啟用機器人（一次性設定）：編輯 `config.yaml` 設 `api.enabled: true` 與 `api.chats` 白名單 → 重啟 exe → 執行 `AI寶.exe --role cli token` 產生 Token → 在控制台設定頁貼上 Token 存入認證管理員。

## 9. 目錄結構

```text
pack/
  build.mjs            打包管線主腳本
  build-windows.yml    GitHub Actions 範本（審核後複製到 .github/workflows/ 才啟用）
  package.json         管線相依（esbuild、postject、resedit，皆為 devDependencies）
  launcher/
    entry.mjs          啟動器（監督者 + core/helper/cli 角色 + 資產解開）
    paths.mjs          資料目錄解析與路徑表
    dpapi.mjs          DPAPI 的 PowerShell 命令組裝與執行
    vault.mjs          session 靜置加解密流程（fail-safe）
    probe.mjs          埠探測、就緒等待、子行程規格
  tools/
    ico.mjs            PNG → ICO
    strip-signature.mjs 移除 PE 簽章
    set-exe-meta.mjs   resedit 改 icon 與版本資訊 + 讀回
    verify-exe.mjs     成品驗證（PE/SEA/icon/版本）
  test/                單元測試（paths/dpapi/vault/probe，共 28 項）
  build/               建置中間產物（gitignore）
  out/                 最終成品 AI寶.exe（gitignore）
  .cache/              官方 node.exe 下載快取（gitignore）
```
