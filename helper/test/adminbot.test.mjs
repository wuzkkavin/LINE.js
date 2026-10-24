// 管理員通知第四階段接線測試: bot 的事件來源 (關鍵字掃描/事件記錄) 與候選名單。
// 不連真核心: bot 不 connect, 直接呼叫事件方法, 驗證「決策與紀錄」有正確落到 AdminEventStore。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperBot, ADMIN_CANDIDATE_RECENT_MS } from "../src/bot.mjs";
import { createConsoleServer } from "../src/server.mjs";
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
    const CHAT = `c${"1".repeat(32)}`;
    bot.chatNames.set(CHAT, "公司學習群");
    // 2026-10-25 定案: 收件人只有本室管理員, 先給本室設管理員再測關鍵字事件。
    bot.settings.update({ ai: { chatProfiles: { [CHAT]: { personaCustom: false, admins: [{ id: "u-admin" }] } } } });
    bot.checkKeywordRules({ channelId: CHAT, senderId: "u-x", senderName: "同事", text: "午餐吃什麼" });
    assert.equal(adminEvents.list().length, 0);
    bot.checkKeywordRules({ channelId: CHAT, senderId: "u-x", senderName: "同事", text: "這份報價多少錢" });
    const events = adminEvents.list();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "keyword");
    assert.equal(events[0].notified, true);
    assert.match(events[0].message, /有人提到關鍵字/);
    assert.match(events[0].message, /公司學習群/);
    assert.equal(events[0].targets[0].adminId, "u-admin");
    // 本室管理員、且 bot 完全沒這個群的發言資料 -> 預設可 @, 不誤走退路
    assert.equal(events[0].targets[0].mode, "mention");
    assert.equal(adminEvents.pendingNotify().length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("@ 退路: 有發言紀錄的群裡, 沒說過話的本室管理員改走寫名字", () => {
  const dir = mkdtempSync(join(tmpdir(), "adminbot-"));
  try {
    const { bot, adminEvents } = makeBot(dir, NOTIFY);
    const CHAT = `c${"1".repeat(32)}`;
    bot.chatNames.set(CHAT, "公司學習群");
    // 2026-10-25 定案: 收件人只有本室管理員; 本室管理員沒說過話 -> 寫名字, 不 @。
    bot.settings.update({ ai: { chatProfiles: { [CHAT]: { personaCustom: false, admins: [{ id: "u-admin" }] } } } });
    // 群裡有人說過話 (但不是管理員) -> bot 有這個群的發言資料, 管理員不在其中 -> hasSpoken false
    bot.noteSpeaker({ channelId: CHAT, senderId: "u-other", senderName: "別人" });
    bot.raiseAdminEvent("scam", { chatId: CHAT, chatName: "公司學習群", detail: "有人貼了疑似詐騙訊息。" });
    const ev = adminEvents.list()[0];
    assert.deepEqual(ev.targets.map((t) => t.adminId), ["u-admin"]);
    assert.equal(ev.targets[0].mode, "plain");
    assert.match(ev.targets[0].note, /還沒在這個群說過話/);
    // 管理員自己說過話之後就可 @
    bot.noteSpeaker({ channelId: CHAT, senderId: "u-admin", senderName: "老吳" });
    bot.raiseAdminEvent("selfError", { chatId: CHAT, chatName: "公司學習群", detail: "有訊息讀不到。" });
    const ev2 = adminEvents.list().find((e) => e.kind === "selfError");
    assert.equal(ev2.targets[0].mode, "mention");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("候選名單: 來自該室發言者登記, 含聊天室名 (未連線時不查 OpenChat)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adminbot-"));
  try {
    const { bot } = makeBot(dir, NOTIFY);
    const CHAT = `c${"1".repeat(32)}`;
    bot.chatNames.set(CHAT, "公司學習群");
    bot.noteSpeaker({ channelId: CHAT, senderId: "u-a", senderName: "阿明" });
    bot.noteSpeaker({ channelId: CHAT, senderId: "u-b", senderName: "小華" });
    // 2026-10-25 定案: 候選只取該室, 不給室不回聯集。
    const list = await bot.adminCandidates(CHAT);
    assert.equal(list.length, 2);
    assert.equal(list.find((c) => c.id === "u-a").chats[0], "公司學習群");
    assert.equal(list.find((c) => c.id === "u-a").source, "speaker");
    assert.deepEqual(await bot.adminCandidates(), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("每室管理員 (修復版6, 2026-10-25 定案): 有自訂管理員的群通知該室全部管理員, 未設的群不 @、只寫紀錄", () => {
  const dir = mkdtempSync(join(tmpdir(), "adminbot-"));
  try {
    const { bot, adminEvents } = makeBot(dir, NOTIFY);
    const CHAT_WITH = `c${"1".repeat(32)}`;
    const CHAT_WITHOUT = `c${"2".repeat(32)}`;
    bot.chatNames.set(CHAT_WITH, "有自訂管理員的群");
    bot.chatNames.set(CHAT_WITHOUT, "未設管理員的群");
    // 該室自訂管理員兩位 (personaCustom=false 的 admins-only 條目也要算數)
    bot.settings.update({ ai: { chatProfiles: { [CHAT_WITH]: { personaCustom: false, admins: [{ id: "u-chat1" }, { id: "u-chat2" }] } } } });
    // 本室甲在該群說過話、本室乙沒說過 -> 甲可 @、乙走寫名字 (presence 只算收件池)
    bot.noteSpeaker({ channelId: CHAT_WITH, senderId: "u-chat1", senderName: "本室甲" });
    bot.raiseAdminEvent("scam", { chatId: CHAT_WITH, chatName: "有自訂管理員的群", detail: "有人貼了疑似詐騙訊息。" });
    const evChat = adminEvents.list().find((e) => e.chatId === CHAT_WITH);
    assert.deepEqual(evChat.targets.map((t) => t.adminId), ["u-chat1", "u-chat2"], "有自訂管理員時應通知該室全部管理員");
    assert.equal(evChat.targets.find((t) => t.adminId === "u-chat1").mode, "mention");
    assert.equal(evChat.targets.find((t) => t.adminId === "u-chat2").mode, "plain");
    // 未設自訂管理員的群: 不 @ 任何人, 事件只寫進紀錄 (備援已廢除, 不再退全域名單)
    bot.raiseAdminEvent("scam", { chatId: CHAT_WITHOUT, chatName: "未設管理員的群", detail: "有人貼了疑似詐騙訊息。" });
    const evGlobal = adminEvents.list().find((e) => e.chatId === CHAT_WITHOUT);
    assert.deepEqual(evGlobal.targets, []);
    assert.equal(evGlobal.notified, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("候選名單 (修復版6): 給 chat 只回該室候選, 形狀不合法回空陣列", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adminbot-"));
  try {
    const { bot } = makeBot(dir, NOTIFY);
    const CHAT_X = `c${"3".repeat(32)}`;
    const CHAT_Y = `c${"4".repeat(32)}`;
    bot.chatNames.set(CHAT_X, "甲聊天室");
    bot.chatNames.set(CHAT_Y, "乙聊天室");
    bot.noteSpeaker({ channelId: CHAT_X, senderId: "u-x1", senderName: "甲室的人" });
    bot.noteSpeaker({ channelId: CHAT_Y, senderId: "u-y1", senderName: "乙室的人" });
    const onlyX = await bot.adminCandidates(CHAT_X);
    assert.deepEqual(onlyX.map((c) => c.id), ["u-x1"], "給 chat 時只應回該室候選");
    assert.equal(onlyX[0].chats[0], "甲聊天室");
    assert.deepEqual(await bot.adminCandidates(), [], "2026-10-25 定案: 不給 chat 不回聯集");
    assert.deepEqual(await bot.adminCandidates("bad-id"), [], "chatId 形狀不合法應回空陣列不報錯");
    assert.deepEqual(await bot.adminCandidates("c123"), [], "長度不符的 chatId 應回空陣列");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("候選名單 all 模式 (修復版6 擴充): all 含超出近期窗的舊發言者, 預設不含; 端點 all=1 有傳到 bot", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "adminbot-"));
  try {
    const { bot } = makeBot(dir, NOTIFY);
    const CHAT_Z = `c${"5".repeat(32)}`;
    bot.chatNames.set(CHAT_Z, "人多的聊天室");
    bot.noteSpeaker({ channelId: CHAT_Z, senderId: "u-recent", senderName: "最近發言者" });
    // 直接寫入一筆舊發言者: lastAt 超出近期窗 (窗長 + 一天), 模擬很久以前在本室出現過的人
    bot.chatSpeakers.get(CHAT_Z).set("u-old", { name: "很久以前的人", lastAt: Date.now() - ADMIN_CANDIDATE_RECENT_MS - 24 * 60 * 60 * 1000 });
    // 預設模式: 只列近期窗內的發言者
    const def = await bot.adminCandidates(CHAT_Z);
    assert.deepEqual(def.map((c) => c.id), ["u-recent"], "預設模式不應包含超出近期窗的舊發言者");
    // all 模式: 曾記錄過的本室發言者全部列出 (去重、形狀相同)
    const widened = await bot.adminCandidates(CHAT_Z, { all: true });
    assert.deepEqual(widened.map((c) => c.id).sort(), ["u-old", "u-recent"], "all 模式應包含超出近期窗的舊發言者");
    assert.equal(widened.find((c) => c.id === "u-old").chats[0], "人多的聊天室");
    assert.equal(widened.find((c) => c.id === "u-old").source, "speaker");
    // 無參數呼叫不再回聯集 (2026-10-25 定案: 備援聯集已廢除)
    assert.deepEqual(await bot.adminCandidates(), [], "無參數呼叫應回空陣列");
    // 端點: 不帶 all 只回近期; 帶 all=1 放寬; 不帶 chat 回 400 白話錯誤
    const logger = new Logger({ dir: join(dir, "logs2") });
    const server = createConsoleServer({ settings: bot.settings, secrets: null, ai: null, kb: null, bot, logger });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const r1 = await (await fetch(`${base}/api/admin-candidates?chat=${CHAT_Z}`)).json();
    assert.deepEqual(r1.candidates.map((c) => c.id), ["u-recent"], "端點預設應只回近期候選");
    const r2 = await (await fetch(`${base}/api/admin-candidates?chat=${CHAT_Z}&all=1`)).json();
    assert.deepEqual(r2.candidates.map((c) => c.id).sort(), ["u-old", "u-recent"], "端點 all=1 應放寬名單");
    const rNoChat = await fetch(`${base}/api/admin-candidates`);
    assert.equal(rNoChat.status, 400);
    assert.match((await rNoChat.json()).message, /選一個聊天室/);
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

test("候選名單 (界面重整, 2026-10-25 定案): A 室候選不含只在 B 室發言的人, 不給室不回聯集", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "adminbot-"));
  try {
    const { bot } = makeBot(dir, NOTIFY);
    const CHAT_A = `c${"a".repeat(32)}`;
    const CHAT_B = `c${"b".repeat(32)}`;
    bot.chatNames.set(CHAT_A, "甲聊天室");
    bot.chatNames.set(CHAT_B, "乙聊天室");
    bot.noteSpeaker({ channelId: CHAT_A, senderId: "u-only-a", senderName: "只在甲室的人" });
    bot.noteSpeaker({ channelId: CHAT_B, senderId: "u-only-b", senderName: "只在乙室的人" });
    bot.noteSpeaker({ channelId: CHAT_A, senderId: "u-both", senderName: "兩室都發言的人" });
    bot.noteSpeaker({ channelId: CHAT_B, senderId: "u-both", senderName: "兩室都發言的人" });
    const onlyA = await bot.adminCandidates(CHAT_A);
    assert.deepEqual(onlyA.map((c) => c.id).sort(), ["u-both", "u-only-a"], "A 室候選不應含只在 B 室發言的人");
    const onlyB = await bot.adminCandidates(CHAT_B);
    assert.deepEqual(onlyB.map((c) => c.id).sort(), ["u-both", "u-only-b"], "B 室候選不應含只在 A 室發言的人");
    assert.deepEqual(await bot.adminCandidates(), [], "備援聯集已廢除, 不給室就回空陣列");
    // 端點: 不帶 chat 回 400; 給 chat 只回該室
    const logger = new Logger({ dir: join(dir, "logs3") });
    const server = createConsoleServer({ settings: bot.settings, secrets: null, ai: null, kb: null, bot, logger });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}`;
    const fb = await fetch(`${base}/api/admin-candidates?scope=fallback`);
    assert.equal(fb.status, 400, "舊聯集參數不再回聯集");
    const ch = await (await fetch(`${base}/api/admin-candidates?chat=${CHAT_A}`)).json();
    assert.deepEqual(ch.candidates.map((c) => c.id).sort(), ["u-both", "u-only-a"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("通知收件人 (2026-10-25 定案): 只通知該室管理員, 未設的室不 @、只寫紀錄; 舊欄位照樣存著", () => {
  const dir = mkdtempSync(join(tmpdir(), "adminbot-"));
  try {
    const notify = {
      admins: [{ id: "u-f1", name: "舊備援甲" }, { id: "u-f2", name: "舊備援乙" }],
      rules: [{ id: "r-scam", kind: "scam", keyword: "", notifyAdminIds: ["u-f1"], enabled: true }],
    };
    const { bot, adminEvents } = makeBot(dir, notify);
    const CHAT_NO_ADMIN = `c${"c".repeat(32)}`;
    const CHAT_WITH_ADMIN = `c${"d".repeat(32)}`;
    bot.chatNames.set(CHAT_NO_ADMIN, "未設管理員的群");
    bot.chatNames.set(CHAT_WITH_ADMIN, "有自訂管理員的群");
    bot.settings.update({ ai: { chatProfiles: { [CHAT_WITH_ADMIN]: { personaCustom: false, admins: [{ id: "u-c1" }] } } } });
    // 未設管理員的室: 不 @ 任何人, 事件只寫進紀錄 (舊備援名單不再是通知對象來源)
    bot.raiseAdminEvent("scam", { chatId: CHAT_NO_ADMIN, chatName: "未設管理員的群", detail: "有人貼了疑似詐騙訊息。" });
    const evGlobal = adminEvents.list().find((e) => e.chatId === CHAT_NO_ADMIN);
    assert.deepEqual(evGlobal.targets, []);
    assert.equal(evGlobal.notified, true);
    // 有自訂管理員的室: 只通知該室管理員, 備援與逐規則選人都不介入
    bot.raiseAdminEvent("scam", { chatId: CHAT_WITH_ADMIN, chatName: "有自訂管理員的群", detail: "有人貼了疑似詐騙訊息。" });
    const evChat = adminEvents.list().find((e) => e.chatId === CHAT_WITH_ADMIN);
    assert.deepEqual(evChat.targets.map((t) => t.adminId), ["u-c1"]);
    // 舊欄位儲存相容: 逐規則選人、種類、關鍵字、開關與舊備援名單都還在設定裡, 沒有被刪掉
    const stored = bot.settings.get().notify.rules.find((r) => r.id === "r-scam");
    assert.equal(stored.kind, "scam");
    assert.equal(stored.enabled, true);
    assert.deepEqual(stored.notifyAdminIds, ["u-f1"]);
    assert.deepEqual(bot.settings.get().notify.admins, notify.admins);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
