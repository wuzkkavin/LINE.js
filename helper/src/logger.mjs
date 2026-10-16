// Logger: 每日一檔、保留 N 天、中文模組標籤、秘密遮罩。
// 紅線: 不記 API Key / Token / QR / PIN / session; 訊息全文只有除錯模式才記 (由呼叫端決定, 且須經 logText)。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const GENERIC_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer ***"],
  [/linejs_[A-Za-z0-9_\-]{8,}/g, "linejs_***"],
  [/sk-[A-Za-z0-9_\-]{8,}/g, "sk-***"],
  [/gsk_[A-Za-z0-9_\-]{8,}/g, "gsk_***"],
];

export class Logger {
  constructor({ dir, retentionDays = 14, debug = false, now = () => new Date() } = {}) {
    if (!dir) throw new Error("Logger 需要 dir");
    this.dir = dir;
    this.retentionDays = retentionDays;
    this.debug = !!debug;
    this.now = now;
    this.secrets = new Set();
    mkdirSync(dir, { recursive: true });
    this.cleanup();
    if (this.debug) this.line("WARN", "Log", "除錯模式開啟中: 本日 log 可能包含問題全文, 請勿外流");
  }
  addSecret(value) {
    if (typeof value === "string" && value.length >= 4) this.secrets.add(value);
  }
  redact(input) {
    let s = typeof input === "string" ? input : JSON.stringify(input ?? "");
    for (const secret of this.secrets) s = s.split(secret).join("***");
    for (const [re, rep] of GENERIC_PATTERNS) s = s.replace(re, rep);
    return s;
  }
  fileFor(date) {
    const d = date.toISOString().slice(0, 10);
    return join(this.dir, `helper-${d}.log`);
  }
  line(level, moduleName, event, detail) {
    const ts = this.now().toISOString();
    let text = `${ts} | ${level} | (${moduleName}) ${this.redact(event)}`;
    if (detail !== undefined) {
      const d = typeof detail === "string" ? detail : JSON.stringify(detail);
      text += ` | ${this.redact(d)}`;
    }
    appendFileSync(this.fileFor(this.now()), text + "\n", "utf8");
    return text;
  }
  info(m, e, d) { return this.line("INFO", m, e, d); }
  warn(m, e, d) { return this.line("WARN", m, e, d); }
  error(m, e, d) { return this.line("ERROR", m, e, d); }
  debugLog(m, e, d) { if (this.debug) return this.line("DEBUG", m, e, d); }
  // 訊息/問題全文: 一般模式只記長度, 除錯模式才記全文 (仍過遮罩)。
  logText(moduleName, label, text) {
    if (this.debug) return this.line("DEBUG", moduleName, `${label}全文`, String(text).slice(0, 2000));
    return this.line("INFO", moduleName, `${label}長度=${String(text ?? "").length}`);
  }
  cleanup() {
    const cutoff = Date.now() - this.retentionDays * 86400000;
    let names = [];
    try { names = readdirSync(this.dir); } catch { return; }
    for (const name of names) {
      const m = /^helper-(\d{4}-\d{2}-\d{2})\.log$/.exec(name);
      if (m && new Date(m[1] + "T00:00:00Z").getTime() < cutoff) {
        try { rmSync(join(this.dir, name)); } catch {}
      }
    }
  }
  readToday() {
    const f = this.fileFor(this.now());
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  }
  listFiles() {
    try { return readdirSync(this.dir).filter((n) => n.endsWith(".log")).sort(); } catch { return []; }
  }
}
