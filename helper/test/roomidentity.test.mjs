// 修復 A + 記 ID 不記名字 + 備援廢除 (2026-10-25, 老吳定案):
// ① 白名單 (核心設定檔 api.chats) 與核心即時清單 (channels 影格) 對不起來時,
//    社群群不能默默不服務: 監聽狀態要顯示未監聽, 補登與解密掃描要覆蓋白名單全部室。
// ② 管理員只有一種: 各室從該室成員名單選, 不得混室; 備援名單與跨室聯集已廢除,
//    不提供聯集端點/資料, 舊備援存檔值留置不動、發送解析不再讀它。
// ③ 身分認 ID 不認名字: 已選管理員只存 ID, 顯示名每次從該室最新發言資料即時解析;
//    同一 ID 改名後顯示自動跟著變、通知對象不變; 同名不同 ID 視為不同人; 比對不用名字。
// ④ 未設管理員的室: 事件不 @ 任何人、只寫紀錄, 僅此而已 (不補、不提醒)。
// 實作不寫死任何名字/帳號: 以下 fixture 用的帳號與名字皆為測試虛構, 只證明機制。
// 不連真核心: bot 不 connect, 直接餵影格/訊息, AI 與核心送出皆以 stub 模擬。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { HelperBot } from "../src/bot.mjs";
import { SettingsStore, normalizeChatAdmins } from "../src/config.mjs";
import { AdminEventStore } from "../src/adminnotify.mjs";
import { Logger } from "../src/logger.mjs";

const TALK = `c${"a".repeat(32)}`; // 一般群 (測試虛構 ID)
const SQUARE = `m${"b".repeat(32)}`; // 社群群 OpenChat (測試虛構 ID, m 開頭)
const ID_TALK = `u${"1".repeat(32)}`; // 一般群身分 (測試虛構帳號)
const ID_SQUARE = `p${"Q".repeat(20)}`; // 社群群身分 (測試虛構帳號)
const RULES_ONLY = {
  admins: [{ id: `u${"7".repeat(32)}`, name: "舊備援殘留" }],
  rules: [{ id: "r-scam", kind: "scam", keyword: "", notifyAdminIds: [], enabled: true }],
};

function makeBot(dir, notify, whitelist) {
  const logger = new Logger({ dir: join(dir, "logs") });
  const seen = { info: [], warn: [] };
  for (const k of ["info", "warn"]) {
    const orig = logger[k].bind(logger);
    logger[k] = (...a) => { seen[k].push(a); return orig(...a); };
  }
  logger.logText = () => {};
  const settings = new SettingsStore({ path: join(dir, "settings.json"), logger });
  settings.update({ botName: "AI寶", notify });
  const adminEvents = new AdminEventStore({ path: join(dir, "admin-events.json"), logger });
  const bot = new HelperBot({ settings, secrets: null, ai: null, kb: null, logger, adminEvents, whitelistReader: whitelist ? () => [...whitelist] : null });
  return { bot, adminEvents, seen };
}

async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "roomidentity-"));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("監聽狀態: 白名單有、即時清單缺的社群群顯示未監聽, 摘要不冒充全部正常", async () => {
  await withDir(async (dir) => {
    const { bot } = makeBot(dir, undefined, [TALK, SQUARE]);
    bot.botChats = [TALK];
    bot.chatNames.set(TALK, "一般群");
    bot.chatNames.set(SQUARE, "社群群");
    const monitor = bot.monitorStatus();
    assert.equal(monitor.total, 2);
    assert.deepEqual(monitor.monitored, [TALK]);
    assert.deepEqual(monitor.unmonitored.map((u) => u.chatId), [SQUARE]);
    // 掃一輪 (兩室都掃得到、都沒有解密失敗): 舊版會因 chatsChecked=2 顯示 ok,
    // 新版必須是 partial 並列出未監聽的社群群。
    bot.connected = true;
    bot.fetchHistoryPage = async () => ({ messages: [], hasMore: false });
    const summary = await bot.scanDecryptHealthOnce();
    assert.equal(summary.state, "partial");
    assert.equal(summary.whitelistTotal, 2);
    assert.equal(summary.chatsChecked, 2);
    assert.deepEqual(summary.unmonitoredChats.map((u) => u.chatId), [SQUARE]);
  });
});

