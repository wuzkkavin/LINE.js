# AI寶 App 圖示企劃（定稿：自繪 macOS 光澤風）

## 一、macosicons.com 授權查證結論

**一句話結論：macosicons.com 沒有給予任何「可把圖示嵌入第三方產品」的授權——站上圖示是個別設計師的投稿作品、且多為既有 App 商標形象的再繪製，不得下載用於本產品（含公司內部員工版）；定稿路線為「仿 macOS 光澤風自繪」，站上頁面僅作風格參考。**

查證證據（2026-10-20 實際抓取）：

1. **站方定位是「替換自己電腦上的 App 圖示」**：分類頁標題如「Finder icons — 97 custom macOS icons for Finder, from the community」，個別圖示頁標題為「Free .icns & PNG Download」——「免費」指的是供個人下載替換自己 macOS 的圖示，未提及任何產品嵌入或再散布授權。
   - https://macosicons.com/apps/finder
   - https://macosicons.com/icon/finder-B7DXS2NKpM （圖示「Finder」作者 octaviotti，頁面僅有作者署名與下載鈕，無授權條款）
2. **投稿指南明言著作權屬個別投稿者**：「Submit your own work — Upload icons you designed. Your own take on an app's icon is welcome, but an altered copy of someone else's icon isn't.」並要求投稿者填寫設計師 credit。全站（含資源頁）查無 license／terms 頁面授予第三方使用權。
   - https://macosicons.com/resources/how-to-get-approved
   - https://macosicons.com/resources
3. **商標風險獨立存在**：apps 目錄（https://macosicons.com/zh/apps ）前 30 名幾乎全是知名 App 的替代圖示（Spotify、Discord、Google Chrome、WhatsApp、Telegram、Obsidian 等），其圖形本身即各公司的商標形象；就算投稿者同意，商標權也不在他手上。

因此本企劃**不下載任何站上圖檔**；下列「參考候選」是給自繪設計師看的風格錨點（看光澤、圓角、陰影與圖形語彙），不是取用來源。

## 二、自繪通用規格（九個圖示共用）

依站方投稿指南公開的 Apple 圖示網格（https://macosicons.com/resources/how-to-get-approved ）定規格，確保成品與 macOS 圖示並排不突兀：

- 畫布 1024×1024 PNG（透明底）；圖示主體 824×824 置中，四周各留 100px 透明邊（留給陰影）。
- 形狀：連續圓角方（squircle），圓角約為邊長 22%。
- 質感：主體上→下同色系漸層（上亮下深約 12% 明度差）；頂部一道柔和高光；底部柔和投影（模糊 24px、向下偏移 10px、不透明度 18%）。
- 圖形：白色或近白色單色符號，線寬一致（以 1024 畫布計約 56px 的圓頭線條，或實心剪影），置中、視覺重量與主體約 52%。
- 底色策略：底色不做死在圖裡——PNG 只畫「白色符號＋透明底」，底色由程式以該主題主色即時填繪（見 implementation-notes.md），五套主題共用一組圖、切主題不用換圖。例外：LINE 登入圖示底色固定 LINE 綠（品牌辨識優先，見下）。
- 輸出尺寸：256 / 128 / 64 / 48 / 32 五種 PNG；檔名 `nav-<page>.png`，存放 `app/assets/icons/`。
- 每個圖示需在 32px 實尺寸下仍可辨識（側欄實際顯示約 20–22px，驗收以 32px 截圖檢查）。

## 三、九個位置：參考候選＋自繪定稿

### 1. 總覽（Overview）
- 參考候選：Finder 分類頁 https://macosicons.com/apps/finder —「Finder」by octaviotti（https://macosicons.com/icon/finder-B7DXS2NKpM ）：雙色調笑臉，光澤與親和感是全站標竿；另「Finder Icon With Green」by epicdude2121（同分類頁）示範綠色調版本。
- 自繪定稿：主色漸層 squircle 底；白色「房屋＋圓點」符號（屋簷下一個實心圓點，像狀態指示燈）——一眼是首頁、且呼應「服務狀態」。

### 2. LINE 登入（Login）
- 參考候選：WhatsApp 分類頁 https://macosicons.com/apps/whatsapp —「WhatsApp」by Crakitus（下載數 6103，該分類人氣最高）：綠色對話泡泡＋白色符號的語彙正是通訊軟體登入的直覺形象。
- 自繪定稿：底色固定 LINE 綠 `#06C755` 漸層（此圖示不受主題變色，維持通訊品牌辨識）；白色對話泡泡（圓角、左下小尾巴），泡泡中央是一把鑰匙的鑰匙孔圓點＋短柄——「用 LINE 登入」的合成語彙。注意：不得描摹 WhatsApp 的電話聽筒圖形（商標）。

