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
    use windows::Win32::System::Console::{GenerateConsoleCtrlEvent, CTRL_BREAK_EVENT};
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

    /// 對監督者行程群組送 CTRL_BREAK: 監督者 (entry.mjs) 有處理 SIGBREAK 優雅關閉
    /// (結束子行程並把 session 以 DPAPI 加密封存)。送達性依規格書 v3 風險 2, 由探針在雲端 Windows 實測。
    pub fn send_ctrl_break(pid: u32) -> bool {
        unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid).is_ok() }
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
}
