# AI寶 App 主題＋圖示 施工銜接說明

給後續施工者：本文件把 design/palettes.md（色票定稿）、design/icons.md（圖示定稿）、design/preview.html（預覽稿）的落地方式講清楚。色碼與規格以那兩份為準，本文件只講「怎麼接進程式」。

## 0. 設計約束：固定視窗、單一尺寸驗證（老吳定案）

- App 視窗**固定尺寸約 1060×740，不可放大縮小**；介面縮放（UI zoom）一併鎖定。鎖定機制本身由施工批處理（viewport `resizable(false)`、固定 inner size、啟動時 `set_pixels_per_point` 固定、不回應 egui 的縮放快捷鍵），本文件只記錄它帶來的設計約束：
  - 五套主題與所有版面**只需針對 1060×740 @100% 一種尺寸**設計與驗收，不做響應式斷點、不預留窄窗版面。
  - 預覽稿 preview.html／preview.png 已按此比例呈現（每格 530×370＝50% 縮放），施工完成後的截圖應與預覽稿同構圖逐格對照。
  - 任何新頁面／新卡片進版面前，先在 1060×740 內確認不溢出、不捲動主區（頁內捲動僅限紀錄文字區等既有設計）。

## 1. 主題系統落地（egui）

### 1.1 資料結構

在 app/src 內新增 `theme.rs`（或併入 shell.rs），定義：

- `enum ThemeId { Forest, Ocean, Sakura, Violet, Mono }`，含 `fn from_str / as_str`（存檔用字串：`forest` / `ocean` / `sakura` / `violet` / `mono`）。
- `struct Palette`，欄位與 palettes.md 的角色一一對應（皆為 `egui::Color32`）：
  `bg, sidebar, card, primary, primary_hover, secondary, accent, text_main, text_sub, ok, ok_text, warn, warn_text, bad, idle, border`
- `fn palette(theme: ThemeId) -> Palette`：五套常數表，數值逐格照 palettes.md 抄，不在程式裡另行調色。

### 1.2 套用方式

- 啟動與切換時呼叫 `apply_theme(ctx, &palette)`，設定 `egui::Visuals`：
  - `panel_fill = bg`（主背景）、`window_fill = card`、`extreme_bg_color = card`（輸入框底）、`faint_bg_color = sidebar`。
  - `selection.bg_fill = primary`、`selection.stroke = 白`；`hyperlink_color = secondary`（黑白主題依 palettes.md 通用規則第 4 點，用 text_main＋底線——egui 連結樣式有限，至少顏色照表）。
  - widgets 三態（inactive / hovered / active）的 `bg_fill`、`bg_stroke`、`fg_stroke` 以 card／border／primary／text_main 對應填入；主按鈕在各頁以 `Button::fill(primary)` 個別指定（現行寫法即如此，只是色值改走 palette）。
- `App` struct 持 `theme: ThemeId` 與 `palette: Palette` 兩個欄位；所有頁面繪製函式改吃 `&self.palette`，不得再引用全域色常數。

### 1.3 現行寫死顏色盤點（main.rs，已逐行核對）

