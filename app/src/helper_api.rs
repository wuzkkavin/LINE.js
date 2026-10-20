// helper 本機 API 客戶端 (http://127.0.0.1:3790/api/*): 殼的設定/狀態/診斷全走這裡,
// 不重寫 helper 業務邏輯 (規格書 v3 第 3 節)。端點合約見 helper/src/server.mjs。
use std::time::Duration;

use crate::engine::HELPER_PORT;

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

pub fn get_json(path: &str) -> Result<serde_json::Value, String> {
    match agent(10).get(&url(path)).call() {
        Ok(resp) => resp.into_json::<serde_json::Value>().map_err(|e| format!("回應解析失敗: {e}")),
        Err(ureq::Error::Status(_, resp)) => Err(format!("服務回應錯誤: {}", resp.status())),
        Err(e) => Err(format!("連不上設定服務: {e}")),
    }
}

pub fn post_json(path: &str, body: serde_json::Value, timeout_secs: u64) -> Result<serde_json::Value, String> {
    match agent(timeout_secs).post(&url(path)).send_json(body) {
        Ok(resp) => resp.into_json::<serde_json::Value>().map_err(|e| format!("回應解析失敗: {e}")),
        Err(ureq::Error::Status(code, resp)) => {
            // helper 的業務錯誤多以 200 + {ok:false,message} 回傳; 真的 HTTP 錯誤時也盡量讀出訊息
            if let Ok(v) = resp.into_json::<serde_json::Value>() {
                return Ok(v);
            }
            Err(format!("服務回應錯誤 (HTTP {code})"))
        }
        Err(e) => Err(format!("連不上設定服務: {e}")),
    }
}

pub fn put_settings(body: serde_json::Value) -> Result<serde_json::Value, String> {
    match agent(15).put(&url("/api/settings")).send_json(body) {
        Ok(resp) => resp.into_json::<serde_json::Value>().map_err(|e| format!("回應解析失敗: {e}")),
        Err(ureq::Error::Status(code, _)) => Err(format!("儲存失敗 (HTTP {code})")),
        Err(e) => Err(format!("連不上設定服務: {e}")),
    }
}

pub fn get_status() -> Result<serde_json::Value, String> {
    get_json("/api/status")
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
    match agent(40).get(&url("/api/line/chats")).call() {
        Ok(resp) => resp.into_json::<serde_json::Value>().map_err(|e| format!("回應解析失敗: {e}")),
        Err(ureq::Error::Status(_, resp)) => Err(format!("服務回應錯誤: {}", resp.status())),
        Err(e) => Err(format!("連不上設定服務: {e}")),
    }
}

pub fn line_config_apply(chat_id: &str) -> Result<serde_json::Value, String> {
    post_json("/api/line/config-apply", serde_json::json!({ "chatId": chat_id }), 20)
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
