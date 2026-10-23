//! 瀏覽器通道送出 + 發送排程決策 (第三/四階段, 2026-10-22; 檔案送出 2026-10-22 接第二階段核心通道)。
//! 分工定案: 排程計時與實際送出由 App 殼負責; 送出走核心的「網頁通道」
//! (先取 linejs_browser cookie, 再連 ws://127.0.0.1:3789/ws 不帶 scope) —
//! 與核心內建網頁同一條路: 文字可帶 mentions、圖片先 POST /media/upload 拿 mediaId 再送、
//! 一般檔案先 POST /file/upload 拿 fileId 再以 fileId 送 (第二階段介面契約, 見施工紀錄)。
//! 機器人通道 (/api/ws) 明文拒絕圖片、一般檔案與 mentions 的群組 @, 所以待發清單與管理員通知都不走那條。
//! 本模組的決策部分 (plan_entry / build_notify_text / 逐項送出組裝) 都是純函式, 有 cargo 單元測試;
//! 真正連線送出的部分只能在老吳的 Windows 實機驗證 (本機無真帳號, 見施工紀錄的未驗證清單)。

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::time::Duration;

use serde_json::{json, Value};

use crate::core_ws;
use crate::engine::CORE_PORT;

/// 有人剛進群的鑰匙交接窗口: 這段時間內不要發送 (規格護欄; 撞上就順延到窗口結束)。
pub const JOIN_GUARD_MS: i64 = 120_000;
/// 圖片單筆上限 (核心 /media/upload 的圖片上限同值)。
pub const IMAGE_MAX_BYTES: usize = 10 * 1024 * 1024;
/// 一般檔案單筆上限 (核心 limits.uploadFileMaxBytes, 預設與最高皆 10MB; 規格第一版自訂上限,
/// LINE 伺服器端的真正上限未以真帳號驗證, 不得宣稱可送滿 10MB)。
pub const FILE_MAX_BYTES: usize = 10 * 1024 * 1024;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ---------- 排程決策 (純函式) ----------

/// 一輪計時檢查時, 一筆待發可以做的事。
#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    /// 還沒到時間 (或沒有下一次時間), 這輪跳過
    NotDue,
    /// 到時間了, 可以送
    Send,
    /// 程式沒開時錯過了 (一次性/立即): 不偷發, 等使用者在待發清單按「補發」
    AwaitConfirm,
    /// 程式沒開時錯過了 (重複發): 跳過錯過的那一次, 直接算下一次
    SkipMissed,
    /// 這個群組的鑰匙不正常 (有訊息讀不到): 先暫停, 不硬發
    PauseDecrypt,
    /// 有人在交接窗口內進群: 順延到窗口結束 (值 = 新的 nextRunAt)
    DeferUntil(i64),
}

/// 判斷一筆待發這輪要怎麼做。ctx 全部由呼叫端查好再帶進來, 本函式不碰 IO。
/// - started_at_ms: 這次程式啟動的時間; nextRunAt 早於它 = 程式沒開時就到期了 (錯過)。
/// - decrypt_failed_chats: 目前有訊息讀不到的聊天室 (helper /api/status 的 bot.decrypt.issues)。
/// - recent_joins: chatId -> 最近一次有人進群的時間 (core_ws::recent_joins_snapshot)。
pub fn plan_entry(
    entry: &Value,
    now: i64,
    started_at_ms: i64,
    decrypt_failed_chats: &HashSet<String>,
    recent_joins: &HashMap<String, i64>,
) -> Plan {
    let status = entry.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if status != "pending" {
        return Plan::NotDue;
    }
    let chat_id = entry.get("chatId").and_then(|v| v.as_str()).unwrap_or("");
    // 鑰匙不正常先暫停: 就算還沒到時間也先標暫停, 使用者一眼看得出為什麼沒發
    if decrypt_failed_chats.contains(chat_id) {
        return Plan::PauseDecrypt;
    }
    let next = match entry.get("nextRunAt").and_then(|v| v.as_i64()) {
        Some(n) => n,
        None => return Plan::NotDue,
    };
    if next > now {
        return Plan::NotDue;
    }
    // 到期了。先看是不是「程式沒開時錯過」的: 到期時間早於這次啟動時間。
    if next < started_at_ms {
        let mode = entry.get("schedule").and_then(|s| s.get("mode")).and_then(|v| v.as_str()).unwrap_or("now");
        return if mode == "repeat" { Plan::SkipMissed } else { Plan::AwaitConfirm };
    }
    // 鑰匙交接窗口: 最近有人進這個群, 且窗口還沒過 -> 順延到窗口結束
    if let Some(joined_at) = recent_joins.get(chat_id) {
        let until = *joined_at + JOIN_GUARD_MS;
        if now < until {
            return Plan::DeferUntil(until);
        }
    }
    Plan::Send
}

