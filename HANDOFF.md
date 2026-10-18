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
- ai-bao-avatar.png：現行頭像（定版）。老吳於 2026-10-16 深夜親自處理後提供：1277×1232 RGBA、透明底、白色貼紙邊完整均勻。原檔原樣保存（MD5 53d0a1617d54dfa8ad38258349e45f49），不得再裁切或加工；控制台狀態卡與日後 LINE 大頭貼用。原圖出處在 ~/workspace/user/media_library/（image/ca/ 下）。
- 其餘頭像衍生檔（先前 Muse 製作的 cutout 與各版 avatar）：老吳指示不要，已於 2026-10-16 全數移入 Muse 垃圾桶（2026-11-15 到期，期間可用 trash.restore 救回），Repo 內不再存在，不要再引用。pack 打包的資產清單若列有 ai-bao-cutout.png，須改為只內嵌 ai-bao-avatar.png 與 ai-bao-icon.png。

## 5. 目前進度與驗證證據（2026-10-16）

- 階段一（假資料摸底核心）：完成。上游 typecheck 通過、自動測試 207/207。
- 階段二（helper 體驗版）：完成。helper 測試 13/13（含端到端：FakeProvider 真核心＋本機 AI stub；句尾觸發、改名、知識庫附來源、防詐騙警告、log 無 Key 皆有斷言）。控制台截圖在 helper/screenshots/。
- 階段三（打包）：VM 內完成。pack 測試 28/28；產出 pack/out/AI寶.exe（103,270,400 bytes，PE32+ x64，基底 Node v24.20.0，icon 與版本資訊已寫入，LegalCopyright 為版權字串，證據 pack/build/build-report.json）。注意：pack/out 與 pack/build、pack/.cache 已被 .gitignore 排除，不進 Git。
- 雲端 Windows 驗證：2026-10-16 已由老吳核准並啟動，run id 38920095834（workflow build-windows，ref ai-bao）。接手者先用 gh run view 38920095834 --repo wuzkkavin/LINE.js 查結果與下載 artifact（exe、Windows 截圖、打包報告），再判讀：兩個服務 HTTP 200、控制台截圖正常、DPAPI 與認證管理員在 Windows 的實際行為（log 佐證）。若失敗，看該 run 的 job log 修管線，不要宣稱通過。
- 雲端驗證第二輪（run 38921241900）：失敗。原因為啟動器跨行程競態——監督者與 core 子行程同時呼叫 ensureRuntime 解開資產並以 cpSync 鏡像 dist/web，Windows 檔案鎖下 core 在 copyDir 撞上「檔案正被另一行程使用」（EPIPE）啟動即以 code=1 結束；Linux 本機因檔案鎖語義不同不重現。第一輪通過純屬時序幸運。
- 競態修復（2026-10-16 深夜）：解開邏輯抽至 pack/launcher/runtime.mjs——mkdir 原子鎖（.runtime-lock）串行化，只有持鎖者動檔案，其餘行程輪詢等待（逾時 120 秒、殘留鎖 60 秒可打破）；解開改走暫存目錄寫入＋.extracted-ok 標記＋原子換名；dist/web 鏡像加 .mirror-ok 版本標記、換名失敗退回就地複製；檔案操作包 retryOnBusy 對 EBUSY/EPERM/EPIPE/EACCES 退避重試。pack/test 新增並發回歸測試（3 行程並發 ensureRuntime），pack 測試 33/33、本機重打包 exe 104,715,776 bytes（build-report ok）。
- 雲端驗證第三輪（run 38922892169，commit ae37c72）：整體結論 failure，但競態修復已驗證有效——「啟動 exe 並等待服務就緒」步驟通過（第二輪正是死在此步），打包與關閉、上傳皆成功。唯一失敗步驟是「截圖核心登入頁與控制台」：Chrome headless 啟動約 0.8 秒即結束且未產生 PNG，步驟在 Test-Path 檢查如設計拋錯（截圖失敗, 檔案未產生: pack/build/core-3789.png），故本輪 artifact 仍只有 exe（104,716,288 bytes）與打包報告、無截圖。截圖問題與啟動器無關，下一步應查 runner 上 Chrome headless 的實際錯誤（目前 log 無 Chrome stderr；可改為擷取 Chrome 輸出與 exit code，或換截圖工具），修好再重跑一輪補截圖，不要把第三輪說成全過。
- 雲端驗證第四輪（run 38923430084）：啟動再次通過（競態修復穩定）；截圖仍失敗但已錄到關鍵證據——pwsh 直接呼叫 GUI 子系統的 Chrome 不會等待（exit 立即返回、無輸出），PNG 未產生即被判失敗。
- 雲端驗證第五輪（run 38923830484）：全步驟成功，階段三驗證完成。截圖步驟改用 Start-Process -Wait 等待瀏覽器結束後，console-3790.png 與 core-3789.png 皆取得（存於 pack/cloud-run-38923830484/）。雲端版 exe 104,716,288 bytes 已備份 Drive「AI寶 LINE 小幫手」資料夾（file id 1yTbIkbr80ame9KFg26sXJIJY-cdwmCnY，大小核對一致）；五輪的 Actions artifact 已全數刪除（老吳既定流程）。注意：雲端跑的是乾淨 runner 無真 Key/真帳號，DPAPI 與認證管理員的真實寫入仍待階段四或老吳實機操作時佐證（程式路徑已在 runner 上實際執行、未報錯）。
- 尚未 commit 到 main 的內容：ai-bao 分支開發中。main 只有 workflow 檔 commit 633ecd1（workflow_dispatch 必須存在於預設分支才可被呼叫，這是 GitHub 的限制）；workflow 內容更新時須同步 main 與 ai-bao 兩處的 .github/workflows/build-windows.yml（正本在 pack/build-windows.yml）。

