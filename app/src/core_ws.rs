// 核心 WS 登入客戶端: 照上游 src/cli.ts 的非瀏覽器連線方式實作 —
// 先 HTTP GET / 取 linejs_browser cookie, 再帶 Host/Origin/Cookie 標頭升級 WS。
// 登入訊框定義見上游 src/ws/protocol.ts: 送 auth:start / auth:logout,
// 收 auth:state / auth:qr(url) / auth:pin(code) / auth:ready(profile)。
// QR URL 與 PIN 只存在於記憶體與畫面, 不寫 log、不落盤 (上游安全性硬規則)。
use std::io::Read;
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::engine::CORE_PORT;
use crate::shell;

#[derive(Debug, Clone, PartialEq)]
pub enum AuthState {
    Unknown,
    Restoring,
    Idle,
    Authenticating,
    Ready,
    Error,
}

#[derive(Debug, Clone)]
pub struct LoginUi {
    pub connected: bool,
    pub auth: AuthState,
    pub qr_url: Option<String>,
    pub pin: Option<String>,
    pub profile_name: Option<String>,
    /// 登入帳號實際頭像的本機 media id (核心 profile 的 pictureId, 不含位元組);
    /// 殼以此向核心 /media/<id> 取圖顯示, 取不到時退回品牌定版頭像。
    pub profile_picture_id: Option<String>,
    /// 登入流程開始時間 (逾時判定; 上限比照 CLI 的 LOGIN_MS 180 秒)
    pub login_started: Option<Instant>,
    pub last_error: Option<String>,
}

impl Default for LoginUi {
    fn default() -> Self {
        Self {
            connected: false,
            auth: AuthState::Unknown,
            qr_url: None,
            pin: None,
            profile_name: None,
            profile_picture_id: None,
            login_started: None,
            last_error: None,
        }
    }
}

pub enum WsCommand {
    StartLogin,
    Logout,
}

pub type SharedLogin = Arc<Mutex<LoginUi>>;

const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);

fn fetch_cookie() -> Result<String, String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(3))
        .build();
    let resp = agent
        .get(&format!("http://127.0.0.1:{CORE_PORT}/"))
        .call()
        .map_err(|e| format!("連不上核心服務: {e}"))?;
    let cookie = resp
        .header("set-cookie")
        .and_then(|v| v.split(';').next())
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "核心服務沒有回傳登入 cookie".to_string())?;
    Ok(cookie)
}

/// 取登入帳號實際頭像的位元組: 核心 /media/<pictureId> 需帶瀏覽器 cookie
/// (與 WS 連線同一套 fetch_cookie 流程)。pictureId 是核心給的不透明 id,
/// 這裡只做基本形狀檢查防路徑字元混入; 失敗回 Err 由 UI 退回品牌頭像。
pub fn fetch_profile_picture(picture_id: &str) -> Result<Vec<u8>, String> {
    if picture_id.is_empty()
        || picture_id.len() > 128
        || !picture_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("頭像編號形狀不正確".to_string());
    }
    let cookie = fetch_cookie()?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(5))
        .build();
    let resp = agent
        .get(&format!("http://127.0.0.1:{CORE_PORT}/media/{picture_id}"))
        .set("Cookie", &cookie)
        .call()
        .map_err(|e| format!("向核心取頭像失敗: {e}"))?;
    use std::io::Read;
    let mut buf = Vec::new();
    resp.into_reader()
        .take(5 * 1024 * 1024)
        .read_to_end(&mut buf)
        .map_err(|e| format!("讀取頭像資料失敗: {e}"))?;
    if buf.is_empty() {
        return Err("核心回傳的頭像是空的".to_string());
    }
    Ok(buf)
}

