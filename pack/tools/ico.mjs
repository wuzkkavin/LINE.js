// AI寶 ICO 產生器: 把來源 PNG 產生多尺寸、透明底、正方形的 ICO。
//
// 為什麼重寫 (2026-10-20 圖示修復批次): 舊版只把來源 PNG (233x232) 原封包成
// 單一尺寸 ICO。Windows 各介面 (工作列/標題列/系統匣/檔案總管) 需要 16/20/24/
// 32/48/64/128/256 等確切尺寸, 只有一張 233x232 時系統被迫即時縮放; 而來源圖
// 是二值 alpha (只有 0 與 255, 沒有抗鋸齒邊) 且透明像素的 RGB 是白色,
// 非預乘縮放會把透明區的顏色平均進邊緣, 造成系統匣黑邊/白暈, 大尺寸介面也
// 可能選不到合適圖示而顯示空白。故改為:
//   1. 純 Node 內建模組 (node:zlib) 解碼 PNG, 不新增相依;
//   2. 先置中補透明邊成正方形畫布 (來源 233x232 非正方形, 舊 app/assets/icon.ico
//      的最大張甚至是 128x127, 就是沒補正方形的結果);
//   3. 以「預乘 alpha 面積加權」縮放每一種尺寸, 邊緣自然產生正確顏色的
//      半透明抗鋸齒像素, 不再被系統縮放污染;
//   4. 每種尺寸各自編成 PNG 再組 ICO (Vista 以上支援 PNG 壓縮圖示)。
// 本工具同時供 build.mjs (引擎 exe 圖示) 與 app/assets/icon.ico (Rust 殼圖示,
// 以 CLI 模式產生) 使用, 兩邊圖示保證一致:
//   node tools/ico.mjs <來源 PNG> <輸出 ICO>
import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";

export const ICO_SIZES = [16, 20, 24, 32, 48, 64, 128, 256];

// ---------- CRC32 (PNG 區塊需要) ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

