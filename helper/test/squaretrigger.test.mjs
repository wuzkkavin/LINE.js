// 社群群 (square / OpenChat, m 開頭) 模擬訊息完整觸發路徑 (2026-10-25 界面重整收尾驗證):
// 在社群聊天室叫名字提問 -> 觸發判斷命中 -> AI 回答 -> 送回同一個社群聊天室,
// 且沒叫名字的一般訊息不觸發。名字與帳號皆為測試虛構, 只證明機制, 不寫死任何真實身分。
// 不連真核心: 送出與 AI 皆以 stub 模擬, 驗的是 helper 內部的觸發路徑, 真群行為仍須真機驗收。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperBot } from "../src/bot.mjs";
import { SettingsStore, SECRET_NAMES } from "../src/config.mjs";
import { MemorySecretStore } from "../src/secrets.mjs";
import { AdminEventStore } from "../src/adminnotify.mjs";
import { Logger } from "../src/logger.mjs";

const SQUARE = `m${"b".repeat(32)}`;

test("社群群模擬訊息: 叫名字提問走完整觸發路徑回同一室, 沒叫名字不觸發", async () => {
  const dir = mkdtempSync(join(tmpdir(), "squaretrigger-"));
  try {
    const logger = new Logger({ dir: join(dir, "logs") });
    logger.logText = () => {};
    const settings = new SettingsStore({ path: join(dir, "settings.json"), logger });
    settings.update({ botName: "AI寶", scam: { enabled: false } });
    const secrets = new MemorySecretStore();
    await secrets.set(SECRET_NAMES.openai, "test-key-not-real");
    const adminEvents = new AdminEventStore({ path: join(dir, "admin-events.json"), logger });
    const ai = { chat: async () => ({ content: "模擬回答：這是社群群觸發路徑的測試回答。" }) };
    const bot = new HelperBot({
      settings, secrets, ai, kb: null, logger, adminEvents,
      whitelistReader: () => [SQUARE],
    });
    bot.selfId = "u-me-test";
    bot.botChats = [SQUARE];
    bot.chatNames.set(SQUARE, "模擬社群群");
    const sent = [];
    bot.sendText = async (chatId, text, replyTo) => { sent.push({ chatId, text, replyTo }); };
    await bot.onMessage({
      messageId: "sq-1", channelId: SQUARE, channelKind: "square",
      senderId: `p${"Q".repeat(20)}`, senderName: "社群測試員",
      text: "AI寶，請問怎麼設定自動登入？", contentType: "NONE", createdAt: Date.now(),
    });
    assert.equal(sent.length, 1, "叫名字提問必須回一則");
    assert.equal(sent[0].chatId, SQUARE, "回答必須送回同一個社群聊天室");
    assert.match(sent[0].text, /模擬回答/, "回答內容應為 AI stub 的回答");
    assert.ok(bot.stats.triggered >= 1, "觸發計數應增加");
    assert.ok(bot.stats.answered >= 1, "已回答計數應增加");
    assert.ok(JSON.stringify(bot.memory.get(SQUARE) ?? []).includes("模擬回答"), "對話記憶應記在該社群室名下");
    await bot.onMessage({
      messageId: "sq-2", channelId: SQUARE, channelKind: "square",
      senderId: `p${"Q".repeat(20)}`, senderName: "社群測試員",
      text: "今天天氣不錯", contentType: "NONE", createdAt: Date.now(),
    });
    assert.equal(sent.length, 1, "沒叫名字的一般訊息不得觸發回答");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
