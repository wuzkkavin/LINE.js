// 引擎管理: payload 解開、監督者啟停、存活監督。
// 引擎 = pack 管線產出的 SEA exe (內含核心 3789 + helper 3790 + 監督者), 由 build.rs 嵌入。
use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use crate::shell;

pub const ENGINE_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/engine.exe"));
pub const ENGINE_EMBEDDED: bool = env!("AIBAO_ENGINE_EMBEDDED").as_bytes()[0] == b'1';
pub const ENGINE_ID: &str = env!("AIBAO_ENGINE_ID");

/// 預設連接埠 (核心 3789、控制台 3790)。執行期實際連接埠可能不同:
/// 使用者在總覽按「改用空閒連接埠」後, 殼改用空閒埠並存進 shell-settings,
/// 之後 helper_api、chatview、engine 探測一律讀執行期連接埠, 不再寫死預設值。
pub const CORE_PORT: u16 = 3789;
pub const HELPER_PORT: u16 = 3790;

/// 執行期連接埠 (啟動時由 shell-settings 帶入, 預設即上列常數; 改埠按鈕先改這裡
/// 再重啟引擎, 引擎監督者與子行程經環境變數拿到同一組埠)。
static RUNTIME_PORTS: std::sync::RwLock<(u16, u16)> = std::sync::RwLock::new((CORE_PORT, HELPER_PORT));

pub fn core_port() -> u16 {
    runtime_ports().0
}

pub fn helper_port() -> u16 {
    runtime_ports().1
}

pub fn runtime_ports() -> (u16, u16) {
    *RUNTIME_PORTS.read().unwrap()
}

pub fn set_runtime_ports(core: u16, helper: u16) {
    *RUNTIME_PORTS.write().unwrap() = (core, helper);
}

/// 挑一對空閒連接埠 (改用空閒連接埠用): 從 3801 起掃描, 核心與控制台各取第一個
/// 當下 bind 得上的埠 (bind 後立即放掉; 引擎真正啟動前仍有被別人搶走的極小窗口,
/// 若重啟後又撞佔用, 提示會再出現、使用者可再按一次)。掃不到回 None。
pub fn pick_free_port_pair() -> Option<(u16, u16)> {
    use std::net::TcpListener;
    let free = |p: u16| TcpListener::bind(("127.0.0.1", p)).is_ok();
    for core in 3801..=3999u16 {
        if !free(core) {
            continue;
        }
        for helper in (core + 1)..=4000u16 {
            if free(helper) {
                return Some((core, helper));
            }
        }
    }
    None
}

/// 佔用者明細: 逐埠列出 listen 行程的 PID 與映像名稱 (取得到才列), 附在 Foreign 說明後面 —
/// 只說「不明程式」使用者無從辨認 (2026-10-20 補充要求): 有了 PID 與程式名, 就能在工作管理員對上號,
/// 也能分辨到底是自家 stack 還在跑、還是真的外來程式 (例如其他工具遺留的 node 服務)。
fn occupant_detail() -> String {
    #[cfg(windows)]
    {
        let mut parts: Vec<String> = Vec::new();
        for port in [core_port(), helper_port()] {
            let pids = crate::platform::listening_pids(port);
            if pids.is_empty() {
                parts.push(format!("埠 {port}: 查不到 listen 行程"));
                continue;
            }
            let descs: Vec<String> = pids
                .iter()
                .map(|pid| {
                    let name = crate::platform::process_image_path(*pid)
                        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
                        .unwrap_or_else(|| "名稱未知".to_string());
                    format!("行程 {pid} ({name})")
                })
                .collect();
            parts.push(format!("埠 {port}: {}", descs.join("、")));
        }
        format!("佔用者: {}", parts.join("; "))
    }
    #[cfg(not(windows))]
    {
        "佔用者: 此平台無法取得行程資訊".to_string()
    }
}

/// 埠被外來程式佔用時的白話訊息 (顯示在主視窗狀態區, 要讓使用者知道下一步怎麼做)。
/// 注意分界: 「不認識的程式」才是 Foreign; 舊版 AI寶 (無身分標記的自家舊世代) 歸 Legacy, 由殼收編並負責結束, 不走這段訊息。
/// 訊息裡的埠號用執行期連接埠 (改用空閒連接埠後, 佔用的就是新埠, 不能再寫死 3789/3790)。
/// 總覽的佔用提示用此前綴判斷 Failed 是否為佔用 (見 page_overview)。
pub fn foreign_port_message() -> String {
    let (core, helper) = runtime_ports();
    format!("連接埠被其他程式佔用了: 在這台電腦上回應的服務, 無法確認是 AI寶 (可能是其他程式, 也可能是沒被辨識出來的 AI寶 服務)。AI寶 先不啟動、也不會去動對方的程式。下方有佔用者的行程資訊, 請先在工作管理員確認並關閉佔用連接埠 {core} 或 {helper} 的程式, 再重新開啟 AI寶。")
}

