// 60 秒視窗上限 (修復版7) 測試:
// (A) trigger 單元 (假時間): 每人每群到上限被擋、視窗滑出後恢復、每人每群互不影響、
//     所有群合計會擋下其他群、被擋下的提問不計次、設定 0 = 不限制、引用續答同樣受限。
// (B) bot 計次規則 (真 HelperBot, 傳送與 AI 都用替身): 只叫名字的問候不計次、
//     AI 回答失敗仍計次、合計上限在 bot 層會擋下另一個群的提問,
//     被擋下時活動紀錄留下 window_user / window_all (畫面顯示「問太密擋下」/「全部群問太密擋下」)。
import test from "node:test";
import assert from "node:assert/strict";
import { createTriggerState, evaluateTrigger, markTriggered } from "../src/trigger.mjs";
import { SettingsStore } from "../src/config.mjs";
import { HelperBot } from "../src/bot.mjs";

const CHAT_A = `c${"a".repeat(32)}`;
const CHAT_B = `c${"b".repeat(32)}`;

// ---------- (A) trigger 單元 ----------

function unitSettings(over = {}) {
  return {
    botName: "AI寶", aliases: [], triggerMode: "relaxed", cooldownSec: 0, dailyLimit: 10000,
    perUserChatMinuteLimit: 3, allChatsMinuteLimit: 10, ...over,
  };
}

// 模擬 bot 的用法: 判定通過才 markTriggered (計次), 被擋下不計次。
function ask(state, settings, { chatId = CHAT_A, senderId = "u1", now, text = "AI寶，請問試算表怎麼加總？", quotedSelf = false }) {
  const v = evaluateTrigger({ text, senderId, selfId: "me", settings, state, now, chatId, quotedSelf });
  if (v.triggered) markTriggered(state, senderId, now, chatId);
  return v;
}

test("window: 每人每群 60 秒到上限被擋 (window_user), 別人與別群不受影響", () => {
  const st = createTriggerState();
  const s = unitSettings();
  const t0 = new Date(1_700_000_000_000);
  for (let i = 0; i < 3; i++) {
    assert.equal(ask(st, s, { now: new Date(t0.getTime() + i * 1000) }).triggered, true, `第 ${i + 1} 題應通過`);
  }
  const blocked = ask(st, s, { now: new Date(t0.getTime() + 3000) });
  assert.equal(blocked.triggered, false);
  assert.equal(blocked.reason, "window_user");
  // 同一人在另一個聊天室: 各群分開計, 不受影響
  assert.equal(ask(st, s, { chatId: CHAT_B, now: new Date(t0.getTime() + 3000) }).triggered, true);
  // 同聊天室另一個人: 不受影響
  assert.equal(ask(st, s, { senderId: "u2", now: new Date(t0.getTime() + 3000) }).triggered, true);
});

test("window: 視窗滑出後恢復, 且被擋下的提問不計次 (不會把視窗往後延)", () => {
  const st = createTriggerState();
  const s = unitSettings();
  const t0 = new Date(1_700_000_100_000);
  for (let i = 0; i < 3; i++) ask(st, s, { now: new Date(t0.getTime() + i * 1000) });
  // 30 秒時被擋一次; 若被擋的也計次, 90 秒時視窗內仍會留著那一筆
  assert.equal(ask(st, s, { now: new Date(t0.getTime() + 30_000) }).reason, "window_user");
  // 最早的提問滑出 60 秒後應恢復 (3 筆都在 t0~t0+2s, t0+61s 時全數滑出)
  assert.equal(ask(st, s, { now: new Date(t0.getTime() + 61_000) }).triggered, true);
});

test("window: 所有群合計到上限會擋下其他群 (window_all)", () => {
  const st = createTriggerState();
  const s = unitSettings({ perUserChatMinuteLimit: 100, allChatsMinuteLimit: 2 });
  const t0 = new Date(1_700_000_200_000);
  assert.equal(ask(st, s, { chatId: CHAT_A, senderId: "u1", now: t0 }).triggered, true);
  assert.equal(ask(st, s, { chatId: CHAT_B, senderId: "u2", now: new Date(t0.getTime() + 1000) }).triggered, true);
  const blocked = ask(st, s, { chatId: CHAT_B, senderId: "u3", now: new Date(t0.getTime() + 2000) });
  assert.equal(blocked.triggered, false);
  assert.equal(blocked.reason, "window_all");
});

