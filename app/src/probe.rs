// 探針模式 (--probe-login): 在雲端 Windows runner 上以正式程式碼路徑驗證 —
// payload 解開 → 引擎 headless 啟動 → 雙埠回應 → 核心 WS 登入往返 (cookie/hello/auth:state/auth:start→auth:qr)
// → 停止訊號檔優雅結束 → 埠釋放。結果寫成 key=value 行: 同時印出並寫入 AIBAO_PROBE_OUT 指定的結果檔。
// 全程不碰真帳號: 只送 auth:start 取得一組未被掃描的 QR (沒有手機掃描就不會登入任何帳號)。
use std::io::Write;
use std::time::{Duration, Instant};

use crate::core_ws;
use crate::engine::{self, EngineManager, StopOutcome};
use crate::shell;

pub fn run_probe() -> i32 {
    let out_path = std::env::var("AIBAO_PROBE_OUT").unwrap_or_else(|_| "probe-result.txt".to_string());
    let mut lines: Vec<String> = Vec::new();
    let mut rec = |line: String| {
        println!("{line}");
        shell::log_line(&format!("probe: {}", sanitize(&line)));
        lines.push(line);
    };
    rec(format!("probe=start time={}", shell::iso_now()));
    rec(format!("data_dir={}", shell::data_dir().display()));
    rec(format!("engine_embedded={}", engine::ENGINE_EMBEDDED));
    rec(format!("engine_id={}", engine::ENGINE_ID));
    rec(format!("engine_bytes={}", engine::ENGINE_BYTES.len()));

    let mut mgr = EngineManager::new();
    // 1) 解開
    match EngineManager::ensure_extracted() {
        Ok(p) => rec(format!("extract=ok path={}", p.display())),
        Err(e) => {
            rec(format!("extract=fail:{e}"));
            finish(&out_path, &lines);
            return 1;
        }
    }
    // 2) 啟動
    if let Err(e) = mgr.start() {
        rec(format!("engine_start=fail:{e}"));
        finish(&out_path, &lines);
        return 1;
    }
    rec(format!("engine_start=ok pid={}", mgr.pid.unwrap_or(0)));
    // 3) 等雙埠 (狀態機 + 直接探測)
    let deadline = Instant::now() + Duration::from_secs(90);
    let mut core_code = None;
    let mut helper_code = None;
    while Instant::now() < deadline {
        mgr.tick();
        core_code = engine::http_status(engine::CORE_PORT, "/");
        helper_code = engine::http_status(engine::HELPER_PORT, "/api/status");
        if core_code == Some(200) && helper_code == Some(200) {
            break;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    rec(format!("core_http={}", core_code.map(|c| c.to_string()).unwrap_or_else(|| "none".into())));
    rec(format!("helper_http={}", helper_code.map(|c| c.to_string()).unwrap_or_else(|| "none".into())));
    if core_code != Some(200) || helper_code != Some(200) {
        rec("ports=fail".to_string());
        let _ = mgr.stop();
        finish(&out_path, &lines);
        return 1;
    }
    rec("ports=ok".to_string());
    // 4) helper 狀態內容 (bot 欄位存在與否)
    if let Some(text) = engine::http_get_text(engine::HELPER_PORT, "/api/status") {
        let has_bot = text.contains("\"bot\"");
        rec(format!("helper_status_has_bot={has_bot}"));
        // 身分標記也要在 (新版 helper 才有; App 靠它分辨新舊服務)
        let has_identity = text.contains("\"service\":\"aibao-helper\"") || text.contains("\"service\": \"aibao-helper\"");
        rec(format!("helper_status_identity={has_identity}"));
        // 機器人連線狀態欄位 (botConnected): 總覽靠它把「LINE 已登入」與「機器人已連線」分開顯示
        let has_bot_connected = text.contains("\"botConnected\"");
        rec(format!("helper_status_bot_connected_field={has_bot_connected}"));
    }
    // 4b) payload 端點實測: 實際 POST /api/list-models 與 /api/test-ai, 用回應內容證明路由存在。
    // list-models 不給 Key → 正確行為是 HTTP 200 + {ok:false, code:"AI_NO_KEY"}; 若回 404 就是路由不在 (實機踩過)。
    match engine::http_post_text(engine::HELPER_PORT, "/api/list-models", "{\"provider\":\"groq\",\"baseUrl\":\"https://api.groq.com/openai/v1\"}") {
        Some((200, body)) if body.contains("AI_NO_KEY") => rec("helper_list_models_route=ok".to_string()),
        Some((code, body)) => rec(format!("helper_list_models_route=fail:http{code}:{}", sanitize(&body.chars().take(120).collect::<String>()))),
        None => rec("helper_list_models_route=fail:no-response".to_string()),
    }
    // test-ai 把 baseUrl 指向必定連不上的本機埠 → 正確行為是 HTTP 200 + {ok:false, code:"AI_NETWORK"};
    // 回 404 代表 test-ai 路由不在; 回 ok:true 或其他 code 都不對。
    match engine::http_post_text(engine::HELPER_PORT, "/api/test-ai", "{\"provider\":\"groq\",\"baseUrl\":\"http://127.0.0.1:9/v1\",\"model\":\"probe-stub\",\"apiKey\":\"probe\"}") {
        Some((200, body)) if body.contains("AI_NETWORK") => rec("helper_test_ai_route=ok".to_string()),
        Some((code, body)) => rec(format!("helper_test_ai_route=fail:http{code}:{}", sanitize(&body.chars().take(120).collect::<String>()))),
        None => rec("helper_test_ai_route=fail:no-response".to_string()),
    }
    // 4c) 群組清單端點實測: GET /api/line/chats。此時核心未登入, 正確行為是 200 + {ok:false, code:"NOT_LOGGED_IN"};
    // 回 404 或非 JSON 代表路由不在 (同 4b 教訓)。helper 端要等核心把登入狀態定案, 給 40 秒逾時。
    match engine::http_get_text_long(engine::HELPER_PORT, "/api/line/chats", 40) {
        Some(body) if body.contains("NOT_LOGGED_IN") || body.contains("\"ok\":true") || body.contains("\"ok\": true") => {
            rec("helper_line_chats_route=ok".to_string())
        }
        Some(body) => rec(format!("helper_line_chats_route=fail:{}", sanitize(&body.chars().take(120).collect::<String>()))),
        None => rec("helper_line_chats_route=fail:no-response".to_string()),
    }
    // 5) WS 登入往返
    let events = core_ws::probe_login_roundtrip(true, Duration::from_secs(90));
    for e in &events {
        rec(format!("ws_event {e}"));
    }
    let roundtrip_ok = events.iter().any(|e| {
        e == "result=roundtrip_qr" || e == "result=roundtrip_error_state" || e == "result=already_logged_in" || e == "result=roundtrip_ready"
    });
    rec(format!("login_roundtrip={}", if roundtrip_ok { "ok" } else { "fail" }));
    // 6) 優雅結束 + 埠釋放核對
    let outcome = mgr.stop();
    rec(format!(
        "shutdown_path={}",
        match outcome {
            StopOutcome::GracefulSignal => "signal_file",
            StopOutcome::ForcedStop => "forced_stop",
            StopOutcome::AlreadyStopped => "already_stopped",
            StopOutcome::BlockedForeign(_) => "blocked_foreign",
            StopOutcome::Residual(_) => "residual",
        }
    ));
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut freed = false;
    while Instant::now() < deadline {
        if engine::http_status(engine::CORE_PORT, "/").is_none() && engine::http_status(engine::HELPER_PORT, "/api/status").is_none() {
            freed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    rec(format!("ports_freed={freed}"));
    rec("probe=done".to_string());
    finish(&out_path, &lines);
    if roundtrip_ok && freed {
        0
    } else {
        1
    }
}

fn sanitize(line: &str) -> String {
    // 避免把長字串整段塞進 log; probe 行本身不含祕密 (QR 只記長度), 這裡只截斷
    if line.chars().count() > 300 {
        format!("{}...", line.chars().take(300).collect::<String>())
    } else {
        line.to_string()
    }
}

fn finish(out_path: &str, lines: &[String]) {
    let text = lines.join("\n") + "\n";
    if let Ok(mut f) = std::fs::File::create(out_path) {
        let _ = f.write_all(text.as_bytes());
    }
}