// ---------- 逐項內容 (與 helper flattenItems 同序: 文字 -> 圖片 -> 檔案) ----------

#[derive(Debug, Clone)]
pub struct FlatItem {
    pub kind: String, // text | image | file
    pub label: String,
    pub text: String,
    pub name: String,
    pub ref_path: String,
    pub size_bytes: u64,
}

/// 這一次實際要發的內容攤平 (系列取 seriesItems[seriesIndex], 與 helper effectiveItems 一致)。
pub fn flatten_entry(entry: &Value) -> Vec<FlatItem> {
    let items = effective_items(entry);
    let mut out = Vec::new();
    if let Some(t) = items.get("text").and_then(|v| v.as_str()) {
        if !t.is_empty() {
            out.push(FlatItem { kind: "text".into(), label: "文字".into(), text: t.to_string(), name: String::new(), ref_path: String::new(), size_bytes: 0 });
        }
    }
    for (key, kind) in [("images", "image"), ("files", "file")] {
        if let Some(arr) = items.get(key).and_then(|v| v.as_array()) {
            for it in arr {
                let name = it.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                out.push(FlatItem {
                    kind: kind.into(),
                    label: if name.is_empty() { if kind == "image" { "圖片".into() } else { "檔案".into() } } else { name.clone() },
                    text: String::new(),
                    name,
                    ref_path: it.get("ref").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    size_bytes: it.get("sizeBytes").and_then(|v| v.as_u64()).unwrap_or(0),
                });
            }
        }
    }
    out
}

fn effective_items(entry: &Value) -> Value {
    let is_series = entry.get("schedule").and_then(|s| s.get("repeat")).and_then(|r| r.get("kind")).and_then(|v| v.as_str()) == Some("series");
    if is_series {
        if let Some(arr) = entry.get("seriesItems").and_then(|v| v.as_array()) {
            if !arr.is_empty() {
                let idx = entry.get("seriesIndex").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                return arr.get(idx.min(arr.len() - 1)).cloned().unwrap_or(Value::Null);
            }
        }
    }
    entry.get("items").cloned().unwrap_or(Value::Null)
}

// ---------- 管理員通知本文組裝 (純函式) ----------

/// UTF-16 code unit 數 (核心 parseMentions 以 JS 字串索引驗證 mentions, 即 UTF-16 位置)。
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 組通知訊息: mention 對象在最前面逐位 "@名字 ", 純文字對象也寫名字 (點名),
/// 後面接事件本文。回 (完整文字, mentions 陣列 [{userId, start, end}], 有沒有人走退路)。
/// mentions 的 start/end 是 UTF-16 位置, end = start + "@名字" 的 UTF-16 長度 (與 web/composer.ts 一致)。
pub fn build_notify_text(body: &str, targets: &[Value]) -> (String, Vec<Value>, bool) {
    let mut text = String::new();
    let mut mentions = Vec::new();
    let mut any_plain = false;
    for t in targets {
        let name = t.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let id = t.get("adminId").and_then(|v| v.as_str()).unwrap_or("");
        let mode = t.get("mode").and_then(|v| v.as_str()).unwrap_or("mention");
        if name.is_empty() {
            continue;
        }
        let token = format!("@{name} ");
        if mode == "mention" && !id.is_empty() {
            let start = utf16_len(&text);
            let token_no_space = format!("@{name}");
            mentions.push(json!({ "userId": id, "start": start, "end": start + utf16_len(&token_no_space) }));
        } else {
            any_plain = true;
        }
        text.push_str(&token);
    }
    text.push_str(body);
    (text, mentions, any_plain)
}

// ---------- 瀏覽器通道送出 ----------

type Ws = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

/// 一次連線可送多則 (排程一輪/通知多筆共用), 送完由呼叫端丟棄。
pub struct PageChannel {
    socket: Ws,
    seq: u64,
}

