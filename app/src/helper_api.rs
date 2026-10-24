// helper 本機 API 客戶端 (http://127.0.0.1:3790/api/*): 殼的設定/狀態/診斷全走這裡,
// 不重寫 helper 業務邏輯 (規格書 v3 第 3 節)。端點合約見 helper/src/server.mjs。
//
// 消費級基線 (2026-10-20 老吳裁示): UI 只准看到白話訊息, 不准出現狀態碼/Network Error
// 之類原始錯誤; 原始細節一律寫進殼 log 供診斷。所有呼叫都有逾時; 傳輸層失敗
// (連不上/讀不到 — 多半是 helper 正在重啟或短暫忙碌) 自動重試兩次 (退避 0.4s/1.2s),
// 不要一次失敗就把錯誤丟給使用者。HTTP 狀態錯誤不重試 (對方已明確回覆), 但若 body
// 帶 helper 的白話 message 就優先用它。
use std::time::Duration;

use crate::engine::HELPER_PORT;
use crate::shell;

const ERR_UNREACHABLE: &str = "連不上 AI寶 的服務, 它可能還在啟動或短暫忙碌。請稍等幾秒再試一次; 如果一直失敗, 請到「總覽」頁按「一鍵修復」。";
const ERR_BAD_RESPONSE: &str = "AI寶 的服務回應異常, 這項功能暫時無法讀取。問題已記錄下來, 請稍後再試, 或到「總覽」頁按「一鍵修復」。";

fn agent(timeout_secs: u64) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(3))
        .timeout_read(Duration::from_secs(timeout_secs))
        .timeout_write(Duration::from_secs(5))
        .build()
}

fn url(path: &str) -> String {
    format!("http://127.0.0.1:{HELPER_PORT}{path}")
}

enum CallErr {
    /// HTTP 狀態錯誤 (對方有回覆; body 若帶白話 message 優先顯示它)
    Status(u16, Option<String>),
    /// 傳輸層失敗 (連不上/逾時/讀取中斷): 可重試, 最終只給白話訊息、細節進 log
    Transport(String),
    /// 回應不是合法 JSON
    Parse(String),
}

fn classify_status(code: u16, resp: ureq::Response) -> CallErr {
    match resp.into_json::<serde_json::Value>() {
        Ok(v) => {
            let msg = v.get("message").and_then(|m| m.as_str()).map(|s| s.to_string());
            CallErr::Status(code, msg)
        }
        Err(_) => CallErr::Status(code, None),
    }
}

fn once_get(path: &str, timeout_secs: u64) -> Result<serde_json::Value, CallErr> {
    match agent(timeout_secs).get(&url(path)).call() {
        Ok(resp) => resp.into_json::<serde_json::Value>().map_err(|e| CallErr::Parse(e.to_string())),
        Err(ureq::Error::Status(code, resp)) => Err(classify_status(code, resp)),
        Err(e) => Err(CallErr::Transport(e.to_string())),
    }
}

fn once_send(method: &str, path: &str, body: &serde_json::Value, timeout_secs: u64) -> Result<serde_json::Value, CallErr> {
    let req = match method {
        "PUT" => agent(timeout_secs).put(&url(path)),
        _ => agent(timeout_secs).post(&url(path)),
    };
    match req.send_json(body.clone()) {
        Ok(resp) => resp.into_json::<serde_json::Value>().map_err(|e| CallErr::Parse(e.to_string())),
        Err(ureq::Error::Status(code, resp)) => Err(classify_status(code, resp)),
        Err(e) => Err(CallErr::Transport(e.to_string())),
    }
}

