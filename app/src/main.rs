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

use std::collections::HashMap;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use core_ws::{AuthState, LoginUi, SharedLogin, WsCommand};
use engine::{EngineManager, EngineState, StopOutcome};
use serde_json::Value;

const COPYRIGHT: &str = "©Copyright 2026 By 吳治綱 繁體中文化";
const UPSTREAM_CREDIT: &str = "上游出處: JS-PACKAGE/LINE.js (Apache-2.0) ・ @evex/linejs (evex-dev)";
const GREEN: egui::Color32 = egui::Color32::from_rgb(0x0c, 0x51, 0x3d);
const LIGHT_BG: egui::Color32 = egui::Color32::from_rgb(0xf3, 0xf8, 0xf3);

const FONT_BYTES: &[u8] = include_bytes!("../../helper/assets/fonts/jf-openhuninn-2.1.ttf");
const AVATAR_BYTES: &[u8] = include_bytes!("../../helper/assets/ai-bao-avatar.png");
const ICON_BYTES: &[u8] = include_bytes!("../../helper/assets/ai-bao-icon.png");

type Slot<T> = Arc<Mutex<Option<T>>>;

#[derive(Debug, Clone, Copy)]
enum AppSignal {
    ShowWindow,
    QuitApp,
}

#[derive(Debug, Clone, Copy, PartialEq)]
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
    line_cfg_status: Slot<Value>,
    reindex_slot: Slot<Value>,
    save_slot: Slot<Value>,
    page_msg: HashMap<String, String>,
    logs_slot: Slot<Value>,
    logs_text: String,
    avatar_tex: Option<egui::TextureHandle>,
    hidden: bool,
    confirm_quit: bool,
    quitting: bool,
    quit_outcome: Arc<Mutex<Option<StopOutcome>>>,
    quit_blocked_msg: Option<String>,
    show_tray_hint: bool,
    confirm_logout: bool,
    autostart_arg: bool,
    shell_settings: shell::ShellSettings,
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

fn decode_png_rgba(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory_with_format(bytes, image::ImageFormat::Png).ok()?;
    let rgba = img.to_rgba8();
    let (w, h) = rgba.dimensions();
    Some((rgba.into_raw(), w, h))
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

    let mut viewport = egui::ViewportBuilder::default()
        .with_title("AI寶")
        .with_inner_size([1024.0, 720.0])
        .with_min_inner_size([880.0, 600.0])
        .with_visible(!start_hidden);
    if let Some((rgba, w, h)) = decode_png_rgba(ICON_BYTES) {
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
        Box::new(move |cc| Ok(Box::new(App::new(cc, sig_rx, autostart, start_hidden, settings_for_app)))),
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
    let (rgba, w, h) = decode_png_rgba(ICON_BYTES)?;
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
        let mut visuals = egui::Visuals::light();
        visuals.panel_fill = LIGHT_BG;
        visuals.selection.bg_fill = GREEN;
        cc.egui_ctx.set_visuals(visuals);

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

        let avatar_tex = decode_png_rgba(AVATAR_BYTES).map(|(rgba, w, h)| {
            let img = egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba);
            cc.egui_ctx.load_texture("avatar", img, egui::TextureOptions::LINEAR)
        });

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
            line_cfg_status: Arc::new(Mutex::new(None)),
            reindex_slot: Arc::new(Mutex::new(None)),
            save_slot: Arc::new(Mutex::new(None)),
            page_msg: HashMap::new(),
            logs_slot: Arc::new(Mutex::new(None)),
            logs_text: String::new(),
            avatar_tex,
            hidden: start_hidden,
            confirm_quit: false,
            quitting: false,
            quit_outcome: Arc::new(Mutex::new(None)),
            quit_blocked_msg: None,
            show_tray_hint: false,
            confirm_logout: false,
            autostart_arg,
            shell_settings,
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

    /// 開始結束序列: 背景執行緒執行 engine.stop() (停止訊號檔→Job 兜底), 完成後主執行緒依結果關視窗;
    /// 若服務不是本視窗啟的、又停不下來 (StopOutcome::External), 不關窗, 改顯示白話說明 (不假裝已結束)。
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

    fn helper_status(&self) -> Option<Value> {
        self.snap.lock().unwrap().status.clone()
    }
}

