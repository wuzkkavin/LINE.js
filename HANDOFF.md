# AI寶 專案交接文件（HANDOFF）

最後更新：2026-10-16 深夜（Muse 撰寫）
讀者：未來接手本專案的 agent 或工程師。本文件自給自足，先讀完再動手。

## 1. 這是什麼

- 專案：把開源專案 LINE.js 改造成華葳集成公司 LINE 群組的「電腦學習小幫手」，名字叫「AI寶」。
- 委託人：吳治綱（老吳），GitHub 帳號 wuzkkavin。所有重大決策（對外發布、用真帳號、動他的雲端檔案）都要先經他同意。
- 上游：JS-PACKAGE/LINE.js（作者 YueyuHoshizora，益師傅的學生），Apache License 2.0；核心函式庫 @evex/linejs 釘版 3.4.2，不得擅自升版。
- Fork：wuzkkavin/LINE.js。main 分支＝上游鏡像（僅多一個 .github/workflows/build-windows.yml，原因見第 6 節）；開發分支＝ai-bao。
- 本機工作路徑：~/workspace/linejs-helper（origin＝fork，upstream＝原作者 repo）。
- 規格正本：~/workspace/linejs-test/規格書-v2.md（v2.1，共 13 節）；測試報告：同目錄 第一階段假資料測試報告.md、第二階段假資料體驗版報告.md。
- 文件備份：Google Drive「Muse 專區／AI寶 LINE 小幫手」資料夾（folder id 1K4DHnEKEUgpDfUGRwVftaZmMpvMDxk9-）。

## 2. 架構定案（不要推翻，除非老吳同意）

- 新功能全部做成 Repo 內獨立的 helper/ 伴隨模組，透過上游既有的機器人接口 /api/ws（WebSocket）連接 LINE.js 核心（127.0.0.1:3789）。
- 上游檔案零修改（git status 只應出現 helper/、pack/ 與本文件等新增物）。理由：上游持續更新，改上游會讓同步撞車。掛鉤紀錄在 helper/FORK.md（目前為零掛鉤）。
- 打包在 pack/：Node SEA 單一 exe，啟動器（pack/launcher）以多工模式自我分身成監督者／核心／helper／cli 角色。
- 資料落點（Windows）：%LOCALAPPDATA%\HwLineHelper（config、session、log、知識庫索引），絕不寫 exe 旁邊。

## 3. 功能規格重點（細節以規格書 v2.1 為準）

- 登入：專用次要 LINE 帳號 QR＋PIN（裝置 ANDROIDSECONDARY）。嚴禁用老吳主帳號。機器人以真人帳號身分在群組回答，群組須先在核心 config.yaml 的 api.chats 白名單內，機器人 Token 用核心 CLI 產生（npm run cli -- token，或 exe 的 --role cli）。
- 觸發：不用 @ 或 /。設定裡的機器人名字（主名＋別名）出現在訊息任何位置（句首／句中／句尾）＋問句或請求意圖才回（預設「標準」模式；另有寬鬆／嚴格）。名字是設定值、出廠預設「AI寶」，絕不可寫死在程式裡（改名測試必須通過）。同人冷卻 20 秒、每日回答上限可調。
- AI 供應商：OpenAI／Groq／MiniMax 三家，皆 OpenAI 相容格式共用一套客戶端；設定頁各填 Key＋模型＋測試連線，單選使用中一家。Key 存 Windows 認證管理員（DPAPI 後端在 helper/src/secrets.mjs），設定 JSON 與 log 絕不可出現 Key 明文；API 回應只回末 4 碼。
- 知識庫：設定頁指定資料夾（內容由老吳保證已脫敏），唯讀；第一版支援 .txt/.md/.csv，切段約 800 字＋BM25 索引（存資料夾外）；公司類問題先查知識庫、答案註明來源檔名，查不到要明說不編造。第二版才做 .pdf/.docx/.xlsx。
- 防詐騙：本機規則預篩（網址、短網址、高風險詞）命中才送 AI 判讀機率與手法，門檻預設 0.8，超過以 replyTo 在群組警告（文案含「僅供參考」）；支援手動貼訊息問「這是詐騙嗎」；每分鐘上限 10；TypeSafe Jev 僅保留欄位、預設停用。只分析別人的訊息。
- Log：放資料夾（Windows 為 AppData 下 logs），每日一檔保留 14 天；不記 Key/Token/QR/PIN，不記訊息全文（除錯模式除外）；控制台可下載診斷包 ZIP。
- 介面：控制台在 127.0.0.1:3790，繁體中文（台灣用語）、粉圓體、深綠＋LINE 綠卡片式；頁尾與「關於」卡必須有版權宣告，原文一字不改：「©Copyright 2026 By 吳治綱 繁體中文化」，同處並列上游出處（JS-PACKAGE/LINE.js、Apache License 2.0）。驗收截圖必須拍到宣告。
- 成品平台：只出 Windows 版（老吳定版規則）。

## 4. 素材（helper/assets/）

