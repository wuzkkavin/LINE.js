// 訊息解密健康偵測 (2026-10-21 第二段): 假核心 (WebSocketServer) + 真 helper bot。
// 情境取自實機事故: 群組成員變動後, 特定寄件者的訊息在核心解密失敗, history DTO
// 帶 decryptFailed 且無文字; 即時路徑根本不送影格, 機器人過去對此零可見性、
// 狀態全綠。本測試驗證: 掃描能正確點燈/計數/歸屬聊天室、全正常不誤報、
// 恢復時正確轉回 ok 且轉移 log 各只寫一次、掃描不干擾連線後歷史補登。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { Logger } from "../src/logger.mjs";
import { MemorySecretStore } from "../src/secrets.mjs";
import { SettingsStore, SECRET_NAMES } from "../src/config.mjs";
import { createAiClient } from "../src/ai.mjs";
import { KnowledgeBase } from "../src/kb.mjs";
import { HelperBot } from "../src/bot.mjs";
import { MessageSenderRegistry } from "../src/msgregistry.mjs";

const CHAT = "c" + "a".repeat(32);
const CHAT_NAME = "公司學習群(假)";
const BASE_TS = 1761000000000; // 固定時間基準, 斷言 lastFailAt 用

async function tmp() { return mkdtemp(join(tmpdir(), "aibao-decrypt-")); }

async function waitUntil(pred, timeout = 6000, label = "condition") {
  const started = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - started > timeout) throw new Error("waitUntil timeout: " + label);
    await new Promise((r) => setTimeout(r, 30));
  }
}

// 假核心: 連線即送 auth:ready + channels; history:fetch 依目前設定的假歷史回一頁。
// state.history 可在測試中途換掉 (模擬登出重登後鑰匙對齊、訊息恢復可讀)。
// state.sendEvent 可把一則訊息以即時事件影格送給 bot (模擬正常送達, 漏接比對用)。
async function startFakeCore(t) {
  const state = { history: [], historyCalls: 0, socket: null };
  state.sendEvent = (message) => state.socket?.send(JSON.stringify({ type: "message", message }));
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on("listening", r));
  wss.on("connection", (s) => {
    state.socket = s;
    s.send(JSON.stringify({ type: "hello", serverVersion: "9.9.9" }));
    s.send(JSON.stringify({ type: "auth:ready", profile: { userId: "u-me", displayName: "假帳號" } }));
    s.send(JSON.stringify({ type: "channels", channels: [{ channelId: CHAT, name: CHAT_NAME }] }));
    s.on("message", (d) => {
      let f; try { f = JSON.parse(d.toString()); } catch { return; }
      if (f.type === "history:fetch") {
        state.historyCalls++;
        s.send(JSON.stringify({ type: "history", requestId: f.requestId, chatId: f.chatId, messages: state.history, hasMore: false }));
      }
      if (f.type === "message:send") s.send(JSON.stringify({ type: "sent", requestId: f.requestId, messageId: `botmsg-${f.requestId}` }));
    });
  });
  t.after(() => wss.close());
  return { state, port: wss.address().port };
}

async function startBot(t, core, botOptions = {}) {
  const dir = await tmp();
  const logger = new Logger({ dir: join(dir, "logs") });
  const settings = new SettingsStore({ path: join(dir, "settings.json"), logger });
  settings.update({ botName: "AI寶", lineApiUrl: `ws://127.0.0.1:${core.port}/api/ws` });
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.lineToken, "tok-DECRYPT-0000");
  const kb = new KnowledgeBase({ folder: "", indexPath: join(dir, "kb-index.json"), logger });
  const registry = new MessageSenderRegistry({ path: join(dir, "message-senders.json"), logger });
  const bot = new HelperBot({ settings, secrets, ai: createAiClient({}), kb, logger, registry, ...botOptions });
  t.after(() => bot.disconnect());
  await bot.connect();
  await waitUntil(() => bot.selfId === "u-me", 4000, "bot auth ready");
  // 等連線後歷史補登完成, 之後算 history 呼叫數才不會混到補登的份
  await waitUntil(() => bot.historyPrefetchedChats.has(CHAT), 4000, "history prefetch done");
  return { bot, logger, registry };
}

function msg(i, over = {}) {
  return {
    messageId: String(1790000000000000000n + BigInt(i)),
    channelId: CHAT, senderId: "u-other", senderName: "同事(假)",
    contentType: "TEXT", text: `訊息 ${i}`, createdAt: BASE_TS + i * 1000, ...over,
  };
}

