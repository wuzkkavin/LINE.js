// Windows 平台層: Job Object 行程管理、CTRL_BREAK 優雅關閉、具名互斥鎖/事件 (單一實例)、
// HKCU Run 自啟動。非 Windows 只提供可編譯的樁 (開發機 cargo check 用), 不宣稱行為等價。
#[cfg(windows)]
pub use win_impl::*;

#[cfg(windows)]
mod win_impl {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::{Path, PathBuf};
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows::Win32::System::Threading::{
        CreateEventW, CreateMutexW, CreateProcessW, GetExitCodeProcess, OpenEventW, ResumeThread,
        SetEvent, WaitForSingleObject, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
        CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, EVENT_MODIFY_STATE, PROCESS_INFORMATION,
        STARTUPINFOW,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn wide_path(p: &Path) -> Vec<u16> {
        p.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
    }

    /// Job Object: 設 KILL_ON_JOB_CLOSE — 殼結束 (或崩潰) 時系統連帶清除整棵引擎行程樹,
    /// 補上 pack README 已知限制「強制結束會殘留子行程」的缺口 (規格書 v3 第 7 節)。
    pub struct JobHandle(pub HANDLE);
    // HANDLE 是原始指標包裝; 本程式只在主執行緒/引擎管理執行緒使用, 以 unsafe 宣告跨執行緒持有是安全的
    // (實際的 API 呼叫都在 engine 管理執行緒序列化進行)。
    unsafe impl Send for JobHandle {}

    impl JobHandle {
        pub fn new_kill_on_close() -> std::io::Result<Self> {
            unsafe {
                let job = CreateJobObjectW(None, PCWSTR::null())
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
                Ok(Self(job))
            }
        }
        pub fn terminate(&self) {
            unsafe {
                let _ = TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for JobHandle {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    /// 以 CREATE_SUSPENDED 啟動引擎監督者: 先納入 Job Object 再 Resume, 消除
    /// 「監督者在被納管前就生出子行程」的競態 (子行程會自動繼承 Job 歸屬)。
    pub struct SpawnedEngine {
        pub pid: u32,
        process: HANDLE,
        thread: HANDLE,
    }
    unsafe impl Send for SpawnedEngine {}

    impl SpawnedEngine {
        pub fn exited(&self) -> bool {
            unsafe {
                let mut code: u32 = 0;
                if GetExitCodeProcess(self.process, &mut code).is_ok() {
                    code != 259 // STILL_ACTIVE
                } else {
                    true
                }
            }
        }
    }

    impl Drop for SpawnedEngine {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.thread);
                let _ = CloseHandle(self.process);
            }
        }
    }

    pub fn spawn_engine_suspended(
        exe: &Path,
        extra_env: &[(&str, &str)],
    ) -> std::io::Result<SpawnedEngine> {
        // 環境區塊: 繼承目前環境 + 覆寫 extra_env, UTF-16 雙空字元結尾 (CREATE_UNICODE_ENVIRONMENT)
        let mut env_map: Vec<(OsString, OsString)> = std::env::vars_os().collect();
        for (k, v) in extra_env {
            env_map.retain(|(ek, _)| !ek.eq_ignore_ascii_case(k));
            env_map.push((OsString::from(k), OsString::from(v)));
        }
        let mut env_block: Vec<u16> = Vec::new();
        for (k, v) in &env_map {
            env_block.extend(k.encode_wide());
            env_block.push(b'=' as u16);
            env_block.extend(v.encode_wide());
            env_block.push(0);
        }
        env_block.push(0);

        let app = wide_path(exe);
        let cmdline_str = format!("\"{}\"", exe.to_string_lossy());
        let mut cmdline = wide(&cmdline_str);
        let cwd = wide_path(&exe.parent().unwrap_or(Path::new(".")));
        let si = STARTUPINFOW { cb: std::mem::size_of::<STARTUPINFOW>() as u32, ..Default::default() };
        let mut pi = PROCESS_INFORMATION::default();
        let flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
        unsafe {
            CreateProcessW(
                PCWSTR(app.as_ptr()),
                PWSTR(cmdline.as_mut_ptr()),
                None,
                None,
                false,
                flags,
                Some(env_block.as_ptr() as *const core::ffi::c_void),
                PCWSTR(cwd.as_ptr()),
                &si,
                &mut pi,
            )
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
        }
        Ok(SpawnedEngine { pid: pi.dwProcessId, process: pi.hProcess, thread: pi.hThread })
    }

    pub fn assign_and_resume(job: &JobHandle, engine: &SpawnedEngine) -> std::io::Result<()> {
        unsafe {
            AssignProcessToJobObject(job.0, engine.process)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            if ResumeThread(engine.thread) == u32::MAX {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(())
    }

    // ---- 單一實例: 具名互斥鎖 + 具名事件通知既有實例 ----

    pub struct Singleton {
        _mutex: HANDLE,
    }
    unsafe impl Send for Singleton {}

    impl Drop for Singleton {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self._mutex);
            }
        }
    }

    /// 搶互斥鎖; 已有實例在跑時回傳 None。
    pub fn acquire_singleton(name: &str) -> Option<Singleton> {
        unsafe {
            let m = CreateMutexW(None, false, PCWSTR(wide(name).as_ptr())).ok()?;
            // ERROR_ALREADY_EXISTS = 183
            if windows::Win32::Foundation::GetLastError().0 == 183 {
                let _ = CloseHandle(m);
                return None;
            }
            Some(Singleton { _mutex: m })
        }
    }

    /// 通知既有實例 (第二實例呼叫): 開啟具名事件並 SetEvent; 事件不存在 (第一實例還沒建) 時靜默。
    pub fn signal_named_event(name: &str) {
        unsafe {
            if let Ok(ev) = OpenEventW(EVENT_MODIFY_STATE, false, PCWSTR(wide(name).as_ptr())) {
                let _ = SetEvent(ev);
                let _ = CloseHandle(ev);
            }
        }
    }

    /// 建立具名事件並在背景執行緒等待; 每被觸發一次就呼叫 callback (自動重設事件)。
    pub fn spawn_event_waiter<F>(name: &str, callback: F)
    where
        F: Fn() + Send + 'static,
    {
        let name = name.to_string();
        std::thread::spawn(move || unsafe {
            let ev = match CreateEventW(None, false, false, PCWSTR(wide(&name).as_ptr())) {
                Ok(e) => e,
                Err(_) => return,
            };
            loop {
                if WaitForSingleObject(ev, u32::MAX) == WAIT_OBJECT_0 {
                    callback();
                } else {
                    break;
                }
            }
        });
    }

    // ---- HKCU Run 自啟動 (規格書 v3 第 8 節定案) ----

    pub const AUTOSTART_VALUE_NAME: &str = "HwLineHelper-AiBao";
    const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    pub fn autostart_get() -> Option<String> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu.open_subkey(RUN_KEY).ok()?;
        key.get_value::<String, _>(AUTOSTART_VALUE_NAME).ok()
    }

