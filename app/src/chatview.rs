//! 「聊天室畫面」頁嵌入的核心聊天畫面 (http://127.0.0.1:<核心連接埠>, 預設 3789)。
//!
//! 只有 Windows + MSVC 建置 (CI 正式成品的工具鏈) 才有真的 WebView2 嵌入:
//! 以 wry 建立子視窗掛在 eframe 主視窗 (HWND) 底下, 位置/尺寸每幀跟 egui 預留的
//! 矩形同步 (本 App 視窗固定尺寸不可縮放, 不需處理縮放協議)。其他平台 (本機
//! Linux 檢查版、windows-gnu) available() = false, 該頁改顯示白話占位。
//!
//! 顯示條件由 main.rs 每幀裁決: 只在「聊天室畫面」頁、已登入、無對話框開啟、
//! 視窗未縮到系統匣時才顯示; 其餘一律 force_hide(), 避免原生子視窗殘留在
//! 其他頁面或蓋住程式自己的對話框 (原生子視窗永遠畫在父視窗表面之上)。
//!
//! 查證 (2026-10-21, 讀上游核心原始碼): 核心 src/http/server.ts 在 serve 根頁面
//! 的同一個回應就 Set-Cookie: linejs_browser=<token> (頁面自己拿到 cookie 後再
//! 連 WS), 所以全新 WebView2 profile 直接載入根頁面即可使用, 不需要先行流程。

use std::path::Path;

// 只在 Windows MSVC 的 imp 模組裡使用; 其他平台編譯時標記允許未使用, 免警告。
#[cfg_attr(not(all(windows, target_env = "msvc")), allow(dead_code))]
/// 核心聊天頁位址 (執行期核心連接埠組裝; 改用空閒連接埠後跟著變)。
pub fn chat_url() -> String {
    format!("http://127.0.0.1:{}/", crate::engine::core_port())
}

pub fn available() -> bool {
    cfg!(all(windows, target_env = "msvc"))
}

pub struct ChatViewHost {
    #[cfg(all(windows, target_env = "msvc"))]
    inner: Option<imp::Inner>,
    #[cfg(all(windows, target_env = "msvc"))]
    error: Option<String>,
    #[cfg(all(windows, target_env = "msvc"))]
    last_attempt: Option<std::time::Instant>,
    // 修復版6後續修復: 診斷用狀態, 讓「全白」不再是無訊息的空白。
    // hwnd_missing = 上次 sync 時主視窗代碼是空的 (靜默不建立的分支);
    // diag_logged_at = 上次寫診斷紀錄的時間 (節流, 避免每幀刷 log)。
    // 導覽網址另由導覽處理器寫進 shell.log (處理器拿不到 &mut self, 不經狀態欄)。
    #[cfg(all(windows, target_env = "msvc"))]
    hwnd_missing: bool,
    #[cfg(all(windows, target_env = "msvc"))]
    diag_logged_at: Option<std::time::Instant>,
    // 修復版6後續修復: 進頁/重新載入時要求強制重排重顯一次。
    // 機制 (2026-10-24 真機證據): 老吳把 App 縮小再打開後畫面就出現了——
    // 縮放帶來的視窗重排會讓子視窗重新對齊位置尺寸並重新顯示, 而第一次進頁時
    // 這個重排沒有發生, 且已建立的 WebView 之後只有矩形改變才重設位置、
    // set_visible(true) 失敗也會被無條件記成已顯示, 之後不再重試。
    // 因此進頁與重新載入時主動做一次「縮小再打開時的那個動作」: 不論快取的
    // 矩形/可見旗標, 無條件重調 set_bounds + set_visible(true)。
    #[cfg(all(windows, target_env = "msvc"))]
    reveal: bool,
}

impl ChatViewHost {
    /// WebView 是否已建立 (給聊天室畫面頁的進頁狀態紀錄用)。
    pub fn is_created(&self) -> bool {
        #[cfg(all(windows, target_env = "msvc"))]
        {
            self.inner.is_some()
        }
        #[cfg(not(all(windows, target_env = "msvc")))]
        {
            false
        }
    }