/// 傳輸失敗重試 (退避 0.4s → 1.2s, 共 3 次嘗試); 狀態/解析錯誤立即定案。
/// 最終錯誤一律轉白話; 原始錯誤只進殼 log (格式: helper API <path> 第 N 次嘗試失敗: <raw>)。
fn with_retry(what: &str, mut f: impl FnMut() -> Result<serde_json::Value, CallErr>) -> Result<serde_json::Value, String> {
    let backoffs = [Duration::from_millis(400), Duration::from_millis(1200)];
    let mut attempt = 0usize;
    loop {
        attempt += 1;
        match f() {
            Ok(v) => return Ok(v),
            Err(CallErr::Status(code, msg)) => {
                if let Some(m) = msg {
                    if !m.trim().is_empty() {
                        return Ok(serde_json::json!({ "ok": false, "message": m }));
                    }
                }
                // 狀態碼一定要進 log (第 5 項觀測性修復): 2026-10-20 實機事故時殼從未記錄狀態碼,
                // 只剩 7.9 萬行「狀態異常」無法分辨 404/500/其他, 斷點只能靠拼湊還原。
                shell::log_line(&format!("helper API {what} 回應狀態異常: HTTP {code} (回應無白話訊息), 已轉白話訊息給 UI"));
                return Err(ERR_BAD_RESPONSE.to_string());
            }
            Err(CallErr::Parse(raw)) => {
                shell::log_line(&format!("helper API {what} 回應解析失敗: {raw}"));
                return Err(ERR_BAD_RESPONSE.to_string());
            }
            Err(CallErr::Transport(raw)) => {
                shell::log_line(&format!("helper API {what} 第 {attempt} 次嘗試連線失敗: {raw}"));
                if attempt > backoffs.len() {
                    return Err(ERR_UNREACHABLE.to_string());
                }
                std::thread::sleep(backoffs[attempt - 1]);
            }
        }
    }
}

pub fn get_json(path: &str) -> Result<serde_json::Value, String> {
    with_retry(path, || once_get(path, 10))
}

pub fn post_json(path: &str, body: serde_json::Value, timeout_secs: u64) -> Result<serde_json::Value, String> {
    with_retry(path, || once_send("POST", path, &body, timeout_secs))
}

pub fn put_settings(body: serde_json::Value) -> Result<serde_json::Value, String> {
    with_retry("/api/settings (儲存)", || once_send("PUT", "/api/settings", &body, 15))
}

pub fn get_status() -> Result<serde_json::Value, String> {
    get_json("/api/status")
}

/// 機器人聊天情況 (第 12 項): 狀態摘要 + 最近動態 (helper 記憶體環形緩衝)。
/// 群組篩選 (2026-10-23): chat 給了就帶 ?chat=<chatId>, 由 helper 端做純顯示層
/// 篩選 (邏輯在 helper/src/activityfilter.mjs, 附單元測試); chatId 只含英數字
/// 與連字號, 直接拼進 query 即可。
/// 核心聊天頁自我檢查 (修復版6後續修復): 直接對核心 3789 根頁面做一次 GET,
/// 只回狀態碼、不解析內容。給「聊天室畫面」頁區分「核心網頁連不上」
/// 與「核心網頁通、但嵌入顯示有問題」兩種情況, 不再讓使用者對著空白猜。
pub fn core_page_check() -> Result<u16, String> {
    use crate::engine::CORE_PORT;
    match agent(5).get(&format!("http://127.0.0.1:{CORE_PORT}/")).call() {
        Ok(resp) => Ok(resp.status()),
        Err(ureq::Error::Status(code, _)) => Ok(code),
        Err(e) => Err(format!("{e}")),
    }
}

pub fn bot_activity(chat: Option<&str>) -> Result<serde_json::Value, String> {
    match chat {
        Some(id) if !id.is_empty() => get_json(&format!("/api/bot/activity?chat={id}")),
        _ => get_json("/api/bot/activity"),
    }
}

pub fn get_settings() -> Result<serde_json::Value, String> {
    get_json("/api/settings")
}

/// AI 測試連線: {provider, apiKey?(未存先測時), baseUrl, model}; 回傳 helper 的結果物件 (含 ok/message/latencyMs)
pub fn test_ai(provider: &str, api_key: Option<&str>, base_url: &str, model: &str) -> Result<serde_json::Value, String> {
    let mut body = serde_json::json!({ "provider": provider, "baseUrl": base_url, "model": model });
    if let Some(k) = api_key {
        if !k.is_empty() {
            body["apiKey"] = serde_json::Value::String(k.to_string());
        }
    }
    post_json("/api/test-ai", body, 45)
}

