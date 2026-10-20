// runtime 模組測試: 跨行程解開競態修復的回歸測試。
// 重點情境: 監督者與 core/helper 子行程在真實啟動時會同時呼叫 ensureRuntime,
// 舊作法在 Windows 檔案鎖下互撞 (run 38921241900)。本測試以多個子行程並發
// 呼叫 ensureRuntime 指向同一資料目錄, 驗證全員成功且檔案完整。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dataPaths } from "../launcher/paths.mjs";
import { retryOnBusy, withRuntimeLock } from "../launcher/runtime.mjs";
import { STUB_FILES, STUB_VERSION, expectedContent } from "./fixtures/stub-sea.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = join(here, "fixtures", "ensure-worker.mjs");

function runWorker(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, dataDir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("runtime: 三個行程並發 ensureRuntime 同一資料目錄, 全員成功且檔案完整", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "aibao-runtime-race-"));
  const results = await Promise.all([runWorker(dataDir), runWorker(dataDir), runWorker(dataDir)]);
  for (const r of results) {
    assert.equal(r.code, 0, `worker 失敗: code=${r.code}, stderr=${r.stderr}`);
    assert.match(r.stdout, /WORKER-OK/);
  }
  const paths = dataPaths(dataDir);
  const versionDir = join(paths.runtimeDir, STUB_VERSION);
  // 解開完成標記存在, 且每個檔案內容與來源逐字相同
  assert.equal(existsSync(join(versionDir, ".extracted-ok")), true);
  for (const key of STUB_FILES) {
    assert.equal(readFileSync(join(versionDir, ...key.split("/")), "utf8"), expectedContent(key), `解開檔案不完整: ${key}`);
  }
  // runtime 目錄只留版本目錄, 無暫存目錄殘留; 鎖已釋放
  assert.deepEqual(readdirSync(paths.runtimeDir), [STUB_VERSION]);
  assert.equal(existsSync(join(dataDir, ".runtime-lock")), false);
  // 網頁鏡像完整, 且鏡像標記記錄正確版本
  assert.equal(readFileSync(join(paths.distWebDir, "index.html"), "utf8"), expectedContent("core/dist/web/index.html"));
  assert.equal(readFileSync(join(paths.distWebDir, "assets", "app.js"), "utf8"), expectedContent("core/dist/web/assets/app.js"));
  assert.equal(readFileSync(join(dataDir, "dist", ".mirror-ok"), "utf8").trim(), STUB_VERSION);
  // dist 目錄無暫存/舊目錄殘留
  assert.deepEqual(readdirSync(join(dataDir, "dist")).sort(), [".mirror-ok", "web"]);
  // 設定範本已備妥到資料目錄根
  assert.equal(readFileSync(join(dataDir, "config.example.yaml"), "utf8"), expectedContent("core/config.example.yaml"));
});

test("runtime: 資料目錄已有舊版凍結 runtime 時, 新版必須解開新目錄並清掉舊目錄 (2026-10-20 實機凍結事故回歸)", async () => {
  // 事故形狀: 舊版啟動器以 package 版本字串 (1.8.0+0.1.0) 為 runtime 目錄鍵, 解開一次後
  // 之後所有新版 exe 都沿用那份舊快照 — 使用者機器上的 helper 凍結在沒有新功能的舊碼,
  // 修復全數「CI 綠、實機紅」。修法: 目錄鍵改為內容雜湊 (build.mjs), 每份不同內容各自
  // 一個目錄; 本測試預置事故形狀的舊目錄 (含完成標記與毒化內容), 驗證新版 ensureRuntime
  // 不重用它、解開自己的目錄、且把舊目錄清掉。
  const { ensureRuntime, runtimeVersionDir } = await import("../launcher/runtime.mjs");
  const { makeStubSea } = await import("./fixtures/stub-sea.mjs");
  const { writeFileSync } = await import("node:fs");
  const dataDir = mkdtempSync(join(tmpdir(), "aibao-runtime-stale-"));
  const paths = dataPaths(dataDir);
  const staleDir = join(paths.runtimeDir, "1.8.0+0.1.0");
  mkdirSync(join(staleDir, "helper", "src"), { recursive: true });
  writeFileSync(join(staleDir, ".extracted-ok"), "files=1\n");
  writeFileSync(join(staleDir, "helper", "src", "main.mjs"), "STALE-OLD-CODE");
  const versionDir = await ensureRuntime(makeStubSea(), paths, () => {});
  assert.equal(versionDir, runtimeVersionDir(paths, STUB_VERSION), "應解開目前版本的目錄, 不是舊目錄");
  assert.equal(readFileSync(join(versionDir, "helper", "src", "main.mjs"), "utf8"), expectedContent("helper/src/main.mjs"));
  assert.equal(existsSync(staleDir), false, "舊版凍結目錄應被 cleanup 清除");
});

test("runtime: 再次呼叫 ensureRuntime 走標記快路徑, 結果不變", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "aibao-runtime-again-"));
  const first = await runWorker(dataDir);
  assert.equal(first.code, 0, first.stderr);
  const second = await runWorker(dataDir);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /WORKER-OK/);
});

test("retryOnBusy: 忙碌錯誤退避重試後成功", async () => {
  let attempts = 0;
  const value = await retryOnBusy(() => {
    attempts += 1;
    if (attempts < 3) {
      const e = new Error("resource busy");
      e.code = "EBUSY";
      throw e;
    }
    return "done";
  }, { tries: 5, baseMs: 1, sleep: () => Promise.resolve() });
  assert.equal(value, "done");
  assert.equal(attempts, 3);
});

test("retryOnBusy: 忙碌錯誤超過上限拋出; 非忙碌錯誤不重試", async () => {
  let busyAttempts = 0;
  await assert.rejects(
    retryOnBusy(() => {
      busyAttempts += 1;
      const e = new Error("still busy");
      e.code = "EPERM";
      throw e;
    }, { tries: 3, baseMs: 1, sleep: () => Promise.resolve() }),
    /still busy/,
  );
  assert.equal(busyAttempts, 3);

  let otherAttempts = 0;
  await assert.rejects(
    retryOnBusy(() => {
      otherAttempts += 1;
      const e = new Error("not found");
      e.code = "ENOENT";
      throw e;
    }, { tries: 5, baseMs: 1, sleep: () => Promise.resolve() }),
    /not found/,
  );
  assert.equal(otherAttempts, 1);
});

test("withRuntimeLock: 他人持鎖時逾時拋錯; 殘留舊鎖可被打破取得", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "aibao-runtime-lock-"));
  const paths = dataPaths(dataDir);
  const lockDir = join(dataDir, ".runtime-lock");
  mkdirSync(lockDir, { recursive: true });
  await assert.rejects(
    withRuntimeLock(paths, () => "never", { timeoutMs: 300, staleMs: 60000, pollMs: 20 }),
    /逾時/,
  );
  // 把鎖目錄 mtime 改到過去, 模擬持鎖行程已死亡的殘留鎖
  const past = new Date(Date.now() - 120000);
  utimesSync(lockDir, past, past);
  const value = await withRuntimeLock(paths, () => 42, { timeoutMs: 2000, staleMs: 1000, pollMs: 20 });
  assert.equal(value, 42);
  assert.equal(existsSync(lockDir), false);
});