    /// 重新載入聊天畫面: 銷毀目前的 WebView 與其瀏覽器內容 (含 profile 連線),
    /// 清掉錯誤與上次嘗試時間, 下一次 sync 會重新建立並重新載入核心聊天頁。
    /// 給畫面全白等異常時自救用, 不必結束程式。
    #[cfg(all(windows, target_env = "msvc"))]
    pub fn reset(&mut self) {
        self.inner = None;
        self.error = None;
        self.last_attempt = None;
        self.hwnd_missing = false;
        self.reveal = true;
        crate::shell::log_line("嵌入聊天畫面: 已銷毀 WebView, 下一幀會重新建立 (使用者按了重新載入)");
    }

    #[cfg(not(all(windows, target_env = "msvc")))]
    pub fn reset(&mut self) {}

    /// 進頁時要求強制重排重顯一次 (見 reveal 欄位註解): 已建立的 WebView
    /// 下一幀無條件重調位置尺寸並重新顯示, 不再只靠矩形改變才觸發。
    #[cfg(all(windows, target_env = "msvc"))]
    pub fn request_reveal(&mut self) {
        self.reveal = true;
    }

    #[cfg(not(all(windows, target_env = "msvc")))]
    pub fn request_reveal(&mut self) {}

    pub fn new() -> Self {
        Self {
            #[cfg(all(windows, target_env = "msvc"))]
            inner: None,
            #[cfg(all(windows, target_env = "msvc"))]
            error: None,
            #[cfg(all(windows, target_env = "msvc"))]
            last_attempt: None,
            #[cfg(all(windows, target_env = "msvc"))]
            hwnd_missing: false,
            #[cfg(all(windows, target_env = "msvc"))]
            diag_logged_at: None,
            #[cfg(all(windows, target_env = "msvc"))]
            reveal: false,
        }
    }

    /// 診斷紀錄節流寫入: 同一類訊息 30 秒內只寫一次, 避免 sync 每幀刷 log。
    #[cfg(all(windows, target_env = "msvc"))]
    fn log_diag_throttled(&mut self, msg: &str) {
        let now = std::time::Instant::now();
        if self.diag_logged_at.map(|t| now.duration_since(t) < std::time::Duration::from_secs(30)).unwrap_or(false) {
            return;
        }
        self.diag_logged_at = Some(now);
        crate::shell::log_line(msg);
    }

    /// 給「聊天室畫面」頁顯示的嵌入狀態白話行: WebView 沒畫面時, 使用者看得到原因,
    /// 不再是無訊息的空白。want/want_reason 由呼叫端 (page_chat) 依當幀條件給出。
    #[cfg(all(windows, target_env = "msvc"))]
    pub fn status_line(&self, want: bool, want_reason: &str) -> String {
        if self.error.is_some() {
            return "嵌入狀態: 建立失敗, 原因見下方說明。".to_string();
        }
        if self.inner.is_some() {
            if want {
                // 旗標與實際狀態一致化: set_visible(true) 失敗時 visible 保持 false,
                // 狀態行就不能謊稱正在顯示, 要寫重試中。
                if self.inner.as_ref().map(|i| i.visible).unwrap_or(false) {
                    return "嵌入狀態: 已建立, 正在顯示核心聊天頁。".to_string();
                }
                return "嵌入狀態: 已建立, 但畫面還沒顯示出來, 正在重試。".to_string();
            }
            return format!("嵌入狀態: 已建立, 但目前被隱藏 ({want_reason})。");
        }
        if !want {
            return format!("嵌入狀態: 目前不顯示 ({want_reason})。");
        }
        if self.hwnd_missing {
            return "嵌入狀態: 還沒建立 (主視窗代碼尚未取得, 請稍候或按右上「重新載入聊天畫面」再試)。".to_string();
        }
        if self.last_attempt.is_some() {
            return "嵌入狀態: 正在建立中…".to_string();
        }
        "嵌入狀態: 還沒建立, 下一幀會嘗試建立。".to_string()
    }

    #[cfg(not(all(windows, target_env = "msvc")))]
    pub fn status_line(&self, _want: bool, _want_reason: &str) -> String {
        "嵌入狀態: 這個版本不支援內嵌聊天畫面 (Windows 版才有)。".to_string()
    }