/// 取得可用模型清單: {provider, apiKey?, baseUrl}; 回傳 {ok, models:[...], message}
pub fn list_models(provider: &str, api_key: Option<&str>, base_url: &str) -> Result<serde_json::Value, String> {
    let mut body = serde_json::json!({ "provider": provider, "baseUrl": base_url });
    if let Some(k) = api_key {
        if !k.is_empty() {
            body["apiKey"] = serde_json::Value::String(k.to_string());
        }
    }
    post_json("/api/list-models", body, 45)
}

pub fn line_config_status() -> Result<serde_json::Value, String> {
    get_json("/api/line/config-status")
}

/// 讀取已登入帳號的群組清單 (helper 經核心網頁通道取得, 含白名單標記)。
/// helper 端要等核心快照 + 重新整理, 可能十幾秒, 用較長逾時 (一般 get_json 只有 10 秒)。
pub fn line_chats() -> Result<serde_json::Value, String> {
    with_retry("/api/line/chats", || once_get("/api/line/chats", 40))
}

pub fn line_config_apply(chat_id: &str) -> Result<serde_json::Value, String> {
    post_json("/api/line/config-apply", serde_json::json!({ "chatId": chat_id }), 20)
}

/// 已儲存白名單逐筆清單 (含名稱解析狀態); 核心快照可能慢, 用較長逾時比照 line_chats。
pub fn line_whitelist() -> Result<serde_json::Value, String> {
    with_retry("/api/line/whitelist", || once_get("/api/line/whitelist", 40))
}

pub fn line_config_remove(chat_id: &str) -> Result<serde_json::Value, String> {
    post_json("/api/line/config-remove", serde_json::json!({ "chatId": chat_id }), 20)
}

pub fn line_generate_token() -> Result<serde_json::Value, String> {
    post_json("/api/line/generate-token", serde_json::json!({}), 60)
}

pub fn kb_reindex() -> Result<serde_json::Value, String> {
    post_json("/api/kb/reindex", serde_json::json!({}), 30)
}

/// 待發清單 + 發送紀錄 (發送群組訊息頁): helper 只做本機存放與規則, 實際送出由殼負責
pub fn get_outbox() -> Result<serde_json::Value, String> {
    get_json("/api/outbox")
}

pub fn create_outbox(body: serde_json::Value) -> Result<serde_json::Value, String> {
    post_json("/api/outbox", body, 15)
}

pub fn cancel_outbox(id: &str) -> Result<serde_json::Value, String> {
    post_json("/api/outbox/cancel", serde_json::json!({ "id": id }), 15)
}

// --- 第三/四階段: 排程護欄動作、管理員通知、教材庫 ---

/// 送出結果寫回 (逐項成敗, 與 helper flattenItems 同序)
pub fn record_outbox_result(id: &str, results: serde_json::Value, note: &str) -> Result<serde_json::Value, String> {
    post_json("/api/outbox/result", serde_json::json!({ "id": id, "results": results, "note": note }), 15)
}

/// 失敗項目重送後的合併結果寫回 (不算新的一次發送, 不推進系列/次數)
pub fn record_outbox_retry_result(id: &str, results: serde_json::Value, note: &str) -> Result<serde_json::Value, String> {
    post_json("/api/outbox/retry-result", serde_json::json!({ "id": id, "results": results, "note": note }), 15)
}

/// 暫停/恢復一筆待發。reason: "decrypt" = 鑰匙異常被護欄自動暫停 (恢復正常後會自動繼續);
/// "manual" = 使用者在畫面按的 (不會自動恢復)。恢復時 reason 傳空字串。
pub fn pause_outbox(id: &str, paused: bool, note: &str, reason: &str) -> Result<serde_json::Value, String> {
    post_json("/api/outbox/pause", serde_json::json!({ "id": id, "paused": paused, "note": note, "reason": reason }), 15)
}