/// 收編舊世代引擎時的 log/狀態用語 (不是錯誤: 是同產品舊版, 殼接手管理與結束)。
pub const LEGACY_ADOPTED_MESSAGE: &str = "偵測到舊版 AI寶 的服務還在執行 (舊世代), 已由本程式接手管理; 之後按「結束服務並關閉程式」會一併把它清乾淨。";

/// 單一埠上服務的世代分類 (結束序列加嚴的核心概念, 2026-10-20 老吳實機定案):
/// 分類證據都來自實際回應內容, 不用猜的。
#[derive(Debug, Clone, Copy, PartialEq)]
enum SvcClass {
    /// 沒人 listen / 連不上
    None,
    /// 目前世代 (核心: LINE.js 網頁; helper: /api/status 帶 service 身分標記)
    Current,
    /// 舊世代 AI寶 (核心仍是 LINE.js 網頁; helper /api/status 是舊形狀 {version, bot, serverTime} 無身分標記)
    Legacy,
    /// 不明程式 (有完整回應但形狀不符任何世代)
    Foreign,
    /// 身分未定: 埠上有回應 (HTTP 狀態探得到) 但 body 讀不完整 — 服務可能正在退場或啟動中。
    /// 這是「重開撞到自己上一代還在退場」的競態窗口 (2026-10-20 老吳實機定案之三):
    /// 不可直接判 Foreign, 必須等待重探讓對方退場完成或啟動完成後再定案。
    Flapping,
}

/// 執行中 stack 的建置版本戳記比對結果。戳記 = ENGINE_ID (payload 內容雜湊+長度,
/// build.rs 產生, 同時是引擎解開目錄名 engine/<ENGINE_ID>/): 從埠上 listener 行程的
/// 映像路徑就能讀出該 stack 是用哪個建置的引擎在跑, 不必等對方回應 (對方忙到不回應時也判得出)。
#[derive(Debug, Clone, PartialEq)]
enum StackVersion {
    /// 與本殼同一個建置
    SameBuild,
    /// 自家產品但不同建置 (附對方的 ENGINE_ID; 獨立執行形態以雜湊或大小標記)
    OtherBuild(String),
    /// 判讀不出 (映像不是自家引擎命名 — 例如 stub 的 pwsh 託管者 — 或非 Windows 環境):
    /// 不干預, 回到只看回應形狀的既有分類。
    Unknown,
}

/// 從行程映像路徑讀 ENGINE_ID: 路徑形狀須為 <資料目錄>/engine/<16 碼 hex>-<數字>/engine.exe,
/// 形狀不符回 None (避免把任意目錄名當戳記)。
fn engine_id_of_image(path: &std::path::Path) -> Option<String> {
    let root = shell::data_dir().join("engine");
    let dir = path.parent()?;
    if dir.parent()? != root {
        return None;
    }
    let id = dir.file_name()?.to_string_lossy().to_string();
    let (hash, size) = id.split_once('-')?;
    if hash.len() == 16
        && hash.chars().all(|c| c.is_ascii_hexdigit())
        && !size.is_empty()
        && size.chars().all(|c| c.is_ascii_digit())
    {
        Some(id)
    } else {
        None
    }
}

fn running_stack_version() -> StackVersion {
    if !ENGINE_EMBEDDED {
        return StackVersion::Unknown;
    }
    #[cfg(windows)]
    {
        for port in [core_port(), helper_port()] {
            for pid in crate::platform::listening_pids(port) {
                if let Some(p) = crate::platform::process_image_path(pid) {
                    let v = stack_version_of_image(&p);
                    if v != StackVersion::Unknown {
                        return v;
                    }
                }
            }
        }
    }
    StackVersion::Unknown
}

/// 映像檔名是否像自家引擎 (獨立執行形態的判讀前提): 殼解開的 engine.exe、
/// 網頁版世代的 AI寶.exe、CI 歷史建置的 *-engine.exe、Ubuntu 的 aibao。
/// 其他映像 (pwsh/node 等託管者) 無法以檔案判讀建置 → 回 Unknown 不干預。
fn looks_like_family_engine(path: &std::path::Path) -> bool {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    name == "engine.exe"
        || name == "ai寶.exe"
        || name == "aibao"
        || name == "aibao.exe"
        || name.ends_with("-engine.exe")
}