test("即時清單縮水時寫 log, 不靜默掉室; 補登對象含白名單室", async () => {
  await withDir(async (dir) => {
    const { bot, seen } = makeBot(dir, undefined, [TALK, SQUARE]);
    bot.botChats = [TALK, SQUARE];
    bot.connected = true;
    const fetched = [];
    bot.fetchHistoryPage = async (chatId) => { fetched.push(chatId); return { messages: [], hasMore: false }; };
    await bot.onFrame(JSON.stringify({ type: "channels", channels: [{ channelId: TALK, name: "一般群" }] }));
    assert.deepEqual(bot.botChats, [TALK]);
    assert.ok(seen.warn.some(([cat, msg]) => cat === "LINE 連線" && String(msg).includes("不再出現")), "縮水要留一筆 log");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(fetched.includes(TALK), "影格內的室要補登");
    assert.ok(fetched.includes(SQUARE), "白名單裡影格缺的社群群也要補登");
  });
});

test("解密掃描覆蓋白名單社群群, 順帶補登該室發言者", async () => {
  await withDir(async (dir) => {
    const { bot } = makeBot(dir, undefined, [TALK, SQUARE]);
    bot.botChats = [TALK];
    bot.connected = true;
    bot.fetchHistoryPage = async (chatId) => ({
      messages: chatId === SQUARE
        ? [{ messageId: "m-sq-1", senderId: ID_SQUARE, senderName: "社群群身分", channelId: SQUARE, createdAt: Date.now(), text: "大家好" }]
        : [],
      hasMore: false,
    });
    await bot.scanDecryptHealthOnce();
    const speakers = bot.chatSpeakers.get(SQUARE);
    assert.ok(speakers?.has(ID_SQUARE), "掃描要把社群群發言者記進候選名單來源");
    assert.equal(speakers.get(ID_SQUARE).name, "社群群身分");
  });
});

test("各室候選不得混室: 一般群選單沒有社群群身分, 反之亦然; 不給室不回聯集", async () => {
  await withDir(async (dir) => {
    const { bot } = makeBot(dir, undefined, [TALK, SQUARE]);
    bot.chatNames.set(TALK, "一般群");
    bot.chatNames.set(SQUARE, "社群群");
    bot.noteSpeaker({ channelId: TALK, senderId: ID_TALK, senderName: "一般群身分" });
    bot.noteSpeaker({ channelId: SQUARE, senderId: ID_SQUARE, senderName: "社群群身分" });
    const talkOnly = await bot.adminCandidates(TALK);
    assert.deepEqual(talkOnly.map((c) => c.id), [ID_TALK]);
    const squareOnly = await bot.adminCandidates(SQUARE);
    assert.deepEqual(squareOnly.map((c) => c.id), [ID_SQUARE]);
    assert.deepEqual(await bot.adminCandidates(), [], "備援聯集已廢除, 不給室就回空陣列");
  });
});

test("記 ID 不記名字: 存檔只留 ID, 改名後顯示跟著變、通知對象不變", async () => {
  await withDir(async (dir) => {
    const { bot, adminEvents } = makeBot(dir, RULES_ONLY, [TALK]);
    // 舊存檔殘留名字快照: 存進去時正規化就只留 ID。
    bot.settings.update({ ai: { chatProfiles: { [TALK]: { personaCustom: false, admins: [{ id: ID_TALK, name: "舊名" }] } } } });
    assert.deepEqual(bot.settings.get().ai.chatProfiles[TALK].admins, [{ id: ID_TALK }], "存檔不得留名字快照");
    // 同一 ID 在該室改名: 先叫舊名、後叫新名, 最新發言資料為準。
    bot.noteSpeaker({ channelId: TALK, senderId: ID_TALK, senderName: "舊名" });
    bot.noteSpeaker({ channelId: TALK, senderId: ID_TALK, senderName: "新名" });
    bot.raiseAdminEvent("scam", { chatId: TALK, chatName: "一般群", detail: "有人貼了疑似詐騙訊息。" });
    const ev = adminEvents.list().find((e) => e.chatId === TALK);
    assert.deepEqual(ev.targets.map((t) => t.adminId), [ID_TALK], "通知對象認 ID, 改名不變");
    assert.equal(ev.targets[0].name, "新名", "顯示名取最新發言資料, 不是舊快照");
    assert.equal(ev.targets[0].mode, "mention");
  });
});

test("同名不同 ID 視為不同人: 選了誰就通知誰, 不以名字合併", async () => {
  await withDir(async (dir) => {
    const { bot, adminEvents } = makeBot(dir, RULES_ONLY, [TALK]);
    const ID_OTHER = `u${"2".repeat(32)}`;
    bot.noteSpeaker({ channelId: TALK, senderId: ID_TALK, senderName: "同名" });
    bot.noteSpeaker({ channelId: TALK, senderId: ID_OTHER, senderName: "同名" });
    const list = await bot.adminCandidates(TALK);
    assert.equal(list.filter((c) => c.name === "同名").length, 2, "同名兩筆都要列出");
    bot.settings.update({ ai: { chatProfiles: { [TALK]: { personaCustom: false, admins: [{ id: ID_OTHER }] } } } });
    bot.raiseAdminEvent("scam", { chatId: TALK, chatName: "一般群", detail: "有人貼了疑似詐騙訊息。" });
    const ev = adminEvents.list().find((e) => e.chatId === TALK);
    assert.deepEqual(ev.targets.map((t) => t.adminId), [ID_OTHER]);
  });
});