/// 登入背景執行緒: 維持一條 WS 連線, 斷線自動重連 (引擎重啟時能自己接回)。
/// UI 透過 SharedLogin 讀狀態、透過 commands 送指令。
pub fn spawn_login_thread(state: SharedLogin, commands: Receiver<WsCommand>, repaint: Arc<Mutex<Option<egui::Context>>>) {
    std::thread::spawn(move || {
        let poke = |state: &SharedLogin| {
            if let Ok(g) = repaint.lock() {
                if let Some(ctx) = g.as_ref() {
                    ctx.request_repaint();
                }
            }
            let _ = state;
        };
        loop {
            match run_connection(&state, &commands, &poke) {
                Ok(()) => {}
                Err(e) => {
                    let mut g = state.lock().unwrap();
                    if g.connected {
                        g.connected = false;
                        g.auth = AuthState::Unknown;
                        g.qr_url = None;
                        g.pin = None;
                    }
                    drop(g);
                    shell::log_line(&format!("核心 WS 連線中斷: {e}"));
                }
            }
            poke(&state);
            // 斷線重連間隔; 同時把排隊的指令吃掉, 避免重連後誤執行舊指令
            let wait_until = Instant::now() + Duration::from_secs(3);
            while Instant::now() < wait_until {
                match commands.try_recv() {
                    Ok(_) => { /* 重連期間的登入/登出指令不排隊執行, 請使用者連線後再按一次 */ }
                    Err(std::sync::mpsc::TryRecvError::Empty) => std::thread::sleep(Duration::from_millis(100)),
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => return,
                }
            }
        }
    });
}

/// 建立 WS 連線: 必須用 ClientRequestBuilder, 它會自動帶 Sec-WebSocket-Key 等握手標頭;
/// 2026-10-20 雲端探針實測: 用手組 http::Request 會缺 sec-websocket-key 被核心拒絕。
fn connect_ws(cookie: &str) -> Result<tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>, String> {
    let req = tungstenite::client::ClientRequestBuilder::new(
        format!("ws://127.0.0.1:{CORE_PORT}/ws").parse().map_err(|e| format!("WS 位址錯誤: {e:?}"))?,
    )
    .with_header("Host", format!("127.0.0.1:{CORE_PORT}"))
    .with_header("Origin", format!("http://127.0.0.1:{CORE_PORT}"))
    .with_header("Cookie", cookie.to_string());
    let (socket, _resp) = tungstenite::connect(req).map_err(|e| format!("WS 連線被拒: {e}"))?;
    Ok(socket)
}

