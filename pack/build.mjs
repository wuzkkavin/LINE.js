#!/usr/bin/env node
// AI寶 打包管線: 把 LINE.js 核心 + helper 小幫手 + 啟動器打成單一執行檔 (Node SEA)。
//
// 流程:
//   1. 確認相依與核心建置 (根目錄 npm ci / npm run build, helper npm ci)
//   2. esbuild 打包四件 JS: 核心 dist/main.js、核心 CLI、helper 主程式、啟動器 (CJS)
//   3. 蒐集靜態資產到 build/assets (核心網頁、helper 網頁與字體圖示、package.json 等) 並產生 manifest
//   4. 以 node --experimental-sea-config 產生 SEA blob
//   5. 取得基底 node: --target win 下載官方 Node win-x64 的 node.exe; --target current 用目前平台的 node (自測用)
//   6. (僅 win) 以 resedit 換上 AI寶 icon 與版本資訊 (含版權宣告)
//   7. 以 postject 注入 SEA blob, 產出 out/AI寶.exe
//   8. 驗證成品 (PE/fuse/icon/版本) 並寫入 build/build-report.json
//
// 用法: node build.mjs [--target win|current] [--skip-core-build]
import { execFile, spawn } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as esbuild from "esbuild";
import { inject } from "postject";
import { buildIcoFromPng } from "./tools/ico.mjs";
import { applyExeMetadata } from "./tools/set-exe-meta.mjs";
import { stripSignature } from "./tools/strip-signature.mjs";
import { inspectExe, SEA_FUSE } from "./tools/verify-exe.mjs";

const NODE_VERSION = "v24.20.0"; // 與開發 VM 相同的 Node 大版本 (24), 釘版避免 SEA 行為漂移
const packDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(packDir, "..");
const helperDir = join(repoRoot, "helper");
const buildDir = join(packDir, "build");
const stagingDir = join(buildDir, "assets");
const cacheDir = join(packDir, ".cache");
const outDir = join(packDir, "out");

const args = process.argv.slice(2);
const target = args.includes("--target") ? args[args.indexOf("--target") + 1] : "win";
const skipCoreBuild = args.includes("--skip-core-build");
if (!["win", "current"].includes(target)) {
  console.error(`未知的 --target: ${target} (可用: win, current)`);
  process.exit(2);
}

