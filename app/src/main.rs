#![cfg_attr(windows, windows_subsystem = "windows")]

// AI寶 Windows 原生 App (規格書 v3): Rust + egui 殼, 內嵌 TypeScript 引擎 (核心 + helper)。
// 設計原則: 畫面全原生、不開瀏覽器; 設定與 AI 功能一律呼叫 helper 既有本機 API, 不重寫業務邏輯;
// LINE 登入走核心 WS 協定 (照上游 CLI 的非瀏覽器連線方式)。
mod core_ws;
mod engine;
mod helper_api;
mod platform;
mod probe;
mod shell;
mod theme;

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use core_ws::{AuthState, LoginUi, SharedLogin, WsCommand};
use engine::{EngineManager, EngineState, StopOutcome};
use serde_json::Value;

const COPYRIGHT: &str = "©Copyright 2026 By 吳治綱";
const UPSTREAM_CREDIT: &str = "上游出處: JS-PACKAGE/LINE.js (Apache-2.0) ・ @evex/linejs (evex-dev)";

// 介面顏色一律走 theme 模組的 Palette (設計定稿 design/palettes.md), 不得再寫死色碼;
// 僅 QR 碼的黑/白是功能必需 (掃描對比), 不屬主題色。

const FONT_BYTES: &[u8] = include_bytes!("../../helper/assets/fonts/jf-openhuninn-2.1.ttf");
const AVATAR_BYTES: &[u8] = include_bytes!("../../helper/assets/ai-bao-avatar.png");
const ICON_BYTES: &[u8] = include_bytes!("../../helper/assets/ai-bao-icon.png");

type Slot<T> = Arc<Mutex<Option<T>>>;

#[derive(Debug, Clone, Copy)]
enum AppSignal {
    ShowWindow,
    QuitApp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Page {
    Overview,
    LineLogin,
    AiSettings,
    BotSettings,
    KbSettings,
    ScamSettings,
    Logs,
    AppSettings,
    About,
}

/// 側欄導覽順序與標籤 (圖示與頁面一一對應, 順序即 nav_icons 的索引)。
const NAV_PAGES: [(Page, &str); 9] = [
    (Page::Overview, "總覽"),
    (Page::LineLogin, "LINE 登入"),
    (Page::AiSettings, "AI 設定"),
    (Page::BotSettings, "機器人與觸發"),
    (Page::KbSettings, "知識庫"),
    (Page::ScamSettings, "防詐騙"),
    (Page::Logs, "紀錄"),
    (Page::AppSettings, "程式設定"),
    (Page::About, "關於"),
];

/// 自繪側欄圖示 (白色符號 + 透明底; LINE 登入為全彩定版)。產生方式與 SVG 源檔
/// 見 assets/icons/ (generate_icons.py); 底色由繪製端依主題主色即時填繪,
/// 圖示本身不帶主題色, 切主題不必換圖。
fn nav_icon_bytes(page: Page) -> &'static [u8] {
    match page {
        Page::Overview => include_bytes!("../assets/icons/nav-overview-256.png"),
        Page::LineLogin => include_bytes!("../assets/icons/nav-line-login-256.png"),
        Page::AiSettings => include_bytes!("../assets/icons/nav-ai-settings-256.png"),
        Page::BotSettings => include_bytes!("../assets/icons/nav-bot-256.png"),
        Page::KbSettings => include_bytes!("../assets/icons/nav-kb-256.png"),
        Page::ScamSettings => include_bytes!("../assets/icons/nav-scam-256.png"),
        Page::Logs => include_bytes!("../assets/icons/nav-logs-256.png"),
        Page::AppSettings => include_bytes!("../assets/icons/nav-app-settings-256.png"),
        Page::About => include_bytes!("../assets/icons/nav-about-256.png"),
    }
}

#[derive(Clone, Default)]
struct ProviderForm {
    label: String,
    base_url: String,
    model: String,
    key_input: String,
    configured: bool,
    last4: String,
    models: Vec<String>,
    models_msg: Option<String>,
    test_msg: Option<String>,
}

#[derive(Default)]
struct SettingsForm {
    loaded: bool,
    bot_name: String,
    aliases_text: String,
    trigger_mode: String,
    cooldown_sec: u32,
    daily_limit: u32,
    ai_active: String,
    providers: HashMap<String, ProviderForm>,
    scam_enabled: bool,
    scam_threshold: f64,
    scam_per_minute: u32,
    jev_enabled: bool,
    jev_model: String,
    kb_folder: String,
    show_sources: bool,
    creator_reply: String,
    persona_birthdate: String,
    persona_gender: String,
    persona_zodiac: String,
    persona_measurements: String,
    persona_interests: String,
    persona_marital: String,
    persona_intro: String,
    line_token_configured: bool,
    line_token_last4: String,
    line_token_input: String,
    save_msg: Option<String>,
}

struct HelperSnap {
    status: Option<Value>,
    settings: Option<Value>,
    err: Option<String>,
}

#[derive(Clone, Default)]
struct EngineSnap {
    state: EngineState,
    label: String,
    pid: Option<u32>,
}

impl Default for EngineState {
    fn default() -> Self {
        EngineState::NotStarted
    }
}

struct App {
    engine: Arc<Mutex<EngineManager>>,
    engine_snap: EngineSnap,
    login: SharedLogin,
    login_tx: Sender<WsCommand>,
    signals: Receiver<AppSignal>,
    page: Page,
    snap: Arc<Mutex<HelperSnap>>,
    form: SettingsForm,
    form_needs_load: bool,
    test_slots: HashMap<String, Slot<Value>>,
    model_slots: HashMap<String, Slot<Value>>,
    busy: HashMap<String, bool>,
    token_slot: Slot<Value>,
    apply_slot: Slot<Value>,
    chats_slot: Slot<Value>,
    group_chats: Vec<Value>,
    chats_loaded: bool,
    wl_slot: Slot<Value>,
    whitelist: Vec<Value>,
    wl_loaded: bool,
    // 白名單自動載入只嘗試一次 (第 5 項修復): 舊版以 !wl_loaded 為條件每幀重打,
    // 端點失敗時 wl_loaded 永遠為 false, 60fps 無限重試把 log 灌爆、錯誤訊息疊加。
    // 改為: 進頁自動載入一次, 失敗就停, 使用者按「重新讀取白名單」才再試。
    wl_attempted: bool,
    // 機器人聊天情況面板 (第 12 項): 活動端點的最近結果與上次抓取時間
    activity_slot: Arc<Mutex<Option<serde_json::Value>>>,
    activity: Option<serde_json::Value>,
    activity_fetched_at: Option<std::time::Instant>,
    activity_msg: Option<String>,
    line_cfg_status: Slot<Value>,
    reindex_slot: Slot<Value>,
    save_slot: Slot<Value>,
    page_msg: HashMap<String, String>,
    logs_slot: Slot<Value>,
    logs_text: String,
    diag_slot: Slot<String>,
    repair_slot: Slot<Vec<String>>,
    repair_lines: Vec<String>,
    avatar_tex: Option<egui::TextureHandle>,
    /// 登入帳號的實際 LINE 頭像 (以核心 profile 的 pictureId 向 /media 取圖)。
    /// account_avatar_id 記錄目前這張圖對應的 pictureId, id 沒變就不重抓;
    /// 抓取/解碼失敗不把 id 記死 (舊版記死後永遠不再試, 一次偶發失敗就一輩子顯示
    /// 品牌圖), 改記失敗次數與下次可重試時間: 間隔 20 秒、最多 6 次, 且每次
    /// 「連線成功 (含 session 還原)」都重置額度重新嘗試。抓不到時顯示退回品牌頭像。
    account_avatar_tex: Option<egui::TextureHandle>,
    account_avatar_id: Option<String>,
    account_avatar_fetching: Option<String>,
    account_avatar_slot: Slot<(String, Result<Vec<u8>, String>)>,
    account_avatar_attempts: u32,
    account_avatar_retry_at: Option<std::time::Instant>,
    account_avatar_ready_seen: bool,
    hidden: bool,
    confirm_quit: bool,
    quitting: bool,
    quit_outcome: Arc<Mutex<Option<StopOutcome>>>,
    quit_blocked_msg: Option<String>,
    show_tray_hint: bool,
    confirm_logout: bool,
    autostart_arg: bool,
    shell_settings: shell::ShellSettings,
    /// 目前主題與其色票 (所有頁面繪製吃 palette, 不再引用全域色常數)。
    theme_id: theme::ThemeId,
    palette: theme::Palette,
    /// 側欄圖示紋理, 索引與 NAV_PAGES 對齊; 解碼失敗為 None (側欄退回純文字, 已記 log)。
    nav_icons: [Option<egui::TextureHandle>; 9],
    #[cfg(windows)]
    tray: Option<Tray>,
}

#[cfg(windows)]
struct Tray {
    _icon: tray_icon::TrayIcon,
    status_item: tray_icon::menu::MenuItem,
    open_id: tray_icon::menu::MenuId,
    restart_id: tray_icon::menu::MenuId,
    quit_id: tray_icon::menu::MenuId,
    icon_id: tray_icon::TrayIconId,
    last_state_key: String,
    normal_icon: tray_icon::Icon,
    gray_icon: tray_icon::Icon,
}

/// 解碼圖片位元組為 RGBA: 依內容自動辨識格式 (不再強制 PNG)。
/// 為什麼改 (2026-10-20 驗收修復): 登入帳號的實際頭像是向核心 /media 取的 LINE 頭像圖,
/// LINE 的頭像原圖是 JPEG; 舊版強制以 PNG 格式解碼, JPEG 位元組必然失敗, 總覽與側欄
/// 永遠退回品牌定版圖 (實機回報「頭像沒換成帳號實際頭像」的程式層根因)。品牌圖示等
/// PNG 素材走同一條路徑照常解碼。
fn decode_image_rgba(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory(bytes).ok()?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    Some((rgba.into_raw(), w, h))
}

/// 圖示專用縮放: 以「預乘 alpha 面積加權」把 RGBA 縮到目標尺寸, 並先置中補成正方形。
/// 為什麼不用原圖 (233x232) 直交 egui/winit 與 tray-icon 自行縮放 (2026-10-20 實機回報
/// 工作列圖示不見、系統匣 icon 黑邊): 來源圖是二值 alpha (只有 0/255) 的硬邊圖,
/// 透明像素的 RGB 是白色; 系統以非預乘方式即時縮小 233 到 16/20 時, 邊緣像素會被
/// 透明區的顏色 (或縮放緩衝區的黑色) 污染而出現黑邊, 超大圖示的 HICON 轉換也不穩。
/// 在這裡先算出帶正確抗鋸齒邊的小圖, 呼叫端幾乎不必再縮放, 邊緣才乾淨。
/// 只處理縮小 (目標邊長小於來源); 否則原樣回傳 (仍會補正方形)。
fn icon_rgba(size: u32) -> Option<(Vec<u8>, u32, u32)> {
    let (rgba, w, h) = decode_image_rgba(ICON_BYTES)?;
    // 置中貼到正方形透明畫布 (來源 233x232 非正方形, 直接給非正方形尺寸會被拉伸變形)
    let side = w.max(h);
    let mut canvas = vec![0u8; (side * side * 4) as usize];
    let ox = ((side - w) / 2) as usize;
    let oy = ((side - h) / 2) as usize;
    for y in 0..h as usize {
        let src_row = &rgba[y * w as usize * 4..(y + 1) * w as usize * 4];
        let dst = ((y + oy) * side as usize + ox) * 4;
        canvas[dst..dst + src_row.len()].copy_from_slice(src_row);
    }
    if size >= side {
        return Some((canvas, side, side));
    }
    // 面積加權: 每個輸出像素涵蓋來源的一個矩形範圍, 以重疊面積為權重累積預乘顏色
    let (tw, th) = (size, size);
    let mut out = vec![0u8; (tw * th * 4) as usize];
    let sx = side as f64 / tw as f64;
    let sy = side as f64 / th as f64;
    for ty in 0..th {
        let y0 = ty as f64 * sy;
        let y1 = y0 + sy;
        for tx in 0..tw {
            let x0 = tx as f64 * sx;
            let x1 = x0 + sx;
            let (mut r, mut g, mut b, mut a) = (0f64, 0f64, 0f64, 0f64);
            let mut yy = y0.floor() as u32;
            while (yy as f64) < y1 {
                let wy = ((yy as f64 + 1.0).min(y1) - (yy as f64).max(y0)).max(0.0);
                if wy > 0.0 {
                    let mut xx = x0.floor() as u32;
                    while (xx as f64) < x1 {
                        let wx = ((xx as f64 + 1.0).min(x1) - (xx as f64).max(x0)).max(0.0);
                        if wx > 0.0 {
                            let idx = ((yy * side + xx) * 4) as usize;
                            let alpha = canvas[idx + 3] as f64 / 255.0;
                            let weight = wx * wy;
                            r += canvas[idx] as f64 * alpha * weight;
                            g += canvas[idx + 1] as f64 * alpha * weight;
                            b += canvas[idx + 2] as f64 * alpha * weight;
                            a += alpha * weight;
                        }
                        xx += 1;
                    }
                }
                yy += 1;
            }
            let o = ((ty * tw + tx) * 4) as usize;
            let area = sx * sy;
            let alpha_out = a / area;
            out[o + 3] = (alpha_out * 255.0).round().clamp(0.0, 255.0) as u8;
            if a > 1e-9 {
                // r/g/b 累積的是 (0..255 色值 x alpha x 權重), 除以 a 即 alpha 加權平均原色 (0..255);
                // 全透明像素 RGB 保持 0, 不帶任何顏色污染
                out[o] = (r / a).round().clamp(0.0, 255.0) as u8;
                out[o + 1] = (g / a).round().clamp(0.0, 255.0) as u8;
                out[o + 2] = (b / a).round().clamp(0.0, 255.0) as u8;
            }
        }
    }
    Some((out, tw, th))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    shell::log_line(&format!("AI寶 App 啟動, 參數: {}", args[1..].join(" ")));
    if args.iter().any(|a| a == "--probe-login") {
        std::process::exit(probe::run_probe());
    }
    if args.iter().any(|a| a == "--version") {
        println!("AI寶 App {} (引擎 {})", env!("CARGO_PKG_VERSION"), engine::ENGINE_ID);
        return;
    }
    let autostart = args.iter().any(|a| a == "--autostart");
    let quit_arg = args.iter().any(|a| a == "--quit");

    // ---- 單一實例: 第二實例只通知既有實例 (顯示視窗或結束), 自己隨即退出 ----
    #[cfg(windows)]
    let _singleton = {
        match platform::acquire_singleton("HwLineHelper-AiBao-SingleInstance") {
            Some(s) => Some(s),
            None => {
                if quit_arg {
                    platform::signal_named_event("HwLineHelper-AiBao-Quit");
                } else {
                    platform::signal_named_event("HwLineHelper-AiBao-Show");
                }
                return;
            }
        }
    };

    let (sig_tx, sig_rx) = std::sync::mpsc::channel::<AppSignal>();
    #[cfg(windows)]
    {
        let tx = sig_tx.clone();
        platform::spawn_event_waiter("HwLineHelper-AiBao-Show", move || {
            let _ = tx.send(AppSignal::ShowWindow);
        });
        let tx = sig_tx.clone();
        platform::spawn_event_waiter("HwLineHelper-AiBao-Quit", move || {
            let _ = tx.send(AppSignal::QuitApp);
        });
    }

    // 自啟動路徑自癒: 登錄值存在但路徑與目前 exe 不同 (被搬移/改名) 時自動改寫
    #[cfg(windows)]
    {
        if let Some(current) = platform::autostart_get() {
            if let Ok(exe) = std::env::current_exe() {
                let recorded = platform::autostart_exe_of(&current);
                if recorded != exe {
                    if platform::autostart_set(&exe).is_ok() {
                        shell::log_line(&format!("自啟動路徑自癒: {} → {}", recorded.display(), exe.display()));
                    }
                }
            }
        }
    }

    let shell_settings = shell::ShellSettings::load();
    let start_hidden = autostart || !shell_settings.show_window_on_start;

    // 視窗尺寸鎖定(2026-10-20 老吳指示):不給使用者任意放大縮小,避免版面被
    // 拉到走樣。沿用現行設計尺寸 1024x720:resizable(false) 之外再把 min/max
    // 釘在同一尺寸雙重保險;最大化按鈕也明確關掉 (with_maximize_button(false)
    // + with_maximized(false)) — 不靠「Windows 會隨 resizable 一併停用」的慣例,
    // 老吳驗收時明示連最大化都不行, 設定寫死在 builder 上可直接查證。
    // 縮到系統匣、最小化、關閉行為不受影響;--autostart 走同一條路徑同樣固定。
    let mut viewport = egui::ViewportBuilder::default()
        .with_title("AI寶")
        .with_inner_size([1024.0, 720.0])
        .with_min_inner_size([1024.0, 720.0])
        .with_max_inner_size([1024.0, 720.0])
        .with_resizable(false)
        .with_maximize_button(false)
        .with_maximized(false)
        .with_visible(!start_hidden);
    // 視窗/工作列圖示: 給預先縮好的 64px 圖 (理由見 icon_rgba), 不再直交 233x232 原圖
    if let Some((rgba, w, h)) = icon_rgba(64) {
        viewport = viewport.with_icon(egui::IconData { rgba, width: w, height: h });
    }
    let options = eframe::NativeOptions {
        viewport,
        renderer: eframe::Renderer::Wgpu,
        ..Default::default()
    };
    let settings_for_app = shell_settings;
    let result = eframe::run_native(
        "AI寶",
        options,
        Box::new(move |cc| {
            // 停用 egui 介面縮放(老吳指示):關掉鍵盤縮放捷徑(Ctrl +/- /0),
            // pixels_per_point 只跟隨系統 DPI;捏合手勢的 Event::Zoom 在
            // App::update 每幀濾除,zoom_factor 也每幀強制回 1.0。
            cc.egui_ctx
                .memory_mut(|m| m.options.zoom_with_keyboard = false);
            Ok(Box::new(App::new(cc, sig_rx, autostart, start_hidden, settings_for_app)))
        }),
    );
    if let Err(e) = result {
        shell::log_line(&format!("eframe 結束時回報錯誤: {e}"));
    }
}