test("window: 設定 0 = 不限制; 舊存檔沒有欄位時用出廠預設 (3 / 10)", () => {
  const st = createTriggerState();
  const s0 = unitSettings({ perUserChatMinuteLimit: 0, allChatsMinuteLimit: 0 });
  const t0 = new Date(1_700_000_300_000);
  for (let i = 0; i < 15; i++) {
    assert.equal(ask(st, s0, { now: new Date(t0.getTime() + i * 100) }).triggered, true, "0 應為不限制");
  }
  const st2 = createTriggerState();
  const legacy = unitSettings();
  delete legacy.perUserChatMinuteLimit;
  delete legacy.allChatsMinuteLimit;
  for (let i = 0; i < 3; i++) assert.equal(ask(st2, legacy, { now: new Date(t0.getTime() + i * 1000) }).triggered, true);
  assert.equal(ask(st2, legacy, { now: new Date(t0.getTime() + 3000) }).reason, "window_user", "缺欄位要用預設 3");
});

test("window: 引用續答同樣受視窗限制 (與每日上限同性質, 不比照冷卻放行)", () => {
  const st = createTriggerState();
  const s = unitSettings({ perUserChatMinuteLimit: 1 });
  const t0 = new Date(1_700_000_400_000);
  assert.equal(ask(st, s, { now: t0 }).triggered, true);
  const v = ask(st, s, { now: new Date(t0.getTime() + 1000), text: "那如果換成減法呢？", quotedSelf: true });
  assert.equal(v.triggered, false);
  assert.equal(v.reason, "window_user");
});

// ---------- (B) bot 計次規則 ----------

function makeBot(settingsOver, aiImpl) {
  const settings = new SettingsStore({ path: "" });
  settings.update({ triggerMode: "relaxed", cooldownSec: 0, dailyLimit: 100, ...settingsOver });
  const bot = new HelperBot({ settings });
  bot.sendText = async () => {};
  bot.chatWithAi = aiImpl;
  return bot;
}
let seq = 0;
function msg(chatId, senderId, text) {
  return { channelId: chatId, senderId, senderName: "同事", text, messageId: `m${++seq}` };
}

test("bot window: 只叫名字的問候不計次, 真提問才占額度; 到上限留 window_user 活動紀錄", async () => {
  const bot = makeBot({ perUserChatMinuteLimit: 1, allChatsMinuteLimit: 10 }, async () => ({ content: "好的回答" }));
  const s = bot.cfg();
  // 連打三次招呼 (只叫名字): 都回引導, 且不占視窗額度
  for (let i = 0; i < 3; i++) {
    assert.equal(await bot.handleTrigger(msg(CHAT_A, "u1", "AI寶"), s), true);
  }
  assert.equal(bot.activitySnapshot().filter((a) => a.kind === "name_only").length, 3);
  // 第一題真提問: 額度還在, 應正常回答 (證明問候沒吃掉額度)
  assert.equal(await bot.handleTrigger(msg(CHAT_A, "u1", "AI寶，請問試算表怎麼加總？"), s), true);
  assert.equal(bot.activitySnapshot().filter((a) => a.kind === "answered").length, 1);
  // 緊接著第二題: 視窗上限 1 已用滿, 被擋下並留下紀錄
  assert.equal(await bot.handleTrigger(msg(CHAT_A, "u1", "AI寶，請問圖表怎麼做？"), s), true);
  assert.ok(bot.activitySnapshot().some((a) => a.kind === "window_user"), "應留下 window_user 活動紀錄");
  assert.equal(bot.activitySnapshot().filter((a) => a.kind === "answered").length, 1, "被擋下的不應再回答");
});

test("bot window: AI 回答失敗仍計次", async () => {
  const bot = makeBot({ perUserChatMinuteLimit: 1, allChatsMinuteLimit: 10 }, async () => { throw new Error("boom"); });
  const s = bot.cfg();
  await bot.handleTrigger(msg(CHAT_A, "u1", "AI寶，請問試算表怎麼加總？"), s);
  assert.ok(bot.activitySnapshot().some((a) => a.kind === "ai_failed"), "第一題應是 AI 失敗備援");
  await bot.handleTrigger(msg(CHAT_A, "u1", "AI寶，請問圖表怎麼做？"), s);
  assert.ok(bot.activitySnapshot().some((a) => a.kind === "window_user"), "失敗的那一題已占額度, 第二題應被視窗擋下");
});

test("bot window: 所有群合計到上限, 另一個群的人也被擋下 (window_all)", async () => {
  const bot = makeBot({ perUserChatMinuteLimit: 100, allChatsMinuteLimit: 1 }, async () => ({ content: "好的回答" }));
  const s = bot.cfg();
  await bot.handleTrigger(msg(CHAT_A, "u1", "AI寶，請問試算表怎麼加總？"), s);
  assert.equal(bot.activitySnapshot().filter((a) => a.kind === "answered").length, 1);
  await bot.handleTrigger(msg(CHAT_B, "u2", "AI寶，請問圖表怎麼做？"), s);
  assert.ok(bot.activitySnapshot().some((a) => a.kind === "window_all"), "合計上限用滿後, 別群的提問應被擋下");
  assert.equal(bot.activitySnapshot().filter((a) => a.kind === "answered").length, 1);
});
