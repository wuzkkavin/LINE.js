// 引擎管理: payload 解開、監督者啟停、存活監督。
// 引擎 = pack 管線產出的 SEA exe (內含核心 3789 + helper 3790 + 監督者), 由 build.rs 嵌入。
use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::shell;

pub const ENGINE_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/engine.exe"));
pub const ENGINE_EMBEDDED: bool = env!("AIBAO_ENGINE_EMBEDDED").as_bytes()[0] == b'1';
pub const ENGINE_ID: &str = env!("AIBAO_ENGINE_ID");

pub const CORE_PORT: u16 = 3789;
pub const HELPER_PORT: u16 = 3790;

/// 埠被外來程式佔用時的白話訊息 (顯示在主視窗狀態區, 要讓使用者知道下一步怎麼做)。
pub const FOREIGN_PORT_MESSAGE: &str = "連接埠被其他程式佔用了: 在這台電腦上回應的不是本程式的服務 (很可能是舊版 AI寶.exe 還開著)。請先完全關閉舊版 AI寶 — 只關主視窗還不夠, 要到工作管理員結束 AI寶.exe, 或在舊版的瀏覽器控制台頁面關閉後確認程式已結束 — 再重新開啟本程式。";

#[derive(Debug, Clone, Copy, PartialEq)]
enum PortState {
    Free,
    Own,
    Foreign,
}

#[derive(Debug, Clone, PartialEq)]
pub enum EngineState {
    NotStarted,
    Starting,
    Running,
    /// 不是本殼啟動的引擎 (例如舊版 AI寶.exe 也在跑), 殼只能看狀態、不能保證結束它
    ExternalRunning,
    Stopped,
    Failed(String),
}

#[derive(Debug)]
pub enum StopOutcome {
    /// 監督者經停止訊號檔 (stop-request) 自行優雅退出 (session 有機會完成 DPAPI 封存)
    GracefulSignal,
    /// 逾時未退, 以 Job Object 整樹清除 (兜底)
    JobTerminate,
    /// 本來就沒在跑
    AlreadyStopped,
    /// 外部啟動的引擎, 殼無法結束
    External,
}

pub struct EngineManager {
    pub state: EngineState,
    pub pid: Option<u32>,
    #[cfg(windows)]
    job: Option<crate::platform::JobHandle>,
    #[cfg(windows)]
    proc: Option<crate::platform::SpawnedEngine>,
    #[cfg(not(windows))]
    proc: Option<std::process::Child>,
    started_at: Option<Instant>,
}

impl Default for EngineManager {
    fn default() -> Self {
        Self::new()
    }
}

impl EngineManager {
    pub fn new() -> Self {
        Self {
            state: EngineState::NotStarted,
            pid: None,
            #[cfg(windows)]
            job: None,
            proc: None,
            started_at: None,
        }
    }

    pub fn engine_dir() -> PathBuf {
        shell::data_dir().join("engine").join(ENGINE_ID)
    }

    pub fn engine_exe_path() -> PathBuf {
        Self::engine_dir().join("engine.exe")
    }