fn install_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    fonts.font_data.insert(
        "huninn".to_string(),
        Arc::new(egui::FontData::from_static(FONT_BYTES)),
    );
    for family in [egui::FontFamily::Proportional, egui::FontFamily::Monospace] {
        fonts
            .families
            .entry(family)
            .or_default()
            .insert(0, "huninn".to_string());
    }
    ctx.set_fonts(fonts);
    ctx.all_styles_mut(|style| {
        style.text_styles.insert(egui::TextStyle::Body, egui::FontId::proportional(16.0));
        style.text_styles.insert(egui::TextStyle::Button, egui::FontId::proportional(16.0));
        style.text_styles.insert(egui::TextStyle::Heading, egui::FontId::proportional(24.0));
    });
}

/// helper 資料輪詢: 每 3 秒抓 /api/status; settings 尚未載入且服務可用時抓一次。
fn spawn_helper_poller(snap: Arc<Mutex<HelperSnap>>, ctx: egui::Context) {
    std::thread::spawn(move || loop {
        match helper_api::get_status() {
            Ok(v) => {
                let need_settings = snap.lock().unwrap().settings.is_none();
                let settings = if need_settings {
                    helper_api::get_settings().ok()
                } else {
                    None
                };
                let mut g = snap.lock().unwrap();
                g.status = Some(v);
                g.err = None;
                if g.settings.is_none() {
                    if let Some(s) = settings {
                        g.settings = Some(s);
                    }
                }
            }
            Err(e) => {
                let mut g = snap.lock().unwrap();
                g.err = Some(e);
            }
        }
        ctx.request_repaint();
        std::thread::sleep(Duration::from_secs(3));
    });
}

fn refresh_line_cfg_status(app: &mut App) {
    let slot = app.line_cfg_status.clone();
    let ctx_slot = slot.clone();
    let _ = ctx_slot;
    std::thread::spawn(move || {
        if let Ok(v) = helper_api::line_config_status() {
            *slot.lock().unwrap() = Some(v);
        }
    });
}

#[cfg(windows)]
fn build_tray() -> Option<Tray> {
    use tray_icon::menu::{Menu, MenuItem, PredefinedMenuItem};
    // 系統匣圖示: 給預先縮好的 32px 圖 (涵蓋 100% 到 200% DPI 的 16/20/24 顯示尺寸,
    // 理由見 icon_rgba), 不再讓 Windows 把 233x232 原圖即時縮小而產生黑邊
    let (rgba, w, h) = icon_rgba(32)?;
    let normal = tray_icon::Icon::from_rgba(rgba.clone(), w, h).ok()?;
    // 灰階版: 未登入/異常時用 (飽和度降為 0)
    let mut gray = rgba.clone();
    for px in gray.chunks_exact_mut(4) {
        let g = ((px[0] as u32 * 30 + px[1] as u32 * 59 + px[2] as u32 * 11) / 100) as u8;
        px[0] = g;
        px[1] = g;
        px[2] = g;
    }
    let gray_icon = tray_icon::Icon::from_rgba(gray, w, h).ok()?;

    let menu = Menu::new();
    let open_item = MenuItem::new("開啟主視窗", true, None);
    let status_item = MenuItem::new("狀態: 啟動中", false, None);
    let restart_item = MenuItem::new("重新啟動引擎", true, None);
    let quit_item = MenuItem::new("結束服務並關閉程式", true, None);
    let sep = PredefinedMenuItem::separator();
    menu.append(&open_item).ok()?;
    menu.append(&status_item).ok()?;
    menu.append(&sep).ok()?;
    menu.append(&restart_item).ok()?;
    menu.append(&quit_item).ok()?;
    let open_id = open_item.id().clone();
    let restart_id = restart_item.id().clone();
    let quit_id = quit_item.id().clone();
    let icon = tray_icon::TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("AI寶 — 啟動中")
        .with_icon(normal.clone())
        .build()
        .ok()?;
    let icon_id = icon.id().clone();
    Some(Tray {
        _icon: icon,
        status_item,
        open_id,
        restart_id,
        quit_id,
        icon_id,
        last_state_key: String::new(),
        normal_icon: normal,
        gray_icon,
    })
}

impl App {
    fn new(
        cc: &eframe::CreationContext<'_>,
        signals: Receiver<AppSignal>,
        autostart_arg: bool,
        start_hidden: bool,
        shell_settings: shell::ShellSettings,
    ) -> Self {
        install_fonts(&cc.egui_ctx);
        // 主題在第一幀之前就套用 (一般啟動與 --autostart 走同一條路徑):
        // 讀已存的 ShellSettings.theme, 不會先閃一下預設森林綠再跳色。
        let theme_id = theme::ThemeId::from_str(&shell_settings.theme);
        theme::apply_theme(&cc.egui_ctx, theme_id);

        let login: SharedLogin = Arc::new(Mutex::new(LoginUi::default()));
        let (login_tx, login_rx) = std::sync::mpsc::channel::<WsCommand>();
        let repaint_ctx: Arc<Mutex<Option<egui::Context>>> = Arc::new(Mutex::new(Some(cc.egui_ctx.clone())));
        core_ws::spawn_login_thread(login.clone(), login_rx, repaint_ctx);

        let snap = Arc::new(Mutex::new(HelperSnap { status: None, settings: None, err: None }));
        spawn_helper_poller(snap.clone(), cc.egui_ctx.clone());

        let engine = Arc::new(Mutex::new(EngineManager::new()));
        {
            let mut mgr = engine.lock().unwrap();
            if let Err(e) = mgr.start() {
                shell::log_line(&format!("引擎啟動失敗: {e}"));
                mgr.state = EngineState::Failed(e);
            }
        }

        let avatar_tex = decode_image_rgba(AVATAR_BYTES).map(|(rgba, w, h)| {
            let img = egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba);
            cc.egui_ctx.load_texture("avatar", img, egui::TextureOptions::LINEAR)
        });

