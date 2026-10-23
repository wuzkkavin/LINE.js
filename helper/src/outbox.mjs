// 待發清單 + 發送紀錄 (規格: 發送群組訊息頁的下方兩個清單)。
// 為什麼獨立成模組: 排程的資料與規則 (驗證、算下一次時間、逐項成敗) 與「實際送出」分開——
// 送出由 App 殼 (瀏覽器通道) 負責 (2026-10-22 拍板, 見根目錄施工紀錄), 本模組只管存放與規則,
// 這樣規則可以不連 LINE 就完整單元測試, 殼只負責計時與呼叫送出後把結果寫回來。
// 存放: data 目錄下的 outbox.json (比照 msgregistry 的 JSON 落盤模式, 寫入用 0600)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export const OUTBOX_TEXT_MAX = 8000; // 與核心 textMaxLength 一致 (src/config.ts)
export const OUTBOX_IMAGE_MAX_BYTES = 10 * 1024 * 1024; // 規格第一版上限; 圖片走 /media/upload 本來也是 10MB
export const OUTBOX_FILE_MAX_BYTES = 10 * 1024 * 1024; // 規格第一版自訂上限; LINE 伺服器真上限未驗證 (施工紀錄第二階段)

const WEEK_MS = 7 * 24 * 3600 * 1000;

// 這一次實際要發的內容: 頻率「依序發下一份」時是 seriesItems[seriesIndex] 那一份,
// 其他情況就是 entry.items 本身。送出端 (App 殼) 與結果判定都以這份為準, 兩邊才不會對不起來。
export function effectiveItems(entry) {
  if (entry?.schedule?.mode === "repeat" && entry?.schedule?.repeat?.kind === "series" && Array.isArray(entry?.seriesItems) && entry.seriesItems.length) {
    const idx = Math.min(Math.max(entry.seriesIndex ?? 0, 0), entry.seriesItems.length - 1);
    return entry.seriesItems[idx] ?? {};
  }
  return entry?.items ?? {};
}

// 把 entry 的內容攤平成逐項清單 (文字最多一項、圖片/檔案逐檔一項), 逐項成敗與重送都以這個順序為準。
export function flattenItems(entry) {
  const out = [];
  const items = effectiveItems(entry);
  if (typeof items.text === "string" && items.text) out.push({ kind: "text", label: "文字" });
  for (const im of items.images ?? []) out.push({ kind: "image", label: im.name || "圖片" });
  for (const f of items.files ?? []) out.push({ kind: "file", label: f.name || "檔案" });
  return out;
}

function checkMediaList(list, maxBytes, kindLabel, errors) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) { errors.push(`${kindLabel}清單格式不正確`); return []; }
  const out = [];
  for (const it of list) {
    const name = typeof it?.name === "string" ? it.name.trim() : "";
    const sizeBytes = Number(it?.sizeBytes);
    if (!name) { errors.push(`${kindLabel}缺少檔名`); continue; }
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) { errors.push(`${kindLabel}「${name}」缺少大小資訊`); continue; }
    if (sizeBytes > maxBytes) { errors.push(`${kindLabel}「${name}」超過上限 ${Math.round(maxBytes / 1024 / 1024)}MB`); continue; }
    out.push({ name, sizeBytes, ref: typeof it?.ref === "string" ? it.ref : "" });
  }
  return out;
}