// ---------- PNG 解碼 (8-bit、非交錯; 支援灰階/RGB/調色盤/灰階+alpha/RGBA) ----------
export function decodePngToRgba(png) {
  if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("不是有效的 PNG 檔案 (檔頭不符)");
  }
  let pos = 8;
  let ihdr = null;
  let palette = null;
  let trns = null;
  const idatParts = [];
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") ihdr = data;
    else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idatParts.push(data);
    pos += 12 + len;
    if (type === "IEND") break;
  }
  if (!ihdr) throw new Error("PNG 缺少 IHDR");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (bitDepth !== 8) throw new Error(`只支援 8-bit PNG (來源是 ${bitDepth}-bit)`);
  if (interlace !== 0) throw new Error("只支援非交錯 PNG");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支援的 PNG 色彩類型 ${colorType}`);
  const raw = inflateSync(Buffer.concat(idatParts));
  const stride = width * channels;
  const px = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[rp++];
      const a = x >= channels ? px[rowStart + x - channels] : 0;
      const b = y > 0 ? px[prevStart + x] : 0;
      const c = x >= channels && y > 0 ? px[prevStart + x - channels] : 0;
      let out;
      switch (filter) {
        case 0: out = v; break;
        case 1: out = v + a; break;
        case 2: out = v + b; break;
        case 3: out = v + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`不支援的 PNG filter ${filter}`);
      }
      px[rowStart + x] = out & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 6) {
      rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = px[s + 3];
    } else if (colorType === 2) {
      rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = 255;
    } else if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = 255;
    } else if (colorType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = px[s + 1];
    } else {
      if (!palette) throw new Error("調色盤 PNG 缺少 PLTE");
      const pi = px[s] * 3;
      rgba[d] = palette[pi]; rgba[d + 1] = palette[pi + 1]; rgba[d + 2] = palette[pi + 2];
      rgba[d + 3] = trns && px[s] < trns.length ? trns[px[s]] : 255;
    }
  }
  return { rgba, width, height };
}

// ---------- PNG 編碼 (RGBA 8-bit, filter 0) ----------
export function encodeRgbaPng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 預乘 alpha 的 1D 重採樣 (三角核; 縮小時核寬隨比例放大) ----------
// 先把顏色乘上 alpha 再重採樣、最後除回 alpha, 是避免透明像素顏色污染邊緣的關鍵。
function resampleAxisPremultiplied(src, sw, sh, dw, dh, horizontal) {
  const out = new Float64Array(dw * dh * 4);
  const sLen = horizontal ? sw : sh;
  const dLen = horizontal ? dw : dh;
  const scale = sLen / dLen;
  const radius = Math.max(1, scale); // 來源像素單位的核半徑
  for (let d = 0; d < dLen; d++) {
    const center = (d + 0.5) * scale - 0.5;
    const s0 = Math.max(0, Math.floor(center - radius));
    const s1 = Math.min(sLen - 1, Math.ceil(center + radius));
    const weights = [];
    let wSum = 0;
    for (let s = s0; s <= s1; s++) {
      const w = Math.max(0, 1 - Math.abs(s - center) / radius);
      weights.push([s, w]);
      wSum += w;
    }
    for (let fixed = 0; fixed < (horizontal ? sh : sw); fixed++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [s, w] of weights) {
        const idx = (horizontal ? (fixed * sw + s) : (s * sw + fixed)) * 4;
        const alpha = src[idx + 3];
        r += src[idx] * alpha * w;
        g += src[idx + 1] * alpha * w;
        b += src[idx + 2] * alpha * w;
        a += alpha * w;
      }
      const oIdx = (horizontal ? (fixed * dw + d) : (d * dw + fixed)) * 4;
      out[oIdx] = r / wSum;
      out[oIdx + 1] = g / wSum;
      out[oIdx + 2] = b / wSum;
      out[oIdx + 3] = a / wSum;
    }
  }
  return out;
}

export function resizeRgbaPremultiplied(rgba, sw, sh, dw, dh) {
  const src = new Float64Array(rgba.length);
  for (let i = 0; i < rgba.length; i++) src[i] = rgba[i] / 255;
  const mid = resampleAxisPremultiplied(src, sw, sh, dw, sh, true);
  const done = resampleAxisPremultiplied(mid, dw, sh, dw, dh, false);
  const out = new Uint8Array(dw * dh * 4);
  for (let p = 0; p < dw * dh; p++) {
    const i = p * 4;
    const a = done[i + 3];
    out[i + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
    if (a > 1e-6) {
      // done 存的是預乘值 (顏色*alpha 的加權平均, 尚未除以 alpha): 除回 alpha 才是原色 (0..1)
      out[i] = Math.round(Math.min(1, Math.max(0, done[i] / a)) * 255);
      out[i + 1] = Math.round(Math.min(1, Math.max(0, done[i + 1] / a)) * 255);
      out[i + 2] = Math.round(Math.min(1, Math.max(0, done[i + 2] / a)) * 255);
    }
    // alpha 為 0 的像素 RGB 保持 0: 透明區不帶任何顏色, 杜絕縮放後的黑/白邊來源。
  }
  return out;
}

/** 把來源 RGBA 置中貼到正方形透明畫布 (不拉伸變形)。 */
export function padToSquare(rgba, w, h) {
  const side = Math.max(w, h);
  const out = new Uint8Array(side * side * 4);
  const ox = Math.floor((side - w) / 2);
  const oy = Math.floor((side - h) / 2);
  for (let y = 0; y < h; y++) {
    out.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), ((y + oy) * side + ox) * 4);
  }
  return { rgba: out, side };
}

// ---------- ICO 組裝 ----------
export function buildMultiSizeIco(png, sizes = ICO_SIZES) {
  const { rgba, width, height } = decodePngToRgba(png);
  const square = padToSquare(rgba, width, height);
  const images = sizes.map((size) => {
    const resized = size === square.side
      ? square.rgba
      : resizeRgbaPremultiplied(square.rgba, square.side, square.side, size, size);
    return { size, png: encodeRgbaPng(resized, size, size) };
  });
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(images.length, 4); // count
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png: img } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size === 256 ? 0 : size, 0);
    entry.writeUInt8(size === 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // color palette count
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(img.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += img.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

/** 相容舊呼叫端 (build.mjs): 現在回傳多尺寸 ICO, 不再是單張原圖。 */
export function buildIcoFromPng(png) {
  return buildMultiSizeIco(png);
}

// CLI: node tools/ico.mjs <來源 PNG> <輸出 ICO>
if (process.argv[1] && process.argv[1].endsWith("ico.mjs")) {
  const [srcPath, outPath] = process.argv.slice(2);
  if (!srcPath || !outPath) {
    console.error("用法: node tools/ico.mjs <來源 PNG> <輸出 ICO>");
    process.exit(2);
  }
  const ico = buildIcoFromPng(readFileSync(srcPath));
  writeFileSync(outPath, ico);
  console.log(`已產生 ${outPath}: ${ico.length} bytes, 尺寸 ${ICO_SIZES.join("/")} (來源 ${srcPath})`);
}