        // 側欄圖示: 任一顆解碼失敗只退回該顆純文字按鈕並記 log, 不 panic、不擋啟動。
        let mut nav_icons: [Option<egui::TextureHandle>; 9] = Default::default();
        for (idx, (page, _)) in NAV_PAGES.iter().enumerate() {
            nav_icons[idx] = decode_image_rgba(nav_icon_bytes(*page)).map(|(rgba, w, h)| {
                let img = egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba);
                cc.egui_ctx.load_texture(format!("nav-{idx}"), img, egui::TextureOptions::LINEAR)
            });
            if nav_icons[idx].is_none() {
                shell::log_line(&format!("側欄圖示載入失敗 (page={page:?}), 該顆退回純文字按鈕"));
            }
        }

        #[cfg(windows)]
        let tray = build_tray();
        let mut app = Self {
            engine,
            engine_snap: EngineSnap::default(),
            login,
            login_tx,
            signals,
            page: Page::Overview,
            snap,
            form: SettingsForm::default(),
            form_needs_load: true,
            test_slots: HashMap::new(),
            model_slots: HashMap::new(),
            busy: HashMap::new(),
            token_slot: Arc::new(Mutex::new(None)),
            apply_slot: Arc::new(Mutex::new(None)),
            chats_slot: Arc::new(Mutex::new(None)),
            group_chats: Vec::new(),
            chats_loaded: false,
            wl_slot: Arc::new(Mutex::new(None)),
            whitelist: Vec::new(),
            wl_loaded: false,
            wl_attempted: false,
            activity_slot: Arc::new(Mutex::new(None)),
            activity: None,
            activity_fetched_at: None,
            activity_msg: None,
            line_cfg_status: Arc::new(Mutex::new(None)),
            reindex_slot: Arc::new(Mutex::new(None)),
            save_slot: Arc::new(Mutex::new(None)),
            page_msg: HashMap::new(),
            logs_slot: Arc::new(Mutex::new(None)),
            logs_text: String::new(),
            diag_slot: Arc::new(Mutex::new(None)),
            repair_slot: Arc::new(Mutex::new(None)),
            repair_lines: Vec::new(),
            avatar_tex,
            account_avatar_tex: None,
            account_avatar_id: None,
            account_avatar_fetching: None,
            account_avatar_slot: Arc::new(Mutex::new(None)),
            account_avatar_attempts: 0,
            account_avatar_retry_at: None,
            account_avatar_ready_seen: false,
            hidden: start_hidden,
            confirm_quit: false,
            quitting: false,
            quit_outcome: Arc::new(Mutex::new(None)),
            quit_blocked_msg: None,
            show_tray_hint: false,
            confirm_logout: false,
            autostart_arg,
            shell_settings,
            theme_id,
            palette: theme_id.palette(),
            nav_icons,
            #[cfg(windows)]
            tray,
        };
        if autostart_arg {
            shell::log_line("以 --autostart 模式啟動 (縮系統匣, 引擎自動拉起)");
        }
        refresh_line_cfg_status(&mut app);
        app
    }

    fn show_window(&mut self, ctx: &egui::Context) {
        self.hidden = false;
        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(true));
        ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(false));
        ctx.send_viewport_cmd(egui::ViewportCommand::Focus);
    }

    fn hide_window(&mut self, ctx: &egui::Context) {
        self.hidden = true;
        ctx.send_viewport_cmd(egui::ViewportCommand::Visible(false));
    }

    /// 開始結束序列: 背景執行緒執行 engine.stop() (訊號優雅結束→強制清除→逐埠驗證), 完成後主執行緒依結果處理;
    /// 停不下來 (BlockedForeign / Residual) 就不關窗, 改顯示白話說明與殘留明細 (不假裝已結束)。
    fn begin_quit(&mut self, ctx: &egui::Context) {
        if self.quitting {
            return;
        }
        self.quitting = true;
        self.confirm_quit = false;
        self.show_window(ctx);
        let engine = self.engine.clone();
        let slot = self.quit_outcome.clone();
        std::thread::spawn(move || {
            let outcome = {
                let mut mgr = engine.lock().unwrap();
                mgr.stop()
            };
            shell::log_line(&format!("結束序列完成: {outcome:?}"));
            *slot.lock().unwrap() = Some(outcome);
        });
    }

    fn restart_engine(&mut self) {
        let engine = self.engine.clone();
        std::thread::spawn(move || {
            let mut mgr = engine.lock().unwrap();
            let _ = mgr.stop();
            if let Err(e) = mgr.start() {
                shell::log_line(&format!("重新啟動引擎失敗: {e}"));
                mgr.state = EngineState::Failed(e);
            }
        });
    }

    /// 一鍵修復 (消費級基線: 使用者不該用指令自救): 在背景執行緒診斷常見壞狀態並安全自修。
    /// 能修的: 引擎沒在跑/狀態鎖死/服務無回應 → 走 EngineManager 既有 stop()+start()
    /// (start 內含世代與版本判定: 自家舊建置 stack 先清除再啟新版; 真外來佔用會被擋下並在
    /// Failed 訊息裡附佔用者名稱 — 修復不硬搶, 把那段訊息原樣整理給使用者看)。
    /// 機器人斷線但引擎與服務都正常時: helper 本身會退避自動重連, 修復只等待並確認結果。
    /// 結果以白話逐項寫進 repair_slot, 總覽頁列出「做了什麼」。
    fn start_repair(&mut self, ctx: &egui::Context) {
        if self.busy.get("repair").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("repair".into(), true);
        self.repair_lines = vec!["修復中… 正在檢查服務狀態".to_string()];
        let slot = self.repair_slot.clone();
        let engine = self.engine.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let mut lines: Vec<String> = Vec::new();
            let mut restarted = false;
            let state0 = engine.lock().unwrap().state.clone();
            let helper_ok = helper_api::ping_helper();
            let need_restart = match state0 {
                EngineState::Running | EngineState::ExternalRunning => {
                    if helper_ok {
                        lines.push("檢查完成: 引擎與服務都在正常回應".to_string());
                        false
                    } else {
                        lines.push("檢查發現: 引擎顯示執行中, 但服務沒有回應".to_string());
                        true
                    }
                }
                EngineState::Starting => {
                    lines.push("檢查發現: 引擎還在啟動中, 先等它完成".to_string());
                    false
                }
                EngineState::Failed(_) => {
                    lines.push("檢查發現: 引擎處於異常停止狀態".to_string());
                    true
                }
                EngineState::Stopped | EngineState::NotStarted => {
                    lines.push("檢查發現: 引擎目前沒有在執行".to_string());
                    true
                }
            };
            if need_restart {
                lines.push("已重新啟動引擎 (舊的服務會先被清乾淨, 再啟動目前版本的引擎)".to_string());
                let mut mgr = engine.lock().unwrap();
                let _ = mgr.stop();
                match mgr.start() {
                    Ok(()) => {
                        restarted = true;
                    }
                    Err(e) => {
                        mgr.state = EngineState::Failed(e.clone());
                        lines.push(format!("自動修復到這裡停住了: {e}"));
                        lines.push("上面有寫佔用的程式名稱: 請先在工作管理員結束它, 再重新開啟 AI寶。".to_string());
                    }
                }
            }
            if restarted || matches!(state0, EngineState::Running | EngineState::ExternalRunning) {
                // 等服務就緒並確認機器人連線 (剛重啟要給它時間; 本來就在跑則快速確認)
                let wait_rounds = if restarted { 12 } else { 4 };
                let mut bot_ok = false;
                let mut svc_ok = false;
                for _ in 0..wait_rounds {
                    std::thread::sleep(Duration::from_secs(2));
                    if let Ok(v) = helper_api::get_status() {
                        svc_ok = true;
                        bot_ok = v
                            .get("bot")
                            .and_then(|b| b.get("botConnected"))
                            .and_then(|x| x.as_bool())
                            .unwrap_or(false);
                        if bot_ok {
                            break;
                        }
                    }
                }
                if svc_ok && bot_ok {
                    lines.push("確認完成: 服務已恢復, 機器人已連線, 可以到群組測試了".to_string());
                } else if svc_ok {
                    lines.push("服務已恢復回應; 機器人還在自動連線中 (它會自己重試, 不用再處理)。若超過一分鐘還沒連上, 請到「機器人與觸發」頁確認 Token 是否已設定".to_string());
                } else {
                    lines.push("服務還是沒有回應: 請把 AI寶 完全關閉後重新開啟一次; 若還是不行, 請到「紀錄」頁匯出診斷包給維護人員".to_string());
                }
            } else if matches!(state0, EngineState::Starting) {
                lines.push("引擎還在啟動, 請等左下角變成「引擎: 執行中」再到群組測試".to_string());
            }
            shell::log_line(&format!("一鍵修復完成: {}", lines.join(" / ")));
            *slot.lock().unwrap() = Some(lines);
            ctx2.request_repaint();
        });
    }

    fn engine_tick_and_snap(&mut self) {
        if let Ok(mut mgr) = self.engine.try_lock() {
            mgr.tick();
            self.engine_snap = EngineSnap {
                state: mgr.state.clone(),
                label: mgr.state_label().to_string(),
                pid: mgr.pid,
            };
        }
    }

    fn login_snapshot(&self) -> LoginUi {
        self.login.lock().unwrap().clone()
    }

    /// 每幀同步帳號實際頭像: pictureId 出現或變化時在背景抓圖, 成功就換上 texture;
    /// 失敗記 log (白話原因) 並退回品牌頭像, 但不記死: 20 秒後可再試 (最多 6 次),
    /// 且每次連線成功 (含 session 還原的 Ready) 都重置次數重新嘗試 — 舊版把失敗
    /// 記成「已處理」永不再試, 一次偶發失敗 (核心媒體未就緒、cookie 流程競態)
    /// 就永遠顯示品牌圖。登出 (pictureId 消失) 時清掉帳號頭像, 下次登入會重新抓。
    fn sync_account_avatar(&mut self, ctx: &egui::Context) {
        let snap = self.login_snapshot();
        let want = snap.profile_picture_id.clone();
        // 連線成功 (Ready) 的上升緣: 重置重試額度 — 每次連上都重新嘗試取得頭像
        let ready_now = snap.connected && snap.auth == AuthState::Ready;
        if ready_now && !self.account_avatar_ready_seen {
            self.account_avatar_attempts = 0;
            self.account_avatar_retry_at = None;
        }
        self.account_avatar_ready_seen = ready_now;
        if let Some((id, res)) = self.account_avatar_slot.lock().unwrap().take() {
            if self.account_avatar_fetching.as_deref() == Some(id.as_str()) {
                self.account_avatar_fetching = None;
            }
            if want.as_deref() == Some(id.as_str()) {
                match res {
                    Ok(bytes) => {
                        self.account_avatar_tex = decode_image_rgba(&bytes).map(|(rgba, w, h)| {
                            let img = egui::ColorImage::from_rgba_unmultiplied(
                                [w as usize, h as usize],
                                &rgba,
                            );
                            ctx.load_texture("account-avatar", img, egui::TextureOptions::LINEAR)
                        });
                        if self.account_avatar_tex.is_some() {
                            self.account_avatar_id = Some(id);
                            self.account_avatar_attempts = 0;
                            self.account_avatar_retry_at = None;
                        } else {
                            self.account_avatar_attempts += 1;
                            self.account_avatar_retry_at =
                                Some(std::time::Instant::now() + std::time::Duration::from_secs(20));
                            shell::log_line("帳號頭像解碼失敗, 退回品牌頭像顯示 (稍後會自動再試)");
                        }
                    }
                    Err(e) => {
                        self.account_avatar_tex = None;
                        self.account_avatar_attempts += 1;
                        self.account_avatar_retry_at =
                            Some(std::time::Instant::now() + std::time::Duration::from_secs(20));
                        shell::log_line(&format!("帳號頭像抓取失敗, 退回品牌頭像顯示 (稍後會自動再試): {e}"));
                    }
                }
            }
        }
        match &want {
            None => {
                if self.account_avatar_id.is_some() || self.account_avatar_tex.is_some() {
                    self.account_avatar_id = None;
                    self.account_avatar_tex = None;
                }
                self.account_avatar_attempts = 0;
                self.account_avatar_retry_at = None;
            }
            Some(id) => {
                let retry_due = self
                    .account_avatar_retry_at
                    .map_or(true, |t| std::time::Instant::now() >= t);
                if self.account_avatar_id.as_deref() != Some(id.as_str())
                    && self.account_avatar_fetching.as_deref() != Some(id.as_str())
                    && self.account_avatar_attempts < 6
                    && retry_due
                {
                    let id = id.clone();
                    let slot = self.account_avatar_slot.clone();
                    self.account_avatar_fetching = Some(id.clone());
                    std::thread::spawn(move || {
                        let res = core_ws::fetch_profile_picture(&id);
                        *slot.lock().unwrap() = Some((id, res));
                    });
                }
            }
        }
    }

    /// 顯示用頭像: 優先登入帳號的實際頭像, 沒有就用品牌定版頭像。
    fn display_avatar(&self) -> Option<&egui::TextureHandle> {
        self.account_avatar_tex.as_ref().or(self.avatar_tex.as_ref())
    }

    fn helper_status(&self) -> Option<Value> {
        self.snap.lock().unwrap().status.clone()
    }

    /// 切換介面主題: 即時套用並存檔, 重開沿用, 不需要重啟程式。
    fn set_theme(&mut self, ctx: &egui::Context, id: theme::ThemeId) {
        if id == self.theme_id {
            return;
        }
        self.theme_id = id;
        self.palette = id.palette();
        theme::apply_theme(ctx, id);
        self.shell_settings.theme = id.as_str().to_string();
        self.shell_settings.save();
        shell::log_line(&format!("介面主題切換為 {}", id.as_str()));
        ctx.request_repaint();
    }

    /// 側欄導覽列一顆 (圖 + 文橫排): 圖示片是主色圓角方 + 白色符號, 底色由程式
    /// 依目前主題即時填繪 (LINE 登入圖自帶全彩底除外)。選中態: 整列主色底、
    /// 白字, 列左緣溝槽再加 3px 主色實條 (五套主題同一形狀語言, 不靠色相辨識)。
    /// 圖示紋理缺失時退回純文字置中, 不留空位。
    fn nav_item(&self, ui: &mut egui::Ui, idx: usize, page: Page, label: &str) -> bool {
        let pal = self.palette;
        let selected = self.page == page;
        let (rect, resp) = ui.allocate_exact_size(egui::vec2(152.0, 34.0), egui::Sense::click());
        let painter = ui.painter();
        if selected {
            painter.rect_filled(rect, 7.0, pal.primary);
            let bar = egui::Rect::from_min_max(
                egui::pos2(rect.left() - 6.0, rect.top() + 4.0),
                egui::pos2(rect.left() - 3.0, rect.bottom() - 4.0),
            );
            painter.rect_filled(bar, 1.5, pal.primary);
        } else if resp.hovered() {
            painter.rect_filled(rect, 7.0, theme::with_alpha(pal.primary, 26));
        }
        let center_y = rect.center().y;
        let text_color = if selected { egui::Color32::WHITE } else { pal.text_main };
        match &self.nav_icons[idx] {
            Some(tex) => {
                let chip = egui::Rect::from_center_size(
                    egui::pos2(rect.left() + 18.0, center_y),
                    egui::vec2(24.0, 24.0),
                );
                if page == Page::LineLogin {
                    // LINE 登入: 全彩定版圖 (LINE 綠), 不疊主題色片; 本體含留邊,
                    // 略放大讓視覺重量與其他顆一致。
                    let img_rect = egui::Rect::from_center_size(chip.center(), egui::vec2(27.0, 27.0));
                    painter.image(
                        tex.id(),
                        img_rect,
                        egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1.0, 1.0)),
                        egui::Color32::WHITE,
                    );
                } else {
                    let chip_fill = if selected {
                        theme::with_alpha(egui::Color32::WHITE, 56)
                    } else {
                        theme::with_alpha(pal.primary, 140) // 主色 55%
                    };
                    painter.rect_filled(chip, 6.0, chip_fill);
                    painter.image(
                        tex.id(),
                        chip,
                        egui::Rect::from_min_max(egui::Pos2::ZERO, egui::pos2(1.0, 1.0)),
                        egui::Color32::WHITE,
                    );
                }
                painter.text(
                    egui::pos2(rect.left() + 38.0, center_y),
                    egui::Align2::LEFT_CENTER,
                    label,
                    egui::FontId::proportional(15.0),
                    text_color,
                );
            }
            None => {
                painter.text(
                    rect.center(),
                    egui::Align2::CENTER_CENTER,
                    label,
                    egui::FontId::proportional(15.0),
                    text_color,
                );
            }
        }
        if resp.hovered() {
            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        }
        resp.clicked()
    }
}

// ---------- 共用 UI 小工具 ----------

fn card<R>(ui: &mut egui::Ui, pal: theme::Palette, title: &str, body: impl FnOnce(&mut egui::Ui) -> R) -> R {
    egui::Frame::default()
        .fill(pal.card)
        .stroke(egui::Stroke::new(1.0, pal.border))
        .corner_radius(10.0)
        .inner_margin(egui::Margin::same(14))
        .show(ui, |ui| {
            ui.label(egui::RichText::new(title).strong().color(pal.primary).size(17.0));
            ui.add_space(6.0);
            body(ui)
        })
        .inner
}

fn status_dot(color: egui::Color32) -> egui::RichText {
    egui::RichText::new("●").color(color).size(16.0)
}

/// 主要動作按鈕 (每頁的主 CTA): 主題主色實心 + 白字; 次要動作維持預設描邊按鈕,
/// 讓畫面有主次之分 (設計稿: 主要按鈕 = 主色)。
fn primary_btn(ui: &mut egui::Ui, pal: theme::Palette, label: &str) -> egui::Response {
    let text = egui::RichText::new(label).color(egui::Color32::WHITE);
    ui.add(egui::Button::new(text).fill(pal.primary))
}