fn run_connection(
    state: &SharedLogin,
    commands: &Receiver<WsCommand>,
    poke: &dyn Fn(&SharedLogin),
) -> Result<(), String> {
    let cookie = fetch_cookie()?;
    let mut socket = connect_ws(&cookie)?;
    // 設定讀取逾時, 讓主迴圈能定期檢查指令與登入逾時
    match socket.get_mut() {
        tungstenite::stream::MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
        }
        #[allow(unreachable_patterns)]
        _ => {}
    }
    {
        let mut g = state.lock().unwrap();
        g.connected = true;
    }
    shell::log_line("核心 WS 已連線");
    let mut hello_seen = false;
    let mut profile_requested = false;
    loop {
        // 指令
        match commands.try_recv() {
            Ok(WsCommand::StartLogin) => {
                {
                    let mut g = state.lock().unwrap();
                    g.login_started = Some(Instant::now());
                    g.last_error = None;
                    g.qr_url = None;
                    g.pin = None;
                }
                send_frame(&mut socket, serde_json::json!({ "type": "auth:start" }))?;
            }
            Ok(WsCommand::Logout) => {
                send_frame(&mut socket, serde_json::json!({ "type": "auth:logout" }))?;
            }
            Err(std::sync::mpsc::TryRecvError::Empty) => {}
            Err(std::sync::mpsc::TryRecvError::Disconnected) => return Ok(()),
        }
        // 登入逾時 (比照 CLI LOGIN_MS): 只清畫面上的 QR/PIN 並提示, 狀態仍以上游 auth:state 為準
        {
            let mut g = state.lock().unwrap();
            if g.auth == AuthState::Authenticating {
                if let Some(started) = g.login_started {
                    if started.elapsed() > LOGIN_TIMEOUT {
                        g.qr_url = None;
                        g.pin = None;
                        g.login_started = None;
                        g.last_error = Some("登入逾時 (超過 3 分鐘): QR 已過期, 請按「重新產生」再試一次".to_string());
                        poke(state);
                    }
                }
            }
        }
        // 收訊
        let msg = match socket.read() {
            Ok(m) => m,
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(e) => return Err(format!("WS 讀取失敗: {e}")),
        };
        let text = match msg {
            tungstenite::Message::Text(t) => t.to_string(),
            tungstenite::Message::Binary(b) => String::from_utf8_lossy(&b).to_string(),
            tungstenite::Message::Close(_) => return Err("WS 被核心關閉".to_string()),
            _ => continue,
        };
        let frame: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let ftype = frame.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match ftype {
            "hello" => {
                let proto = frame.get("protocol").and_then(|v| v.as_u64()).unwrap_or(0);
                if proto != 2 {
                    return Err(format!("核心通訊協定版本不符 (預期 2, 實際 {proto}), 請更新程式"));
                }
                hello_seen = true;
            }
            "auth:state" => {
                let s = frame.get("state").and_then(|v| v.as_str()).unwrap_or("");
                let mut g = state.lock().unwrap();
                g.auth = match s {
                    "restoring" => AuthState::Restoring,
                    "idle" => AuthState::Idle,
                    "authenticating" => AuthState::Authenticating,
                    "ready" => AuthState::Ready,
                    "error" => AuthState::Error,
                    _ => AuthState::Unknown,
                };
                if g.auth == AuthState::Ready {
                    g.qr_url = None;
                    g.pin = None;
                    g.login_started = None;
                    g.last_error = None;
                }
                if g.auth == AuthState::Error {
                    g.qr_url = None;
                    g.pin = None;
                    g.login_started = None;
                    if g.last_error.is_none() {
                        g.last_error = Some("登入失敗, 請再試一次".to_string());
                    }
                }
                if g.auth == AuthState::Idle {
                    g.profile_name = None;
                    g.profile_picture_id = None;
                    profile_requested = false;
                }
                drop(g);
                poke(state);
                // 已登入但還沒拿到 profile: 主動要一次 (auth:ready 通常會自己來, 這是備援)
                if s == "ready" && !profile_requested {
                    let has_profile = state.lock().unwrap().profile_name.is_some();
                    if !has_profile {
                        profile_requested = true;
                        let _ = send_frame(&mut socket, serde_json::json!({ "type": "profile:get", "requestId": "shell-profile-1" }));
                    }
                }
            }
            "auth:qr" => {
                // QR URL 只進記憶體與畫面, 絕不寫 log (上游硬規則)
                if let Some(url) = frame.get("url").and_then(|v| v.as_str()) {
                    let mut g = state.lock().unwrap();
                    g.qr_url = Some(url.to_string());
                    shell::log_line("已收到 QR (內容不記錄)");
                    drop(g);
                    poke(state);
                }
            }
            "auth:pin" => {
                // PIN 同上: 只顯示給使用者去手機輸入, 不寫 log、不落盤
                if let Some(code) = frame.get("code").and_then(|v| v.as_str()) {
                    let mut g = state.lock().unwrap();
                    g.pin = Some(code.to_string());
                    shell::log_line("已收到 PIN (內容不記錄)");
                    drop(g);
                    poke(state);
                }
            }
            "auth:ready" | "profile" => {
                // profile 同時帶 displayName 與 pictureId (帳號有設頭像時);
                // pictureId 只當不透明 id 透傳, 位元組由殼另向核心 /media 取。
                let profile = frame.get("profile");
                let name = profile
                    .and_then(|p| p.get("displayName"))
                    .and_then(|v| v.as_str());
                let picture = profile
                    .and_then(|p| p.get("pictureId"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty());
                if name.is_some() || picture.is_some() {
                    let mut g = state.lock().unwrap();
                    if let Some(name) = name {
                        g.profile_name = Some(name.to_string());
                    }
                    if let Some(picture) = picture {
                        g.profile_picture_id = Some(picture.to_string());
                    }
                    drop(g);
                    poke(state);
                }
            }
            "error" => {
                let code = frame.get("code").and_then(|v| v.as_str()).unwrap_or("");
                if code == "LOGIN_UNAVAILABLE" {
                    let mut g = state.lock().unwrap();
                    g.last_error = Some("目前無法開始登入: 已有登入進行中, 或已經登入了".to_string());
                    drop(g);
                    poke(state);
                } else if !code.is_empty() {
                    shell::log_line(&format!("核心回報錯誤框架: {code}"));
                }
            }
            _ => {}
        }
        let _ = hello_seen;
    }
}