test("decrypt: 近期歷史有 decryptFailed 時點燈、計數與聊天室歸屬正確, 轉移 log 只寫一次", async (t) => {
  const core = await startFakeCore(t);
  const failedAt = [3, 6, 8];
  core.state.history = Array.from({ length: 10 }, (_, i) =>
    failedAt.includes(i)
      ? msg(i, { text: undefined, decryptFailed: true, senderId: "u-fox", senderName: "妖狐藏馬(假)" })
      : msg(i));
  const { bot, logger } = await startBot(t, core);

  const s1 = await bot.scanDecryptHealthOnce();
  assert.equal(s1.state, "failed");
  assert.equal(s1.totalFailed, 3);
  assert.equal(s1.totalScanned, 10);
  assert.equal(s1.issues.length, 1);
  assert.equal(s1.issues[0].chatId, CHAT);
  assert.equal(s1.issues[0].name, CHAT_NAME);
  assert.equal(s1.issues[0].failed, 3);
  assert.equal(s1.issues[0].scanned, 10);
  assert.equal(s1.issues[0].lastFailAt, new Date(BASE_TS + 8000).toISOString());
  assert.deepEqual(s1.issues[0].senders, ["妖狐藏馬(假)"]);
  // status() 同欄位 (App 總覽與 web 控制台都讀這裡)
  assert.equal(bot.status().decrypt.state, "failed");
  assert.equal(bot.status().decrypt.totalFailed, 3);

  // 再掃一輪 (狀態未變): 不重複寫偵測 log
  await bot.scanDecryptHealthOnce();
  const logText = logger.readToday();
  assert.equal(logText.split("偵測到無法解密的訊息").length - 1, 1, "首次偵測 log 應只寫一次");
});

test("decrypt: 全部正常不誤報; 掃描不影響連線後歷史補登的寄件者登記", async (t) => {
  const core = await startFakeCore(t);
  core.state.history = [
    msg(1, { senderId: "u-me", senderName: "假帳號" }), // 機器人自己先前發的訊息
    msg(2), msg(3),
  ];
  const { bot, logger, registry } = await startBot(t, core);
  // 補登已把機器人自己的訊息登記進登記簿 (引用續答靠它) — 掃描前後都要在
  assert.equal(registry.lookup(core.state.history[0].messageId), "u-me");

  const before = core.state.historyCalls;
  const s = await bot.scanDecryptHealthOnce();
  assert.equal(s.state, "ok");
  assert.equal(s.totalFailed, 0);
  assert.deepEqual(s.issues, []);
  assert.equal(core.state.historyCalls - before, 1, "每輪掃描每聊天室只抓一頁");
  assert.equal(registry.lookup(core.state.history[0].messageId), "u-me", "掃描不得動到登記簿");
  assert.ok(!logger.readToday().includes("偵測到無法解密的訊息"), "正常時不得寫偵測警告");
});