/// 順延一筆待發到指定時間 (有人剛進群的鑰匙交接護欄)
pub fn defer_outbox(id: &str, next_run_at_ms: i64, note: &str) -> Result<serde_json::Value, String> {
    post_json("/api/outbox/defer", serde_json::json!({ "id": id, "nextRunAt": next_run_at_ms, "note": note }), 15)
}

/// 跳過程式沒開時錯過的那一次 (只有重複發)
pub fn skip_outbox(id: &str, note: &str) -> Result<serde_json::Value, String> {
    post_json("/api/outbox/skip", serde_json::json!({ "id": id, "note": note }), 15)
}

/// 管理員通知事件紀錄 + 待送清單 (pending)
pub fn get_admin_events() -> Result<serde_json::Value, String> {
    get_json("/api/admin-events")
}

/// 管理員通知實際送出後寫回結果
pub fn mark_admin_event_sent(id: &str, ok: bool, note: &str) -> Result<serde_json::Value, String> {
    post_json("/api/admin-events/sent", serde_json::json!({ "id": id, "ok": ok, "note": note }), 15)
}

/// 管理員候選名單 (白名單群組近期發言者 + OpenChat 管理員)
pub fn get_admin_candidates() -> Result<serde_json::Value, String> {
    with_retry("/api/admin-candidates", || once_get("/api/admin-candidates", 30))
}

/// 單一聊天室的管理員候選名單 (聊天室管理頁用): 只回該室的近期發言者與社群管理員,
/// 回應形狀與 get_admin_candidates 相同 (candidates 陣列, 每筆含 id/name/chats/source)。
pub fn admin_candidates_chat(chat_id: &str, all: bool) -> Result<serde_json::Value, String> {
    // all=false (預設): 只回近期在這個聊天室發言過的人 + 社群管理員 (人多時先看這份短名單);
    // all=true: 按下「找沒發言過的人」才抓的較寬名單 (曾在這個聊天室出現過的人 + 社群管理員)。
    let path = if all {
        format!("/api/admin-candidates?chat={chat_id}&all=1")
    } else {
        format!("/api/admin-candidates?chat={chat_id}")
    };
    with_retry(&path.clone(), move || once_get(&path, 30))
}

/// 教材庫清單
pub fn get_materials() -> Result<serde_json::Value, String> {
    get_json("/api/materials")
}

/// 把一份檔案存進教材庫 (內容以 base64 傳, 上限 10MB)
pub fn add_material(name: &str, data_base64: &str) -> Result<serde_json::Value, String> {
    post_json("/api/materials", serde_json::json!({ "name": name, "dataBase64": data_base64 }), 30)
}

/// 取教材庫一份檔案的位元組 (送出圖片時用; 不是 JSON, 單獨走原始回應)
pub fn get_material_bytes(name: &str) -> Result<Vec<u8>, String> {
    let encoded = percent_encode(name);
    match agent(20).get(&url(&format!("/api/materials/file?name={encoded}"))).call() {
        Ok(resp) => {
            let mut buf = Vec::new();
            use std::io::Read as _;
            resp.into_reader().read_to_end(&mut buf).map_err(|e| format!("讀取教材庫檔案失敗: {e}"))?;
            Ok(buf)
        }
        Err(ureq::Error::Status(404, _)) => Err(format!("教材庫裡找不到「{name}」")),
        Err(e) => Err(format!("讀取教材庫失敗: {e}")),
    }
}

/// URI 百分號編碼 (只保留 RFC 3986 unreserved 字元); pagesend 的 /file/upload
/// 以它編 X-Filename, 核心端以 decodeURIComponent 解回原始檔名, 兩邊必須同一套規則。
pub(crate) fn percent_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn get_logs() -> Result<serde_json::Value, String> {
    get_json("/api/logs")
}

pub fn get_log_dir() -> Result<serde_json::Value, String> {
    get_json("/api/log-dir")
}

/// 一鍵修復用: 不經重試、短逾時探一次 helper 是否有回應 (修復流程自己控制節奏)。
pub fn ping_helper() -> bool {
    matches!(agent(3).get(&url("/api/status")).call(), Ok(resp) if resp.status() == 200)
}