const log = (msg) => console.log(`[pack] ${msg}`);
function run(cmd, cmdArgs, { cwd, shell = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, cmdArgs, { cwd, shell, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} ${cmdArgs.join(" ")} 結束碼 ${code}`))));
  });
}
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const runNpm = (npmArgs, cwd) => run(npmCmd, npmArgs, { cwd, shell: process.platform === "win32" });

function copyTree(src, dest) {
  if (!existsSync(src)) throw new Error(`找不到要打包的檔案: ${src}`);
  cpSync(src, dest, { recursive: true, force: true });
}
function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out.sort();
}

async function ensureDepsAndCoreBuild() {
  if (!existsSync(join(repoRoot, "node_modules"))) {
    log("根目錄 node_modules 不存在, 執行 npm ci --include=dev");
    await runNpm(["ci", "--include=dev"], repoRoot);
  }
  if (!skipCoreBuild) {
    log("建置上游核心 (tsc + vite)");
    await runNpm(["run", "build"], repoRoot);
  } else if (!existsSync(join(repoRoot, "dist", "main.js"))) {
    throw new Error("--skip-core-build 指定了, 但 dist/main.js 不存在");
  }
  if (!existsSync(join(helperDir, "node_modules"))) {
    log("helper node_modules 不存在, 執行 npm ci");
    await runNpm(["ci"], helperDir);
  }
}

async function bundleAll() {
  // ESM bundle 內的 CJS 相依 (如 ws) 會呼叫 require(); 注入 createRequire 讓它在 ESM 情境也能運作。
  const requireBanner = { js: "import { createRequire as __aibaoCreateRequire } from 'node:module'; const require = __aibaoCreateRequire(import.meta.url);" };
  const common = { bundle: true, platform: "node", target: "node22", logLevel: "warning", external: ["bufferutil", "utf-8-validate"], banner: requireBanner };
  log("esbuild 打包核心 dist/main.js");
  await esbuild.build({ ...common, format: "esm", entryPoints: [join(repoRoot, "dist", "main.js")], outfile: join(stagingDir, "core", "dist", "main.js") });
  log("esbuild 打包核心 CLI scripts/cli.mjs");
  await esbuild.build({ ...common, format: "esm", entryPoints: [join(repoRoot, "scripts", "cli.mjs")], outfile: join(stagingDir, "core", "scripts", "cli.mjs") });
  log("esbuild 打包 helper 主程式");
  await esbuild.build({ ...common, format: "esm", entryPoints: [join(helperDir, "src", "main.mjs")], outfile: join(stagingDir, "helper", "src", "main.mjs") });
  log("esbuild 打包啟動器 (CJS, SEA 主程式)");
  await esbuild.build({ bundle: true, platform: "node", target: "node22", format: "cjs", logLevel: "warning", entryPoints: [join(packDir, "launcher", "entry.mjs")], outfile: join(buildDir, "launcher.cjs") });
}

function collectAssets(coreVer, helperVer) {
  copyTree(join(repoRoot, "dist", "web"), join(stagingDir, "core", "dist", "web"));
  copyTree(join(repoRoot, "package.json"), join(stagingDir, "core", "package.json"));
  copyTree(join(repoRoot, "config.example.yaml"), join(stagingDir, "core", "config.example.yaml"));
  copyTree(join(helperDir, "web"), join(stagingDir, "helper", "web"));
  copyTree(join(helperDir, "package.json"), join(stagingDir, "helper", "package.json"));
  copyTree(join(helperDir, "assets", "fonts"), join(stagingDir, "helper", "assets", "fonts"));
  // 頭像素材只打現行版: icon (App 圖示)、avatar (去背+米白底頭像)、cutout (透明母檔);
  // ai-bao-avatar-ai.png / -photo.png / -original.png 是備份, 不進 exe。
  for (const name of ["ai-bao-icon.png", "ai-bao-avatar.png", "ai-bao-cutout.png"]) {
    copyTree(join(helperDir, "assets", name), join(stagingDir, "helper", "assets", name));
  }
  const files = listFiles(stagingDir).filter((f) => f !== "manifest.json");
  const manifest = { version: `${coreVer}+${helperVer}`, files };
  writeFileSync(join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  log(`資產蒐集完成: ${files.length} 個檔案, runtime 版本 ${manifest.version}`);
  return manifest;
}

async function makeSeaBlob(manifest) {
  const assets = {};
  for (const key of [...manifest.files, "manifest.json"]) assets[key] = join(stagingDir, ...key.split("/"));
  const seaConfig = {
    main: join(buildDir, "launcher.cjs"),
    output: join(buildDir, "sea.blob"),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    assets,
  };
  const configPath = join(buildDir, "sea-config.json");
  writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));
  log("產生 SEA blob");
  await new Promise((resolvePromise, reject) => {
    execFile(process.execPath, ["--experimental-sea-config", configPath], { cwd: packDir }, (err, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      return err ? reject(err) : resolvePromise();
    });
  });
}

async function downloadFile(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下載失敗 ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function baseNodeExe() {
  if (target === "current") return process.execPath;
  const dirName = `node-${NODE_VERSION}-win-x64`;
  const exePath = join(cacheDir, dirName, "node.exe");
  if (existsSync(exePath)) return exePath;
  mkdirSync(cacheDir, { recursive: true });
  const zipPath = join(cacheDir, `${dirName}.zip`);
  if (!existsSync(zipPath)) {
    const url = `https://nodejs.org/dist/${NODE_VERSION}/${dirName}.zip`;
    log(`下載官方 Node ${NODE_VERSION} win-x64: ${url}`);
    await downloadFile(url, zipPath);
  }
  log("解壓縮 node.exe");
  if (process.platform === "win32") {
    await run("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${cacheDir}'`], {});
  } else {
    await run("unzip", ["-o", "-q", zipPath, `${dirName}/node.exe`, "-d", cacheDir], {});
  }
  if (!existsSync(exePath)) throw new Error(`解壓縮後找不到 node.exe: ${exePath}`);
  return exePath;
}

async function main() {
  const started = Date.now();
  mkdirSync(buildDir, { recursive: true });
  rmSync(stagingDir, { recursive: true, force: true });
  mkdirSync(stagingDir, { recursive: true });

  const coreVer = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
  const helperVer = JSON.parse(readFileSync(join(helperDir, "package.json"), "utf8")).version;

  await ensureDepsAndCoreBuild();
  await bundleAll();
  const manifest = collectAssets(coreVer, helperVer);
  await makeSeaBlob(manifest);

  const baseExe = await baseNodeExe();
  const exeName = target === "win" ? "AI寶.exe" : "AI寶-linux";
  const exeDir = target === "win" ? outDir : join(buildDir, "selftest");
  mkdirSync(exeDir, { recursive: true });
  const exePath = join(exeDir, exeName);
  cpSync(baseExe, exePath, { force: true });
  log(`基底 node 已複製: ${exePath}`);

  let metaApplied = false;
  let metaError = null;
  if (target === "win") {
    try {
      const strip = stripSignature(exePath);
      log(`已移除基底 node 的簽章: ${JSON.stringify(strip)}`);
    } catch (e) {
      log(`警告: 移除簽章失敗 (${String(e?.message || e)}), 繼續後續步驟`);
    }
    try {
      const ico = buildIcoFromPng(readFileSync(join(helperDir, "assets", "ai-bao-icon.png")));
      const fileVersion = `${coreVer}.0`;
      applyExeMetadata(exePath, {
        icoBuffer: ico,
        fileVersion,
        strings: {
          ProductName: "AI寶",
          FileDescription: "AI寶 - 公司 LINE 群組電腦學習小幫手 (©Copyright 2026 By 吳治綱 繁體中文化)",
          LegalCopyright: "©Copyright 2026 By 吳治綱 繁體中文化",
          CompanyName: "吳治綱",
          ProductVersion: fileVersion,
          FileVersion: fileVersion,
          OriginalFilename: "AI寶.exe",
          InternalName: "AI寶",
          Comments: "基於 JS-PACKAGE/LINE.js (Apache License 2.0) 與 @evex/linejs 的客製版本",
        },
      });
      metaApplied = true;
      log("已以 resedit 換上 AI寶 icon 與版本資訊");
    } catch (e) {
      metaError = String(e?.message || e);
      log(`警告: resedit 改寫 exe 資源失敗 (${metaError}); 先照常注入 SEA, 此項列入待 Windows 端補做`);
    }
  }

  log("以 postject 注入 SEA blob");
  await inject(exePath, "NODE_SEA_BLOB", readFileSync(join(buildDir, "sea.blob")), { sentinelFuse: SEA_FUSE });

  const report = inspectExe(exePath);
  if (target === "current") report.ok = Boolean(report.seaFuse); // ELF 自測版只驗 SEA fuse, PE 檢查不適用
  report.target = target;
  report.nodeVersion = NODE_VERSION;
  report.coreVersion = coreVer;
  report.helperVersion = helperVer;
  report.metaApplied = metaApplied;
  if (metaError) report.metaError = metaError;
  report.builtInMs = Date.now() - started;
  writeFileSync(join(buildDir, "build-report.json"), JSON.stringify(report, null, 2));
  log(`成品: ${exePath} (${(report.size / 1048576).toFixed(1)} MiB)`);
  log(`驗證: PE=${report.pe} x64=${report.isX64} SEA fuse=${report.seaFuse} icon 組數=${report.meta?.iconGroups ?? "n/a"}`);
  if (!report.ok) {
    console.error("[pack] 成品驗證未通過, 詳見 build/build-report.json");
    process.exit(1);
  }
  log("打包完成");
}

main().catch((e) => {
  console.error(`[pack] 打包失敗: ${e?.stack || e}`);
  process.exit(1);
});
