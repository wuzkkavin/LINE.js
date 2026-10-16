// 移除 PE 檔案的 Authenticode 簽章 (Certificate Table)。
// 時機: 在 resedit 改資源與 postject 注入之前先移除, 成品維持「乾淨的未簽章」狀態,
// 避免留下指向舊內容的失效簽章 (postject 會警告 signature corrupted, 且部分工具會誤判檔案損壞)。
// 作法: 把 Optional Header 資料目錄第 4 項 (IMAGE_DIRECTORY_ENTRY_SECURITY) 的位址與大小清零,
// 並把位於檔尾的憑證表截掉。僅支援 PE32+ (x64)。
import { readFileSync, writeFileSync } from "node:fs";

export function stripSignature(exePath) {
  const buf = readFileSync(exePath);
  if (buf.length < 64 || buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error("不是有效的 PE 檔案 (缺 MZ)");
  const peOff = buf.readUInt32LE(0x3c);
  if (buf.toString("latin1", peOff, peOff + 4) !== "PE\0\0") throw new Error("不是有效的 PE 檔案 (缺 PE 簽名)");
  const optOff = peOff + 4 + 20; // PE signature + COFF header
  const magic = buf.readUInt16LE(optOff);
  if (magic !== 0x20b) throw new Error(`只支援 PE32+ (x64), Optional Header magic=${magic.toString(16)}`);
  const secEntryOff = optOff + 112 + 4 * 8; // 資料目錄起點 (PE32+ 為 +112) + 第 4 項 (SECURITY) * 8 bytes
  const certAddr = buf.readUInt32LE(secEntryOff);
  const certSize = buf.readUInt32LE(secEntryOff + 4);
  if (certAddr === 0 || certSize === 0) return { stripped: false, reason: "no-certificate" };
  buf.writeUInt32LE(0, secEntryOff);
  buf.writeUInt32LE(0, secEntryOff + 4);
  // 憑證表依規格位於檔案最後; 吻合時一併截掉多餘 bytes, 不吻合則只清目錄項不動檔案長度。
  const out = certAddr + certSize === buf.length ? buf.subarray(0, certAddr) : buf;
  writeFileSync(exePath, out);
  return { stripped: true, certSize, truncated: out.length !== buf.length };
}
