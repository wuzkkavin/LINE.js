// AI寶 啟動器: SEA 單一執行檔的主程式。
//
// 模式 (以參數區分, 同一個 exe 自己分飾多角):
//   (無參數)       監督者: 解開內嵌檔案、處理 session 加密、啟動核心與 helper、開啟瀏覽器、負責收尾。
//   --role core    LINE.js 核心 (HTTP/WS 3789)。
//   --role helper  AI寶 控制台與機器人 (HTTP 3790)。
//   --role cli     核心 CLI 轉送, 例: AI寶.exe --role cli token (產生機器人 Token)。
//   --version      印出資料目錄後結束。
//
// 資料一律落在 resolveDataDir() 決定的目錄 (Windows 為 %LOCALAPPDATA%/HwLineHelper), 不寫 exe 旁邊。
// 開發模式 (非 SEA, 直接以 node 執行本檔) 時, 核心與 helper 改從 Repo 原始檔案載入, 行為與 SEA 版一致。
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDataDir, dataPaths } from "./paths.mjs";
import { createSessionVault } from "./vault.mjs";
import { probeHttp, waitForHttp, buildChildSpec } from "./probe.mjs";

const CORE_PORT = 3789;
const HELPER_PORT = 3790;
const CONSOLE_URL = `http://127.0.0.1:${HELPER_PORT}/`;
// 本檔案會在兩種情境執行: 開發模式直接以 node 執行本 ESM 原始檔 (import.meta.url 可用),
// 以及被 esbuild 打成 CJS 後塞進 SEA (import.meta 為空物件, 改用 CJS 的 __filename)。
// selfPath() 統一取得本程式路徑; repoRoot 只在開發模式使用, SEA 時其值不被引用。
function selfPath() {
  try { if (import.meta.url) return fileURLToPath(import.meta.url); } catch { /* SEA/CJS 情境 */ }
  try { if (typeof __filename === "string") return __filename; } catch { /* ESM 情境無此變數 */ }
  return process.execPath;
}
const here = dirname(selfPath());
const repoRoot = join(here, "..", "..");

async function getSea() {
  try {
    const sea = await import("node:sea");
    return sea && typeof sea.isSea === "function" && sea.isSea() ? sea : null;
  } catch {
    return null;
  }
}

function makeLog(paths) {
  const file = join(paths.logsDir, "launcher.log");
  return (msg) => {
    const line = `${new Date().toISOString()} [launcher] ${msg}`;
    try { appendFileSync(file, `${line}\n`); } catch { /* log 寫入失敗不應讓啟動器崩潰 */ }
    console.log(line);
  };
}

// 把 SEA 內嵌資產解開到 <dataDir>/runtime/<版本>/, 並把核心網頁鏡像到 <dataDir>/dist/web
// (核心以 CWD 的 dist/web 提供網頁, 而核心子行程的 CWD 就是資料目錄)。
// 回傳本次版本的 runtime 目錄。已有完整解開標記時只做鏡像與舊版清理。
function extractAssets(sea, paths, log) {
  const manifest = JSON.parse(Buffer.from(sea.getAsset("manifest.json")).toString("utf8"));
  const runtimeVerDir = join(paths.runtimeDir, manifest.version);
  const marker = join(runtimeVerDir, ".extracted-ok");
  if (!existsSync(marker)) {
    log(`解開內嵌檔案到 ${runtimeVerDir} (共 ${manifest.files.length} 個)`);
    for (const key of manifest.files) {
      const dest = join(runtimeVerDir, ...key.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(sea.getAsset(key)));
    }
    writeFileSync(marker, `files=${manifest.files.length}\n`);
  }
  const webSrc = join(runtimeVerDir, "core", "dist", "web");
  if (existsSync(webSrc)) {
    mkdirSync(paths.distWebDir, { recursive: true });
    cpSync(webSrc, paths.distWebDir, { recursive: true, force: true });
  }
  // 核心首次啟動會把 CWD 的 config.example.yaml 複製成 config.yaml; 資料目錄裡必須先備好範本。
  const exampleSrc = join(runtimeVerDir, "core", "config.example.yaml");
  const exampleDest = join(paths.root, "config.example.yaml");
  if (existsSync(exampleSrc) && !existsSync(exampleDest)) cpSync(exampleSrc, exampleDest);
  try {
    for (const name of readdirSync(paths.runtimeDir)) {
      const p = join(paths.runtimeDir, name);
      if (p !== runtimeVerDir) rmSync(p, { recursive: true, force: true });
    }
  } catch { /* 清理舊版失敗不影響啟動 */ }
  return runtimeVerDir;
}

