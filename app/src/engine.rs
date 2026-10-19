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

    /// 啟動引擎。冪等: 已在跑就直接回報目前狀態。
    pub fn start(&mut self) -> Result<(), String> {
        match self.state {
            EngineState::Running | EngineState::ExternalRunning | EngineState::Starting => return Ok(()),
            _ => {}
        }
        // 已有引擎在跑 (不是我們啟的): 不重複啟動, 只接管狀態顯示
        if Self::ports_alive() {
            self.state = EngineState::ExternalRunning;
            shell::log_line("偵測到引擎已在執行 (非本程式啟動), 只顯示狀態");
            return Ok(());
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
                    // 監督者結束但埠還在 = 有別人接手或舊服務還在; 埠不在 = 引擎真的停了
                    if Self::ports_alive() {
                        self.state = EngineState::ExternalRunning;
                    } else {
                        self.state = EngineState::Failed("引擎已停止 (監督者行程結束)".to_string());
                        self.pid = None;
                    }
                    return;
                }
                if self.state == EngineState::Starting && Self::ports_alive() {
                    self.state = EngineState::Running;
                    shell::log_line("引擎就緒: 核心 3789 與 helper 3790 皆回應");
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
            EngineState::ExternalRunning => return StopOutcome::External,
            EngineState::NotStarted | EngineState::Stopped => return StopOutcome::AlreadyStopped,
            _ => {}
        }
        #[cfg(windows)]
        {
            let stop_file = shell::data_dir().join("stop-request");
            let sent = std::fs::write(&stop_file, b"stop").is_ok();
            shell::log_line(&format!("已放出停止訊號檔 ({}), 寫入={sent}", stop_file.display()));
            if sent {
                let deadline = Instant::now() + Duration::from_secs(12);
                while Instant::now() < deadline {
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