/// 讀檔算 FNV-1a 64 (與 build.rs 產生 ENGINE_ID 的方式一致), 回完整戳記字串。
fn fnv_id_of_file(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in &bytes {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    Some(format!("{:016x}-{}", hash, bytes.len()))
}

/// 單一映像路徑的建置判定:
/// 1. 在殼的引擎目錄底下 (殼管理的引擎) → 目錄名即戳記, 直接比對。
/// 2. 獨立執行形態 (自家引擎命名、任意路徑 — 例如雙擊舊網頁版 AI寶.exe 佔埠,
///    或 CI 情境把歷史引擎 exe 直接拉起): 先比檔案大小 (歷代 payload 大小皆不同,
///    一擊判異); 大小相同才讀全檔算雜湊確認同版/異版, 結果以 (路徑,大小,修改時間)
///    快取, 避免反覆讀 100+MB 大檔。
/// 3. 其餘 → Unknown (不干預)。
fn stack_version_of_image(path: &std::path::Path) -> StackVersion {
    if let Some(id) = engine_id_of_image(path) {
        return if id == ENGINE_ID {
            StackVersion::SameBuild
        } else {
            StackVersion::OtherBuild(id)
        };
    }
    if !looks_like_family_engine(path) {
        return StackVersion::Unknown;
    }
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return StackVersion::Unknown,
    };
    let size = meta.len();
    if size as usize != ENGINE_BYTES.len() {
        return StackVersion::OtherBuild(format!("standalone-{size}"));
    }
    let mtime_nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    static CACHE: std::sync::Mutex<Option<(std::path::PathBuf, u64, u128, StackVersion)>> =
        std::sync::Mutex::new(None);
    if let Ok(c) = CACHE.lock() {
        if let Some((p, s, m, v)) = c.as_ref() {
            if p == path && *s == size && *m == mtime_nanos {
                return v.clone();
            }
        }
    }
    let v = match fnv_id_of_file(path) {
        Some(id) if id == ENGINE_ID => StackVersion::SameBuild,
        Some(id) => StackVersion::OtherBuild(id),
        None => StackVersion::Unknown,
    };
    if let Ok(mut c) = CACHE.lock() {
        *c = Some((path.to_path_buf(), size, mtime_nanos, v.clone()));
    }
    v
}

/// 版本不符的 log 節流: probe 會被 tick 每 4 秒呼叫, 同一個對方建置只記一次, 換了才再記。
fn log_version_mismatch(other: &str) {
    use std::sync::Mutex;
    static LAST: Mutex<Option<String>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap();
    if last.as_deref() != Some(other) {
        shell::log_line(&format!(
            "版本戳記不符: 埠上 AI寶 服務是建置 {other}, 本程式是 {ENGINE_ID}; 視為舊世代走換版流程 (不收編使用)"
        ));
        *last = Some(other.to_string());
    }
}

/// 單一埠探測的原始結果: 先分「完全無回應 / 回應不完整 / 有完整 body」三層, 再依 body 形狀分類。
enum PortProbe {
    NoResponse,
    Incomplete,
    Body(String),
}

