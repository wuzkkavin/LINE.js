#![cfg_attr(windows, windows_subsystem = "windows")]

// AI寶 Windows 原生 App (規格書 v3): Rust + egui 殼, 內嵌 TypeScript 引擎 (核心 + helper)。
// 設計原則: 畫面全原生、不開瀏覽器; 設定與 AI 功能一律呼叫 helper 既有本機 API, 不重寫業務邏輯;
// LINE 登入走核心 WS 協定 (照上游 CLI 的非瀏覽器連線方式)。
mod chatview;
mod core_ws;
mod engine;
mod helper_api;
mod pagesend;
mod platform;
mod probe;
mod shell;
mod theme;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use core_ws::{AuthState, LoginUi, SharedLogin, WsCommand};
use engine::{EngineManager, EngineState, StopOutcome};
use serde_json::Value;

const COPYRIGHT: &str = "©Copyright 2026 By 吳治綱";
// 角色定位與回答範圍的出廠預設 (與 helper/src/config.mjs 逐字一致):
// 設定尚未載入或舊存檔缺欄位時, AI 設定頁先以預設值顯示, 不讓欄位空白誤導。
const DEFAULT_ROLE_PROMPT: &str = "你是華葳集成的電腦學習助理, 在公司 LINE 群組回答同事的電腦與 AI 工具操作問題。";
const DEFAULT_SCOPE_PROMPT: &str = "你負責回答電腦與 AI 工具操作相關的問題。遇到與電腦無關的問題（例如算命、食譜、閒聊、生活瑣事），請禮貌婉拒，說明你負責的是電腦學習協助，並引導對方改問電腦相關的問題。";
const UPSTREAM_CREDIT: &str = "上游出處: JS-PACKAGE/LINE.js (Apache-2.0) ・ @evex/linejs (evex-dev)";

// 介面顏色一律走 theme 模組的 Palette (設計定稿 design/palettes.md), 不得再寫死色碼;
// 僅 QR 碼的黑/白是功能必需 (掃描對比), 不屬主題色。

const FONT_BYTES: &[u8] = include_bytes!("../../helper/assets/fonts/jf-openhuninn-2.1.ttf");
const AVATAR_BYTES: &[u8] = include_bytes!("../../helper/assets/ai-bao-avatar.png");
const ICON_BYTES: &[u8] = include_bytes!("../../helper/assets/ai-bao-icon.png");

type Slot<T> = Arc<Mutex<Option<T>>>;

/// 引擎操作單一進行鎖 (2026-10-22 實機循環事故修復): 重新啟動引擎/一鍵修復/結束序列
/// 這類會 stop+start 引擎的操作, 同一時間只准一個在進行; 後到的要求直接略過並記 log,
/// 不 spawn 執行緒排隊。舊版每次呼叫 restart_engine 都 spawn 一條執行緒去等引擎 mutex,
/// 重複觸發 (連點、事件重複投遞) 會被序列化成一長串 stop→start 循環: 引擎每被停一次,
/// 登入頁的 QR 就被清掉一次, 使用者永遠登入不了, 而且全程沒有任何來源紀錄可查。
/// 現在每個入口都帶來源標籤寫進 log, 事故時看 shell.log 就知道是誰在什麼時候觸發。
#[derive(Clone)]
struct EngineOpGate {
    busy: Arc<AtomicBool>,
}

impl EngineOpGate {
    fn new() -> Self {
        Self { busy: Arc::new(AtomicBool::new(false)) }
    }

    /// 嘗試取得進行權: 已有操作進行中就記一筆「略過」並回 false (不排隊、不重入)。
    fn try_begin(&self, what: &str, caller: &str) -> bool {
        if self.busy.swap(true, Ordering::SeqCst) {
            shell::log_line(&format!("{what}要求被略過 (來源: {caller}): 已有引擎操作進行中, 不排隊、不重入"));
            false
        } else {
            shell::log_line(&format!("{what}開始 (來源: {caller})"));
            true
        }
    }

    fn end(&self, what: &str) {
        self.busy.store(false, Ordering::SeqCst);
        shell::log_line(&format!("{what}結束"));
    }

    fn is_busy(&self) -> bool {
        self.busy.load(Ordering::SeqCst)
    }
}

#[derive(Debug, Clone, Copy)]
enum AppSignal {
    ShowWindow,
    QuitApp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Page {
    Overview,
    ChatRoom,
    ChatManage,
    SendMessages,
    AiSettings,
    BotSettings,
    KbSettings,
    ScamSettings,
    Logs,
    AppSettings,
    About,
}

/// 側欄導覽順序與標籤 (圖示與頁面一一對應, 順序即 nav_icons 的索引)。
const NAV_PAGES: [(Page, &str); 11] = [
    (Page::Overview, "總覽"),
    (Page::ChatRoom, "聊天室畫面"),
    (Page::ChatManage, "聊天室管理"),
    (Page::SendMessages, "發送群組訊息"),
    (Page::AiSettings, "AI 設定"),
    (Page::BotSettings, "機器人與觸發"),
    (Page::KbSettings, "知識庫"),
    (Page::ScamSettings, "防詐騙"),
    (Page::Logs, "紀錄"),
    (Page::AppSettings, "程式設定"),
    (Page::About, "關於"),
];

/// 自繪側欄圖示 (白色符號 + 透明底)。產生方式與 SVG 源檔
/// 見 assets/icons/ (generate_icons.py); 底色由繪製端依主題主色即時填繪,
/// 圖示本身不帶主題色, 切主題不必換圖。
fn nav_icon_bytes(page: Page) -> &'static [u8] {
    match page {
        Page::Overview => include_bytes!("../assets/icons/nav-overview-256.png"),
        Page::ChatRoom => include_bytes!("../assets/icons/nav-chat-256.png"),
        // 聊天室管理頁暫用聊天圖示占位: 依設計通則側欄圖示須自繪, 正式圖示待補畫
        Page::ChatManage => include_bytes!("../assets/icons/nav-chat-256.png"),
        // 發送群組訊息頁暫用聊天圖示占位: 依設計通則側欄圖示須自繪, 正式圖示待設計批補畫 (施工紀錄第一階段註明)
        Page::SendMessages => include_bytes!("../assets/icons/nav-chat-256.png"),
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

/// 發送群組訊息頁選好的一個媒體 (圖片/檔案): ref_path 是本機路徑, 或 "materials:<檔名>" (教材庫)
#[derive(Clone)]
struct SendMediaSel {
    name: String,
    size: u64,
    ref_path: String,
}

/// 管理員通知的一筆事件規則 (機器人與觸發頁編輯; 存進 settings.notify.rules, 形狀見 helper/src/adminnotify.mjs)
#[derive(Clone, Default)]
struct NotifyRuleForm {
    kind: String,
    keyword: String,
    enabled: bool,
    admin_ids: Vec<String>,
}

/// 分群設定表單 (settings.ai.chatProfiles 的一個群一包; 契約見規格書《分群角色定位與回答範圍》):
/// custom=false 表示這個群的人設跟著全域預設; custom=true 表示本群自訂 (取代全域, 不是疊加)。
/// suspended=true 是「移出白名單後保留但停用」, 重新加入後要由使用者在展開編輯區按「恢復使用」才生效。
/// chatty 是聒噪模式開關 (修復版5), 與 custom 互相獨立: 只開聒噪的群也存一包
/// (personaCustom=false), 人設照舊跟全域走。admins 是本聊天室管理員 (修復版6),
/// 同樣與 custom 互相獨立。條目要不要存在由 has_entry 決定:
/// 人設自訂、聒噪開啟、停用保留、本室管理員有設定, 任一成立就存一包, 全不成立才刪除條目。
#[derive(Clone, Default, PartialEq)]
struct ChatProfileForm {
    custom: bool,
    role: String,
    scope: String,
    kb_enabled: bool,
    kb_folder: String,
    suspended: bool,
    chatty: bool,
    // 本聊天室管理員 (聊天室管理頁設定; 每筆是 (帳號, 顯示名))。與人設自訂互相獨立:
    // 只設管理員的群也存一包 (personaCustom=false), 人設照舊跟全域走。
    admins: Vec<(String, String)>,
}

impl ChatProfileForm {
    /// 這包設定需不需要以條目存在 (false = 刪掉條目, 這個群完全用預設且聒噪關閉、未設管理員)。
    fn has_entry(&self) -> bool {
        self.custom || self.chatty || self.suspended || !self.admins.is_empty()
    }

    /// 送給 helper 的完整物件 (欄位名照共用契約: rolePrompt/scopePrompt/kbEnabled/kbFolder/suspended/chatty/personaCustom)。
    /// personaCustom 就是表單的 custom (人設是否本群自訂), 與 chatty 分開送, helper 端才分得出
    /// 「只開聒噪」與「人設自訂」是兩件事。
    fn to_value(&self) -> Value {
        serde_json::json!({
            "rolePrompt": self.role,
            "scopePrompt": self.scope,
            "kbEnabled": self.kb_enabled,
            "kbFolder": self.kb_folder,
            "suspended": self.suspended,
            "chatty": self.chatty,
            "personaCustom": self.custom,
            "admins": self.admins.iter().map(|(id, name)| serde_json::json!({ "id": id, "name": name })).collect::<Vec<_>>()
        })
    }

    /// 從 settings.ai.chatProfiles 的一包解析回表單; 缺欄位照契約預設
    /// (kbEnabled 預設 true; personaCustom 缺值 = true, 與修復版4「有條目即人設自訂」相同;
    /// chatty 缺值 = false)。
    fn from_value(v: &Value) -> Self {
        Self {
            custom: v.get("personaCustom").and_then(|x| x.as_bool()).unwrap_or(true),
            role: v.get("rolePrompt").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            scope: v.get("scopePrompt").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            kb_enabled: v.get("kbEnabled").and_then(|x| x.as_bool()).unwrap_or(true),
            kb_folder: v.get("kbFolder").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            suspended: v.get("suspended").and_then(|x| x.as_bool()).unwrap_or(false),
            chatty: v.get("chatty").and_then(|x| x.as_bool()).unwrap_or(false),
            admins: v
                .get("admins")
                .and_then(|x| x.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|a| Some((a.get("id")?.as_str()?.to_string(), a.get("name")?.as_str()?.to_string())))
                        .collect()
                })
                .unwrap_or_default(),
        }
    }
}

/// 生效來源判定: 這個群的人設目前是用本聊天室自訂, 還是跟著全域預設。
/// 只看 personaCustom (custom): 只開聒噪、只設管理員、只改知識庫的群, 人設仍走全域。
/// 沒有條目 (None) 一律視為用全域預設。聊天室管理頁上方的生效來源標示與測試共用這一支。
fn chat_profile_uses_custom(form: Option<&ChatProfileForm>) -> bool {
    form.map(|f| f.custom).unwrap_or(false)
}

/// 草稿與已儲存原貌是否有效不同 (給管理頁「尚未儲存」標示用, 語意對齊補丁規則):
/// 沒存檔條目時, 草稿沒有任何自訂內容 (不開聒噪、不設管理員、不自訂人設、沒停用)
/// 視同沒改——剛點進沒自訂的室時草稿是全域預設值, 不能因此謊稱「尚未儲存」;
/// 有存檔條目時, 草稿與原貌逐值不同才算改 (補丁送完整物件的同一條件)。
fn chat_profile_dirty(draft: Option<&ChatProfileForm>, saved: Option<&ChatProfileForm>) -> bool {
    match (draft, saved) {
        (None, _) => false,
        (Some(d), None) => d.has_entry(),
        (Some(d), Some(s)) => d != s,
    }
}

/// 管理員選人器分頁: 每頁固定 50 位 (Codex 管理頁對照: 每頁最多 50 位)。
/// 回傳 (本頁第一位下標, 本頁最後一位的下一個下標, 總頁數); 沒有任何人時三者皆 0。
/// 頁碼超出範圍時由呼叫端先箝制, 這裡不主動修正 (測試直接驗邊界)。
const MANAGE_ADMIN_PAGE_SIZE: usize = 50;

fn admin_page_slice(total: usize, page: usize, per_page: usize) -> (usize, usize, usize) {
    if total == 0 || per_page == 0 {
        return (0, 0, 0);
    }
    let pages = total.div_ceil(per_page);
    let start = (page * per_page).min(total);
    let end = ((page + 1) * per_page).min(total);
    (start, end, pages)
}

/// 選人器搜尋: 名字含關鍵字、或帳號本身含關鍵字 (打帳號末碼也能找到人, Codex 搜尋列同款:
/// 「輸入名稱或成員 ID」)。空關鍵字一律符合。
fn admin_candidate_matches(name: &str, id: &str, keyword: &str) -> bool {
    keyword.is_empty() || name.contains(keyword) || id.contains(keyword)
}

/// 已選管理員中「無法確認還在室內」的人: 已選帳號不在目前候選名單裡
/// (最近沒在這個室說話、也不是社群管理員)。只陳述「不在名單、無法確認」,
/// 不推論通知送不送得到。回傳 (帳號, 存檔名字)。
fn admin_unconfirmed(
    selected: &[(String, String)],
    candidate_ids: &[String],
) -> Vec<(String, String)> {
    selected
        .iter()
        .filter(|(id, _)| !candidate_ids.iter().any(|c| c == id))
        .cloned()
        .collect()
}

/// 帳號末 4 碼 (畫面不顯示原始 ID 全文, 同名的人靠末碼區分; 未命名聊天室同款作法)。
fn admin_last4(id: &str) -> String {
    if id.len() >= 4 {
        id[id.len() - 4..].to_string()
    } else {
        id.to_string()
    }
}

/// 總覽「目前情況」提示的處置動作 (每種提示只配一顆按鈕, 不要只給一句話讓人自己找路)。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SituationAction {
    /// 不需要按鈕 (正常、或只是等候中的狀態)。
    None,
    /// 服務未啟動: 按了叫起引擎。
    StartEngine,
    /// 引擎失敗 / 機器人未連線: 按了重新啟動引擎。
    RestartEngine,
    /// 未登入 / 登入異常: 按了送出登入 (登入碼在上方登入區)。
    StartLogin,
    /// 連接埠被佔用: 按了換空閒連接埠並重啟。
    SwitchPorts,
    /// 解密被擋 / 今日有警告: 按了跳到紀錄頁看詳情 (紀錄是詳情的家, 總覽只提示)。
    ViewLogs,
}

/// 總覽「目前情況」判定 (2026-10-24 老吳: 情況區最上方要有一列白話提示, 主動告訴
/// 使用者現在需要注意什麼)。優先順序: 連接埠被佔用 → 引擎失敗 → 引擎啟動中 →
/// 服務未啟動 → 登入中/恢復中 (等候) → 登入異常/未登入 → 機器人未連線 →
/// 解密被擋 → 今日有警告 → 一切正常。第一個命中即回傳, 之後的不再列。
/// bot_connected=None (控制台狀態還沒抓到) 與 warned=None 時跳過該項, 不誤報。
pub fn current_situation(
    engine_state: &EngineState,
    login_auth: &AuthState,
    bot_connected: Option<bool>,
    decrypt_blocking: u64,
    warned_today: Option<u64>,
) -> (String, SituationAction) {
    use SituationAction::*;
    if let EngineState::Failed(msg) = engine_state {
        if msg.starts_with(&crate::engine::foreign_port_message()) {
            let (core, helper) = crate::engine::runtime_ports();
            return (
                format!("連接埠 {core}／{helper} 已由其他程式佔用，服務無法啟動；AI寶 不會自動換埠、不會動對方程式、不會自動重試。請先關掉佔用程式，再到上方服務列手動按「啟動」；佔用解除後也不會自動啟動，要手動按才會啟動。也可以按「改用空閒連接埠」換到空閒連接埠再啟動。"),
                SwitchPorts,
            );
        }
        return (
            "引擎啟動失敗，請按「重新啟動引擎」再試一次；一直失敗請用「一鍵修復」。".to_string(),
            RestartEngine,
        );
    }
    if matches!(engine_state, EngineState::Starting) {
        return ("引擎啟動中，請稍候…".to_string(), None);
    }
    if !matches!(engine_state, EngineState::Running | EngineState::ExternalRunning) {
        return (
            "服務還沒啟動，機器人不會回應群組訊息。按「去啟動」把服務叫起來。".to_string(),
            StartEngine,
        );
    }
    match login_auth {
        AuthState::Authenticating => {
            return ("正在等你掃 QR 碼登入（登入碼在上方登入區）。".to_string(), None)
        }
        AuthState::Restoring => return ("正在恢復上次登入，請稍候…".to_string(), None),
        AuthState::Error => {
            return ("登入異常，請按「去登入」重新登入。".to_string(), StartLogin)
        }
        AuthState::Ready => {}
        _ => {
            return (
                "還沒登入 LINE，登入後機器人才會在群組服務。按「去登入」開始登入。".to_string(),
                StartLogin,
            )
        }
    }
    if bot_connected == Some(false) {
        return (
            "機器人還沒連上 LINE，訊息不會回應；通常會自動重試，一直沒連上請按「重新啟動引擎」。".to_string(),
            RestartEngine,
        );
    }
    if decrypt_blocking > 0 {
        return (
            format!("有 {decrypt_blocking} 則訊息我現在讀不到（鑰匙對不上），請按「看紀錄」看詳情。"),
            ViewLogs,
        );
    }
    if let Some(w) = warned_today {
        if w > 0 {
            return (
                format!("今天已有 {w} 則防詐警告，請按「看紀錄」看詳情。"),
                ViewLogs,
            );
        }
    }
    (
        "目前正常：引擎執行中、已登入、機器人已連線。".to_string(),
        None,
    )
}

/// 起始頁解析 (AIBAO_START_PAGE, CI 冒煙/逐頁截圖專用, 一般使用不設):
/// 值與頁面的對照: overview 總覽、chat 聊天室畫面、manage 聊天室管理、send 發送群組訊息、
/// ai AI 設定、bot 機器人與觸發、kb 知識庫、scam 防詐騙、logs 紀錄、app 程式設定、about 關於。
/// 舊值 login 映射到總覽 (修復版6 起 LINE 登入併入總覽, CI 相容); 不認識的值一律總覽。
fn parse_start_page(value: Option<&str>) -> Page {
    match value {
        Some("chat") => Page::ChatRoom,
        Some("manage") => Page::ChatManage,
        Some("send") => Page::SendMessages,
        Some("ai") => Page::AiSettings,
        Some("bot") => Page::BotSettings,
        Some("kb") => Page::KbSettings,
        Some("scam") => Page::ScamSettings,
        Some("logs") => Page::Logs,
        Some("app") => Page::AppSettings,
        Some("about") => Page::About,
        // "overview" 與舊值 "login" 與其他值都回總覽
        _ => Page::Overview,
    }
}

/// 組「儲存聊天室設定」的補丁: 只含與載入原貌不同的群。
/// 不再需要條目 (人設用預設、聒噪關閉、未停用, 見 has_entry) 或表單裡已不存在的原有群 = 傳 null 刪除;
/// 需要條目且改過欄位的群 = 完整物件 (suspended/chatty 的變更也併進完整物件一起送, 伺服器端照契約合併欄位)。
fn chat_profiles_patch(forms: &HashMap<String, ChatProfileForm>, orig: &HashMap<String, ChatProfileForm>) -> serde_json::Map<String, Value> {
    let mut patch = serde_json::Map::new();
    for (id, o) in orig {
        match forms.get(id) {
            None => {
                patch.insert(id.clone(), Value::Null);
            }
            Some(f) if !f.has_entry() => {
                patch.insert(id.clone(), Value::Null);
            }
            Some(f) if f != o => {
                patch.insert(id.clone(), f.to_value());
            }
            _ => {}
        }
    }
    for (id, f) in forms {
        if orig.contains_key(id) {
            continue;
        }
        if f.has_entry() {
            patch.insert(id.clone(), f.to_value());
        }
    }
    patch
}

/// 補丁送出成功後的新原貌: 以原貌為底, null 的群刪掉、物件的群換成表單目前值。
fn chat_profiles_new_orig(
    forms: &HashMap<String, ChatProfileForm>,
    orig: &HashMap<String, ChatProfileForm>,
    patch: &serde_json::Map<String, Value>,
) -> HashMap<String, ChatProfileForm> {
    let mut out = orig.clone();
    for (id, v) in patch {
        if v.is_null() {
            out.remove(id);
        } else if let Some(f) = forms.get(id) {
            out.insert(id.clone(), f.clone());
        }
    }
    out
}

/// bot 狀態裡一份知識庫索引狀態 (全域 kb 或某群的 kbChats) 的白話一行,
/// 格式比照知識庫頁: 檔案數、片段數、整理中標示、資料夾。
fn kb_status_line(kb: &Value) -> String {
    let files = kb.get("files").and_then(|v| v.as_u64()).unwrap_or(0);
    let chunks = kb.get("chunks").and_then(|v| v.as_u64()).unwrap_or(0);
    let ready = kb.get("ready").and_then(|v| v.as_bool()).unwrap_or(false);
    let scanning = kb.get("scanning").and_then(|v| v.as_bool()).unwrap_or(false);
    let folder = kb.get("folder").and_then(|v| v.as_str()).unwrap_or("");
    let mut line = format!(
        "檔案 {} 個、片段 {} 段{}",
        files,
        chunks,
        if scanning {
            " (索引正在背景整理中…)"
        } else if ready {
            " (已就緒)"
        } else {
            " (尚無可用檔案)"
        }
    );
    if !folder.is_empty() {
        line.push_str(&format!("; 資料夾: {folder}"));
    }
    line
}

#[derive(Default)]
struct SettingsForm {
    loaded: bool,
    bot_name: String,
    aliases_text: String,
    trigger_mode: String,
    cooldown_sec: u32,
    daily_limit: u32,
    per_user_chat_minute: u32,
    all_chats_minute: u32,
    ai_active: String,
    ai_role: String,
    ai_scope: String,
    providers: HashMap<String, ProviderForm>,
    scam_enabled: bool,
    scam_threshold: f64,
    scam_per_minute: u32,
    jev_enabled: bool,
    jev_model: String,
    jev_key_input: String,
    jev_key_configured: bool,
    jev_key_last4: String,
    jev_key_clear: bool,
    kb_folder: String,
    show_sources: bool,
    // 修復版6後續修復: creatorReply 已清除 (老吳 2026-10-24 02:53 定案: 創造者問答
    // 固定回覆取消、改委婉拒答)。App 不再讀寫該欄位, helper 也不再把它放進預設值;
    // 舊存檔裡殘留的值由 helper 載入時清除, 不會再被回寫。
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
    // 管理員通知: admins 是 (帳號, 顯示名); 名單由候選清單勾選產生 (不用手打代號), 候選來自白名單群組發言者+OpenChat 管理員 (第四階段接通)
    notify_admins: Vec<(String, String)>,
    notify_rules: Vec<NotifyRuleForm>,
    save_msg: Option<String>,
    // 分群設定 (聊天室管理頁編輯): chat_profiles 是目前畫面上的表單值,
    // chat_profiles_orig 是載入時的原貌快照, 儲存時兩邊比對才知道哪些群要送完整物件、哪些送 null 刪除。
    chat_profiles: HashMap<String, ChatProfileForm>,
    chat_profiles_orig: HashMap<String, ChatProfileForm>,
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
    /// 引擎操作單一進行鎖: 重啟/修復/結束共用, 防重複觸發排隊成 stop→start 循環。
    engine_gate: EngineOpGate,
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
    // 分群設定 (聊天室管理頁編輯): 儲存/刪除/停用的背景結果通道與待套用的新原貌。
    chat_profiles_slot: Slot<Value>,
    // 聊天室管理頁: 目前選定的聊天室、本室管理員候選清單與其背景通道。
    manage_chat_id: String,
    manage_candidates: Vec<Value>,
    manage_candidates_slot: Slot<Value>,
    manage_candidates_for: String,
    // 聊天室管理頁選管理員: 搜尋關鍵字 (本機即時過濾) 與是否已切到較寬名單 (all=1)。
    manage_admin_search: String,
    // 聊天室管理員選人器分頁: 目前頁 (0 起算), 每頁 50 位 (Codex 對照: 每頁最多 50 位)。
    // CI 逐頁截圖可用 AIBAO_MANAGE_PAGE (1 起算) 與 AIBAO_MANAGE_SEARCH 預設頁碼與搜尋字,
    // 由 manage_ci_prefill_done 保證一個啟動只套用一次, 之後使用者點上一頁/下一頁不再被環境變數蓋掉。
    manage_admin_page: usize,
    manage_ci_prefill_done: bool,
    // 聊天室管理頁聊天室清單的搜尋關鍵字 (群很多時打群名篩選, 企業多群場景)。
    manage_chat_search: String,
    manage_candidates_all: bool,
    // 機器人與觸發頁備援管理員選人: 搜尋關鍵字 (本機即時過濾)。
    backup_admin_search: String,
    // 聊天室畫面頁進頁紀錄: 記上次寫過紀錄時所在的頁面, 避免每一幀都刷 log。
    chat_log_last_page: Option<Page>,
    // 總覽嵌入聊天畫面進頁追蹤 (與聊天室畫面頁分開記, 兩頁共用同一個 WebView):
    // 進總覽時也要做一次強制重排重顯, 第一次就要畫出來。
    overview_last_page: Option<Page>,
    // 總覽「改用空閒連接埠」挑不到埠時的錯誤行 (成功時重啟引擎, 提示由狀態變化承擔)。
    ports_msg: Option<String>,
    // 總覽服務列「登入 QR 碼」在引擎未跑時先啟動引擎、就緒後自動送一次登入;
    // 使用者離開總覽即清除, 不在別頁突然跳出登入。
    login_after_engine: bool,
    // 聊天室畫面頁自我檢查 (修復版6後續修復): 按「檢查核心網頁」後背景執行緒回填結果。
    chat_check_slot: Slot<String>,
    chat_check_msg: Option<String>,
    chat_profiles_msg: Option<String>,
    /// 儲存/刪除成功後要套用的 (新原貌, 成功後要從表單移除的 chatId 清單 — 孤兒刪除用)。
    chat_profiles_pending: Option<(HashMap<String, ChatProfileForm>, Vec<String>)>,
    chat_suspend_slot: Slot<Value>,
    chat_suspend_id: Option<String>,
    /// 正在移除白名單的 chatId: 移除成功後若該群有自訂設定, 要追加送 suspended=true 保留但停用。
    pending_remove_chat: Option<String>,
    // 機器人聊天情況面板 (第 12 項): 活動端點的最近結果與上次抓取時間
    activity_slot: Arc<Mutex<Option<serde_json::Value>>>,
    activity: Option<serde_json::Value>,
    activity_fetched_at: Option<std::time::Instant>,
    activity_msg: Option<String>,
    // 群組篩選 (2026-10-23 老吳裁示): Some((chatId, 顯示名)) = 只看該群; None = 全部群組。
    // 純顯示層狀態, 連同名稱一起存, 讓該群暫時不在最近紀錄裡時選單仍顯示得出來。
    activity_chat_filter: Option<(String, String)>,
    // 發送群組訊息頁 (2026-10-22 第一階段): 表單狀態 + 待發清單/紀錄的載入 slot
    send_chat_id: String,
    send_chat_name: String,
    send_text: String,
    send_mode: String,
    send_once_at: String,
    send_repeat_kind: String,
    send_cycle: String,
    send_time: String,
    send_weekdays: [bool; 7],
    send_month_day: u32,
    send_msg: Option<String>,
    outbox_slot: Slot<Value>,
    outbox_entries: Vec<Value>,
    outbox_attempted: bool,
    outbox_action_slot: Slot<Value>,
    // 發送群組訊息 (第三階段): 選好的圖片/檔案、系列每一份的文字、教材庫與排程計時
    send_images: Vec<SendMediaSel>,
    send_files: Vec<SendMediaSel>,
    send_series: Vec<String>,
    materials: Vec<Value>,
    materials_slot: Slot<Value>,
    materials_attempted: bool,
    /// 這次程式啟動的時間 (epoch 毫秒): 排程「程式沒開時錯過」的判定基準 (pagesend::plan_entry)
    send_engine_started_ms: i64,
    last_send_tick: Option<std::time::Instant>,
    last_notify_tick: Option<std::time::Instant>,
    /// 最近一次「管理員通知送不出去」的白話原因 (送成功就清除); 顯示在通知紀錄卡上方,
    /// 讓失敗看得見, 不再只留在 log 裡 (2026-10-22 修復)。
    notify_last_error: Option<String>,
    send_tick_slot: Slot<Value>,
    // 管理員通知 (第四階段): 事件紀錄與候選名單 (機器人與觸發頁顯示/勾選)
    admin_events: Vec<Value>,
    admin_events_slot: Slot<Value>,
    admin_events_attempted: bool,
    candidates: Vec<Value>,
    candidates_slot: Slot<Value>,
    // 嵌入聊天畫面 (2026-10-21 新增「聊天室畫面」頁): WebView 宿主、主視窗代碼、profile 目錄
    chatview: chatview::ChatViewHost,
    parent_hwnd: Option<isize>,
    webview_profile_dir: std::path::PathBuf,
    line_cfg_status: Slot<Value>,
    reindex_slot: Slot<Value>,
    save_slot: Slot<Value>,
    page_msg: HashMap<String, String>,
    logs_slot: Slot<Value>,
    logs_text: String,
    /// 紀錄頁進頁自動讀取只嘗試一次 (比照 wl_attempted 的教訓: 不每幀重打)。
    logs_attempted: bool,
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
    nav_icons: [Option<egui::TextureHandle>; 11],
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
    // 視窗/工作列圖示: 給預先縮好的 64px 圖 (理由見 icon_rgba), 不再直交 233x232 原圖。
    // 解碼失敗不再靜默 (2026-10-22 修復): 舊版失敗就沒圖示、也沒任何紀錄, 真機回報
    // 「工具列 icon 沒顯示」時無從查起; 現在至少 log 留證據、總覽也會提示。
    match icon_rgba(64) {
        Some((rgba, w, h)) => {
            viewport = viewport.with_icon(egui::IconData { rgba, width: w, height: h });
        }
        None => shell::log_line("視窗/工作列圖示載入失敗: 品牌圖示解碼失敗, 工作列將顯示預設圖示"),
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
    // 理由見 icon_rgba), 不再讓 Windows 把 233x232 原圖即時縮小而產生黑邊。
    // 每一步失敗都記 log (2026-10-22 修復): 舊版全程用 ? 靜默吞掉, 系統匣沒出現也查不到原因。
    let (rgba, w, h) = match icon_rgba(32) {
        Some(v) => v,
        None => {
            shell::log_line("系統匣圖示建立失敗: 品牌圖示解碼失敗");
            return None;
        }
    };
    let normal = match tray_icon::Icon::from_rgba(rgba.clone(), w, h) {
        Ok(v) => v,
        Err(e) => {
            shell::log_line(&format!("系統匣圖示建立失敗: 圖示轉換失敗 ({e})"));
            return None;
        }
    };
    // 灰階版: 未登入/異常時用 (飽和度降為 0)
    let mut gray = rgba.clone();
    for px in gray.chunks_exact_mut(4) {
        let g = ((px[0] as u32 * 30 + px[1] as u32 * 59 + px[2] as u32 * 11) / 100) as u8;
        px[0] = g;
        px[1] = g;
        px[2] = g;
    }
    let gray_icon = match tray_icon::Icon::from_rgba(gray, w, h) {
        Ok(v) => v,
        Err(e) => {
            shell::log_line(&format!("系統匣圖示建立失敗: 灰階圖示轉換失敗 ({e})"));
            return None;
        }
    };

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
    let icon = match tray_icon::TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("AI寶 — 啟動中")
        .with_icon(normal.clone())
        .build()
    {
        Ok(v) => v,
        Err(e) => {
            shell::log_line(&format!("系統匣圖示建立失敗: 系統匣註冊失敗 ({e})"));
            return None;
        }
    };
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
        // 執行期連接埠: 先讀 shell-settings (改用空閒連接埠後存的值), 再啟動任何引擎 —
        // 順序不能反, 否則第一個引擎會跑在舊埠、殼卻去新埠找服務。
        if let (Some(core), Some(helper)) = (shell_settings.core_port, shell_settings.helper_port) {
            crate::engine::set_runtime_ports(core, helper);
            shell::log_line(&format!("連接埠沿用上次換好的空閒連接埠: 核心 {core}、控制台 {helper}"));
        }
        // 啟動行為 (2026-10-22 老吳交代改為可選): 「開啟程式時自動登入並啟用服務」
        // 預設關閉 — 關閉時不啟動引擎, 程式停在未登入狀態, 等使用者按「登入並啟用」。
        // --autostart (開機自啟動) 只影響縮系統匣與否, 不再連帶自動登入。
        if shell_settings.auto_login {
            let mut mgr = engine.lock().unwrap();
            if let Err(e) = mgr.start() {
                shell::log_line(&format!("引擎啟動失敗: {e}"));
                mgr.state = EngineState::Failed(e);
            }
        } else {
            shell::log_line("自動登入已關閉: 程式開啟後停在未啟用狀態, 等使用者按「登入並啟用」");
        }

        let avatar_tex = decode_image_rgba(AVATAR_BYTES).map(|(rgba, w, h)| {
            let img = egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba);
            cc.egui_ctx.load_texture("avatar", img, egui::TextureOptions::LINEAR)
        });

