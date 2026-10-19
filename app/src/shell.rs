// 殼自身的基礎設施: 資料目錄 (與引擎 paths.mjs 同規則)、殼設定檔、殼 log。
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

/// 資料目錄: 優先 HWLINEHELPER_HOME (與引擎 pack/launcher/paths.mjs 同一規則),
/// Windows 預設 %LOCALAPPDATA%\HwLineHelper。引擎子行程會繼承同一個環境, 兩邊指向同一處。
pub fn data_dir() -> PathBuf {
    if let Ok(home) = std::env::var("HWLINEHELPER_HOME") {
        if !home.is_empty() {
            return PathBuf::from(home);
        }
    }
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if !local.is_empty() {
                return PathBuf::from(local).join("HwLineHelper");
            }
        }
    }
    // 非 Windows (開發機) 或環境變數缺失時的退路
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".hw-line-helper")
}

pub fn logs_dir() -> PathBuf {
    data_dir().join("logs")
}

static LOG_LOCK: Mutex<()> = Mutex::new(());

/// 殼 log: 寫進資料目錄 logs\shell.log (規格書 v3 第 9 節)。絕不寫入任何機密 (Key/Token/QR/PIN)。
pub fn log_line(msg: &str) {
    let dir = logs_dir();
    let _ = std::fs::create_dir_all(&dir);
    let line = format!("{} [shell] {}\n", iso_now(), msg);
    let _lock = LOG_LOCK.lock();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("shell.log")) {
        let _ = f.write_all(line.as_bytes());
    }
    // probe 模式沒有主控台子系統可看, 改靠 log 檔與結果檔查證
    eprintln!("[shell] {msg}");
}

/// 簡易 UTC 時間字串 (不引入 chrono; 精度到秒即可)
pub fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (days, rem) = (secs / 86400, secs % 86400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // civil-from-days (Howard Hinnant 演算法)
    let z = days as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// 殼自身偏好 (shell-settings.json): 只放殼的偏好, 不放任何機密。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ShellSettings {
    /// 雙擊啟動時是否直接顯示主視窗 (自啟動 --autostart 時永遠先縮系統匣, 不受此值影響)
    #[serde(default = "default_true")]
    pub show_window_on_start: bool,
}

fn default_true() -> bool {
    true
}

impl Default for ShellSettings {
    fn default() -> Self {
        Self { show_window_on_start: true }
    }
}

impl ShellSettings {
    pub fn load() -> Self {
        let path = data_dir().join("shell-settings.json");
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }
    pub fn save(&self) {
        let path = data_dir().join("shell-settings.json");
        let _ = std::fs::create_dir_all(data_dir());
        if let Ok(text) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(&path, text);
        }
    }
}
