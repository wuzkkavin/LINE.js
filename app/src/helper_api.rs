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

/// 機器人聊天情況 (第 12 項): 狀態摘要 + 最近動態 (helper 記憶體環形緩衝)
pub fn bot_activity() -> Result<serde_json::Value, String> {
    get_json("/api/bot/activity")
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