fn probe_port(port: u16, path: &str) -> PortProbe {
    match http_get_text(port, path) {
        Some(text) => PortProbe::Body(text),
        None => {
            if http_status(port, path).is_some() {
                PortProbe::Incomplete
            } else {
                PortProbe::NoResponse
            }
        }
    }
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
    /// 監督者經停止訊號檔 (stop-request) 自行優雅退出 (session 有機會完成 DPAPI 封存), 且雙埠已驗證釋放
    GracefulSignal,
    /// 優雅結束送不到或逾時, 改以強制手段 (Job Object / 依 listener PID 結束 / 引擎目錄掃除) 清乾淨, 且雙埠已驗證釋放。
    /// 有用到強制手段就回這個 (不粉飾成優雅結束), UI 會在 log 留下紀錄。
    ForcedStop,
    /// 本來就沒在跑 (雙埠皆無服務)
    AlreadyStopped,
    /// 埠上有不明程式 (Foreign): 不是 AI寶 的服務, 殼不動它、也不關窗, 附白話說明給 UI 顯示。
    BlockedForeign(String),
    /// 已用盡手段仍有殘留: 附逐埠/逐行程明細, UI 不關窗並顯示明細 (不准謊報成功)。
    Residual(String),
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
    /// Starting 期間 helper 被判 Foreign 的連續次數 (要連續成立才鎖 Failed, 防啟動窗口的短暫異常形狀)
    starting_foreign_strikes: u8,
    /// Failed/ExternalRunning 狀態校正重探的節流時間點 (服務實際狀態變了, 殼要跟著改, 不鎖死舊判定)
    recovery_probe_at: Option<Instant>,
    /// 接手的引擎連續無回應次數 (達 2 次才改判已停止, 防單次探測抖動)
    external_gone_strikes: u8,
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
            starting_foreign_strikes: 0,
            recovery_probe_at: None,
            external_gone_strikes: 0,
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

    /// 任一埠還有服務在回應就算「還活著」。舊版是 ports_alive() 用 AND (雙埠都要有回應),
    /// 結果核心先死、helper 還在 (或反過來) 的半殘狀態會被誤判成「都停了」 — 結束序列加嚴時改為逐埠判定。
    fn any_service_alive() -> bool {
        http_status(core_port(), "/").is_some() || http_status(helper_port(), "/api/status").is_some()
    }

    /// 分類核心埠 (3789): 現行與舊世代的核心都是 LINE.js 網頁 (GET / 回 HTML);
    /// 回 JSON 或其他形狀的是不明程式; 連不上是 None。
    fn classify_core() -> SvcClass {
        match probe_port(core_port(), "/") {
            PortProbe::Body(text) => {
                let head: String = text.chars().take(512).collect::<String>().to_lowercase();
                if head.contains("<html") || head.contains("<!doctype") {
                    SvcClass::Current
                } else {
                    SvcClass::Foreign
                }
            }
            PortProbe::Incomplete => SvcClass::Flapping,
            PortProbe::NoResponse => SvcClass::None,
        }
    }

    /// 分類 helper 埠 (3790), 證據是 /api/status 的實際 JSON 形狀 (2026-10-20 查 git 歷史定案):
    /// 目前世代: {service:"aibao-helper", capabilities, bot, ...}; 舊世代 (4a54c35 網頁版與 1314fb3 第一代殼同形):
    /// {version, bot, serverTime} 無 service 欄位。有回應但兩種形狀都不是 (例如 CI 的 stub 只有 {version, bot}、缺 serverTime) → Foreign。
    fn classify_helper() -> SvcClass {
        match probe_port(helper_port(), "/api/status") {
            PortProbe::Body(text) => {
                let v: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => return SvcClass::Foreign,
                };
                if v.get("service").and_then(|s| s.as_str()) == Some("aibao-helper") {
                    return SvcClass::Current;
                }
                if v.get("version").is_some() && v.get("bot").is_some() && v.get("serverTime").is_some() {
                    return SvcClass::Legacy;
                }
                SvcClass::Foreign
            }
            PortProbe::Incomplete => SvcClass::Flapping,
            PortProbe::NoResponse => SvcClass::None,
        }
    }

    /// 同時分類兩埠, 回傳 (核心, helper)。分類後一律套版本戳記 (見 apply_version_stamp)。
    fn probe_classes() -> (SvcClass, SvcClass) {
        let (core, helper) = (Self::classify_core(), Self::classify_helper());
        Self::apply_version_stamp(core, helper)
    }

    /// 把建置版本戳記套進世代分類: 在跑的 stack 若是「自家產品但不同建置」, helper 一律降為
    /// Legacy (走清除/換版流程), 不得當 Current 收編使用 — classify 只看 /api/status 形狀
    /// 分不出建置世代: 舊建置 helper 同樣有 service 身分標記, 曾被新殼當 Current 收編,
    /// 結果新殼用舊 helper 服務 (新端點回 404、舊掃描行為重現, 2026-10-20 老吳實機定案之四)。
    fn apply_version_stamp(core: SvcClass, helper: SvcClass) -> (SvcClass, SvcClass) {
        if helper != SvcClass::Current {
            return (core, helper);
        }
        if let StackVersion::OtherBuild(other) = running_stack_version() {
            log_version_mismatch(&other);
            return (core, SvcClass::Legacy);
        }
        (core, helper)
    }

    /// 啟動前專用的身分確認 (多輪重探): 單輪探測可能正好撞上自家引擎「正在退場/正在啟動」的窗口 —
    /// 對方還在 listen、能回 HTTP 狀態, 但 body 送不完整 (Flapping); 舊版在這種窗口把 body 讀不到
    /// 直接判 Foreign, 於是「結束後立刻重開」被誤判成不明程式佔埠並鎖死異常停止 (2026-10-20 實機)。
    /// 定案規則: 任一輪乾淨 (無 Foreign、無 Flapping) 立即定案; Foreign 必須連續兩輪都由完整 body
    /// 證據成立才定案; 輪次耗盡仍 Flapping 時, 視為「持續有回應卻永遠無法辨識」→ 改判 Foreign
    /// (真外來程式的特徵; 自家引擎的退場/啟動窗口會在輪次內自己結束)。
    fn probe_classes_confirmed(max_rounds: u32, wait: Duration) -> (SvcClass, SvcClass) {
        let mut last = Self::probe_classes();
        let mut foreign_strikes = 0u32;
        for round in 1..=max_rounds {
            let (c, h) = last;
            let has_foreign = c == SvcClass::Foreign || h == SvcClass::Foreign;
            let has_flap = c == SvcClass::Flapping || h == SvcClass::Flapping;
            if !has_foreign && !has_flap {
                return last;
            }
            if has_foreign {
                foreign_strikes += 1;
                if foreign_strikes >= 2 {
                    return last;
                }
            } else {
                foreign_strikes = 0;
            }
            if round == max_rounds {
                break;
            }
            shell::log_line(&format!(
                "埠上服務身分未定 (核心={c:?}, helper={h:?}; 可能正在退場或啟動中), 等待後重探 (下一輪 {}/{max_rounds})",
                round + 1
            ));
            std::thread::sleep(wait);
            last = Self::probe_classes();
        }
        let settle = |c: SvcClass| if c == SvcClass::Flapping { SvcClass::Foreign } else { c };
        (settle(last.0), settle(last.1))
    }

    /// 啟動引擎。冪等: 已在跑就直接回報目前狀態。
    pub fn start(&mut self) -> Result<(), String> {
        match self.state {
            EngineState::Running | EngineState::ExternalRunning | EngineState::Starting => return Ok(()),
            _ => {}
        }
        // 已有服務在跑 (不是我們啟的): 先依世代分類 —
        // Foreign (不明程式): 明確擋下並說明, 不動對方、不用它的服務。
        // Current (目前世代, 例如另一個新版 AI寶 或新版網頁版啟的): 收編為 ExternalRunning, 只顯示狀態, 結束時走 stop() 的收編路徑。
        // Legacy (舊世代 AI寶): 不能直接收編來用 — 舊 helper 沒有目前世代的端點 (list-models 等), 收編等於重演 404 陷阱;
        // 正確收編是先把舊殘留清乾淨 (與 stop() 同一條強制清除路徑), 再啟動目前世代引擎, 使用者打開新版 App 就是要用新版。
        // 身分判定走多輪確認: 避免撞上自家上一代引擎退場窗口 (Flapping) 被誤判 Foreign 鎖死。
        let (core_cls, helper_cls) = Self::probe_classes_confirmed(4, Duration::from_millis(700));
        if core_cls == SvcClass::Foreign || helper_cls == SvcClass::Foreign {
            let detail = occupant_detail();
            let msg = format!("{}\n{detail}", foreign_port_message());
            self.state = EngineState::Failed(msg.clone());
            shell::log_line(&format!("偵測到連接埠被不明程式佔用 (世代分類=Foreign, 多輪確認後定案), 已擋下並提示使用者。{detail}"));
            return Err(msg);
        }
        let any_alive = core_cls != SvcClass::None || helper_cls != SvcClass::None;
        if any_alive && helper_cls == SvcClass::Legacy {
            shell::log_line(LEGACY_ADOPTED_MESSAGE);
            let legacy_images = Self::force_clear_services("啟動前收編舊世代");
            if !Self::wait_ports_clear(Duration::from_secs(10)) {
                let detail = Self::residual_detail();
                let msg = format!("舊版 AI寶 的服務清不乾淨, 本程式先不啟動。殘留: {detail}。請到工作管理員結束 AI寶 的行程後再重新開啟本程式。");
                self.state = EngineState::Failed(msg.clone());
                shell::log_line(&format!("收編舊世代失敗: {detail}"));
                return Err(msg);
            }
            // 舊監督者收到子行程結束會自己收尾 (含 session 封存), 等它退場再啟動, 避免兩個監督者同時碰 session 檔
            Self::wait_image_gone(&legacy_images, Duration::from_secs(8));
            shell::log_line("舊世代殘留已清乾淨, 接著啟動目前世代引擎");
        } else if any_alive {
            self.state = EngineState::ExternalRunning;
            shell::log_line("偵測到目前世代引擎已在執行 (非本程式啟動), 接手顯示狀態");
            return Ok(());
        }
        let exe = Self::ensure_extracted()?;
        self.state = EngineState::Starting;
        self.started_at = Some(Instant::now());
        #[cfg(windows)]
        {
            let job = crate::platform::JobHandle::new_kill_on_close()
                .map_err(|e| format!("建立行程管理 (Job Object) 失敗: {e}"))?;
            let spawned = crate::platform::spawn_engine_suspended(&exe, &[
                ("HWLINEHELPER_NO_BROWSER", "1"),
                ("HWLINE_CORE_PORT", &core_port().to_string()),
                ("HELPER_PORT", &helper_port().to_string()),
            ])
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
                .env("HWLINE_CORE_PORT", core_port().to_string())
                .env("HELPER_PORT", helper_port().to_string())
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
                    // 監督者結束但埠還在: 依世代分類標示 — 不明程式 (Foreign) 明確標示;
                    // 其餘是 AI寶 某世代的服務還活著 (例如被別的實例接手), 收編為 ExternalRunning 顯示狀態。
                    if Self::any_service_alive() {
                        // 一樣走多輪確認: 監督者剛退場的瞬間最容易撞上退場窗口的 Flapping/跨界誤判
                        let (core_cls, helper_cls) = Self::probe_classes_confirmed(2, Duration::from_millis(600));
                        if core_cls == SvcClass::Foreign || helper_cls == SvcClass::Foreign {
                            self.state = EngineState::Failed(format!("{}\n{}", foreign_port_message(), occupant_detail()));
                        } else {
                            self.state = EngineState::ExternalRunning;
                        }
                    } else {
                        self.state = EngineState::Failed("引擎已停止 (監督者行程結束)".to_string());
                        self.pid = None;
                    }
                    return;
                }
                if self.state == EngineState::Starting {
                    // 就緒 = 雙埠都有回應且 helper 是目前世代 (少一邊都不算就緒, 半套存活不能裝作正常)。
                    // 走 probe_classes (含版本戳記): 若埠上其實是別的建置的自家 stack, 不算就緒。
                    let (core_cls_rt, helper_cls) = Self::probe_classes();
                    let core_up = core_cls_rt != SvcClass::None;
                    if core_up && helper_cls == SvcClass::Current {
                        self.state = EngineState::Running;
                        self.starting_foreign_strikes = 0;
                        shell::log_line(&format!("引擎就緒: 核心 {} 與 helper {} 皆回應 (身分驗證通過)", core_port(), helper_port()));
                    } else if helper_cls == SvcClass::Foreign {
                        // 自己的 helper 還在啟動窗口時, 3790 可能短暫是別的東西在退場 (或回應形狀未定);
                        // 連續 3 次探測都由完整 body 證明是 Foreign 才定案, 不因單次命中就鎖死。
                        self.starting_foreign_strikes += 1;
                        if self.starting_foreign_strikes >= 3 {
                            let detail = occupant_detail();
                            self.state = EngineState::Failed(format!("{}\n{detail}", foreign_port_message()));
                            shell::log_line(&format!("引擎啟動時發現連接埠被不明程式佔用 (世代分類=Foreign, 連續探測確認)。{detail}"));
                            return;
                        }
                    } else {
                        self.starting_foreign_strikes = 0;
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
            EngineState::Failed(_) | EngineState::ExternalRunning => {
                // 狀態校正: Failed 多半是啟動當下的判定 (例如撞上上一代退場窗口被判 Foreign),
                // 但服務的實際狀態會變 — 引擎後來自己起來了 (或接手的引擎已退場), 殼必須跟著改,
                // 不得鎖死在舊判定 (2026-10-20 實機: 殼顯示異常停止, helper 其實已在跑)。
                // 只在殼手上沒有自己的行程時做 (有行程的狀態由 Starting/Running 分支負責), 每 4 秒一輪。
                if self.proc.is_some() {
                    return;
                }
                let due = self.recovery_probe_at.map(|t| t.elapsed() >= Duration::from_secs(4)).unwrap_or(true);
                if !due {
                    return;
                }
                self.recovery_probe_at = Some(Instant::now());
                let (core_cls, helper_cls) = Self::probe_classes();
                let current_alive = helper_cls == SvcClass::Current
                    && matches!(core_cls, SvcClass::Current | SvcClass::None);
                let all_gone = core_cls == SvcClass::None && helper_cls == SvcClass::None;
                if matches!(self.state, EngineState::Failed(_)) && current_alive {
                    self.state = EngineState::ExternalRunning;
                    shell::log_line("狀態校正: 先前判定已過時 — 目前世代引擎實際在執行, 改為接手顯示狀態 (執行中)");
                } else if matches!(self.state, EngineState::ExternalRunning) {
                    if all_gone {
                        self.external_gone_strikes += 1;
                        if self.external_gone_strikes >= 2 {
                            self.external_gone_strikes = 0;
                            self.state = EngineState::Stopped;
                            self.pid = None;
                            shell::log_line("狀態校正: 接手的引擎已不在執行 (雙埠連續無回應), 狀態改為已停止");
                        }
                    } else {
                        self.external_gone_strikes = 0;
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

    /// 結束序列 (規格書 v3 第 7 節 + 2026-10-20 殘留定案加嚴): 四階段, 每階段後都以「雙埠逐埠驗證釋放」為準,
    /// 不再有「回傳成功但服務還在」的路徑。為什麼不用 CTRL_BREAK: CREATE_NO_WINDOW 的行程沒有主控台,
    /// 控制事件送不到 (2026-10-20 雲端探針實測失敗) — 規格書 v3 風險 2 的定案退路是停止訊號檔。
    ///
    /// 階段: (1) 訊號檔請監督者優雅結束 (自己的引擎與收編的目前世代引擎都支援; 舊世代不理會, 逾時往下走)
    /// (2) Job Object 整樹 + 依 listener PID 強制結束 (涵蓋收編引擎與舊世代: 它們的監督者不在我們的 Job 裡)
    /// (3) 掃資料目錄 engine/ 底下各世代引擎映像的行程補刀 (監督者本人在埠釋放後也算殘留)
    /// (4) 逐埠最終驗證: 全清才回成功 (有動到強制手段回 ForcedStop); 還有殘留回 Residual 附明細, 絕不謊報。
    /// 例外: 埠上是 Foreign (不明程式) 時, 在階段 1 之前就回 BlockedForeign — 不是我們的服務, 不動它也不關窗。
    /// Failed 狀態 (多半是啟動時就被 Foreign 擋下) 一律走本函式完整分類判定 — 舊版沒有專屬分支、落進「自己引擎」區塊,
    /// 又在逾時後謊報成功直接關窗, 是老吳實機「結束了但服務還在」的定案根因之二。
    pub fn stop(&mut self) -> StopOutcome {
        // 先逐埠分類現況 (Failed / External / 任何狀態都一樣辦理, 不依 state 猜)。
        // Flapping (回應不完整) 先等 1.5 秒重探一次: 服務可能正在退場, 不能把退場中的自家服務
        // 當成不明程式擋下; 重探後仍 Flapping 就當作自家服務走正常結束流程 (階段 1 訊號+等待會處理)。
        let (mut core_cls, mut helper_cls) = Self::probe_classes();
        if core_cls == SvcClass::Flapping || helper_cls == SvcClass::Flapping {
            std::thread::sleep(Duration::from_millis(1500));
            let again = Self::probe_classes();
            core_cls = if again.0 == SvcClass::Flapping { SvcClass::Current } else { again.0 };
            helper_cls = if again.1 == SvcClass::Flapping { SvcClass::Current } else { again.1 };
            shell::log_line("結束前探測: 埠上服務回應不完整 (可能正在退場), 已重探並依自家服務流程處理");
        }
        if core_cls == SvcClass::None && helper_cls == SvcClass::None {
            return self.finish_stopped(StopOutcome::AlreadyStopped, "結束檢查: 雙埠皆無服務, 本來就沒在跑");
        }
        if core_cls == SvcClass::Foreign || helper_cls == SvcClass::Foreign {
            let detail = Self::residual_detail();
            shell::log_line(&format!("結束被擋下: 埠上有不明程式 (非 AI寶 服務), 不動它也不關窗。現況: {detail}"));
            return StopOutcome::BlockedForeign(format!(
                "沒有把服務停下來: 連接埠 {} 或 {} 上回應的服務無法確認是 AI寶, 本程式不會去結束別人的程式, 視窗先不關。現況: {detail}。請先到工作管理員結束佔用該連接埠的程式, 再重新開啟 AI寶。",
                core_port(),
                helper_port()
            ));
        }

        // ---- 階段 1: 停止訊號檔優雅結束 (12 秒, 等待期間訊號被監督者啟動清除時自動補寫) ----
        let stop_file = shell::data_dir().join("stop-request");
        let _ = std::fs::write(&stop_file, b"stop");
        shell::log_line("結束序列階段 1: 已放出停止訊號檔, 等待監督者優雅結束");
        if Self::wait_services_clear(Duration::from_secs(12), Some(&stop_file)) {
            let own_exited = self.proc.is_none() || self.proc_exited();
            return self.finish_stopped(
                StopOutcome::GracefulSignal,
                if own_exited { "引擎已優雅結束 (停止訊號檔路徑, 雙埠已驗證釋放)" } else { "服務已優雅結束 (停止訊號檔路徑, 雙埠已驗證釋放)" },
            );
        }

        // ---- 階段 2+3: 強制清除 (Job 整樹 + listener PID + 引擎目錄掃除) ----
        shell::log_line("結束序列階段 2: 優雅結束逾時, 改走強制清除 (Job + listener PID + 引擎目錄掃除)");
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.terminate();
            shell::log_line("結束序列階段 2: 已以 Job Object 整樹結束自己的引擎行程樹");
        }
        #[cfg(not(windows))]
        if let Some(mut c) = self.proc.take() {
            let _ = c.kill();
        }
        let _ = Self::force_clear_services("結束序列");
        if Self::wait_services_clear(Duration::from_secs(10), None) {
            return self.finish_stopped(StopOutcome::ForcedStop, "引擎已強制清乾淨 (雙埠已驗證釋放)");
        }

        // ---- 階段 4: 最終驗證 — 還有人活著就誠實回 Residual, 不關窗 ----
        let detail = Self::residual_detail();
        shell::log_line(&format!("結束序列未清乾淨, 回報殘留 (不關窗): {detail}"));
        StopOutcome::Residual(format!(
            "服務還沒有完全停下來, 這個視窗先不關, 以免你誤以為已經結束。殘留: {detail}。可以再按一次「結束服務並關閉程式」重試, 或到工作管理員結束上面列出的行程。"
        ))
    }

    /// 統一收尾: 清掉殼持有的行程/Job 控制權並把狀態標為 Stopped (只在已驗證雙埠釋放後呼叫)。
    fn finish_stopped(&mut self, outcome: StopOutcome, log_msg: &str) -> StopOutcome {
        #[cfg(windows)]
        {
            // Job 設了 KILL_ON_JOB_CLOSE: 放掉 handle 等於再保險清一次整樹 (此時服務已驗證全停, 不會誤傷)
            self.job = None;
        }
        self.proc = None;
        self.pid = None;
        self.state = EngineState::Stopped;
        shell::log_line(log_msg);
        outcome
    }

    /// 等到雙埠都沒有回應為止 (逐埠判定, 任一埠活著就繼續等)。
    /// stop_file 有給時, 等待期間檔案不見就補寫 (監督者啟動初期會清一次殘留訊號檔的競態防護)。
    fn wait_services_clear(total: Duration, stop_file: Option<&std::path::Path>) -> bool {
        let deadline = Instant::now() + total;
        loop {
            if !Self::any_service_alive() {
                return true;
            }
            if Instant::now() >= deadline {
                return !Self::any_service_alive();
            }
            if let Some(f) = stop_file {
                if !f.exists() {
                    let _ = std::fs::write(f, b"stop");
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    fn wait_ports_clear(total: Duration) -> bool {
        Self::wait_services_clear(total, None)
    }

    /// 強制清除埠上屬 AI寶 的服務 (呼叫端須已確認不是 Foreign):
    /// Job Object 整樹 (自己的引擎) → 依兩埠 listener PID 強制結束 (收編/舊世代) → 掃 engine/ 目錄底下行程補刀。
    /// 回傳被結束行程的映像路徑清單 (供呼叫端等待舊監督者退場用)。非 Windows 為開發樁, 只殺自己的子行程。
    fn force_clear_services(context: &str) -> Vec<PathBuf> {
        let mut images: Vec<PathBuf> = Vec::new();
        #[cfg(windows)]
        {
            // 注: 自己的引擎另有 Job Object 整樹 (stop() 階段 2 先行、finish_stopped 放掉 handle 再掃一次);
            // 這裡專門處理不在我們 Job 裡的行程: 收編/舊世代的 listener 與 engine 目錄底下的殘留監督者。
            let engine_root = shell::data_dir().join("engine");
            let mut targets: Vec<u32> = Vec::new();
            for port in [core_port(), helper_port()] {
                for pid in crate::platform::listening_pids(port) {
                    if let Some(p) = crate::platform::process_image_path(pid) {
                        images.push(p);
                    }
                    targets.push(pid);
                }
            }
            targets.extend(crate::platform::pids_with_image_under(&engine_root));
            targets.sort_unstable();
            targets.dedup();
            for pid in &targets {
                if crate::platform::terminate_pid(*pid) {
                    shell::log_line(&format!("{context}: 已強制結束行程 pid={pid}"));
                }
            }
            if targets.is_empty() {
                shell::log_line(&format!("{context}: 強制清除未找到屬 AI寶 的行程 (埠上服務可能正在自行結束)"));
            }
        }
        #[cfg(not(windows))]
        {
            let _ = context;
        }
        images.sort();
        images.dedup();
        images
    }

    /// 等映像路徑清單裡的行程全部消失 (舊監督者收到子行程結束後要自己收尾, 需要一點時間;
    /// 等它退場再啟動新引擎, 避免兩個監督者同時碰 session 檔。逾時只記 log 不擋路)。
    fn wait_image_gone(images: &[PathBuf], total: Duration) {
        if images.is_empty() {
            return;
        }
        #[cfg(windows)]
        {
            let deadline = Instant::now() + total;
            loop {
                if crate::platform::pids_with_image_in(images).is_empty() {
                    return;
                }
                if Instant::now() >= deadline {
                    shell::log_line("等待舊監督者退場逾時, 仍繼續啟動 (新監督者會自行處理埠狀態)");
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (images, total);
        }
    }

    /// 逐埠殘留明細 (給 Residual/BlockedForeign 訊息與 log 用): 每埠的分類與 listener PID。
    fn residual_detail() -> String {
        let (core_cls, helper_cls) = Self::probe_classes();
        let fmt = |port: u16, cls: SvcClass| -> String {
            #[cfg(windows)]
            let pids = crate::platform::listening_pids(port);
            #[cfg(not(windows))]
            let pids: Vec<u32> = Vec::new();
            if cls == SvcClass::None {
                format!("埠 {port}: 無服務")
            } else if pids.is_empty() {
                format!("埠 {port}: {cls:?} (查不到 listen 行程)")
            } else {
                let descs: Vec<String> = pids
                    .iter()
                    .map(|pid| {
                        #[cfg(windows)]
                        let name = crate::platform::process_image_path(*pid)
                            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()));
                        #[cfg(not(windows))]
                        let name: Option<String> = None;
                        match name {
                            Some(n) => format!("{pid} ({n})"),
                            None => pid.to_string(),
                        }
                    })
                    .collect();
                format!("埠 {port}: {cls:?} (行程 {})", descs.join(", "))
            }
        };
        format!("{}; {}", fmt(core_port(), core_cls), fmt(helper_port(), helper_cls))
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
    http_post_text_long(port, path, json_body, 10)
}

/// POST 的較長逾時版: 給「首次呼叫要等平台冷啟動」的端點探測用 — 例如 /api/list-models
/// 在沒帶 Key 時須先讀 Windows 認證管理員 (helper 要冷啟動 PowerShell + Add-Type 編譯,
/// 忙碌的 CI 機器上實測可超過 10 秒, run 39413133498 探針因此假失敗)。
pub fn http_post_text_long(port: u16, path: &str, json_body: &str, read_secs: u64) -> Option<(u16, String)> {
    use std::io::Read as _;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(read_secs))
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
/// GET 並讀完整 body 的較長逾時版 (給需要等核心定案的端點探測用, 如 /api/line/chats)。
pub fn http_get_text_long(port: u16, path: &str, read_secs: u64) -> Option<String> {
    use std::io::Read as _;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(read_secs))
        .build();
    let resp = agent.get(&format!("http://127.0.0.1:{port}{path}")).call().ok()?;
    let mut text = String::new();
    resp.into_reader().read_to_string(&mut text).ok()?;
    Some(text)
}

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