impl PageChannel {
    pub fn connect() -> Result<Self, String> {
        let cookie = core_ws::fetch_cookie()?;
        // 必須用 ClientRequestBuilder (它自動帶 Sec-WebSocket-Key 握手標頭);
        // 手組 http::Request 會缺標頭被拒 — core_ws::connect_ws 的既有定版教訓。
        let req = tungstenite::client::ClientRequestBuilder::new(
            format!("ws://127.0.0.1:{CORE_PORT}/ws").parse().map_err(|e| format!("WS 位址錯誤: {e:?}"))?,
        )
        .with_header("Host", format!("127.0.0.1:{CORE_PORT}"))
        .with_header("Origin", format!("http://127.0.0.1:{CORE_PORT}"))
        .with_header("Cookie", cookie);
        let (mut socket, _resp) = tungstenite::connect(req).map_err(|e| format!("連不上 LINE 核心: {e}"))?;
        if let tungstenite::stream::MaybeTlsStream::Plain(stream) = socket.get_mut() {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(400)));
        }
        let mut ch = Self { socket, seq: 0 };
        ch.wait_ready()?;
        Ok(ch)
    }

    /// 等核心說登入完成 (auth:state = ready)。沒登入就回白話錯誤, 不假裝能送。
    fn wait_ready(&mut self) -> Result<(), String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(6);
        loop {
            if std::time::Instant::now() > deadline {
                return Err("等不到 LINE 登入完成, 這次沒有送出".into());
            }
            let frame = match self.read_frame() {
                Ok(Some(f)) => f,
                Ok(None) => continue,
                Err(e) => return Err(e),
            };
            match frame.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "auth:state" => {
                    let s = frame.get("state").and_then(|v| v.as_str()).unwrap_or("");
                    if s == "ready" {
                        return Ok(());
                    }
                    if s == "idle" || s == "error" {
                        return Err("尚未登入 LINE, 請先到「總覽」頁登入後再發送".into());
                    }
                }
                "auth:ready" => return Ok(()),
                _ => {}
            }
        }
    }

    fn read_frame(&mut self) -> Result<Option<Value>, String> {
        match self.socket.read() {
            Ok(tungstenite::Message::Text(t)) => Ok(serde_json::from_str(&t.to_string()).ok()),
            Ok(tungstenite::Message::Binary(b)) => Ok(serde_json::from_str(&String::from_utf8_lossy(&b)).ok()),
            Ok(tungstenite::Message::Close(_)) => Err("LINE 核心把連線關閉了".into()),
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => Ok(None),
            Err(e) => Err(format!("讀取核心回應失敗: {e}")),
        }
    }

    /// 送一框並等它的 sent/error 回應 (以 requestId 對應; 中間的其他推播影格跳過)。
    fn request(&mut self, frame: Value, timeout: Duration) -> Result<Value, String> {
        let rid = frame.get("requestId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let text = frame.to_string();
        self.socket.send(tungstenite::Message::Text(text.into())).map_err(|e| format!("送出失敗: {e}"))?;
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if std::time::Instant::now() > deadline {
                return Err("等太久沒有回應 (逾時), 這次沒有送出".into());
            }
            let f = match self.read_frame() {
                Ok(Some(f)) => f,
                Ok(None) => continue,
                Err(e) => return Err(e),
            };
            if f.get("requestId").and_then(|v| v.as_str()) != Some(rid.as_str()) {
                continue;
            }
            return match f.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                "sent" => Ok(f),
                "chat:admins" => Ok(f),
                "error" => Err(send_error_note(f.get("code").and_then(|v| v.as_str()).unwrap_or(""))),
                _ => Ok(f),
            };
        }
    }

    fn next_id(&mut self) -> String {
        self.seq += 1;
        format!("shell-send-{}-{}", self.seq, now_ms())
    }

    pub fn send_text(&mut self, chat_id: &str, text: &str, mentions: &[Value]) -> Result<(), String> {
        let rid = self.next_id();
        let mut frame = json!({ "type": "message:send", "requestId": rid, "chatId": chat_id, "text": text });
        if !mentions.is_empty() {
            frame["mentions"] = json!(mentions);
        }
        self.request(frame, Duration::from_secs(15)).map(|_| ())
    }

    /// 圖片: 先把位元組 POST 到 /media/upload 拿 mediaId, 再用 message:send 送出 (核心原圖直送、不壓縮)。
    pub fn send_image_bytes(&mut self, chat_id: &str, bytes: &[u8], content_type: &str) -> Result<(), String> {
        if bytes.len() > IMAGE_MAX_BYTES {
            return Err("圖片超過 10MB 上限, 這張沒有送出".into());
        }
        let media_id = upload_media(bytes, content_type)?;
        let rid = self.next_id();
        let frame = json!({ "type": "message:send", "requestId": rid, "chatId": chat_id, "mediaId": media_id });
        self.request(frame, Duration::from_secs(20)).map(|_| ())
    }

    /// 一般檔案: 先把位元組 POST 到 /file/upload 拿 fileId, 再以 message:send 帶 fileId 送出
    /// (第二階段介面契約: WS 只帶編號不帶位元組; 核心在白名單檢查後經 LineProvider.sendFile 送出,
    /// 成功才消耗編號、失敗保留可重試, 所以這裡不需要自己管編號生命週期)。
    pub fn send_file_bytes(&mut self, chat_id: &str, bytes: &[u8], filename: &str) -> Result<(), String> {
        if bytes.len() > FILE_MAX_BYTES {
            return Err("檔案超過 10MB 上限, 這個檔案沒有送出".into());
        }
        if filename.trim().is_empty() {
            return Err("這個檔案沒有檔名, 沒有送出".into());
        }
        let file_id = upload_file(bytes, filename)?;
        let rid = self.next_id();
        let frame = json!({ "type": "message:send", "requestId": rid, "chatId": chat_id, "fileId": file_id });
        self.request(frame, Duration::from_secs(30)).map(|_| ())
    }

    /// 查 OpenChat 管理員 (通知 @ 的備援核對; 一般群組核心會回錯誤, 呼叫端忽略)。
    pub fn query_admins(&mut self, chat_id: &str) -> Result<Vec<Value>, String> {
        let rid = self.next_id();
        let frame = json!({ "type": "chat:admins:get", "requestId": rid, "chatId": chat_id });
        let f = self.request(frame, Duration::from_secs(8))?;
        Ok(f.get("admins").and_then(|v| v.as_array()).cloned().unwrap_or_default())
    }
}