test("未設管理員的室: 事件不 @ 任何人、只寫紀錄, 舊備援存檔留置不動且不被讀取", async () => {
  await withDir(async (dir) => {
    const { bot, adminEvents } = makeBot(dir, RULES_ONLY, [TALK]);
    bot.noteSpeaker({ channelId: TALK, senderId: ID_TALK, senderName: "一般群身分" });
    bot.raiseAdminEvent("scam", { chatId: TALK, chatName: "一般群", detail: "有人貼了疑似詐騙訊息。" });
    const ev = adminEvents.list().find((e) => e.chatId === TALK);
    assert.deepEqual(ev.targets, [], "沒設管理員就不 @");
    assert.equal(ev.notified, true, "事件仍要寫進紀錄");
    assert.ok(!/備援/.test(ev.message), "紀錄文字不得再提備援");
    assert.deepEqual(bot.settings.get().notify.admins, RULES_ONLY.admins, "舊備援存檔值留置不動");
  });
});

test("本室管理員 @ 可行性不變: 說過話可 @、沒說過話走寫名字", async () => {
  await withDir(async (dir) => {
    const { bot, adminEvents } = makeBot(dir, RULES_ONLY, [TALK]);
    const ID_SILENT = `u${"3".repeat(32)}`;
    bot.settings.update({ ai: { chatProfiles: { [TALK]: { personaCustom: false, admins: [{ id: ID_TALK }, { id: ID_SILENT }] } } } });
    bot.noteSpeaker({ channelId: TALK, senderId: ID_TALK, senderName: "有說話" });
    bot.raiseAdminEvent("scam", { chatId: TALK, chatName: "一般群", detail: "有人貼了疑似詐騙訊息。" });
    const ev = adminEvents.list().find((e) => e.chatId === TALK);
    assert.equal(ev.targets.find((t) => t.adminId === ID_TALK).mode, "mention");
    assert.equal(ev.targets.find((t) => t.adminId === ID_SILENT).mode, "plain");
  });
});

test("normalizeChatAdmins 只存 ID: 名字快照丟掉、重複 ID 去重、無 ID 剔除", () => {
  assert.deepEqual(
    normalizeChatAdmins([{ id: ID_TALK, name: "舊名" }, { id: ID_TALK, name: "新名" }, { name: "沒有帳號" }, null, "字串"]),
    [{ id: ID_TALK }],
  );
});

test("社群群訊息走同一條觸發路徑: 收到→觸發命中→AI 回答→回覆送到該社群群", async () => {
  await withDir(async (dir) => {
    const { bot, seen } = makeBot(dir, undefined, [SQUARE]);
    bot.selfId = "u-me";
    bot.connected = true;
    bot.botChats = [SQUARE];
    bot.chatNames.set(SQUARE, "社群群");
    bot.ai = { chat: async () => ({ content: "這是測試回答", finishReason: "stop" }) };
    const sent = [];
    const fakeWs = {
      readyState: WebSocket.OPEN,
      send(data) {
        const f = JSON.parse(data);
        if (f.type === "message:send") {
          sent.push(f);
          queueMicrotask(() => bot.onFrame(JSON.stringify({ type: "sent", requestId: f.requestId, messageId: "sent-1" })));
        }
      },
    };
    bot.ws = fakeWs;
    await bot.onMessage({
      messageId: "mid-1", channelId: SQUARE, senderId: "u-other", senderName: "群友",
      text: "AI寶 請問怎麼開檔案？", createdAt: Date.now(), contentType: "TEXT",
    });
    assert.ok(seen.info.some(([cat, msg]) => cat === "訊息接收" && msg === "收到訊息"), "問答日誌要有收到訊息");
    assert.ok(seen.info.some(([cat, msg]) => cat === "觸發判斷" && msg === "命中觸發"), "問答日誌要有觸發判斷命中");
    assert.ok(seen.info.some(([cat, msg]) => cat === "AI" && msg === "AI 回答完成"), "問答日誌要有 AI 回答完成");
    assert.equal(sent.length, 1, "回覆要送出 (只看畫面有回覆不算數, 這裡對的是送出影格)");
    assert.equal(sent[0].chatId, SQUARE, "回覆要送到同一個社群群");
    assert.equal(sent[0].replyTo, "mid-1");
    assert.match(sent[0].text, /這是測試回答/);
  });
});