fn send_frame(socket: &mut tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>, frame: serde_json::Value) -> Result<(), String> {
    socket
        .send(tungstenite::Message::Text(frame.to_string().into()))
        .map_err(|e| format!("WS 送出失敗: {e}"))
}

/// 一次性探針連線 (不經背景執行緒): 連上核心、驗 hello 與 auth:state,
/// 必要時送 auth:start 並等待 auth:qr / 錯誤狀態。回傳觀察到的事件摘要 (不含任何祕密內容)。
pub fn probe_login_roundtrip(do_start: bool, timeout: Duration) -> Vec<String> {
    let mut events: Vec<String> = Vec::new();
    let cookie = match fetch_cookie() {
        Ok(c) => {
            events.push("cookie=ok".to_string());
            c
        }
        Err(e) => {
            events.push(format!("cookie=fail:{e}"));
            return events;
        }
    };
    let mut socket = match connect_ws(&cookie) {
        Ok(s) => {
            events.push("ws=connected".to_string());
            s
        }
        Err(e) => {
            events.push(format!("ws=fail:{e}"));
            return events;
        }
    };
    if let tungstenite::stream::MaybeTlsStream::Plain(stream) = socket.get_mut() {
        let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    }
    let deadline = Instant::now() + timeout;
    let mut sent_start = false;
    let mut settled_state = String::new();
    while Instant::now() < deadline {
        let msg = match socket.read() {
            Ok(m) => m,
            Err(tungstenite::Error::Io(e))
                if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                continue;
            }
            Err(e) => {
                events.push(format!("ws_read=fail:{e}"));
                break;
            }
        };
        let text = match msg {
            tungstenite::Message::Text(t) => t.to_string(),
            tungstenite::Message::Close(_) => {
                events.push("ws=closed_by_core".to_string());
                break;
            }
            _ => continue,
        };
        let frame: serde_json::Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };
        match frame.get("type").and_then(|v| v.as_str()).unwrap_or("") {
            "hello" => {
                let proto = frame.get("protocol").and_then(|v| v.as_u64()).unwrap_or(0);
                events.push(format!("hello=protocol:{proto}"));
            }
            "auth:state" => {
                let s = frame.get("state").and_then(|v| v.as_str()).unwrap_or("").to_string();
                events.push(format!("auth_state={s}"));
                if s != "restoring" && settled_state.is_empty() {
                    settled_state = s.clone();
                    if do_start && (s == "idle" || s == "error") && !sent_start {
                        if send_frame(&mut socket, serde_json::json!({ "type": "auth:start" })).is_ok() {
                            sent_start = true;
                            events.push("auth_start=sent".to_string());
                        }
                    }
                    if s == "ready" {
                        events.push("result=already_logged_in".to_string());
                        break;
                    }
                }
                if sent_start && s == "error" {
                    events.push("result=roundtrip_error_state".to_string());
                    break;
                }
            }
            "auth:qr" => {
                // 只記「有收到」與 URL 長度, 內容絕不入記錄 (上游硬規則)
                let len = frame.get("url").and_then(|v| v.as_str()).map(|u| u.len()).unwrap_or(0);
                events.push(format!("auth_qr=received(len={len})"));
                events.push("result=roundtrip_qr".to_string());
                break;
            }
            "auth:ready" => {
                events.push("result=roundtrip_ready".to_string());
                break;
            }
            _ => {}
        }
    }
    if events.iter().all(|e| !e.starts_with("result=")) {
        events.push("result=timeout".to_string());
    }
    let _ = socket.close(None);
    events
}

// 讓 Read 在未用到的情境不產生警告的占位 (ureq 回應 body 讀取在 engine.rs 使用)
#[allow(dead_code)]
fn _unused(_: Option<&mut dyn Read>) {}