| 位置 | 現況 | 改法 |
|---|---|---|
| main.rs:24 `const GREEN` (#0C513D) | 主色全域常數 | 刪除，改 `palette.primary` |
| main.rs:25 `const LIGHT_BG` (#F3F8F3) | 背景全域常數 | 刪除，改 `palette.bg` |
| `card()` 函式（約 711–712 行） | fill 寫死 WHITE、stroke 寫死 #D8E4D8、標題色 GREEN | 改吃 palette.card / border / primary |
| main.rs:534–537 `COLOR_OK/WARN/BAD/IDLE` | 狀態色常數 | 改 palette.ok / warn / bad / idle；狀態文字需上色時用 ok_text / warn_text（palettes.md 狀態色規則） |
| 側欄導覽按鈕（約 643–645 行） | 選中 fill=GREEN、未選文字 #333333 | fill 改 palette.primary；未選文字改 palette.text_main |
| 其餘散列 Color32（846、848、1761、1770 行等） | 個別寫死 | 施工時以 `grep -n "Color32::" app/src/*.rs` 全量盤點逐一歸類：屬主題角色者改走 palette；與主題無關者（QR 碼繪製的黑白、約 1515–1524 行）保留寫死並註解原因 |

側欄底色目前與主背景同色（LIGHT_BG），新設計要分出側欄一階：側欄 Panel 的 Frame fill 改 `palette.sidebar`。

### 1.4 選擇與持久化

- `shell.rs` 的 `ShellSettings`（現有欄位 `show_window_on_start`、`tray_hint_shown`，存 `shell-settings.json`）新增：
  `#[serde(default = "default_theme")] pub theme: String`（預設 `forest`）。load/save 沿用既有函式，不另開檔案。
- 程式設定頁（main.rs 約 2161 行起）新增「介面主題」卡片：五個選項橫排，每個是「色票圓鈕（主色填滿、邊框 border 色）＋主題名」，點選即：即時 `apply_theme` → 寫回 ShellSettings → 當前頁重繪。旁邊註明「立即生效，不需重新啟動」。
- 自啟動（--autostart）與一般啟動共用同一條套用路徑：讀 ShellSettings → 套用 → 再畫第一幀，避免開機時先閃預設綠再跳色。

## 2. 圖示嵌入

- 素材：依 icons.md 自繪規格產出 `app/assets/icons/nav-<page>.png`（page = overview / line-login / ai-settings / bot / kb / scam / logs / app-settings / about），只畫白色符號＋透明底；LINE 登入一顆為全彩定版（綠底泡泡，直接畫死顏色）。
- 程式以 `include_bytes!` 嵌入（比照現行字型 FONT_BYTES 與頭像的作法），啟動時解碼成 `egui::TextureHandle` 快取在 App struct（九顆各一），切主題不重載。
- 側欄按鈕改圖文橫排：`ui.horizontal` 內先畫底色圓角方（fill = 選中時 primary、未選時 primary 55% 不透明度），再疊圖示 Texture（白色符號，約 20×20），右側放文字標籤。因為底色是程式填的，五主題共用一組 PNG；選中態另在列左緣加 3px primary 實條（與 palettes.md 黑白主題的選中態規則一致，五套通用）。
- 備援：圖示解碼失敗時退回純文字按鈕（現行樣式），不得 panic；log 記一筆。
- 系統匣圖示與視窗圖示不受主題影響，沿用既有定版（ai-bao-icon），不動。

## 3. 驗收截圖清單（施工完成後逐張拍、逐張親驗）

視窗一律 1060×740、100% 縮放；每張都要拍到頁尾版權宣告「©Copyright 2026 By 吳治綱 繁體中文化」才算數。

1. 五套主題 × 總覽頁（5 張）：對照 preview.png 同格檢查——側欄底色、卡片、主按鈕、狀態圓點、三列狀態文字皆為該主題色；森林綠應與現行畫面幾乎一致（僅側欄多一階底色）。
2. 五套主題 × 機器人與觸發頁（5 張）：檢查選中態（主色填滿＋左緣實條）、九顆側欄圖示在各主題下辨識度一致。
3. 程式設定頁（森林綠，1 張）：主題卡片五個色票圓鈕與名稱完整入鏡。
4. 切換連拍（任一主題→另一主題，2 張）：切換前後各一，證明即時生效且版面不跳動。
5. 系統匣（1 張）：右鍵選單展開＋匣圖示入鏡，證明主題施工未影響系統匣。
6. 圖示近拍（1 張）：九顆側欄圖示在 100% 下的近拍，檢查光澤、圓角與 20px 辨識度（對 icons.md 第四節）。
7. 重開驗證（1 張）：切到非預設主題→結束程式→重開，第一幀即為所選主題（不閃綠），且 ShellSettings 已存檔（附 shell-settings.json 的 theme 欄位截圖或內容）。
