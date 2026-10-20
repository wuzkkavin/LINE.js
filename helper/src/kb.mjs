// 知識庫: 指定資料夾唯讀掃描 (.txt/.md/.csv), 切段約 800 字, BM25 關鍵字索引, 索引存資料夾外。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";

const SUPPORTED = new Set([".txt", ".md", ".csv"]);

// 檔案數超過這個量就提醒使用者改用專用小資料夾 (只提醒、不阻擋)
export const KB_LARGE_FOLDER_FILES = 2000;

// 讓出事件迴圈一輪: 長掃描靠它分段進行, 不把 WS 訊息處理與其他 API 一起卡死
const yieldLoop = () => new Promise((r) => setImmediate(r));

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
    this.statsStale = false; // 索引剛載入但詞頻未齊 (舊格式索引) 時為真, 掃描補算完才開放搜尋
    this.scanning = false; // 是否有掃描進行中 (狀態顯示用; 掃描期間舊索引照常服務搜尋)
    this.scanPromise = null; // 進行中的掃描 (同時只跑一個, 後到的請求排隊補做一次)
    this.scanQueuedForce = null;
    this.loadIndex();
  }
  setFolder(folder) { this.folder = folder ?? ""; }
  loadIndex() {
    if (this.indexPath && existsSync(this.indexPath)) {
      try {
        const d = JSON.parse(readFileSync(this.indexPath, "utf8"));
        if (d.folder === this.folder) {
          this.manifest = d.manifest ?? {};
          // tf (詞頻) 有存就還原: 開機不必對整本索引重跑 tokenize (10 萬段要數十秒,
          // 那段時間 helper 還沒 listen, 殼會以為引擎沒起來 — 2026-10-20 競態的一環)。
          // 舊版索引沒有 tf 的片段標記 statsStale, 等背景掃描補算完才開放搜尋, 不拿半套統計亂答。
          this.chunks = (d.chunks ?? []).map((c) => ({
            id: c.id, file: c.file, idx: c.idx, text: c.text,
            ...(Array.isArray(c.tf) ? { tf: new Map(c.tf), len: c.len ?? 0 } : {}),
          }));
          this.statsStale = this.chunks.some((c) => !c.tf);
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
      if (!c.tf) {
        c.tf = new Map();
        const toks = tokenize(c.text);
        c.len = toks.length;
        for (const t of toks) c.tf.set(t, (c.tf.get(t) ?? 0) + 1);
      }
      totalLen += c.len ?? 0;
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
      // tf/len 一併存: 下次開機直接還原統計, 不重跑 tokenize (理由見 loadIndex)
      chunks: this.chunks.map((c) => ({ id: c.id, file: c.file, idx: c.idx, text: c.text, len: c.len ?? null, tf: c.tf ? [...c.tf] : null })),
    };
    writeFileSync(this.indexPath, JSON.stringify(data), { mode: 0o600 });
  }
  // 只數檔案不讀內容 (設定資料夾時估量用; 純目錄走訪, 快)。
  countSupportedFiles() {
    if (!this.folder || !existsSync(this.folder)) return 0;
    return walk(this.folder, this.folder, []).length;
  }

  // 非同步分段統計: 與 rebuildStats 相同的 BM25 統計, 但每 500 段讓出事件迴圈一次。
  // 為什麼要分段: 110k 段的 tokenize 在舊版同步跑完要 100+ 秒, 期間整個 helper 事件迴圈
  // 卡死 — WS 訊息不處理、/api/settings 回不了, UI 全滅 (2026-10-20 老吳實機定案之二)。
  async buildStatsAsync(chunks) {
    const df = new Map();
    let totalLen = 0;
    let i = 0;
    for (const c of chunks) {
      if (!c.tf) { // 已有 tf 的片段 (未異動沿用/索引還原) 不重算, 只做 df 彙總
        c.tf = new Map();
        const toks = tokenize(c.text);
        c.len = toks.length;
        for (const t of toks) c.tf.set(t, (c.tf.get(t) ?? 0) + 1);
      }
      totalLen += c.len ?? 0;
      for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
      if (++i % 500 === 0) await yieldLoop();
    }
    return { df, avgLen: chunks.length ? totalLen / chunks.length : 0 };
  }

  // 掃描資料夾 (唯讀); force=true 全部重建, 否則只重建異動檔案。回傳狀態 (Promise)。
  // 非同步分段執行: 掃描期間週期性讓出事件迴圈, 其他 API 與 WS 照常運作;
  // 索引在掃描完成時才整批換上, 掃描期間搜尋續用舊索引, 不會查到一半的資料。
  // 同時只跑一個掃描; 進行中又被要求掃描時, 記下需求、等這輪結束再補做一次。
  async scan({ force = false } = {}) {
    if (this.scanPromise) {
      this.scanQueuedForce = (this.scanQueuedForce ?? false) || force;
      return this.scanPromise;
    }
    const run = (async () => {
      let nextForce = force;
      for (;;) {
        await this.scanOnce({ force: nextForce });
        if (this.scanQueuedForce === null) break;
        nextForce = this.scanQueuedForce;
        this.scanQueuedForce = null;
      }
      return this.status();
    })();
    this.scanPromise = run;
    try { return await run; } finally { if (this.scanPromise === run) this.scanPromise = null; }
  }

  async scanOnce({ force = false } = {}) {
    const started = Date.now();
    this.scanning = true;
    try {
      if (!this.folder || !existsSync(this.folder)) {
        this.chunks = []; this.manifest = {}; this.rebuildStats();
        this.logger?.warn("知識庫", "資料夾未設定或不存在, 知識庫為空", { folder: this.folder || "(未設定)" });
        return;
      }
      const files = walk(this.folder, this.folder, []);
      const seen = new Set();
      let changed = 0;
      // 未異動檔案沿用既有片段 (不重讀不重切); 異動的才讀檔切段。組裝成新陣列, 最後一次換上。
      const keptByFile = new Map();
      for (const c of this.chunks) {
        const arr = keptByFile.get(c.file);
        if (arr) arr.push(c); else keptByFile.set(c.file, [c]);
      }
      const nextChunks = [];
      const nextManifest = {};
      let i = 0;
      for (const f of files) {
        seen.add(f.rel);
        const st = statSync(f.full);
        const prev = this.manifest[f.rel];
        if (!force && prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && keptByFile.has(f.rel)) {
          nextChunks.push(...keptByFile.get(f.rel));
          nextManifest[f.rel] = prev;
        } else {
          changed++;
          const raw = readFileSync(f.full, "utf8");
          const parts = chunkText(raw);
          parts.forEach((text, j) => nextChunks.push({ id: `${f.rel}#${j + 1}`, file: f.rel, idx: j + 1, text }));
          nextManifest[f.rel] = { mtimeMs: st.mtimeMs, size: st.size };
        }
        if (++i % 8 === 0) await yieldLoop(); // 每 8 個檔案讓出一次, 讀檔切段不連續霸佔
      }
      for (const rel of Object.keys(this.manifest)) {
        if (!seen.has(rel)) changed++;
      }
      nextChunks.forEach((c, j) => { c.id = c.id || `${c.file}#${c.idx}`; c.seq = j; });
      const stats = await this.buildStatsAsync(nextChunks);
      this.chunks = nextChunks;
      this.manifest = nextManifest;
      this.df = stats.df;
      this.avgLen = stats.avgLen;
      this.statsStale = false;
      this.updatedAt = new Date().toISOString();
      this.saveIndex();
      const s = this.status();
      this.logger?.info("知識庫", "索引掃描完成", { files: s.files, chunks: s.chunks, changed, ms: Date.now() - started });
    } finally {
      this.scanning = false;
    }
  }
  search(query, topN = 3) {
    // 統計未補算完 (舊索引剛載入) 時不搜尋: 半套 df 算出的分數會誤判命中/未命中
    if (this.statsStale) return [];
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
    const files = Object.keys(this.manifest).length;
    return {
      folder: this.folder,
      files,
      chunks: this.chunks.length,
      updatedAt: this.updatedAt,
      ready: this.chunks.length > 0,
      scanning: this.scanning,
      // 檔案異常多 (例如誤把整個文件庫根目錄設進來): UI 顯示白話提醒, 建議改用專用小資料夾
      largeFolder: files > KB_LARGE_FOLDER_FILES,
    };
  }
}
