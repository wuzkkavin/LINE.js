// 執行期資產解開的跨行程協調 (監督者 / core / helper / cli 共用)。
//
// 競態背景: 四種角色都會呼叫 ensureRuntime()。舊作法各行程同時對同一資料目錄
// 解開檔案並以 cpSync 鏡像核心網頁, Linux 上多半沒事, 但 Windows 的檔案鎖
// 語義下會互撞 (EPIPE / EBUSY: The process cannot access the file because it
// is being used by another process), 造成 core 子行程啟動即以 code=1 結束
// (GitHub 雲端驗證 run 38921241900 的實際故障)。
//
// 修法:
// 1. mkdir 原子鎖 (<dataDir>/.runtime-lock): 只有持鎖者能動檔案, 其他行程
//    輪詢等待; 鎖逾時未釋放且夠舊時視為殘留鎖可打破, 避免當掉的行程鎖死全家。
// 2. 解開採暫存目錄 + 原子換名: 先全部寫到 runtime/.tmp-<版本>-<pid>-<隨機>,
//    寫入完成標記 .extracted-ok 後才 rename 成 runtime/<版本>; 其他行程只會
//    看到「不存在」或「完整存在」, 不會讀到半成品。
// 3. 網頁鏡像 (dist/web) 以 .mirror-ok 標記記錄已鏡像的版本, 持鎖者檢查後
//    決定跳過或重做; 換名失敗時退回就地複製。
// 4. 所有檔案操作包一層忙碌重試: Windows 的 EBUSY / EPERM / EPIPE / EACCES
//    多為短暫占用, 有限次指數退避後多可成功。
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// Windows 上代表「檔案被其他行程占用」的錯誤碼集合, 這些錯誤值得退避重試。
export const BUSY_ERROR_CODES = new Set(["EBUSY", "EPERM", "EPIPE", "EACCES"]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 對同步檔案操作做有限次退避重試; 非忙碌錯誤立即拋出不重試。
// sleep 可注入 (測試用), 預設為 setTimeout。
export async function retryOnBusy(fn, { tries = 8, baseMs = 90, sleep = defaultSleep, onRetry } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      if (!BUSY_ERROR_CODES.has(e?.code) || attempt === tries) throw e;
      if (onRetry) onRetry(e, attempt);
      await sleep(baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 40));
    }
  }
  throw lastError;
}

// 以 mkdir 的原子性取得執行期鎖; 回傳釋放函式。拿不到鎖時輪詢等待,
// 超過 timeoutMs 拋錯; 鎖目錄 mtime 超過 staleMs 未更新視為殘留鎖, 打破重取。
export async function acquireRuntimeLock(paths, {
  timeoutMs = 120000, staleMs = 60000, pollMs = 120, sleep = defaultSleep,
} = {}) {
  const lockDir = join(paths.root, ".runtime-lock");
  mkdirSync(paths.root, { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      mkdirSync(lockDir);
      return () => { try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* 已釋放 */ } };
    } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      let stale = false;
      try { stale = Date.now() - statSync(lockDir).mtimeMs > staleMs; } catch { stale = true; }
      if (stale) {
        try { rmSync(lockDir, { recursive: true, force: true }); } catch { /* 競爭打破, 下一輪再試 */ }
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`等待執行期資產鎖逾時 (${timeoutMs}ms), 鎖目錄: ${lockDir}`);
      }
      await sleep(pollMs);
    }
  }
}

// 在執行期鎖內執行 fn, 結束 (含拋錯) 必釋放鎖。
export async function withRuntimeLock(paths, fn, lockOptions) {
  const release = await acquireRuntimeLock(paths, lockOptions);
  try {
    return await fn();
  } finally {
    release();
  }
}

function readManifest(sea) {
  return JSON.parse(Buffer.from(sea.getAsset("manifest.json")).toString("utf8"));
}

export function runtimeVersionDir(paths, version) {
  return join(paths.runtimeDir, version);
}

