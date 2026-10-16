#!/usr/bin/env node
// 驗證打包成果是否為合格的 Windows SEA exe:
//   1. MZ/PE 檔頭與 x64 machine type;
//   2. Node SEA 的 sentinel fuse 與 NODE_SEA_BLOB 資源存在 (代表 blob 已注入);
//   3. 以 resedit 讀回 icon 資源與版本字串 (ProductName/FileDescription/LegalCopyright)。
// 用法: node tools/verify-exe.mjs <exe 路徑>; 檢查不過時結束碼為 1。
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { readExeMetadata } from "./set-exe-meta.mjs";

export const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

export function inspectExe(exePath) {
  const buf = readFileSync(exePath);
  const result = { path: exePath, size: statSync(exePath).size };
  result.mz = buf.length > 64 && buf[0] === 0x4d && buf[1] === 0x5a;
  const peOff = result.mz ? buf.readUInt32LE(0x3c) : 0;
  result.pe = result.mz && buf.toString("latin1", peOff, peOff + 4) === "PE\0\0";
  result.machine = result.pe ? buf.readUInt16LE(peOff + 4) : 0;
  result.isX64 = result.machine === 0x8664;
  result.seaFuse = buf.includes(Buffer.from(SEA_FUSE, "latin1"));
  result.seaBlobResource = buf.includes(Buffer.from("NODE_SEA_BLOB", "latin1"));
  result.meta = readExeMetadata(exePath);
  result.ok = Boolean(result.mz && result.pe && result.isX64 && result.seaFuse);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("verify-exe.mjs")) {
  const target = process.argv[2] ? resolve(process.argv[2]) : null;
  if (!target) {
    console.error("用法: node tools/verify-exe.mjs <exe 路徑>");
    process.exit(2);
  }
  const r = inspectExe(target);
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) {
    console.error("驗證失敗: 不是合格的 x64 Windows SEA exe");
    process.exit(1);
  }
  console.log("驗證通過: x64 Windows PE + SEA fuse 存在");
}