// ---------- eframe 主迴圈 ----------

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        let ctx = &ctx;
        // 介面縮放鎖定(老吳指示):每幀濾掉捏合手勢產生的 Zoom 事件、重申鍵盤
        // 縮放停用,並把 zoom_factor 強制回 1.0 — pixels_per_point 只跟隨系統
        // DPI,不被使用者以快捷鍵或手勢改動(視窗尺寸鎖定在 main 的 viewport)。
        ctx.input_mut(|i| {
            i.events.retain(|e| !matches!(e, egui::Event::Zoom(_)));
        });
        ctx.memory_mut(|m| m.options.zoom_with_keyboard = false);
        if (ctx.zoom_factor() - 1.0).abs() > f32::EPSILON {
            ctx.set_zoom_factor(1.0);
        }
        ctx.request_repaint_after(Duration::from_millis(400));
        self.engine_tick_and_snap();
        self.sync_account_avatar(ctx);

        // 第二實例/系統匣喚醒與結束訊號
        while let Ok(sig) = self.signals.try_recv() {
            match sig {
                AppSignal::ShowWindow => self.show_window(ctx),
                AppSignal::QuitApp => {
                    // --quit 是明確指令 (自動化/支援用), 直接進結束序列, 不再跳確認框;
                    // 介面上的結束按鈕 (視窗/系統匣) 仍一律先跳確認框 (規格書 v3 第 7 節)。
                    self.begin_quit(ctx);
                }
            }
        }

        // 結束序列完成 → 依結果處理: 驗證真的停了才關視窗; 停不下來 (BlockedForeign / Residual) 取消結束並明說。
        if self.quitting {
            let outcome = self.quit_outcome.lock().unwrap().take();
            if let Some(outcome) = outcome {
                match outcome {
                    StopOutcome::BlockedForeign(msg) | StopOutcome::Residual(msg) => {
                        self.quitting = false;
                        self.quit_blocked_msg = Some(msg);
                        shell::log_line("結束序列中止: 服務未完全停止, 已顯示說明給使用者 (不關窗)");
                    }
                    StopOutcome::ForcedStop => {
                        // 有用到強制手段才清乾淨: 不粉飾, engine.stop 已留下完整階段紀錄, 這裡再記一筆後正常關窗
                        shell::log_line("結束序列完成: 以強制手段清乾淨 (ForcedStop), 關閉視窗");
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                    _ => {
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                }
            }
        }

        // 視窗行為: 最小化與 X 都改成縮到系統匣 (規格書 v3 第 7 節);
        // 第一次縮小時先跳白話提示, 避免使用者以為「關掉視窗 = 結束程式」(2026-10-20 老吳實機誤會)。
        let (close_requested, minimized) = ctx.input(|i| {
            let v = i.viewport();
            (v.close_requested(), v.minimized)
        });
        if !self.quitting {
            if close_requested {
                ctx.send_viewport_cmd(egui::ViewportCommand::CancelClose);
                if self.shell_settings.tray_hint_shown {
                    self.hide_window(ctx);
                    shell::log_line("主視窗關閉鍵 → 縮到系統匣 (服務繼續執行)");
                } else {
                    self.show_tray_hint = true;
                    shell::log_line("主視窗關閉鍵 → 先顯示系統匣提示 (第一次)");
                }
            } else if minimized == Some(true) {
                ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(false));
                if self.shell_settings.tray_hint_shown {
                    self.hide_window(ctx);
                    shell::log_line("主視窗最小化 → 縮到系統匣 (服務繼續執行)");
                } else {
                    self.show_tray_hint = true;
                    shell::log_line("主視窗最小化 → 先顯示系統匣提示 (第一次)");
                }
            }
        }

        self.poll_tray(ctx);
        self.poll_async_results(ctx);
        self.sync_tray_status();

        // 左側導覽 (Frame 底色換成 palette.sidebar, 與主背景分出一階;
        // 內距比照 egui 預設 side panel (8, 2), 版面尺寸不變)
        egui::Panel::left("nav")
            .resizable(false)
            .exact_size(168.0)
            .frame(
                egui::Frame::default()
                    .fill(self.palette.sidebar)
                    .inner_margin(egui::Margin::symmetric(8, 2)),
            )
            .show(ui, |ui| {
                ui.add_space(10.0);
                ui.vertical_centered(|ui| {
                    if let Some(tex) = self.display_avatar() {
                        ui.image((tex.id(), egui::vec2(72.0, 72.0)));
                    }
                    ui.label(egui::RichText::new("AI寶").strong().size(20.0).color(self.palette.primary));
                    ui.label(egui::RichText::new("LINE 學習小幫手").size(12.0).weak());
                });
                ui.add_space(12.0);
                for idx in 0..NAV_PAGES.len() {
                    let (page, label) = NAV_PAGES[idx];
                    if self.nav_item(ui, idx, page, label) {
                        self.page = page;
                        if page == Page::BotSettings {
                            refresh_line_cfg_status(self);
                        }
                    }
                }
                ui.with_layout(egui::Layout::bottom_up(egui::Align::Center), |ui| {
                    if ui
                        .button(egui::RichText::new("結束服務並關閉程式").color(self.palette.bad))
                        .on_hover_text("真的停止服務並關閉 AI寶 (會先跳確認)")
                        .clicked()
                    {
                        self.confirm_quit = true;
                    }
                    ui.label(
                        egui::RichText::new(format!("引擎: {}", self.engine_snap.label))
                            .size(12.0)
                            .weak(),
                    );
                });
            });

        // 頁尾: 版權宣告 (每一頁都要在, 規格書固定要求)
        egui::Panel::bottom("footer").show(ui, |ui| {
            ui.horizontal_centered(|ui| {
                ui.label(egui::RichText::new(COPYRIGHT).size(12.5).color(self.palette.primary));
                ui.separator();
                ui.label(egui::RichText::new(UPSTREAM_CREDIT).size(12.5).weak());
            });
        });

        egui::CentralPanel::default().show(ui, |ui| {
            egui::ScrollArea::vertical().show(ui, |ui| match self.page {
                Page::Overview => self.page_overview(ui),
                Page::LineLogin => self.page_login(ui),
                Page::AiSettings => self.page_ai(ui),
                Page::BotSettings => self.page_bot(ui),
                Page::KbSettings => self.page_kb(ui),
                Page::ScamSettings => self.page_scam(ui),
                Page::Logs => self.page_logs(ui),
                Page::AppSettings => self.page_app_settings(ui, ctx),
                Page::About => self.page_about(ui),
            });
        });

        // 結束確認框
        if self.confirm_quit {
            egui::Window::new("確認結束")
                .collapsible(false)
                .resizable(false)
                .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
                .show(ctx, |ui| {
                    if matches!(self.engine_snap.state, EngineState::ExternalRunning) {
                        ui.label("目前在跑的服務不是由這個視窗啟動的 (是另一個 AI寶 程式)。結束時會請它一起停止; 如果停不下來, 會再告訴你, 不會假裝已經關好。確定要結束嗎?");
                    } else {
                        ui.label("結束後 AI寶 將停止回覆群組訊息, 確定要結束服務並關閉程式嗎?");
                    }
                    ui.add_space(10.0);
                    ui.horizontal(|ui| {
                        if ui.button("取消").clicked() {
                            self.confirm_quit = false;
                        }
                        if ui
                            .button(egui::RichText::new("結束服務並關閉程式").color(self.palette.bad).strong())
                            .clicked()
                        {
                            self.begin_quit(ctx);
                        }
                    });
                });
        }

        // 登出確認框 (登出 = 帳號層級, 不結束程式; 沿用核心既有清除行為)
        if self.confirm_logout {
            egui::Window::new("確認登出")
                .collapsible(false)
                .resizable(false)
                .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
                .show(ctx, |ui| {
                    ui.label("登出會清除這台電腦上的登入資料, 下次需要重新掃描 QR 碼。確定登出嗎? (程式不會結束)");
                    ui.add_space(10.0);
                    ui.horizontal(|ui| {
                        if ui.button("取消").clicked() {
                            self.confirm_logout = false;
                        }
                        if ui.button(egui::RichText::new("確定登出").color(self.palette.bad)).clicked() {
                            self.confirm_logout = false;
                            let _ = self.login_tx.send(WsCommand::Logout);
                        }
                    });
                });
        }

        // 系統匣提示 (第一次按 X 或最小化時): 講清楚「關視窗 ≠ 結束程式」
        if self.show_tray_hint {
            egui::Window::new("AI寶還在執行")
                .collapsible(false)
                .resizable(false)
                .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
                .show(ctx, |ui| {
                    ui.label("提醒: 把視窗關起來, 程式不會結束。AI寶 會縮到 Windows 右下角的「系統匣」繼續執行, LINE 服務照常運作。");
                    ui.label("要真正停止服務並關閉程式, 請用系統匣圖示右鍵選單, 或視窗左下角的「結束服務並關閉程式」。");
                    ui.add_space(10.0);
                    ui.horizontal(|ui| {
                        if ui.button("先不要").clicked() {
                            self.show_tray_hint = false;
                        }
                        if ui.button(egui::RichText::new("知道了, 縮到系統匣").strong()).clicked() {
                            self.shell_settings.tray_hint_shown = true;
                            self.shell_settings.save();
                            self.show_tray_hint = false;
                            self.hide_window(ctx);
                            shell::log_line("系統匣提示已確認, 之後縮小不再提示");
                        }
                    });
                });
        }

        // 結束未成說明框 (服務不是本視窗啟的、又停不下來時, 明說不假裝)
        if let Some(msg) = self.quit_blocked_msg.clone() {
            egui::Window::new("服務還在執行")
                .collapsible(false)
                .resizable(false)
                .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
                .show(ctx, |ui| {
                    ui.label(msg);
                    ui.add_space(10.0);
                    if ui.button("知道了").clicked() {
                        self.quit_blocked_msg = None;
                    }
                });
        }

        // 結束中遮罩
        if self.quitting {
            egui::Window::new("正在結束")
                .collapsible(false)
                .resizable(false)
                .anchor(egui::Align2::CENTER_CENTER, [0.0, 0.0])
                .show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        ui.spinner();
                        ui.label("正在結束服務並封存登入資料…");
                    });
                });
        }
    }
}

impl App {
    fn poll_tray(&mut self, ctx: &egui::Context) {
        #[cfg(windows)]
        {
            use tray_icon::menu::MenuEvent;
            use tray_icon::{MouseButton, MouseButtonState, TrayIconEvent};
            while let Ok(ev) = MenuEvent::receiver().try_recv() {
                if let Some(tray) = &self.tray {
                    if ev.id == tray.open_id {
                        self.show_window(ctx);
                    } else if ev.id == tray.restart_id {
                        self.restart_engine();
                    } else if ev.id == tray.quit_id {
                        self.show_window(ctx);
                        self.confirm_quit = true;
                    }
                }
            }
            while let Ok(ev) = TrayIconEvent::receiver().try_recv() {
                if let Some(tray) = &self.tray {
                    if ev.id() == &tray.icon_id {
                        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
                        | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } = ev
                        {
                            self.show_window(ctx);
                        }
                    }
                }
            }
        }
        let _ = ctx;
    }

    /// 系統匣狀態同步: 圖示三態 (正常/灰階) 與狀態文字; 狀態鍵不變就不重設, 避免閃爍。
    fn sync_tray_status(&mut self) {
        #[cfg(windows)]
        {
            let login = self.login_snapshot();
            let (key, text, ok) = tray_state_of(&self.engine_snap, &login);
            if let Some(tray) = &mut self.tray {
                if tray.last_state_key != key {
                    tray.last_state_key = key;
                    tray.status_item.set_text(&text);
                    let _ = tray._icon.set_tooltip(Some(&format!("AI寶 — {text}")));
                    let _ = tray._icon.set_icon(Some(if ok {
                        tray.normal_icon.clone()
                    } else {
                        tray.gray_icon.clone()
                    }));
                }
            }
        }
    }
}

#[cfg(windows)]
fn tray_state_of(engine: &EngineSnap, login: &LoginUi) -> (String, String, bool) {
    match engine.state {
        EngineState::Running | EngineState::ExternalRunning => match login.auth {
            AuthState::Ready => {
                let name = login.profile_name.clone().unwrap_or_default();
                ("ready".into(), format!("LINE 已連線{name}"), true)
            }
            AuthState::Authenticating => ("auth".into(), "LINE 登入中".into(), false),
            AuthState::Restoring => ("restoring".into(), "LINE 登入恢復中".into(), false),
            AuthState::Error => ("error".into(), "LINE 登入異常, 請開啟主視窗處理".into(), false),
            _ => ("idle".into(), "LINE 尚未登入".into(), false),
        },
        EngineState::Starting => ("starting".into(), "引擎啟動中".into(), false),
        EngineState::Failed(_) => ("failed".into(), "引擎異常停止".into(), false),
        EngineState::Stopped => ("stopped".into(), "引擎已停止".into(), false),
        EngineState::NotStarted => ("notstarted".into(), "引擎尚未啟動".into(), false),
    }
}

// ---------- 設定表單: 載入 / 儲存 ----------

impl App {
    fn fill_form(&mut self, v: &Value) {
        let f = &mut self.form;
        f.bot_name = v.get("botName").and_then(|x| x.as_str()).unwrap_or("AI寶").to_string();
        f.aliases_text = v
            .get("aliases")
            .and_then(|x| x.as_array())
            .map(|arr| arr.iter().filter_map(|s| s.as_str()).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        f.trigger_mode = v.get("triggerMode").and_then(|x| x.as_str()).unwrap_or("standard").to_string();
        f.cooldown_sec = v.get("cooldownSec").and_then(|x| x.as_u64()).unwrap_or(20) as u32;
        f.daily_limit = v.get("dailyLimit").and_then(|x| x.as_u64()).unwrap_or(100) as u32;
        f.ai_active = v.get("ai").and_then(|a| a.get("active")).and_then(|x| x.as_str()).unwrap_or("openai").to_string();
        f.providers.clear();
        if let Some(providers) = v.get("ai").and_then(|a| a.get("providers")).and_then(|p| p.as_object()) {
            for (pid, pv) in providers {
                f.providers.insert(
                    pid.clone(),
                    ProviderForm {
                        label: pv.get("label").and_then(|x| x.as_str()).unwrap_or(pid).to_string(),
                        base_url: pv.get("baseUrl").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        model: pv.get("model").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        key_input: String::new(),
                        configured: pv.get("set").and_then(|x| x.as_bool()).unwrap_or(false),
                        last4: pv.get("last4").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        models: Vec::new(),
                        models_msg: None,
                        test_msg: None,
                    },
                );
            }
        }
        let scam = v.get("scam").cloned().unwrap_or(Value::Null);
        f.scam_enabled = scam.get("enabled").and_then(|x| x.as_bool()).unwrap_or(true);
        f.scam_threshold = scam.get("threshold").and_then(|x| x.as_f64()).unwrap_or(0.8);
        f.scam_per_minute = scam.get("perMinute").and_then(|x| x.as_u64()).unwrap_or(10) as u32;
        f.jev_enabled = scam.get("jev").and_then(|j| j.get("enabled")).and_then(|x| x.as_bool()).unwrap_or(false);
        f.jev_model = scam
            .get("jev")
            .and_then(|j| j.get("model"))
            .and_then(|x| x.as_str())
            .unwrap_or("jev-1.13.0")
            .to_string();
        f.kb_folder = v.get("kb").and_then(|k| k.get("folder")).and_then(|x| x.as_str()).unwrap_or("").to_string();
        f.show_sources = v.get("showSources").and_then(|x| x.as_bool()).unwrap_or(false);
        f.creator_reply = v
            .get("creatorReply")
            .and_then(|x| x.as_str())
            .unwrap_or("是吳治綱大師創造此機器人，©Copyright By 吳治綱")
            .to_string();
        let persona = v.get("persona").cloned().unwrap_or(Value::Null);
        let pstr = |k: &str| persona.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        f.persona_birthdate = pstr("birthdate");
        f.persona_gender = pstr("gender");
        f.persona_zodiac = pstr("zodiac");
        f.persona_measurements = pstr("measurements");
        f.persona_interests = pstr("interests");
        f.persona_marital = pstr("maritalStatus");
        f.persona_intro = pstr("intro");
        let line = v.get("line").cloned().unwrap_or(Value::Null);
        f.line_token_configured = line.get("set").and_then(|x| x.as_bool()).unwrap_or(false);
        f.line_token_last4 = line.get("last4").and_then(|x| x.as_str()).unwrap_or("").to_string();
        f.loaded = true;
    }

    fn collect_settings_body(&self) -> Value {
        let f = &self.form;
        let aliases: Vec<Value> = f
            .aliases_text
            .split([',', '、', ' '])
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| Value::String(s.to_string()))
            .collect();
        let mut providers = serde_json::Map::new();
        for (pid, p) in &f.providers {
            let mut pv = serde_json::json!({ "baseUrl": p.base_url, "model": p.model });
            if !p.key_input.is_empty() {
                pv["apiKey"] = Value::String(p.key_input.clone());
            }
            providers.insert(pid.clone(), pv);
        }
        serde_json::json!({
            "botName": f.bot_name,
            "aliases": aliases,
            "triggerMode": f.trigger_mode,
            "cooldownSec": f.cooldown_sec,
            "dailyLimit": f.daily_limit,
            "ai": { "active": f.ai_active, "providers": providers },
            "scam": {
                "enabled": f.scam_enabled,
                "threshold": f.scam_threshold,
                "perMinute": f.scam_per_minute,
                "jev": { "enabled": f.jev_enabled, "model": f.jev_model }
            },
            "kb": { "folder": f.kb_folder },
            "showSources": f.show_sources,
            "creatorReply": f.creator_reply,
            "persona": {
                "birthdate": f.persona_birthdate,
                "gender": f.persona_gender,
                "zodiac": f.persona_zodiac,
                "measurements": f.persona_measurements,
                "interests": f.persona_interests,
                "maritalStatus": f.persona_marital,
                "intro": f.persona_intro
            }
        })
    }