// 驗證並正規化一筆待發內容; 回 { ok, errors(白話), value }。chatId 只檢查形狀有值, 白名單歸屬在送出時由核心擋 (UNKNOWN_CHAT)。
export function validateOutboxInput(input) {
  const errors = [];
  const chatId = typeof input?.chatId === "string" ? input.chatId.trim() : "";
  const chatName = typeof input?.chatName === "string" ? input.chatName.trim() : "";
  if (!chatId) errors.push("尚未選群組");
  const src = input?.items ?? {};
  let text = "";
  if (src.text !== undefined) {
    if (typeof src.text !== "string") errors.push("文字內容格式不正確");
    else {
      text = src.text;
      if (text.length > OUTBOX_TEXT_MAX) errors.push(`文字超過上限 ${OUTBOX_TEXT_MAX} 字`);
    }
  }
  const images = checkMediaList(src.images, OUTBOX_IMAGE_MAX_BYTES, "圖片", errors);
  const files = checkMediaList(src.files, OUTBOX_FILE_MAX_BYTES, "檔案", errors);
  if (!text && images.length === 0 && files.length === 0 && errors.length === 0) errors.push("尚未選任何內容");

  const sch = input?.schedule ?? { mode: "now" };
  const schedule = { mode: ["now", "once", "repeat"].includes(sch.mode) ? sch.mode : "now" };
  if (schedule.mode === "once") {
    const at = Date.parse(sch.at ?? "");
    if (!Number.isFinite(at)) errors.push("排程時間不正確");
    else schedule.at = new Date(at).toISOString();
  }
  if (schedule.mode === "repeat") {
    const r = sch.repeat ?? {};
    const rep = {
      kind: r.kind === "series" ? "series" : "same",
      cycle: ["daily", "weekly", "monthly"].includes(r.cycle) ? r.cycle : "daily",
      time: /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time ?? "") ? r.time : "09:00",
      weekdays: Array.isArray(r.weekdays) ? [...new Set(r.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [],
      monthDay: Number.isInteger(r.monthDay) && r.monthDay >= 1 && r.monthDay <= 31 ? r.monthDay : 1,
      endDate: /^\d{4}-\d{2}-\d{2}$/.test(r.endDate ?? "") ? r.endDate : "",
      maxCount: Number.isInteger(r.maxCount) && r.maxCount > 0 ? r.maxCount : 0,
    };
    if (rep.cycle === "weekly" && rep.weekdays.length === 0) errors.push("每週重複要至少勾一天");
    schedule.repeat = rep;
    if (rep.kind === "series") {
      // 依序發下一份: 每一份是一個獨立條目 (seriesItems), 逐次往下輪; 單一 entry 的 items 是第 1 份的預覽不算數
      if (!Array.isArray(input?.seriesItems) || input.seriesItems.length === 0) errors.push("依序發送要先排好整套內容");
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    value: {
      chatId, chatName,
      items: { ...(text ? { text } : {}), images, files },
      schedule,
      seriesItems: schedule.mode === "repeat" && schedule.repeat.kind === "series" ? input.seriesItems : undefined,
    },
  };
}

function atTime(date, hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d;
}

// 算下一次要發的時間 (ms); 沒有下一次 (結束條件到/系列發完) 回 null。fromMs 之後 (含同一分鐘) 的第一個符合時間。
// sentCount / seriesIndex 由 entry 帶入, 結束條件: endDate (含當天) 之後不發、maxCount 達標不發、series 超出份數不發。
export function computeNextRun(schedule, fromMs, { sentCount = 0, seriesIndex = 0, seriesTotal = 0 } = {}) {
  if (!schedule) return null;
  if (schedule.mode === "now") return fromMs;
  if (schedule.mode === "once") {
    const at = Date.parse(schedule.at ?? "");
    return Number.isFinite(at) ? at : null;
  }
  const rep = schedule.repeat ?? {};
  if (rep.maxCount && sentCount >= rep.maxCount) return null;
  if (rep.kind === "series" && seriesTotal > 0 && seriesIndex >= seriesTotal) return null;
  const from = new Date(fromMs);
  for (let add = 0; add < 400; add++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + add);
    let ok = false;
    if (rep.cycle === "daily") ok = true;
    else if (rep.cycle === "weekly") ok = (rep.weekdays ?? []).includes(day.getDay());
    else if (rep.cycle === "monthly") {
      // 每月只在設定的那一天成立; 設 31 號但該月只有 30 天時, 以該月最後一天為準 (不然該月會整月跳過)
      const lastDay = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
      ok = day.getDate() === Math.min(rep.monthDay || 1, lastDay);
    }
    if (!ok) continue;
    const cand = atTime(day, rep.time || "09:00");
    if (cand.getTime() < fromMs) continue;
    if (rep.endDate && cand.getTime() > Date.parse(rep.endDate + "T23:59:59.999")) return null;
    return cand.getTime();
  }
  return null;
}

export class OutboxStore {
  constructor({ path = "", now = () => Date.now(), logger } = {}) {
    this.path = path;
    this.now = now;
    this.logger = logger;
    this.entries = [];
    this.load();
  }
  load() {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      this.entries = Array.isArray(raw?.entries) ? raw.entries : [];
    } catch (e) {
      this.logger?.warn("待發清單", "待發清單讀取失敗, 以空白重新開始", { error: String(e?.message ?? e) });
      this.entries = [];
    }
  }
  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify({ version: 1, entries: this.entries }, null, 2), { mode: 0o600 });
  }
  create(input) {
    const v = validateOutboxInput(input);
    if (!v.ok) return v;
    const ts = this.now();
    const entry = {
      id: randomUUID(),
      ...v.value,
      status: "pending",
      sentCount: 0,
      seriesIndex: 0,
      itemResults: [],
      history: [{ ts, note: "已建立" }],
      createdAt: ts,
      updatedAt: ts,
    };
    entry.nextRunAt = computeNextRun(entry.schedule, ts, entry);
    this.entries.unshift(entry);
    this.save();
    return { ok: true, entry };
  }
  update(id, patch) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return { ok: false, errors: ["找不到這筆待發"] };
    if (entry.status !== "pending" && entry.status !== "paused") return { ok: false, errors: ["這筆已經處理完, 不能再改"] };
    const merged = { chatId: entry.chatId, chatName: entry.chatName, items: entry.items, schedule: entry.schedule, seriesItems: entry.seriesItems, ...(patch ?? {}) };
    const v = validateOutboxInput(merged);
    if (!v.ok) return v;
    Object.assign(entry, v.value, { updatedAt: this.now() });
    entry.nextRunAt = computeNextRun(entry.schedule, this.now(), entry);
    entry.history.push({ ts: this.now(), note: "已修改" });
    this.save();
    return { ok: true, entry };
  }
  cancel(id) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return { ok: false, errors: ["找不到這筆待發"] };
    entry.status = "cancelled";
    entry.updatedAt = this.now();
    entry.history.push({ ts: this.now(), note: "已取消" });
    this.save();
    return { ok: true, entry };
  }
  // 暫停/恢復。reason 記「為什麼暫停」: "decrypt" = 鑰匙（解密）異常被護欄自動暫停,
  // 這種暫停在鑰匙恢復正常後由執行端自動恢復; 其他（人工在畫面按的）一律 "manual",
  // 絕不自動恢復。舊資料沒有 pauseReason 欄位, 視為 manual（不自動動它）。
  setPaused(id, paused, note = "", reason = "") {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return { ok: false, errors: ["找不到這筆待發"] };
    entry.status = paused ? "paused" : "pending";
    entry.pauseReason = paused ? (reason || "manual") : "";
    entry.updatedAt = this.now();
    entry.history.push({ ts: this.now(), note: note || (paused ? "已暫停" : "已恢復") });
    this.save();
    return { ok: true, entry };
  }
  // 送出結果寫回: results 與 flattenItems(entry) 同序, 每項 { ok, note }。回傳彙總後的 entry。
  recordResult(id, results, { note = "" } = {}) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return { ok: false, errors: ["找不到這筆待發"] };
    entry.itemResults = Array.isArray(results) ? results : [];
    const flat = flattenItems(entry);
    const allOk = flat.length > 0 && entry.itemResults.length >= flat.length && entry.itemResults.slice(0, flat.length).every((r) => r?.ok);
    const anyOk = entry.itemResults.some((r) => r?.ok);
    entry.sentCount += 1;
    entry.updatedAt = this.now();
    if (entry.schedule.mode === "repeat") {
      if (entry.schedule.repeat?.kind === "series") entry.seriesIndex += 1;
      const seriesTotal = Array.isArray(entry.seriesItems) ? entry.seriesItems.length : 0;
      entry.nextRunAt = allOk || anyOk ? computeNextRun(entry.schedule, this.now() + 1000, { ...entry, seriesTotal }) : entry.nextRunAt;
      entry.status = entry.nextRunAt ? "pending" : "done";
    } else {
      entry.status = allOk ? "sent" : anyOk ? "partial" : "failed";
      entry.nextRunAt = null;
    }
    entry.history.push({ ts: this.now(), note: note || (entry.status === "sent" || entry.status === "done" ? "已送出" : entry.status === "partial" ? "部分送出" : entry.status === "pending" ? "已送出, 等待下一次" : "送出失敗") });
    this.save();
    return { ok: true, entry };
  }
  // 順延 (護欄: 有人剛進群的鑰匙交接窗口不要發, 撞上就把時間往後推並註明原因)。
  // 只改 nextRunAt, 不動排程本身; 恢復後照原排程繼續算下一次。
  defer(id, nextRunAtMs, note = "") {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return { ok: false, errors: ["找不到這筆待發"] };
    if (entry.status !== "pending") return { ok: false, errors: ["這筆不是待發狀態, 不能順延"] };
    if (!Number.isFinite(nextRunAtMs)) return { ok: false, errors: ["順延時間不正確"] };
    entry.nextRunAt = nextRunAtMs;
    entry.updatedAt = this.now();
    entry.history.push({ ts: this.now(), note: note || "已順延" });
    this.save();
    return { ok: true, entry };
  }
  // 程式沒開時錯過的「重複發」那一次: 不補發 (補發會讓提醒/課程在錯誤的時間連珠炮),
  // 直接跳過並算出下一次, 紀錄註明。一次性/立即的不走這裡 (它們要問使用者要不要補發)。
  skipMissed(id, note = "") {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return { ok: false, errors: ["找不到這筆待發"] };
    if (entry.status !== "pending" || entry.schedule.mode !== "repeat") return { ok: false, errors: ["只有重複發的待發可以跳過錯過的那一次"] };
    const seriesTotal = Array.isArray(entry.seriesItems) ? entry.seriesItems.length : 0;
    entry.nextRunAt = computeNextRun(entry.schedule, this.now() + 1000, { ...entry, seriesTotal });
    entry.status = entry.nextRunAt ? "pending" : "done";
    entry.updatedAt = this.now();
    entry.history.push({ ts: this.now(), note: note || "程式沒開的時候錯過了這一次, 已跳過, 下一次照常" });
    this.save();
    return { ok: true, entry };
  }
  // 失敗項目重送後的結果寫回: results 是「合併後」的完整逐項結果 (與 flattenItems 同序),
  // 與 recordResult 不同: 不算新的一次發送 (不加 sentCount、不推進系列/下一次時間),
  // 只更新這一次的成敗狀態 — 不然重送一次, 課程就會跳過一課、次數上限也會被多扣。
  recordRetryResult(id, results, { note = "" } = {}) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return { ok: false, errors: ["找不到這筆待發"] };
    if (entry.status === "pending" && entry.schedule.mode === "repeat") {
      // 重複發的那一次已由 recordResult 推進完畢, 狀態回到 pending 等下一次; 這時合併的是「上一次」的結果, 狀態不動
    } else if (!["partial", "failed"].includes(entry.status) && entry.status !== "pending") {
      return { ok: false, errors: ["這筆沒有可重送的結果"] };
    }
    entry.itemResults = Array.isArray(results) ? results : [];
    const flat = flattenItems(entry);
    const allOk = flat.length > 0 && entry.itemResults.length >= flat.length && entry.itemResults.slice(0, flat.length).every((r) => r?.ok);
    const anyOk = entry.itemResults.some((r) => r?.ok);
    if (entry.schedule.mode !== "repeat") {
      entry.status = allOk ? "sent" : anyOk ? "partial" : "failed";
    }
    entry.updatedAt = this.now();
    entry.history.push({ ts: this.now(), note: note || (allOk ? "重送完成, 全部送出" : "已重送失敗的項目") });
    this.save();
    return { ok: true, entry };
  }
  // 清單 (新到舊) + 衍生標記: 一次性排程已過期未發 -> overdue (等使用者確認補發, 不自動發)
  list() {
    const nowMs = this.now();
    return this.entries.map((e) => {
      const overdue = e.status === "pending" && e.schedule.mode === "once" && typeof e.nextRunAt === "number" && e.nextRunAt < nowMs;
      return { ...e, overdue };
    });
  }
}

export { WEEK_MS };