        // 側欄圖示: 任一顆解碼失敗只退回該顆純文字按鈕並記 log, 不 panic、不擋啟動。
        let mut nav_icons: [Option<egui::TextureHandle>; 11] = Default::default();
        for (idx, (page, _)) in NAV_PAGES.iter().enumerate() {
            nav_icons[idx] = decode_image_rgba(nav_icon_bytes(*page)).map(|(rgba, w, h)| {
                let img = egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], &rgba);
                cc.egui_ctx.load_texture(format!("nav-{idx}"), img, egui::TextureOptions::LINEAR)
            });
            if nav_icons[idx].is_none() {
                shell::log_line(&format!("側欄圖示載入失敗 (page={page:?}), 該顆退回純文字按鈕"));
            }
        }

        // 嵌入聊天畫面的父視窗代碼: 只在 Windows MSVC 建置取出 (其他平台嵌入不可用, 走占位)。
        #[cfg(all(windows, target_env = "msvc"))]
        let parent_hwnd = {
            use raw_window_handle::HasWindowHandle as _;
            cc.window_handle().ok().and_then(|h| match h.as_raw() {
                raw_window_handle::RawWindowHandle::Win32(w) => Some(w.hwnd.get()),
                _ => None,
            })
        };
        #[cfg(not(all(windows, target_env = "msvc")))]
        let parent_hwnd: Option<isize> = None;

        // 冒煙/截圖用: 以環境變數 AIBAO_START_PAGE 指定起始頁 (overview/chat/manage/send/ai/bot/kb/scam/logs/app/about);
        // 舊值 login 映射到總覽 (CI 相容); 沒設或不認識的值一律總覽, 一般使用不受影響。
        let start_page = parse_start_page(std::env::var("AIBAO_START_PAGE").ok().as_deref());
        if start_page != Page::Overview {
            shell::log_line(&format!("起始頁由 AIBAO_START_PAGE 指定: {start_page:?}"));
        }

        #[cfg(windows)]
        let tray = build_tray();
        let mut app = Self {
            engine,
            engine_gate: EngineOpGate::new(),
            engine_snap: EngineSnap::default(),
            login,
            login_tx,
            signals,
            page: start_page,
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
            chat_profiles_slot: Arc::new(Mutex::new(None)),
            manage_chat_id: String::new(),
            manage_candidates: Vec::new(),
            manage_candidates_slot: Arc::new(Mutex::new(None)),
            manage_candidates_for: String::new(),
            manage_admin_search: String::new(),
            manage_admin_page: 0,
            manage_ci_prefill_done: false,
            manage_chat_search: String::new(),
            manage_candidates_all: false,
            backup_admin_search: String::new(),
            chat_log_last_page: None,
            overview_last_page: None,
            ports_msg: None,
            login_after_engine: false,
            chat_check_slot: Arc::new(Mutex::new(None)),
            chat_check_msg: None,
            chat_profiles_msg: None,
            chat_profiles_pending: None,
            chat_suspend_slot: Arc::new(Mutex::new(None)),
            chat_suspend_id: None,
            pending_remove_chat: None,
            activity_slot: Arc::new(Mutex::new(None)),
            activity: None,
            activity_fetched_at: None,
            activity_msg: None,
            activity_chat_filter: None,
            send_chat_id: String::new(),
            send_chat_name: String::new(),
            send_text: String::new(),
            send_mode: "now".to_string(),
            send_once_at: String::new(),
            send_repeat_kind: "same".to_string(),
            send_cycle: "weekly".to_string(),
            send_time: "09:00".to_string(),
            send_weekdays: [false, true, false, false, false, false, false],
            send_month_day: 1,
            send_msg: None,
            outbox_slot: Arc::new(Mutex::new(None)),
            outbox_entries: Vec::new(),
            outbox_attempted: false,
            outbox_action_slot: Arc::new(Mutex::new(None)),
            send_images: Vec::new(),
            send_files: Vec::new(),
            send_series: vec![String::new()],
            materials: Vec::new(),
            materials_slot: Arc::new(Mutex::new(None)),
            materials_attempted: false,
            send_engine_started_ms: pagesend::now_ms(),
            last_send_tick: None,
            last_notify_tick: None,
            notify_last_error: None,
            send_tick_slot: Arc::new(Mutex::new(None)),
            admin_events: Vec::new(),
            admin_events_slot: Arc::new(Mutex::new(None)),
            admin_events_attempted: false,
            candidates: Vec::new(),
            candidates_slot: Arc::new(Mutex::new(None)),
            chatview: chatview::ChatViewHost::new(),
            parent_hwnd,
            webview_profile_dir: shell::data_dir().join("webview2-profile-v2"),
            line_cfg_status: Arc::new(Mutex::new(None)),
            reindex_slot: Arc::new(Mutex::new(None)),
            save_slot: Arc::new(Mutex::new(None)),
            page_msg: HashMap::new(),
            logs_slot: Arc::new(Mutex::new(None)),
            logs_text: String::new(),
            logs_attempted: false,
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
        #[cfg(windows)]
        if app.tray.is_none() {
            shell::log_line("本次啟動沒有系統匣圖示 (建立失敗, 原因見上方紀錄)");
        }
        if autostart_arg {
            shell::log_line("以 --autostart 模式啟動 (縮系統匣待命; 要不要登入看「自動登入」設定)");
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
    fn begin_quit(&mut self, ctx: &egui::Context, caller: &str) {
        if self.quitting {
            return;
        }
        // 結束序列不被進行鎖擋下 (使用者要結束就該能結束), 但要留下來源紀錄;
        // 若剛好有重啟/修復進行中, log 會寫明, 本執行緒接著等引擎 mutex 依序處理。
        let _ = self.engine_gate.try_begin("結束序列", caller);
        self.quitting = true;
        self.confirm_quit = false;
        self.show_window(ctx);
        let engine = self.engine.clone();
        let gate = self.engine_gate.clone();
        let slot = self.quit_outcome.clone();
        std::thread::spawn(move || {
            let outcome = {
                let mut mgr = engine.lock().unwrap();
                mgr.stop()
            };
            shell::log_line(&format!("結束序列完成: {outcome:?}"));
            *slot.lock().unwrap() = Some(outcome);
            gate.end("結束序列");
        });
    }

    fn restart_engine(&mut self, caller: &str) {
        // 單一進行鎖: 已有引擎操作進行中就直接略過這次要求 (不 spawn 執行緒排隊)。
        // 舊版每次呼叫都 spawn 一條執行緒等 mutex, 重複觸發會被序列化成一長串
        // stop→start 循環 (2026-10-22 實機事故: 19 次循環、QR 每次出現就被砍掉)。
        if !self.engine_gate.try_begin("重新啟動引擎", caller) {
            return;
        }
        let engine = self.engine.clone();
        let gate = self.engine_gate.clone();
        std::thread::spawn(move || {
            let mut mgr = engine.lock().unwrap();
            let _ = mgr.stop();
            if let Err(e) = mgr.start() {
                shell::log_line(&format!("重新啟動引擎失敗: {e}"));
                mgr.state = EngineState::Failed(e);
            }
            drop(mgr);
            gate.end("重新啟動引擎");
        });
    }

    /// 「登入並啟用」: 使用者主動按下才啟動引擎 (自動登入關閉時的入口)。
    /// 只 start 不 stop: start 本身對已在跑的引擎是無動作, 不會打斷現有連線。
    fn start_engine(&mut self, caller: &str) {
        if !self.engine_gate.try_begin("啟用引擎", caller) {
            return;
        }
        let engine = self.engine.clone();
        let gate = self.engine_gate.clone();
        std::thread::spawn(move || {
            let mut mgr = engine.lock().unwrap();
            if let Err(e) = mgr.start() {
                shell::log_line(&format!("啟用引擎失敗: {e}"));
                mgr.state = EngineState::Failed(e);
            }
            drop(mgr);
            gate.end("啟用引擎");
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
        // 與重啟/結束共用單一進行鎖: 已有引擎操作進行中就不另起修復 (不排隊、不重入)。
        if !self.engine_gate.try_begin("一鍵修復", "總覽頁「一鍵修復」按鈕") {
            self.repair_lines = vec!["引擎正在進行其他操作 (重新啟動或結束中), 請等它完成後再按一次一鍵修復".to_string()];
            return;
        }
        self.busy.insert("repair".into(), true);
        self.repair_lines = vec!["修復中… 正在檢查服務狀態".to_string()];
        let slot = self.repair_slot.clone();
        let engine = self.engine.clone();
        let gate = self.engine_gate.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let mut lines: Vec<String> = Vec::new();
            let mut restarted = false;
            let mut state0 = engine.lock().unwrap().state.clone();
            // 引擎還在啟動中就先等它定案再判斷 (最多 30 秒): 舊版一讀到 Starting 就回
            // 「等它完成」, 但引擎可能隨即被停掉/失敗, 結論與實況脫節 (2026-10-22 實機:
            // 修復說等啟動完成, 引擎 1 秒後就被結束序列停掉, 使用者以為修復沒用)。
            if matches!(state0, EngineState::Starting) {
                for _ in 0..15 {
                    std::thread::sleep(Duration::from_secs(2));
                    state0 = engine.lock().unwrap().state.clone();
                    if !matches!(state0, EngineState::Starting) {
                        break;
                    }
                }
                if matches!(state0, EngineState::Starting) {
                    lines.push("檢查發現: 引擎啟動超過 30 秒還沒完成, 重新啟動它".to_string());
                }
            }
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
                    // 走到這裡代表已等了 30 秒仍未就緒 (等待迴圈已記下卡住的那行), 直接重啟。
                    true
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
                // 已在修復開頭等過 30 秒; 走到這裡是等待期間狀態離開又回到啟動中的罕見情形。
                lines.push("引擎還在啟動, 請等左下角變成「引擎: 執行中」再到群組測試".to_string());
            }
            // 訊息解密檢查 (2026-10-21 第二段): 引擎與連線都正常, 不代表讀得到訊息 —
            // 群組成員變動後 LINE 換了讀訊息的鑰匙、跟這台電腦對不上時, 訊息會在核心
            // 解密失敗、機器人完全收不到, 而且重新啟動修不好 (鑰匙存在登入狀態裡)。
            // 修復要誠實講出這個病因並指引登出重登; 修復本身不能替使用者登出
            // (登出重登要他拿手機掃 QR, 不是程式能代做的事)。
            if let Ok(v) = helper_api::get_status() {
                if let Some(dec) = v.get("bot").and_then(|b| b.get("decrypt")) {
                    if dec.get("state").and_then(|x| x.as_str()) == Some("failed") {
                        let total = dec.get("totalFailed").and_then(|x| x.as_u64()).unwrap_or(0);
                        let names: Vec<String> = dec.get("issues").and_then(|x| x.as_array())
                            .map(|a| a.iter().filter_map(|i| i.get("name").and_then(|n| n.as_str()).map(|s| s.to_string())).collect())
                            .unwrap_or_default();
                        let where_text = if names.is_empty() { String::new() } else { format!("(在『{}』)", names.join("』、『")) };
                        lines.push(format!("檢查發現: 有 {total} 則訊息解密失敗{where_text} — 機器人讀不到那些訊息的內容, 所以不會回覆; 這是鑰匙對不上, 重新啟動修不好。第一步: 請到「總覽」頁按「登出」, 再重新掃 QR 登入, 讓鑰匙重新對齊。若登出重登後還是讀不到, 第二步: 把機器人移出該群組、再重新邀請它加入 (重新入群會讓 LINE 把目前的鑰匙重新分發給它)。"));
                    }
                    // 漏接 (整個群組收不到) 是更嚴重的病徵, 要獨立講清楚, 不能混在解密失敗裡
                    if let Some(missed_issues) = dec.get("missedIssues").and_then(|x| x.as_array()) {
                        for issue in missed_issues {
                            let name = issue.get("name").and_then(|n| n.as_str()).unwrap_or("未命名群組");
                            let missed = issue.get("missed").and_then(|n| n.as_u64()).unwrap_or(0);
                            lines.push(format!("檢查發現: 『{name}』有 {missed} 則訊息根本沒有送到機器人這裡 — 那個群組的訊息現在整個收不到, 叫它也不會回應。請先到「總覽」頁登出後重新登入; 若還是收不到, 把機器人移出該群組、再重新邀請它加入。"));
                        }
                    }
                }
            }
            shell::log_line(&format!("一鍵修復完成: {}", lines.join(" / ")));
            *slot.lock().unwrap() = Some(lines);
            gate.end("一鍵修復");
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
    /// 依目前主題即時填繪。選中態: 整列主色底、
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
                {
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

// ---------- 群組清單共用列 (2026-10-21 版面整理) ----------
// 讀取清單與白名單清單共用同一種列: 左側主行 = 群組名稱、副行小字 = 類型・人數;
// 右側固定欄位 (固定寬度、靠右) 放動作按鈕或狀態標籤, 讓每列按鈕水平成一直線;
// 列與列之間以分隔線區隔。畫面上不顯示原始 chat ID (ID 只留在 log/診斷資料)。

/// 聊天情況群組篩選的選單標籤: 有群名用群名; 沒群名 (核心尚未回報名稱) 不顯示
/// 完整編號 (畫面不露原始 ID 的產品規格), 以末 4 碼區分不同的未命名聊天室。
fn activity_chat_label(id: &str, name: &str) -> String {
    if !name.is_empty() {
        return name.to_string();
    }
    let tail: String = id.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    if tail.is_empty() {
        "未命名聊天室".to_string()
    } else {
        format!("未命名聊天室 (末 4 碼 {tail})")
    }
}

fn chat_kind_label(kind: &str) -> &str {
    match kind {
        "group" => "群組",
        "room" => "聊天室",
        "square" => "社群",
        _ => "聊天室",
    }
}

/// 逐項送出一筆待發的內容 (文字走瀏覽器通道、圖片先上傳拿 mediaId 再送、
/// 檔案先 POST /file/upload 拿 fileId 再送 — 第二階段介面契約, 2026-10-22 接通)。
/// prev 有值時 = 重送模式: 上次成功的項目原樣保留、不重送, 只送失敗的。
/// 回傳與 pagesend::flatten_entry 同序的逐項結果 [{ok, note}]。
fn send_entry_items(ch: &mut pagesend::PageChannel, entry: &Value, prev: Option<&Vec<Value>>) -> Vec<Value> {
    let chat = entry.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
    let flat = pagesend::flatten_entry(entry);
    let mut out = Vec::new();
    for (i, item) in flat.iter().enumerate() {
        if let Some(prev) = prev {
            if prev.get(i).and_then(|r| r.get("ok")).and_then(|b| b.as_bool()).unwrap_or(false) {
                out.push(prev[i].clone());
                continue;
            }
        }
        let r = match item.kind.as_str() {
            "text" => ch.send_text(chat, &item.text, &[]),
            "image" => match pagesend::load_image_bytes(item, &|name| helper_api::get_material_bytes(name)) {
                Ok(bytes) => {
                    let ct = pagesend::image_content_type(&bytes, &item.name);
                    ch.send_image_bytes(chat, &bytes, ct)
                }
                Err(e) => Err(e),
            },
            "file" => match pagesend::load_file_bytes(item, &|name| helper_api::get_material_bytes(name)) {
                Ok(bytes) => ch.send_file_bytes(chat, &bytes, &item.name),
                Err(e) => Err(e),
            },
            _ => Err("不明的內容種類, 沒有送出".to_string()),
        };
        out.push(match r {
            Ok(()) => serde_json::json!({ "ok": true, "note": "" }),
            Err(e) => serde_json::json!({ "ok": false, "note": e }),
        });
        std::thread::sleep(Duration::from_millis(250)); // 逐項間隔, 避免同秒連發被核心限流
    }
    out
}

/// 把待送的管理員通知送掉 (第四階段): @ 送不出去 (核心保留訊息裡沒有這個人) 就改純文字點名重送,
/// 結果與原因都寫回事件紀錄, 畫面與紀錄只出現白話。
/// 回傳 (有沒有真的送成功至少一筆, 最後一筆失敗的白話原因) — 呼叫端據此在畫面顯示
/// 「通知目前送不出去」的狀態, 不讓失敗只留在 log 裡 (2026-10-22 修復)。
fn send_admin_events(ch: &mut pagesend::PageChannel) -> (bool, Option<String>) {
    let Ok(v) = helper_api::get_admin_events() else { return (false, Some("通知清單讀不到, 請稍後再試".to_string())) };
    let pending = v.get("pending").and_then(|p| p.as_array()).cloned().unwrap_or_default();
    let mut sent_any = false;
    let mut last_error: Option<String> = None;
    for ev in &pending {
        let id = ev.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let chat = ev.get("chatId").and_then(|x| x.as_str()).unwrap_or("");
        let body = ev.get("message").and_then(|x| x.as_str()).unwrap_or("");
        if id.is_empty() || chat.is_empty() || body.is_empty() {
            if !id.is_empty() {
                let _ = helper_api::mark_admin_event_sent(id, false, "通知內容不完整, 只保留在紀錄裡");
            }
            continue;
        }
        let targets = ev.get("targets").and_then(|t| t.as_array()).cloned().unwrap_or_default();
        let (text, mentions, any_plain) = pagesend::build_notify_text(body, &targets);
        let plain_note = "有管理員還沒在這個群說過話或不在群裡, 已改用寫名字的方式點名 (請管理員先在群裡說一句話, 之後就能被 @ 到)";
        let (ok, note) = match ch.send_text(chat, &text, &mentions) {
            Ok(()) => (true, if any_plain { plain_note.to_string() } else { String::new() }),
            Err(e) => {
                if !mentions.is_empty() {
                    match ch.send_text(chat, &text, &[]) {
                        Ok(()) => (true, plain_note.to_string()),
                        Err(e2) => (false, format!("通知送不出去: {e2}")),
                    }
                } else {
                    (false, format!("通知送不出去: {e}"))
                }
            }
        };
        let _ = helper_api::mark_admin_event_sent(id, ok, &note);
        shell::log_line(&format!("管理員通知送出: id={id} ok={ok} note={note}"));
        if ok { sent_any = true; } else { last_error = Some(note.clone()); }
    }
    (sent_any, last_error)
}

/// 排程一輪 (背景執行緒呼叫): 讀待發清單與解密狀態, 照 pagesend::plan_entry 逐筆處置;
/// 要送的與待送的管理員通知共用一條瀏覽器通道連線。回傳 {changed, notes} 給 poll 記 log/重讀清單。
fn run_send_engine_once(started_ms: i64) -> Value {
    let mut notes: Vec<String> = Vec::new();
    let mut changed = false;
    let mut entries = match helper_api::get_outbox() {
        Ok(v) => v.get("entries").and_then(|e| e.as_array()).cloned().unwrap_or_default(),
        Err(e) => return serde_json::json!({ "changed": false, "notes": [format!("待發清單讀不到: {e}")] }),
    };
    // 「現在真的讀不到」的聊天室: 只認 helper 的 blockingChats (即時活狀態判定, 見 helper
    // bot.decryptSummary)。2026-10-22 修復: 舊版拿歷史掃描的 issues 當暫停依據, 裡面混著
    // 舊世代不可復原的歷史訊息 — 群組明明即時可解可回, 待發卻被永久暫停、訊息發不出去。
    let mut failed_chats: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(st) = helper_api::get_status() {
        if let Some(arr) = st.get("bot").and_then(|b| b.get("decrypt")).and_then(|d| d.get("blockingChats")).and_then(|i| i.as_array()) {
            for i in arr {
                if let Some(id) = i.as_str() {
                    failed_chats.insert(id.to_string());
                }
            }
        }
    }
    // 自動恢復: 先前被鑰匙護欄暫停 (pauseReason=decrypt) 的待發, 群組已不在擋事清單就
    // 自動改回待發 (本地快照同步改, 這一輪就能接著評估送出)。人工暫停 (manual 或舊
    // 資料沒有 reason) 不自動動 — 那是使用者自己按的。
    for e in &mut entries {
        let id = e.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let chat_id = e.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
        let auto_resumable = e.get("status").and_then(|v| v.as_str()) == Some("paused")
            && e.get("pauseReason").and_then(|v| v.as_str()) == Some("decrypt")
            && !failed_chats.contains(chat_id);
        if auto_resumable && !id.is_empty() {
            if helper_api::pause_outbox(&id, false, "這個群組的訊息已恢復正常, 自動繼續發送", "").is_ok() {
                changed = true;
                notes.push(format!("待發 {id} 已自動恢復 (群組訊息恢復正常)"));
                if let Some(obj) = e.as_object_mut() {
                    obj.insert("status".into(), serde_json::json!("pending"));
                    obj.insert("pauseReason".into(), serde_json::json!(""));
                }
            }
        }
    }
    let joins = core_ws::recent_joins_snapshot();
    let now = pagesend::now_ms();
    let mut to_send: Vec<Value> = Vec::new();
    for e in &entries {
        let id = e.get("id").and_then(|v| v.as_str()).unwrap_or("");
        match pagesend::plan_entry(e, now, started_ms, &failed_chats, &joins) {
            pagesend::Plan::PauseDecrypt => {
                if helper_api::pause_outbox(id, true, "這個群組現在有訊息讀不到 (鑰匙對不上), 先暫停不發; 等訊息恢復正常會自動繼續, 也可以在待發清單按「恢復」", "decrypt").is_ok() {
                    changed = true;
                    notes.push(format!("待發 {id} 已暫停 (群組現在讀不到訊息)"));
                }
            }
            pagesend::Plan::SkipMissed => {
                if helper_api::skip_outbox(id, "程式沒開的時候錯過了這一次, 已跳過, 下一次照常").is_ok() {
                    changed = true;
                    notes.push(format!("待發 {id} 已跳過錯過的那一次"));
                }
            }
            pagesend::Plan::DeferUntil(until) => {
                if helper_api::defer_outbox(id, until, "有人剛進群組, 等鑰匙交接完成再發 (已自動順延)").is_ok() {
                    changed = true;
                    notes.push(format!("待發 {id} 已順延 (有人剛進群)"));
                }
            }
            pagesend::Plan::Send => to_send.push(e.clone()),
            pagesend::Plan::AwaitConfirm | pagesend::Plan::NotDue => {}
        }
    }
    // 有沒有待送的管理員通知 (決定要不要開連線)
    let has_notify = helper_api::get_admin_events().map(|v| v.get("pending").and_then(|p| p.as_array()).map(|a| !a.is_empty()).unwrap_or(false)).unwrap_or(false);
    let mut notify_error: Option<String> = None;
    if !to_send.is_empty() || has_notify {
        match pagesend::PageChannel::connect() {
            Ok(mut ch) => {
                // 管理員通知優先 (2026-10-22 修復): 舊版先送完所有排程待發才送通知,
                // 通知被排程壅塞拖慢, 體感像沒回應。改成連線一開先送通知。
                if has_notify {
                    let (sent_any, err) = send_admin_events(&mut ch);
                    changed = true; // 通知紀錄有更新, 順帶觸發畫面重讀
                    if !sent_any {
                        notify_error = err;
                    }
                }
                for e in &to_send {
                    let id = e.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let results = send_entry_items(&mut ch, e, None);
                    let ok_count = results.iter().filter(|r| r.get("ok").and_then(|b| b.as_bool()).unwrap_or(false)).count();
                    if helper_api::record_outbox_result(id, serde_json::json!(results), "").is_ok() {
                        changed = true;
                        notes.push(format!("待發 {id} 已送出 ({ok_count} 項成功)"));
                    }
                }
            }
            Err(e) => {
                notes.push(format!("這輪送不出: {e}"));
                if has_notify {
                    notify_error = Some(format!("管理員通知目前送不出去: {e}"));
                }
            }
        }
    }
    serde_json::json!({ "changed": changed, "notes": notes, "notifyError": notify_error })
}

/// 管理員通知快速路 (2026-10-22 修復): 每 5 秒檢查一次待送通知, 有待送才開連線送出,
/// 不跟 20 秒一輪的排程擠。舊版通知最壞要等滿 20 秒、再排在所有排程待發之後,
/// 老吳真機體感「呼叫管理員有點慢、甚至沒回應」。
fn run_notify_once() -> Value {
    let has_notify = helper_api::get_admin_events().map(|v| v.get("pending").and_then(|p| p.as_array()).map(|a| !a.is_empty()).unwrap_or(false)).unwrap_or(false);
    if !has_notify {
        return serde_json::json!({ "changed": false, "notes": [], "notifyError": null });
    }
    match pagesend::PageChannel::connect() {
        Ok(mut ch) => {
            let (sent_any, err) = send_admin_events(&mut ch);
            if sent_any {
                serde_json::json!({ "changed": true, "notes": ["管理員通知已送出"], "notifyError": null })
            } else {
                let msg = err.unwrap_or_else(|| "管理員通知目前送不出去".to_string());
                serde_json::json!({ "changed": true, "notes": [format!("管理員通知送出失敗: {msg}")], "notifyError": msg })
            }
        }
        Err(e) => {
            let msg = format!("管理員通知目前送不出去: {e}");
            serde_json::json!({ "changed": false, "notes": [msg.clone()], "notifyError": msg })
        }
    }
}

/// 本機時區對 UTC 的偏移秒數 (事件時間顯示用; 只在啟動時問一次作業系統)。
fn local_utc_offset_secs() -> i64 {
    #[cfg(windows)]
    {
        use std::sync::OnceLock;
        static CACHE: OnceLock<i64> = OnceLock::new();
        *CACHE.get_or_init(|| unsafe {
            use windows::Win32::System::Time::{GetTimeZoneInformation, TIME_ZONE_INFORMATION};
            let mut tzi = TIME_ZONE_INFORMATION::default();
            let rc = GetTimeZoneInformation(&mut tzi);
            let extra = match rc {
                2 => tzi.DaylightBias,
                1 => tzi.StandardBias,
                _ => 0,
            };
            -((tzi.Bias as i64) + (extra as i64)) * 60
        })
    }
    #[cfg(not(windows))]
    {
        0
    }
}

/// epoch 毫秒 -> 「M/D HH:MM」本機時間 (民用日期換算, 不引 chrono)。
fn fmt_event_time(ms: i64) -> String {
    if ms <= 0 {
        return "時間不明".to_string();
    }
    let secs = ms / 1000 + local_utc_offset_secs();
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (hh, mm) = (sod / 3600, (sod % 3600) / 60);
    // civil-from-days (Howard Hinnant 算法)
    let z = days + 719_468;
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{m}/{d} {hh:02}:{mm:02}")
}

/// 檔案大小白話 (B/KB/MB)
fn fmt_size(n: u64) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1}MB", n as f64 / 1_048_576.0)
    } else if n >= 1024 {
        format!("{:.0}KB", n as f64 / 1024.0)
    } else {
        format!("{n}B")
    }
}

/// 標準 base64 編碼 (教材庫上傳用; 相依不為這點小事再加一個 crate)
fn b64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 貼上截圖: 從剪貼簿取圖片存成暫存 PNG, 回傳可加入圖片清單的選取。
fn paste_clipboard_image() -> Result<SendMediaSel, String> {
    let mut cb = arboard::Clipboard::new().map_err(|_| "打不開剪貼簿, 請再試一次".to_string())?;
    let img = cb.get_image().map_err(|_| "剪貼簿裡沒有圖片: 先複製一張圖片或截圖, 再按「貼上截圖」".to_string())?;
    let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned()).ok_or("剪貼簿裡的圖片尺寸不正確")?;
    let path = std::env::temp_dir().join(format!("aibao-paste-{}.png", pagesend::now_ms()));
    rgba.save(&path).map_err(|e| format!("貼上的圖片存不下來: {e}"))?;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(SendMediaSel { name: "貼上的截圖.png".to_string(), size, ref_path: path.to_string_lossy().to_string() })
}

/// 副行文字: 已解析 → 「類型・N 人」; 名稱未解析 → 「名稱與資料待讀取」。
/// 待發清單/發送紀錄的狀態白話 (畫面不出現英文代號; 原始 status 只在 helper 存檔裡)
fn outbox_status_label(e: &Value) -> String {
    if e.get("overdue").and_then(|v| v.as_bool()).unwrap_or(false) {
        return "已過期, 等你確認要不要補發".to_string();
    }
    match e.get("status").and_then(|s| s.as_str()) {
        Some("pending") => "等待發送".to_string(),
        Some("paused") => "已暫停".to_string(),
        Some("sent") => "已送出".to_string(),
        Some("done") => "已全部發完".to_string(),
        Some("partial") => "部分送出 (失敗的可以重送)".to_string(),
        Some("failed") => "送出失敗".to_string(),
        Some("cancelled") => "已取消".to_string(),
        _ => "處理中".to_string(),
    }
}

fn chat_sub_text(kind: Option<&str>, member_count: Option<i64>, resolved: bool) -> String {
    if !resolved {
        return "名稱與資料待讀取".to_string();
    }
    let k = chat_kind_label(kind.unwrap_or(""));
    match member_count {
        Some(n) => format!("{k}・{n} 人"),
        None => k.to_string(),
    }
}

/// 主行名稱: 有名稱就用名稱, 缺失或保底字樣一律顯示「未命名群組」 (不退回顯示 ID)。
fn chat_display_name(name: Option<&str>, resolved: bool) -> String {
    let n = name.unwrap_or("");
    if resolved && !n.is_empty() && n != "(未命名)" {
        n.to_string()
    } else {
        "未命名群組".to_string()
    }
}

fn chat_list_row(ui: &mut egui::Ui, name: &str, sub: &str, action: impl FnOnce(&mut egui::Ui)) {
    // 版面: 整列用右到左配置 — 動作按鈕先靠右固定, 左側剩餘空間放名稱 (主行) 與
    // 類型/人數 (副行小字)。先前用 allocate_ui_with_layout 切左右兩塊的寫法實測會
    // 把名稱擠掉、按鈕位置逐列漂移 (2026-10-21 本機截圖), 改用這個 egui 慣用式。
    // 名稱不用 RichText::strong(): 本 App 主題把「啟用中」文字色設為白色 (給深色
    // 按鈕用), 而 egui 的 strong 文字色正是取自該值 — 沒另外指定顏色時 strong
    // 標籤會變成白字、在淺色卡片上看不見 (同卡的步驟標題也因此改用 size 強調)。
    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
        action(ui);
        ui.with_layout(egui::Layout::left_to_right(egui::Align::Center), |ui| {
            ui.vertical(|ui| {
                ui.label(egui::RichText::new(name).size(15.0));
                ui.label(egui::RichText::new(sub).weak().small());
            });
        });
    });
    ui.separator();
}

