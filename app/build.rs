// 建置腳本:
// 1. 引擎 payload: 把 pack 管線產出的引擎 exe (SEA) 複製到 OUT_DIR, 供 main 以 include_bytes 內嵌。
//    來源優先序: 環境變數 AIBAO_ENGINE_EXE > app/payload/engine.exe。
//    找不到時寫入空佔位並設 AIBAO_ENGINE_EMBEDDED=0 (僅供本機 cargo check 過關, CI 必須有真 payload)。
// 2. Windows: 以 winresource 寫入 icon 與版本資訊 (含版權宣告)。
use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());

    // --- 引擎 payload ---
    let candidates: Vec<PathBuf> = [
        env::var("AIBAO_ENGINE_EXE").ok().map(PathBuf::from),
        Some(manifest_dir.join("payload").join("engine.exe")),
    ]
    .into_iter()
    .flatten()
    .collect();
    let engine_dest = out_dir.join("engine.exe");
    let mut embedded = false;
    let mut engine_id = String::from("none");
    for cand in &candidates {
        if cand.is_file() {
            let bytes = fs::read(cand).expect("讀取引擎 payload 失敗");
            if !bytes.is_empty() {
                // 以內容長度 + 簡單滾動雜湊當版本識別 (解開目錄用它分版, 內容變了就換新目錄)
                let mut hash: u64 = 0xcbf29ce484222325;
                for b in &bytes {
                    hash ^= *b as u64;
                    hash = hash.wrapping_mul(0x100000001b3);
                }
                engine_id = format!("{:016x}-{}", hash, bytes.len());
                fs::write(&engine_dest, &bytes).expect("寫入 OUT_DIR 引擎 payload 失敗");
                embedded = true;
                println!("cargo:rerun-if-changed={}", cand.display());
                break;
            }
        }
    }
    if !embedded {
        fs::write(&engine_dest, b"").expect("寫入佔位 payload 失敗");
    }
    println!("cargo:rustc-env=AIBAO_ENGINE_EMBEDDED={}", if embedded { "1" } else { "0" });
    println!("cargo:rustc-env=AIBAO_ENGINE_ID={}", engine_id);
    println!("cargo:rerun-if-env-changed=AIBAO_ENGINE_EXE");

    // --- Windows icon 與版本資訊 ---
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon(&manifest_dir.join("assets").join("icon.ico").to_string_lossy());
        res.set("ProductName", "AI寶");
        res.set("FileDescription", "AI寶 — 華葳集成 LINE 學習小幫手");
        res.set("CompanyName", "華葳集成");
        res.set("LegalCopyright", "©Copyright 2026 By 吳治綱 繁體中文化");
        res.set("OriginalFilename", "AI寶.exe");
        if let Err(e) = res.compile() {
            // icon/版本資訊寫入失敗不應擋下整個建置, 但要在建置輸出留下紀錄
            println!("cargo:warning=winresource 寫入失敗: {e}");
        }
    }
}