    fn save_settings(&mut self, ctx: &egui::Context) {
        if self.busy.get("save").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("save".into(), true);
        let body = self.collect_settings_body();
        let slot = self.save_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let result = helper_api::put_settings(body);
            *slot.lock().unwrap() = Some(match result {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    fn poll_async_results(&mut self, ctx: &egui::Context) {
        // 設定載入
        if self.form_needs_load {
            let settings = self.snap.lock().unwrap().settings.clone();
            if let Some(v) = settings {
                self.fill_form(&v);
                self.form_needs_load = false;
            }
        }
        // 儲存結果
        if let Some(v) = self.save_slot.lock().unwrap().take() {
            self.busy.insert("save".into(), false);
            let msg = v
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("已儲存")
                .to_string();
            self.form.save_msg = Some(msg);
            // 儲存後重新載入設定 (Key 末4碼等遮罩狀態要刷新); 清掉 poller 快取讓它重抓
            self.snap.lock().unwrap().settings = None;
            self.form_needs_load = true;
            // key_input 清空 (密已進機密庫, 畫面不留明文)
            for p in self.form.providers.values_mut() {
                p.key_input.clear();
            }
            self.form.line_token_input.clear();
        }
        // AI 測試連線 / 模型清單
        let pids: Vec<String> = self.test_slots.keys().cloned().collect();
        for pid in pids {
            if let Some(v) = self.test_slots.get(&pid).and_then(|s| s.lock().unwrap().take()) {
                self.busy.insert(format!("test:{pid}"), false);
                if let Some(p) = self.form.providers.get_mut(&pid) {
                    p.test_msg = Some(
                        v.get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("沒有回應訊息")
                            .to_string(),
                    );
                }
            }
            if let Some(v) = self.model_slots.get(&pid).and_then(|s| s.lock().unwrap().take()) {
                self.busy.insert(format!("models:{pid}"), false);
                if let Some(p) = self.form.providers.get_mut(&pid) {
                    if v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) {
                        p.models = v
                            .get("models")
                            .and_then(|m| m.as_array())
                            .map(|arr| arr.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
                            .unwrap_or_default();
                    }
                    p.models_msg = Some(
                        v.get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("沒有回應訊息")
                            .to_string(),
                    );
                }
            }
        }
        // LINE Token 產生
        if let Some(v) = self.token_slot.lock().unwrap().take() {
            self.busy.insert("token".into(), false);
            let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("完成").to_string();
            self.page_msg.insert("token".into(), msg);
            self.snap.lock().unwrap().settings = None;
            self.form_needs_load = true;
        }
        // 白名單套用
        let applied = self.apply_slot.lock().unwrap().take();
        if let Some(v) = applied {
            self.busy.insert("apply".into(), false);
            let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("完成").to_string();
            self.page_msg.insert("apply".into(), msg);
            refresh_line_cfg_status(self);
            // 套用成功後自動重讀群組清單, 讓「已在白名單」標示立刻更新
            if v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) && self.chats_loaded {
                self.spawn_chats_load(ctx);
            }
            // 加入/移除後白名單管理清單也要同步重讀
            if v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) && self.wl_loaded {
                self.spawn_whitelist_load(ctx);
            }
        }
        // 白名單管理清單讀取
        if let Some(v) = self.wl_slot.lock().unwrap().take() {
            self.busy.insert("wl".into(), false);
            if v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) {
                self.whitelist = v.get("chats").and_then(|c| c.as_array()).cloned().unwrap_or_default();
                self.wl_loaded = true;
            } else if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
                self.page_msg.insert("wl".into(), m.to_string());
            }
        }
        // 群組清單讀取
        if let Some(v) = self.chats_slot.lock().unwrap().take() {
            self.busy.insert("chats".into(), false);
            if v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) {
                self.group_chats = v.get("chats").and_then(|c| c.as_array()).cloned().unwrap_or_default();
                self.chats_loaded = true;
            }
            if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
                self.page_msg.insert("chats".into(), m.to_string());
            }
        }
        // 知識庫重建
        if let Some(v) = self.reindex_slot.lock().unwrap().take() {
            self.busy.insert("reindex".into(), false);
            let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("完成").to_string();
            self.page_msg.insert("reindex".into(), msg);
        }
        // Log
        if let Some(v) = self.logs_slot.lock().unwrap().take() {
            self.busy.insert("logs".into(), false);
            self.logs_text = v.get("tail").and_then(|t| t.as_str()).unwrap_or("").to_string();
            if let Some(dir) = v.get("dir").and_then(|d| d.as_str()) {
                self.page_msg.insert("logdir".into(), dir.to_string());
            }
        }
        // 診斷包匯出結果
        // 一鍵修復結果
        if let Some(lines) = self.repair_slot.lock().unwrap().take() {
            self.busy.insert("repair".into(), false);
            self.repair_lines = lines;
        }
        if let Some(msg) = self.diag_slot.lock().unwrap().take() {
            self.busy.insert("diag".into(), false);
            self.page_msg.insert("diag".into(), msg);
        }
        let _ = ctx;
    }
}

// ---------- 各頁面 ----------

impl App {
    fn engine_unavailable(&self) -> bool {
        !matches!(self.engine_snap.state, EngineState::Running | EngineState::ExternalRunning)
    }