// 開發模式: 只鏡像核心網頁與設定範本到資料目錄, JS 本體直接從 Repo 載入。
function devMirror(paths) {
  const webSrc = join(repoRoot, "dist", "web");
  if (existsSync(webSrc)) {
    mkdirSync(paths.distWebDir, { recursive: true });
    cpSync(webSrc, paths.distWebDir, { recursive: true, force: true });
  }
  const exampleSrc = join(repoRoot, "config.example.yaml");
  const exampleDest = join(paths.root, "config.example.yaml");
  if (existsSync(exampleSrc) && !existsSync(exampleDest)) cpSync(exampleSrc, exampleDest);
  return null;
}

function ensureRuntime(sea, paths, log) {
  return sea ? extractAssets(sea, paths, log) : devMirror(paths);
}

function openBrowser() {
  try {
    const opts = { detached: true, stdio: "ignore" };
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", CONSOLE_URL], { ...opts, windowsHide: true }).unref();
    else if (process.platform === "darwin") spawn("open", [CONSOLE_URL], opts).unref();
    else spawn("xdg-open", [CONSOLE_URL], opts).unref();
  } catch { /* 開瀏覽器失敗不影響服務本身 */ }
}

async function roleCore(sea, paths) {
  const log = makeLog(paths);
  const runtimeVerDir = ensureRuntime(sea, paths, log);
  process.chdir(paths.root);
  const target = sea ? join(runtimeVerDir, "core", "dist", "main.js") : join(repoRoot, "dist", "main.js");
  await import(pathToFileURL(target).href);
}

async function roleHelper(sea, paths) {
  const log = makeLog(paths);
  const runtimeVerDir = ensureRuntime(sea, paths, log);
  if (!process.env.HELPER_DATA_DIR) process.env.HELPER_DATA_DIR = paths.root;
  if (!process.env.HELPER_PORT) process.env.HELPER_PORT = String(HELPER_PORT);
  const target = sea ? join(runtimeVerDir, "helper", "src", "main.mjs") : join(repoRoot, "helper", "src", "main.mjs");
  await import(pathToFileURL(target).href);
}

async function roleCli(sea, paths, args) {
  const log = makeLog(paths);
  const runtimeVerDir = ensureRuntime(sea, paths, log);
  process.chdir(paths.root);
  process.argv = [process.argv[0], "cli", ...args];
  const target = sea ? join(runtimeVerDir, "core", "scripts", "cli.mjs") : join(repoRoot, "scripts", "cli.mjs");
  await import(pathToFileURL(target).href);
}