    /// 把內嵌 payload 解開到 engine/<版本>/; 有完整標記就直接用。
    /// 回傳 exe 路徑。解開失敗回傳白話原因 (規格書 v3 第 6 節: 不靜默失敗)。
    pub fn ensure_extracted() -> Result<PathBuf, String> {
        if !ENGINE_EMBEDDED {
            return Err("這支程式沒有內嵌引擎 (建置缺失), 請向維護人員反應".to_string());
        }
        let dir = Self::engine_dir();
        let exe = Self::engine_exe_path();
        let marker = dir.join("complete.txt");
        if exe.is_file() && marker.is_file() {
            return Ok(exe);
        }
        std::fs::create_dir_all(&dir).map_err(|e| format!("建立引擎目錄失敗: {e}"))?;
        let tmp = dir.join("engine.exe.tmp");
        std::fs::write(&tmp, ENGINE_BYTES).map_err(|e| format!("解開引擎失敗 (磁碟空間或權限問題): {e}"))?;
        // 大小核對: 寫入長度必須與內嵌長度一致才算解開完成
        let written = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
        if written as usize != ENGINE_BYTES.len() {
            return Err(format!("解開引擎不完整: 預期 {} 位元組, 實際 {} 位元組", ENGINE_BYTES.len(), written));
        }
        let _ = std::fs::remove_file(&exe);
        std::fs::rename(&tmp, &exe).map_err(|e| format!("引擎檔案就位失敗: {e}"))?;
        std::fs::write(&marker, ENGINE_ID).map_err(|e| format!("寫入引擎完成標記失敗: {e}"))?;
        // 清除舊版本引擎目錄 (只清 engine/ 底下非目前版本的子目錄)
        if let Some(parent) = dir.parent() {
            if let Ok(entries) = std::fs::read_dir(parent) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    if p.is_dir() && p != dir {
                        let _ = std::fs::remove_dir_all(&p);
                    }
                }
            }
        }
        shell::log_line(&format!("引擎 payload 已解開: {} ({} 位元組)", exe.display(), ENGINE_BYTES.len()));
        Ok(exe)
    }

    fn ports_alive() -> bool {
        http_status(CORE_PORT, "/").is_some() && http_status(HELPER_PORT, "/api/status").is_some()
    }

    /// 3790 上的是不是「新版」helper: /api/status 必須帶 service 身分標記。
    /// 為什麼要驗: 舊版 AI寶.exe (網頁版) 的 helper 也佔同一個 3790 埠、也有 /api/status,
    /// 但沒有 /api/list-models、測試連線還是舊邏輯 — 不驗身分就會把舊的當成自己的,
    /// 使用者按「取得可用模型」得到 HTTP 404、按「測試連線」被舊邏輯誤判 (2026-10-20 老吳實機踩到)。
    fn helper_is_ours() -> bool {
        match http_get_text(HELPER_PORT, "/api/status") {
            Some(text) => serde_json::from_str::<serde_json::Value>(&text)
                .map(|v| v.get("service").and_then(|s| s.as_str()) == Some("aibao-helper"))
                .unwrap_or(false),
            None => false,
        }
    }

    /// 埠的狀態: 沒人用 / 是新版引擎 / 被別的程式佔用 (多半是舊版 AI寶.exe)。
    fn probe_ports() -> PortState {
        let core = http_status(CORE_PORT, "/").is_some();
        let helper = http_status(HELPER_PORT, "/api/status").is_some();
        if !core && !helper {
            return PortState::Free;
        }
        if core && Self::helper_is_ours() {
            return PortState::Own;
        }
        PortState::Foreign
    }

    /// 啟動引擎。冪等: 已在跑就直接回報目前狀態。
    pub fn start(&mut self) -> Result<(), String> {
        match self.state {
            EngineState::Running | EngineState::ExternalRunning | EngineState::Starting => return Ok(()),
            _ => {}
        }
        // 已有引擎在跑 (不是我們啟的): 先驗身分 — 是新版引擎才接管狀態顯示;
        // 是外來程式 (多半是舊版 AI寶.exe) 就明確擋下並說明, 不能把舊服務當成自己的用。
        match Self::probe_ports() {
            PortState::Own => {
                self.state = EngineState::ExternalRunning;
                shell::log_line("偵測到引擎已在執行 (非本程式啟動), 只顯示狀態");
                return Ok(());
            }
            PortState::Foreign => {
                let msg = FOREIGN_PORT_MESSAGE.to_string();
                self.state = EngineState::Failed(msg.clone());
                shell::log_line("偵測到連接埠被外來程式佔用 (身分驗證不符), 已擋下並提示使用者");
                return Err(msg);
            }
            PortState::Free => {}
        }
        let exe = Self::ensure_extracted()?;
        self.state = EngineState::Starting;
        self.started_at = Some(Instant::now());
        #[cfg(windows)]
        {
            let job = crate::platform::JobHandle::new_kill_on_close()
                .map_err(|e| format!("建立行程管理 (Job Object) 失敗: {e}"))?;
            let spawned = crate::platform::spawn_engine_suspended(&exe, &[("HWLINEHELPER_NO_BROWSER", "1")])
                .map_err(|e| format!("啟動引擎失敗: {e}"))?;
            crate::platform::assign_and_resume(&job, &spawned)
                .map_err(|e| format!("引擎納管失敗: {e}"))?;
            self.pid = Some(spawned.pid);
            self.proc = Some(spawned);
            self.job = Some(job);
            shell::log_line(&format!("引擎監督者已啟動 (pid={})", self.pid.unwrap_or(0)));
        }
        #[cfg(not(windows))]
        {
            let child = std::process::Command::new(&exe)
                .env("HWLINEHELPER_NO_BROWSER", "1")
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| format!("啟動引擎失敗: {e}"))?;
            self.pid = Some(child.id());
            self.proc = Some(child);
        }
        Ok(())
    }

    /// UI 每幀呼叫: 更新存活狀態 (監督者退出偵測、就緒判定)。
    pub fn tick(&mut self) {
        match self.state {
            EngineState::Starting | EngineState::Running => {
                if self.proc_exited() {
                    // 監督者結束但埠還在: 要驗身分 — 是新版引擎才算「別人接手」;
                    // 是外來程式 (舊版 AI寶.exe) 就明確標示, 不能當成自己的引擎顯示。
                    if Self::ports_alive() {
                        if Self::helper_is_ours() {
                            self.state = EngineState::ExternalRunning;
                        } else {
                            self.state = EngineState::Failed(FOREIGN_PORT_MESSAGE.to_string());
                        }
                    } else {
                        self.state = EngineState::Failed("引擎已停止 (監督者行程結束)".to_string());
                        self.pid = None;
                    }
                    return;
                }
                if self.state == EngineState::Starting && Self::ports_alive() {
                    if Self::helper_is_ours() {
                        self.state = EngineState::Running;
                        shell::log_line("引擎就緒: 核心 3789 與 helper 3790 皆回應 (身分驗證通過)");
                    } else {
                        // 雙埠都有回應、但 3790 不是新版 helper: 自己的 helper 綁埠失敗, 埠被外來程式佔用
                        self.state = EngineState::Failed(FOREIGN_PORT_MESSAGE.to_string());
                        shell::log_line("引擎啟動時發現連接埠被外來程式佔用 (身分驗證不符)");
                        return;
                    }
                }
                if self.state == EngineState::Starting {
                    if let Some(t) = self.started_at {
                        if t.elapsed() > Duration::from_secs(90) {
                            self.state = EngineState::Failed("引擎啟動逾時 (90 秒未就緒), 請看紀錄頁的 launcher 記錄".to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }

    fn proc_exited(&mut self) -> bool {
        #[cfg(windows)]
        {
            match &self.proc {
                Some(p) => p.exited(),
                None => true,
            }
        }
        #[cfg(not(windows))]
        {
            match &mut self.proc {
                Some(c) => matches!(c.try_wait(), Ok(Some(_)) | Err(_)),
                None => true,
            }
        }
    }

    /// 結束序列 (規格書 v3 第 7 節): 先以停止訊號檔請監督者優雅關閉 (等 12 秒), 逾時以 Job Object 兜底。
    /// 為什麼不用 CTRL_BREAK: CREATE_NO_WINDOW 的行程沒有主控台, 控制事件送不到
    /// (2026-10-20 雲端探針實測 GenerateConsoleCtrlEvent 失敗) — 規格書 v3 風險 2 的定案退路。
    pub fn stop(&mut self) -> StopOutcome {
        match self.state {
            EngineState::ExternalRunning => {
                // 不是本殼啟動的引擎 (例如另一個 AI寶 視窗或新版網頁版啟的): 不能假裝關得掉。
                // 但新版監督者都看同一個資料目錄的 stop-request 訊號檔, 放訊號請它優雅結束,
                // 並以「埠真的釋放」為成功判準; 15 秒內沒停就誠實回 External, 由 UI 明說沒停成。
                let stop_file = shell::data_dir().join("stop-request");
                let _ = std::fs::write(&stop_file, b"stop");
                shell::log_line("結束外部引擎: 已放出停止訊號檔, 等待埠釋放確認");
                let deadline = Instant::now() + Duration::from_secs(15);
                while Instant::now() < deadline {
                    if !Self::ports_alive() {
                        self.state = EngineState::Stopped;
                        shell::log_line("外部引擎已結束 (埠已釋放)");
                        return StopOutcome::GracefulSignal;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                shell::log_line("外部引擎 15 秒內未結束 (埠仍有回應), 回報未停止");
                return StopOutcome::External;
            }
            EngineState::NotStarted | EngineState::Stopped => return StopOutcome::AlreadyStopped,
            _ => {}
        }
        #[cfg(windows)]
        {
            let stop_file = shell::data_dir().join("stop-request");
            let sent = std::fs::write(&stop_file, b"stop").is_ok();
            shell::log_line(&format!("已放出停止訊號檔 ({}), 寫入={sent}", stop_file.display()));
            if sent {
                let deadline = Instant::now() + Duration::from_secs(15);
                while Instant::now() < deadline {
                    // 競態防護 (2026-10-20 雲端第二輪探針實測): 監督者啟動初期會清一次殘留訊號檔,
                    // 若我們的訊號寫在它清除之前會被一起清掉; 等待期間只要檔案不見就補寫, 確保送達。
                    if !stop_file.exists() && !self.proc_exited() {
                        let _ = std::fs::write(&stop_file, b"stop");
                    }
                    if self.proc_exited() && !Self::ports_alive() {
                        self.state = EngineState::Stopped;
                        self.proc = None;
                        self.job = None;
                        self.pid = None;
                        shell::log_line("引擎已優雅結束 (停止訊號檔路徑)");
                        return StopOutcome::GracefulSignal;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
            if let Some(job) = &self.job {
                job.terminate();
            }
            std::thread::sleep(Duration::from_millis(500));
            self.state = EngineState::Stopped;
            self.proc = None;
            self.job = None;
            self.pid = None;
            shell::log_line("引擎以 Job Object 整樹結束 (兜底路徑)");
            StopOutcome::JobTerminate
        }
        #[cfg(not(windows))]
        {
            if let Some(mut c) = self.proc.take() {
                let _ = c.kill();
            }
            self.state = EngineState::Stopped;
            self.pid = None;
            StopOutcome::JobTerminate
        }
    }

    pub fn state_label(&self) -> &'static str {
        match &self.state {
            EngineState::NotStarted => "尚未啟動",
            EngineState::Starting => "啟動中",
            EngineState::Running => "執行中",
            EngineState::ExternalRunning => "執行中 (由其他程式啟動)",
            EngineState::Stopped => "已停止",
            EngineState::Failed(_) => "異常停止",
        }
    }
}

/// 快速 HTTP 探測: 回傳狀態碼; 連不上回傳 None。用短逾時避免卡住 UI。
pub fn http_status(port: u16, path: &str) -> Option<u16> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_millis(600))
        .timeout_read(Duration::from_millis(900))
        .build();
    match agent.get(&format!("http://127.0.0.1:{port}{path}")).call() {
        Ok(resp) => Some(resp.status()),
        Err(ureq::Error::Status(code, _)) => Some(code),
        Err(_) => None,
    }
}

/// POST 一段 JSON 並回傳 (狀態碼, body); 連不上回傳 None (探針端點實測用)。
/// 為什麼需要: /api/status 回 200 不代表其他端點存在 — 2026-10-20 老吳實機遇到 /api/list-models 404,
/// 探針必須實際打端點、用回應內容證明路由存在且邏輯有跑, 不能只看狀態端點。
pub fn http_post_text(port: u16, path: &str, json_body: &str) -> Option<(u16, String)> {
    use std::io::Read as _;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(10))
        .build();
    let read_body = |mut resp: ureq::Response| -> String {
        let mut text = String::new();
        let _ = resp.into_reader().read_to_string(&mut text);
        text
    };
    match agent.post(&format!("http://127.0.0.1:{port}{path}")).set("Content-Type", "application/json").send_string(json_body) {
        Ok(resp) => {
            let code = resp.status();
            Some((code, read_body(resp)))
        }
        Err(ureq::Error::Status(code, resp)) => Some((code, read_body(resp))),
        Err(_) => None,
    }
}

/// 讀取一個本機 HTTP 回應的 body (探針與狀態檢查用)
pub fn http_get_text(port: u16, path: &str) -> Option<String> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(3))
        .build();
    let resp = agent.get(&format!("http://127.0.0.1:{port}{path}")).call().ok()?;
    let mut text = String::new();
    resp.into_reader().read_to_string(&mut text).ok()?;
    Some(text)
}
