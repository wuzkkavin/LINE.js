import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityChatOptions, filterActivityEvents } from "../src/activityfilter.mjs";
import { Logger } from "../src/logger.mjs";
import { MemorySecretStore } from "../src/secrets.mjs";
import { SettingsStore } from "../src/config.mjs";
import { createAiClient } from "../src/ai.mjs";
import { HelperBot } from "../src/bot.mjs";
import { createConsoleServer } from "../src/server.mjs";

// 活動紀錄是新到舊排序 (bot.recordActivity 以 unshift 插入)。
const ev = (chatId, chatName, question = "") => ({ chatId, chatName, question });

test("activityfilter options: 空清單回空陣列", () => {
  assert.deepEqual(activityChatOptions([]), []);
  assert.deepEqual(activityChatOptions(null), []);
  assert.deepEqual(activityChatOptions(undefined), []);
});

test("activityfilter options: 多群去重、依最近活動排序、名稱取最近一筆", () => {
  const events = [
    ev("c-b", "乙群", "新"),
    ev("c-a", "甲群", "新"),
    ev("c-b", "乙群", "舊"),
    ev("c-a", "甲群", "舊"),
  ];
  assert.deepEqual(activityChatOptions(events), [
    { chatId: "c-b", chatName: "乙群" },
    { chatId: "c-a", chatName: "甲群" },
  ]);
});

test("activityfilter options: 群名變更只列一個選項, 名稱用最新名", () => {
  const events = [ev("c-a", "新名字"), ev("c-a", "舊名字")];
  assert.deepEqual(activityChatOptions(events), [{ chatId: "c-a", chatName: "新名字" }]);
});

test("activityfilter options: 最近一筆沒名稱時往較舊的同群紀錄補名", () => {
  const events = [ev("c-a", ""), ev("c-a", "甲群")];
  assert.deepEqual(activityChatOptions(events), [{ chatId: "c-a", chatName: "甲群" }]);
});

test("activityfilter options: 沒有 chatId 的紀錄不列入選單", () => {
  const events = [ev("", ""), ev("c-a", "甲群"), { chatName: "無編號" }];
  assert.deepEqual(activityChatOptions(events), [{ chatId: "c-a", chatName: "甲群" }]);
});

test("activityfilter filter: 不給 chatId 回全部 (複本, 不動原陣列)", () => {
  const events = [ev("c-a", "甲群"), ev("c-b", "乙群")];
  for (const key of [undefined, null, ""]) {
    const out = filterActivityEvents(events, key);
    assert.deepEqual(out, events);
    assert.notEqual(out, events, "必須是複本, 不能回原陣列");
  }
  assert.deepEqual(filterActivityEvents(null, ""), []);
});

test("activityfilter filter: 指定單群只回該群且順序不變", () => {
  const events = [ev("c-a", "甲群", "1"), ev("c-b", "乙群", "2"), ev("c-a", "甲群", "3")];
  assert.deepEqual(filterActivityEvents(events, "c-a").map((e) => e.question), ["1", "3"]);
  assert.deepEqual(filterActivityEvents(events, "c-b").map((e) => e.question), ["2"]);
});

test("activityfilter filter: 以編號為準 — 同群改名後新舊紀錄都回", () => {
  const events = [ev("c-a", "新名字", "新"), ev("c-a", "舊名字", "舊")];
  assert.deepEqual(filterActivityEvents(events, "c-a").map((e) => e.question), ["新", "舊"]);
});

test("activityfilter filter: 未知 chatId 與空清單都回空陣列", () => {
  assert.deepEqual(filterActivityEvents([ev("c-a", "甲群")], "c-zzz"), []);
  assert.deepEqual(filterActivityEvents([], "c-a"), []);
});

test("activityfilter 端點: /api/bot/activity?chat= 只回該群, 並附 chats 與 total", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "helper-actfilter-"));
  const logger = new Logger({ dir: join(dir, "logs") });
  const settings = new SettingsStore({ path: join(dir, "settings.json"), logger });
  const secrets = new MemorySecretStore();
  const bot = new HelperBot({ settings, secrets, ai: createAiClient({}), logger });
  const server = createConsoleServer({ settings, secrets, ai: createAiClient({}), kb: null, bot, logger });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/bot/activity`;
  bot.chatNames.set("c-aaa", "甲群");
  bot.chatNames.set("c-bbb", "乙群");
  const rec = (channelId, text) => bot.recordActivity({ kind: "answered", m: { channelId, senderName: "同事", text }, answerChars: 5, ms: 10 });
  rec("c-aaa", "甲群問題一");
  rec("c-bbb", "乙群問題");
  rec("c-aaa", "甲群問題二");

  const all = await fetch(base).then((x) => x.json());
  assert.equal(all.ok, true);
  assert.equal(all.events.length, 3, "不帶 chat 參數時行為與改版前相同");
  assert.equal(all.total, 3);
  assert.deepEqual(all.chats, [
    { chatId: "c-aaa", chatName: "甲群" },
    { chatId: "c-bbb", chatName: "乙群" },
  ]);

  const only = await fetch(`${base}?chat=c-aaa`).then((x) => x.json());
  assert.equal(only.events.length, 2);
  assert.ok(only.events.every((e) => e.chatId === "c-aaa"));
  assert.equal(only.total, 3, "total 是未篩選總數, 供畫面分開標明");
  assert.equal(only.chats.length, 2, "選單仍列全部群組");

  const none = await fetch(`${base}?chat=c-zzz`).then((x) => x.json());
  assert.deepEqual(none.events, []);
  assert.equal(none.total, 3);
});