    /// 背景讀取群組清單 (helper /api/line/chats), 結果進 chats_slot 由 poll 收。
    fn spawn_chats_load(&mut self, ctx: &egui::Context) {
        if self.busy.get("chats").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("chats".into(), true);
        // 開始新一次讀取就清掉上一次的訊息: 畫面只留目前狀態, 不疊舊錯誤 (第 5 項)
        self.page_msg.remove("chats");
        let slot = self.chats_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let r = helper_api::line_chats();
            *slot.lock().unwrap() = Some(match r {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    /// 背景把某個聊天室加入白名單 (helper /api/line/config-apply), 結果進 apply_slot 由 poll 收。
    fn start_apply(&mut self, ctx: &egui::Context, chat_id: String) {
        if self.busy.get("apply").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("apply".into(), true);
        let slot = self.apply_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let r = helper_api::line_config_apply(&chat_id);
            *slot.lock().unwrap() = Some(match r {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    /// 背景讀取已儲存白名單清單 (helper /api/line/whitelist), 結果進 wl_slot 由 poll 收。
    fn spawn_whitelist_load(&mut self, ctx: &egui::Context) {
        if self.busy.get("wl").copied().unwrap_or(false) {
            return;
        }
        self.wl_attempted = true;
        self.busy.insert("wl".into(), true);
        self.page_msg.remove("wl");
        let slot = self.wl_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let r = helper_api::line_whitelist();
            *slot.lock().unwrap() = Some(match r {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    /// 背景把某個聊天室移出白名單 (helper /api/line/config-remove), 結果進 apply_slot 由 poll 收
    /// (與加入共用同一條訊息通道與「需完全結束重開才生效」的提示)。
    fn start_remove(&mut self, ctx: &egui::Context, chat_id: String) {
        if self.busy.get("apply").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("apply".into(), true);
        let slot = self.apply_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let r = helper_api::line_config_remove(&chat_id);
            *slot.lock().unwrap() = Some(match r {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    fn page_overview(&mut self, ui: &mut egui::Ui) {
        let ctx = ui.ctx().clone();
        let login = self.login_snapshot();
        let status = self.helper_status();
        ui.heading("總覽");
        ui.add_space(8.0);
        card(ui, self.palette, "服務狀態", |ui| {
            ui.horizontal(|ui| {
                if let Some(tex) = self.display_avatar() {
                    ui.image((tex.id(), egui::vec2(84.0, 84.0)));
                }
                ui.vertical(|ui| {
                    let bot = status.as_ref().and_then(|s| s.get("bot").cloned()).unwrap_or(Value::Null);
                    let bot_name = bot.get("botName").and_then(|v| v.as_str()).unwrap_or("AI寶");
                    // 狀態一致性原則: 引擎不在執行時, 登入/機器人/AI 資訊都只是「上次的舊資料」,
                    // 不得照舊顯示綠燈 (2026-10-20 實機: 引擎異常停止, 總覽卻顯示 LINE 已登入, 畫面全綠實際已死)。
                    let engine_ok = matches!(self.engine_snap.state, EngineState::Running | EngineState::ExternalRunning);
                    let engine_starting = matches!(self.engine_snap.state, EngineState::Starting);
                    ui.label(egui::RichText::new(bot_name).size(22.0).strong().color(self.palette.primary));
                    ui.horizontal(|ui| {
                        ui.label(status_dot(match self.engine_snap.state {
                            EngineState::Running | EngineState::ExternalRunning => self.palette.ok,
                            EngineState::Starting => self.palette.warn,
                            _ => self.palette.bad,
                        }));
                        ui.label(format!("引擎: {}", self.engine_snap.label));
                    });
                    // LINE 登入狀態 (核心 session): 只有引擎真的在跑時, 登入快照才可信
                    ui.horizontal(|ui| {
                        if !engine_ok {
                            ui.label(status_dot(self.palette.idle));
                            ui.label(if engine_starting {
                                "LINE: 引擎啟動中, 登入狀態尚未取得".to_string()
                            } else {
                                "LINE: 未取得 (引擎目前沒有在執行)".to_string()
                            });
                        } else {
                            ui.label(status_dot(match login.auth {
                                AuthState::Ready => self.palette.ok,
                                AuthState::Authenticating | AuthState::Restoring => self.palette.warn,
                                AuthState::Error => self.palette.bad,
                                _ => self.palette.idle,
                            }));
                            ui.label(match login.auth {
                                AuthState::Ready => format!(
                                    "LINE: 已登入{}",
                                    login.profile_name.as_deref().map(|n| format!(" ({n})")).unwrap_or_default()
                                ),
                                AuthState::Authenticating => "LINE: 登入中 (請看 LINE 登入頁)".to_string(),
                                AuthState::Restoring => "LINE: 正在恢復上次登入…".to_string(),
                                AuthState::Error => "LINE: 登入異常, 請到 LINE 登入頁處理".to_string(),
                                _ => "LINE: 尚未登入".to_string(),
                            });
                        }
                    });
                    // 機器人連線狀態 (bot 與核心的 WS): 與「LINE 已登入」分開顯示 —
                    // 登入還在不代表機器人有連上 (換 Token 被踢線時就是登入在、機器人斷), 兩件事要分得出來。
                    ui.horizontal(|ui| {
                        if !engine_ok {
                            ui.label(status_dot(self.palette.idle));
                            ui.label("機器人: 未連線 (引擎未執行)".to_string());
                        } else if bot.is_object() {
                            let bc = bot
                                .get("botConnected")
                                .and_then(|v| v.as_bool())
                                .or_else(|| bot.get("connected").and_then(|v| v.as_bool()))
                                .unwrap_or(false);
                            let line_state = bot.get("lineState").and_then(|v| v.as_str()).unwrap_or("");
                            ui.label(status_dot(if bc { self.palette.ok } else { self.palette.warn }));
                            ui.label(if bc {
                                "機器人: 已連線 (會回應群組訊息)".to_string()
                            } else if line_state == "未設定 Token" {
                                "機器人: 尚未設定 Token, 請到「機器人與觸發」頁完成開通".to_string()
                            } else {
                                "機器人: 未連線, 會自動重試連線; 一直沒連上請重新啟動引擎".to_string()
                            });
                        } else {
                            ui.label(status_dot(self.palette.idle));
                            ui.label("機器人: 狀態尚未取得…".to_string());
                        }
                    });
                    if engine_ok {
                        if let Some(bot) = status.as_ref().and_then(|s| s.get("bot")) {
                        let ai = bot.get("aiActive").and_then(|v| v.as_str()).unwrap_or("-");
                        let model = bot.get("aiModel").and_then(|v| v.as_str()).unwrap_or("-");
                        let answered = bot.get("answeredToday").and_then(|v| v.as_u64()).unwrap_or(0);
                        ui.label(format!("使用中的 AI: {ai} / {model}"));
                        // 核心版本 (第 14 項): 來自核心 hello 影格的實際回報, 未連線時顯示「—」不猜
                        let core_ver = bot.get("coreVersion").and_then(|v| v.as_str()).unwrap_or("");
                        ui.label(if core_ver.is_empty() {
                            "核心 LINE.js: —".to_string()
                        } else {
                            format!("核心 LINE.js: v{core_ver}")
                        });
                        ui.label(format!("今日已回答: {answered} 次"));
                        if let Some(scam) = bot.get("scam") {
                            let checked = scam.get("checkedToday").and_then(|v| v.as_u64()).unwrap_or(0);
                            let warned = scam.get("warnedToday").and_then(|v| v.as_u64()).unwrap_or(0);
                            ui.label(format!("防詐騙: 今日檢查 {checked} 則、警告 {warned} 則"));
                        }
                        } else {
                            ui.label(egui::RichText::new("設定服務尚未就緒, 請稍候…").weak());
                        }
                    }
                });
            });
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                if ui.button("重新啟動引擎").clicked() {
                    self.restart_engine();
                }
                let repairing = self.busy.get("repair").copied().unwrap_or(false);
                if primary_btn(ui, self.palette, if repairing { "修復中…" } else { "一鍵修復" }).clicked() && !repairing {
                    self.start_repair(&ctx);
                }
                if ui.button("開啟 LINE 登入頁").clicked() {
                    self.page = Page::LineLogin;
                }
            });
            if !self.repair_lines.is_empty() {
                ui.add_space(4.0);
                ui.label(egui::RichText::new("一鍵修復結果:").strong());
                for line in self.repair_lines.clone() {
                    ui.label(format!("・{line}"));
                }
            }
            if let EngineState::Failed(msg) = &self.engine_snap.state {
                ui.label(egui::RichText::new(format!("引擎異常: {msg}")).color(self.palette.bad));
            }
        });
        ui.add_space(10.0);
        card(ui, self.palette, "使用方式", |ui| {
            ui.label("1. 在「LINE 登入」頁用次要帳號掃描 QR 碼登入 (只需要做一次)。");
            ui.label("2. 在「AI 設定」頁貼上 API Key、選好模型, 按儲存。");
            ui.label("3. 在「機器人與觸發」頁完成 LINE 開通 (白名單 + Token)。");
            ui.label("4. 之後把視窗縮小即可: AI寶 會躲在右下角系統匣繼續在群組服務。");
        });
    }

    fn page_login(&mut self, ui: &mut egui::Ui) {
        ui.heading("LINE 登入");
        ui.add_space(8.0);
        let login = self.login_snapshot();
        if self.engine_unavailable() {
            card(ui, self.palette, "引擎尚未就緒", |ui| {
                ui.label(format!("目前引擎狀態: {}", self.engine_snap.label));
                ui.label("引擎還沒啟動完成, 登入功能要等引擎就緒才能使用。");
                if ui.button("重新啟動引擎").clicked() {
                    self.restart_engine();
                }
            });
            return;
        }
        match login.auth {
            AuthState::Ready => {
                card(ui, self.palette, "已登入", |ui| {
                    ui.horizontal(|ui| {
                        ui.label(status_dot(self.palette.ok));
                        ui.label(
                            egui::RichText::new(format!(
                                "已登入: {}",
                                login.profile_name.as_deref().unwrap_or("(名稱讀取中)")
                            ))
                            .size(18.0),
                        );
                    });
                    ui.label("這個帳號就是 AI寶 在 LINE 群組裡的身分。登入狀態已加密保存, 下次開機自啟動會自動登入。");
                    ui.add_space(6.0);
                    if ui.button("登出").clicked() {
                        self.confirm_logout = true;
                    }
                });
            }
            AuthState::Authenticating => {
                card(ui, self.palette, "登入中", |ui| {
                    ui.label("請用次要帳號的 LINE, 依下面步驟完成登入:");
                    ui.label("第 1 步: 用手機 LINE 掃描這張 QR 碼 (LINE App 的「加入好友 → 行動條碼」)。");
                    if let Some(url) = &login.qr_url {
                        draw_qr(ui, self.palette, url, 240.0);
                    } else {
                        ui.horizontal(|ui| {
                            ui.spinner();
                            ui.label("正在向 LINE 取得 QR 碼…");
                        });
                    }
                    ui.add_space(6.0);
                    ui.label("第 2 步: 掃描後, 手機會要你輸入一組 PIN 碼, 就是這一組:");
                    if let Some(pin) = &login.pin {
                        ui.label(egui::RichText::new(pin.clone()).size(44.0).strong().color(self.palette.primary));
                    } else {
                        ui.label(egui::RichText::new("等待產生…").size(24.0).weak());
                    }
                    if let Some(err) = &login.last_error {
                        ui.label(egui::RichText::new(err.clone()).color(self.palette.bad));
                        if ui.button("重新產生").clicked() {
                            let _ = self.login_tx.send(WsCommand::StartLogin);
                        }
                    }
                    ui.label(egui::RichText::new("QR 碼 3 分鐘內有效; 過期請按重新產生。").weak());
                });
            }
            AuthState::Restoring => {
                card(ui, self.palette, "恢復登入中", |ui| {
                    ui.horizontal(|ui| {
                        ui.spinner();
                        ui.label("正在用上次保存的登入狀態自動登入, 請稍候…");
                    });
                });
            }
            _ => {
                card(ui, self.palette, "尚未登入", |ui| {
                    if !login.connected {
                        ui.horizontal(|ui| {
                            ui.spinner();
                            ui.label("正在連接核心服務…");
                        });
                    }
                    ui.label("按下開始登入後, 這裡會出現 QR 碼, 用次要帳號的手機 LINE 掃描即可。");
                    ui.label(egui::RichText::new("重要: 請用次要帳號, 不要用主帳號登入。").color(self.palette.warn_text).strong());
                    if let Some(err) = &login.last_error {
                        ui.label(egui::RichText::new(err.clone()).color(self.palette.bad));
                    }
                    ui.add_space(6.0);
                    if ui.add(egui::Button::new(egui::RichText::new("開始登入").size(18.0).color(egui::Color32::WHITE)).fill(self.palette.primary)).clicked() {
                        let _ = self.login_tx.send(WsCommand::StartLogin);
                    }
                });
            }
        }
        ui.add_space(10.0);
        self.activity_panel(ui, matches!(login.auth, AuthState::Ready));
    }

    // 機器人聊天情況面板 (第 12 項): 登入卡片下方顯示機器人在群組的服務實況。
    // 資料來自 helper 的 GET /api/bot/activity (唯讀; 問題只留前 30 字且只在 helper 記憶體)。
    // 開頁立即抓、之後每約 4 秒自動刷新; 失敗顯示白話訊息, 不跳原始錯誤。
    fn activity_panel(&mut self, ui: &mut egui::Ui, logged_in: bool) {
        let ctx = ui.ctx().clone();
        card(ui, self.palette, "機器人聊天情況", |ui| {
            if !logged_in {
                ui.label("登入後這裡會顯示機器人的聊天情況");
                return;
            }
            // 收取背景抓取結果
            if let Some(v) = self.activity_slot.lock().unwrap().take() {
                self.busy.insert("activity".into(), false);
                if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
                    self.activity = Some(v);
                    self.activity_msg = None;
                } else {
                    let m = v.get("message").and_then(|x| x.as_str()).unwrap_or("讀取聊天情況失敗, 請稍後再試。").to_string();
                    self.activity_msg = Some(m);
                }
            }
            let busy_act = self.busy.get("activity").copied().unwrap_or(false);
            let due = self.activity_fetched_at.map(|t| t.elapsed() > std::time::Duration::from_secs(4)).unwrap_or(true);
            if due && !busy_act {
                self.busy.insert("activity".into(), true);
                self.activity_fetched_at = Some(std::time::Instant::now());
                let slot = self.activity_slot.clone();
                let ctx2 = ctx.clone();
                std::thread::spawn(move || {
                    let r = helper_api::bot_activity();
                    *slot.lock().unwrap() = Some(match r {
                        Ok(v) => v,
                        Err(e) => serde_json::json!({ "ok": false, "message": e }),
                    });
                    ctx2.request_repaint();
                });
            }
            ctx.request_repaint_after(std::time::Duration::from_secs(1));
            let act = self.activity.clone();
            let status = act.as_ref().and_then(|a| a.get("status").cloned()).unwrap_or(Value::Null);
            if status.is_object() {
                let bc = status.get("botConnected").and_then(|v| v.as_bool()).unwrap_or(false);
                let ai = status.get("aiActive").and_then(|v| v.as_str()).unwrap_or("-");
                let model = status.get("aiModel").and_then(|v| v.as_str()).unwrap_or("-");
                let answered = status.get("answeredToday").and_then(|v| v.as_u64()).unwrap_or(0);
                let limit = status.get("dailyLimit").and_then(|v| v.as_u64()).unwrap_or(0);
                let scam = status.get("scam").cloned().unwrap_or(Value::Null);
                let checked = scam.get("checkedToday").and_then(|v| v.as_u64()).unwrap_or(0);
                let warned = scam.get("warnedToday").and_then(|v| v.as_u64()).unwrap_or(0);
                ui.horizontal(|ui| {
                    ui.label(status_dot(if bc { self.palette.ok } else { self.palette.warn }));
                    ui.label(if bc { "機器人已連線" } else { "機器人未連線" });
                    ui.separator();
                    ui.label(format!("AI: {ai} / {model}"));
                    ui.separator();
                    ui.label(format!("今日已回答 {answered} / 上限 {limit}"));
                    ui.separator();
                    ui.label(format!("防詐騙: 檢查 {checked}、警告 {warned}"));
                });
            } else if self.activity_msg.is_none() {
                ui.label("正在讀取聊天情況…");
            }
            if let Some(m) = &self.activity_msg {
                ui.label(egui::RichText::new(m.clone()).color(self.palette.warn_text));
            }
            ui.add_space(4.0);
            let events = act.as_ref().and_then(|a| a.get("events")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if events.is_empty() {
                ui.label(egui::RichText::new("目前還沒有紀錄: 有人在群組跟機器人說話後, 這裡會逐筆出現。").weak());
            } else {
                let max_h = ui.available_height().max(80.0);
                egui::ScrollArea::vertical().id_salt("activity-scroll").max_height(max_h).show(ui, |ui| {
                    for ev in &events {
                        let time = ev.get("time").and_then(|v| v.as_str()).unwrap_or("");
                        let kind = ev.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                        let (label, color) = match kind {
                            "answered" => ("已回答", self.palette.ok),
                            "name_only" => ("引導說明", self.palette.idle),
                            "cooldown" => ("冷卻略過", self.palette.warn),
                            "daily_limit" => ("每日上限擋下", self.palette.warn),
                            "scam_warned" => ("防詐騙警告", self.palette.bad),
                            "ai_busy" => ("AI 忙線", self.palette.warn),
                            "ai_failed" => ("AI 連不上", self.palette.bad),
                            _ => ("紀錄", self.palette.idle),
                        };
                        let chat = ev.get("chatName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("(群組)");
                        let sender = ev.get("senderName").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or("(同事)");
                        let q = ev.get("question").and_then(|v| v.as_str()).unwrap_or("");
                        let chars = ev.get("answerChars").and_then(|v| v.as_u64());
                        let ms = ev.get("ms").and_then(|v| v.as_u64());
                        ui.horizontal_wrapped(|ui| {
                            ui.label(egui::RichText::new(time).weak());
                            ui.label(egui::RichText::new(label).color(color).strong());
                            ui.label(format!("{chat}・{sender}: {q}"));
                            if let Some(c) = chars {
                                ui.label(egui::RichText::new(format!("(回答 {c} 字{})", ms.map(|m| format!("・{} 毫秒", m)).unwrap_or_default())).weak());
                            }
                        });
                    }
                });
            }
        });
    }

    fn page_ai(&mut self, ui: &mut egui::Ui) {
        ui.heading("AI 設定");
        ui.add_space(4.0);
        ui.label("選一家 AI 服務、貼上 API Key、抓模型清單選一個, 測試成功後按「儲存全部設定」。");
        ui.add_space(8.0);
        let ctx = ui.ctx().clone();
        let pids: Vec<String> = ["openai", "groq", "minimax"].iter().map(|s| s.to_string()).collect();
        for pid in pids {
            let is_active = self.form.ai_active == pid;
            let label = self.form.providers.get(&pid).map(|p| p.label.clone()).unwrap_or_else(|| pid.clone());
            card(ui, self.palette, &format!("{label}{}", if is_active { " (使用中)" } else { "" }), |ui| {
                let p = match self.form.providers.get_mut(&pid) {
                    Some(p) => p,
                    None => return,
                };
                ui.horizontal(|ui| {
                    ui.label("API Key:");
                    ui.add(egui::TextEdit::singleline(&mut p.key_input).password(true).desired_width(320.0).hint_text("貼上這家的 API Key"));
                });
                ui.label(if p.configured {
                    format!("已儲存的 Key: 末 4 碼 {}", p.last4)
                } else {
                    "尚未設定 Key".to_string()
                });
                ui.horizontal(|ui| {
                    ui.label("連線位置 (Base URL):");
                    ui.add(egui::TextEdit::singleline(&mut p.base_url).desired_width(320.0));
                });
                // 模型: 先保底目前值, 抓到清單後用下拉選
                ui.horizontal(|ui| {
                    ui.label("模型:");
                    let mut options: Vec<String> = Vec::new();
                    if !p.models.is_empty() {
                        options = p.models.clone();
                    }
                    if !options.contains(&p.model) {
                        options.insert(0, p.model.clone());
                    }
                    egui::ComboBox::from_id_salt(format!("model-{pid}"))
                        .selected_text(p.model.clone())
                        .width(320.0)
                        .show_ui(ui, |ui| {
                            for m in &options {
                                ui.selectable_value(&mut p.model, m.clone(), m.clone());
                            }
                        });
                });
                let busy_models = self.busy.get(&format!("models:{pid}")).copied().unwrap_or(false);
                let busy_test = self.busy.get(&format!("test:{pid}")).copied().unwrap_or(false);
                ui.horizontal(|ui| {
                    if ui.button(if busy_models { "抓取中…" } else { "取得可用模型" }).clicked() && !busy_models {
                        self.busy.insert(format!("models:{pid}"), true);
                        let slot: Slot<Value> = Arc::new(Mutex::new(None));
                        self.model_slots.insert(pid.clone(), slot.clone());
                        let (provider, key, base) = (pid.clone(), p.key_input.clone(), p.base_url.clone());
                        let ctx2 = ctx.clone();
                        std::thread::spawn(move || {
                            let r = helper_api::list_models(&provider, if key.is_empty() { None } else { Some(&key) }, &base);
                            *slot.lock().unwrap() = Some(match r {
                                Ok(v) => v,
                                Err(e) => serde_json::json!({ "ok": false, "message": e }),
                            });
                            ctx2.request_repaint();
                        });
                    }
                    if ui.button(if busy_test { "測試中…" } else { "測試連線" }).clicked() && !busy_test {
                        self.busy.insert(format!("test:{pid}"), true);
                        let slot: Slot<Value> = Arc::new(Mutex::new(None));
                        self.test_slots.insert(pid.clone(), slot.clone());
                        let (provider, key, base, model) = (pid.clone(), p.key_input.clone(), p.base_url.clone(), p.model.clone());
                        let ctx2 = ctx.clone();
                        std::thread::spawn(move || {
                            let r = helper_api::test_ai(&provider, if key.is_empty() { None } else { Some(&key) }, &base, &model);
                            *slot.lock().unwrap() = Some(match r {
                                Ok(v) => v,
                                Err(e) => serde_json::json!({ "ok": false, "message": e }),
                            });
                            ctx2.request_repaint();
                        });
                    }
                });
                if let Some(m) = &p.models_msg {
                    ui.label(m.clone());
                }
                if let Some(m) = &p.test_msg {
                    ui.label(m.clone());
                }
                if !is_active && ui.button(format!("改用 {label} 這家")).clicked() {
                    self.form.ai_active = pid.clone();
                }
            });
            ui.add_space(8.0);
        }
        ui.horizontal(|ui| {
            let saving = self.busy.get("save").copied().unwrap_or(false);
            if ui.add(egui::Button::new(egui::RichText::new(if saving { "儲存中…" } else { "儲存全部設定" }).size(17.0).strong().color(egui::Color32::WHITE)).fill(self.palette.primary)).clicked() {
                self.save_settings(&ctx);
            }
            if let Some(m) = &self.form.save_msg {
                ui.label(m.clone());
            }
        });
    }
}

/// 把 QR URL 字串在本機畫成 QR 圖 (內容不上傳任何服務, 比照上游 CLI 以 qrcode 套件本機產生)。
/// QR 本體固定黑/白 (掃描對比是功能必需, 不隨主題變); 只有失敗提示文字吃主題色。
fn draw_qr(ui: &mut egui::Ui, pal: theme::Palette, content: &str, size: f32) {
    let code = match qrcode::QrCode::new(content.as_bytes()) {
        Ok(c) => c,
        Err(_) => {
            ui.label(egui::RichText::new("QR 碼產生失敗, 請按重新產生").color(pal.bad));
            return;
        }
    };
    let width = code.width();
    let colors = code.to_colors();
    let (rect, _resp) = ui.allocate_exact_size(egui::vec2(size, size), egui::Sense::hover());
    let painter = ui.painter_at(rect);
    painter.rect_filled(rect, 0.0, egui::Color32::WHITE);
    let cell = size / width as f32;
    for y in 0..width {
        for x in 0..width {
            if colors[y * width + x] == qrcode::types::Color::Dark {
                let min = egui::pos2(rect.min.x + x as f32 * cell, rect.min.y + y as f32 * cell);
                painter.rect_filled(
                    egui::Rect::from_min_size(min, egui::vec2(cell + 0.5, cell + 0.5)),
                    0.0,
                    egui::Color32::BLACK,
                );
            }
        }
    }
}

impl App {
    fn page_bot(&mut self, ui: &mut egui::Ui) {
        ui.heading("機器人與觸發");
        ui.add_space(8.0);
        let ctx = ui.ctx().clone();
        card(ui, self.palette, "機器人名字與觸發規則", |ui| {
            ui.horizontal(|ui| {
                ui.label("機器人主名 (在群組裡叫這個名字, 我就會回應):");
                ui.add(egui::TextEdit::singleline(&mut self.form.bot_name).desired_width(200.0));
            });
            ui.horizontal(|ui| {
                ui.label("別名 (可多個, 用逗號分開):");
                ui.add(
                    egui::TextEdit::singleline(&mut self.form.aliases_text)
                        .desired_width(280.0)
                        .hint_text("例: 小寶, 阿寶"),
                );
            });
            ui.label(egui::RichText::new("別名是我的小名: 別人用別名叫我, 我也會回應。主名和別名都算數。").weak());
            ui.label("群組裡有人在訊息中提到這個名字 (含問句或請求), 或引用機器人自己的回答再追問, 機器人就會回應。");
            ui.horizontal(|ui| {
                ui.label("觸發寬嚴:");
                for (val, label) in [("relaxed", "寬鬆"), ("standard", "標準"), ("strict", "嚴格")] {
                    ui.selectable_value(&mut self.form.trigger_mode, val.to_string(), label);
                }
            });
            ui.horizontal(|ui| {
                ui.label("同一人冷卻秒數:");
                ui.add(egui::DragValue::new(&mut self.form.cooldown_sec).range(0..=600));
                ui.label("每日回答上限:");
                ui.add(egui::DragValue::new(&mut self.form.daily_limit).range(0..=10000));
            });
            ui.horizontal(|ui| {
                let saving = self.busy.get("save").copied().unwrap_or(false);
                if primary_btn(ui, self.palette, if saving { "儲存中…" } else { "儲存設定" }).clicked() {
                    self.save_settings(&ctx);
                }
                if let Some(m) = &self.form.save_msg {
                    ui.label(m.clone());
                }
            });
        });
        ui.add_space(10.0);
        card(ui, self.palette, "機器人身分 (別人問我的身世時, 我照這裡回答)", |ui| {
            ui.label(egui::RichText::new("這些是機器人的個人資料: 群組裡有人問我的年紀、生日、星座、興趣等等, 我會照這裡填的回答; 沒填的我會老實說還沒設定, 不會亂編。年紀不用填, 我會自己用出生日算。").weak());
            let mut row = |ui: &mut egui::Ui, label: &str, field: &mut String, hint: &str, width: f32| {
                ui.horizontal(|ui| {
                    ui.label(label);
                    ui.add(egui::TextEdit::singleline(field).desired_width(width).hint_text(hint));
                });
            };
            row(ui, "出生日:", &mut self.form.persona_birthdate, "例: 2020-05-01", 200.0);
            row(ui, "性別:", &mut self.form.persona_gender, "例: 女", 200.0);
            row(ui, "星座:", &mut self.form.persona_zodiac, "例: 金牛座", 200.0);
            row(ui, "三圍:", &mut self.form.persona_measurements, "可留空", 200.0);
            row(ui, "興趣:", &mut self.form.persona_interests, "例: 學習新知識、幫忙查資料", 320.0);
            row(ui, "婚姻狀態:", &mut self.form.persona_marital, "例: 未婚", 200.0);
            row(ui, "自我介紹:", &mut self.form.persona_intro, "一句話介紹自己", 420.0);
            ui.add_space(4.0);
            ui.label(egui::RichText::new("有人問「是誰創造你的 / 作者是誰 / 版權是誰的」這類問題時, 我會固定回下面這句 (不讓 AI 自由發揮)。這句是固定答覆, 只供檢視, 不能修改:").weak());
            ui.horizontal(|ui| {
                ui.label("創造者問答 (唯讀):");
                // 唯讀 (第 4' 項): 以 add_enabled(false) 停用編輯, 值仍隨表單載入/儲存原樣往返
                ui.add_enabled(false, egui::TextEdit::singleline(&mut self.form.creator_reply).desired_width(460.0));
            });
            ui.horizontal(|ui| {
                let saving = self.busy.get("save").copied().unwrap_or(false);
                if primary_btn(ui, self.palette, if saving { "儲存中…" } else { "儲存身分設定" }).clicked() {
                    self.save_settings(&ctx);
                }
                if let Some(m) = &self.form.save_msg {
                    ui.label(m.clone());
                }
            });
        });
        ui.add_space(10.0);
        card(ui, self.palette, "LINE 開通 (讓機器人能在群組說話)", |ui| {
            // 步驟一: 白名單 (用選的: 先讀群組清單, 再點選加入; 貼 ID 降為進階)
            let cfg = self.line_cfg_status.lock().unwrap().clone();
            ui.label(egui::RichText::new("步驟一: 把目標群組加入白名單").strong());
            if let Some(c) = &cfg {
                let enabled = c.get("apiEnabled").and_then(|v| v.as_bool()).unwrap_or(false);
                let chats = c.get("chats").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
                ui.label(format!(
                    "機器人 API: {}; 已加入白名單的群組: {} 個",
                    if enabled { "已啟用" } else { "尚未啟用" },
                    chats
                ));
            } else {
                ui.label("正在讀取核心設定狀態…");
            }
            ui.label(egui::RichText::new("不用自己找代號: 先在手機 LINE 把這個次要帳號邀請進要用的群組, 回來按「讀取我的群組清單」, 群組會列出來, 用點的加入白名單。").weak());
            let busy_chats = self.busy.get("chats").copied().unwrap_or(false);
            if ui.button(if busy_chats { "讀取中…" } else { "讀取我的群組清單" }).clicked() && !busy_chats {
                self.spawn_chats_load(&ctx);
            }
            if let Some(m) = self.page_msg.get("chats") {
                ui.label(m.clone());
            }
            if self.chats_loaded {
                let chats = self.group_chats.clone();
                let busy_apply_now = self.busy.get("apply").copied().unwrap_or(false);
                for c in &chats {
                    let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("(未命名)").to_string();
                    let kind = c.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                    let kind_label = match kind { "group" => "群組", "room" => "聊天室", "square" => "社群", _ => kind };
                    let members = c.get("memberCount").and_then(|v| v.as_i64());
                    let whitelisted = c.get("whitelisted").and_then(|v| v.as_bool()).unwrap_or(false);
                    let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    ui.horizontal(|ui| {
                        let mut text = format!("{name} ({kind_label}");
                        if let Some(n) = members {
                            text += &format!("・{n} 人");
                        }
                        text += ")";
                        ui.label(text);
                        if whitelisted {
                            ui.label(egui::RichText::new("已在白名單").color(self.palette.ok_text));
                        } else if ui.add_enabled(!busy_apply_now, egui::Button::new("加入白名單")).clicked() {
                            self.start_apply(&ctx, id.clone());
                        }
                    });
                }
            }
            ui.collapsing("進階: 手動貼上群組 ID (清單讀不到時才需要)", |ui| {
                ui.horizontal(|ui| {
                    ui.label("群組 ID:");
                    let mut chat_id = self.page_msg.get("chatid").cloned().unwrap_or_default();
                    if ui.add(egui::TextEdit::singleline(&mut chat_id).desired_width(320.0).hint_text("c 開頭共 33 碼")).changed() {
                        self.page_msg.insert("chatid".into(), chat_id);
                    }
                });
                ui.label(egui::RichText::new("備用方法: 在核心網頁 (http://127.0.0.1:3789) 點進群組聊天室, 用右鍵「複製聊天室 ID」取得 ID, 再貼到上面欄位。").weak());
                let busy_apply = self.busy.get("apply").copied().unwrap_or(false);
                if ui.button(if busy_apply { "處理中…" } else { "加入白名單" }).clicked() && !busy_apply {
                    let chat_id = self.page_msg.get("chatid").cloned().unwrap_or_default();
                    if chat_id.trim().is_empty() {
                        self.page_msg.insert("apply".into(), "請先貼上群組 ID 再按加入白名單".to_string());
                    } else {
                        self.start_apply(&ctx, chat_id);
                    }
                }
            });
            if let Some(m) = self.page_msg.get("apply") {
                ui.label(m.clone());
            }
            ui.add_space(8.0);
            // 目前白名單 (修復項 8): 已儲存的 chats 逐筆列出與移除, 不能只給計數;
            // 名稱由 helper 對照核心快照解析, 核心讀不到時顯示 ID 並註明待讀取, 清單本身照樣列。
            ui.label(egui::RichText::new("目前白名單 (已儲存的群組)").strong());
            if !self.wl_loaded && !self.wl_attempted && !self.busy.get("wl").copied().unwrap_or(false) {
                self.spawn_whitelist_load(&ctx);
            }
            let busy_wl = self.busy.get("wl").copied().unwrap_or(false);
            if ui.button(if busy_wl { "讀取中…" } else { "重新讀取白名單" }).clicked() && !busy_wl {
                self.spawn_whitelist_load(&ctx);
            }
            if let Some(m) = self.page_msg.get("wl") {
                ui.label(m.clone());
            }
            if self.wl_loaded {
                if self.whitelist.is_empty() {
                    ui.label("白名單目前是空的: 還沒有任何群組被加入, 機器人不會在任何群組回應。");
                }
                let wl = self.whitelist.clone();
                let busy_apply_now = self.busy.get("apply").copied().unwrap_or(false);
                for c in &wl {
                    let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let resolved = c.get("nameResolved").and_then(|v| v.as_bool()).unwrap_or(false);
                    let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    ui.horizontal(|ui| {
                        if resolved && !name.is_empty() {
                            ui.label(name.clone());
                            ui.label(egui::RichText::new(format!("({id})")).weak().small());
                        } else {
                            ui.label(id.clone());
                            ui.label(egui::RichText::new("(名稱待讀取: 核心清單讀不到時先顯示代號)").weak());
                        }
                        if ui.add_enabled(!busy_apply_now, egui::Button::new("移除")).clicked() {
                            self.start_remove(&ctx, id.clone());
                        }
                    });
                }
                ui.label(egui::RichText::new("移除後要把 AI寶 完全關閉再重新開啟才會生效 (與加入相同)。").weak());
            }
            ui.add_space(8.0);
            // 步驟二: Token
            ui.label(egui::RichText::new("步驟二: 產生機器人 Token").strong());
            ui.label(if self.form.line_token_configured {
                format!("目前 Token: 已設定 (末 4 碼 {})", self.form.line_token_last4)
            } else {
                "目前 Token: 尚未設定".to_string()
            });
            let busy_token = self.busy.get("token").copied().unwrap_or(false);
            if primary_btn(ui, self.palette, if busy_token { "產生中…" } else { "自動產生 Token 並儲存" }).clicked() && !busy_token {
                self.busy.insert("token".into(), true);
                let slot = self.token_slot.clone();
                let ctx2 = ctx.clone();
                std::thread::spawn(move || {
                    let r = helper_api::line_generate_token();
                    *slot.lock().unwrap() = Some(match r {
                        Ok(v) => v,
                        Err(e) => serde_json::json!({ "ok": false, "message": e }),
                    });
                    ctx2.request_repaint();
                });
            }
            if let Some(m) = self.page_msg.get("token") {
                ui.label(m.clone());
            }
            ui.label(egui::RichText::new("注意: 白名單生效需要把 AI寶 完全結束再重新開啟一次 (用系統匣的「結束服務並關閉程式」)。").weak());
        });
    }

    fn page_kb(&mut self, ui: &mut egui::Ui) {
        ui.heading("知識庫");
        ui.add_space(8.0);
        let ctx = ui.ctx().clone();
        card(ui, self.palette, "知識庫資料夾", |ui| {
            ui.label("指定一個資料夾, AI寶 會讀取裡面的 .txt / .md / .csv 回答公司問題。資料夾內容請先自行脫敏。");
            ui.horizontal(|ui| {
                ui.checkbox(&mut self.form.show_sources, "回答時附上參考來源");
                ui.label(egui::RichText::new("(打開才會在回答後面附上參考的檔案名稱; 關閉就不顯示)").weak());
            });
            ui.horizontal(|ui| {
                ui.add(egui::TextEdit::singleline(&mut self.form.kb_folder).desired_width(420.0).hint_text("例如 D:\\公司文件\\知識庫"));
                if ui.button("選擇資料夾…").clicked() {
                    if let Some(path) = rfd::FileDialog::new().pick_folder() {
                        self.form.kb_folder = path.to_string_lossy().to_string();
                    }
                }
            });
            let status = self.helper_status();
            if let Some(kb) = status.as_ref().and_then(|s| s.get("bot")).and_then(|b| b.get("kb")) {
                if !kb.is_null() {
                    let files = kb.get("files").and_then(|v| v.as_u64()).unwrap_or(0);
                    let chunks = kb.get("chunks").and_then(|v| v.as_u64()).unwrap_or(0);
                    let ready = kb.get("ready").and_then(|v| v.as_bool()).unwrap_or(false);
                    ui.label(format!("索引狀態: {}; 檔案 {} 個、片段 {} 段", if ready { "已就緒" } else { "尚無可用檔案" }, files, chunks));
                    if kb.get("scanning").and_then(|v| v.as_bool()).unwrap_or(false) {
                        ui.label("索引正在背景整理中… (不影響其他功能, 整理好後這裡的數字會自動更新)");
                    }
                    // 檔案異常多只提醒不阻擋: 通常是誤把整個文件庫根目錄設進來 (實機曾掃到 7 千多個檔、卡 2 分鐘)
                    if kb.get("largeFolder").and_then(|v| v.as_bool()).unwrap_or(false) || files > 2000 {
                        ui.label(
                            egui::RichText::new(format!(
                                "提醒: 這個資料夾有 {files} 個文件檔案, 數量很多, 每次掃描都會花比較久。建議另外建一個只放要給 AI 參考文件的專用資料夾, 會快很多。"
                            ))
                            .color(self.palette.warn_text),
                        );
                    }
                }
            }
            ui.horizontal(|ui| {
                let saving = self.busy.get("save").copied().unwrap_or(false);
                if primary_btn(ui, self.palette, "儲存知識庫設定").clicked() && !saving {
                    self.save_settings(&ctx);
                }
                let busy = self.busy.get("reindex").copied().unwrap_or(false);
                if ui.button(if busy { "整理中…" } else { "重新建立索引" }).clicked() && !busy {
                    self.busy.insert("reindex".into(), true);
                    let slot = self.reindex_slot.clone();
                    let ctx2 = ctx.clone();
                    std::thread::spawn(move || {
                        let r = helper_api::kb_reindex();
                        *slot.lock().unwrap() = Some(match r {
                            Ok(v) => v,
                            Err(e) => serde_json::json!({ "ok": false, "message": e }),
                        });
                        ctx2.request_repaint();
                    });
                }
                if let Some(m) = self.page_msg.get("reindex") {
                    ui.label(m.clone());
                }
            });
        });
    }

    fn page_scam(&mut self, ui: &mut egui::Ui) {
        ui.heading("防詐騙");
        ui.add_space(8.0);
        let ctx = ui.ctx().clone();
        card(ui, self.palette, "詐騙訊息判讀", |ui| {
            ui.checkbox(&mut self.form.scam_enabled, "啟用防詐騙判讀");
            ui.horizontal(|ui| {
                ui.label("判讀門檻 (0~1, 越高越嚴格):");
                ui.add(egui::DragValue::new(&mut self.form.scam_threshold).range(0.0..=1.0).speed(0.05));
            });
            ui.horizontal(|ui| {
                ui.label("每分鐘最多判讀則數:");
                ui.add(egui::DragValue::new(&mut self.form.scam_per_minute).range(1..=60));
            });
            ui.label("運作方式: 本機規則先預篩, 可疑訊息再送 AI 判讀; 超過門檻會在群組回覆警告。");
            ui.add_space(6.0);
            ui.checkbox(&mut self.form.jev_enabled, "啟用 TypeSafe Jev 判讀 (進階, 需要另外的 Jev 設定; 預設停用)");
            ui.horizontal(|ui| {
                ui.label("Jev 模型:");
                ui.add(egui::TextEdit::singleline(&mut self.form.jev_model).desired_width(200.0));
            });
            ui.horizontal(|ui| {
                let saving = self.busy.get("save").copied().unwrap_or(false);
                if primary_btn(ui, self.palette, if saving { "儲存中…" } else { "儲存設定" }).clicked() {
                    self.save_settings(&ctx);
                }
                if let Some(m) = &self.form.save_msg {
                    ui.label(m.clone());
                }
            });
        });
    }

    fn page_logs(&mut self, ui: &mut egui::Ui) {
        ui.heading("紀錄");
        ui.add_space(8.0);
        let ctx = ui.ctx().clone();
        card(ui, self.palette, "今日紀錄", |ui| {
            ui.horizontal(|ui| {
                let busy = self.busy.get("logs").copied().unwrap_or(false);
                if ui.button(if busy { "讀取中…" } else { "重新讀取" }).clicked() && !busy {
                    self.busy.insert("logs".into(), true);
                    let slot = self.logs_slot.clone();
                    let ctx2 = ctx.clone();
                    std::thread::spawn(move || {
                        let mut merged = serde_json::json!({});
                        if let Ok(v) = helper_api::get_logs() {
                            merged = v;
                        }
                        if let Ok(d) = helper_api::get_log_dir() {
                            if let Some(dir) = d.get("dir").cloned() {
                                merged["dir"] = dir;
                            }
                        }
                        *slot.lock().unwrap() = Some(merged);
                        ctx2.request_repaint();
                    });
                }
                if ui.button("開啟紀錄資料夾").clicked() {
                    let dir = shell::logs_dir();
                    open_folder(&dir);
                }
                if ui.button("開啟資料目錄").clicked() {
                    open_folder(&shell::data_dir());
                }
                // 一鍵匯出診斷包: 近 14 天紀錄 + 殼 log + 版本/狀態資訊打包成 zip (機密已遮罩)
                let busy_diag = self.busy.get("diag").copied().unwrap_or(false);
                if ui.button(if busy_diag { "匯出中…" } else { "匯出診斷包" }).clicked() && !busy_diag {
                    let default_name = format!("aibao-diagnostic-{}.zip", shell::iso_now().chars().take(10).collect::<String>());
                    if let Some(path) = rfd::FileDialog::new().set_file_name(&default_name).save_file() {
                        self.busy.insert("diag".into(), true);
                        let slot = self.diag_slot.clone();
                        let ctx2 = ctx.clone();
                        std::thread::spawn(move || {
                            let msg = match shell::export_diagnostic(&path) {
                                Ok(m) => m,
                                Err(e) => {
                                    shell::log_line(&format!("診斷包匯出失敗: {e}"));
                                    "匯出失敗: 檔案寫不進去, 請換一個位置再試一次".to_string()
                                }
                            };
                            *slot.lock().unwrap() = Some(msg);
                            ctx2.request_repaint();
                        });
                    }
                }
            });
            if let Some(m) = self.page_msg.get("diag") {
                ui.label(m.clone());
            }
            if let Some(dir) = self.page_msg.get("logdir") {
                ui.label(format!("紀錄資料夾: {dir}"));
            }
            ui.label(egui::RichText::new("紀錄不會包含 API Key、Token 或訊息全文 (機密會被遮罩)。出問題時按「匯出診斷包」把檔案給維護人員看即可。").weak());
            ui.add_space(6.0);
            egui::ScrollArea::vertical().max_height(420.0).show(ui, |ui| {
                // 可選取複製: 用可選字 Label (舊作法是不可選的唯讀文字框, 使用者反應沒辦法複製 — 2026-10-20 實機)
                ui.add(
                    egui::Label::new(egui::RichText::new(self.logs_text.clone()).monospace())
                        .selectable(true),
                );
            });
        });
    }

    fn page_app_settings(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.heading("程式設定");
        ui.add_space(8.0);
        card(ui, self.palette, "啟動行為", |ui| {
            // 自啟動開關: 以登錄實際值為準 (Windows); 非 Windows 停用
            #[cfg(windows)]
            {
                let current = platform::autostart_get();
                let mut enabled = current.is_some();
                let before = enabled;
                ui.checkbox(&mut enabled, "隨 Windows 啟動並自動登入");
                if enabled != before {
                    if enabled {
                        if let Ok(exe) = std::env::current_exe() {
                            match platform::autostart_set(&exe) {
                                Ok(()) => shell::log_line("已啟用開機自啟動 (HKCU Run)"),
                                Err(e) => {
                                    shell::log_line(&format!("寫入自啟動失敗: {e}"));
                                    self.page_msg.insert("autostart".into(), "設定失敗: 沒能把開機自啟動寫進 Windows 設定, 請重新試一次".to_string());
                                }
                            }
                        }
                    } else {
                        match platform::autostart_remove() {
                            Ok(()) => shell::log_line("已取消開機自啟動 (HKCU Run 已移除)"),
                            Err(e) => {
                                shell::log_line(&format!("移除自啟動失敗: {e}"));
                                self.page_msg.insert("autostart".into(), "設定失敗: 沒能把開機自啟動從 Windows 設定移除, 請重新試一次".to_string());
                            }
                        }
                    }
                }
                ui.label("勾選後, 每次登入 Windows, AI寶 會自己在右下角系統匣上線並自動登入 LINE, 不用你動手。取消勾選就完全移除, 不留殘留。");
                if let Some(cur) = &current {
                    ui.label(egui::RichText::new(format!("目前登錄: {cur}")).size(12.0).weak());
                }
                if let Some(m) = self.page_msg.get("autostart") {
                    ui.label(egui::RichText::new(m.clone()).color(self.palette.bad));
                }
            }
            #[cfg(not(windows))]
            {
                ui.label("自啟動設定只在 Windows 版提供。");
            }
            ui.add_space(6.0);
            let mut show = self.shell_settings.show_window_on_start;
            if ui.checkbox(&mut show, "雙擊啟動時直接顯示主視窗 (取消勾選則直接縮到系統匣)").changed() {
                self.shell_settings.show_window_on_start = show;
                self.shell_settings.save();
            }
        });
        ui.add_space(10.0);
        card(ui, self.palette, "介面主題", |ui| {
            ui.label("挑一個喜歡的配色, 點下去馬上生效, 不用重新啟動程式; 下次打開也會記得你的選擇。");
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                for id in theme::ThemeId::ALL {
                    let p = id.palette();
                    let selected = id == self.theme_id;
                    let (rect, resp) = ui.allocate_exact_size(egui::vec2(88.0, 62.0), egui::Sense::click());
                    let painter = ui.painter();
                    if selected {
                        painter.rect_filled(rect.shrink(1.0), 8.0, theme::with_alpha(p.primary, 22));
                        painter.rect_stroke(rect, 8.0, egui::Stroke::new(2.0, p.primary), egui::StrokeKind::Inside);
                    } else if resp.hovered() {
                        painter.rect_stroke(rect, 8.0, egui::Stroke::new(1.0, self.palette.border), egui::StrokeKind::Inside);
                    }
                    // 色票圓: 主色大圓 + 右下點綴色小圓 (黑白主題的點綴是灰階, 一樣畫得出來)
                    let center = egui::pos2(rect.center().x, rect.top() + 21.0);
                    painter.circle_filled(center, 13.0, p.primary);
                    painter.circle_stroke(center, 13.0, egui::Stroke::new(1.0, self.palette.border));
                    let dot = egui::pos2(center.x + 10.0, center.y + 9.0);
                    painter.circle_filled(dot, 6.5, p.accent);
                    painter.circle_stroke(dot, 6.5, egui::Stroke::new(1.0, self.palette.border));
                    painter.text(
                        egui::pos2(rect.center().x, rect.bottom() - 11.0),
                        egui::Align2::CENTER_CENTER,
                        id.label(),
                        egui::FontId::proportional(13.5),
                        if selected { p.primary } else { self.palette.text_main },
                    );
                    if resp.hovered() {
                        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
                    }
                    if resp.clicked() {
                        self.set_theme(ctx, id);
                    }
                }
            });
        });
        ui.add_space(10.0);
        card(ui, self.palette, "資料與結束", |ui| {
            ui.label(format!("資料目錄: {}", shell::data_dir().display()));
            ui.horizontal(|ui| {
                if ui.button("開啟資料目錄").clicked() {
                    open_folder(&shell::data_dir());
                }
                if ui.button("重新啟動引擎").clicked() {
                    self.restart_engine();
                }
            });
            ui.add_space(6.0);
            ui.label("要真的結束 AI寶 (停止回覆群組訊息), 請按下面這個按鈕; 平常關視窗只是縮到系統匣, 服務會繼續。");
            if ui.button(egui::RichText::new("結束服務並關閉程式").color(self.palette.bad).strong()).clicked() {
                self.confirm_quit = true;
            }
            let _ = ctx;
        });
    }

    fn page_about(&mut self, ui: &mut egui::Ui) {
        ui.heading("關於 AI寶");
        ui.add_space(8.0);
        card(ui, self.palette, "AI寶 — 華葳集成 LINE 學習小幫手", |ui| {
            ui.horizontal(|ui| {
                if let Some(tex) = &self.avatar_tex {
                    ui.image((tex.id(), egui::vec2(96.0, 96.0)));
                }
                ui.vertical(|ui| {
                    ui.label(format!("程式版本: {}", env!("CARGO_PKG_VERSION")));
                    let status = self.helper_status();
                    if let Some(v) = status.as_ref().and_then(|s| s.get("version")).and_then(|v| v.as_str()) {
                        ui.label(format!("引擎 (helper) 版本: {v}"));
                    }
                    let core_ver = status
                        .as_ref()
                        .and_then(|s| s.get("bot"))
                        .and_then(|b| b.get("coreVersion"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    ui.label(if core_ver.is_empty() {
                        "核心: LINE.js (尚未連線, 版號待取得)".to_string()
                    } else {
                        format!("核心: LINE.js v{core_ver} (上游版本隨每日同步更新)")
                    });
                    ui.label(format!("資料目錄: {}", shell::data_dir().display()));
                });
            });
            ui.add_space(8.0);
            ui.label(egui::RichText::new(COPYRIGHT).size(16.0).strong().color(self.palette.primary));
            ui.label(UPSTREAM_CREDIT);
            ui.add_space(6.0);
            ui.label("機密保存方式: API Key 存放在 Windows 認證管理員; LINE 登入狀態以 DPAPI 加密後存放在本機資料目錄, 只綁這台電腦的這個使用者帳號。");
            ui.label("提醒: 本程式以次要帳號登入 LINE (非官方介面), 請勿使用主帳號。");
        });
    }
}

#[cfg(test)]
mod tests {
    use super::decode_image_rgba;
    use std::io::Cursor;

    fn encode(img: &image::DynamicImage, format: image::ImageFormat) -> Vec<u8> {
        let mut buf = Vec::new();
        img.write_to(&mut Cursor::new(&mut buf), format).unwrap();
        buf
    }

    #[test]
    fn decode_accepts_png_and_jpeg() {
        // 品牌素材是 PNG、LINE 帳號頭像是 JPEG: 兩種都要解得開。
        // (舊版強制 PNG 解碼, JPEG 頭像必然失敗 — 2026-10-20 驗收第 4 項根因。)
        let src = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(4, 3, image::Rgba([10, 20, 30, 255])));
        let png = encode(&src, image::ImageFormat::Png);
        let (rgba, w, h) = decode_image_rgba(&png).expect("PNG 應可解碼");
        assert_eq!((w, h), (4, 3));
        assert_eq!(&rgba[0..4], &[10, 20, 30, 255]);
        let jpg = encode(&src, image::ImageFormat::Jpeg);
        let (rgba2, w2, h2) = decode_image_rgba(&jpg).expect("JPEG 頭像應可解碼");
        assert_eq!((w2, h2), (4, 3));
        // JPEG 是有損壓縮, 只驗大致顏色與不透明
        assert!((rgba2[0] as i32 - 10).abs() <= 4 && rgba2[3] == 255);
        assert!(decode_image_rgba(b"not an image").is_none());
    }
}

fn open_folder(path: &std::path::Path) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("explorer").arg(path).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(path).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(path).spawn();
    }
}