/// 清單列右側的動作按鈕: 固定最小尺寸, 讓各列按鈕大小一致、水平對齊。
fn chat_action_btn(ui: &mut egui::Ui, label: &str, enabled: bool) -> egui::Response {
    ui.add_enabled(
        enabled,
        egui::Button::new(label).min_size(egui::vec2(96.0, 26.0)),
    )
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
        self.send_engine_tick(ctx);
        self.sync_account_avatar(ctx);

        // 第二實例/系統匣喚醒與結束訊號
        while let Ok(sig) = self.signals.try_recv() {
            match sig {
                AppSignal::ShowWindow => {
                    shell::log_line("收到第二實例通知: 顯示主視窗");
                    self.show_window(ctx);
                }
                AppSignal::QuitApp => {
                    // --quit 是明確指令 (自動化/支援用), 直接進結束序列, 不再跳確認框;
                    // 介面上的結束按鈕 (視窗/系統匣) 仍一律先跳確認框 (規格書 v3 第 7 節)。
                    shell::log_line("收到第二實例通知: 結束指令 (--quit)");
                    self.begin_quit(ctx, "第二實例 --quit 指令");
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

        // 嵌入聊天畫面的顯示總開關: 不在「聊天室畫面」頁與「總覽」頁、引擎未就緒、
        // 任一確認框開啟中、或視窗已縮到系統匣時, 一律先隱藏 WebView。原生子視窗永遠
        // 畫在程式表面之上, 不先藏好就會殘留在別的頁面、或蓋住「確認結束」這類程式
        // 自己的對話框。(在本頁且條件符合時, page_chat / page_overview 會在同一幀
        // 把它顯示回來; 兩頁共用同一個 WebView, 每次只顯示在當前頁的框裡。)
        if (self.page != Page::ChatRoom && self.page != Page::Overview)
            || self.hidden
            || self.engine_unavailable()
            || self.confirm_quit
            || self.confirm_logout
            || self.show_tray_hint
            || self.quitting
        {
            self.chatview.force_hide();
        }

        if self.page != Page::ChatRoom {
            self.chat_log_last_page = Some(self.page);
        }
        if self.page != Page::Overview {
            self.overview_last_page = Some(self.page);
            self.login_after_engine = false;
        }
        egui::CentralPanel::default().show(ui, |ui| {
            egui::ScrollArea::vertical().show(ui, |ui| match self.page {
                Page::Overview => self.page_overview(ui),
                Page::ChatRoom => self.page_chat(ui),
                Page::ChatManage => self.page_manage(ui),
                Page::SendMessages => self.page_send(ui),
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
                            self.begin_quit(ctx, "結束確認框按鈕");
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
                        shell::log_line("系統匣選單事件: 開啟主視窗");
                        self.show_window(ctx);
                    } else if ev.id == tray.restart_id {
                        shell::log_line("系統匣選單事件: 重新啟動引擎");
                        self.restart_engine("系統匣選單「重新啟動引擎」");
                    } else if ev.id == tray.quit_id {
                        shell::log_line("系統匣選單事件: 結束服務並關閉程式 (跳確認框)");
                        self.show_window(ctx);
                        self.confirm_quit = true;
                    } else {
                        // 未匹配的選單事件也要留紀錄: 2026-10-22 循環事故時無法分辨
                        // 觸發源是按鈕、系統匣還是事件重複投遞, 就是因為全程沒有這行。
                        let unmatched_id = ev.id.clone();
                        shell::log_line(&format!("系統匣選單事件: 未匹配的項目 (id={unmatched_id:?})"));
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

// 60 秒視窗上限 (修復版7): 從設定 JSON 讀出兩個數字; 舊存檔沒有這兩個欄位時用出廠預設 (3 / 10)。
// 0 是合法值 (表示不限制), 不可用「讀不到或 0 就回預設」的寫法蓋掉使用者的設定。
fn rate_limits_from_settings(v: &Value) -> (u32, u32) {
    (
        v.get("perUserChatMinuteLimit").and_then(|x| x.as_u64()).unwrap_or(3) as u32,
        v.get("allChatsMinuteLimit").and_then(|x| x.as_u64()).unwrap_or(10) as u32,
    )
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
        let (puc, acm) = rate_limits_from_settings(v);
        f.per_user_chat_minute = puc;
        f.all_chats_minute = acm;
        f.ai_active = v.get("ai").and_then(|a| a.get("active")).and_then(|x| x.as_str()).unwrap_or("openai").to_string();
        f.ai_role = v
            .get("ai")
            .and_then(|a| a.get("rolePrompt"))
            .and_then(|x| x.as_str())
            .unwrap_or(DEFAULT_ROLE_PROMPT)
            .to_string();
        f.ai_scope = v
            .get("ai")
            .and_then(|a| a.get("scopePrompt"))
            .and_then(|x| x.as_str())
            .unwrap_or(DEFAULT_SCOPE_PROMPT)
            .to_string();
        // 分群設定跟著同一條載入路徑進表單, 並留一份原貌快照供儲存時比對增刪改。
        f.chat_profiles.clear();
        f.chat_profiles_orig.clear();
        if let Some(profiles) = v.get("ai").and_then(|a| a.get("chatProfiles")).and_then(|x| x.as_object()) {
            for (chat_id, pv) in profiles {
                let form = ChatProfileForm::from_value(pv);
                f.chat_profiles.insert(chat_id.clone(), form.clone());
                f.chat_profiles_orig.insert(chat_id.clone(), form);
            }
        }
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
        // Jev 金鑰比照 AI 供應商 Key 的遮罩檢視: 只拿「已設定/末 4 碼」, 明文不進表單
        f.jev_key_configured = scam.get("jev").and_then(|j| j.get("set")).and_then(|x| x.as_bool()).unwrap_or(false);
        f.jev_key_last4 = scam
            .get("jev")
            .and_then(|j| j.get("last4"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        f.jev_key_input.clear();
        f.jev_key_clear = false;
        f.kb_folder = v.get("kb").and_then(|k| k.get("folder")).and_then(|x| x.as_str()).unwrap_or("").to_string();
        f.show_sources = v.get("showSources").and_then(|x| x.as_bool()).unwrap_or(false);
        // creatorReply 不再讀取 (見 SettingsForm 欄位註解): 舊存檔殘留值直接忽略。
        let persona = v.get("persona").cloned().unwrap_or(Value::Null);
        let pstr = |k: &str| persona.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        f.persona_birthdate = pstr("birthdate");
        f.persona_gender = pstr("gender");
        f.persona_zodiac = pstr("zodiac");
        f.persona_measurements = pstr("measurements");
        f.persona_interests = pstr("interests");
        f.persona_marital = pstr("maritalStatus");
        f.persona_intro = pstr("intro");
        let notify = v.get("notify").cloned().unwrap_or(Value::Null);
        f.notify_admins = notify
            .get("admins")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| {
                        Some((
                            a.get("id")?.as_str()?.to_string(),
                            a.get("name")?.as_str()?.to_string(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        f.notify_rules = notify
            .get("rules")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|r| NotifyRuleForm {
                        kind: r.get("kind").and_then(|x| x.as_str()).unwrap_or("scam").to_string(),
                        keyword: r.get("keyword").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        enabled: r.get("enabled").and_then(|x| x.as_bool()).unwrap_or(true),
                        admin_ids: r
                            .get("notifyAdminIds")
                            .and_then(|x| x.as_array())
                            .map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
                            .unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default();
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
        // Jev 金鑰比照 AI 供應商 Key: 有輸入才帶 apiKey; 按了「清除金鑰」送 __clear__ 讓 helper 刪機密
        let mut jev_body = serde_json::json!({ "enabled": f.jev_enabled, "model": f.jev_model });
        if f.jev_key_clear {
            jev_body["apiKey"] = Value::String("__clear__".to_string());
        } else if !f.jev_key_input.is_empty() {
            jev_body["apiKey"] = Value::String(f.jev_key_input.clone());
        }
        serde_json::json!({
            "botName": f.bot_name,
            "aliases": aliases,
            "triggerMode": f.trigger_mode,
            "cooldownSec": f.cooldown_sec,
            "dailyLimit": f.daily_limit,
            "perUserChatMinuteLimit": f.per_user_chat_minute,
            "allChatsMinuteLimit": f.all_chats_minute,
            "ai": { "active": f.ai_active, "providers": providers, "rolePrompt": f.ai_role, "scopePrompt": f.ai_scope },
            "scam": {
                "enabled": f.scam_enabled,
                "threshold": f.scam_threshold,
                "perMinute": f.scam_per_minute,
                "jev": jev_body
            },
            "kb": { "folder": f.kb_folder },
            "notify": {
                "admins": f.notify_admins.iter().map(|(id, name)| serde_json::json!({ "id": id, "name": name })).collect::<Vec<_>>(),
                "rules": f.notify_rules.iter().map(|r| serde_json::json!({
                    "kind": r.kind, "keyword": r.keyword, "enabled": r.enabled, "notifyAdminIds": r.admin_ids
                })).collect::<Vec<_>>()
            },
            "showSources": f.show_sources,
            // creatorReply 不再回寫 (見 SettingsForm 欄位註解)。
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
        // 存檔前檢查 (2026-10-22 修復): 「有人提到關鍵字」的規則沒填關鍵字 = 永遠不會
        // 通知, 舊版靜靜存下去, 使用者以為有設好。直接擋下並講清楚哪一筆要補。
        if self.form.notify_rules.iter().any(|r| r.enabled && r.kind == "keyword" && r.keyword.trim().is_empty()) {
            self.form.save_msg = Some("有一筆「有人提到關鍵字」的通知還沒填關鍵字, 這一筆不會通知任何人。請先把關鍵字填好再儲存。".to_string());
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

    /// 「儲存聊天室設定」: 只送有變更的聊天室組成的補丁 (完整物件或 null), 走既有 PUT /api/settings。
    /// 成功後的新原貌先存進 chat_profiles_pending, 等 poll 收到成功回應才套用。
    fn save_chat_profiles(&mut self, ctx: &egui::Context) {
        if self.busy.get("chat_profiles").copied().unwrap_or(false) {
            return;
        }
        let patch = chat_profiles_patch(&self.form.chat_profiles, &self.form.chat_profiles_orig);
        if patch.is_empty() {
            self.chat_profiles_msg = Some("聊天室設定沒有變更, 不需要儲存。".to_string());
            return;
        }
        let new_orig = chat_profiles_new_orig(&self.form.chat_profiles, &self.form.chat_profiles_orig, &patch);
        let body = serde_json::json!({ "ai": { "chatProfiles": Value::Object(patch) } });
        self.spawn_chat_profiles_put(ctx, body, new_orig, Vec::new());
    }

    /// 捨棄一份已停用的聊天室設定: 立刻送該聊天室 null 刪除條目, 成功後重讀設定狀態。
    fn delete_orphan_chat_profile(&mut self, ctx: &egui::Context, chat_id: String) {
        if self.busy.get("chat_profiles").copied().unwrap_or(false) {
            return;
        }
        let mut patch = serde_json::Map::new();
        patch.insert(chat_id.clone(), Value::Null);
        let mut new_orig = self.form.chat_profiles_orig.clone();
        new_orig.remove(&chat_id);
        let body = serde_json::json!({ "ai": { "chatProfiles": Value::Object(patch) } });
        self.spawn_chat_profiles_put(ctx, body, new_orig, vec![chat_id]);
    }

    /// 分群設定補丁的共用送出通道 (儲存與孤兒刪除共用 busy 鎖與結果 slot, 同一時間只送一筆)。
    fn spawn_chat_profiles_put(
        &mut self,
        ctx: &egui::Context,
        body: Value,
        new_orig: HashMap<String, ChatProfileForm>,
        remove_form_ids: Vec<String>,
    ) {
        self.busy.insert("chat_profiles".into(), true);
        self.chat_profiles_msg = None;
        self.chat_profiles_pending = Some((new_orig, remove_form_ids));
        let slot = self.chat_profiles_slot.clone();
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

    /// 白名單移除成功後的連動: 該群若有自訂設定, 追加送 { suspended: true } 只改停用欄位,
    /// 設定保留不刪 (日後重新加入時在展開編輯區提示恢復)。結果進 chat_suspend_slot 由 poll 收。
    fn spawn_suspend_chat_profile(&mut self, ctx: &egui::Context, chat_id: String) {
        if self.busy.get("chat_profiles").copied().unwrap_or(false) {
            // 儲存/刪除進行中就先記 log; 原貌快照裡仍留著這筆, 使用者下次在聊天室管理頁按儲存前
            // 狀態顯示會是未停用 — 但同一時間只會有一種寫入, 不冒險併發送第二筆。
            shell::log_line(&format!("分群設定停用暫緩 (chatId={chat_id}): 已有分群設定儲存進行中"));
            return;
        }
        self.busy.insert("chat_profiles".into(), true);
        self.chat_suspend_id = Some(chat_id.clone());
        let body = serde_json::json!({ "ai": { "chatProfiles": { chat_id: { "suspended": true } } } });
        let slot = self.chat_suspend_slot.clone();
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
        // 待發清單載入結果
        if let Some(v) = self.outbox_slot.lock().unwrap().take() {
            self.busy.insert("outbox".into(), false);
            if let Some(arr) = v.get("entries").and_then(|x| x.as_array()) {
                self.outbox_entries = arr.clone();
            } else if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
                self.send_msg = Some(format!("待發清單讀不到: {m}"));
            }
        }
        // 待發建立/取消結果: 成功就重讀清單 (截圖結果是例外: 把截好的圖加入圖片清單)
        if let Some(v) = self.outbox_action_slot.lock().unwrap().take() {
            self.busy.insert("outbox_action".into(), false);
            if let Some(shot) = v.get("screenshot").and_then(|s| s.as_str()) {
                let size = std::fs::metadata(shot).map(|m| m.len()).unwrap_or(0);
                self.send_images.push(SendMediaSel { name: "截圖.png".to_string(), size, ref_path: shot.to_string() });
                self.send_msg = Some("截圖完成, 已加入圖片清單".to_string());
            } else if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
                self.send_msg = Some("已存進待發清單".to_string());
                self.outbox_attempted = false;
            } else {
                let m = v.get("message").and_then(|m| m.as_str()).unwrap_or("建立失敗");
                self.send_msg = Some(m.to_string());
            }
        }
        // 排程一輪的結果: 只記 log; 有異動就讓待發清單與通知紀錄在下一幀重讀
        if let Some(v) = self.send_tick_slot.lock().unwrap().take() {
            self.busy.insert("send_tick".into(), false);
            // 管理員通知的送出狀態: 有白話原因就顯示在通知紀錄卡上, 送通了就清除
            match v.get("notifyError") {
                Some(Value::String(s)) => self.notify_last_error = Some(s.clone()),
                Some(_) => self.notify_last_error = None,
                None => {}
            }
            if let Some(notes) = v.get("notes").and_then(|n| n.as_array()) {
                for n in notes {
                    if let Some(s) = n.as_str() {
                        shell::log_line(&format!("發送排程: {s}"));
                    }
                }
            }
            if v.get("changed").and_then(|c| c.as_bool()).unwrap_or(false) {
                self.outbox_attempted = false;
                self.admin_events_attempted = false;
            }
        }
        // 教材庫載入結果
        if let Some(v) = self.materials_slot.lock().unwrap().take() {
            self.busy.insert("materials".into(), false);
            if let Some(arr) = v.get("materials").and_then(|x| x.as_array()) {
                self.materials = arr.clone();
            }
        }
        // 聊天室管理頁的本室管理員候選名單結果 (形狀與全域候選相同: candidates 陣列, 也相容直接陣列)
        if let Some(v) = self.manage_candidates_slot.lock().unwrap().take() {
            self.busy.insert("manage_candidates".into(), false);
            if let Some(arr) = v.get("candidates").and_then(|x| x.as_array()) {
                self.manage_candidates = arr.clone();
            } else if let Some(arr) = v.as_array() {
                self.manage_candidates = arr.clone();
            } else if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
                self.page_msg.insert("manage_candidates".into(), format!("本聊天室候選名單讀不到: {m}"));
            }
        }
        // 管理員候選名單結果
        if let Some(v) = self.candidates_slot.lock().unwrap().take() {
            self.busy.insert("candidates".into(), false);
            if let Some(arr) = v.get("candidates").and_then(|x| x.as_array()) {
                self.candidates = arr.clone();
            } else if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
                self.page_msg.insert("candidates".into(), format!("候選名單讀不到: {m}"));
            }
        }
        // 管理員通知事件紀錄結果
        if let Some(v) = self.admin_events_slot.lock().unwrap().take() {
            self.busy.insert("admin_events".into(), false);
            if let Some(arr) = v.get("events").and_then(|x| x.as_array()) {
                self.admin_events = arr.clone();
            }
        }
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
            self.form.jev_key_input.clear();
            self.form.jev_key_clear = false;
        }
        // 分群設定儲存/刪除結果: 成功才套用新原貌快照; 孤兒刪除還要把表單條目移除並重讀設定狀態。
        if let Some(v) = self.chat_profiles_slot.lock().unwrap().take() {
            self.busy.insert("chat_profiles".into(), false);
            let pending = self.chat_profiles_pending.take();
            if v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) {
                let is_orphan_delete = pending.as_ref().map(|(_, ids)| !ids.is_empty()).unwrap_or(false);
                if let Some((new_orig, remove_ids)) = pending {
                    self.form.chat_profiles_orig = new_orig;
                    for id in &remove_ids {
                        self.form.chat_profiles.remove(id);
                    }
                }
                self.chat_profiles_msg = Some("已儲存，馬上生效".to_string());
                if is_orphan_delete {
                    // 照定案重讀設定狀態: 清掉 poller 快取, 下一輪會把最新設定整份抓回來填表單。
                    self.snap.lock().unwrap().settings = None;
                    self.form_needs_load = true;
                }
            } else {
                let m = v.get("message").and_then(|m| m.as_str()).unwrap_or("儲存失敗, 請稍後再試一次");
                self.chat_profiles_msg = Some(format!("聊天室設定沒有存成功: {m}"));
            }
        }
        // 白名單移除連動的停用結果: 成功才把本地狀態同步標成停用中。
        if let Some(v) = self.chat_suspend_slot.lock().unwrap().take() {
            self.busy.insert("chat_profiles".into(), false);
            let chat_id = self.chat_suspend_id.take().unwrap_or_default();
            if v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false) {
                if let Some(f) = self.form.chat_profiles.get_mut(&chat_id) {
                    f.suspended = true;
                }
                if let Some(f) = self.form.chat_profiles_orig.get_mut(&chat_id) {
                    f.suspended = true;
                }
                shell::log_line(&format!("分群設定已停用保留 (chatId={chat_id}): 群組移出白名單"));
            } else {
                let m = v.get("message").and_then(|m| m.as_str()).unwrap_or("停用失敗");
                self.chat_profiles_msg = Some(format!("群組已移出白名單, 但這個群的自訂設定停用沒有成功: {m}"));
                shell::log_line(&format!("分群設定停用失敗 (chatId={chat_id}): {m}"));
            }
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
            // 移除白名單連動 (定案: 保留但停用): 移除成功且該群有自訂設定時,
            // 追加一筆只改 suspended 的補丁; 加入白名單不走這條 (pending_remove_chat 只有移除時才有值)。
            if let Some(removed_id) = self.pending_remove_chat.take() {
                if v.get("ok").and_then(|o| o.as_bool()).unwrap_or(false)
                    && self.form.chat_profiles_orig.contains_key(&removed_id)
                {
                    self.spawn_suspend_chat_profile(ctx, removed_id);
                }
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
        // Log: 讀不到內容時顯示白話說明, 絕不靜默空白 (2026-10-22 事故修復:
        // 舊版失敗時 slot 是 {}, 這裡就把 logs_text 設成空字串, 畫面一片空白)。
        if let Some(v) = self.logs_slot.lock().unwrap().take() {
            self.busy.insert("logs".into(), false);
            let tail = v.get("tail").and_then(|t| t.as_str()).unwrap_or("");
            self.logs_text = if tail.trim().is_empty() {
                "這次沒有讀到紀錄內容。請按「重新讀取」再試一次; 如果一直讀不到, 請按「匯出診斷包」把檔案給維護人員看。".to_string()
            } else {
                tail.to_string()
            };
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
        self.pending_remove_chat = None;
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
        // 記住正在移除哪個群: poll 收到成功後要連動把該群的自訂設定停用保留。
        self.pending_remove_chat = Some(chat_id.clone());
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
        // 總覽服務列「登入 QR 碼」先啟動引擎的後續: 引擎就緒、且尚未進入登入流程時
        // 自動送一次登入 (登入碼出現在上方登入區, 使用者不用再按一次)。
        if self.login_after_engine
            && matches!(self.engine_snap.state, EngineState::Running | EngineState::ExternalRunning)
            && !matches!(login.auth, AuthState::Ready | AuthState::Authenticating | AuthState::Restoring)
        {
            let _ = self.login_tx.send(WsCommand::StartLogin);
            self.login_after_engine = false;
            shell::log_line("引擎就緒後自動送出登入 (總覽頁「登入 QR 碼」按鈕先啟動引擎)");
        }
        ui.heading("總覽");
        ui.add_space(8.0);
        // 登入區在最上方 (修復版6: 原 LINE 登入頁併入總覽, 第一眼就能看到登入狀態與按鈕)
        self.login_section(ui);
        ui.add_space(10.0);
        // 目前情況 (2026-10-24 老吳: 情況區最上方要有一列白話提示, 配處置按鈕,
        // 不要只顯示一句話讓人自己找路。判定與優先順序見 current_situation。)
        {
            let bot = status.as_ref().and_then(|s| s.get("bot")).cloned().unwrap_or(Value::Null);
            let bot_connected = bot
                .get("botConnected")
                .and_then(|v| v.as_bool())
                .or_else(|| bot.get("connected").and_then(|v| v.as_bool()));
            let decrypt_blocking: u64 = bot
                .get("decrypt")
                .and_then(|d| d.get("issues"))
                .and_then(|v| v.as_array())
                .map(|issues| {
                    issues
                        .iter()
                        .filter(|i| i.get("blocking").and_then(|v| v.as_bool()).unwrap_or(false))
                        .map(|i| i.get("failed").and_then(|v| v.as_u64()).unwrap_or(0))
                        .sum()
                })
                .unwrap_or(0);
            let warned = bot.get("scam").and_then(|s| s.get("warnedToday")).and_then(|v| v.as_u64());
            let (text, action) =
                current_situation(&self.engine_snap.state, &login.auth, bot_connected, decrypt_blocking, warned);
            let ports_err = self.ports_msg.clone();
            card(ui, self.palette, "目前情況", |ui| {
                ui.label(&text);
                ui.add_space(4.0);
                match action {
                    SituationAction::StartEngine => {
                        if ui.button("去啟動").clicked() {
                            self.start_engine("總覽頁「目前情況」去啟動按鈕");
                        }
                    }
                    SituationAction::RestartEngine => {
                        if ui.button("重新啟動引擎").clicked() {
                            self.restart_engine("總覽頁「目前情況」重新啟動引擎按鈕");
                        }
                    }
                    SituationAction::StartLogin => {
                        if ui.button("去登入").clicked() {
                            let _ = self.login_tx.send(WsCommand::StartLogin);
                        }
                    }
                    SituationAction::SwitchPorts => {
                        if ui.button("改用空閒連接埠").clicked() {
                            match crate::engine::pick_free_port_pair() {
                                Some((core, helper)) => {
                                    crate::engine::set_runtime_ports(core, helper);
                                    self.shell_settings.core_port = Some(core);
                                    self.shell_settings.helper_port = Some(helper);
                                    self.shell_settings.save();
                                    shell::log_line(&format!(
                                        "連接埠已換到空閒連接埠: 核心 {core}、控制台 {helper}，正在重新啟動引擎"
                                    ));
                                    self.ports_msg = None;
                                    self.restart_engine("總覽頁「目前情況」改用空閒連接埠按鈕");
                                }
                                None => {
                                    self.ports_msg = Some(
                                        "3801～4000 區間找不到空閒連接埠，請先關掉其他佔用程式再按一次。"
                                            .to_string(),
                                    );
                                }
                            }
                        }
                        if let Some(m) = &ports_err {
                            ui.label(egui::RichText::new(m).color(self.palette.bad));
                        }
                    }
                    SituationAction::ViewLogs => {
                        if ui.button("看紀錄").clicked() {
                            self.page = Page::Logs;
                        }
                    }
                    SituationAction::None => {}
                }
            });
            ui.add_space(10.0);
        }
        // 機器人情況數字卡 (Codex 總覽同款資訊架構, 口徑沿用現有統計: 知識庫檔數、
        // 今日回答、今日防詐判讀、今日警告; 服務狀態卡裡重複的今日回答/防詐騙兩行
        // 隨之上移到這裡, 不再重複列。掃描數仍在「防詐騙」頁可查。)
        {
            let bot = status.as_ref().and_then(|s| s.get("bot")).cloned().unwrap_or(Value::Null);
            let kb_files = bot.get("kb").and_then(|k| k.get("files")).and_then(|v| v.as_u64());
            let answered = bot.get("answeredToday").and_then(|v| v.as_u64());
            let (checked, warned) = bot
                .get("scam")
                .map(|s| {
                    (
                        s.get("checkedToday").and_then(|v| v.as_u64()),
                        s.get("warnedToday").and_then(|v| v.as_u64()),
                    )
                })
                .unwrap_or((None, None));
            let num = |v: Option<u64>, unit: &str| {
                v.map(|n| format!("{n} {unit}")).unwrap_or_else(|| "—".to_string())
            };
            card(ui, self.palette, "機器人情況", |ui| {
                ui.horizontal_wrapped(|ui| {
                    for (n, label) in [
                        (num(kb_files, "檔"), "知識庫"),
                        (num(answered, "次"), "今日回答"),
                        (num(checked, "則"), "今日防詐判讀"),
                        (num(warned, "則"), "今日警告"),
                    ] {
                        ui.vertical(|ui| {
                            ui.label(egui::RichText::new(n).size(20.0).strong());
                            ui.label(egui::RichText::new(label).weak().small());
                        });
                        ui.add_space(24.0);
                    }
                });
            });
            ui.add_space(10.0);
        }
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
                                AuthState::Authenticating => "LINE: 登入中 (請看「總覽」頁)".to_string(),
                                AuthState::Restoring => "LINE: 正在恢復上次登入…".to_string(),
                                AuthState::Error => "LINE: 登入異常, 請到「總覽」頁處理".to_string(),
                                _ => "LINE: 尚未登入".to_string(),
                            });
                        }
                    });
                    // LINE 服務列按鈕 (2026-10-24 總覽 Codex 化: 啟動就做在情況區裡,
                    // 不用跳去別頁。登入 QR 碼只在未登入時顯示, 已登入不顯示以免誤觸重登;
                    // 引擎未跑時點登入 QR 碼先啟動引擎、就緒後自動送一次登入, 見 login_after_engine。)
                    ui.horizontal(|ui| {
                        let running = matches!(self.engine_snap.state, EngineState::Running | EngineState::ExternalRunning);
                        let starting = matches!(self.engine_snap.state, EngineState::Starting);
                        let failed = matches!(self.engine_snap.state, EngineState::Failed(_));
                        if ui.add_enabled(!running && !starting, egui::Button::new("啟動")).clicked() {
                            self.start_engine("總覽頁 LINE 服務列「啟動」按鈕");
                        }
                        if ui.add_enabled(running || failed, egui::Button::new("重新啟動")).clicked() {
                            self.restart_engine("總覽頁 LINE 服務列「重新啟動」按鈕");
                        }
                        if login.auth != AuthState::Ready {
                            if ui.add_enabled(!starting, egui::Button::new("登入 QR 碼")).clicked() {
                                if running {
                                    let _ = self.login_tx.send(WsCommand::StartLogin);
                                } else {
                                    self.login_after_engine = true;
                                    self.start_engine("總覽頁 LINE 服務列「登入 QR 碼」按鈕 (先啟動引擎)");
                                }
                            }
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
                    // 小幫手服務列按鈕 (與 LINE 列同款。注意: 我方核心與 helper 同屬一個引擎,
                    // 與 Codex 的雙行程不同, 所以這列的啟動/重新啟動接同一組引擎動作;
                    // 回報中會把這個差異講明, 不假裝是兩個獨立服務。)
                    ui.horizontal(|ui| {
                        let running = matches!(self.engine_snap.state, EngineState::Running | EngineState::ExternalRunning);
                        let starting = matches!(self.engine_snap.state, EngineState::Starting);
                        let failed = matches!(self.engine_snap.state, EngineState::Failed(_));
                        if ui.add_enabled(!running && !starting, egui::Button::new("啟動")).clicked() {
                            self.start_engine("總覽頁小幫手服務列「啟動」按鈕");
                        }
                        if ui.add_enabled(running || failed, egui::Button::new("重新啟動")).clicked() {
                            self.restart_engine("總覽頁小幫手服務列「重新啟動」按鈕");
                        }
                    });
                    if engine_ok {
                        if let Some(bot) = status.as_ref().and_then(|s| s.get("bot")) {
                        let ai = bot.get("aiActive").and_then(|v| v.as_str()).unwrap_or("-");
                        let model = bot.get("aiModel").and_then(|v| v.as_str()).unwrap_or("-");
                        ui.label(format!("使用中的 AI: {ai} / {model}"));
                        // 核心版本 (第 14 項): 來自核心 hello 影格的實際回報, 未連線時顯示「—」不猜
                        let core_ver = bot.get("coreVersion").and_then(|v| v.as_str()).unwrap_or("");
                        ui.label(if core_ver.is_empty() {
                            "核心 LINE.js: —".to_string()
                        } else {
                            format!("核心 LINE.js: v{core_ver}")
                        });
                        // 今日回答/防詐騙數字已上移到上方「機器人情況」數字卡, 這裡不再重複列。
                        // 訊息解密健康 (2026-10-21 第二段): 有解不開的訊息要老實點燈,
                        // 不讓「機器人已連線」的綠燈蓋住「其實讀不到訊息」(事故定案:
                        // 成員變動後鑰匙對不上, 訊息在核心解密失敗, 以前全綠看不出來)。
                        if let Some(dec) = bot.get("decrypt") {
                            if dec.get("state").and_then(|v| v.as_str()) == Some("failed") {
                                // 顯示分流 (2026-10-22 修復, 依真機診斷包定案): 「現在真的讀不到」
                                // (blocking, 即時訊息也解不開) 與「只有舊世代歷史訊息解不開、
                                // 目前收發正常」是兩回事 — 舊版混成一句「有 N 則讀不到」把整群
                                // 判死, 還連帶擋下發送。分開講, 只有 blocking 才給處置。
                                let issues = dec.get("issues").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                                let blocking: Vec<&Value> = issues.iter().filter(|i| i.get("blocking").and_then(|v| v.as_bool()).unwrap_or(false)).collect();
                                let history_only: Vec<&Value> = issues.iter().filter(|i| !i.get("blocking").and_then(|v| v.as_bool()).unwrap_or(false)).collect();
                                if !blocking.is_empty() {
                                    let total: u64 = blocking.iter().map(|i| i.get("failed").and_then(|v| v.as_u64()).unwrap_or(0)).sum();
                                    ui.label(egui::RichText::new(format!("⚠ 有 {total} 則訊息我現在讀不到, 那些訊息我不會回覆:")).color(self.palette.bad));
                                    for issue in &blocking {
                                        let name = issue.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                        let failed = issue.get("failed").and_then(|v| v.as_u64()).unwrap_or(0);
                                        let senders: Vec<&str> = issue.get("senders").and_then(|v| v.as_array())
                                            .map(|a| a.iter().filter_map(|s| s.as_str()).collect())
                                            .unwrap_or_default();
                                        let who = if senders.is_empty() { String::new() } else { format!("({} 的)", senders.join("、")) };
                                        ui.label(format!("・在『{}』有 {} 則{}訊息讀不到", if name.is_empty() { "未命名群組" } else { name }, failed, who));
                                    }
                                    ui.label("處置: 先到「總覽」頁登出後重新登入 (讓鑰匙重新對齊); 若還是讀不到, 下一步是把機器人移出該群組、再重新邀請它加入 (重新入群會讓 LINE 把目前的鑰匙重新發一份給它)。");
                                }
                                for issue in &history_only {
                                    let name = issue.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                    let failed = issue.get("failed").and_then(|v| v.as_u64()).unwrap_or(0);
                                    ui.label(egui::RichText::new(format!(
                                        "『{}』目前收發正常; 有 {} 則舊訊息因為先前的鑰匙事故無法讀取 (不影響現在的訊息, 那些舊訊息我不會回覆)。",
                                        if name.is_empty() { "未命名群組" } else { name }, failed
                                    )).color(self.palette.warn));
                                }
                            }
                            // 訊息漏接 (同批追加): 訊息有進群組歷史、卻完全沒有送到機器人這裡 —
                            // 最壞情形是整個群組都收不到 (事故擴大時的現況), 文案要講到這個程度,
                            // 不能只寫「有幾則漏接」讓人以為只是小毛病。
                            if let Some(missed_issues) = dec.get("missedIssues").and_then(|v| v.as_array()) {
                                for issue in missed_issues {
                                    let name = issue.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                    let missed = issue.get("missed").and_then(|v| v.as_u64()).unwrap_or(0);
                                    let when = issue.get("newestMissedTime").and_then(|v| v.as_str()).unwrap_or("");
                                    ui.label(egui::RichText::new(format!(
                                        "⚠ 『{}』整個群組的訊息都沒有送到我這裡 (最近一則是 {} 的訊息, 已漏接 {} 則), 現在在那個群組叫我也不會回應。",
                                        if name.is_empty() { "未命名群組" } else { name }, when, missed
                                    )).color(self.palette.bad));
                                }
                                if !missed_issues.is_empty() {
                                    ui.label("處置: 先到「總覽」頁登出後重新登入; 若還是收不到, 把機器人移出該群組、再重新邀請它加入。");
                                }
                            }
                        }
                        } else {
                            ui.label(egui::RichText::new("設定服務尚未就緒, 請稍候…").weak());
                        }
                    }
                });
            });
            if matches!(self.engine_snap.state, EngineState::NotStarted) {
                ui.add_space(6.0);
                ui.label(egui::RichText::new("目前尚未啟用: 還沒有登入 LINE, 不會回應群組訊息。按下面的「登入並啟用」開始; 想讓它以後打開就自動登入, 到「程式設定」打開『開啟程式時自動登入並啟用服務』。").color(self.palette.warn));
            }
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                if matches!(self.engine_snap.state, EngineState::NotStarted) {
                    if primary_btn(ui, self.palette, "登入並啟用").clicked() {
                        self.start_engine("總覽頁「登入並啟用」按鈕");
                    }
                } else if ui.button("重新啟動引擎").clicked() {
                    self.restart_engine("總覽頁「重新啟動引擎」按鈕");
                }
                let repairing = self.busy.get("repair").copied().unwrap_or(false);
                if primary_btn(ui, self.palette, if repairing { "修復中…" } else { "一鍵修復" }).clicked() && !repairing {
                    self.start_repair(&ctx);
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
            #[cfg(windows)]
            if self.tray.is_none() {
                ui.label(egui::RichText::new("右下角系統匣圖示建立失敗 (原因已寫進程式紀錄): 要結束程式請用「程式設定」頁的『結束服務並關閉程式』, 並請把這行訊息回報給維護人員。").color(self.palette.warn));
            }
        });
        ui.add_space(10.0);
        // LINE 聊天畫面直接嵌在總覽下方 (Codex 總覽同款, 老吳 2026-10-24 定奪):
        // 與「聊天室畫面」頁共用同一個 WebView, 每次只顯示在當前頁的框裡;
        // 未登入時只顯示占位文字, 不重複出現第二個登入介面 (登入在上方登入區做)。
        // 進頁狀態紀錄與強制重排: 與聊天室畫面頁同一標準, 第一次進總覽就要畫出來,
        // 不必等使用者縮小再打開 (追蹤欄位與聊天室畫面頁分開記)。
        let force_chatview = std::env::var("AIBAO_CHATVIEW_FORCE").as_deref() == Ok("1");
        if self.overview_last_page != Some(Page::Overview) {
            let login0 = self.login_snapshot();
            shell::log_line(&format!(
                "總覽頁: 進入本頁, 登入狀態={:?}, WebView 已建立={}, 嵌入可用={}{}",
                login0.auth,
                self.chatview.is_created(),
                chatview::available(),
                if force_chatview { ", 強制嵌入模式 (CI)" } else { "" }
            ));
            self.overview_last_page = Some(Page::Overview);
            self.chatview.request_reveal();
        }
        ui.horizontal(|ui| {
            ui.label(egui::RichText::new("LINE 聊天畫面").strong());
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("重新載入聊天畫面").clicked() {
                    self.chatview.reset();
                }
            });
        });
        ui.add_space(4.0);
        let minimized = ui.ctx().input(|i| i.viewport().minimized) == Some(true);
        let want = Self::chatview_hidden_reason(self.hidden, minimized, self.confirm_quit, self.confirm_logout, self.show_tray_hint, self.quitting).is_none();
        let want_reason = Self::chatview_hidden_reason(self.hidden, minimized, self.confirm_quit, self.confirm_logout, self.show_tray_hint, self.quitting).unwrap_or("顯示中");
        let avail = ui.available_size();
        let (rect, _) = ui.allocate_exact_size(egui::vec2(avail.x, 520.0), egui::Sense::hover());
        ui.painter().rect_stroke(
            rect,
            egui::CornerRadius::same(10),
            egui::Stroke::new(1.0, self.palette.border),
            egui::StrokeKind::Inside,
        );
        if self.engine_unavailable() {
            ui.painter().text(
                rect.center(),
                egui::Align2::CENTER_CENTER,
                "引擎尚未就緒：請在上方服務狀態列按『啟動』或『一鍵修復』，引擎就緒後聊天會顯示在這裡。",
                egui::FontId::proportional(15.0),
                self.palette.warn_text,
            );
        } else if !matches!(login.auth, AuthState::Ready) && !force_chatview {
            ui.painter().text(
                rect.center(),
                egui::Align2::CENTER_CENTER,
                "請在上方啟動 LINE 服務；登入後聊天會顯示在這裡。",
                egui::FontId::proportional(15.0),
                self.palette.warn_text,
            );
        } else if chatview::available() {
            ui.label(egui::RichText::new(self.chatview.status_line(want, want_reason)).weak().small());
            let profile = self.webview_profile_dir.clone();
            let ppp = ui.ctx().pixels_per_point();
            self.chatview.sync(self.parent_hwnd, rect, ppp, want, want_reason, &profile);
            if let Some(err) = self.chatview.error() {
                let err = err.to_string();
                ui.painter().text(
                    rect.center(),
                    egui::Align2::CENTER_CENTER,
                    err,
                    egui::FontId::proportional(15.0),
                    self.palette.warn_text,
                );
            }
        } else {
            ui.painter().text(
                rect.center(),
                egui::Align2::CENTER_CENTER,
                "聊天畫面會在 Windows 版的 AI寶 裡顯示",
                egui::FontId::proportional(15.0),
                self.palette.warn_text,
            );
        }
        ui.add_space(4.0);
        if ui.button("去「聊天室畫面」頁看大畫面").clicked() {
            self.page = Page::ChatRoom;
        }
    }

    /// 總覽最上方的登入區 (修復版6: 原「LINE 登入」頁全部內容併入總覽)。
    /// 分區標題保留「LINE 登入」四字作為總覽內的分區名; 登入狀態機、按鈕行為與
    /// confirm_logout 對話框一律不改。尚未啟用與引擎未就緒時只顯示對應卡片,
    /// 不提早離開總覽 (下方服務狀態與聊天情況仍要顯示)。
    fn login_section(&mut self, ui: &mut egui::Ui) {
        ui.label(egui::RichText::new("LINE 登入").strong().size(17.0).color(self.palette.primary));
        ui.add_space(6.0);
        let login = self.login_snapshot();
        if matches!(self.engine_snap.state, EngineState::NotStarted) {
            card(ui, self.palette, "尚未啟用", |ui| {
                ui.label("程式還沒有啟用: 目前沒有登入 LINE, 也不會回應群組訊息。");
                ui.label("按下面的按鈕就會開始登入 (之前登入過的話會用保存的登入狀態自動恢復, 不用再掃一次 QR 碼)。");
                ui.add_space(6.0);
                if ui.button("登入並啟用").clicked() {
                    self.start_engine("總覽頁「登入並啟用」按鈕");
                }
                ui.add_space(6.0);
                ui.label(egui::RichText::new("想讓它每次打開程式就自動登入, 到「程式設定」打開『開啟程式時自動登入並啟用服務』。").weak());
            });
        } else if self.engine_unavailable() {
            card(ui, self.palette, "引擎尚未就緒", |ui| {
                ui.label(format!("目前引擎狀態: {}", self.engine_snap.label));
                ui.label("引擎還沒啟動完成, 登入功能要等引擎就緒才能使用。");
                if ui.button("重新啟動引擎").clicked() {
                    self.restart_engine("總覽頁「重新啟動引擎」按鈕");
                }
            });
        } else {
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
                    ui.add_space(6.0);
                    // 什麼情況需要登出重登 (2026-10-21 第二段): 事故時老吳只能重啟亂試,
                    // 把正解寫在登出按鈕旁邊, 以後不用再問人。
                    ui.label(egui::RichText::new("什麼時候需要登出再重新登入? 如果機器人突然讀不到某位同事的訊息 (例如群組有人加入或離開之後), 那是 LINE 換了讀訊息的鑰匙、跟這台電腦對不上。先按上面的「登出」, 再重新掃 QR 登入, 讓鑰匙重新對齊。若登出重登後還是讀不到, 下一步是把機器人移出該群組、再重新邀請它加入 — 重新入群會讓 LINE 把目前的鑰匙重新分發給它。重新啟動程式修不好這個問題。").weak());
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
        }
    }
    // 機器人聊天情況面板 (第 12 項): 登入卡片下方顯示機器人在群組的服務實況。
    // 資料來自 helper 的 GET /api/bot/activity (唯讀; 問題只留前 30 字且只在 helper 記憶體)。
    // 開頁立即抓、之後每約 4 秒自動刷新; 失敗顯示白話訊息, 不跳原始錯誤。
    // 2026-10-21 第 2 項: 已回答事件在問題行下方多一行回答預覽 (灰色小字, 約 40 字),
    // 點一下展開完整回答、再點收合; 未回答的事件 (冷卻/上限/忙線/引導) 不顯示回答區。
    // 退場 (2026-10-24 老吳親自定奪: 總覽改 Codex 式,「機器人聊天情況」活動清單卡拿掉,
    // 含修復版3 的群組篩選功能一併退場)。函式本體留置不刪, 以免後續整理誤傷;
    // 後端活動紀錄本身 (紀錄頁可查) 不受影響, 不要刪資料。若編譯因此出現 dead_code 警告,
    // 如實列入回報, 不在此加 allow 掩蓋; 是否整段移除由老吳裁示。
    fn activity_panel(&mut self, ui: &mut egui::Ui, logged_in: bool) {
        let ctx = ui.ctx().clone();
        {
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
                let chat_filter = self.activity_chat_filter.as_ref().map(|(id, _)| id.clone());
                std::thread::spawn(move || {
                    let r = helper_api::bot_activity(chat_filter.as_deref());
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
                let scanned = scam.get("scannedToday").and_then(|v| v.as_u64()).unwrap_or(0);
                let checked = scam.get("checkedToday").and_then(|v| v.as_u64()).unwrap_or(0);
                let warned = scam.get("warnedToday").and_then(|v| v.as_u64()).unwrap_or(0);
                // 修復版6後續修復: 舊版用不換行的 horizontal, 這列在 1024 寬視窗會被右邊緣裁掉
                // (真機: 「警告 0」後面的字被切)。改可換行, 太長就折到第二行, 不再裁字。
                ui.horizontal_wrapped(|ui| {
                    ui.label(status_dot(if bc { self.palette.ok } else { self.palette.warn }));
                    ui.label(if bc { "機器人已連線" } else { "機器人未連線" });
                    ui.separator();
                    ui.label(format!("AI: {ai} / {model}"));
                    ui.separator();
                    ui.label(format!("今日已回答 {answered} / 上限 {limit}"));
                    ui.separator();
                    ui.label(format!("防詐騙: 掃描 {scanned}、判讀 {checked}、警告 {warned}"));
                });
            } else if self.activity_msg.is_none() {
                ui.label("正在讀取聊天情況…");
            }
            if let Some(m) = &self.activity_msg {
                ui.label(egui::RichText::new(m.clone()).color(self.palette.warn_text));
            }
            // 群組篩選 (2026-10-23 老吳裁示): 純顯示層 — 篩選在 helper 端完成
            // (activityfilter.mjs), 這裡只給選單與標明計數口徑。選單清單取端點的
            // chats (未篩選的不重複群組); 舊版 helper 沒有 chats 時退回用手邊的
            // events 萃取 (篩選啟用時可能不完整, 僅相容兜底)。
            let events = act.as_ref().and_then(|a| a.get("events")).and_then(|v| v.as_array()).cloned().unwrap_or_default();
            let total = act.as_ref().and_then(|a| a.get("total")).and_then(|v| v.as_u64());
            let mut chat_options: Vec<(String, String)> = Vec::new();
            if let Some(chats) = act.as_ref().and_then(|a| a.get("chats")).and_then(|v| v.as_array()) {
                for c in chats {
                    let id = c.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
                    if id.is_empty() || chat_options.iter().any(|(x, _)| x == id) { continue; }
                    chat_options.push((id.to_string(), c.get("chatName").and_then(|v| v.as_str()).unwrap_or("").to_string()));
                }
            } else {
                for ev in &events {
                    let id = ev.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
                    if id.is_empty() || chat_options.iter().any(|(x, _)| x == id) { continue; }
                    chat_options.push((id.to_string(), ev.get("chatName").and_then(|v| v.as_str()).unwrap_or("").to_string()));
                }
            }
            if !chat_options.is_empty() || self.activity_chat_filter.is_some() {
                let selected_text = match &self.activity_chat_filter {
                    Some((id, name)) => activity_chat_label(id, name),
                    None => "全部群組".to_string(),
                };
                let mut picked: Option<Option<(String, String)>> = None;
                ui.horizontal(|ui| {
                    ui.label("顯示群組:");
                    egui::ComboBox::from_id_salt("activity-chat-filter")
                        .selected_text(selected_text)
                        .width(260.0)
                        .show_ui(ui, |ui| {
                            if ui.selectable_label(self.activity_chat_filter.is_none(), "全部群組").clicked() {
                                picked = Some(None);
                            }
                            for (id, name) in &chat_options {
                                let label = activity_chat_label(id, name);
                                let is_sel = self.activity_chat_filter.as_ref().map(|(x, _)| x == id).unwrap_or(false);
                                if ui.selectable_label(is_sel, label.clone()).clicked() {
                                    picked = Some(Some((id.clone(), name.clone())));
                                }
                            }
                        });
                });
                if let Some(p) = picked {
                    if p != self.activity_chat_filter {
                        self.activity_chat_filter = p;
                        // 換群組就丟掉舊清單重新抓, 不讓上一個群組的紀錄在新篩選下殘留一幀以上
                        self.activity = None;
                        self.activity_fetched_at = None;
                    }
                }
                if let Some((fid, name)) = &self.activity_chat_filter {
                    let shown = events.len();
                    let label = activity_chat_label(fid, name);
                    let count_txt = match total {
                        Some(t) => format!("只看「{label}」: 顯示 {shown} 筆 (全部共 {t} 筆)。"),
                        None => format!("只看「{label}」: 顯示 {shown} 筆。"),
                    };
                    ui.label(egui::RichText::new(count_txt).weak().small());
                    ui.label(egui::RichText::new("上面那排今日數字是全部群組的統計; 下面清單只顯示這個群組。").weak().small());
                }
            }
            ui.add_space(4.0);
            if events.is_empty() {
                if let Some((fid, name)) = &self.activity_chat_filter {
                    ui.label(egui::RichText::new(format!("「{}」目前還沒有紀錄: 紀錄只保留最近 50 筆, 較早的會被新的蓋掉; 也可以改選「全部群組」看其他群的情況。", activity_chat_label(fid, name))).weak());
                } else {
                    ui.label(egui::RichText::new("目前還沒有紀錄: 有人在群組跟機器人說話後, 這裡會逐筆出現。").weak());
                }
            } else {
                let max_h = ui.available_height().max(80.0);
                egui::ScrollArea::vertical().id_salt("activity-scroll").max_height(max_h).show(ui, |ui| {
                    for ev in &events {
                        let time = ev.get("time").and_then(|v| v.as_str()).unwrap_or("");
                        let kind = ev.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                        let (label, color) = match kind {
                            "answered" => ("已回答", self.palette.ok),
                            "chatty" => ("接話", self.palette.ok),
                            "chatty_pass" => ("選擇不接話", self.palette.idle),
                            "declined" => ("婉拒（範圍外）", self.palette.idle),
                            "clarify" => ("反問確認", self.palette.warn),
                            "name_only" => ("引導說明", self.palette.idle),
                            "cooldown" => ("冷卻略過", self.palette.warn),
                            "window_user" => ("問太密擋下", self.palette.warn),
                            "window_all" => ("全部群問太密擋下", self.palette.warn),
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
                        // 回答內容 (第 2 項): 只有已回答事件才有 answer; 預覽列可點開/收合,
                        // 展開狀態存 egui persisted data (以 時間|種類|提問者|問題 為鍵, 清單刷新不遺失;
                        // 不用 temp data — 它只有一幀生命週期, 展開狀態留不住, 實測點了沒反應)。
                        let answer = ev.get("answer").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
                        if let Some(ans) = answer {
                            let truncated = ev.get("answerTruncated").and_then(|v| v.as_bool()).unwrap_or(false);
                            let key = format!("{time}|{kind}|{sender}|{q}");
                            let ans_id = ui.id().with(("activity-answer", key.clone()));
                            let expanded = ui.ctx().data_mut(|d| d.get_persisted::<bool>(ans_id).unwrap_or(false));
                            let total = ans.chars().count();
                            let preview: String = ans.chars().take(40).collect();
                            let preview_text = if total > 40 {
                                format!("回答: {preview}… (點一下看全部)")
                            } else {
                                format!("回答: {preview}")
                            };
                            // 用無框按鈕當可點的預覽列: 外觀與小字標籤相同, 但點擊感應比 Label 可靠
                            // (Label + Sense::click 在巢狀 ScrollArea 實測點不到, 2026-10-21 本機截圖驗證)。
                            if ui
                                .add(egui::Button::new(egui::RichText::new(preview_text).weak().small()).frame(false))
                                .clicked()
                            {
                                ui.ctx().data_mut(|d| d.insert_persisted(ans_id, !expanded));
                            }
                            if expanded {
                                ui.label(egui::RichText::new(ans).small());
                                if truncated {
                                    ui.label(egui::RichText::new("(回答原文較長, 這裡只保存前 2000 字)").weak().small());
                                }
                            }
                        }
                    }
                });
            }
        }
    }

/// 聊天室畫面「目前不顯示」的原因 (白話, 檢查順序與 page_chat 的 want 條件一致)。
/// 回 None = 應該顯示。單元測試鎖定優先順序, 免得狀態行與實際條件脫鉤。
fn chatview_hidden_reason(hidden: bool, minimized: bool, confirm_quit: bool, confirm_logout: bool, show_tray_hint: bool, quitting: bool) -> Option<&'static str> {
    if hidden {
        Some("視窗目前縮到系統匣")
    } else if minimized {
        Some("視窗目前是最小化")
    } else if confirm_quit {
        Some("正在確認結束程式")
    } else if confirm_logout {
        Some("正在確認登出")
    } else if show_tray_hint {
        Some("正在顯示系統匣提示")
    } else if quitting {
        Some("正在結束程式")
    } else {
        None
    }
}

    // 「聊天室畫面」頁 (2026-10-21 老吳定案): 把核心的 LINE.js 聊天室網頁真嵌入內容區
    // (chatview.rs, Windows 版 WebView2 子視窗), 占滿標題下方剩餘空間。
    // 未登入或引擎未就緒只顯示白話占位、不載入頁面; 嵌入不可用的建置 (本機檢查版) 顯示占位說明。
    // 修復版6後續修復: 嵌入區上方常駐一行狀態 (已建立/還沒建立/原因), 不再是無訊息空白;
    // 另有「檢查核心網頁」自我檢查, 區分核心連不上與嵌入顯示問題。
    fn page_chat(&mut self, ui: &mut egui::Ui) {
        // 標題列: 右側放「重新載入聊天畫面」自救按鈕 (銷毀 WebView 後重新建立)
        // 與「檢查核心網頁」自我檢查 (修復版6後續修復): 直接對核心 3789 做一次 GET,
        // 區分「核心網頁連不上」與「核心網頁通、但嵌入顯示有問題」。
        ui.horizontal(|ui| {
            ui.heading("聊天室畫面");
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("重新載入聊天畫面").clicked() {
                    self.chatview.reset();
                }
                let checking = self.busy.get("chat_check").copied().unwrap_or(false);
                if ui.button(if checking { "檢查中…" } else { "檢查核心網頁" }).clicked() && !checking {
                    self.busy.insert("chat_check".into(), true);
                    self.chat_check_msg = None;
                    let slot = self.chat_check_slot.clone();
                    let ctx2 = ui.ctx().clone();
                    std::thread::spawn(move || {
                        let msg = match helper_api::core_page_check() {
                            Ok(200) => "檢查結果: 核心網頁連得通 (HTTP 200)。如果畫面還是空白, 問題在嵌入顯示這一層, 請到「紀錄」頁匯出診斷包傳給我看。".to_string(),
                            Ok(code) => format!("檢查結果: 核心網頁回應異常 (HTTP {code})。請先到「總覽」頁按「一鍵修復」重啟引擎, 再回來看。"),
                            Err(_) => "檢查結果: 連不上核心網頁。引擎可能還沒就緒或已停止, 請先到「總覽」頁按「一鍵修復」重啟引擎, 再回來看。".to_string(),
                        };
                        *slot.lock().unwrap() = Some(msg);
                        ctx2.request_repaint();
                    });
                }
            });
        });
        if let Some(m) = self.chat_check_slot.lock().unwrap().take() {
            self.busy.insert("chat_check".into(), false);
            self.chat_check_msg = Some(m);
        }
        if let Some(m) = &self.chat_check_msg {
            ui.label(egui::RichText::new(m.clone()).weak().small());
        }
        ui.add_space(8.0);
        // CI 強制嵌入 (CI 截圖驗證專用, 一般使用不設): AIBAO_CHATVIEW_FORCE=1 時略過登入完成門檻,
        // 直接走嵌入路徑 (引擎仍須就緒), 好在雲端截到 WebView 內的畫面; 未設時行為完全不變。
        let force_chatview = std::env::var("AIBAO_CHATVIEW_FORCE").as_deref() == Ok("1");
        // 進頁狀態紀錄: 進入本頁後第一次要 sync 前寫一行, 供日後診斷包定案空白問題;
        // 以 chat_log_last_page 記上次紀錄時的頁面, 避免每一幀刷 log。
        // 同時要求強制重排重顯: 把縮小再打開時觸發的那個重排動作變成進頁動作,
        // 第一次進頁就直接畫出來, 不必等使用者縮小再打開 (見 chatview.rs reveal 註解)。
        if self.chat_log_last_page != Some(Page::ChatRoom) {
            let login0 = self.login_snapshot();
            shell::log_line(&format!(
                "聊天室畫面頁: 進入本頁, 登入狀態={:?}, WebView 已建立={}, 嵌入可用={}{}",
                login0.auth,
                self.chatview.is_created(),
                chatview::available(),
                if force_chatview { ", 強制嵌入模式 (CI)" } else { "" }
            ));
            self.chat_log_last_page = Some(Page::ChatRoom);
            self.chatview.request_reveal();
        }
        if self.engine_unavailable() {
            self.chatview.force_hide();
            card(ui, self.palette, "引擎尚未就緒", |ui| {
                ui.label(format!("目前引擎狀態: {}", self.engine_snap.label));
                ui.label("引擎還沒啟動完成, 聊天畫面要等引擎就緒才能使用。");
                if ui.button("重新啟動引擎").clicked() {
                    self.restart_engine("聊天室頁「重新啟動引擎」按鈕");
                }
            });
            return;
        }
        let login = self.login_snapshot();
        if !matches!(login.auth, AuthState::Ready) && !force_chatview {
            self.chatview.force_hide();
            card(ui, self.palette, "聊天畫面", |ui| {
                ui.label("登入後這裡會顯示聊天畫面");
                ui.label(egui::RichText::new("請先到「總覽」頁完成登入, 用次要帳號掃 QR 碼完成登入。").weak());
            });
            return;
        }
        // 嵌入狀態行 (修復版6後續修復): 先算好顯示條件, 狀態行寫在框上方,
        // 再配額嵌入框 — 框裡空白時, 使用者至少看得到原因與下一步。
        let minimized = ui.ctx().input(|i| i.viewport().minimized) == Some(true);
        let want = Self::chatview_hidden_reason(self.hidden, minimized, self.confirm_quit, self.confirm_logout, self.show_tray_hint, self.quitting).is_none();
        let want_reason = Self::chatview_hidden_reason(self.hidden, minimized, self.confirm_quit, self.confirm_logout, self.show_tray_hint, self.quitting).unwrap_or("顯示中");
        if chatview::available() {
            ui.label(egui::RichText::new(self.chatview.status_line(want, want_reason)).weak().small());
            ui.add_space(4.0);
        }
        let avail = ui.available_size();
        let height = avail.y.max(140.0);
        let (rect, _) = ui.allocate_exact_size(egui::vec2(avail.x, height), egui::Sense::hover());
        ui.painter().rect_stroke(
            rect,
            egui::CornerRadius::same(10),
            egui::Stroke::new(1.0, self.palette.border),
            egui::StrokeKind::Inside,
        );
        if chatview::available() {
            let profile = self.webview_profile_dir.clone();
            let ppp = ui.ctx().pixels_per_point();
            self.chatview.sync(self.parent_hwnd, rect, ppp, want, want_reason, &profile);
            if let Some(err) = self.chatview.error() {
                let err = err.to_string();
                ui.painter().text(
                    rect.center(),
                    egui::Align2::CENTER_CENTER,
                    err,
                    egui::FontId::proportional(15.0),
                    self.palette.warn_text,
                );
            }
        } else {
            ui.painter().text(
                rect.center(),
                egui::Align2::CENTER_CENTER,
                "聊天畫面會在 Windows 版的 AI寶 裡顯示",
                egui::FontId::proportional(15.0),
                self.palette.idle,
            );
        }
    }

    fn page_ai(&mut self, ui: &mut egui::Ui) {
        ui.heading("AI 設定");
        ui.add_space(4.0);
        ui.label("選一家 AI 服務、貼上 API Key、抓模型清單選一個, 測試成功後按「儲存全部設定」。");
        ui.add_space(8.0);
        let ctx = ui.ctx().clone();
        // 第一張卡改為指路卡 (修復版6後續修復, 一份設定只有一個家):
        // 全域角色定位與回答範圍改到「聊天室管理」頁上方全域區改, 這裡不再放第二份可編輯欄位。
        // (欄位本身仍在表單裡, 由管理頁全域區編輯、走同一條 save_settings 儲存。)
        card(ui, self.palette, "機器人定位與範圍（全域的預設設定）", |ui| {
            ui.label("全域的角色定位與回答範圍改到「聊天室管理」頁最上方的全域區改, 這裡不再放第二份。");
            ui.label(egui::RichText::new("已有自己設定的聊天室不會用這份, 也不會和這份合併。").weak().small());
            if ui.button("去「聊天室管理」頁改全域設定").clicked() {
                self.page = Page::ChatManage;
            }
        });
        ui.add_space(10.0);
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
    /// 確保某聊天室在分群表單裡有一份草稿: 還沒有條目的聊天室先建一份跟著全域預設的草稿,
    /// 角色與範圍預填全域目前值, 之後切到本聊天室自訂時不用從空白重打。
    /// 條目要不要真的存起來, 由 ChatProfileForm::has_entry 與 chat_profiles_patch 決定 (共用邏輯, 只此一份)。
    fn ensure_chat_profile_draft(&mut self, chat_id: &str) {
        if !self.form.chat_profiles.contains_key(chat_id) {
            self.form.chat_profiles.insert(
                chat_id.to_string(),
                ChatProfileForm {
                    custom: false,
                    role: self.form.ai_role.clone(),
                    scope: self.form.ai_scope.clone(),
                    kb_enabled: true,
                    kb_folder: String::new(),
                    suspended: false,
                    chatty: false,
                    admins: Vec::new(),
                },
            );
        }
    }

    /// 聊天室管理頁的聊天室選項: 來源是白名單聊天室清單, 加上已有分群設定條目的聊天室;
    /// 顯示一律用名稱, 沒有名稱才用「未命名聊天室 (末 4 碼)」輔助區分, 不直接把編號給人看。
    fn manage_chat_options(&self) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        for c in &self.whitelist {
            let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if id.is_empty() || out.iter().any(|(x, _)| x == id) {
                continue;
            }
            let resolved = c.get("nameResolved").and_then(|v| v.as_bool()).unwrap_or(false);
            let name = if resolved { c.get("name").and_then(|v| v.as_str()).unwrap_or("") } else { "" };
            out.push((id.to_string(), activity_chat_label(id, name)));
        }
        let mut extra: Vec<String> = Vec::new();
        for id in self.form.chat_profiles_orig.keys().chain(self.form.chat_profiles.keys()) {
            if !out.iter().any(|(x, _)| x == id) && !extra.contains(id) {
                extra.push(id.clone());
            }
        }
        extra.sort();
        for id in extra {
            let known = self
                .group_chats
                .iter()
                .find(|c| c.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
                .and_then(|c| c.get("name").and_then(|v| v.as_str()))
                .unwrap_or("");
            out.push((id.clone(), activity_chat_label(&id, known)));
        }
        out
    }

    /// 管理員選人器要顯示的候選名單 (id, 名字, 來源): 平常就是 helper 讀回的近期發言者
    /// + 社群管理員。CI 逐頁截圖專用: AIBAO_MANAGE_CANDIDATE_COUNT=N 時, 在真實名單之外
    /// 補上假候選人 (先放該室已儲存的管理員、再以「截圖驗證成員NN」補到 N 位), 只影響畫面
    /// 顯示, 不寫回任何存檔、不參與儲存 (與 AIBAO_MANAGE_CHAT_ID、AIBAO_CHATVIEW_FORCE
    /// 同款 CI 專用環境變數, 一般使用不設)。假帳號皆為 u9 開頭的測試編號, 不是真實帳號。
    fn manage_display_candidates(&self, chat_id: &str) -> Vec<(String, String, String)> {
        let mut out: Vec<(String, String, String)> = Vec::new();
        for c in &self.manage_candidates {
            let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("");
            let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
            if id.is_empty() || name.is_empty() {
                continue;
            }
            let source = c.get("source").and_then(|v| v.as_str()).unwrap_or("").to_string();
            out.push((id.to_string(), name.to_string(), source));
        }
        if let Ok(n) = std::env::var("AIBAO_MANAGE_CANDIDATE_COUNT")
            .unwrap_or_default()
            .parse::<usize>()
        {
            if n > 0 {
                if let Some(saved) = self.form.chat_profiles_orig.get(chat_id) {
                    for (aid, aname) in &saved.admins {
                        if !out.iter().any(|(id, _, _)| id == aid) {
                            out.push((aid.clone(), aname.clone(), String::new()));
                        }
                    }
                }
                let mut i = 1usize;
                while out.len() < n {
                    let fid = format!("u9{i:031}");
                    if !out.iter().any(|(id, _, _)| id == &fid) {
                        out.push((fid, format!("截圖驗證成員{i:02}"), String::new()));
                    }
                    i += 1;
                }
            }
        }
        out
    }

    /// 背景讀取單一聊天室的管理員候選名單, 結果進 manage_candidates_slot 由 poll 收。
    fn spawn_manage_candidates_load(&mut self, ctx: &egui::Context, chat_id: String) {
        if self.busy.get("manage_candidates").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("manage_candidates".into(), true);
        let all = self.manage_candidates_all;
        self.manage_candidates_for = if all { format!("{chat_id}#all") } else { chat_id.clone() };
        let slot = self.manage_candidates_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let r = helper_api::admin_candidates_chat(&chat_id, all);
            *slot.lock().unwrap() = Some(match r {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    /// 已停用設定的「恢復使用」: 只送 suspended:false 的補丁, 其他欄位 (聒噪/管理員/知識庫等) 隨條目保留不動。
    fn restore_suspended_chat(&mut self, ctx: &egui::Context, chat_id: String) {
        if self.busy.get("chat_profiles").copied().unwrap_or(false) {
            return;
        }
        if let Some(f) = self.form.chat_profiles.get_mut(&chat_id) {
            f.suspended = false;
        }
        let mut new_orig = self.form.chat_profiles_orig.clone();
        if let Some(f) = new_orig.get_mut(&chat_id) {
            f.suspended = false;
        }
        let body = serde_json::json!({ "ai": { "chatProfiles": { chat_id.clone(): { "suspended": false } } } });
        self.spawn_chat_profiles_put(ctx, body, new_orig, Vec::new());
    }

    /// 聊天室清單每列的設定狀態摘要 (企業多群場景): 一眼看到這個群用哪套設定、聒噪、
    /// 管理員與知識庫狀態, 不用逐群點開。優先看編輯中的表單 (目前選定群的未儲存修改也算),
    /// 其次看已儲存原貌, 都沒有就是全域預設狀態。
    fn chat_profile_summary(&self, chat_id: &str) -> String {
        let f = self
            .form
            .chat_profiles
            .get(chat_id)
            .or_else(|| self.form.chat_profiles_orig.get(chat_id));
        match f {
            Some(f) => {
                let source = if f.suspended {
                    "已停用待確認"
                } else if f.custom {
                    "本聊天室自訂"
                } else {
                    "全域預設"
                };
                let chatty = if f.chatty { "聒噪開" } else { "聒噪關" };
                let admins = if f.admins.is_empty() {
                    "未設管理員".to_string()
                } else {
                    format!("管理員 {} 位", f.admins.len())
                };
                let kb = if f.kb_enabled { "知識庫開" } else { "知識庫關" };
                format!("{source}・{chatty}・{admins}・{kb}")
            }
            None => "全域預設・聒噪關・未設管理員・知識庫開".to_string(),
        }
    }

    /// 聊天室管理頁 (修復版6 新頁): 先選一個聊天室, 在同一頁改完這個聊天室的全部設定再儲存。
    /// 分群設定全 App 只在這一頁可以改; 全域預設在「AI 設定」頁, 這裡不重複提供。
    fn page_manage(&mut self, ui: &mut egui::Ui) {
        let ctx = ui.ctx().clone();
        if !self.wl_loaded && !self.wl_attempted && !self.busy.get("wl").copied().unwrap_or(false) {
            self.spawn_whitelist_load(&ctx);
        }
        let options = self.manage_chat_options();
        if options.is_empty() {
            ui.heading("聊天室管理");
            ui.add_space(8.0);
            card(ui, self.palette, "聊天室管理", |ui| {
                ui.label("目前還沒有可以管理的聊天室: 請先到「機器人與觸發」頁把群組加入白名單, 這裡就會列出來。");
                if let Some(m) = self.page_msg.get("wl") {
                    ui.label(m.clone());
                }
            });
            return;
        }
        // 預設選室: CI 逐頁截圖可用 AIBAO_MANAGE_CHAT_ID 指定先選哪個室
        // (切換前後對照截圖用, 一般使用不設); 沒指定或對不上時選第一個室。
        if self.manage_chat_id.is_empty() || !options.iter().any(|(id, _)| *id == self.manage_chat_id) {
            let forced = std::env::var("AIBAO_MANAGE_CHAT_ID").ok().unwrap_or_default();
            self.manage_chat_id = if options.iter().any(|(id, _)| *id == forced) {
                forced
            } else {
                options[0].0.clone()
            };
        }
        // CI 專用預設 (一個啟動只套用一次): AIBAO_MANAGE_PAGE (1 起算) 預設選人器頁碼、
        // AIBAO_MANAGE_SEARCH 預設選人器搜尋字, 供選人器分頁/搜尋截圖; 之後使用者點
        // 上一頁/下一頁或改搜尋字不再被環境變數蓋掉。
        if !self.manage_ci_prefill_done {
            self.manage_ci_prefill_done = true;
            if let Ok(p) = std::env::var("AIBAO_MANAGE_PAGE").unwrap_or_default().parse::<usize>() {
                if p >= 1 {
                    self.manage_admin_page = p - 1;
                }
            }
            let s = std::env::var("AIBAO_MANAGE_SEARCH").unwrap_or_default();
            if !s.is_empty() {
                self.manage_admin_search = s;
            }
        }
        // 頁面標題列: 右上角放一顆看得見的儲存鈕 (Codex 管理頁同款位置),
        // 存的與標題下方、表單最下方那兩顆是同一個動作 (存這個聊天室的設定)。
        ui.horizontal(|ui| {
            ui.heading("聊天室管理");
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                let saving_profiles = self.busy.get("chat_profiles").copied().unwrap_or(false);
                if primary_btn(ui, self.palette, if saving_profiles { "儲存中…" } else { "儲存這個聊天室的設定" }).clicked() && !saving_profiles {
                    self.save_chat_profiles(&ctx);
                }
            });
        });
        ui.add_space(8.0);
        // 三步指引 (老吳 2026-10-24: 原頁面看不出改完按哪裡儲存、改完去哪裡看效果)。
        // 第零步學 Codex 流程: 白名單先設好, 這裡才有室可以管 (白名單本身仍在
        // 「機器人與觸發」頁改, 這裡只指路, 不複製第二份可改的白名單)。
        card(ui, self.palette, "怎麼用這個頁面 (三步)", |ui| {
            ui.label("第零步 (先做一次就好): 到「機器人與觸發」頁把要管的群組加入白名單, 這裡才會列出來。");
            if ui.button("去「機器人與觸發」頁設白名單").clicked() {
                self.page = Page::BotSettings;
            }
            ui.label("第一步: 下面點一個聊天室的頁簽, 點哪個頁簽就是在設哪個聊天室。");
            ui.label("第二步: 改下面五區的設定 (角色、回答範圍、知識庫、管理員、聒噪)。");
            ui.label("第三步: 按「儲存這個聊天室的設定」 (頁面右上角、標題下面和表單最下面都有)。");
            ui.label("改完去哪裡看效果: 總覽頁上方的「機器人情況」數字會跟著變; 詳細的通知與回答紀錄在「紀錄」頁。");
        });
        ui.add_space(10.0);
        // 上方全域區 (老吳 2026-10-24 版面): 全域預設一處可改; 各室自己的設定在下方頁簽改。
        // 全域角色/範圍/知識庫資料夾原本散在「AI 設定」頁與「知識庫」頁, 現在起以這裡為主,
        // 那兩頁改為指到這裡的說明卡/說明頁 (一份設定只有一個家)。
        card(ui, self.palette, "全域設定 (所有聊天室沒自訂時都用這一份)", |ui| {
            ui.label(egui::RichText::new("這裡改的是「沒自訂的聊天室共用的預設」; 已經有自己設定的聊天室不會用這份, 也不會和這份合併。").weak().small());
            ui.label(egui::RichText::new("角色定位").strong());
            ui.add(egui::TextEdit::multiline(&mut self.form.ai_role).desired_rows(2).desired_width(f32::INFINITY));
            ui.label(egui::RichText::new("清空後儲存, 會自動回復成出廠預設的角色定位。").weak().small());
            ui.add_space(6.0);
            ui.label(egui::RichText::new("回答範圍").strong());
            ui.add(egui::TextEdit::multiline(&mut self.form.ai_scope).desired_rows(4).desired_width(f32::INFINITY));
            ui.label(egui::RichText::new("清空這個欄位 = 不限制範圍, 什麼問題都回答。").weak().small());
            ui.add_space(6.0);
            ui.label(egui::RichText::new("知識庫資料夾").strong());
            ui.horizontal(|ui| {
                ui.add(egui::TextEdit::singleline(&mut self.form.kb_folder).desired_width(420.0).hint_text("例如 D:\\公司文件\\知識庫"));
                if ui.button("選擇資料夾…").clicked() {
                    if let Some(path) = rfd::FileDialog::new().pick_folder() {
                        self.form.kb_folder = path.to_string_lossy().to_string();
                    }
                }
            });
            ui.label(egui::RichText::new("指定一個資料夾, AI寶 會讀取裡面的 .txt / .md / .csv 回答公司問題。資料夾內容請先自行脫敏。留空 = 沒有全域資料夾, 各室只能用自己的專屬資料夾。").weak().small());
            ui.horizontal(|ui| {
                ui.checkbox(&mut self.form.show_sources, "回答時附上參考來源");
                ui.label(egui::RichText::new("(打開才會在回答後面附上參考的檔案名稱; 關閉就不顯示)").weak());
            });
            ui.horizontal(|ui| {
                let saving = self.busy.get("save").copied().unwrap_or(false);
                if primary_btn(ui, self.palette, if saving { "儲存中…" } else { "儲存全域設定" }).clicked() && !saving {
                    self.save_settings(&ctx);
                }
                if let Some(m) = &self.form.save_msg {
                    ui.label(m.clone());
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
        ui.add_space(10.0);
        // 下方各室區: 頁簽本身就是室名, 點哪個頁簽就是在設哪個室。
        // 搜尋只是輔助找室: 輸入關鍵字會縮小頁簽範圍, 清空就全部回來, 不取代可見的頁簽。
        ui.label(egui::RichText::new("各聊天室的管理 (點頁簽就是在設那個室)").strong());
        ui.horizontal(|ui| {
            ui.label("找室:");
            ui.add(
                egui::TextEdit::singleline(&mut self.manage_chat_search)
                    .desired_width(260.0)
                    .hint_text("打群名關鍵字縮小頁簽範圍…"),
            );
            if !self.manage_chat_search.is_empty() && ui.button("顯示全部").clicked() {
                self.manage_chat_search.clear();
            }
        });
        let q = self.manage_chat_search.trim().to_string();
        let tabs: Vec<(String, String)> = options
            .iter()
            .filter(|(_, label)| q.is_empty() || label.contains(&q))
            .map(|(id, label)| (id.clone(), label.clone()))
            .collect();
        if tabs.is_empty() {
            ui.label(egui::RichText::new("沒有名字符合的聊天室, 按「顯示全部」回到完整頁簽。").weak());
        }
        let mut picked: Option<String> = None;
        egui::ScrollArea::horizontal()
            .id_salt("manage-chat-tabs")
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    for (id, label) in &tabs {
                        let summary = self.chat_profile_summary(id);
                        if ui
                            .selectable_value(&mut self.manage_chat_id, id.clone(), label.clone())
                            .on_hover_text(summary)
                            .changed()
                        {
                            picked = Some(id.clone());
                        }
                    }
                });
            });
        if picked.is_some() {
            self.manage_admin_search.clear();
            self.manage_admin_page = 0;
            self.manage_candidates_all = false;
            self.manage_candidates.clear();
        }
        ui.add_space(8.0);
        let chat_id = self.manage_chat_id.clone();
        // 換聊天室就讀該室的管理員候選名單 (只讀該室, 不混其他聊天室的人)
        let manage_key = if self.manage_candidates_all { format!("{chat_id}#all") } else { chat_id.clone() };
        if self.manage_candidates_for != manage_key && !self.busy.get("manage_candidates").copied().unwrap_or(false) {
            self.spawn_manage_candidates_load(&ctx, chat_id.clone());
        }
        self.ensure_chat_profile_draft(&chat_id);
        let status = self.helper_status();
        let bot_status = status.as_ref().and_then(|s| s.get("bot")).cloned().unwrap_or(Value::Null);
        let kb_chats = bot_status.get("kbChats").cloned().unwrap_or(Value::Null);
        let global_kb = bot_status.get("kb").cloned().unwrap_or(Value::Null);
        let global_role = self.form.ai_role.clone();
        let global_scope = self.form.ai_scope.clone();
        let pal = self.palette;
        let room_name = options
            .iter()
            .find(|(id, _)| *id == chat_id)
            .map(|(_, l)| l.clone())
            .unwrap_or_else(|| activity_chat_label(&chat_id, ""));
        card(ui, pal, &format!("正在設定: {room_name}"), |ui| {
            // 生效來源標示改看「已儲存原貌」: 診斷包 chatProfiles={} 卻顯示「本聊天室自訂」
            // 的教訓——之前看的是未儲存的編輯草稿, 草稿一動就謊稱已生效。
            // 草稿與存檔不同時, 另起一行標明「尚未儲存」, 不准把草稿當成效。
            let (saved_custom, saved_suspended) = {
                let s0 = self.form.chat_profiles_orig.get(&chat_id);
                (chat_profile_uses_custom(s0), s0.map(|f| f.suspended).unwrap_or(false))
            };
            let dirty = chat_profile_dirty(
                self.form.chat_profiles.get(&chat_id),
                self.form.chat_profiles_orig.get(&chat_id),
            );
            if saved_suspended {
                ui.label(egui::RichText::new("已儲存的狀態: 已停用待確認 (這個聊天室的自訂設定暫停中, 請到本頁最下方處理)").color(pal.warn_text).strong());
            } else if saved_custom {
                ui.label(egui::RichText::new("已儲存的狀態: 用本聊天室設定 (全域預設不生效)").color(pal.primary).strong());
            } else {
                ui.label(egui::RichText::new("已儲存的狀態: 用全域預設").strong());
            }
            if dirty {
                ui.label(egui::RichText::new("⚠ 上面有還沒儲存的修改 (尚未生效), 按「儲存這個聊天室的設定」才會真的生效。").color(pal.warn_text).strong());
            }
            ui.add_space(6.0);
            // 儲存鈕放標題下面, 不用捲到最下方才找得到 (下方表單最下面也有一顆, 兩顆同一動作)。
            ui.horizontal(|ui| {
                let saving_profiles = self.busy.get("chat_profiles").copied().unwrap_or(false);
                if primary_btn(ui, pal, if saving_profiles { "儲存中…" } else { "儲存這個聊天室的設定" }).clicked() && !saving_profiles {
                    self.save_chat_profiles(&ctx);
                }
                if let Some(m) = &self.chat_profiles_msg {
                    ui.label(m.clone());
                }
            });
            ui.add_space(4.0);
            // 角色與回答範圍 (五區前兩區): 這區是改這個聊天室回答問題時扮演的角色、
            // 以及能回答哪些範圍。
            // 使用全域預設 / 本聊天室自訂切換: 切自訂時預填全域文字; 切回全域只清人設自訂旗標,
            // 聒噪、管理員、知識庫等獨立欄位不連帶刪除 (條目存廢由 has_entry 決定)。
            ui.label(egui::RichText::new("角色與回答範圍").strong());
            ui.label(egui::RichText::new("這區是改這個聊天室回答問題時扮演的角色、以及能回答哪些範圍。").weak().small());
            {
                let f = match self.form.chat_profiles.get_mut(&chat_id) {
                    Some(f) => f,
                    None => return,
                };
                let was_custom = f.custom;
                ui.horizontal(|ui| {
                    ui.label("人設要用哪一套:");
                    ui.selectable_value(&mut f.custom, false, "使用全域預設");
                    ui.selectable_value(&mut f.custom, true, "本聊天室自訂");
                });
                if f.custom && !was_custom {
                    if f.role.trim().is_empty() {
                        f.role = global_role.clone();
                    }
                    if f.scope.trim().is_empty() {
                        f.scope = global_scope.clone();
                    }
                }
            }
            ui.add_space(6.0);
            // 角色定位與回答範圍 (自訂時才在這裡改; 用全域時去「AI 設定」頁改全域預設)
            {
                let f = match self.form.chat_profiles.get_mut(&chat_id) {
                    Some(f) => f,
                    None => return,
                };
                if !f.custom {
                    ui.label(egui::RichText::new("這個聊天室用上方全域區的角色定位與回答範圍, 要改全域預設請捲到上面全域區。").weak().small());
                } else {
                    ui.label(egui::RichText::new("角色定位").strong());
                    ui.add(egui::TextEdit::multiline(&mut f.role).desired_rows(2).desired_width(f32::INFINITY));
                    ui.add_space(6.0);
                    ui.label(egui::RichText::new("回答範圍").strong());
                    ui.add(egui::TextEdit::multiline(&mut f.scope).desired_rows(4).desired_width(f32::INFINITY));
                    ui.label(egui::RichText::new("清空這個欄位 = 這個聊天室不限制範圍, 什麼問題都回答。").weak().small());
                }
                ui.add_space(8.0);
                ui.separator();
                // 知識庫 (五區第三區): 允許讀取 + 專屬資料夾 + 該群索引狀態一行
                ui.label(egui::RichText::new("這個聊天室的知識庫").strong());
                ui.label(egui::RichText::new("這區是決定這個聊天室能不能查知識庫、查哪個專屬資料夾。").weak().small());
                ui.checkbox(&mut f.kb_enabled, "允許這個聊天室讀取知識庫");
                ui.label(egui::RichText::new("關閉後, 這個聊天室問公司問題時不會查知識庫。").weak().small());
                ui.horizontal(|ui| {
                    ui.label("專屬資料夾:");
                    ui.add(egui::TextEdit::singleline(&mut f.kb_folder).desired_width(340.0).hint_text("留空 = 用全域資料夾"));
                    if ui.button("選擇資料夾…").clicked() {
                        if let Some(path) = rfd::FileDialog::new().pick_folder() {
                            f.kb_folder = path.to_string_lossy().to_string();
                        }
                    }
                });
                ui.label(egui::RichText::new("留空 = 用全域知識庫資料夾。").weak().small());
                if let Some(entry) = kb_chats.get(&chat_id) {
                    ui.label(egui::RichText::new(format!("這個聊天室的知識庫索引: {}", kb_status_line(entry))).weak().small());
                } else if !global_kb.is_null() {
                    ui.label(egui::RichText::new(format!("全域知識庫索引: {}", kb_status_line(&global_kb))).weak().small());
                }
            }
            // (聒噪區移到管理員區之後, 五區順序: 角色、範圍、知識庫、管理員、聒噪。)
            ui.add_space(8.0);
            ui.separator();
            // 本聊天室管理員挑選 (五區第四區, 人多先行): 預設只列近期發言過的人 + 社群管理員;
            // 已選的人另外列在已選區 (附移除鈕), 搜尋只過濾下方待選清單, 已選區不會被篩掉;
            // 待選清單分頁 (每頁 50 位, Codex 管理頁同款), 同名的人靠帳號末 4 碼區分。
            ui.label(egui::RichText::new("本聊天室管理員").strong());
            ui.label(egui::RichText::new("這區是選這個聊天室出事時要 @ 出來處理的人。").weak().small());
            ui.label(egui::RichText::new("這裡的管理員只是「通知對象」: 有重要事件時, AI寶 會在群組裡 @ 他們出面處理; AI寶 本身不會踢人或處分任何人。未設定時, 重要事件會通知「機器人與觸發」頁的備援管理員。").weak().small());
            ui.label(egui::RichText::new("管理員認的是帳號不是名字: 這個人改名字、或在不同聊天室顯示不同名字, 管理員身分都不會認不得。上面顯示的是他最近一次發言用的名字, 若和存檔舊名不同會加註。").weak().small());
            // 顯示用候選名單 (真實名單; CI 截圖時另補假候選人, 見 manage_display_candidates)。
            // 候選名單是否已讀完: 只有讀完才能判斷「已選的人不在名單裡」, 讀取中不亂警告。
            let display_cands = self.manage_display_candidates(&chat_id);
            let candidate_ids: Vec<String> = display_cands.iter().map(|(id, _, _)| id.clone()).collect();
            let load_done = self.manage_candidates_for == manage_key
                && !self.busy.get("manage_candidates").copied().unwrap_or(false);
            // 已選的管理員 (另外列出, 每人附移除鈕; Codex: 查看或移除已選對象)
            ui.label(egui::RichText::new("已選的管理員").strong());
            {
                let f = match self.form.chat_profiles.get_mut(&chat_id) {
                    Some(f) => f,
                    None => return,
                };
                if f.admins.is_empty() {
                    // 沒設本室管理員時, 實際生效的是全域備援名單——這就是之前每個室
                    // 通知看起來都是同一個人 (妖狐藏馬) 的原因: 不是寫死, 是全部退回備援。
                    let fallback = self
                        .form
                        .notify_admins
                        .iter()
                        .map(|(_, n)| n.clone())
                        .collect::<Vec<_>>()
                        .join("、");
                    if fallback.is_empty() {
                        ui.label(egui::RichText::new("未設管理員, 全域備援也沒設人: 重要事件只會記在紀錄裡, 不會 @ 任何人。").weak().small());
                    } else {
                        ui.label(egui::RichText::new(format!("未設管理員, 目前用全域備援: {fallback} (只有這個聊天室沒設管理員時才用這裡的人)。")).weak().small());
                    }
                } else {
                    // 顯示名字以候選名單最新名字為準 (帳號相同、名字改過時不顯示舊名);
                    // 存檔舊名不同時加註, 不偷偷改寫存檔。
                    let mut remove_id: Option<String> = None;
                    for (aid, aname) in &f.admins.clone() {
                        let fresh = display_cands
                            .iter()
                            .find(|(id, _, _)| id == aid)
                            .map(|(_, n, _)| n.clone())
                            .unwrap_or_else(|| aname.clone());
                        let label = if fresh != *aname {
                            format!("{fresh} (存檔舊名: {aname})")
                        } else {
                            fresh
                        };
                        ui.horizontal(|ui| {
                            ui.label(label);
                            if ui.button("移除").clicked() {
                                remove_id = Some(aid.clone());
                            }
                        });
                    }
                    if let Some(rid) = remove_id {
                        f.admins.retain(|(id, _)| *id != rid);
                    }
                    // 未確認提醒 (Codex: 成員名單未經確認要有提醒文字): 已選的人不在目前
                    // 候選名單裡 (最近沒在這個室說話), 無法確認他還在室內, 請重新確認。
                    // 注意: Codex 另有「未核對就不 @」的門檻, 我們不抄——那會改變現有通知
                    // 行為 (備援與已設管理員本來就會 @); 這裡只提醒、不擋通知。
                    if load_done {
                        let bad = admin_unconfirmed(&f.admins.clone(), &candidate_ids);
                        if !bad.is_empty() {
                            let names = bad.iter().map(|(_, n)| n.clone()).collect::<Vec<_>>().join("、");
                            ui.label(egui::RichText::new(format!("⚠ 以下已選的人不在目前的候選名單裡 (最近沒在這個室說話), 無法確認他還在室內, 建議重新確認: {names}。")).color(pal.warn_text).strong());
                        }
                    }
                }
            }
            ui.add_space(4.0);
            // 搜尋框: 打名字或帳號末碼即時篩選下方待選清單 (本機過濾, 不動已選區)
            ui.horizontal(|ui| {
                ui.label("搜尋:");
                ui.add(egui::TextEdit::singleline(&mut self.manage_admin_search).desired_width(220.0).hint_text("輸入名字的一部分或帳號末碼"));
            });
            ui.horizontal(|ui| {
                let busy_mc = self.busy.get("manage_candidates").copied().unwrap_or(false);
                if ui.button(if busy_mc { "讀取中…" } else { "重新讀取本聊天室候選名單" }).clicked() && !busy_mc {
                    self.manage_candidates_for = String::new();
                }
                // 次要按鈕: 按下才抓較寬名單 (曾在本室出現過的人 + 社群管理員)
                if !self.manage_candidates_all && ui.button("找沒發言過的人").clicked() && !busy_mc {
                    self.manage_candidates_all = true;
                    self.manage_candidates_for = String::new();
                }
            });
            if self.manage_candidates_all {
                ui.label(egui::RichText::new("LINE 沒有提供完整成員名單，這裡列得出的是曾在這個聊天室出現過的人；從未出現過的人無法列出。").weak().small());
            }
            if display_cands.is_empty() {
                ui.label(egui::RichText::new("目前沒有讀到這個聊天室的候選名單: 有人在這個聊天室說過話之後, 就會列在這裡讓你勾選。").weak().small());
            }
            // 待選清單: 已選的人只在上方已選區出現, 不重複列; 搜尋看名字或帳號; 分頁每頁 50 位。
            let keyword = self.manage_admin_search.trim().to_string();
            let selected_ids: Vec<String> = self
                .form
                .chat_profiles
                .get(&chat_id)
                .map(|f| f.admins.iter().map(|(id, _)| id.clone()).collect())
                .unwrap_or_default();
            let cands_empty = display_cands.is_empty();
            let filtered: Vec<(String, String, String)> = display_cands
                .into_iter()
                .filter(|(cid, cname, _)| {
                    !selected_ids.iter().any(|id| id == cid)
                        && admin_candidate_matches(cname, cid, &keyword)
                })
                .collect();
            let total = filtered.len();
            if total == 0 {
                if !cands_empty {
                    ui.label(egui::RichText::new("沒有符合搜尋的人, 或想找的人已經在上方已選名單裡。").weak().small());
                }
            } else {
                let mut page = self.manage_admin_page;
                let (_, _, pages) = admin_page_slice(total, page, MANAGE_ADMIN_PAGE_SIZE);
                if pages > 0 && page >= pages {
                    page = pages - 1;
                    self.manage_admin_page = page;
                }
                let (start, end, pages) = admin_page_slice(total, page, MANAGE_ADMIN_PAGE_SIZE);
                ui.label(format!("符合搜尋 {total} 位; 目前顯示第 {}~{end} 位, 每頁最多 {} 位。", start + 1, MANAGE_ADMIN_PAGE_SIZE));
                ui.horizontal(|ui| {
                    if ui.add_enabled(page > 0, egui::Button::new("上一頁")).clicked() {
                        self.manage_admin_page = page.saturating_sub(1);
                    }
                    ui.label(format!("第 {} / {pages} 頁", page + 1));
                    if ui.add_enabled(page + 1 < pages, egui::Button::new("下一頁")).clicked() {
                        self.manage_admin_page = page + 1;
                    }
                });
                let f = match self.form.chat_profiles.get_mut(&chat_id) {
                    Some(f) => f,
                    None => return,
                };
                for (cid, cname, source) in &filtered[start..end] {
                    let suffix = if source == "openchat-admin" { " (社群管理員)" } else { "" };
                    let mut on = false;
                    if ui.checkbox(&mut on, format!("{cname}（帳號末 4 碼：{}）{suffix}", admin_last4(cid))).changed() && on {
                        f.admins.push((cid.clone(), cname.clone()));
                    }
                }
            }
            ui.add_space(8.0);
            ui.separator();
            // 聒噪模式 (五區第五區, 各室自己的開關; 凍結定義, 語意不改):
            // 開啟後 AI 看該群近期對話、自己判斷接不接話, 沒合適的話就安靜;
            // 護欄 (45 秒間隔、每小時 20 則、剛接過話先讓真人講、同一人來回 3 次冷卻 10 分鐘)
            // 與「不主動接其他機器人的話」照凍結定義, 這裡只寫開關與指路, 不重定義。
            ui.label(egui::RichText::new("聒噪模式").strong());
            ui.label(egui::RichText::new("這區是決定這個聊天室要不要讓 AI 自己找話題接話 (不用叫名字)。").weak().small());
            {
                let f = match self.form.chat_profiles.get_mut(&chat_id) {
                    Some(f) => f,
                    None => return,
                };
                ui.checkbox(&mut f.chatty, "聒噪模式: 不用叫名字, 我也會自己找話題接話");
                ui.label(egui::RichText::new("打開後, 我會看著這個群最近的對話, 自己判斷有沒有自然合適的話可以接; 沒有合適的話就保持安靜, 不會每則都回。打開後 AI 用量會增加。叫名字或引用問我時, 還是照平常方式優先回答; 別的群的事、個人資料跟公司機密, 我一樣不會說出去。").weak().small());
            }
            ui.label(egui::RichText::new("聒噪只接「沒被叫名字」的話; 被叫名字時走全域觸發規則, 不走這裡。兩邊怎麼分工, 看「機器人與觸發」頁上方的說明。").weak().small());
            if ui.button("去「機器人與觸發」頁看分工說明").clicked() {
                self.page = Page::BotSettings;
            }
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                let saving_profiles = self.busy.get("chat_profiles").copied().unwrap_or(false);
                if primary_btn(ui, pal, if saving_profiles { "儲存中…" } else { "儲存這個聊天室的設定" }).clicked() && !saving_profiles {
                    self.save_chat_profiles(&ctx);
                }
                if let Some(m) = &self.chat_profiles_msg {
                    ui.label(m.clone());
                }
            });
            ui.label(egui::RichText::new("儲存後馬上生效, 不用重新開啟程式。").weak().small());
        });
        ui.add_space(10.0);
        // 已停用設定區 (頁尾): 移出白名單後保留但停用的條目, 在這裡恢復或捨棄。
        let mut suspended_ids: Vec<String> = self
            .form
            .chat_profiles_orig
            .iter()
            .filter(|(_, f)| f.suspended)
            .map(|(id, _)| id.clone())
            .collect();
        suspended_ids.sort();
        if !suspended_ids.is_empty() {
            card(ui, pal, "已停用設定", |ui| {
                ui.label(egui::RichText::new("這些聊天室之前有自訂設定, 移出白名單後先保留但停用。恢復使用後要把聊天室加回白名單才會真的生效; 不要了可以捨棄這份設定 (會把這份設定刪掉, 聒噪/管理員等欄位也會一起刪掉)。").weak().small());
                let mut restore_id: Option<String> = None;
                let mut discard_id: Option<String> = None;
                for sid in &suspended_ids {
                    let label = options.iter().find(|(id, _)| id == sid).map(|(_, l)| l.clone()).unwrap_or_else(|| activity_chat_label(sid, ""));
                    ui.horizontal(|ui| {
                        ui.label(label);
                        if ui.button("恢復使用").clicked() {
                            restore_id = Some(sid.clone());
                        }
                        if ui.button("捨棄這份設定").clicked() {
                            discard_id = Some(sid.clone());
                        }
                    });
                }
                if let Some(sid) = restore_id {
                    self.restore_suspended_chat(&ctx, sid);
                }
                if let Some(sid) = discard_id {
                    self.delete_orphan_chat_profile(&ctx, sid);
                }
                if let Some(m) = &self.chat_profiles_msg {
                    ui.label(m.clone());
                }
            });
        }
    }

    fn page_bot(&mut self, ui: &mut egui::Ui) {
        ui.heading("機器人與觸發");
        ui.add_space(8.0);
        let ctx = ui.ctx().clone();
        if !self.admin_events_attempted {
            self.admin_events_attempted = true;
            self.spawn_admin_events_load(&ctx);
        }
        // 觸發與聒噪的分工說明 (修復版6後續修復, 語意經程式查證 — 見施工紀錄):
        // 叫名字/引用走觸發、沒叫名字才看各室聒噪、同一則絕不雙回; 兩者不打架。
        card(ui, self.palette, "觸發跟聒噪怎麼分工 (不會打架)", |ui| {
            ui.label("觸發是全域規則, 在這一頁管: 有人在訊息裡叫機器人名字或別名、或是引用機器人的回答再追問, 就走觸發回答; 冷卻、60 秒上限、每日上限也在這一頁。");
            ui.label("聒噪是各聊天室自己的開關, 在「聊天室管理」頁管: 只有「沒被叫名字」的一般訊息, 才看那個聊天室的聒噪開關決定要不要自己接話。");
            ui.label("同一則訊息不會回兩次: 被叫名字的訊息就算這次被冷卻或上限擋下不回, 也不會轉給聒噪補一句; 聒噪只接沒叫名字的話。");
            ui.label("AI寶 自己的話和系統通知 (有人加入或離開) 不觸發也不接話。其他機器人的話因為 LINE 沒給可靠的標記、沒辦法百分之百認出來, 靠接話間隔與上限護欄收斂, 不會無限互聊。");
            if ui.button("去「聊天室管理」頁開／關聒噪").clicked() {
                self.page = Page::ChatManage;
            }
        });
        ui.add_space(8.0);
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
                ui.label("每人每群／60 秒上限:");
                ui.add(egui::DragValue::new(&mut self.form.per_user_chat_minute).range(0..=1000));
                ui.label("所有群合計／60 秒上限:");
                ui.add(egui::DragValue::new(&mut self.form.all_chats_minute).range(0..=1000));
            });
            ui.label(egui::RichText::new("每人每群／60 秒: 同一個人在同一個聊天室，任意連續 60 秒內最多問 AI 幾次。").weak());
            ui.label(egui::RichText::new("所有群合計／60 秒: 所有允許的聊天室加起來，任意連續 60 秒內最多問幾次；用滿後，其他群的人也要等有空額才能問。").weak());
            ui.label(egui::RichText::new("兩個數字填 0 表示不限制。只算真正送出的提問: 只叫名字打招呼不算，AI 當次回答失敗也算一次；次數在程式重啟後會清零。").weak());
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
            ui.label(egui::RichText::new("有人問 AI寶 是誰做的、問到版權，或問 AI寶 是用什麼技術做成的時候，AI寶 會委婉拒答——這些屬機敏資訊，不會在群組對話透露。（程式畫面上的版權宣告不受影響）").weak());
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
            ui.label(egui::RichText::new("步驟一: 把目標群組加入白名單").size(15.0));
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
                    let name = chat_display_name(c.get("name").and_then(|v| v.as_str()), true);
                    let sub = chat_sub_text(
                        c.get("kind").and_then(|v| v.as_str()),
                        c.get("memberCount").and_then(|v| v.as_i64()),
                        true,
                    );
                    let whitelisted = c.get("whitelisted").and_then(|v| v.as_bool()).unwrap_or(false);
                    let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    chat_list_row(ui, &name, &sub, |ui| {
                        if whitelisted {
                            // 已在白名單: 停用態標籤 (與按鈕同尺寸同欄位, 保持每列對齊)
                            let _ = chat_action_btn(ui, "已在白名單", false);
                        } else if chat_action_btn(ui, "加入白名單", !busy_apply_now).clicked() {
                            self.start_apply(&ctx, id.clone());
                        }
                    });
                }
            }
            ui.collapsing("進階: 手動貼上群組 ID (清單讀不到時才需要)", |ui| {
                ui.horizontal(|ui| {
                    ui.label("群組 ID:");
                    let mut chat_id = self.page_msg.get("chatid").cloned().unwrap_or_default();
                    if ui.add(egui::TextEdit::singleline(&mut chat_id).desired_width(320.0).hint_text("共 33 碼 (群組 c 開頭、社群 m 開頭)")).changed() {
                        self.page_msg.insert("chatid".into(), chat_id);
                    }
                });
                ui.label(egui::RichText::new(format!("備用方法: 在核心網頁 (http://127.0.0.1:{}) 點進群組聊天室, 用右鍵「複製聊天室 ID」取得 ID, 再貼到上面欄位。", crate::engine::core_port())).weak());
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
            // 名稱/類型/人數由 helper 對照核心快照解析; 2026-10-21 版面整理: 畫面不顯示原始 ID,
            // 名稱讀不到就顯示「未命名群組」與「名稱與資料待讀取」 (ID 只留在 log/診斷資料)。
            ui.label(egui::RichText::new("目前白名單 (已儲存的群組)").size(15.0));
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
                    if id.is_empty() {
                        continue;
                    }
                    let resolved = c.get("nameResolved").and_then(|v| v.as_bool()).unwrap_or(false);
                    let name = chat_display_name(c.get("name").and_then(|v| v.as_str()), resolved);
                    let sub_base = chat_sub_text(
                        c.get("kind").and_then(|v| v.as_str()),
                        c.get("memberCount").and_then(|v| v.as_i64()),
                        resolved,
                    );
                    // 狀態小字 (唯讀): 這個群目前用哪一套設定, 一眼可分; 改設定去「聊天室管理」頁, 這裡不提供編輯。
                    let prof = self.form.chat_profiles.get(&id);
                    let state_txt = match prof.map(|f| (f.custom, f.suspended)) {
                        Some((_, true)) => "已停用待確認",
                        Some((true, false)) => "本群自訂",
                        _ => "用預設",
                    };
                    let chatty_mark = if prof.map(|f| f.chatty).unwrap_or(false) { "・聒噪開" } else { "" };
                    let sub = format!("{sub_base}・{state_txt}{chatty_mark}");
                    let mut remove_clicked = false;
                    chat_list_row(ui, &name, &sub, |ui| {
                        if chat_action_btn(ui, "移除", !busy_apply_now).clicked() {
                            remove_clicked = true;
                        }
                    });
                    if remove_clicked {
                        self.start_remove(&ctx, id.clone());
                    }
                }
                ui.label(egui::RichText::new("移除後要把 AI寶 完全關閉再重新開啟才會生效 (與加入相同)。各聊天室自己的設定請到「聊天室管理」頁改。").weak());
            }
            ui.add_space(8.0);
            // 步驟二: Token
            ui.label(egui::RichText::new("步驟二: 產生機器人 Token").size(15.0));
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
        ui.add_space(10.0);
        card(ui, self.palette, "備援管理員 (聊天室未設管理員時用)", |ui| {
            ui.label(egui::RichText::new("每個聊天室可以在「聊天室管理」頁設定自己的管理員; 該聊天室有自己的管理員時, 重要事件只通知該室管理員, 不會通知這份備援名單。").weak());
            ui.label(egui::RichText::new("只有聊天室沒設管理員時才用這裡的人: 所以如果你看到每個室通知的都是同一批人, 不是寫死, 是那些室都還沒設自己的管理員、全部退回這份備援名單。").weak());
            ui.label(egui::RichText::new("管理員認的是帳號不是名字: 這個人改名字、或在不同聊天室顯示不同名字, 管理員身分都不會認不得。").weak());
            ui.label(egui::RichText::new("被 @ 的對象就是這份名單裡的人; 實務上大部份會是你本人。從下面「有在白名單群組裡發言過的人」裡面用勾的選, 不用打任何代號; 勾完按下面通知事件清單裡的「儲存通知設定」才算數。").weak());
            ui.label(egui::RichText::new("小提醒: 被通知的人最好有在那個群裡說過話。從來沒在群裡說過話的人可能 @ 不到, 到時候 AI寶 會改用寫名字的方式通知, 並在紀錄裡註明。").weak());
            // 已選的管理員固定置頂 (比照聊天室管理頁): 不因搜尋或清單捲動而消失, 可直接取消勾選。
            ui.label(egui::RichText::new("已選的管理員").strong());
            if self.form.notify_admins.is_empty() {
                ui.label("目前還沒有設定管理員。");
            } else {
                let selected: Vec<(String, String)> = self.form.notify_admins.clone();
                for (aid, aname) in &selected {
                    let mut on = true;
                    if ui.checkbox(&mut on, aname.clone()).changed() && !on {
                        self.form.notify_admins.retain(|(id, _)| id != aid);
                    }
                }
            }
            ui.add_space(6.0);
            // 搜尋框: 打名字關鍵字即時篩選下方待選清單 (本機過濾, 資料來源沿用全域候選名單)
            ui.horizontal(|ui| {
                ui.label("搜尋名字:");
                ui.add(egui::TextEdit::singleline(&mut self.backup_admin_search).desired_width(220.0).hint_text("輸入名字的一部分"));
            });
            ui.horizontal(|ui| {
                let busy_c = self.busy.get("candidates").copied().unwrap_or(false);
                if ui.button(if busy_c { "讀取中…" } else { "讀取可選名單" }).clicked() && !busy_c {
                    self.spawn_candidates_load(&ctx);
                }
                if let Some(m) = self.page_msg.get("candidates") {
                    ui.label(m.clone());
                }
            });
            if !self.candidates.is_empty() {
                ui.label(egui::RichText::new("有在白名單群組發言過的人 (勾選 = 加入備援管理員名單):").weak());
            }
            let keyword = self.backup_admin_search.trim().to_string();
            let cands = self.candidates.clone();
            let mut shown = 0usize;
            for c in &cands {
                let cid = c.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let cname = c.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if cid.is_empty() || cname.is_empty() {
                    continue;
                }
                // 已選的人只在上方已選區出現, 待選清單不重複列
                if self.form.notify_admins.iter().any(|(id, _)| *id == cid) {
                    continue;
                }
                if !keyword.is_empty() && !cname.contains(&keyword) {
                    continue;
                }
                shown += 1;
                let chats = c.get("chats").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("、")).unwrap_or_default();
                let source = if c.get("source").and_then(|v| v.as_str()) == Some("openchat-admin") { " (社群管理員)" } else { "" };
                let mut on = false;
                let label = if chats.is_empty() { format!("{cname}{source}") } else { format!("{cname}{source} — 在『{chats}』發言過") };
                if ui.checkbox(&mut on, label).changed() && on {
                    self.form.notify_admins.push((cid.clone(), cname.clone()));
                }
            }
            if shown == 0 && !self.candidates.is_empty() {
                ui.label(egui::RichText::new("沒有符合搜尋的人, 或想找的人已經在上方已選名單裡。").weak().small());
            }
        });
        ui.add_space(10.0);
        card(ui, self.palette, "通知事件清單 (發生什麼事要通知管理員)", |ui| {
            ui.label(egui::RichText::new("一筆一筆設定: 發生哪種事、要通知哪幾位管理員。這裡的開關和關鍵字改完按下面「儲存通知設定」才算數。同一種事 10 分鐘內先通知第一筆, 其他先合併起來、不會一直 @ 人; 過了 10 分鐘會再補送一則彙總通知, 不會漏掉。一天最多通知 20 次。").weak());
            let admins = self.form.notify_admins.clone();
            let mut remove_idx: Option<usize> = None;
            for (idx, rule) in self.form.notify_rules.iter_mut().enumerate() {
                ui.horizontal(|ui| {
                    ui.checkbox(&mut rule.enabled, "啟用");
                    for (val, label) in [("scam", "詐騙警報"), ("unanswered", "AI寶 答不出來"), ("keyword", "有人提到關鍵字"), ("selfError", "AI寶 自己出狀況")] {
                        ui.selectable_value(&mut rule.kind, val.to_string(), label);
                    }
                    if ui.button("刪除這一筆").clicked() {
                        remove_idx = Some(idx);
                    }
                });
                if rule.kind == "keyword" {
                    ui.horizontal(|ui| {
                        ui.label("關鍵字:");
                        ui.add(egui::TextEdit::singleline(&mut rule.keyword).desired_width(200.0).hint_text("例: 報價, 客訴"));
                    });
                    // 目前關鍵字用白話再顯示一次 (2026-10-22 修復): 只看輸入框容易看漏/看不清
                    // 到底有沒有填、填的是什麼; 空的時候直接警告這筆不會通知。
                    if rule.keyword.trim().is_empty() {
                        ui.label(egui::RichText::new("還沒填關鍵字: 這一筆不會通知任何人, 請先填關鍵字。").color(self.palette.bad));
                    } else {
                        ui.label(egui::RichText::new(format!("目前關鍵字: 『{}』— 群組訊息裡出現這個詞, 就會通知管理員。", rule.keyword.trim())).weak());
                    }
                }
                if admins.is_empty() {
                    ui.label(egui::RichText::new("尚無管理員名單, 這一筆先存著, 名單設定好後在這裡勾要通知誰。").weak());
                } else {
                    ui.horizontal(|ui| {
                        ui.label("通知誰:");
                        for (aid, aname) in &admins {
                            let mut on = rule.admin_ids.contains(aid);
                            if ui.checkbox(&mut on, aname.clone()).changed() {
                                if on {
                                    rule.admin_ids.push(aid.clone());
                                } else {
                                    rule.admin_ids.retain(|x| x != aid);
                                }
                            }
                        }
                    });
                }
                ui.separator();
            }
            if let Some(idx) = remove_idx {
                self.form.notify_rules.remove(idx);
            }
            ui.horizontal(|ui| {
                if ui.button("新增一筆通知事件").clicked() {
                    self.form.notify_rules.push(NotifyRuleForm { kind: "scam".to_string(), enabled: true, ..Default::default() });
                }
                let saving = self.busy.get("save").copied().unwrap_or(false);
                if primary_btn(ui, self.palette, if saving { "儲存中…" } else { "儲存通知設定" }).clicked() {
                    self.save_settings(&ctx);
                }
                if let Some(m) = &self.form.save_msg {
                    ui.label(m.clone());
                }
            });
        });
        ui.add_space(10.0);
        card(ui, self.palette, "最近的管理員通知紀錄", |ui| {
            ui.horizontal(|ui| {
                if ui.button("重新讀取").clicked() {
                    self.admin_events_attempted = true;
                    self.spawn_admin_events_load(&ctx);
                }
            });
            if let Some(err) = &self.notify_last_error {
                ui.label(egui::RichText::new(err.clone()).color(self.palette.bad));
                ui.add_space(4.0);
            }
            if self.admin_events.is_empty() {
                ui.label(egui::RichText::new("還沒有通知紀錄。有設定通知事件、而且真的發生事情時, 會記在這裡 (有沒有真的送出去、為什麼改用寫名字, 都會註明)。").weak());
            }
            for ev in self.admin_events.iter().take(15) {
                let label = ev.get("kindLabel").and_then(|v| v.as_str()).unwrap_or("通知");
                let label = if ev.get("isSummary").and_then(|v| v.as_bool()).unwrap_or(false) { format!("彙總補送・{label}") } else { label.to_string() };
                let chat = ev.get("chatName").and_then(|v| v.as_str()).unwrap_or("");
                let ts = ev.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
                let when = fmt_event_time(ts);
                let merged = ev.get("mergedCount").and_then(|v| v.as_u64()).unwrap_or(0);
                let merged_total = ev.get("mergedTotal").and_then(|v| v.as_u64()).unwrap_or(0);
                let sent_ok = ev.get("sentOk");
                let sent_state = match sent_ok.and_then(|v| v.as_bool()) {
                    Some(true) => "已通知管理員".to_string(),
                    Some(false) => "通知沒有送出去".to_string(),
                    None => {
                        if ev.get("notified").and_then(|v| v.as_bool()).unwrap_or(false) {
                            "等程式送出中".to_string()
                        } else {
                            "只寫進紀錄 (沒有另外通知)".to_string()
                        }
                    }
                };
                // 合併狀態要分清 (2026-10-22 修復): 還有幾則合併中 (稍後補送彙總) / 已補送完
                let merged_note = if merged > 0 {
                    format!(" (同類事件另有 {merged} 則合併中, 稍後會補送一則彙總通知)")
                } else if merged_total > 0 {
                    format!(" (同類事件曾合併 {merged_total} 則, 已補送彙總通知)")
                } else {
                    String::new()
                };
                ui.label(format!("{when}・{label}・『{chat}』— {sent_state}{merged_note}"));
                let note = ev.get("note").and_then(|v| v.as_str()).unwrap_or("");
                if !note.is_empty() {
                    ui.label(egui::RichText::new(format!("　{note}")).weak());
                }
            }
        });
    }

    /// 背景讀取待發清單/發送紀錄 (helper /api/outbox), 結果進 outbox_slot 由 poll 收。
    fn spawn_outbox_load(&mut self, ctx: &egui::Context) {
        if self.busy.get("outbox").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("outbox".into(), true);
        let slot = self.outbox_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let r = helper_api::get_outbox();
            *slot.lock().unwrap() = Some(match r {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    fn spawn_materials_load(&mut self, ctx: &egui::Context) {
        if self.busy.get("materials").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("materials".into(), true);
        let slot = self.materials_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let r = helper_api::get_materials();
            *slot.lock().unwrap() = Some(match r {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    fn spawn_candidates_load(&mut self, ctx: &egui::Context) {
        if self.busy.get("candidates").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("candidates".into(), true);
        let slot = self.candidates_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let r = helper_api::get_admin_candidates();
            *slot.lock().unwrap() = Some(match r {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    fn spawn_admin_events_load(&mut self, ctx: &egui::Context) {
        if self.busy.get("admin_events").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("admin_events".into(), true);
        let slot = self.admin_events_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let r = helper_api::get_admin_events();
            *slot.lock().unwrap() = Some(match r {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    /// 待發清單的暫停/恢復 (鑰匙不正常被排程自動暫停的, 修好後使用者按恢復)
    fn start_outbox_pause(&mut self, ctx: &egui::Context, id: String, paused: bool) {
        if self.busy.get("outbox_action").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("outbox_action".into(), true);
        let slot = self.outbox_action_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let r = helper_api::pause_outbox(&id, paused, if paused { "已暫停" } else { "已恢復, 照排程繼續" }, if paused { "manual" } else { "" });
            *slot.lock().unwrap() = Some(match r {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    fn start_outbox_create(&mut self, ctx: &egui::Context, body: Value) {
        if self.busy.get("outbox_action").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("outbox_action".into(), true);
        let slot = self.outbox_action_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let r = helper_api::create_outbox(body);
            *slot.lock().unwrap() = Some(match r {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    fn start_outbox_cancel(&mut self, ctx: &egui::Context, id: String) {
        if self.busy.get("outbox_action").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("outbox_action".into(), true);
        let slot = self.outbox_action_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let r = helper_api::cancel_outbox(&id);
            *slot.lock().unwrap() = Some(match r {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    /// 排程計時 (第三階段): 每 20 秒一輪。到期判斷 (含三項護欄) 與送出都在背景執行緒做,
    /// 結果進 send_tick_slot。
    /// 管理員通知走快速路 (2026-10-22 修復): 每 5 秒檢查一次, 有待送就先送 — 不跟排程
    /// 擠同一輪。兩條路共用 busy 旗標與結果 slot, 同一時間只跑一條 (連線只開一條)。
    fn send_engine_tick(&mut self, ctx: &egui::Context) {
        if self.busy.get("send_tick").copied().unwrap_or(false) {
            return;
        }
        if !matches!(self.engine_snap.state, EngineState::Running) {
            return;
        }
        let notify_due = self.last_notify_tick.map(|t| t.elapsed() > Duration::from_secs(5)).unwrap_or(true);
        if notify_due {
            self.last_notify_tick = Some(std::time::Instant::now());
            self.busy.insert("send_tick".into(), true);
            let slot = self.send_tick_slot.clone();
            let ctx2 = ctx.clone();
            std::thread::spawn(move || {
                let summary = run_notify_once();
                *slot.lock().unwrap() = Some(summary);
                ctx2.request_repaint();
            });
            return;
        }
        let due = self.last_send_tick.map(|t| t.elapsed() > Duration::from_secs(20)).unwrap_or(true);
        if !due {
            return;
        }
        self.last_send_tick = Some(std::time::Instant::now());
        self.busy.insert("send_tick".into(), true);
        let slot = self.send_tick_slot.clone();
        let started = self.send_engine_started_ms;
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let summary = run_send_engine_once(started);
            *slot.lock().unwrap() = Some(summary);
            ctx2.request_repaint();
        });
    }

    /// 立即送出一筆待發 (過期清單的「補發」): 整筆照逐項送出, 結果寫回發送紀錄。
    /// retry_only=true 時只重送上次失敗的項目 (發送紀錄的「重送失敗的項目」), 成功的原樣保留。
    fn start_outbox_send_now(&mut self, ctx: &egui::Context, entry: Value, retry_only: bool) {
        if self.busy.get("outbox_action").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("outbox_action".into(), true);
        let slot = self.outbox_action_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let id = entry.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let result = (|| -> Result<Value, String> {
                let mut ch = pagesend::PageChannel::connect()?;
                if retry_only {
                    let prev: Vec<Value> = entry.get("itemResults").and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    let merged = send_entry_items(&mut ch, &entry, Some(&prev));
                    helper_api::record_outbox_retry_result(&id, serde_json::json!(merged), "已重送失敗的項目")
                } else {
                    let results = send_entry_items(&mut ch, &entry, None);
                    helper_api::record_outbox_result(&id, serde_json::json!(results), "")
                }
            })();
            *slot.lock().unwrap() = Some(match result {
                Ok(v) => v,
                Err(e) => serde_json::json!({ "ok": false, "message": e }),
            });
            ctx2.request_repaint();
        });
    }

    // 發送群組訊息: 選群組/內容 (文字/圖片/檔案)/時間/預覽/建立待發 + 待發清單與發送紀錄。
    // 送出與排程在第三階段接通 (send_engine_tick + pagesend 瀏覽器通道); 檔案逐項送出 2026-10-22 接上第二階段核心通道 (/file/upload + fileId)。
    fn page_send(&mut self, ui: &mut egui::Ui) {
        ui.heading("發送群組訊息");
        ui.add_space(8.0);
        let ctx = ui.ctx().clone();
        if !self.outbox_attempted {
            self.outbox_attempted = true;
            self.spawn_outbox_load(&ctx);
        }
        if !self.materials_attempted {
            self.materials_attempted = true;
            self.spawn_materials_load(&ctx);
        }
        // 拖放: 把檔案拖進這一頁就直接加入 (圖片進圖片、其他進檔案), 不用先學任何快捷鍵
        let dropped = ctx.input(|i| i.raw.dropped_files.clone());
        for f in dropped {
            {
                let path = f.path();
                let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                let lower = name.to_ascii_lowercase();
                let sel = SendMediaSel { name: name.clone(), size, ref_path: path.to_string_lossy().to_string() };
                if [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].iter().any(|e| lower.ends_with(e)) {
                    self.send_images.push(sel);
                } else {
                    self.send_files.push(sel);
                }
                self.send_msg = Some(format!("已加入「{name}」"));
            }
        }
        card(ui, self.palette, "選群組 (只能從白名單選)", |ui| {
            let busy_chats = self.busy.get("chats").copied().unwrap_or(false);
            if ui.button(if busy_chats { "讀取中…" } else { "讀取我的群組清單" }).clicked() && !busy_chats {
                self.spawn_chats_load(&ctx);
            }
            if self.chats_loaded {
                let chats = self.group_chats.clone();
                for c in &chats {
                    let name = chat_display_name(c.get("name").and_then(|v| v.as_str()), true);
                    let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let whitelisted = c.get("whitelisted").and_then(|v| v.as_bool()).unwrap_or(false);
                    ui.horizontal(|ui| {
                        if whitelisted {
                            if ui.selectable_label(self.send_chat_id == id, name.clone()).clicked() {
                                self.send_chat_id = id.clone();
                                self.send_chat_name = name.clone();
                            }
                        } else {
                            ui.label(egui::RichText::new(format!("{name} (尚未加入白名單, 不能選)")).weak());
                        }
                    });
                }
            }
            if !self.send_chat_name.is_empty() {
                ui.label(format!("已選: {}", self.send_chat_name));
            }
        });
        ui.add_space(10.0);
        card(ui, self.palette, "選內容 (文字、圖片、檔案可以一起選)", |ui| {
            ui.label("文字 (最多 8000 字):");
            ui.add(egui::TextEdit::multiline(&mut self.send_text).desired_rows(4).desired_width(560.0).hint_text("例如: 這是本週的教材, 請先看完"));
            ui.label(egui::RichText::new(format!("目前 {} 字", self.send_text.chars().count())).weak());
            ui.add_space(6.0);
            ui.label("圖片 (每一張最多 10MB, 原圖送出不壓縮):");
            ui.horizontal(|ui| {
                if ui.button("選圖片 (可多選)").clicked() {
                    if let Some(paths) = rfd::FileDialog::new().add_filter("圖片", &["png", "jpg", "jpeg", "gif", "webp", "bmp"]).pick_files() {
                        for p in paths {
                            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                            self.send_images.push(SendMediaSel { name: p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), size, ref_path: p.to_string_lossy().to_string() });
                        }
                    }
                }
                if ui.button("貼上截圖").clicked() {
                    match paste_clipboard_image() {
                        Ok(sel) => { self.send_msg = Some("已貼上剪貼簿裡的圖片".to_string()); self.send_images.push(sel); }
                        Err(e) => { self.send_msg = Some(e); }
                    }
                }
                if ui.button("截圖").clicked() {
                    // 框選截圖: 先把主視窗縮到最小, 使用者在畫面上拖出範圍, 截好後視窗自己回來
                    ctx.send_viewport_cmd(egui::ViewportCommand::Minimized(true));
                    let slot = self.outbox_action_slot.clone();
                    let ctx2 = ctx.clone();
                    self.busy.insert("outbox_action".into(), true);
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(600));
                        let r = platform::capture_screen_region();
                        ctx2.send_viewport_cmd(egui::ViewportCommand::Minimized(false));
                        ctx2.send_viewport_cmd(egui::ViewportCommand::Focus);
                        *slot.lock().unwrap() = Some(match r {
                            Ok(path) => serde_json::json!({ "ok": true, "screenshot": path.to_string_lossy() }),
                            Err(e) => serde_json::json!({ "ok": false, "message": e }),
                        });
                        ctx2.request_repaint();
                    });
                }
            });
            ui.label(egui::RichText::new("「截圖」: 按下後視窗會先縮小, 直接用滑鼠在畫面上拖出要截的範圍, 放開就截好; 按 Esc 取消。也可以把圖片檔案直接拖進這一頁。").weak());
            let mut rm_img: Option<usize> = None;
            for (i, im) in self.send_images.iter().enumerate() {
                ui.horizontal(|ui| {
                    ui.label(format!("・{} ({})", im.name, fmt_size(im.size)));
                    if im.size > 10 * 1024 * 1024 {
                        ui.label(egui::RichText::new("超過 10MB, 送不出去").color(self.palette.bad));
                    }
                    if ui.button("移除").clicked() {
                        rm_img = Some(i);
                    }
                });
            }
            if let Some(i) = rm_img {
                self.send_images.remove(i);
            }
            ui.add_space(6.0);
            ui.label("檔案 (可多選, 會依序一個一個送出; 單檔上限 10MB):");
            ui.horizontal(|ui| {
                if ui.button("選檔案 (可多選)").clicked() {
                    if let Some(paths) = rfd::FileDialog::new().pick_files() {
                        for p in paths {
                            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
                            self.send_files.push(SendMediaSel { name: p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(), size, ref_path: p.to_string_lossy().to_string() });
                        }
                    }
                }
            });
            let mut rm_file: Option<usize> = None;
            for (i, f) in self.send_files.iter().enumerate() {
                ui.horizontal(|ui| {
                    ui.label(format!("・{} ({})", f.name, fmt_size(f.size)));
                    if ui.button("移除").clicked() {
                        rm_file = Some(i);
                    }
                });
            }
            if let Some(i) = rm_file {
                self.send_files.remove(i);
            }
        });
        ui.add_space(10.0);
        card(ui, self.palette, "教材庫 (常用的圖片先存起來, 之後點一下就能用)", |ui| {
            ui.horizontal(|ui| {
                if ui.button("重新讀取").clicked() {
                    self.materials_attempted = true;
                    self.spawn_materials_load(&ctx);
                }
                if ui.button("把圖片存進教材庫").clicked() {
                    if let Some(p) = rfd::FileDialog::new().add_filter("圖片", &["png", "jpg", "jpeg", "gif", "webp", "bmp"]).pick_file() {
                        match std::fs::read(&p) {
                            Ok(bytes) => {
                                let name = p.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
                                let slot = self.materials_slot.clone();
                                let ctx2 = ctx.clone();
                                self.busy.insert("materials".into(), true);
                                let b64 = b64_encode(&bytes);
                                std::thread::spawn(move || {
                                    let r = helper_api::add_material(&name, &b64).and_then(|_| helper_api::get_materials());
                                    *slot.lock().unwrap() = Some(match r {
                                        Ok(v) => v,
                                        Err(e) => serde_json::json!({ "ok": false, "message": e }),
                                    });
                                    ctx2.request_repaint();
                                });
                            }
                            Err(e) => {
                                self.send_msg = Some(format!("讀不到這個檔案: {e}"));
                            }
                        }
                    }
                }
            });
            if self.materials.is_empty() {
                ui.label(egui::RichText::new("教材庫還沒有東西。常用的操作步驟圖、公告圖可以先存進來。").weak());
            }
            let mats = self.materials.clone();
            for m in &mats {
                let name = m.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let size = m.get("sizeBytes").and_then(|v| v.as_u64()).unwrap_or(0);
                ui.horizontal(|ui| {
                    ui.label(format!("・{name} ({})", fmt_size(size)));
                    if ui.button("用這張").clicked() {
                        self.send_images.push(SendMediaSel { name: name.clone(), size, ref_path: format!("materials:{name}") });
                    }
                });
            }
        });
        ui.add_space(10.0);
        card(ui, self.palette, "選時間", |ui| {
            ui.horizontal(|ui| {
                ui.selectable_value(&mut self.send_mode, "now".to_string(), "立即");
                ui.selectable_value(&mut self.send_mode, "once".to_string(), "排程 (只發一次)");
                ui.selectable_value(&mut self.send_mode, "repeat".to_string(), "頻率 (重複發)");
            });
            if self.send_mode == "once" {
                ui.horizontal(|ui| {
                    ui.label("發送時間:");
                    ui.add(egui::TextEdit::singleline(&mut self.send_once_at).desired_width(200.0).hint_text("例: 2026-10-23 09:00"));
                });
            }
            if self.send_mode == "repeat" {
                ui.horizontal(|ui| {
                    ui.label("方式:");
                    ui.selectable_value(&mut self.send_repeat_kind, "same".to_string(), "重複發同一份");
                    ui.selectable_value(&mut self.send_repeat_kind, "series".to_string(), "依序發下一份 (整套教材)");
                });
                if self.send_repeat_kind == "series" {
                    ui.label(egui::RichText::new("整套教材一份一份排好: 每次到期就發下一份, 發完最後一份自動停。每一份先放文字; 要附圖的那一份, 發送前也可以在待發清單建立後用「同一份」方式另排。").weak());
                    let mut rm_part: Option<usize> = None;
                    let part_count = self.send_series.len();
                    for (i, part) in self.send_series.iter_mut().enumerate() {
                        ui.horizontal(|ui| {
                            ui.label(format!("第 {} 份:", i + 1));
                            ui.add(egui::TextEdit::multiline(part).desired_rows(2).desired_width(480.0).hint_text("這一課的文字內容"));
                            if part_count > 1 && ui.button("刪除").clicked() {
                                rm_part = Some(i);
                            }
                        });
                    }
                    if let Some(i) = rm_part {
                        self.send_series.remove(i);
                    }
                    if ui.button("再加一份").clicked() {
                        self.send_series.push(String::new());
                    }
                }
                ui.horizontal(|ui| {
                    ui.label("週期:");
                    ui.selectable_value(&mut self.send_cycle, "daily".to_string(), "每日");
                    ui.selectable_value(&mut self.send_cycle, "weekly".to_string(), "每週");
                    ui.selectable_value(&mut self.send_cycle, "monthly".to_string(), "每月");
                    ui.label("時間:");
                    ui.add(egui::TextEdit::singleline(&mut self.send_time).desired_width(70.0).hint_text("09:00"));
                });
                if self.send_cycle == "weekly" {
                    ui.horizontal(|ui| {
                        ui.label("星期:");
                        for (d, label) in [(0usize, "日"), (1, "一"), (2, "二"), (3, "三"), (4, "四"), (5, "五"), (6, "六")] {
                            ui.checkbox(&mut self.send_weekdays[d], label);
                        }
                    });
                }
                if self.send_cycle == "monthly" {
                    ui.horizontal(|ui| {
                        ui.label("每月幾號:");
                        ui.add(egui::DragValue::new(&mut self.send_month_day).range(1..=31));
                    });
                }
            }
        });
        ui.add_space(10.0);
        card(ui, self.palette, "預覽確認", |ui| {
            let when = match self.send_mode.as_str() {
                "once" => format!("排程一次: {}", if self.send_once_at.is_empty() { "(尚未填時間)" } else { &self.send_once_at }),
                "repeat" => format!("重複發: {} / {} {}", if self.send_repeat_kind == "series" { "依序發下一份" } else { "同一份" }, self.send_cycle, self.send_time),
                _ => "立即發送".to_string(),
            };
            ui.label(format!("發到: {}", if self.send_chat_name.is_empty() { "(尚未選群組)" } else { &self.send_chat_name }));
            ui.label(format!("時間: {when}"));
            let is_series = self.send_mode == "repeat" && self.send_repeat_kind == "series";
            if is_series {
                ui.label(format!("內容: 整套 {} 份, 第一份: {}", self.send_series.len(), self.send_series.first().map(|s| s.chars().take(40).collect::<String>()).unwrap_or_default()));
            } else {
                let preview: String = self.send_text.chars().take(80).collect();
                let media_note = if self.send_images.is_empty() && self.send_files.is_empty() { String::new() } else { format!(" (另附圖片 {} 張、檔案 {} 個)", self.send_images.len(), self.send_files.len()) };
                ui.label(format!("內容: {preview}{media_note}"));
            }
            ui.horizontal(|ui| {
                let acting = self.busy.get("outbox_action").copied().unwrap_or(false);
                if primary_btn(ui, self.palette, if acting { "建立中…" } else { "確認, 存進待發清單" }).clicked() && !acting {
                    if self.send_chat_id.is_empty() {
                        self.send_msg = Some("請先選群組".to_string());
                    } else if is_series && self.send_series.iter().any(|p| p.trim().is_empty()) {
                        self.send_msg = Some("整套教材每一份都要先填文字 (空白的那份請填好或刪掉)".to_string());
                    } else if !is_series && self.send_text.trim().is_empty() && self.send_images.is_empty() && self.send_files.is_empty() {
                        self.send_msg = Some("請先選內容: 填文字、選圖片或選檔案, 至少一樣".to_string());
                    } else if self.send_images.iter().any(|im| im.size > 10 * 1024 * 1024) || self.send_files.iter().any(|f| f.size > 10 * 1024 * 1024) {
                        self.send_msg = Some("有圖片或檔案超過 10MB, 請先移除再建立".to_string());
                    } else {
                        let schedule = if self.send_mode == "once" {
                            let at = format!("{}:00+08:00", self.send_once_at.trim().replace(' ', "T"));
                            serde_json::json!({ "mode": "once", "at": at })
                        } else if self.send_mode == "repeat" {
                            let weekdays: Vec<u64> = self.send_weekdays.iter().enumerate().filter(|(_, on)| **on).map(|(d, _)| d as u64).collect();
                            serde_json::json!({ "mode": "repeat", "repeat": { "kind": self.send_repeat_kind, "cycle": self.send_cycle, "time": self.send_time, "weekdays": weekdays, "monthDay": self.send_month_day } })
                        } else {
                            serde_json::json!({ "mode": "now" })
                        };
                        let images: Vec<Value> = self.send_images.iter().map(|im| serde_json::json!({ "name": im.name, "sizeBytes": im.size, "ref": im.ref_path })).collect();
                        let files: Vec<Value> = self.send_files.iter().map(|f| serde_json::json!({ "name": f.name, "sizeBytes": f.size, "ref": f.ref_path })).collect();
                        let mut items = serde_json::json!({});
                        if !self.send_text.trim().is_empty() {
                            items["text"] = serde_json::json!(self.send_text);
                        }
                        if !images.is_empty() {
                            items["images"] = serde_json::json!(images);
                        }
                        if !files.is_empty() {
                            items["files"] = serde_json::json!(files);
                        }
                        let mut body = serde_json::json!({
                            "chatId": self.send_chat_id,
                            "chatName": self.send_chat_name,
                            "items": items,
                            "schedule": schedule
                        });
                        if is_series {
                            // 系列的每一份是獨立內容; entry.items 只放第一份當預覽 (helper 驗證規則)
                            let parts: Vec<Value> = self.send_series.iter().map(|p| serde_json::json!({ "text": p })).collect();
                            body["seriesItems"] = serde_json::json!(parts);
                            body["items"] = serde_json::json!({ "text": self.send_series.first().cloned().unwrap_or_default() });
                        }
                        self.start_outbox_create(&ctx, body);
                    }
                }
                if let Some(m) = &self.send_msg {
                    ui.label(m.clone());
                }
            });
        });
        ui.add_space(10.0);
        card(ui, self.palette, "待發清單", |ui| {
            if ui.button("重新讀取").clicked() {
                self.outbox_attempted = true;
                self.spawn_outbox_load(&ctx);
            }
            let pending: Vec<Value> = self.outbox_entries.iter().filter(|e| {
                matches!(e.get("status").and_then(|s| s.as_str()), Some("pending") | Some("paused"))
            }).cloned().collect();
            if pending.is_empty() {
                ui.label(egui::RichText::new("目前沒有待發的訊息。").weak());
            }
            for e in &pending {
                let id = e.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let name = e.get("chatName").and_then(|v| v.as_str()).unwrap_or("(未命名群組)");
                let status = outbox_status_label(e);
                let overdue = e.get("overdue").and_then(|v| v.as_bool()).unwrap_or(false);
                let is_paused = e.get("status").and_then(|s| s.as_str()) == Some("paused");
                let last_note = e.get("history").and_then(|h| h.as_array()).and_then(|a| a.last())
                    .and_then(|h| h.get("note")).and_then(|n| n.as_str()).unwrap_or("");
                let has_failed_item = e.get("itemResults").and_then(|r| r.as_array())
                    .map(|arr| arr.iter().any(|x| x.get("ok").and_then(|b| b.as_bool()) == Some(false)))
                    .unwrap_or(false);
                ui.horizontal(|ui| {
                    ui.label(format!("{name} — {status}"));
                    if has_failed_item && ui.button("重送失敗的項目").clicked() {
                        self.start_outbox_send_now(&ctx, e.clone(), true);
                    }
                    if overdue && ui.button("補發").clicked() {
                        self.start_outbox_send_now(&ctx, e.clone(), false);
                    }
                    if is_paused && ui.button("恢復").clicked() {
                        self.start_outbox_pause(&ctx, id.clone(), false);
                    }
                    if !is_paused && ui.button("暫停").clicked() {
                        self.start_outbox_pause(&ctx, id.clone(), true);
                    }
                    if ui.button("取消").clicked() {
                        self.start_outbox_cancel(&ctx, id.clone());
                    }
                });
                if !last_note.is_empty() {
                    ui.label(egui::RichText::new(format!("　{last_note}")).weak());
                }
            }
        });
        ui.add_space(10.0);
        card(ui, self.palette, "發送紀錄", |ui| {
            let done: Vec<Value> = self.outbox_entries.iter().filter(|e| {
                !matches!(e.get("status").and_then(|s| s.as_str()), Some("pending") | Some("paused"))
            }).cloned().collect();
            if done.is_empty() {
                ui.label(egui::RichText::new("還沒有發送紀錄。").weak());
            }
            for e in done.iter().take(20) {
                let name = e.get("chatName").and_then(|v| v.as_str()).unwrap_or("(未命名群組)");
                let status = outbox_status_label(e);
                let last_note = e.get("history").and_then(|h| h.as_array()).and_then(|a| a.last())
                    .and_then(|h| h.get("note")).and_then(|n| n.as_str()).unwrap_or("");
                ui.label(format!("{name} — {status} ({last_note})"));
                // 逐項成敗: 哪一項送出、哪一項失敗與原因, 一項一行寫清楚
                let flat = pagesend::flatten_entry(e);
                let results = e.get("itemResults").and_then(|r| r.as_array());
                for (i, item) in flat.iter().enumerate() {
                    let r = results.and_then(|arr| arr.get(i));
                    let ok = r.and_then(|x| x.get("ok")).and_then(|b| b.as_bool()).unwrap_or(false);
                    let note = r.and_then(|x| x.get("note")).and_then(|n| n.as_str()).unwrap_or("");
                    if ok {
                        ui.label(format!("　・{}: 已送出", item.label));
                    } else if r.is_some() {
                        ui.label(egui::RichText::new(format!("　・{}: 失敗 — {note}", item.label)).color(self.palette.bad));
                    }
                }
                let st = e.get("status").and_then(|s| s.as_str()).unwrap_or("");
                if (st == "partial" || st == "failed") && ui.button("重送失敗的項目").clicked() {
                    self.start_outbox_send_now(&ctx, e.clone(), true);
                }
            }
        });
    }

    fn page_kb(&mut self, ui: &mut egui::Ui) {
        ui.heading("知識庫");
        ui.add_space(8.0);
        // 知識庫設定改到「聊天室管理」頁上方全域區 (修復版6後續修復, 一份設定只有一個家):
        // 這裡只留指路與唯讀索引狀態, 不再放可改欄位 (資料夾、附上參考來源、重新建立索引都在管理頁)。
        card(ui, self.palette, "知識庫設定改到「聊天室管理」頁", |ui| {
            ui.label("全域知識庫資料夾、回答時附上參考來源、重新建立索引, 都改到「聊天室管理」頁最上方的全域區改, 這裡不再放第二份。");
            if ui.button("去「聊天室管理」頁改知識庫設定").clicked() {
                self.page = Page::ChatManage;
            }
            ui.add_space(6.0);
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
            ui.label("運作方式: 本機規則先預篩, 可疑訊息再送判讀; 有啟用下方 Jev 時優先由 Jev 判讀, Jev 連不上會自動改用 AI 判讀, 不會漏掉。超過門檻會在群組回覆警告。");
            ui.add_space(6.0);
            ui.checkbox(&mut self.form.jev_enabled, "啟用 TypeSafe Jev 判讀 (付費服務, 需要先貼上 Jev API Key)");
            ui.horizontal(|ui| {
                ui.label("Jev API Key:");
                ui.add(egui::TextEdit::singleline(&mut self.form.jev_key_input).password(true).desired_width(320.0).hint_text("貼上 TypeSafe 的 API Key"));
            });
            ui.horizontal(|ui| {
                if self.form.jev_key_clear {
                    ui.label("按「儲存設定」後會清除目前儲存的金鑰。");
                } else if self.form.jev_key_configured {
                    ui.label(format!("已儲存的 Key: 末 4 碼 {}", self.form.jev_key_last4));
                    if ui.button("清除金鑰").clicked() {
                        self.form.jev_key_clear = true;
                        self.form.jev_key_input.clear();
                    }
                } else {
                    ui.label("尚未設定 Key");
                }
            });
            ui.horizontal(|ui| {
                ui.label("Jev 模型:");
                ui.add(egui::TextEdit::singleline(&mut self.form.jev_model).desired_width(200.0));
            });
            // Jev 誠實狀態: 只有 helper 回報真的判讀成功過才顯示「已接通」, 不用推測冒充
            let jev_status = {
                let snap = self.snap.lock().unwrap();
                snap.status
                    .as_ref()
                    .and_then(|s| s.get("bot"))
                    .and_then(|b| b.get("scam"))
                    .map(|scam| {
                        let state = scam.get("jevState").and_then(|v| v.as_str()).unwrap_or("unconfigured");
                        let err = scam.get("jevLastError").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        (state.to_string(), err)
                    })
            };
            match jev_status {
                Some((state, err)) => {
                    let line = match state.as_str() {
                        "ok" => "Jev 狀態: 已接通".to_string(),
                        "unverified" => "Jev 狀態: 已設定、尚未驗證 (等第一則判讀)".to_string(),
                        "error" => "Jev 狀態: 連不上, 已自動改用 AI 判讀".to_string(),
                        _ => "Jev 狀態: 尚未設定金鑰".to_string(),
                    };
                    ui.label(line);
                    if state == "error" && !err.is_empty() {
                        ui.label(egui::RichText::new(err).weak().small());
                    }
                }
                None => {
                    ui.label("Jev 狀態: 尚未取得 (等設定服務回應)");
                }
            }
            ui.label(egui::RichText::new("貼上新金鑰或清除金鑰後, 要把 AI寶 完全結束再重新開啟, 核心才會載入新金鑰生效 (跟白名單改完要重開一樣)。").weak().small());
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

    /// 紀錄頁讀取 (2026-10-22 事故修復): 直接讀本機紀錄檔, 不經服務 API —
    /// 舊版引擎沒開時 get_logs 必然失敗, slot 回 {} 被消費成空字串, 畫面就是
    /// 「讀取中」之後一片空白, 使用者最需要紀錄的時候反而看不到。
    fn load_logs(&mut self, ctx: &egui::Context) {
        if self.busy.get("logs").copied().unwrap_or(false) {
            return;
        }
        self.busy.insert("logs".into(), true);
        self.logs_attempted = true;
        let slot = self.logs_slot.clone();
        let ctx2 = ctx.clone();
        std::thread::spawn(move || {
            let text = shell::read_logs_tail(500);
            *slot.lock().unwrap() = Some(serde_json::json!({
                "tail": text,
                "dir": shell::logs_dir().to_string_lossy(),
            }));
            ctx2.request_repaint();
        });
    }

    fn page_logs(&mut self, ui: &mut egui::Ui) {
        ui.heading("紀錄");
        ui.add_space(8.0);
        let ctx = ui.ctx().clone();
        // 進頁自動讀一次 (舊版要先按「重新讀取」才有動作, 沒按就永遠空白)。
        if !self.logs_attempted {
            self.load_logs(&ctx);
        }
        card(ui, self.palette, "今日紀錄", |ui| {
            ui.horizontal(|ui| {
                let busy = self.busy.get("logs").copied().unwrap_or(false);
                if ui.button(if busy { "讀取中…" } else { "重新讀取" }).clicked() && !busy {
                    self.load_logs(&ctx);
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
                // 讀取中就明說讀取中, 不要讓使用者對著空白猜 (2026-10-22 事故修復)。
                let shown = if self.logs_text.is_empty() {
                    if self.busy.get("logs").copied().unwrap_or(false) {
                        "讀取中…".to_string()
                    } else {
                        "尚無紀錄內容。".to_string()
                    }
                } else {
                    self.logs_text.clone()
                };
                // 可選取複製: 用可選字 Label (舊作法是不可選的唯讀文字框, 使用者反應沒辦法複製 — 2026-10-20 實機)
                ui.add(
                    egui::Label::new(egui::RichText::new(shown).monospace())
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
                ui.checkbox(&mut enabled, "隨 Windows 開機自動啟動");
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
                ui.label("勾選後, 每次登入 Windows, AI寶 會自己打開, 縮在右下角系統匣待命。這個開關只負責把程式叫起來; 要不要接著自動登入 LINE, 由下面那個開關決定, 兩個互不影響。取消勾選就完全移除, 不留殘留。");
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
            // 自動登入開關 (2026-10-22 新增, 與開機自啟動互相獨立): 預設關閉。
            // 打開的當下若引擎還沒啟動, 直接啟用 (馬上生效, 不用重開程式);
            // 關閉只影響「下次打開程式」: 下次會停在未登入, 等使用者按「登入並啟用」。
            let mut auto_login = self.shell_settings.auto_login;
            if ui.checkbox(&mut auto_login, "開啟程式時自動登入並啟用服務").changed() {
                self.shell_settings.auto_login = auto_login;
                self.shell_settings.save();
                if auto_login && matches!(self.engine_snap.state, EngineState::NotStarted) {
                    self.start_engine("程式設定頁「自動登入」開關");
                }
            }
            ui.label("不勾選 (出廠預設): 每次打開 AI寶, 它會先停在未登入的狀態, 要你按「登入並啟用」才會開始服務。勾選: 打開就自動登入、直接上工。跟上面「隨 Windows 開機自動啟動」是兩個獨立開關: 可以只開機自啟動、不自動登入 (開機後在系統匣待命, 等你按登入), 也可以兩個都開或都關。");
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
                    self.restart_engine("程式設定頁「重新啟動引擎」按鈕");
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
    use super::{
        chat_profile_dirty, chat_profile_uses_custom, chat_profiles_new_orig, chat_profiles_patch, current_situation,
        decode_image_rgba, icon_rgba, parse_start_page, rate_limits_from_settings, App, AuthState, ChatProfileForm,
        EngineOpGate, EngineState, Page, SituationAction, NAV_PAGES,
    };
    use std::collections::HashMap;
    use std::io::Cursor;

    fn profile(role: &str) -> ChatProfileForm {
        ChatProfileForm {
            custom: true,
            role: role.to_string(),
            scope: "範圍".to_string(),
            kb_enabled: true,
            kb_folder: String::new(),
            suspended: false,
            chatty: false,
            admins: Vec::new(),
        }
    }

    #[test]
    fn chat_profile_dirty_matches_patch_semantics() {
        // 修復版6後續修復: 管理頁「尚未儲存」標示的語意必須與補丁規則一致,
        // 否則標示會在「明明存不進去」或「明明沒改」時說謊。
        let fresh = ChatProfileForm::default();
        assert!(!chat_profile_dirty(Some(&fresh), None), "剛點進沒自訂的室不能顯示尚未儲存");
        let chatty_only = ChatProfileForm { chatty: true, ..Default::default() };
        assert!(chat_profile_dirty(Some(&chatty_only), None), "只開聒噪要算改");
        let saved = profile("角色A");
        assert!(!chat_profile_dirty(Some(&saved), Some(&saved)), "沒動過不能顯示尚未儲存");
        let mut edited = profile("角色A");
        edited.scope = "改過的範圍".to_string();
        assert!(chat_profile_dirty(Some(&edited), Some(&saved)), "改過範圍要算改");
        assert!(!chat_profile_dirty(None, Some(&saved)), "沒草稿不能算改");
    }

    #[test]
    fn current_situation_priority() {
        // 總覽「目前情況」優先順序: 佔用 → 失敗 → 啟動中 → 未啟動 → 登入態 →
        // 機器人未連線 → 解密被擋 → 今日警告 → 正常。狀態還沒抓到 (None) 時跳過、不誤報。
        let foreign = crate::engine::foreign_port_message();
        let (_, a) = current_situation(
            &EngineState::Failed(foreign.clone()),
            &AuthState::Ready,
            Some(true),
            0,
            Some(0),
        );
        assert_eq!(a, SituationAction::SwitchPorts, "連接埠被佔用要先於一切提示換埠");
        let (_, a) = current_situation(
            &EngineState::Failed("啟動失敗測試".to_string()),
            &AuthState::Ready,
            Some(true),
            0,
            Some(0),
        );
        assert_eq!(a, SituationAction::RestartEngine);
        let (_, a) = current_situation(&EngineState::Starting, &AuthState::Unknown, None, 0, None);
        assert_eq!(a, SituationAction::None, "啟動中只是等候、不要給按鈕");
        let (_, a) = current_situation(&EngineState::NotStarted, &AuthState::Unknown, None, 0, None);
        assert_eq!(a, SituationAction::StartEngine);
        let (_, a) =
            current_situation(&EngineState::Running, &AuthState::Authenticating, None, 0, None);
        assert_eq!(a, SituationAction::None, "等掃碼時不要催登入");
        let (_, a) = current_situation(&EngineState::Running, &AuthState::Error, None, 0, None);
        assert_eq!(a, SituationAction::StartLogin);
        let (_, a) = current_situation(&EngineState::Running, &AuthState::Idle, None, 0, None);
        assert_eq!(a, SituationAction::StartLogin);
        let (_, a) = current_situation(
            &EngineState::Running,
            &AuthState::Ready,
            Some(false),
            0,
            Some(0),
        );
        assert_eq!(a, SituationAction::RestartEngine, "機器人未連線要先於警告提示重啟");
        let (_, a) = current_situation(
            &EngineState::Running,
            &AuthState::Ready,
            Some(true),
            3,
            Some(0),
        );
        assert_eq!(a, SituationAction::ViewLogs, "解密被擋要先於警告提示看紀錄");
        let (_, a) = current_situation(
            &EngineState::Running,
            &AuthState::Ready,
            Some(true),
            0,
            Some(2),
        );
        assert_eq!(a, SituationAction::ViewLogs);
        let (t, a) = current_situation(
            &EngineState::Running,
            &AuthState::Ready,
            Some(true),
            0,
            Some(0),
        );
        assert_eq!(a, SituationAction::None);
        assert!(t.contains("目前正常"), "全綠時要寫目前正常, 不能留空白或誤報: {t}");
        let (_, a) =
            current_situation(&EngineState::Running, &AuthState::Ready, None, 0, None);
        assert_eq!(a, SituationAction::None, "控制台狀態還沒抓到時不誤報未連線");
    }

    #[test]
    fn pick_free_port_pair_shape() {
        // 挑埠只驗形狀與範圍 (不動全域執行期連接埠, 避免測試互相污染):
        // 核心在 3801..=3999、控制台在其後 4000 以內、兩埠相異。
        if let Some((core, helper)) = crate::engine::pick_free_port_pair() {
            assert!((3801..=3999).contains(&core), "核心埠超出預期區間: {core}");
            assert!(helper > core && helper <= 4000, "控制台埠應在核心之後、4000 以內: {helper}");
            assert_ne!(core, helper);
        }
    }

    #[test]
    fn chatview_hidden_reason_priority() {
        // 修復版6後續修復: 狀態行原因的優先順序必須與 page_chat 的 want 條件一致:
        // 系統匣 > 最小化 > 確認結束 > 確認登出 > 系統匣提示 > 正在結束; 全無才顯示。
        assert_eq!(
            App::chatview_hidden_reason(true, true, true, true, true, true),
            Some("視窗目前縮到系統匣")
        );
        assert_eq!(
            App::chatview_hidden_reason(false, true, true, true, true, true),
            Some("視窗目前是最小化")
        );
        assert_eq!(
            App::chatview_hidden_reason(false, false, true, true, true, true),
            Some("正在確認結束程式")
        );
        assert_eq!(
            App::chatview_hidden_reason(false, false, false, true, true, true),
            Some("正在確認登出")
        );
        assert_eq!(
            App::chatview_hidden_reason(false, false, false, false, true, true),
            Some("正在顯示系統匣提示")
        );
        assert_eq!(
            App::chatview_hidden_reason(false, false, false, false, false, true),
            Some("正在結束程式")
        );
        assert_eq!(
            App::chatview_hidden_reason(false, false, false, false, false, false),
            None
        );
    }

    #[test]
    fn chat_profiles_patch_chatty_only_entry_lifecycle() {
        // 修復版5: 只開聒噪 (人設仍用預設) 也要存成一包 (personaCustom=false, chatty=true);
        // 把聒噪關掉且人設用預設時, 條目要刪掉 (送 null); 人設自訂的群只改聒噪要送完整物件。
        let chatty_only = ChatProfileForm { custom: false, chatty: true, ..Default::default() };
        let orig = HashMap::new();
        let mut forms = HashMap::new();
        forms.insert("c-chatty".to_string(), chatty_only);
        let patch = chat_profiles_patch(&forms, &orig);
        let v = patch.get("c-chatty").expect("只開聒噪的群要送出條目");
        assert_eq!(v.get("chatty").and_then(|x| x.as_bool()), Some(true));
        assert_eq!(v.get("personaCustom").and_then(|x| x.as_bool()), Some(false), "只開聒噪時人設必須標記為用預設");
        let new_orig = chat_profiles_new_orig(&forms, &orig, &patch);
        assert!(new_orig.get("c-chatty").unwrap().chatty);
        let mut forms2 = new_orig.clone();
        forms2.get_mut("c-chatty").unwrap().chatty = false;
        let patch2 = chat_profiles_patch(&forms2, &new_orig);
        assert!(patch2.get("c-chatty").map(|v| v.is_null()).unwrap_or(false), "聒噪關掉且人設用預設時應刪除條目");
        let mut orig3 = HashMap::new();
        orig3.insert("c-cust".to_string(), profile("角色A"));
        let mut forms3 = orig3.clone();
        forms3.get_mut("c-cust").unwrap().chatty = true;
        let patch3 = chat_profiles_patch(&forms3, &orig3);
        let v3 = patch3.get("c-cust").expect("人設自訂的群改聒噪要送完整物件");
        assert_eq!(v3.get("personaCustom").and_then(|x| x.as_bool()), Some(true));
        assert_eq!(v3.get("chatty").and_then(|x| x.as_bool()), Some(true));
        // from_value: 舊存檔沒有 chatty/personaCustom 時, 人設視為自訂、聒噪視為關閉 (修復版4 行為不變)
        let legacy = ChatProfileForm::from_value(&serde_json::json!({ "rolePrompt": "舊角色" }));
        assert!(legacy.custom && !legacy.chatty);
        let co = ChatProfileForm::from_value(&serde_json::json!({ "chatty": true, "personaCustom": false }));
        assert!(!co.custom && co.chatty);
    }

    #[test]
    fn chat_profiles_patch_only_sends_changed_chats() {
        // 分群儲存補丁: 沒改的群不送、新自訂送完整物件、只改 suspended 也併進完整物件。
        let mut orig = HashMap::new();
        orig.insert("c-same".to_string(), profile("角色A"));
        orig.insert("c-susp".to_string(), profile("角色B"));
        let mut forms = orig.clone();
        forms.get_mut("c-susp").unwrap().suspended = true;
        forms.insert("c-new".to_string(), profile("角色C"));
        let patch = chat_profiles_patch(&forms, &orig);
        assert!(!patch.contains_key("c-same"), "沒變更的群不應出現在補丁裡");
        let susp = patch.get("c-susp").expect("suspended 變更的群要送");
        assert_eq!(susp.get("suspended").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(susp.get("rolePrompt").and_then(|v| v.as_str()), Some("角色B"), "改過的群送完整物件");
        let new = patch.get("c-new").expect("新自訂的群要送");
        assert_eq!(new.get("kbEnabled").and_then(|v| v.as_bool()), Some(true));
        // 新原貌: 補丁套用後, 三個群都在、值是表單目前值
        let new_orig = chat_profiles_new_orig(&forms, &orig, &patch);
        assert_eq!(new_orig.len(), 3);
        assert!(new_orig.get("c-susp").unwrap().suspended);
    }

    #[test]
    fn chat_profiles_patch_switch_back_to_default_sends_null() {
        // 切回用預設 (custom=false) 與表單移除都送 null 刪除; 原本就用預設的群不送任何東西。
        let mut orig = HashMap::new();
        orig.insert("c-back".to_string(), profile("角色A"));
        orig.insert("c-gone".to_string(), profile("角色B"));
        let mut forms = HashMap::new();
        let mut back = profile("角色A");
        back.custom = false;
        forms.insert("c-back".to_string(), back);
        forms.insert("c-fresh".to_string(), ChatProfileForm::default());
        let patch = chat_profiles_patch(&forms, &orig);
        assert!(patch.get("c-back").map(|v| v.is_null()).unwrap_or(false), "切回用預設要送 null");
        assert!(patch.get("c-gone").map(|v| v.is_null()).unwrap_or(false), "原貌有、表單沒有要送 null");
        assert!(!patch.contains_key("c-fresh"), "從未自訂的群不送");
        let new_orig = chat_profiles_new_orig(&forms, &orig, &patch);
        assert!(new_orig.is_empty(), "刪除後新原貌不應再有這兩個群");
    }

    #[test]
    fn nav_pages_are_repair6_order_without_line_login() {
        // 修復版6 導覽定案: 共 11 頁, 順序固定, 沒有獨立的 LINE 登入頁, 有聊天室管理頁。
        let pages: Vec<Page> = NAV_PAGES.iter().map(|(p, _)| *p).collect();
        assert_eq!(
            pages,
            vec![
                Page::Overview,
                Page::ChatRoom,
                Page::ChatManage,
                Page::SendMessages,
                Page::AiSettings,
                Page::BotSettings,
                Page::KbSettings,
                Page::ScamSettings,
                Page::Logs,
                Page::AppSettings,
                Page::About,
            ]
        );
        let labels: Vec<&str> = NAV_PAGES.iter().map(|(_, l)| *l).collect();
        assert_eq!(labels[0], "總覽");
        assert_eq!(labels[2], "聊天室管理");
        assert!(!labels.contains(&"LINE 登入"), "導覽不應再有獨立的 LINE 登入頁");
    }

    #[test]
    fn start_page_parsing_covers_all_pages_and_legacy_login() {
        // AIBAO_START_PAGE: 11 頁都有代號; 舊值 login 映射到總覽 (CI 相容); 未知值回總覽。
        assert_eq!(parse_start_page(Some("overview")), Page::Overview);
        assert_eq!(parse_start_page(Some("chat")), Page::ChatRoom);
        assert_eq!(parse_start_page(Some("manage")), Page::ChatManage);
        assert_eq!(parse_start_page(Some("send")), Page::SendMessages);
        assert_eq!(parse_start_page(Some("ai")), Page::AiSettings);
        assert_eq!(parse_start_page(Some("bot")), Page::BotSettings);
        assert_eq!(parse_start_page(Some("kb")), Page::KbSettings);
        assert_eq!(parse_start_page(Some("scam")), Page::ScamSettings);
        assert_eq!(parse_start_page(Some("logs")), Page::Logs);
        assert_eq!(parse_start_page(Some("app")), Page::AppSettings);
        assert_eq!(parse_start_page(Some("about")), Page::About);
        assert_eq!(parse_start_page(Some("login")), Page::Overview, "舊值 login 要映射到總覽");
        assert_eq!(parse_start_page(Some("unknown")), Page::Overview);
        assert_eq!(parse_start_page(None), Page::Overview);
    }

    #[test]
    fn chat_profiles_patch_admins_only_entry_lifecycle() {
        // 修復版6: 只設本聊天室管理員 (人設仍用預設) 也要存成一包 (personaCustom=false, admins 有值);
        // 管理員清空且沒有其他自訂時條目刪除; 人設切回全域時管理員不連帶刪除 (條目保留、管理員照舊)。
        let admins_only = ChatProfileForm {
            custom: false,
            admins: vec![("u-admin".to_string(), "王管理員".to_string())],
            ..Default::default()
        };
        assert!(admins_only.has_entry(), "只設管理員也需要條目");
        let orig = HashMap::new();
        let mut forms = HashMap::new();
        forms.insert("c-admin".to_string(), admins_only);
        let patch = chat_profiles_patch(&forms, &orig);
        let v = patch.get("c-admin").expect("只設管理員的聊天室要送出條目");
        assert_eq!(v.get("personaCustom").and_then(|x| x.as_bool()), Some(false));
        let admins = v.get("admins").and_then(|x| x.as_array()).expect("補丁要帶 admins 陣列");
        assert_eq!(admins.len(), 1);
        assert_eq!(admins[0].get("id").and_then(|x| x.as_str()), Some("u-admin"));
        assert_eq!(admins[0].get("name").and_then(|x| x.as_str()), Some("王管理員"));
        let new_orig = chat_profiles_new_orig(&forms, &orig, &patch);
        assert_eq!(new_orig.get("c-admin").unwrap().admins.len(), 1);
        // from_value 讀回 admins
        let back = ChatProfileForm::from_value(&v);
        assert_eq!(back.admins, vec![("u-admin".to_string(), "王管理員".to_string())]);
        assert!(!back.custom);
        // 管理員清空 -> 刪除條目
        let mut forms2 = new_orig.clone();
        forms2.get_mut("c-admin").unwrap().admins.clear();
        let patch2 = chat_profiles_patch(&forms2, &new_orig);
        assert!(patch2.get("c-admin").map(|x| x.is_null()).unwrap_or(false), "管理員清空且無其他自訂時應刪除條目");
        // 人設自訂的群切回全域, 但管理員還在: 條目保留 (不送 null), personaCustom=false、管理員照舊
        let mut orig3 = HashMap::new();
        let mut with_admins = profile("角色A");
        with_admins.admins = vec![("u-admin".to_string(), "王管理員".to_string())];
        orig3.insert("c-mix".to_string(), with_admins);
        let mut forms3 = orig3.clone();
        forms3.get_mut("c-mix").unwrap().custom = false;
        let patch3 = chat_profiles_patch(&forms3, &orig3);
        let v3 = patch3.get("c-mix").expect("切回全域但管理員還在時要送完整物件, 不是刪除");
        assert!(!v3.is_null());
        assert_eq!(v3.get("personaCustom").and_then(|x| x.as_bool()), Some(false));
        assert_eq!(v3.get("admins").and_then(|x| x.as_array()).map(|a| a.len()), Some(1));
    }

    #[test]
    fn chat_profile_effective_source_judgement() {
        // 生效來源判定: 只有 personaCustom=true 才算用本聊天室設定;
        // 只開聒噪、只設管理員、沒有條目, 人設都還是用全域預設。
        assert!(!chat_profile_uses_custom(None));
        assert!(!chat_profile_uses_custom(Some(&ChatProfileForm::default())));
        let chatty_only = ChatProfileForm { custom: false, chatty: true, ..Default::default() };
        assert!(!chat_profile_uses_custom(Some(&chatty_only)), "只開聒噪不影響人設來源");
        let admins_only = ChatProfileForm {
            custom: false,
            admins: vec![("u1".to_string(), "甲".to_string())],
            ..Default::default()
        };
        assert!(!chat_profile_uses_custom(Some(&admins_only)), "只設管理員不影響人設來源");
        assert!(chat_profile_uses_custom(Some(&profile("角色"))));
    }

    #[test]
    fn rate_limits_settings_round_trip() {
        // 修復版7: 兩個 60 秒視窗上限的讀寫來回 — 寫進設定 JSON 的鍵名與讀回來的解析必須對得上;
        // 舊存檔沒有欄位時回出廠預設 (3 / 10); 使用者填的 0 (不限制) 要原樣保留, 不可被預設蓋掉。
        let body = serde_json::json!({ "perUserChatMinuteLimit": 5, "allChatsMinuteLimit": 30 });
        assert_eq!(rate_limits_from_settings(&body), (5, 30));
        let legacy = serde_json::json!({ "cooldownSec": 20, "dailyLimit": 100 });
        assert_eq!(rate_limits_from_settings(&legacy), (3, 10), "舊存檔缺欄位要用出廠預設");
        let zero = serde_json::json!({ "perUserChatMinuteLimit": 0, "allChatsMinuteLimit": 0 });
        assert_eq!(rate_limits_from_settings(&zero), (0, 0), "0 是不限制, 不能被當成缺欄位");
    }

    #[test]
    fn engine_op_gate_blocks_reentry_until_end() {
        // 2026-10-22 循環事故的修法核心: 第一個操作進行中, 第二個要求必須被擋下
        // (不排隊); 第一個結束後才准下一個進來。
        let gate = EngineOpGate::new();
        assert!(gate.try_begin("重新啟動引擎", "測試來源 A"));
        assert!(!gate.try_begin("重新啟動引擎", "測試來源 B"), "進行中應擋下重入");
        assert!(!gate.try_begin("一鍵修復", "測試來源 C"), "不同操作也共用同一把鎖");
        assert!(gate.is_busy());
        gate.end("重新啟動引擎");
        assert!(!gate.is_busy());
        assert!(gate.try_begin("一鍵修復", "測試來源 D"), "釋放後應可再取得");
        gate.end("一鍵修復");
    }

    #[test]
    fn brand_icon_decodes_for_taskbar_and_tray() {
        // 問題 1 (2026-10-22): 真機回報「下方工具列 icon 沒顯示」。內嵌品牌圖本身必須
        // 解得開、且能產出工作列 (64) 與系統匣 (32) 兩種預縮尺寸 — 先證明圖與縮放沒壞,
        // 真機若仍沒顯示, 問題就在建立流程 (已改為失敗必記 log + 總覽提示)。
        for size in [32u32, 64] {
            let (rgba, w, h) = icon_rgba(size).expect("品牌圖示應可解碼並縮放");
            assert_eq!((w, h), (size, size));
            assert_eq!(rgba.len(), (size * size * 4) as usize);
            assert!(rgba.chunks_exact(4).any(|px| px[3] > 0), "圖示不應整張透明");
        }
    }

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
