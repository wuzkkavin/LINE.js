// 訊息寄件者登記簿: messageId -> senderId。
// 為什麼需要: 核心送到 helper 的訊息只帶 replyTo (被引用訊息的 ID), 不帶被引用訊息的寄件者,
// 所以「引用的是不是機器人自己發的訊息」必須靠 ID 對照一本登記簿認定。
// 登記來源 (全部是核心合法送來的影格, 不向外猜測):
//   1. 收到的 message 影格: 每則都帶 senderId, 看到就登記 (含機器人自己被廣播回來的訊息)。
//   2. 自己送出後的 sent 影格: 核心回新訊息的 messageId, 當下登記為機器人本人。
//   3. history:fetch 查回的歷史訊息: 補登記連線前就存在的訊息 (bot 的 lookupQuotedSender 呼叫)。
// 持久化: 存成 data 目錄下的 JSON, 程序重啟後仍認得先前的回答; 條目有保存期限 (預設 30 天)
// 與數量上限 (預設 10000 筆), 過期或超量自動清除最舊的。
// 上限調高理由 (2026-10-20 修復批次一, 第 6 項): 舊值 2000 筆 / 7 天在熱鬧群組裡幾天就被新訊息擠掉,
// 機器人稍早的回答被擠出登記簿後, 同事引用它追問就認不出來、續答失效; 10000 筆 / 30 天涵蓋一般公司群組
// 約一個月的訊息量, 檔案大小仍在可控範圍 (每筆約百餘 bytes, 全滿約 1-2 MB)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class MessageSenderRegistry {
  constructor({ path = "", maxEntries = 10000, ttlMs = 30 * 24 * 3600 * 1000, saveIntervalMs = 5000, now = () => Date.now(), logger } = {}) {
    this.path = path;
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.saveIntervalMs = saveIntervalMs;
    this.now = now;
    this.logger = logger;
    this.map = new Map(); // messageId -> { senderId, channelId, ts }; senderId "" 表示查過但查無此訊息
    this.dirty = false;
    this.lastSaveAt = 0;
    this.load();
  }

  load() {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      const entries = Array.isArray(raw?.entries) ? raw.entries : [];
      for (const [id, senderId, channelId, ts] of entries) {
        if (typeof id === "string" && typeof senderId === "string" && typeof ts === "number") {
          this.map.set(id, { senderId, channelId: typeof channelId === "string" ? channelId : "", ts });
        }
      }
      this.prune();
    } catch (e) {
      this.logger?.warn("訊息登記簿", "登記簿讀取失敗, 以空白重新開始", { error: String(e?.message ?? e) });
      this.map.clear();
    }
  }

  register(messageId, senderId, channelId = "") {
    if (!messageId || typeof senderId !== "string") return;
    this.map.set(String(messageId), { senderId, channelId: typeof channelId === "string" ? channelId : "", ts: this.now() });
    this.dirty = true;
    if (this.map.size > this.maxEntries) this.prune();
    this.maybeSave();
  }

  // 回傳 senderId ("" = 查過但查無此訊息); undefined = 沒登記過或已過期。
  // 分群隔離 (2026-10-23 稽核修復, 老吳「分群組記憶」明令): 呼叫端有給 channelId 時,
  // 登記時已記下聊天室的條目只有在「同一個聊天室」被查才算數 — 在 A 群登記的訊息,
  // 拿去 B 群查要視同沒登記過, 引用續答不得跨群解析。登記時聊天室不明 ("") 的條目
  // 無法證明屬於哪一群, 維持可查 (sent 影格本來就不帶聊天室, 但 bot 送出時已另記
  // requestId->chatId, 見 bot.onFrame 的 sent 分支; 即時訊息影格也會以正確聊天室覆寫)。
  lookup(messageId, channelId = "") {
    if (!messageId) return undefined;
    const hit = this.map.get(String(messageId));
    if (!hit) return undefined;
    if (this.now() - hit.ts > this.ttlMs) { this.map.delete(String(messageId)); return undefined; }
    if (channelId && hit.channelId && hit.channelId !== channelId) return undefined;
    return hit.senderId;
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, e] of this.map) if (e.ts < cutoff) this.map.delete(id);
    if (this.map.size > this.maxEntries) {
      const sorted = [...this.map.entries()].sort((a, b) => a[1].ts - b[1].ts);
      for (const [id] of sorted.slice(0, this.map.size - this.maxEntries)) this.map.delete(id);
    }
  }

  maybeSave() {
    if (!this.path || !this.dirty) return;
    if (this.now() - this.lastSaveAt < this.saveIntervalMs) return;
    this.save();
  }

  save() {
    if (!this.path) return;
    try {
      this.prune();
      const entries = [...this.map.entries()].map(([id, e]) => [id, e.senderId, e.channelId, e.ts]);
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify({ version: 1, entries }), "utf8");
      this.dirty = false;
      this.lastSaveAt = this.now();
    } catch (e) {
      this.logger?.warn("訊息登記簿", "登記簿寫入失敗", { error: String(e?.message ?? e) });
    }
  }

  flush() { if (this.dirty) this.save(); }
  get size() { return this.map.size; }
}
