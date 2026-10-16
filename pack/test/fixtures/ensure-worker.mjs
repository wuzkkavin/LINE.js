// 並發測試的子行程進入點: 對指定資料目錄呼叫 ensureRuntime,
// 完成後逐檔驗證內容完整, 全對才印 WORKER-OK 並以 0 結束。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataPaths } from "../../launcher/paths.mjs";
import { ensureRuntime, runtimeVersionDir } from "../../launcher/runtime.mjs";
import { makeStubSea, expectedContent, STUB_FILES, STUB_VERSION } from "./stub-sea.mjs";

const dataDir = process.argv[2];
if (!dataDir) {
  console.error("用法: node ensure-worker.mjs <dataDir>");
  process.exit(2);
}
const paths = dataPaths(dataDir);
const versionDir = await ensureRuntime(makeStubSea(), paths, () => {});
if (versionDir !== runtimeVersionDir(paths, STUB_VERSION)) {
  console.error(`runtime 目錄不符: ${versionDir}`);
  process.exit(3);
}
for (const key of STUB_FILES) {
  const got = readFileSync(join(versionDir, ...key.split("/")), "utf8");
  if (got !== expectedContent(key)) {
    console.error(`檔案內容不完整: ${key}`);
    process.exit(4);
  }
}
console.log("WORKER-OK");