/// POST /media/upload: body 是原始位元組, Content-Type 只決定大小預算, 真型別由核心嗅探。
/// 核心上傳路有同源硬規則: 必須帶與 Host 同源的 Origin (瀏覽器會自動帶, ureq 不會,
/// 不帶會被核心以 403 拒絕 — 接檔案路時一併補上, 圖片路同受此規則)。
/// 錯誤一律翻成白話 (對照 web/composer.ts 的既有對照表), 原始代碼只進 log 不上畫面。
pub fn upload_media(bytes: &[u8], content_type: &str) -> Result<String, String> {
    let cookie = core_ws::fetch_cookie()?;
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3)).timeout_read(Duration::from_secs(30)).build();
    let resp = agent
        .post(&format!("http://127.0.0.1:{CORE_PORT}/media/upload"))
        .set("Cookie", &cookie)
        .set("Origin", &format!("http://127.0.0.1:{CORE_PORT}"))
        .set("Content-Type", content_type)
        .send_bytes(bytes);
    match resp {
        Ok(r) => {
            let v: Value = r.into_json().map_err(|e| format!("核心回應格式不正確: {e}"))?;
            v.get("mediaId").and_then(|m| m.as_str()).map(|s| s.to_string()).ok_or_else(|| "核心沒有回傳圖片代號, 這張沒有送出".to_string())
        }
        Err(ureq::Error::Status(code, _)) => Err(match code {
            400 => "這個檔案不是可用的圖片, 沒有送出".to_string(),
            413 => "圖片超過 10MB 上限, 沒有送出".to_string(),
            415 => "圖片格式不支援, 沒有送出".to_string(),
            429 => "上傳太頻繁, 請稍等一下再試".to_string(),
            403 => "上傳被拒絕 (登入狀態可能已過期), 請重新登入後再試".to_string(),
            _ => format!("上傳失敗 (核心回應 {code})"),
        }),
        Err(e) => Err(format!("上傳連不上核心: {e}")),
    }
}

/// POST /file/upload (第二階段介面契約): body 是原始位元組, Content-Type 固定
/// application/octet-stream, 檔名以 URI 編碼放 X-Filename (核心以 decodeURIComponent 解回原名,
/// 中文檔名才不會在 HTTP 標頭裡壞掉); 回應 { fileId }。檔案只暫存在核心記憶體 (10 分鐘),
/// 不落盤。錯誤狀態對照契約: 403 未授權/同源不符、415 類型不符、400 檔名不合規、
/// 413 超過上限、429 太頻繁 — 一律翻白話, 原始代碼不上畫面。
pub fn upload_file(bytes: &[u8], filename: &str) -> Result<String, String> {
    let cookie = core_ws::fetch_cookie()?;
    let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(3)).timeout_read(Duration::from_secs(60)).build();
    let resp = agent
        .post(&format!("http://127.0.0.1:{CORE_PORT}/file/upload"))
        .set("Cookie", &cookie)
        .set("Origin", &format!("http://127.0.0.1:{CORE_PORT}"))
        .set("Content-Type", "application/octet-stream")
        .set("X-Filename", &crate::helper_api::percent_encode(filename))
        .send_bytes(bytes);
    match resp {
        Ok(r) => {
            let v: Value = r.into_json().map_err(|e| format!("核心回應格式不正確: {e}"))?;
            v.get("fileId").and_then(|m| m.as_str()).map(|s| s.to_string()).ok_or_else(|| "核心沒有回傳檔案編號, 這個檔案沒有送出".to_string())
        }
        Err(ureq::Error::Status(code, _)) => Err(match code {
            400 => "檔名不符合規定 (不能有路徑或特殊字元), 這個檔案沒有送出".to_string(),
            413 => "檔案超過 10MB 上限, 沒有送出".to_string(),
            415 => "上傳格式不符, 這個檔案沒有送出".to_string(),
            429 => "上傳太頻繁, 請稍等一下再試".to_string(),
            403 => "上傳被拒絕 (登入狀態可能已過期), 請重新登入後再試".to_string(),
            _ => format!("上傳失敗 (核心回應 {code})"),
        }),
        Err(e) => Err(format!("上傳連不上核心: {e}")),
    }
}

