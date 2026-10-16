// 假 SEA 物件: 提供與 node:sea 相容的 getAsset, 內容由 key 決定性產生,
// 讓並發測試能逐檔驗證解開結果是否完整未被其他行程踩壞。
export const STUB_VERSION = "9.9.9-test";

const chunks = [];
for (let i = 0; i < 40; i += 1) {
  chunks.push(`core/dist/web/assets/chunk-${String(i).padStart(2, "0")}.txt`);
}

export const STUB_FILES = [
  "core/dist/main.js",
  "core/dist/web/index.html",
  "core/dist/web/assets/app.js",
  "core/config.example.yaml",
  "helper/src/main.mjs",
  ...chunks,
];

export function expectedContent(key) {
  return `stub-content:${key}\n${"x".repeat(2048)}\n`;
}

export function makeStubSea() {
  const manifest = { version: STUB_VERSION, files: STUB_FILES };
  return {
    getAsset(key) {
      if (key === "manifest.json") return Buffer.from(JSON.stringify(manifest));
      if (!STUB_FILES.includes(key)) throw new Error(`stub sea 無此資產: ${key}`);
      return Buffer.from(expectedContent(key));
    },
  };
}