test("decrypt: 失敗訊息消失後轉回 ok 並留恢復紀錄; 未連線時掃描不丟例外、狀態 unknown", async (t) => {
  const core = await startFakeCore(t);
  core.state.history = [msg(1, { text: undefined, decryptFailed: true }), msg(2)];
  const { bot, logger } = await startBot(t, core);
  assert.equal((await bot.scanDecryptHealthOnce()).state, "failed");

  // 模擬登出重登後鑰匙對齊: 同一則訊息變得可讀
  core.state.history = [msg(1), msg(2)];
  const s = await bot.scanDecryptHealthOnce();
  assert.equal(s.state, "ok");
  assert.equal(s.totalFailed, 0);
  const logText = logger.readToday();
  assert.ok(logText.includes("全部聊天室的訊息都可正常讀取了"), "恢復應留一筆 log");

  // 未連線的 bot: 沒有影格可打, 掃描直接回 unknown, 不丟例外
  const dir = await tmp();
  const logger2 = new Logger({ dir: join(dir, "logs") });
  const settings2 = new SettingsStore({ path: join(dir, "settings.json"), logger: logger2 });
  const idle = new HelperBot({ settings: settings2, secrets: new MemorySecretStore(), ai: createAiClient({}), logger: logger2 });
  const s2 = await idle.scanDecryptHealthOnce();
  assert.equal(s2.state, "unknown");
  assert.equal(idle.status().decrypt.state, "unknown");
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 漏接測試共用選項: 寬限縮短到 200ms、連線緩衝歸零, 不用真的等兩分鐘
const MISSED_OPTS = { decryptMissedOptions: { graceMs: 200, liveBufferMs: 0, minCount: 2 } };

test("decrypt: 訊息漏接點燈 (歷史有、事件沒送達且超過寬限, 累積達門檻), log 只寫一次", async (t) => {
  const core = await startFakeCore(t);
  const { bot, logger } = await startBot(t, core, MISSED_OPTS);
  const t0 = Date.now();
  // 兩則同事的文字訊息只進歷史、從不以事件送達 (模擬核心監聽卡死、整個群組變聾)
  core.state.history = [
    msg(11, { text: "請問印表機在哪裡", createdAt: t0, senderId: "u-a", senderName: "岱岱均(假)" }),
    msg(12, { text: "@AI寶 請問 VPN 怎麼連", createdAt: t0 + 100, senderId: "u-b", senderName: "Paul(假)" }),
  ];
  await sleep(300);
  const s = await bot.scanDecryptHealthOnce();
  assert.equal(s.missedTotal, 2);
  assert.equal(s.missedIssues.length, 1);
  assert.equal(s.missedIssues[0].chatId, CHAT);
  assert.equal(s.missedIssues[0].name, CHAT_NAME);
  assert.equal(s.missedIssues[0].missed, 2);
  assert.equal(s.missedIssues[0].newestMissedAt, new Date(t0 + 100).toISOString());
  assert.equal(bot.status().decrypt.missedTotal, 2);
  await bot.scanDecryptHealthOnce();
  assert.equal(logger.readToday().split("偵測到訊息漏接").length - 1, 1, "漏接偵測 log 應只寫一次");
});

test("decrypt: 有以事件送達的訊息不算漏接; 未達門檻與連線前的訊息不點燈", async (t) => {
  const core = await startFakeCore(t);
  const { bot } = await startBot(t, core, MISSED_OPTS);
  const t0 = Date.now();
  const arrived = msg(21, { text: "早安, 今天天氣好", createdAt: t0, senderId: "u-a" });
  const single = msg(22, { text: "有人在嗎", createdAt: t0 + 50, senderId: "u-b" });
  const beforeConnect = msg(23, { text: "連線前的舊訊息", createdAt: t0 - 3_600_000, senderId: "u-c" });
  core.state.history = [beforeConnect, arrived, single];
  core.state.sendEvent(arrived); // 這則有正常送達
  await sleep(300);
  const s = await bot.scanDecryptHealthOnce();
  assert.equal(s.missedTotal, 0, "送達過的、連線前的、以及單則未達門檻的都不應點燈");
  assert.deepEqual(s.missedIssues, []);
  // 補上第二則漏接 (等它也超過寬限) → 達到門檻才點燈
  core.state.history = [...core.state.history, msg(24, { text: "再問一次", createdAt: Date.now(), senderId: "u-b" })];
  await sleep(300);
  const s2 = await bot.scanDecryptHealthOnce();
  assert.equal(s2.missedTotal, 2);
  assert.equal(s2.missedIssues[0].missed, 2);
});

test("decrypt(修復): 歷史有舊壞訊息但即時訊息正常 = 不擋事 (blocking=false); 即時也失敗才擋", async (t) => {
  const core = await startFakeCore(t);
  // 歷史窗裡留著舊世代解不開的訊息 (2026-10-21 事故群復原後的真實形貌)
  core.state.history = [
    msg(1), msg(2),
    msg(3, { text: undefined, decryptFailed: true, senderId: "u-fox", senderName: "妖狐藏馬(假)" }),
    msg(4),
  ];
  const { bot } = await startBot(t, core);

  // 只有歷史證據、還沒有任何即時事件: 不冒充「現在壞掉」, 不擋事
  let s = await bot.scanDecryptHealthOnce();
  assert.equal(s.state, "failed"); // 歷史問題仍誠實呈現
  assert.equal(s.issues[0].blocking, false);
  assert.deepEqual(s.blockingChats, []);

  // 即時來一則正常文字 (群是活的): 仍不擋, 且記下最後即時成功時間
  core.state.sendEvent(msg(50, { text: "管理員在不在" }));
  await waitUntil(() => (bot.decryptLiveByChat.get(CHAT)?.lastOkAt ?? 0) > 0, 4000, "live ok recorded");
  s = await bot.scanDecryptHealthOnce();
  assert.equal(s.issues[0].blocking, false);
  assert.ok(s.issues[0].lastLiveOkAt);

  // 即時來一則解不開的佔位訊息、之後沒有成功: 這才是「現在真的讀不到」, 要擋
  core.state.sendEvent(msg(51, { text: undefined, decryptFailed: true, senderId: "u-fox", senderName: "妖狐藏馬(假)" }));
  await waitUntil(() => (bot.decryptLiveByChat.get(CHAT)?.lastFailAt ?? 0) >= (bot.decryptLiveByChat.get(CHAT)?.lastOkAt ?? 0), 4000, "live fail recorded");
  s = await bot.scanDecryptHealthOnce();
  assert.equal(s.issues[0].blocking, true);
  assert.deepEqual(s.blockingChats, [CHAT]);

  // 即時再來一則正常文字: 自動解除擋事 (不用人工處理)
  core.state.sendEvent(msg(52, { text: "復原了" }));
  await waitUntil(() => (bot.decryptLiveByChat.get(CHAT)?.lastOkAt ?? 0) > (bot.decryptLiveByChat.get(CHAT)?.lastFailAt ?? 0), 4000, "live ok again");
  s = await bot.scanDecryptHealthOnce();
  assert.equal(s.issues[0].blocking, false);
  assert.deepEqual(s.blockingChats, []);
});

test("decrypt: 看守計時器會自己掃描並可停止", async (t) => {
  const core = await startFakeCore(t);
  core.state.history = [msg(1, { text: undefined, decryptFailed: true })];
  const { bot } = await startBot(t, core);
  bot.startDecryptWatch(60);
  await waitUntil(() => bot.status().decrypt.state === "failed", 4000, "watch tick detects failure");
  bot.stopDecryptWatch();
  assert.equal(bot.decryptScanTimer, null);
});
