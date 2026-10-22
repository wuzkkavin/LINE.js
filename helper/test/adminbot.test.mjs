// 管理員通知第四階段接線測試: bot 的事件來源 (關鍵字掃描/事件記錄) 與候選名單。
// 不連真核心: bot 不 connect, 直接呼叫事件方法, 驗證「決策與紀錄」有正確落到 AdminEventStore。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperBot } from "../src/bot.mjs";
import { SettingsStore } from "../src/config.mjs";
import { AdminEventStore } from "../src/adminnotify.mjs";
import { Logger } from "../src/logger.mjs";

function makeBot(dir, notify) {
  const logger = new Logger({ dir: join(dir, "logs") });
  const settings = new SettingsStore({ path: join(dir, "settings.json"), logger });
  settings.update({ botName: "AI寶", notify });
  const adminEvents = new AdminEventStore({ path: join(dir, "admin-events.json"), logger });
  const bot = new HelperBot({ settings, secrets: null, ai: null, kb: null, logger, adminEvents });
  bot.chatNames.set("c1", "公司學習群");
  return { bot, adminEvents };
}

const NOTIFY = {
  admins: [{ id: "u-admin", name: "老吳" }],
  rules: [
    { id: "r1", kind: "keyword", keyword: "報價", notifyAdminIds: ["u-admin"], enabled: true },
    { id: "r2", kind: "scam", keyword: "", notifyAdminIds: ["u-admin"], enabled: true },
    { id: "r3", kind: "selfError", keyword: "", notifyAdminIds: [], enabled: true },
  ],
};

test("關鍵字事件: 訊息含關鍵字才記錄, 本文是白話且帶群名與時間", () => {
  const dir = mkdtempSync(join(tmpdir(), "adminbot-"));
  try {
    const { bot, adminEvents } = makeBot(dir, NOTIFY);
    bot.checkKeywordRules({ channelId: "c1", senderId: "u-x", senderName: "同事", text: "午餐吃什麼" });
    assert.equal(adminEvents.list().length, 0);
    bot.checkKeywordRules({ channelId: "c1", senderId: "u-x", senderName: "同事", text: "這份報價多少錢" });
    const events = adminEvents.list();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "keyword");
    assert.equal(events[0].notified, true);
    assert.match(events[0].message, /有人提到關鍵字/);
    assert.match(events[0].message, /公司學習群/);
    assert.equal(events[0].targets[0].adminId, "u-admin");
    // 管理員沒在這個群的發言紀錄裡出現過, 但 bot 完全沒這個群的發言資料 -> 預設可 @, 不誤走退路
    assert.equal(events[0].targets[0].mode, "mention");
    assert.equal(adminEvents.pendingNotify().length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("@ 退路: 有發言紀錄的群裡, 沒說過話的管理員改走寫名字", () => {
  const dir = mkdtempSync(join(tmpdir(), "adminbot-"));
  try {
    const { bot, adminEvents } = makeBot(dir, NOTIFY);
    // 群裡有人說過話 (但不是管理員) -> bot 有這個群的發言資料, 管理員不在其中 -> hasSpoken false
    bot.noteSpeaker({ channelId: "c1", senderId: "u-other", senderName: "別人" });
    bot.raiseAdminEvent("scam", { chatId: "c1", chatName: "公司學習群", detail: "有人貼了疑似詐騙訊息。" });
    const ev = adminEvents.list()[0];
    assert.equal(ev.targets[0].mode, "plain");
    assert.match(ev.targets[0].note, /還沒在這個群說過話/);
    // 管理員自己說過話之後就可 @
    bot.noteSpeaker({ channelId: "c1", senderId: "u-admin", senderName: "老吳" });
    bot.raiseAdminEvent("selfError", { chatId: "c1", chatName: "公司學習群", detail: "有訊息讀不到。" });
    const ev2 = adminEvents.list().find((e) => e.kind === "selfError");
    assert.equal(ev2.targets[0].mode, "mention"); // selfError 規則沒勾人 = 通知全部管理員
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("候選名單: 來自發言者登記, 含聊天室名 (未連線時不查 OpenChat)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adminbot-"));
  try {
    const { bot } = makeBot(dir, NOTIFY);
    bot.noteSpeaker({ channelId: "c1", senderId: "u-a", senderName: "阿明" });
    bot.noteSpeaker({ channelId: "c1", senderId: "u-b", senderName: "小華" });
    const list = await bot.adminCandidates();
    assert.equal(list.length, 2);
    assert.equal(list.find((c) => c.id === "u-a").chats[0], "公司學習群");
    assert.equal(list.find((c) => c.id === "u-a").source, "speaker");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("沒有設定規則時不記錄任何事件 (通知功能等於關閉)", () => {
  const dir = mkdtempSync(join(tmpdir(), "adminbot-"));
  try {
    const { bot, adminEvents } = makeBot(dir, { admins: [], rules: [] });
    bot.checkKeywordRules({ channelId: "c1", senderId: "u-x", text: "報價" });
    bot.raiseAdminEvent("scam", { chatId: "c1", detail: "x" });
    assert.equal(adminEvents.list().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
