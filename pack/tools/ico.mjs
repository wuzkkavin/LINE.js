// 把一張 PNG 包成單張圖示的 ICO 檔 (Windows Vista 以上支援 PNG 壓縮圖示)。
// ICO 格式: ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes) + PNG 原始資料。
// 圖示寬高從 PNG 的 IHDR 讀取; 256 需以 0 表示, 其餘直接填實際像素數。
import { Buffer } from "node:buffer";

export function buildIcoFromPng(png) {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("不是有效的 PNG 檔案 (檔頭不符)");
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width > 256 || height > 256) {
    throw new Error(`PNG 尺寸 ${width}x${height} 超過 ICO 上限 256x256`);
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(width === 256 ? 0 : width, 0);
  entry.writeUInt8(height === 256 ? 0 : height, 1);
  entry.writeUInt8(0, 2); // color palette count
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8); // image size
  entry.writeUInt32LE(6 + 16, 12); // image offset
  return Buffer.concat([header, entry, png]);
}
