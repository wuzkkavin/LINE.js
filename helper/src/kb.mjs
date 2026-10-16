// 知識庫: 指定資料夾唯讀掃描 (.txt/.md/.csv), 切段約 800 字, BM25 關鍵字索引, 索引存資料夾外。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";

const SUPPORTED = new Set([".txt", ".md", ".csv"]);

export function tokenize(text) {
  const tokens = [];
  const lower = String(text).toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9._\-]*/g)) tokens.push(m[0]);
  const cjk = lower.replace(/[^一-鿿]+/g, " ");
  for (const seg of cjk.split(" ")) {
    if (!seg) continue;
    for (let i = 0; i < seg.length; i++) {
      tokens.push(seg[i]);
      if (i + 1 < seg.length) tokens.push(seg.slice(i, i + 2));
    }
  }
  return tokens;
}

export function chunkText(text, size = 800) {
  const paras = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let cur = "";
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ""; };
  for (const p of paras.length ? paras : [String(text)]) {
    if ((cur + "\n" + p).length > size && cur) push();
    if (p.length > size) {
      push();
      for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size));
    } else {
      cur = cur ? cur + "\n" + p : p;
    }
  }
  push();
  return chunks;
}

function walk(dir, base, out) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile() && SUPPORTED.has(extname(e.name).toLowerCase())) out.push({ full, rel: relative(base, full) });
  }
  return out;
}

export class KnowledgeBase {
  constructor({ folder = "", indexPath, logger } = {}) {
    this.folder = folder;
    this.indexPath = indexPath;
    this.logger = logger;
    this.chunks = []; // {id, file, idx, text, tf:Map, len}
    this.manifest = {}; // rel -> {mtimeMs, size}
    this.updatedAt = null;
    this.loadIndex();
  }
  setFolder(folder) { this.folder = folder ?? ""; }
  loadIndex() {
    if (this.indexPath && existsSync(this.indexPath)) {
      try {
        const d = JSON.parse(readFileSync(this.indexPath, "utf8"));
        if (d.folder === this.folder) {
          this.manifest = d.manifest ?? {};
          this.chunks = (d.chunks ?? []).map((c) => ({ ...c }));
          this.rebuildStats();
          this.updatedAt = d.updatedAt ?? null;
        }
      } catch {}
    }
  }
  rebuildStats() {
    this.df = new Map();
    let totalLen = 0;
    for (const c of this.chunks) {
      c.tf = new Map();
      const toks = tokenize(c.text);
      c.len = toks.length;
      totalLen += c.len;
      for (const t of toks) c.tf.set(t, (c.tf.get(t) ?? 0) + 1);
      for (const t of c.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = this.chunks.length ? totalLen / this.chunks.length : 0;
  }
  saveIndex() {
    if (!this.indexPath) return;
    mkdirSync(dirname(this.indexPath), { recursive: true });
    const data = {
      folder: this.folder,
      manifest: this.manifest,
      updatedAt: this.updatedAt,
      chunks: this.chunks.map((c) => ({ id: c.id, file: c.file, idx: c.idx, text: c.text })),
    };
    writeFileSync(this.indexPath, JSON.stringify(data), { mode: 0o600 });
  }
  // 掃描資料夾 (唯讀); force=true 全部重建, 否則只重建異動檔案。回傳狀態。
  scan({ force = false } = {}) {
    const started = Date.now();
    if (!this.folder || !existsSync(this.folder)) {
      this.chunks = []; this.manifest = {}; this.rebuildStats();
      this.logger?.warn("知識庫", "資料夾未設定或不存在, 知識庫為空", { folder: this.folder || "(未設定)" });
      return this.status();
    }
    const files = walk(this.folder, this.folder, []);
    const seen = new Set();
    let changed = 0;
    for (const f of files) {
      seen.add(f.rel);
      const st = statSync(f.full);
      const prev = this.manifest[f.rel];
      if (force || !prev || prev.mtimeMs !== st.mtimeMs || prev.size !== st.size) {
        changed++;
        this.chunks = this.chunks.filter((c) => c.file !== f.rel);
        const raw = readFileSync(f.full, "utf8");
        const parts = chunkText(raw);
        parts.forEach((text, i) => this.chunks.push({ id: `${f.rel}#${i + 1}`, file: f.rel, idx: i + 1, text }));
        this.manifest[f.rel] = { mtimeMs: st.mtimeMs, size: st.size };
      }
    }
    for (const rel of Object.keys(this.manifest)) {
      if (!seen.has(rel)) { delete this.manifest[rel]; this.chunks = this.chunks.filter((c) => c.file !== rel); changed++; }
    }
    this.chunks.forEach((c, i) => { c.id = c.id || `${c.file}#${c.idx}`; c.seq = i; });
    this.rebuildStats();
    this.updatedAt = new Date().toISOString();
    this.saveIndex();
    const s = this.status();
    this.logger?.info("知識庫", "索引掃描完成", { files: s.files, chunks: s.chunks, changed, ms: Date.now() - started });
    return s;
  }
  search(query, topN = 3) {
    const q = [...new Set(tokenize(query))];
    if (!q.length || !this.chunks.length) return [];
    const N = this.chunks.length;
    const k1 = 1.5, b = 0.75;
    const scored = [];
    for (const c of this.chunks) {
      let score = 0;
      let strong = 0; // 命中的雙字詞/英文詞數量 (單字詞太常見, 不計)
      for (const t of q) {
        const tf = c.tf.get(t);
        if (!tf) continue;
        if (t.length >= 2) strong++;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * c.len) / (this.avgLen || 1))));
      }
      if (score > 0) scored.push({ file: c.file, chunkId: c.id, score: Number(score.toFixed(3)), text: c.text, strong });
    }
    scored.sort((a, b2) => b2.score - a.score);
    // 門檻: 分數夠高且至少兩個實質關鍵詞命中, 避免只因「公司」這種常見詞就誤判命中
    return scored.filter((s) => s.score >= 1.2 && s.strong >= 2).map(({ strong, ...rest }) => rest).slice(0, topN);
  }
  status() {
    return { folder: this.folder, files: Object.keys(this.manifest).length, chunks: this.chunks.length, updatedAt: this.updatedAt, ready: this.chunks.length > 0 };
  }
}
