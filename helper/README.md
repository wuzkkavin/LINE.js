# LINE.js 電腦學習小幫手 (helper 伴隨模組)

©Copyright 2026 By 吳治綱 繁體中文化

上列宣告針對本繁體中文化／客製版本 (本 helper 模組)。上游出處: 原始專案 [JS-PACKAGE/LINE.js](https://github.com/JS-PACKAGE/LINE.js) (Apache License 2.0), 核心函式庫 [@evex/linejs](https://github.com/evex-dev/linejs) (evex-dev)。上游著作權與授權標示完整保留 (見 Repo 根目錄 `LICENSE`)。

本模組的控制台圖示 `assets/ai-bao-icon.png` (綠色對話泡泡圖) 由吳治綱提供, 用途為 App/控制台圖示, 日後單一執行檔打包的 .ico 亦由此圖產生。機器人頭像 `assets/ai-bao-avatar.png` (米色毛茸茸角色) 是從吳治綱提供的圖片裁切而成, 用途為控制台裡的頭像/形象圖與日後 LINE 次要帳號的大頭貼來源; 兩張圖用途不同, 不要混用。字體 jf open 粉圓 (jf-openhuninn-2.1) 依 SIL Open Font License 1.1 使用, 授權檔在 `assets/fonts/OFL.txt`。

## 這是什麼

住在公司 LINE 群組的電腦學習助理。機器人主名是設定值 (出廠預設「AI寶」, 可在控制台改名, 別名可自加), 同事在群組訊息裡打到名字 (句首、句中、句尾都可以) 就會觸發回應, 不用 @、不用 /。回答優先查使用者指定的知識庫資料夾, 並註明來源檔名; 另有防詐騙兩段式判讀 (本機規則預篩 + AI 判讀)。

## 架構 (為什麼做成伴隨模組)

```
LINE 服務 <-> LINE.js 核心 (上游, 本 Repo 根目錄) <-/api/ws-> helper 機器人 -> AI 供應商 (OpenAI / Groq / MiniMax)
                                                              |-> 知識庫 (唯讀資料夾 + 本機 BM25 索引)
                                                              |-> 控制台 http://127.0.0.1:3790 (狀態儀表 + 設定頁)
```

- helper 透過上游既有的 `/api/ws` 機器人接口連接核心, **上游檔案零修改** (見 `FORK.md`), 上游出新版時合併不撞車。
- helper 是 Node 22 ESM (.mjs), 只相依 `ws` 8.22.0 (與上游釘選一致)。

## 模組一覽 (src/)

| 檔案 | 職責 |
|---|---|
| `logger.mjs` | 每日一檔、保留 14 天 (可調)、中文模組標籤; 秘密遮罩紅線: 不記 API Key/Token/QR/PIN/session, 訊息全文只有除錯模式才記 |
| `secrets.mjs` | SecretStore 介面: 記憶體 (測試)、AES-256-GCM 檔案 (dev, 檔名 secrets.dev.json)、Windows 認證管理員 (wincred) + DPAPI (PowerShell, 僅 Windows) |
| `config.mjs` | 非機密設定 JSON 與三家 AI 預設值; 對外檢視只回 Key 的「已設定 + 末 4 碼」 |
| `ai.mjs` | OpenAI 相容格式共用客戶端 + `testConnection` |
| `trigger.mjs` | 名字/別名觸發 (只認設定值, 程式不寫死名字)、寬嚴三段、同人冷卻、每日上限 |
| `kb.mjs` | 知識庫唯讀掃描 (.txt/.md/.csv)、約 800 字切段、BM25 索引 (存資料夾外)、異動偵測 |
| `scam.mjs` | 防詐騙: 本機預篩 (網址/短網址/高風險詞)、AI 判讀 (機率 + 手法)、解析失敗的規則備援、每分鐘上限、手動判讀 |
| `bot.mjs` | 機器人主程式: 連 /api/ws、觸發問答、防詐騙自動掃描、對話記憶、送出節流 (配合核心每秒 5 則上限) |
| `server.mjs` | 控制台 HTTP 服務 (127.0.0.1:3790): 狀態/設定 API、測試連線、知識庫重整、Log、診斷包 (ZIP) |
| `main.mjs` | 進入點: 組裝以上模組並啟動 |
| `web/index.html` | 控制台頁面: 粉圓體、深綠 + LINE 綠、狀態儀表卡、設定分區卡、關於卡與頁尾版權宣告 |

## 啟動方式 (開發/測試)

前置: 先讓 LINE.js 核心跑起來 (Repo 根目錄 `npm ci --include=dev && npm run build && npm start`), 並在核心的 `config.yaml` 啟用 `api.enabled` 與白名單聊天室, 用 `npm run cli -- token` 產生機器人 Token。

```sh
cd helper
npm install
# 資料夾預設 helper/data (可用環境變數 HELPER_DATA_DIR 更改); 控制台埠預設 3790 (HELPER_PORT)
HELPER_LINE_TOKEN=<核心產生的機器人Token> npm start
# 開啟 http://127.0.0.1:3790 進行設定
```

API Key 可用環境變數注入 (HELPER_AI_OPENAI_KEY / HELPER_AI_GROQ_KEY / HELPER_AI_MINIMAX_KEY / HELPER_JEV_KEY), 或在控制台設定頁填寫 (存入 SecretStore)。

## 測試

```sh
cd helper && npm test   # 單元 + 端到端 (端到端會用 FakeProvider 啟動真核心與本機 AI stub)
cd .. && npm run typecheck && npm test   # 上游核心 207 項
```

階段二 (假資料版) 驗證結果: helper 13 項全過 (含端到端: 名字觸發句首/句尾、沒觸發不回、知識庫回答附來源、公司問題查不到明說、防詐騙高機率警告、低風險不打擾、手動判讀、改名 AI寶 -> 阿亮 後照樣觸發且舊名失效、log 與設定檔查無測試 Key); 上游 typecheck 通過、207 項全過。名字可自訂已在測試中驗證 (預設 AI寶 是設定值, 不是寫死)。

## 誠實註記 (尚未驗證的事)

- **Windows 機密存放尚未在真 Windows 實測**: 認證管理員 (wincred) 與 DPAPI 的 PowerShell 實作已寫好, 但本階段在 Linux 開發, 工廠函式會自動停用並改用 AES 檔案後端 (dev), 並在 log 說明。真 Windows 上的讀寫、2560 bytes 上限行為、DPAPI 跨使用者行為都要等階段三在真 Windows 驗證。
- 機器人尚未連過真 LINE 帳號、未用過真 API Key 實測 (本階段全用 FakeProvider 與本機 AI stub)。
- TypeSafe Jev 選項欄位已保留 (預設停用), 假資料版尚未實際接 Jev API; 啟用時會記錄警告並改用所選 AI 判讀。
- 單一執行檔 (SEA) 打包不在本階段範圍 (階段三); 本階段的「主機」是 Node 22 直接執行。
- 知識庫第一版只支援 .txt/.md/.csv; PDF/Word/Excel 為第二版規劃。
