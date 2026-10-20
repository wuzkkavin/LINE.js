//! 「聊天室畫面」頁嵌入的核心聊天畫面 (http://127.0.0.1:3789)。
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
pub const CHAT_URL: &str = "http://127.0.0.1:3789/";

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
}

impl ChatViewHost {
    pub fn new() -> Self {
        Self {
            #[cfg(all(windows, target_env = "msvc"))]
            inner: None,
            #[cfg(all(windows, target_env = "msvc"))]
            error: None,
            #[cfg(all(windows, target_env = "msvc"))]
            last_attempt: None,
        }
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
        if let Some(inner) = &mut self.inner {
            if inner.visible {
                let _ = inner.webview.set_visible(false);
                inner.visible = false;
            }
        }
    }

    #[cfg(not(all(windows, target_env = "msvc")))]
    pub fn force_hide(&mut self) {}

    /// 每幀同步: want_visible 為真且主視窗代碼可用時, 懶建立 WebView 並對齊矩形
    /// (egui 邏輯座標 × pixels_per_point = 實體像素, 子視窗座標以父視窗客戶區為原點);
    /// 矩形或可見狀態沒變就不重複呼叫原生 API。建立失敗節流 15 秒最多試一次,
    /// 失敗原因記 log, 畫面只給白話說明 (不崩潰、不露原始錯誤)。
    #[cfg(all(windows, target_env = "msvc"))]
    pub fn sync(&mut self, parent_hwnd: Option<isize>, rect: egui::Rect, pixels_per_point: f32, want_visible: bool, profile_dir: &Path) {
        if !want_visible {
            self.force_hide();
            return;
        }
        let Some(hwnd) = parent_hwnd else {
            return;
        };
        let bounds = (
            (rect.min.x * pixels_per_point).round() as i32,
            (rect.min.y * pixels_per_point).round() as i32,
            ((rect.width() * pixels_per_point).round() as i32).max(1),
            ((rect.height() * pixels_per_point).round() as i32).max(1),
        );
        if let Some(inner) = &mut self.inner {
            if inner.bounds != bounds {
                if inner.webview.set_bounds(imp::rect_of(bounds)).is_ok() {
                    inner.bounds = bounds;
                }
            }
            if !inner.visible {
                let _ = inner.webview.set_visible(true);
                inner.visible = true;
            }
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
    pub fn sync(&mut self, parent_hwnd: Option<isize>, rect: egui::Rect, pixels_per_point: f32, want_visible: bool, profile_dir: &Path) {
        let _ = (parent_hwnd, rect, pixels_per_point, want_visible, profile_dir);
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
            .with_url(super::CHAT_URL)
            .with_bounds(rect_of(bounds))
            .build_as_child(&parent)
            .map_err(|e| format!("{e}"))?;
        Ok(Inner { webview, context, visible: true, bounds })
    }
}