    /// 建立失敗時的白話說明 (給登入頁嵌入區顯示); 沒有錯誤時為 None。
    #[cfg(all(windows, target_env = "msvc"))]
    pub fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    #[cfg(not(all(windows, target_env = "msvc")))]
    pub fn error(&self) -> Option<&str> {
        None
    }

    /// 立即隱藏 (不銷毀, 回到登入頁時可直接再顯示)。
    #[cfg(all(windows, target_env = "msvc"))]
    pub fn force_hide(&mut self) {
        let mut hide_err: Option<String> = None;
        if let Some(inner) = &mut self.inner {
            if inner.visible {
                // 旗標只在真的隱藏成功時才改: 失敗就保持 visible=true, 回到本頁時
                // sync 會再試 set_visible(true), 不會因為旗標說已隱藏而永遠不重試。
                match inner.webview.set_visible(false) {
                    Ok(()) => inner.visible = false,
                    Err(e) => hide_err = Some(format!("嵌入聊天畫面: 隱藏失敗 (下次回本頁會重試): {e}")),
                }
            }
        }
        if let Some(msg) = hide_err {
            self.log_diag_throttled(&msg);
        }
    }

    #[cfg(not(all(windows, target_env = "msvc")))]
    pub fn force_hide(&mut self) {}

    /// 每幀同步: want_visible 為真且主視窗代碼可用時, 懶建立 WebView 並對齊矩形
    /// (egui 邏輯座標 × pixels_per_point = 實體像素, 子視窗座標以父視窗客戶區為原點);
    /// 矩形或可見狀態沒變就不重複呼叫原生 API。建立失敗節流 15 秒最多試一次,
    /// 失敗原因記 log, 畫面只給白話說明 (不崩潰、不露原始錯誤)。
    /// 修復版6後續修復: 過去兩個不建立的分支 (want=false、主視窗代碼空) 全程靜默,
    /// 畫面只剩空白、診斷包也看不出原因; 現在兩個分支都寫節流診斷紀錄,
    /// 且 status_line() 會把原因顯示在頁面上。
    #[cfg(all(windows, target_env = "msvc"))]
    pub fn sync(&mut self, parent_hwnd: Option<isize>, rect: egui::Rect, pixels_per_point: f32, want_visible: bool, want_reason: &str, profile_dir: &Path) {
        if !want_visible {
            self.force_hide();
            self.log_diag_throttled(&format!("嵌入聊天畫面: 目前不顯示 (原因: {want_reason})"));
            return;
        }
        let Some(hwnd) = parent_hwnd else {
            self.hwnd_missing = true;
            self.log_diag_throttled("嵌入聊天畫面: 主視窗代碼尚未取得, 暫不建立");
            return;
        };
        self.hwnd_missing = false;
        let bounds = (
            (rect.min.x * pixels_per_point).round() as i32,
            (rect.min.y * pixels_per_point).round() as i32,
            ((rect.width() * pixels_per_point).round() as i32).max(1),
            ((rect.height() * pixels_per_point).round() as i32).max(1),
        );
        // 強制重排重顯 (進頁/重新載入時): 不論快取矩形與可見旗標,
        // 無條件重調位置尺寸並重新顯示——這就是縮小再打開時觸發的動作。
        // set_visible(true) 失敗時旗標保持 false, 下一幀會再重試, 不再謊稱已顯示。
        // (log 必須等 inner 借用結束後才能寫, 故先記在 show_err、離開 if-let 再寫。)
        let force = self.reveal;
        self.reveal = false;
        let mut show_err: Option<String> = None;
        let mut placed = false;
        if let Some(inner) = &mut self.inner {
            if force || inner.bounds != bounds {
                if inner.webview.set_bounds(imp::rect_of(bounds)).is_ok() {
                    inner.bounds = bounds;
                }
            }
            if force || !inner.visible {
                match inner.webview.set_visible(true) {
                    Ok(()) => inner.visible = true,
                    Err(e) => {
                        inner.visible = false;
                        show_err = Some(format!("嵌入聊天畫面: 重新顯示失敗, 下一幀會重試: {e}"));
                    }
                }
            }
            placed = true;
        }
        if let Some(msg) = show_err {
            self.log_diag_throttled(&msg);
        }
        if placed {
            return;
        }
        if self.last_attempt.map(|t| t.elapsed() < std::time::Duration::from_secs(15)).unwrap_or(false) {
            return;
        }
        self.last_attempt = Some(std::time::Instant::now());
        match imp::create(hwnd, &profile_dir.to_path_buf(), bounds) {
            Ok(inner) => {
                self.inner = Some(inner);
                self.error = None;
                crate::shell::log_line("嵌入聊天畫面: WebView 已建立並載入核心聊天頁");
            }
            Err(e) => {
                crate::shell::log_line(&format!("嵌入聊天畫面: WebView 建立失敗: {e}"));
                self.error = Some("聊天畫面打不開: 這台電腦的瀏覽器元件 (Microsoft Edge WebView2) 可能還沒裝好。請連上網路讓 Windows Update 裝好, 或安裝 WebView2 Runtime 後重新開啟 AI寶。".to_string());
            }
        }
    }