/// 核心送出錯誤代碼 -> 畫面/紀錄用的白話 (原始代碼不上畫面, 是產品定版規則)。
pub fn send_error_note(code: &str) -> String {
    match code {
        "UNKNOWN_CHAT" => "找不到這個聊天室 (可能已被移出群組或不在白名單), 沒有送出".to_string(),
        "INVALID_REQUEST" => "這則訊息被核心拒絕 (內容或 @ 對象不符合規定), 沒有送出".to_string(),
        "UPLOAD_EXPIRED" => "上傳編號已過期或種類不符, 請重新送一次".to_string(),
        "SEND_FAILED" => "LINE 那邊送出失敗, 請稍後再試".to_string(),
        "RATE_LIMITED" => "送出太頻繁被擋下, 請稍等一下".to_string(),
        "" => "送出失敗, 原因不明".to_string(),
        other => format!("送出失敗 ({other})"),
    }
}

/// 依副檔名/魔術位元組猜圖片 Content-Type (上傳時只影響大小預算, 真型別核心會自己嗅探)。
pub fn image_content_type(bytes: &[u8], name: &str) -> &'static str {
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return "image/png";
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return "image/jpeg";
    }
    if bytes.starts_with(b"GIF8") {
        return "image/gif";
    }
    if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "image/png"
    }
}

/// 讀取一張要送的圖片位元組: ref 是本機路徑, 或 "materials:<檔名>" (教材庫, 向 helper 取)。
pub fn load_image_bytes(item: &FlatItem, fetch_material: &dyn Fn(&str) -> Result<Vec<u8>, String>) -> Result<Vec<u8>, String> {
    load_item_bytes(item, fetch_material, "圖片")
}

/// 讀取一個要送的檔案位元組: ref 規則與圖片相同 (本機路徑或教材庫)。
pub fn load_file_bytes(item: &FlatItem, fetch_material: &dyn Fn(&str) -> Result<Vec<u8>, String>) -> Result<Vec<u8>, String> {
    load_item_bytes(item, fetch_material, "檔案")
}