- ai-bao-icon.png：綠色對話泡泡，老吳提供。用途：App/exe 圖示、控制台 Logo、favicon。
- ai-bao-cutout.png：現行透明母檔（無白邊）。來源：AI 乾淨版（ai-bao-avatar-ai.png，1600×1600）以 rembg（isnet-general-use）去背，1075×1222。
- ai-bao-avatar.png：現行頭像 480×480（去背母檔＋米白底合成）。控制台狀態卡與日後 LINE 大頭貼用。
- 備份（不要打包、不要用）：ai-bao-cutout-bordered.png（舊帶白邊版，左邊白邊有缺損，勿用）、ai-bao-cutout-original.png（原照片無白邊擷取版，僅 255×295，解析度低）、ai-bao-avatar-photo.png、ai-bao-avatar-original.png。
- 原始素材出處：老吳提供的四角色合照與角色原圖在 ~/workspace/user/media_library/；弄正後的原圖在 ~/workspace/linejs-test/ai-bao-original-straightened.png（原圖斜 9.2 度，以眼睛連線量測校正）。

## 5. 目前進度與驗證證據（2026-10-16）

- 階段一（假資料摸底核心）：完成。上游 typecheck 通過、自動測試 207/207。
- 階段二（helper 體驗版）：完成。helper 測試 13/13（含端到端：FakeProvider 真核心＋本機 AI stub；句尾觸發、改名、知識庫附來源、防詐騙警告、log 無 Key 皆有斷言）。控制台截圖在 helper/screenshots/。
- 階段三（打包）：VM 內完成。pack 測試 28/28；產出 pack/out/AI寶.exe（103,270,400 bytes，PE32+ x64，基底 Node v24.20.0，icon 與版本資訊已寫入，LegalCopyright 為版權字串，證據 pack/build/build-report.json）。注意：pack/out 與 pack/build、pack/.cache 已被 .gitignore 排除，不進 Git。
- 雲端 Windows 驗證：2026-10-16 已由老吳核准並啟動，run id 38920095834（workflow build-windows，ref ai-bao）。接手者先用 gh run view 38920095834 --repo wuzkkavin/LINE.js 查結果與下載 artifact（exe、Windows 截圖、打包報告），再判讀：兩個服務 HTTP 200、控制台截圖正常、DPAPI 與認證管理員在 Windows 的實際行為（log 佐證）。若失敗，看該 run 的 job log 修管線，不要宣稱通過。
- 尚未 commit 到 main 的內容：ai-bao 分支 commit c04adaa（含 helper/、pack/、workflow 副本）。main 只有 workflow 檔 commit 633ecd1（workflow_dispatch 必須存在於預設分支才可被呼叫，這是 GitHub 的限制）。

## 6. 待辦（依序）

1. 判讀雲端驗證 run 38920095834 結果；若全過，下載該次 exe artifact 作為第一個 Windows 實測版，存 Drive「AI寶 LINE 小幫手」資料夾，並向老吳回報（含 Windows 截圖）。
2. 每次發布/驗證完成後，刪除該次 Actions artifact（老吳既定流程，避免儲存額度累積；Release 與 Drive 備份不受影響）。
3. 階段四（真帳號實測）：等老吳提供次要帳號並在場掃 QR。先進測試小群驗收（觸發、知識庫、防詐騙、log），老吳點頭才進正式公司群。相關流程：exe 啟動後在控制台操作登入，Token 以 --role cli 產生並填入 helper 設定。
4. 上游同步機制：老吳要求「上游更新要跟著更新」，但自動同步的授權範圍與檢查頻率尚未拍板（比照 Craft 家族的每日追蹤＋自動更新模式是候選）。未經老吳確認前，只做手動 git fetch upstream 比對並回報，不要自動合併發布。
5. 知識庫第二版格式（pdf/docx/xlsx）與 Jev 實際串接：未排期，等老吳指示。

## 7. 操作手冊（常用指令）

- 上游測試：Repo 根目錄 npm ci --include=dev；npm run typecheck；npm test（207 項，約 1 分鐘）。
- helper 測試：cd helper；npm test（13 項，含端到端，約 10 秒）。
- pack 測試：cd pack；npm test（28 項）。
- 本機打包（Linux 產 Windows exe）：cd pack；npm ci；node build.mjs --target win（產物 pack/out/AI寶.exe 與 pack/build/build-report.json）。基底 Node 版本跟 VM 的 Node 大版本一致（目前 v24.20.0），.cache 會下載官方 win-x64 node，不要 commit。
- 雲端驗證：gh workflow run build-windows.yml --repo wuzkkavin/LINE.js --ref ai-bao；gh run watch（workflow 內容正本在 pack/build-windows.yml，.github/workflows/ 是啟用副本，改流程要同步兩處）。
- helper 開發啟動：先讓核心跑起來並啟用 api 與白名單、產生 Token，再 cd helper；npm start（控制台 127.0.0.1:3790）。環境變數 HELPER_DATA_DIR、HELPER_PORT 可覆寫資料夾與埠。

## 8. 紅線（任何接手者都必須遵守）

- 不用主帳號、不對外公開部署（服務只綁本機）、不主動推播。
- 密碼、API Key、Token 絕不經對話傳遞、不寫進任何檔案或 log；需要老吳輸入時用安全輸入方式或讓他在設定頁貼上。
- 未經老吳同意：不 push 到 main（workflow 啟用那次是特例且已記錄）、不建 Release、不刪他的檔案、不用他的名義對外發言或送 PR。
- 修改上游檔案前先停下來：本專案的定案是零修改；若真有必要，先在 helper/FORK.md 記錄理由並知會老吳。
- 文件與 UI 一律繁體中文（台灣用語）；交付前截圖自查（字體、版面、版權宣告入鏡）。
- 驗證不過不要宣稱完成；Windows 相關結論只認雲端 run 或實機證據，不要用 Linux 自測代替。