async function supervise(sea, paths) {
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.logsDir, { recursive: true });
  const log = makeLog(paths);
  log(`AI寶 啟動中; 資料目錄: ${paths.root}; 模式: ${sea ? "SEA 單一執行檔" : "開發模式"}`);
  ensureRuntime(sea, paths, log);

  const vault = createSessionVault({ paths });
  try {
    const r = await vault.unlock();
    log(`session 靜置解密: ${r.status}`);
  } catch (e) {
    log(`session 靜置解密失敗 (${e?.code || e?.message || e}), 本次以未登入狀態啟動, 密文保留不動`);
  }

  const coreAlive = await probeHttp({ port: CORE_PORT });
  const helperAlive = await probeHttp({ port: HELPER_PORT });
  if (coreAlive && helperAlive) {
    log("核心與控制台都已在執行, 本次只開啟瀏覽器, 不重複啟動");
    openBrowser();
    return;
  }

  const children = new Map();
  let shuttingDown = false;
  let shutdownPromise = null;

  async function shutdown(reason) {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      log(`開始關閉 (原因: ${reason})`);
      for (const child of children.values()) { try { child.kill(); } catch { /* 已結束 */ } }
      const waits = [...children.values()].map((c) => new Promise((r) => {
        if (c.exitCode !== null || c.signalCode !== null) r();
        else c.once("exit", () => r());
      }));
      await Promise.race([Promise.allSettled(waits), new Promise((r) => setTimeout(r, 3000))]);
      try {
        const r = await vault.lock();
        log(`session 靜置加密: ${r.status}`);
      } catch (e) {
        log(`session 靜置加密失敗 (${e?.code || e?.message || e}), 明文保留, 下次啟動再處理`);
      }
      process.exit(0);
    })();
    return shutdownPromise;
  }

  const spawnRole = (role) => {
    const spec = buildChildSpec(role, { exePath: process.execPath, dataDir: paths.root });
    // stdio 要傳已開啟的 fd; WriteStream 尚未 open 時 fd 為 null, spawn 會拒絕。
    const fd = openSync(join(paths.logsDir, `launcher-${role}.log`), "a");
    const argv = sea ? spec.args : [selfPath(), ...spec.args];
    const child = spawn(spec.file, argv, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    closeSync(fd); // 子行程已繼承自己的 fd, 父行程這份可關閉
    children.set(role, child);
    child.on("error", (e) => log(`${role} 子行程啟動失敗: ${e.message}`));
    child.on("exit", (code, signal) => {
      log(`${role} 子行程結束 (code=${code}, signal=${signal})`);
      if (!shuttingDown) void shutdown(`child-${role}-exit`);
    });
    log(`${role} 子行程已啟動 (pid=${child.pid})`);
    return child;
  };

  if (!coreAlive) spawnRole("core");
  if (!helperAlive) spawnRole("helper");

  const coreOk = coreAlive || (await waitForHttp({ port: CORE_PORT, timeoutMs: 45000 }));
  const helperOk = helperAlive || (await waitForHttp({ port: HELPER_PORT, timeoutMs: 45000 }));
  log(`就緒檢查: 核心=${coreOk ? "OK" : "未就緒"}, 控制台=${helperOk ? "OK" : "未就緒"}`);
  if (helperOk) openBrowser();
  else log("控制台未就緒, 不開啟瀏覽器; 請查看 logs 目錄下的 launcher-helper.log");

  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"]) process.on(sig, () => void shutdown(sig));
  await new Promise(() => { /* 監督者保持存活, 直到 shutdown() 結束行程 */ });
}

async function main() {
  const args = process.argv.slice(2);
  const sea = await getSea();
  const paths = dataPaths(resolveDataDir());
  if (args[0] === "--version") {
    let coreVer = "?", helperVer = "?";
    try { coreVer = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version; } catch { /* SEA 模式下 Repo 不存在 */ }
    try { helperVer = JSON.parse(readFileSync(join(repoRoot, "helper", "package.json"), "utf8")).version; } catch { /* 同上 */ }
    console.log(`AI寶 (LINE.js core ${coreVer}, helper ${helperVer})`);
    console.log(`資料目錄: ${paths.root}`);
    return;
  }
  if (args[0] === "--role") {
    mkdirSync(paths.logsDir, { recursive: true });
    const role = args[1];
    if (role === "core") return roleCore(sea, paths);
    if (role === "helper") return roleHelper(sea, paths);
    if (role === "cli") return roleCli(sea, paths, args.slice(2));
    console.error(`未知的 role: ${role} (可用: core, helper, cli)`);
    process.exitCode = 2;
    return;
  }
  return supervise(sea, paths);
}

main().catch((e) => {
  console.error(`LAUNCHER_FAILED: ${e?.stack || e}`);
  process.exitCode = 1;
});