// 持鎖狀態下呼叫: 把 SEA 資產解開到 runtime/<版本>。
// 已有完成標記直接回傳; 否則解到暫存目錄、寫好標記再原子換名。
async function extractVersionDir(sea, paths, manifest, log) {
  const versionDir = runtimeVersionDir(paths, manifest.version);
  const marker = join(versionDir, ".extracted-ok");
  if (existsSync(marker)) return versionDir;
  mkdirSync(paths.runtimeDir, { recursive: true });
  const tmpDir = join(
    paths.runtimeDir,
    `.tmp-${manifest.version}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await retryOnBusy(() => rmSync(tmpDir, { recursive: true, force: true }));
  mkdirSync(tmpDir, { recursive: true });
  log(`解開內嵌檔案到 ${versionDir} (共 ${manifest.files.length} 個)`);
  for (const key of manifest.files) {
    const dest = join(tmpDir, ...key.split("/"));
    mkdirSync(dirname(dest), { recursive: true });
    const data = Buffer.from(sea.getAsset(key));
    await retryOnBusy(() => writeFileSync(dest, data));
  }
  // 標記先寫進暫存目錄, 換名後與內容同時出現, 保證看到標記就是完整版。
  writeFileSync(join(tmpDir, ".extracted-ok"), `files=${manifest.files.length}\n`);
  if (!existsSync(versionDir)) {
    await retryOnBusy(() => renameSync(tmpDir, versionDir));
  } else if (!existsSync(marker)) {
    // 目標已存在但沒有標記: 是舊版啟動器或中斷遺留的半成品, 持鎖下可安全換掉。
    await retryOnBusy(() => rmSync(versionDir, { recursive: true, force: true }));
    await retryOnBusy(() => renameSync(tmpDir, versionDir));
  } else {
    await retryOnBusy(() => rmSync(tmpDir, { recursive: true, force: true }));
  }
  return versionDir;
}

// 持鎖狀態下呼叫: 把核心網頁鏡像到 <dataDir>/dist/web (核心以 CWD 的 dist/web 供網頁)。
// tag 為版本字串時以 <dataDir>/dist/.mirror-ok 記錄, 相同版本跳過;
// tag 為 null (開發模式) 時一律重做以反映 Repo 最新檔案。
// 鏡像採暫存目錄 + 換名; 換名整段失敗 (例如有行程正開啟 dist/web) 時退回就地複製。
async function mirrorWebDir(paths, webSrc, tag, log) {
  if (!existsSync(webSrc)) return;
  const distDir = dirname(paths.distWebDir);
  const mirrorMarker = join(distDir, ".mirror-ok");
  if (tag !== null && existsSync(mirrorMarker)) {
    try {
      if (readFileSync(mirrorMarker, "utf8").trim() === tag) return;
    } catch { /* 標記讀不到就重做鏡像 */ }
  }
  mkdirSync(distDir, { recursive: true });
  const tmpDir = join(distDir, `.web-tmp-${process.pid}`);
  const oldDir = join(distDir, `.web-old-${process.pid}`);
  await retryOnBusy(() => rmSync(tmpDir, { recursive: true, force: true }));
  await retryOnBusy(() => rmSync(oldDir, { recursive: true, force: true }));
  await retryOnBusy(() => cpSync(webSrc, tmpDir, { recursive: true, force: true }));
  let swapped = false;
  try {
    if (existsSync(paths.distWebDir)) await retryOnBusy(() => renameSync(paths.distWebDir, oldDir));
    await retryOnBusy(() => renameSync(tmpDir, paths.distWebDir));
    swapped = true;
  } catch (e) {
    log(`網頁鏡像換名失敗 (${e?.code || e?.message || e}), 改用就地複製`);
    // 換回可能已被改名的舊目錄, 再就地複製暫存內容覆蓋。
    if (!existsSync(paths.distWebDir) && existsSync(oldDir)) {
      await retryOnBusy(() => renameSync(oldDir, paths.distWebDir)).catch(() => { /* 下方複製會重建 */ });
    }
    mkdirSync(paths.distWebDir, { recursive: true });
    await retryOnBusy(() => cpSync(tmpDir, paths.distWebDir, { recursive: true, force: true }));
    await retryOnBusy(() => rmSync(tmpDir, { recursive: true, force: true }));
    await retryOnBusy(() => rmSync(oldDir, { recursive: true, force: true })).catch(() => { /* 殘留舊目錄下次啟動再清 */ });
  }
  if (swapped) await retryOnBusy(() => rmSync(oldDir, { recursive: true, force: true })).catch(() => { /* 殘留舊目錄下次啟動再清 */ });
  if (tag !== null) writeFileSync(mirrorMarker, `${tag}\n`);
}

// 持鎖狀態下呼叫: 核心首次啟動會把 CWD 的 config.example.yaml 複製成 config.yaml,
// 資料目錄裡必須先備好範本。
function copyConfigExample(paths, exampleSrc) {
  const exampleDest = join(paths.root, "config.example.yaml");
  if (existsSync(exampleSrc) && !existsSync(exampleDest)) cpSync(exampleSrc, exampleDest);
}

// 持鎖狀態下呼叫: 清掉 runtime 下其他版本的目錄與逾時的暫存目錄, 盡力而為不拋錯。
async function cleanupRuntimeDir(paths, keepDir) {
  let names;
  try { names = readdirSync(paths.runtimeDir); } catch { return; }
  for (const name of names) {
    const p = join(paths.runtimeDir, name);
    if (p === keepDir) continue;
    if (name.startsWith(".tmp-")) {
      // 其他行程可能正在解開自己的暫存目錄; 只清夠舊的。
      try { if (Date.now() - statSync(p).mtimeMs < 10 * 60 * 1000) continue; } catch { continue; }
    }
    await retryOnBusy(() => rmSync(p, { recursive: true, force: true }), { tries: 3 }).catch(() => { /* 清理失敗不影響啟動 */ });
  }
}

// 確保執行期資產就緒: SEA 模式解開內嵌檔案, 開發模式鏡像 Repo 的核心網頁。
// 所有角色 (監督者 / core / helper / cli) 都呼叫本函式; 透過執行期鎖串行化,
// 只有一個行程會實際動檔案, 其餘等待後檢查標記直接通過。
// 回傳本次版本的 runtime 目錄 (開發模式回傳 null, JS 本體直接從 Repo 載入)。
export async function ensureRuntime(sea, paths, log, { repoRoot = null, lockOptions } = {}) {
  mkdirSync(paths.root, { recursive: true });
  return withRuntimeLock(paths, async () => {
    if (sea) {
      const manifest = readManifest(sea);
      const versionDir = await extractVersionDir(sea, paths, manifest, log);
      await mirrorWebDir(paths, join(versionDir, "core", "dist", "web"), manifest.version, log);
      copyConfigExample(paths, join(versionDir, "core", "config.example.yaml"));
      await cleanupRuntimeDir(paths, versionDir);
      return versionDir;
    }
    if (repoRoot) {
      await mirrorWebDir(paths, join(repoRoot, "dist", "web"), null, log);
      copyConfigExample(paths, join(repoRoot, "config.example.yaml"));
    }
    return null;
  }, lockOptions);
}