    pub fn autostart_set(exe: &Path) -> std::io::Result<()> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey(RUN_KEY)?;
        // --autostart: 開機啟動時縮系統匣不彈窗, 並讓引擎自動拉起恢復登入
        key.set_value(AUTOSTART_VALUE_NAME, &format!("\"{}\" --autostart", exe.to_string_lossy()))?;
        Ok(())
    }

    pub fn autostart_remove() -> std::io::Result<()> {
        use winreg::enums::HKEY_CURRENT_USER;
        use winreg::RegKey;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = hkcu.open_subkey_with_flags(RUN_KEY, winreg::enums::KEY_WRITE)?;
        match key.delete_value(AUTOSTART_VALUE_NAME) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// 登錄值裡的 exe 路徑部分 (去掉引號與 --autostart)
    pub fn autostart_exe_of(value: &str) -> PathBuf {
        let v = value.trim();
        if let Some(stripped) = v.strip_prefix('"') {
            if let Some(end) = stripped.find('"') {
                return PathBuf::from(&stripped[..end]);
            }
        }
        PathBuf::from(v.split_whitespace().next().unwrap_or(""))
    }

    // ---- 結束序列加嚴: 殘留行程定位與強制結束 ----
    // 背景 (2026-10-20 老吳實機定案): 舊世代引擎 (不支援 stop-request 訊號檔) 殘留時,
    // 殼的優雅結束送不到, 舊版 stop() 又謊報成功。要真的清乾淨, 必須能 (1) 依埠找出正在 listen 的行程,
    // (2) 查任意行程的映像檔路徑 (分辨是不是 AI寶 的引擎), (3) 強制結束單一行程,
    // (4) 掃出資料目錄 engine/ 底下所有世代引擎的行程 (監督者本人在埠釋放後也可能還在)。
    use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows::Win32::Networking::WinSock::AF_INET6;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, TerminateProcess, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };

    fn port_be_u32(port: u16) -> u32 {
        // MIB_TCPROW 的 dwLocalPort: 連接埠以網路位元組序存放在低 2 bytes, 高 2 bytes 為 0。
        // 例: 3789 = 0x0ECD → dwLocalPort = 0x0000_CD0E。
        (((port & 0x00ff) << 8) | (port >> 8)) as u32
    }

    /// 找出正在 listen 指定埠的所有行程 PID (IPv4 + IPv6)。
    /// 用 GetExtendedTcpTable 的 OWNER_PID_LISTENER 表; 查不到或失敗回空清單 (呼叫端以 HTTP 探測為準, 這裡只是定位用)。
    pub fn listening_pids(port: u16) -> Vec<u32> {
        let mut pids: Vec<u32> = Vec::new();
        let want = port_be_u32(port);
        unsafe {
            // IPv4
            let mut size: u32 = 0;
            let r = GetExtendedTcpTable(
                None,
                &mut size,
                false,
                2, // AF_INET
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            );
            if r == ERROR_INSUFFICIENT_BUFFER.0 && size > 0 {
                let mut buf = vec![0u8; size as usize];
                let r2 = GetExtendedTcpTable(
                    Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut size,
                    false,
                    2,
                    TCP_TABLE_OWNER_PID_LISTENER,
                    0,
                );
                if r2 == NO_ERROR.0 {
                    let count = *(buf.as_ptr() as *const u32) as usize;
                    let rows = buf.as_ptr().add(4) as *const MIB_TCPROW_OWNER_PID;
                    for i in 0..count {
                        let row = &*rows.add(i);
                        if (row.dwLocalPort & 0xffff) == want && row.dwOwningPid != 0 {
                            pids.push(row.dwOwningPid);
                        }
                    }
                }
            }
            // IPv6
            let mut size6: u32 = 0;
            let r = GetExtendedTcpTable(
                None,
                &mut size6,
                false,
                AF_INET6.0 as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            );
            if r == ERROR_INSUFFICIENT_BUFFER.0 && size6 > 0 {
                let mut buf = vec![0u8; size6 as usize];
                let r2 = GetExtendedTcpTable(
                    Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                    &mut size6,
                    false,
                    AF_INET6.0 as u32,
                    TCP_TABLE_OWNER_PID_LISTENER,
                    0,
                );
                if r2 == NO_ERROR.0 {
                    let count = *(buf.as_ptr() as *const u32) as usize;
                    let rows = buf.as_ptr().add(4) as *const MIB_TCP6ROW_OWNER_PID;
                    for i in 0..count {
                        let row = &*rows.add(i);
                        if (row.dwLocalPort & 0xffff) == want && row.dwOwningPid != 0 {
                            pids.push(row.dwOwningPid);
                        }
                    }
                }
            }
        }
        pids.sort_unstable();
        pids.dedup();
        pids
    }

    /// 查行程的映像檔完整路徑; 行程已結束或無權限回 None。
    pub fn process_image_path(pid: u32) -> Option<PathBuf> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(
                h,
                PROCESS_NAME_FORMAT(0),
                PWSTR(buf.as_mut_ptr()),
                &mut len,
            );
            let _ = CloseHandle(h);
            if ok.is_err() || len == 0 {
                return None;
            }
            Some(PathBuf::from(OsString::from_wide(&buf[..len as usize])))
        }
    }

    /// 強制結束單一行程 (TerminateProcess)。回傳是否成功送出結束。
    pub fn terminate_pid(pid: u32) -> bool {
        if pid == 0 || pid == std::process::id() {
            return false;
        }
        unsafe {
            match OpenProcess(PROCESS_TERMINATE, false, pid) {
                Ok(h) => {
                    let ok = TerminateProcess(h, 1).is_ok();
                    let _ = CloseHandle(h);
                    ok
                }
                Err(_) => false,
            }
        }
    }

    /// 掃全部行程, 回傳映像檔路徑與清單中任一項完全相同 (不分大小寫) 的行程 PID。
    /// 用來確認某個 exe (例如舊世代引擎的監督者與其子行程共用同一個 exe 檔) 是否還有行程活著。
    pub fn pids_with_image_in(paths: &[std::path::PathBuf]) -> Vec<u32> {
        let mut out = Vec::new();
        if paths.is_empty() {
            return out;
        }
        let wanted: Vec<String> = paths.iter().map(|p| p.to_string_lossy().to_lowercase()).collect();
        unsafe {
            let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                Ok(s) => s,
                Err(_) => return out,
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut candidates: Vec<u32> = Vec::new();
            if Process32FirstW(snap, &mut entry).is_ok() {
                loop {
                    if entry.th32ProcessID != 0 && entry.th32ProcessID != std::process::id() {
                        candidates.push(entry.th32ProcessID);
                    }
                    if Process32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
            for pid in candidates {
                if let Some(p) = process_image_path(pid) {
                    if wanted.contains(&p.to_string_lossy().to_lowercase()) {
                        out.push(pid);
                    }
                }
            }
        }
        out
    }

    /// 掃全部行程, 回傳映像檔路徑位於 dir 底下 (含子目錄) 的行程 PID。
    /// 用來找資料目錄 engine/<世代>/ 裡各世代引擎 (監督者與其子行程) 的殘留。
    pub fn pids_with_image_under(dir: &Path) -> Vec<u32> {
        let mut out = Vec::new();
        let dir_norm = dir.to_string_lossy().to_lowercase();
        unsafe {
            let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
                Ok(s) => s,
                Err(_) => return out,
            };
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut candidates: Vec<u32> = Vec::new();
            if Process32FirstW(snap, &mut entry).is_ok() {
                loop {
                    if entry.th32ProcessID != 0 && entry.th32ProcessID != std::process::id() {
                        candidates.push(entry.th32ProcessID);
                    }
                    if Process32NextW(snap, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
            for pid in candidates {
                if let Some(p) = process_image_path(pid) {
                    let s = p.to_string_lossy().to_lowercase();
                    if s == dir_norm || s.starts_with(&format!("{dir_norm}\\")) {
                        out.push(pid);
                    }
                }
            }
        }
        out
    }

    /// 框選截圖 (發送群組訊息頁的「截圖」鈕): 等使用者用滑鼠在畫面上拖出一個範圍,
    /// 用 GDI 把那塊畫面抓下來存成 PNG (暫存檔), 回傳路徑。按 Esc 或範圍太小 = 取消。
    /// 前提是呼叫端已把主視窗縮小, 不然會截到程式自己 — 流程由 UI 端負責安排。
    /// 阻塞式 (輪詢滑鼠狀態), 呼叫端要在背景執行緒呼叫。
    pub fn capture_screen_region() -> Result<PathBuf, String> {
        use windows::Win32::Foundation::POINT;
        use windows::Win32::Graphics::Gdi::{
            BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
            ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ, SRCCOPY,
        };
        use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON};
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;

        fn key_down(vk: i32) -> bool {
            unsafe { (GetAsyncKeyState(vk) as u16 & 0x8000) != 0 }
        }
        fn cursor() -> (i32, i32) {
            let mut p = POINT::default();
            unsafe {
                let _ = GetCursorPos(&mut p);
            }
            (p.x, p.y)
        }
        // 先等滑鼠放開 (避免按鈕本身的點擊被當成起點), 再等按下 = 起點, 放開 = 終點
        while key_down(VK_LBUTTON.0 as i32) {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let (x0, y0) = loop {
            if key_down(VK_ESCAPE.0 as i32) {
                return Err("已取消截圖".into());
            }
            if key_down(VK_LBUTTON.0 as i32) {
                break cursor();
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        let (x1, y1) = loop {
            if !key_down(VK_LBUTTON.0 as i32) {
                break cursor();
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        let (left, top) = (x0.min(x1), y0.min(y1));
        let (w, h) = ((x0 - x1).abs(), (y0 - y1).abs());
        if w < 8 || h < 8 {
            return Err("選取的範圍太小, 已取消截圖 (請拖出一個明顯的範圍)".into());
        }
        unsafe {
            let screen = GetDC(None);
            if screen.is_invalid() {
                return Err("抓不到螢幕畫面".into());
            }
            let mem = CreateCompatibleDC(screen);
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, HGDIOBJ(bmp.0));
            let blit = BitBlt(mem, 0, 0, w, h, screen, left, top, SRCCOPY);
            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // 負值 = 由上往下, 省掉上下翻轉
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bgra = vec![0u8; (w * h * 4) as usize];
            let got = GetDIBits(mem, bmp, 0, h as u32, Some(bgra.as_mut_ptr() as *mut core::ffi::c_void), &mut info, DIB_RGB_COLORS);
            let _ = SelectObject(mem, old);
            let _ = DeleteObject(HGDIOBJ(bmp.0));
            let _ = DeleteDC(mem);
            let _ = ReleaseDC(None, screen);
            if blit.is_err() || got == 0 {
                return Err("抓取畫面失敗".into());
            }
            // BGRA -> RGBA
            for px in bgra.chunks_exact_mut(4) {
                px.swap(0, 2);
            }
            let img = image::RgbaImage::from_raw(w as u32, h as u32, bgra).ok_or("截圖尺寸不正確")?;
            let path = std::env::temp_dir().join(format!("aibao-shot-{}.png", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
            img.save(&path).map_err(|e| format!("截圖存檔失敗: {e}"))?;
            Ok(path)
        }
    }
}

#[cfg(not(windows))]
pub fn capture_screen_region() -> Result<std::path::PathBuf, String> {
    Err("「截圖」功能在 Windows 版提供".into())
}