fn load_item_bytes(item: &FlatItem, fetch_material: &dyn Fn(&str) -> Result<Vec<u8>, String>, kind_word: &str) -> Result<Vec<u8>, String> {
    if let Some(name) = item.ref_path.strip_prefix("materials:") {
        return fetch_material(name);
    }
    if item.ref_path.is_empty() {
        return Err(format!("這個{kind_word}沒有記錄來源檔案, 無法送出 (請重新選一次)"));
    }
    let mut f = std::fs::File::open(&item.ref_path).map_err(|_| format!("找不到{kind_word}「{}」, 可能已被移動或刪除", item.label))?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).map_err(|e| format!("讀不到{kind_word}「{}」: {e}", item.label))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(mode: &str, next: i64) -> Value {
        json!({
            "id": "e1", "chatId": "c1", "status": "pending",
            "schedule": { "mode": mode }, "nextRunAt": next,
            "items": { "text": "hi" }
        })
    }

    #[test]
    fn plan_due_sends_and_future_skips() {
        let failed = HashSet::new();
        let joins = HashMap::new();
        assert_eq!(plan_entry(&entry("now", 1000), 1000, 500, &failed, &joins), Plan::Send);
        assert_eq!(plan_entry(&entry("once", 2000), 1000, 500, &failed, &joins), Plan::NotDue);
    }

    #[test]
    fn plan_missed_while_off_asks_for_once_and_skips_for_repeat() {
        let failed = HashSet::new();
        let joins = HashMap::new();
        // nextRunAt(100) < started(500): 程式沒開時就到期了
        assert_eq!(plan_entry(&entry("once", 100), 1000, 500, &failed, &joins), Plan::AwaitConfirm);
        assert_eq!(plan_entry(&entry("now", 100), 1000, 500, &failed, &joins), Plan::AwaitConfirm);
        assert_eq!(plan_entry(&entry("repeat", 100), 1000, 500, &failed, &joins), Plan::SkipMissed);
    }

    #[test]
    fn plan_decrypt_pause_beats_due() {
        let mut failed = HashSet::new();
        failed.insert("c1".to_string());
        let joins = HashMap::new();
        assert_eq!(plan_entry(&entry("now", 1000), 1000, 500, &failed, &joins), Plan::PauseDecrypt);
    }

    #[test]
    fn plan_join_window_defers() {
        let failed = HashSet::new();
        let mut joins = HashMap::new();
        joins.insert("c1".to_string(), 950);
        // now=1000, joined 950 (ms 單位同比例), 窗口 120 秒 -> 順延到 950+120000
        assert_eq!(plan_entry(&entry("now", 1000), 1000, 500, &failed, &joins), Plan::DeferUntil(950 + JOIN_GUARD_MS));
        // 窗口過了就照常送
        let mut joins2 = HashMap::new();
        joins2.insert("c1".to_string(), 1000 - JOIN_GUARD_MS - 1);
        assert_eq!(plan_entry(&entry("now", 1000), 1000, 500, &failed, &joins2), Plan::Send);
    }

    #[test]
    fn notify_text_mentions_use_utf16_offsets() {
        let targets = vec![
            json!({ "adminId": "u1", "name": "老吳", "mode": "mention" }),
            json!({ "adminId": "u2", "name": "阿明", "mode": "plain" }),
        ];
        let (text, mentions, any_plain) = build_notify_text("詐騙警報：請留意。", &targets);
        assert_eq!(text, "@老吳 @阿明 詐騙警報：請留意。");
        assert_eq!(mentions.len(), 1);
        assert_eq!(mentions[0]["start"], 0);
        // "@老吳" 的 UTF-16 長度 = 1 + 2 = 3
        assert_eq!(mentions[0]["end"], 3);
        assert!(any_plain);
        // emoji 名字: UTF-16 以代理對計 (一個 emoji = 2)
        let t2 = vec![json!({ "adminId": "u3", "name": "😀王", "mode": "mention" })];
        let (_, m2, _) = build_notify_text("內文", &t2);
        assert_eq!(m2[0]["end"], 1 + 2 + 1);
    }

    #[test]
    fn flatten_series_uses_current_part() {
        let e = json!({
            "items": { "text": "預覽" },
            "schedule": { "mode": "repeat", "repeat": { "kind": "series" } },
            "seriesItems": [{ "text": "第1課" }, { "text": "第2課", "images": [{ "name": "a.png", "sizeBytes": 5, "ref": "/tmp/a.png" }] }],
            "seriesIndex": 1
        });
        let flat = flatten_entry(&e);
        assert_eq!(flat.len(), 2);
        assert_eq!(flat[0].text, "第2課");
        assert_eq!(flat[1].kind, "image");
        assert_eq!(flat[1].ref_path, "/tmp/a.png");
    }

    #[test]
    fn image_type_sniffing() {
        assert_eq!(image_content_type(&[0x89, 0x50, 0x4E, 0x47, 1], "x.bin"), "image/png");
        assert_eq!(image_content_type(&[0xFF, 0xD8, 0xFF, 0], "x.bin"), "image/jpeg");
        assert_eq!(image_content_type(&[], "photo.JPG"), "image/jpeg");
        assert_eq!(image_content_type(&[], "photo.png"), "image/png");
    }

    #[test]
    fn send_error_notes_are_plain() {
        assert!(send_error_note("UNKNOWN_CHAT").contains("找不到這個聊天室"));
        assert!(send_error_note("SEND_FAILED").contains("LINE"));
        // UPLOAD_EXPIRED 圖片與檔案共用, 白話不能只提圖片
        assert!(send_error_note("UPLOAD_EXPIRED").contains("上傳編號已過期"));
    }

    #[test]
    fn file_upload_filename_encoding_matches_core_decode() {
        // 核心以 decodeURIComponent 解 X-Filename: 空格與中文都必須百分號編碼, '.' 等 unreserved 保留
        assert_eq!(crate::helper_api::percent_encode("a b.pdf"), "a%20b.pdf");
        assert_eq!(crate::helper_api::percent_encode("教材.pdf"), "%E6%95%99%E6%9D%90.pdf");
    }

    /// 假核心冒煙: 在 3789 起一個最小的假核心 (手寫 WS 升級回應 + tungstenite 接管),
    #[test]
    fn page_channel_smoke_against_fake_core() {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicBool, Ordering};
        let listener = match TcpListener::bind("127.0.0.1:3789") {
            Ok(l) => l,
            Err(_) => return, // 有真核心在跑, 不搶埠
        };
        listener.set_nonblocking(true).unwrap();
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let frames_seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let (stop2, seen2) = (stop.clone(), frames_seen.clone());
        let server = std::thread::spawn(move || {
            'outer: while !stop2.load(Ordering::Relaxed) {
                let stream = loop {
                    match listener.accept() {
                        Ok((s, _)) => break s,
                        Err(_) => {
                            if stop2.load(Ordering::Relaxed) {
                                return;
                            }
                            std::thread::sleep(Duration::from_millis(20));
                        }
                    }
                };
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
                // 先偷看第一行判斷是 HTTP 還是 WS 升級 (WS 升級也是 HTTP GET, 看有沒有 Upgrade 標頭需讀完標頭;
                // tungstenite::accept_hdr 會自己讀, 所以先以 peek 方式讀請求行+標頭存起來再決定)。
                let mut cloned = match stream.try_clone() {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                let mut reader = BufReader::new(&mut cloned);
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                let mut headers = String::new();
                let mut content_length = 0usize;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {
                            if line == "\r\n" {
                                break;
                            }
                            let lower = line.to_ascii_lowercase();
                            if let Some(v) = lower.strip_prefix("content-length:") {
                                content_length = v.trim().parse().unwrap_or(0);
                            }
                            headers.push_str(&line);
                        }
                    }
                }
                if request_line.starts_with("POST /file/upload") {
                    let mut body = vec![0u8; content_length];
                    let _ = reader.read_exact(&mut body);
                    let header_of = |name: &str| {
                        headers
                            .lines()
                            .find(|l| l.to_ascii_lowercase().starts_with(&format!("{name}:")))
                            .and_then(|l| l.split_once(':').map(|(_, v)| v)) // 只切第一個冒號: Origin 值本身含 "http://"
                            .map(|s| s.trim().to_string())
                            .unwrap_or_default()
                    };
                    seen2.lock().unwrap().push(json!({
                        "fileUploadBytes": body.len(),
                        "fileUploadName": header_of("x-filename"),
                        "fileUploadOrigin": header_of("origin"),
                        "fileUploadType": header_of("content-type"),
                    }));
                    let payload = "{\"fileId\":\"file_fake_123\"}";
                    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", payload.len(), payload);
                    let mut s = stream;
                    let _ = s.write_all(resp.as_bytes());
                    continue 'outer;
                }
                if request_line.starts_with("POST /media/upload") {
                    let mut body = vec![0u8; content_length];
                    let _ = reader.read_exact(&mut body);
                    seen2.lock().unwrap().push(json!({ "uploadBytes": body.len() }));
                    let payload = "{\"mediaId\":\"upl_fake_123\"}";
                    let resp = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", payload.len(), payload);
                    let mut s = stream;
                    let _ = s.write_all(resp.as_bytes());
                    continue 'outer;
                }
                if headers.to_ascii_lowercase().contains("upgrade: websocket") {
                    let seen_ws = seen2.clone();
                    let seen2 = seen_ws.clone();
                    std::thread::spawn(move || {
                        let seen2 = seen_ws;
                    // 標頭已被 BufReader 讀走, 無法再交給 accept_hdr; 改用手算 Sec-WebSocket-Accept 完成升級,
                    // 之後以 from_raw_socket 接管 (handshake 已由我們手寫完成)。
                    let key = headers
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("sec-websocket-key:"))
                        .and_then(|l| l.split(':').nth(1))
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    let accept = ws_accept_key(&key);
                    let resp = format!(
                        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
                    );
                    let mut s = stream;
                    let _ = s.write_all(resp.as_bytes());
                    let _ = s.flush();
                    let mut ws = tungstenite::WebSocket::from_raw_socket(s, tungstenite::protocol::Role::Server, None);
                    let _ = ws.send(tungstenite::Message::Text("{\"type\":\"hello\",\"protocol\":2,\"serverVersion\":\"fake\"}".into()));
                    let _ = ws.send(tungstenite::Message::Text("{\"type\":\"auth:state\",\"state\":\"ready\"}".into()));
                    loop {
                        match ws.read() {
                            Ok(tungstenite::Message::Text(t)) => {
                                let f: Value = serde_json::from_str(&t.to_string()).unwrap_or(Value::Null);
                                seen2.lock().unwrap().push(f.clone());
                                let rid = f.get("requestId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                                match f.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                                    "message:send" => {
                                        let _ = ws.send(tungstenite::Message::Text(json!({ "type": "sent", "requestId": rid, "messageId": "m-fake-1" }).to_string().into()));
                                    }
                                    "chat:admins:get" => {
                                        let _ = ws.send(tungstenite::Message::Text(json!({ "type": "chat:admins", "requestId": rid, "chatId": f.get("chatId").cloned().unwrap_or(Value::Null), "ownMemberId": "own", "admins": [{ "userId": "sq-admin-1", "displayName": "社群管理員", "role": "admin" }] }).to_string().into()));
                                    }
                                    _ => {}
                                }
                            }
                            Ok(tungstenite::Message::Close(_)) | Err(_) => break,
                            _ => {}
                        }
                    }
                    });
                    continue 'outer;
                }
                // 一般 HTTP (GET / 取 cookie)
                let payload = "{}";
                let resp = format!("HTTP/1.1 200 OK\r\nSet-Cookie: linejs_browser=fake-token; Path=/\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}", payload.len(), payload);
                let mut s = stream;
                let _ = s.write_all(resp.as_bytes());
            }
        });

        // 客戶端流程
        let result = (|| -> Result<(), String> {
            let mut ch = PageChannel::connect()?;
            ch.send_text("c-test", "@老吳 詐騙警報", &[json!({ "userId": "u-admin", "start": 0, "end": 3 })])?;
            let png = [0x89u8, 0x50, 0x4E, 0x47, 1, 2, 3];
            ch.send_image_bytes("c-test", &png, "image/png")?;
            ch.send_file_bytes("c-test", b"hello-file", "教材.pdf")?;
            let admins = ch.query_admins("sq-test")?;
            assert_eq!(admins.len(), 1);
            assert_eq!(admins[0]["userId"], "sq-admin-1");
            Ok(())
        })();
        stop.store(true, Ordering::Relaxed);
        let _ = server.join();
        assert!(result.is_ok(), "PageChannel 冒煙失敗: {result:?}");
        let seen = frames_seen.lock().unwrap();
        let sends: Vec<&Value> = seen.iter().filter(|f| f.get("type").and_then(|v| v.as_str()) == Some("message:send")).collect();
        assert_eq!(sends.len(), 3, "應該送出三則 (文字+圖片+檔案): {seen:?}");
        assert_eq!(sends[0]["mentions"][0]["userId"], "u-admin");
        assert_eq!(sends[1]["mediaId"], "upl_fake_123");
        // 檔案走 fileId 引用, 不帶 mediaId、更不帶位元組 (第二階段介面契約)
        assert_eq!(sends[2]["fileId"], "file_fake_123");
        assert!(sends[2].get("mediaId").is_none(), "檔案送出不得帶 mediaId: {seen:?}");
        assert!(seen.iter().any(|f| f.get("uploadBytes").and_then(|v| v.as_u64()) == Some(7)), "上傳應收到 7 bytes: {seen:?}");
        let fu = seen.iter().find(|f| f.get("fileUploadBytes").is_some()).expect("假核心應收到 /file/upload");
        assert_eq!(fu["fileUploadBytes"], 10, "檔案上傳應收到原始 10 bytes: {seen:?}");
        // 檔名以 URI 編碼傳輸: 「教材.pdf」-> %E6%95%99%E6%9D%90.pdf (核心 decodeURIComponent 解回)
        assert_eq!(fu["fileUploadName"], "%E6%95%99%E6%9D%90.pdf");
        // 同源硬規則: Origin 必須帶且與 Host 同源, Content-Type 固定 octet-stream
        assert_eq!(fu["fileUploadOrigin"], "http://127.0.0.1:3789");
        assert_eq!(fu["fileUploadType"], "application/octet-stream");
    }

    /// Sec-WebSocket-Accept = base64(sha1(key + GUID))。測試用最小實作 (含 sha1)。
    fn ws_accept_key(key: &str) -> String {
        let mut data = key.as_bytes().to_vec();
        data.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
        let digest = sha1(&data);
        b64_encode_for_test(&digest)
    }

    fn b64_encode_for_test(data: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
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

    fn sha1(data: &[u8]) -> [u8; 20] {
        let mut h: [u32; 5] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0];
        let mut msg = data.to_vec();
        let bit_len = (data.len() as u64) * 8;
        msg.push(0x80);
        while msg.len() % 64 != 56 {
            msg.push(0);
        }
        msg.extend_from_slice(&bit_len.to_be_bytes());
        for block in msg.chunks_exact(64) {
            let mut w = [0u32; 80];
            for i in 0..16 {
                w[i] = u32::from_be_bytes([block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3]]);
            }
            for i in 16..80 {
                w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
            }
            let (mut a, mut b, mut c, mut d, mut e) = (h[0], h[1], h[2], h[3], h[4]);
            for (i, &wi) in w.iter().enumerate() {
                let (f, k) = match i {
                    0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                    20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                    40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                    _ => (b ^ c ^ d, 0xCA62C1D6),
                };
                let tmp = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(wi);
                e = d;
                d = c;
                c = b.rotate_left(30);
                b = a;
                a = tmp;
            }
            h[0] = h[0].wrapping_add(a);
            h[1] = h[1].wrapping_add(b);
            h[2] = h[2].wrapping_add(c);
            h[3] = h[3].wrapping_add(d);
            h[4] = h[4].wrapping_add(e);
        }
        let mut out = [0u8; 20];
        for (i, v) in h.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
        }
        out
    }
}