### 3. AI 設定（AI Settings）
- 參考候選：Discord 分類頁 https://macosicons.com/apps/discord-2 —「Discord」by shaundr0 等：社群平台的「機器人／助手」臉孔語彙集中在此分類，光澤 squircle＋置中臉孔的構圖可作 AI 設定的氛圍參考（只參考構圖與質感，不取其遊戲手把臉孔圖形）。
- 自繪定稿：主色漸層底；白色「三滑桿 sliders」符號（兩條水平軌道＋兩個圓鈕，與現行介面語彙一致），右上加一顆小四角星芒（sparkle）點出 AI。滑桿＝可調整的模型與參數，語意準確。

### 4. 機器人與觸發（Bot & Trigger）
- 參考候選：Telegram 分類頁 https://macosicons.com/apps/telegram —「Telegram」by alireza（下載數 3391）：圓形底＋白色紙飛機是「訊息送出／觸發」的最佳參照；「Telegram (Dark)」by crowmium 示範深色變體。
- 自繪定稿：主色漸層底；白色對話泡泡，泡泡右上角疊一顆小閃電（觸發）——泡泡代表群組對話、閃電代表「被叫到就回應」，與本頁功能（觸發規則＋白名單）對應。不用紙飛機（Telegram 商標語彙）。

### 5. 知識庫（Knowledge Base）
- 參考候選：Obsidian 分類頁 https://macosicons.com/apps/obsidian —「Obsidian Folder」by windwalker、「Obsidan folder」by caketray：資料夾／書冊與知識收藏的語彙；同頁「Obsidian」by timothyjtracey 是書本感寶石的另一種詮釋。
- 自繪定稿：主色漸層底；白色立體書本（書脊在左、書頁弧線）＋一枚垂下的書籤——「查書回答」的語意，且與 AI寶 的「回答註明來源」功能相呼應。

### 6. 防詐騙（Anti-scam）
- 參考候選：apps 目錄前 30 名無盾牌類 App 分類可引；質感基準沿用 Finder 分類頁（https://macosicons.com/apps/finder ）的光澤與陰影規範，本項以自繪規格為主。
- 自繪定稿：主色漸層底；白色盾牌輪廓，盾內一個勾勾（check）——防護＋判讀完成的語意。盾牌不用紅色（避免與「危險」狀態色混淆），狀態色只出現在狀態列。

### 7. 紀錄（Logs）
- 參考候選：Obsidian 分類頁 https://macosicons.com/apps/obsidian 的「Obsidian Folder」by windwalker（文件夾＝檔案彙整的語彙）；質感同 Finder 分類頁基準。
- 自繪定稿：主色漸層底；白色文件頁（右上折角）＋三條橫線（文字行），文件右下角疊一個小圓時鐘——「依時間留存的紀錄」語意完整。

### 8. 程式設定（App Settings）
- 參考候選：apps 目錄（https://macosicons.com/zh/apps ）的分類語彙中，齒輪是各家 Settings 圖示的共同語言；質感基準沿用 Finder 分類頁。本項以自繪規格為主。
- 自繪定稿：主色漸層底；白色八齒齒輪（齒形圓潤、中央圓孔）——與第 3 項 AI 設定的 sliders 區隔：齒輪＝程式本身的設定（自啟動、主題、視窗），sliders＝AI 的設定。

### 9. 關於（About）
- 參考候選：Finder 分類頁 https://macosicons.com/apps/finder 的笑臉系列（如「Finder Guy」by eldershi）——友善臉孔適合作為「關於我們」的氛圍參考。
- 自繪定稿：主色漸層底；白色圓圈＋小寫 i（資訊符號）。與品牌區的 AI寶 定版頭像分工：關於頁內文可放頭像大圖，側欄圖示保持符號化、九顆風格統一。

## 四、驗收要點（圖示部分）

1. 九顆圖示並排截圖（淺底與深底各一）檢查：圓角、陰影、高光一致；32px 下可辨識。
2. 五套主題各截一張側欄：圖示底色隨主色變、符號不變色（LINE 登入除外，固定綠）。
3. 與 AI寶 定版頭像（helper/assets/ai-bao-avatar.png）並置檢查不打架：頭像是吉祥物、圖示是符號，分工清楚。
