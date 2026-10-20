// ICO 產生器迴歸測試 (2026-10-20 圖示修復批次):
// 舊版只包單張 233x232 原圖, 系統被迫即時縮放而出現系統匣黑邊、工作列選不到尺寸。
// 這裡驗證消費者可見的契約: 多尺寸、正方形、透明角、邊緣有抗鋸齒半透明像素、
// 且每一張內嵌 PNG 的尺寸與 ICO 目錄宣告一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildIcoFromPng, decodePngToRgba, ICO_SIZES } from "../tools/ico.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_PNG = join(here, "..", "..", "helper", "assets", "ai-bao-icon.png");

function parseIco(buf) {
  assert.equal(buf.readUInt16LE(0), 0, "reserved 必須為 0");
  assert.equal(buf.readUInt16LE(2), 1, "type 必須為 1 (icon)");
  const count = buf.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    entries.push({
      size: buf[o] === 0 ? 256 : buf[o],
      heightByte: buf[o + 1],
      planes: buf.readUInt16LE(o + 4),
      bpp: buf.readUInt16LE(o + 6),
      bytes: buf.readUInt32LE(o + 8),
      offset: buf.readUInt32LE(o + 12),
    });
  }
  return entries;
}

test("buildIcoFromPng 產生 ICO_SIZES 全部尺寸, 皆為正方形 PNG 且目錄一致", () => {
  const ico = buildIcoFromPng(readFileSync(SRC_PNG));
  const entries = parseIco(ico);
  assert.deepEqual(entries.map((e) => e.size), ICO_SIZES);
  for (const e of entries) {
    assert.equal(e.heightByte, e.size === 256 ? 0 : e.size, `${e.size} 高度位元組`);
    assert.equal(e.planes, 1);
    assert.equal(e.bpp, 32);
    const img = decodePngToRgba(ico.subarray(e.offset, e.offset + e.bytes));
    assert.equal(img.width, e.size, `${e.size} 內嵌 PNG 寬`);
    assert.equal(img.height, e.size, `${e.size} 內嵌 PNG 高 (必須正方形)`);
  }
});

test("每一尺寸的四角透明, 且邊緣含抗鋸齒半透明像素 (無硬邊黑框成因)", () => {
  const ico = buildIcoFromPng(readFileSync(SRC_PNG));
  for (const e of parseIco(ico)) {
    const { rgba, width, height } = decodePngToRgba(ico.subarray(e.offset, e.offset + e.bytes));
    const alphaAt = (x, y) => rgba[(y * width + x) * 4 + 3];
    for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1]]) {
      assert.ok(alphaAt(x, y) <= 16, `${e.size}px 角落 (${x},${y}) alpha=${alphaAt(x, y)} 應接近全透明`);
    }
    let aa = 0;
    for (let p = 0; p < width * height; p++) {
      const a = rgba[p * 4 + 3];
      if (a > 0 && a < 255) aa++;
    }
    assert.ok(aa > 0, `${e.size}px 應有半透明抗鋸齒邊緣像素`);
  }
});

test("app/assets/icon.ico 與 buildIcoFromPng 產出一致 (殼與引擎同圖示)", () => {
  const fromTool = buildIcoFromPng(readFileSync(SRC_PNG));
  const committed = readFileSync(join(here, "..", "..", "app", "assets", "icon.ico"));
  assert.ok(fromTool.equals(committed), "app/assets/icon.ico 過期: 請跑 node pack/tools/ico.mjs helper/assets/ai-bao-icon.png app/assets/icon.ico 重新產生");
});