    #[cfg(not(all(windows, target_env = "msvc")))]
    pub fn sync(&mut self, parent_hwnd: Option<isize>, rect: egui::Rect, pixels_per_point: f32, want_visible: bool, want_reason: &str, profile_dir: &Path) {
        let _ = (parent_hwnd, rect, pixels_per_point, want_visible, want_reason, profile_dir);
    }
}

#[cfg(all(windows, target_env = "msvc"))]
mod imp {
    use raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
    use std::num::NonZeroIsize;
    use std::path::PathBuf;

    pub struct Inner {
        pub webview: wry::WebView,
        // WebContext 持有 WebView2 的資料目錄 (profile), 必須與 webview 一起保活
        pub context: wry::WebContext,
        pub visible: bool,
        pub bounds: (i32, i32, i32, i32),
    }

    struct Parent(RawWindowHandle);

    impl HasWindowHandle for Parent {
        fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
            // Safety: 代碼來自 eframe 主視窗, 在程式存活期間有效 (eframe 0.36 CreationContext 同做法)
            unsafe { Ok(WindowHandle::borrow_raw(self.0)) }
        }
    }

    pub fn rect_of(b: (i32, i32, i32, i32)) -> wry::Rect {
        wry::Rect {
            position: wry::dpi::Position::Physical(wry::dpi::PhysicalPosition::new(b.0, b.1)),
            size: wry::dpi::Size::Physical(wry::dpi::PhysicalSize::new(b.2 as u32, b.3 as u32)),
        }
    }

    pub fn create(hwnd: isize, profile_dir: &PathBuf, bounds: (i32, i32, i32, i32)) -> Result<Inner, String> {
        let parent = Parent(RawWindowHandle::Win32(Win32WindowHandle::new(
            NonZeroIsize::new(hwnd).ok_or_else(|| "主視窗代碼無效".to_string())?,
        )));
        // profile 放程式資料目錄 (不跟著 exe 亂跑): 全新 profile 沒有 cookie 也沒關係,
        // 核心根頁面會在同一個回應裡 Set-Cookie, 頁面自己就能連上 (見檔頭查證)。
        let mut context = wry::WebContext::new(Some(profile_dir.clone()));
        let webview = wry::WebViewBuilder::new_with_web_context(&mut context)
            .with_url(&super::chat_url())
            .with_bounds(rect_of(bounds))
            // 修復版6後續修復: 導覽處理器只記錄、不攔截。過去導覽失敗全程無聲,
            // 現在 shell.log 會留下 WebView 實際載入的網址, 診斷包可分辨
            // 「核心網頁沒載入」與「載入了但畫不出來」。
            .with_navigation_handler(|url| {
                crate::shell::log_line(&format!("嵌入聊天畫面: 正在載入 {url}"));
                true
            })
            .build_as_child(&parent)
            .map_err(|e| format!("{e}"))?;
        Ok(Inner { webview, context, visible: true, bounds })
    }
}
