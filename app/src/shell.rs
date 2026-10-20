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
    /// 是否已看過「縮到系統匣 ≠ 結束程式」的提示 (只提示第一次, 避免每次縮小都打擾;
    /// 2026-10-20 老吳實機: 按 X 以為關掉程式, 其實只是縮到系統匣、服務繼續跑, 誤以為結束功能壞掉)
    #[serde(default)]
    pub tray_hint_shown: bool,
    /// 介面主題 id (theme 模組 ThemeId 的持久化字串); 舊設定檔沒有此欄位時
    /// 以 serde default 補 forest (森林綠, 出廠預設), 不影響既有偏好。
    #[serde(default = "default_theme")]
    pub theme: String,
}

fn default_true() -> bool {
    true
}

fn default_theme() -> String {
    "forest".to_string()
}

impl Default for ShellSettings {
    fn default() -> Self {
        Self { show_window_on_start: true, tray_hint_shown: false, theme: default_theme() }
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

// ---------- 診斷包匯出 (紀錄頁「匯出診斷包」) ----------
// 內容: 版本資訊、helper 狀態與遮罩後設定 (經 helper API 拿, 天生不含機密)、近 14 天的 log 檔
// (helper-*.log 與殼的 shell.log 都在同一個 logs 目錄; log 寫入時已過遮罩)。
// 紅線: 不打包原始 settings.json、不碰機密庫/session — 那些東西永遠不離開這台電腦。

/// 匯出診斷包到 dest (zip, stored 無壓縮), 回傳給使用者看的完成訊息。
pub fn export_diagnostic(dest: &std::path::Path) -> Result<String, String> {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let version_text = format!(
        "AI寶 App 版本: {}\n引擎版本: {}\n匯出時間 (UTC): {}\n資料目錄: {}\n",
        env!("CARGO_PKG_VERSION"),
        crate::engine::ENGINE_ID,
        iso_now(),
        data_dir().display()
    );
    files.push(("version.txt".to_string(), version_text.into_bytes()));
    if let Ok(v) = crate::helper_api::get_status() {
        if let Ok(text) = serde_json::to_string_pretty(&v) {
            files.push(("status.json".to_string(), text.into_bytes()));
        }
    }
    if let Ok(v) = crate::helper_api::get_settings() {
        // /api/settings 回的是遮罩版 (Key 只剩末 4 碼), 可以放進診斷包
        if let Ok(text) = serde_json::to_string_pretty(&v) {
            files.push(("settings-masked.json".to_string(), text.into_bytes()));
        }
    }
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(14 * 86400);
    let mut log_count = 0usize;
    if let Ok(rd) = std::fs::read_dir(logs_dir()) {
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let is_log = name.ends_with(".log") && (name.starts_with("helper-") || name == "shell.log" || name == "launcher.log");
            if !is_log {
                continue;
            }
            let recent = entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| t >= cutoff)
                .unwrap_or(false);
            if !recent {
                continue;
            }
            if let Ok(bytes) = std::fs::read(entry.path()) {
                files.push((format!("logs/{name}"), bytes));
                log_count += 1;
            }
        }
    }
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let zip = make_zip_stored(&files);
    std::fs::write(dest, &zip).map_err(|e| format!("寫入診斷包失敗: {e}"))?;
    log_line(&format!("已匯出診斷包: {} ({} 位元組, log {} 個)", dest.display(), zip.len(), log_count));
    Ok(format!("已匯出診斷包到: {} (含近 14 天紀錄 {log_count} 個檔, 請把這個 zip 傳給維護人員)", dest.display()))
}

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for n in 0..256u32 {
        let mut c = n;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xedb88320 ^ (c >> 1) } else { c >> 1 };
        }
        table[n as usize] = c;
    }
    let mut c = 0xffffffffu32;
    for &b in data {
        c = table[((c ^ b as u32) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffffffff
}

/// 最小 ZIP (stored, 無壓縮) 產生器, 與 helper 端 makeZip 同格式, 避免為打包功能引入新相依。
fn make_zip_stored(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for (name, data) in files {
        let name_bytes = name.as_bytes();
        let crc = crc32(data);
        let offset = out.len() as u32;
        out.extend_from_slice(&0x04034b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 檔名
        out.extend_from_slice(&0u16.to_le_bytes()); // stored
        out.extend_from_slice(&0u16.to_le_bytes()); // time
        out.extend_from_slice(&0u16.to_le_bytes()); // date
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // extra len
        out.extend_from_slice(name_bytes);
        out.extend_from_slice(data);

        central.extend_from_slice(&0x02014b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&0x0800u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(data.len() as u32).to_le_bytes());
        central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        // name len 之後依序: extra len(2) + comment len(2) + disk(2) + int attr(2) + ext attr(4) = 12 bytes, 再接 offset(4)
        central.extend_from_slice(&[0u8; 12]);
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name_bytes);
    }
    let central_start = out.len();
    out.extend_from_slice(&central);
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(files.len() as u16).to_le_bytes());
    out.extend_from_slice(&(central.len() as u32).to_le_bytes());
    out.extend_from_slice(&(central_start as u32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostic_zip_structure_is_valid() {
        let files = vec![
            ("version.txt".to_string(), b"AI-Bao test\n".to_vec()),
            ("logs/helper-2026-10-20.log".to_string(), vec![b'x'; 5000]),
        ];
        let zip = make_zip_stored(&files);
        // EOCD 在結尾 22 bytes: 簽名、筆數、central 大小與位移要對得起來
        let eocd = &zip[zip.len() - 22..];
        assert_eq!(&eocd[0..4], &0x06054b50u32.to_le_bytes());
        let count = u16::from_le_bytes([eocd[10], eocd[11]]);
        assert_eq!(count, 2);
        let central_size = u32::from_le_bytes([eocd[12], eocd[13], eocd[14], eocd[15]]) as usize;
        let central_off = u32::from_le_bytes([eocd[16], eocd[17], eocd[18], eocd[19]]) as usize;
        assert_eq!(central_off + central_size, zip.len() - 22);
        assert_eq!(&zip[central_off..central_off + 4], &0x02014b50u32.to_le_bytes());
        // 第一筆 local header: 簽名 + CRC 與內容相符 + 資料原樣
        assert_eq!(&zip[0..4], &0x04034b50u32.to_le_bytes());
        let crc = u32::from_le_bytes([zip[14], zip[15], zip[16], zip[17]]);
        assert_eq!(crc, crc32(b"AI-Bao test\n"));
        let name_len = u16::from_le_bytes([zip[26], zip[27]]) as usize;
        assert_eq!(&zip[30..30 + name_len], b"version.txt");
        let data_start = 30 + name_len;
        assert_eq!(&zip[data_start..data_start + 12], b"AI-Bao test\n");
        // 第二筆 local header 緊接在第一筆資料之後, central 每筆固定 46+name
        let second = data_start + 12;
        assert_eq!(&zip[second..second + 4], &0x04034b50u32.to_le_bytes());
    }
}