// ---------- 共用 UI 小工具 ----------

fn card<R>(ui: &mut egui::Ui, title: &str, body: impl FnOnce(&mut egui::Ui) -> R) -> R {
    egui::Frame::default()
        .fill(egui::Color32::WHITE)
        .stroke(egui::Stroke::new(1.0, egui::Color32::from_rgb(0xd8, 0xe4, 0xd8)))
        .corner_radius(10.0)
        .inner_margin(egui::Margin::same(14))
        .show(ui, |ui| {
            ui.label(egui::RichText::new(title).strong().color(GREEN).size(17.0));
            ui.add_space(6.0);
            body(ui)
        })
        .inner
}

fn status_dot(color: egui::Color32) -> egui::RichText {
    egui::RichText::new("●").color(color).size(16.0)
}

const COLOR_OK: egui::Color32 = egui::Color32::from_rgb(0x1d, 0xa4, 0x57);
const COLOR_WARN: egui::Color32 = egui::Color32::from_rgb(0xd9, 0x8a, 0x00);
const COLOR_BAD: egui::Color32 = egui::Color32::from_rgb(0xc0, 0x39, 0x2b);
const COLOR_IDLE: egui::Color32 = egui::Color32::from_rgb(0x95, 0x9a, 0x9d);

// ---------- eframe 主迴圈 ----------

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = ui.ctx().clone();
        let ctx = &ctx;
        ctx.request_repaint_after(Duration::from_millis(400));
        self.engine_tick_and_snap();

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

        // 結束序列完成 → 依結果處理: 真的停了才關視窗; 停不下來 (外部引擎) 就取消結束並明說。
        if self.quitting {
            let outcome = self.quit_outcome.lock().unwrap().take();
            if let Some(outcome) = outcome {
                if matches!(outcome, StopOutcome::External) {
                    self.quitting = false;
                    self.quit_blocked_msg = Some(
                        "沒有把服務停下來: 目前在跑的 LINE 服務不是由這個視窗啟動的 (是另一個 AI寶 程式啟動的), 剛才已請它結束但它沒有停。這個視窗先不關, 服務還在執行中。要真正全部結束, 請到啟動它的那個 AI寶 程式按「結束服務並關閉程式」, 或到 Windows 工作管理員結束 AI寶 的行程。".to_string(),
                    );
                    shell::log_line("結束序列中止: 外部引擎未停止, 已顯示說明給使用者");
                } else {
                    ctx.send_viewport_cmd(egui::ViewportCommand::Close);
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

        // 左側導覽
        egui::Panel::left("nav")
            .resizable(false)
            .exact_size(168.0)
            .show(ui, |ui| {
                ui.add_space(10.0);
                ui.vertical_centered(|ui| {
                    if let Some(tex) = &self.avatar_tex {
                        ui.image((tex.id(), egui::vec2(72.0, 72.0)));
                    }
                    ui.label(egui::RichText::new("AI寶").strong().size(20.0).color(GREEN));
                    ui.label(egui::RichText::new("LINE 學習小幫手").size(12.0).weak());
                });
                ui.add_space(12.0);
                let items: [(Page, &str); 9] = [
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
                for (page, label) in items {
                    let selected = self.page == page;
                    let text = egui::RichText::new(label)
                        .size(15.0)
                        .color(if selected { egui::Color32::WHITE } else { egui::Color32::from_rgb(0x33, 0x33, 0x33) });
                    let btn = egui::Button::new(text)
                        .fill(if selected { GREEN } else { egui::Color32::TRANSPARENT })
                        .stroke(egui::Stroke::NONE);
                    let resp = ui.add_sized([152.0, 34.0], btn);
                    if resp.clicked() {
                        self.page = page;
                        if page == Page::BotSettings {
                            refresh_line_cfg_status(self);
                        }
                    }
                }
                ui.with_layout(egui::Layout::bottom_up(egui::Align::Center), |ui| {
                    if ui
                        .button(egui::RichText::new("結束服務並關閉程式").color(COLOR_BAD))
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
                ui.label(egui::RichText::new(COPYRIGHT).size(12.5).color(GREEN));
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
                            .button(egui::RichText::new("結束服務並關閉程式").color(COLOR_BAD).strong())
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
                        if ui.button(egui::RichText::new("確定登出").color(COLOR_BAD)).clicked() {
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
            "kb": { "folder": f.kb_folder }
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

    fn page_overview(&mut self, ui: &mut egui::Ui) {
        let login = self.login_snapshot();
        let status = self.helper_status();
        ui.heading("總覽");
        ui.add_space(8.0);
        card(ui, "服務狀態", |ui| {
            ui.horizontal(|ui| {
                if let Some(tex) = &self.avatar_tex {
                    ui.image((tex.id(), egui::vec2(84.0, 84.0)));
                }
                ui.vertical(|ui| {
                    let bot = status.as_ref().and_then(|s| s.get("bot").cloned()).unwrap_or(Value::Null);
                    let bot_name = bot.get("botName").and_then(|v| v.as_str()).unwrap_or("AI寶");
                    ui.label(egui::RichText::new(bot_name).size(22.0).strong().color(GREEN));
                    ui.horizontal(|ui| {
                        ui.label(status_dot(match self.engine_snap.state {
                            EngineState::Running | EngineState::ExternalRunning => COLOR_OK,
                            EngineState::Starting => COLOR_WARN,
                            _ => COLOR_BAD,
                        }));
                        ui.label(format!("引擎: {}", self.engine_snap.label));
                    });
                    ui.horizontal(|ui| {
                        ui.label(status_dot(match login.auth {
                            AuthState::Ready => COLOR_OK,
                            AuthState::Authenticating | AuthState::Restoring => COLOR_WARN,
                            AuthState::Error => COLOR_BAD,
                            _ => COLOR_IDLE,
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
                    });
                    if let Some(bot) = status.as_ref().and_then(|s| s.get("bot")) {
                        let ai = bot.get("aiActive").and_then(|v| v.as_str()).unwrap_or("-");
                        let model = bot.get("aiModel").and_then(|v| v.as_str()).unwrap_or("-");
                        let answered = bot.get("answeredToday").and_then(|v| v.as_u64()).unwrap_or(0);
                        ui.label(format!("使用中的 AI: {ai} / {model}"));
                        ui.label(format!("今日已回答: {answered} 次"));
                        if let Some(scam) = bot.get("scam") {
                            let checked = scam.get("checkedToday").and_then(|v| v.as_u64()).unwrap_or(0);
                            let warned = scam.get("warnedToday").and_then(|v| v.as_u64()).unwrap_or(0);
                            ui.label(format!("防詐騙: 今日檢查 {checked} 則、警告 {warned} 則"));
                        }
                    } else {
                        ui.label(egui::RichText::new("設定服務尚未就緒, 請稍候…").weak());
                    }
                });
            });
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                if ui.button("重新啟動引擎").clicked() {
                    self.restart_engine();
                }
                if ui.button("開啟 LINE 登入頁").clicked() {
                    self.page = Page::LineLogin;
                }
            });
            if let EngineState::Failed(msg) = &self.engine_snap.state {
                ui.label(egui::RichText::new(format!("引擎異常: {msg}")).color(COLOR_BAD));
            }
        });
        ui.add_space(10.0);
        card(ui, "使用方式", |ui| {
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
            card(ui, "引擎尚未就緒", |ui| {
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
                card(ui, "已登入", |ui| {
                    ui.horizontal(|ui| {
                        ui.label(status_dot(COLOR_OK));
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
                card(ui, "登入中", |ui| {
                    ui.label("請用次要帳號的 LINE, 依下面步驟完成登入:");
                    ui.label("第 1 步: 用手機 LINE 掃描這張 QR 碼 (LINE App 的「加入好友 → 行動條碼」)。");
                    if let Some(url) = &login.qr_url {
                        draw_qr(ui, url, 240.0);
                    } else {
                        ui.horizontal(|ui| {
                            ui.spinner();
                            ui.label("正在向 LINE 取得 QR 碼…");
                        });
                    }
                    ui.add_space(6.0);
                    ui.label("第 2 步: 掃描後, 手機會要你輸入一組 PIN 碼, 就是這一組:");
                    if let Some(pin) = &login.pin {
                        ui.label(egui::RichText::new(pin.clone()).size(44.0).strong().color(GREEN));
                    } else {
                        ui.label(egui::RichText::new("等待產生…").size(24.0).weak());
                    }
                    if let Some(err) = &login.last_error {
                        ui.label(egui::RichText::new(err.clone()).color(COLOR_BAD));
                        if ui.button("重新產生").clicked() {
                            let _ = self.login_tx.send(WsCommand::StartLogin);
                        }
                    }
                    ui.label(egui::RichText::new("QR 碼 3 分鐘內有效; 過期請按重新產生。").weak());
                });
            }
            AuthState::Restoring => {
                card(ui, "恢復登入中", |ui| {
                    ui.horizontal(|ui| {
                        ui.spinner();
                        ui.label("正在用上次保存的登入狀態自動登入, 請稍候…");
                    });
                });
            }
            _ => {
                card(ui, "尚未登入", |ui| {
                    if !login.connected {
                        ui.horizontal(|ui| {
                            ui.spinner();
                            ui.label("正在連接核心服務…");
                        });
                    }
                    ui.label("按下開始登入後, 這裡會出現 QR 碼, 用次要帳號的手機 LINE 掃描即可。");
                    ui.label(egui::RichText::new("重要: 請用次要帳號, 不要用主帳號登入。").color(COLOR_WARN).strong());
                    if let Some(err) = &login.last_error {
                        ui.label(egui::RichText::new(err.clone()).color(COLOR_BAD));
                    }
                    ui.add_space(6.0);
                    if ui.button(egui::RichText::new("開始登入").size(18.0)).clicked() {
                        let _ = self.login_tx.send(WsCommand::StartLogin);
                    }
                });
            }
        }
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
            card(ui, &format!("{label}{}", if is_active { " (使用中)" } else { "" }), |ui| {
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
            if ui.button(egui::RichText::new(if saving { "儲存中…" } else { "儲存全部設定" }).size(17.0).strong()).clicked() {
                self.save_settings(&ctx);
            }
            if let Some(m) = &self.form.save_msg {
                ui.label(m.clone());
            }
        });
    }
}

/// 把 QR URL 字串在本機畫成 QR 圖 (內容不上傳任何服務, 比照上游 CLI 以 qrcode 套件本機產生)。
fn draw_qr(ui: &mut egui::Ui, content: &str, size: f32) {
    let code = match qrcode::QrCode::new(content.as_bytes()) {
        Ok(c) => c,
        Err(_) => {
            ui.label(egui::RichText::new("QR 碼產生失敗, 請按重新產生").color(COLOR_BAD));
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
        card(ui, "機器人名字與觸發規則", |ui| {
            ui.horizontal(|ui| {
                ui.label("機器人主名:");
                ui.add(egui::TextEdit::singleline(&mut self.form.bot_name).desired_width(200.0));
            });
            ui.horizontal(|ui| {
                ui.label("別名 (可多個, 用逗號分開):");
                ui.add(egui::TextEdit::singleline(&mut self.form.aliases_text).desired_width(280.0));
            });
            ui.label("群組裡有人在訊息中提到這個名字 (含問句或請求), AI寶 就會回應。");
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
                if ui.button(if saving { "儲存中…" } else { "儲存設定" }).clicked() {
                    self.save_settings(&ctx);
                }
                if let Some(m) = &self.form.save_msg {
                    ui.label(m.clone());
                }
            });
        });
        ui.add_space(10.0);
        card(ui, "LINE 開通 (讓機器人能在群組說話)", |ui| {
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
                            ui.label(egui::RichText::new("已在白名單").color(COLOR_OK));
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
            // 步驟二: Token
            ui.label(egui::RichText::new("步驟二: 產生機器人 Token").strong());
            ui.label(if self.form.line_token_configured {
                format!("目前 Token: 已設定 (末 4 碼 {})", self.form.line_token_last4)
            } else {
                "目前 Token: 尚未設定".to_string()
            });
            let busy_token = self.busy.get("token").copied().unwrap_or(false);
            if ui.button(if busy_token { "產生中…" } else { "自動產生 Token 並儲存" }).clicked() && !busy_token {
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
        card(ui, "知識庫資料夾", |ui| {
            ui.label("指定一個資料夾, AI寶 會讀取裡面的 .txt / .md / .csv 回答公司問題, 並註明來源檔案。資料夾內容請先自行脫敏。");
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
                }
            }
            ui.horizontal(|ui| {
                let saving = self.busy.get("save").copied().unwrap_or(false);
                if ui.button("儲存資料夾設定").clicked() && !saving {
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
        card(ui, "詐騙訊息判讀", |ui| {
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
                if ui.button(if saving { "儲存中…" } else { "儲存設定" }).clicked() {
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
        card(ui, "今日紀錄", |ui| {
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
            });
            if let Some(dir) = self.page_msg.get("logdir") {
                ui.label(format!("紀錄資料夾: {dir}"));
            }
            ui.label(egui::RichText::new("紀錄不會包含 API Key、Token 或訊息全文 (機密會被遮罩)。出問題時把這個資料夾的檔案給維護人員看即可。").weak());
            ui.add_space(6.0);
            egui::ScrollArea::vertical().max_height(420.0).show(ui, |ui| {
                ui.add(
                    egui::TextEdit::multiline(&mut self.logs_text.clone())
                        .font(egui::TextStyle::Monospace)
                        .desired_width(f32::INFINITY)
                        .interactive(false),
                );
            });
        });
    }

    fn page_app_settings(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.heading("程式設定");
        ui.add_space(8.0);
        card(ui, "啟動行為", |ui| {
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
                                    self.page_msg.insert("autostart".into(), format!("寫入自啟動失敗: {e}"));
                                }
                            }
                        }
                    } else {
                        match platform::autostart_remove() {
                            Ok(()) => shell::log_line("已取消開機自啟動 (HKCU Run 已移除)"),
                            Err(e) => {
                                self.page_msg.insert("autostart".into(), format!("移除自啟動失敗: {e}"));
                            }
                        }
                    }
                }
                ui.label("勾選後, 每次登入 Windows, AI寶 會自己在右下角系統匣上線並自動登入 LINE, 不用你動手。取消勾選就完全移除, 不留殘留。");
                if let Some(cur) = &current {
                    ui.label(egui::RichText::new(format!("目前登錄: {cur}")).size(12.0).weak());
                }
                if let Some(m) = self.page_msg.get("autostart") {
                    ui.label(egui::RichText::new(m.clone()).color(COLOR_BAD));
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
        card(ui, "資料與結束", |ui| {
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
            if ui.button(egui::RichText::new("結束服務並關閉程式").color(COLOR_BAD).strong()).clicked() {
                self.confirm_quit = true;
            }
            let _ = ctx;
        });
    }

    fn page_about(&mut self, ui: &mut egui::Ui) {
        ui.heading("關於 AI寶");
        ui.add_space(8.0);
        card(ui, "AI寶 — 華葳集成 LINE 學習小幫手", |ui| {
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
                    ui.label(format!("核心: LINE.js (上游版本隨每日同步更新)"));
                    ui.label(format!("資料目錄: {}", shell::data_dir().display()));
                });
            });
            ui.add_space(8.0);
            ui.label(egui::RichText::new(COPYRIGHT).size(16.0).strong().color(GREEN));
            ui.label(UPSTREAM_CREDIT);
            ui.add_space(6.0);
            ui.label("機密保存方式: API Key 存放在 Windows 認證管理員; LINE 登入狀態以 DPAPI 加密後存放在本機資料目錄, 只綁這台電腦的這個使用者帳號。");
            ui.label("提醒: 本程式以次要帳號登入 LINE (非官方介面), 請勿使用主帳號。");
        });
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
