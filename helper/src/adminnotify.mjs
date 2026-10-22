// 管理員通知: 設定形狀、事件決策與事件紀錄 (規格: 功能二)。
// 分工: 本模組只做「要不要通知、通知誰、用 @ 還是純文字點名、節流」這些可離線驗證的決策與紀錄;
// 實際把通知訊息送進群組由 App 殼執行 (2026-10-22 拍板, 排程/通知共用瀏覽器通道), 送出結果再寫回紀錄。
// 節流規則 (規格定版): 同種類+同聊天室 10 分鐘只通知一次; 每日最多通知 20 次; 超過的合併進紀錄, 不再 @。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const NOTIFY_EVENT_KINDS = {
  scam: { label: "詐騙警報" },
  unanswered: { label: "AI寶 答不出來" },
  keyword: { label: "有人提到關鍵字" },
  selfError: { label: "AI寶 自己出狀況" },
};

export const NOTIFY_THROTTLE_MS = 10 * 60 * 1000;
export const NOTIFY_DAILY_CAP = 20;

// 設定形狀驗證: admins=[{id,name}], rules=[{id,kind,keyword,notifyAdminIds,enabled}]
export function validateNotifySettings(notify) {
  const errors = [];
  const admins = [];
  for (const a of notify?.admins ?? []) {
    const id = typeof a?.id === "string" ? a.id.trim() : "";
    const name = typeof a?.name === "string" ? a.name.trim() : "";
    if (!id || !name) { errors.push("管理員名單有一筆缺帳號或名字"); continue; }
    admins.push({ id, name });
  }
  const rules = [];
  for (const r of notify?.rules ?? []) {
    const kind = typeof r?.kind === "string" ? r.kind : "";
    if (!NOTIFY_EVENT_KINDS[kind]) { errors.push("通知事件有一筆種類不正確"); continue; }
    const keyword = kind === "keyword" ? (typeof r.keyword === "string" ? r.keyword.trim() : "") : "";
    if (kind === "keyword" && !keyword) { errors.push("「有人提到關鍵字」的規則要填關鍵字"); continue; }
    rules.push({
      id: typeof r.id === "string" && r.id ? r.id : randomUUID(),
      kind,
      keyword,
      notifyAdminIds: Array.isArray(r.notifyAdminIds) ? r.notifyAdminIds.filter((x) => typeof x === "string") : [],
      enabled: r.enabled !== false,
    });
  }
  return { ok: errors.length === 0, errors, value: { admins, rules } };
}

// 依事件種類挑出有啟用、且符合的規則 (關鍵字種類還要訊息文字真的含關鍵字)。
// 事件來源 (bot) 只管「發生了什麼事」, 要不要通知、通知誰一律在這裡決策, 離線可測。
export function matchNotifyRules(notify, kind, { text = "" } = {}) {
  const rules = Array.isArray(notify?.rules) ? notify.rules : [];
  return rules.filter((r) => {
    if (!r || r.enabled === false || r.kind !== kind) return false;
    if (kind === "keyword") {
      const kw = typeof r.keyword === "string" ? r.keyword.trim() : "";
      if (!kw) return false;
      if (!String(text ?? "").includes(kw)) return false;
    }
    return true;
  });
}

// 依規則決定通知對象與方式。presence: { [adminId]: { inChat, hasSpoken } } (呼叫端由核心保留訊息/管理員查詢得知;
// 缺資料時預設可 @, 明確 false 才走退路——因為「沒查到」不等于「不在群」, 誤退路會讓通知失去 @ 效果)。
export function planTargets({ rule, admins, presence = {} }) {
  const wanted = new Set(rule?.notifyAdminIds ?? []);
  const targets = [];
  for (const a of admins ?? []) {
    if (wanted.size && !wanted.has(a.id)) continue;
    const p = presence[a.id];
    if (p && p.inChat === false) {
      targets.push({ adminId: a.id, name: a.name, mode: "plain", note: "該管理員不在此群，未能 @" });
    } else if (p && p.hasSpoken === false) {
      targets.push({ adminId: a.id, name: a.name, mode: "plain", note: "管理員還沒在這個群說過話，請先在群裡說一句話，之後就能被 @ 到" });
    } else {
      targets.push({ adminId: a.id, name: a.name, mode: "mention", note: "" });
    }
  }
  return targets;
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class AdminEventStore {
  constructor({ path = "", now = () => Date.now(), throttleMs = NOTIFY_THROTTLE_MS, dailyCap = NOTIFY_DAILY_CAP, logger } = {}) {
    this.path = path;
    this.now = now;
    this.throttleMs = throttleMs;
    this.dailyCap = dailyCap;
    this.logger = logger;
    this.events = [];
    this.load();
  }
  load() {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      this.events = Array.isArray(raw?.events) ? raw.events : [];
    } catch (e) {
      this.logger?.warn("管理員通知", "事件紀錄讀取失敗, 以空白重新開始", { error: String(e?.message ?? e) });
      this.events = [];
    }
  }
  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ version: 1, events: this.events.slice(0, 500) }, null, 2), { mode: 0o600 });
    this.events = this.events.slice(0, 500);
  }
  todayNotifyCount(ts = this.now()) {
    const key = dayKey(ts);
    return this.events.filter((e) => e.notified && dayKey(e.ts) === key).reduce((n, e) => n + 1, 0);
  }
  // 記一筆事件並決定要不要真的通知。message 是要送進群組的通知本文 (白話, 由事件來源組好);
  // 殼端送出時在本文前面加上 @管理員 的部分。回傳 { action: 'notify'|'record', reason, event }
  record({ kind, chatId, chatName = "", detail = "", targets = [], message = "" }) {
    if (!NOTIFY_EVENT_KINDS[kind]) return { action: "record", reason: "unknown-kind", event: null };
    const ts = this.now();
    const recent = this.events.find((e) => e.notified && e.kind === kind && e.chatId === chatId && ts - e.ts < this.throttleMs);
    if (recent) {
      recent.mergedCount = (recent.mergedCount ?? 0) + 1;
      recent.lastMergedAt = ts;
      this.save();
      return { action: "record", reason: "throttled", event: recent };
    }
    const event = {
      id: randomUUID(), ts, kind, kindLabel: NOTIFY_EVENT_KINDS[kind].label,
      chatId, chatName, detail, targets, message, notified: false, mergedCount: 0, note: "",
      sentAt: null, sentOk: null,
    };
    if (this.todayNotifyCount(ts) >= this.dailyCap) {
      event.note = "今天通知次數已達上限，只寫進紀錄";
      this.events.unshift(event);
      this.save();
      return { action: "record", reason: "daily-cap", event };
    }
    event.notified = true;
    this.events.unshift(event);
    this.save();
    return { action: "notify", reason: "", event };
  }
  // 殼端實際送出後把結果寫回來: 送成功/失敗都註明, 失敗原因只記白話分類 (見殼端 pagesend 的錯誤對照)。
  markSent(id, ok, note = "") {
    const event = this.events.find((e) => e.id === id);
    if (!event) return { ok: false, errors: ["找不到這筆通知紀錄"] };
    event.sentAt = this.now();
    event.sentOk = !!ok;
    if (note) event.note = event.note ? `${event.note}；${note}` : note;
    this.save();
    return { ok: true, event };
  }
  // 還沒送出的待通知 (殼端輪詢用): 有決定要通知、但還沒有送出結果的。
  pendingNotify() {
    return this.events.filter((e) => e.notified && e.sentAt == null);
  }
  list() { return [...this.events]; }
}
