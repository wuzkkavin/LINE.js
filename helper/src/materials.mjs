// 教材庫: 「發送群組訊息」頁可以重複取用的圖片/檔案, 存在 data 目錄下的 materials 資料夾。
// 為什麼不讓待發清單直接記任意路徑就好: 同事常用的教材圖 (例如操作步驟截圖) 會一再重發,
// 存一份在程式自己的資料夾裡, 換電腦/檔案搬家都不會失效; 臨時選的檔案仍走原本的路徑參照。
// 檔名安全: 只接受單一檔名 (不含路徑分隔與 ..), 讀寫都鎖在這個資料夾內。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MATERIAL_MAX_BYTES = 10 * 1024 * 1024; // 與圖片/檔案的單筆上限一致 (規格第一版 10MB)

export function sanitizeMaterialName(name) {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n || n.includes("/") || n.includes("\\") || n.includes("..") || n.includes("\0")) return "";
  return n;
}

export class MaterialsStore {
  constructor({ dir = "" } = {}) {
    this.dir = dir;
  }
  ensure() {
    if (this.dir) mkdirSync(this.dir, { recursive: true });
  }
  list() {
    if (!this.dir || !existsSync(this.dir)) return [];
    const out = [];
    for (const name of readdirSync(this.dir)) {
      const p = join(this.dir, name);
      try {
        const st = statSync(p);
        if (st.isFile()) out.push({ name, sizeBytes: st.size });
      } catch { /* 讀不到的檔案不列出 */ }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }
  save(name, buffer) {
    const safe = sanitizeMaterialName(name);
    if (!safe) return { ok: false, errors: ["檔名不正確"] };
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) return { ok: false, errors: ["檔案是空的"] };
    if (buffer.length > MATERIAL_MAX_BYTES) return { ok: false, errors: [`檔案超過上限 ${Math.round(MATERIAL_MAX_BYTES / 1024 / 1024)}MB`] };
    this.ensure();
    writeFileSync(join(this.dir, safe), buffer, { mode: 0o600 });
    return { ok: true, value: { name: safe, sizeBytes: buffer.length } };
  }
  read(name) {
    const safe = sanitizeMaterialName(name);
    if (!safe || !this.dir) return null;
    const p = join(this.dir, safe);
    if (!existsSync(p)) return null;
    try { return readFileSync(p); } catch { return null; }
  }
}