## 6. 待辦（依序）

1. （已完成）雲端驗證五輪結果判讀、最終版 exe 備份 Drive、五輪 artifact 清理，皆於 2026-10-16 深夜完成，見第 5 節。
2. 每次發布/驗證完成後，刪除該次 Actions artifact（老吳既定流程，避免儲存額度累積；Release 與 Drive 備份不受影響）。
3. 階段四（真帳號實測）：等老吳提供次要帳號並在場掃 QR。先進測試小群驗收（觸發、知識庫、防詐騙、log），老吳點頭才進正式公司群。相關流程：exe 啟動後在控制台操作登入，Token 以 --role cli 產生並填入 helper 設定。建議老吳可先在他自己的 Windows 電腦雙擊 Drive 上的 AI寶.exe 試跑（免安裝、免帳號也能開控制台看介面；首次會跳 SmartScreen 需按「仍要執行」）。
4. 上游同步機制（2026-10-18 已拍板並落地）：老吳授權比照 Craft 家族——併入每日排程「每日 Git Repo 更新日報」（cron cadcraft-upstream-weekly-check，每日約 09:47）第 C 節：每日 fetch upstream 比對基準，有新提交即自動同步 main 與 ai-bao、跑三套測試（上游 typecheck＋test、helper、pack），全過才觸發雲端 Windows 驗證並把新 exe 備份 Drive（舊版移垃圾桶、刪該次 artifact），結果寫進當日 email 日報；衝突（固定衝突點 .github/workflows/build-windows.yml 以 pack 正本為準除外）或測試/雲端不過就停下回報、不發布半成品。基準紀錄在 ~/workspace/goals/cadcraft/hidden_files/storytold-state.md 末尾「LINE.js 基準」段。首次同步已於 2026-10-18 手動完成：上游 3 提交（8750efd 機器人 API 查聊天室管理員、e9e8c2b、12b9385 Jev 範本改 jev-latest）併入，上游測試增至 235 項全過、helper 13、pack 33；雲端 run 39088178621 全步驟成功；新 exe 104,719,872 bytes 已備份 Drive（id 1bpc5rjU2BapeWHGgzW2NmvDmH0V7s8p1）。同日老吳另交辦 Ubuntu 版（私人 repo wuzkkavin/ubuntu-line-helper），其同步同樣由該排程第 C 節涵蓋（Windows 先、Ubuntu 後）。
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
