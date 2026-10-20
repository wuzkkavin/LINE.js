import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Logger } from "../src/logger.mjs";
import { MemorySecretStore } from "../src/secrets.mjs";
import { SettingsStore, SECRET_NAMES } from "../src/config.mjs";
import { createAiClient } from "../src/ai.mjs";
import { KnowledgeBase } from "../src/kb.mjs";
import { HelperBot } from "../src/bot.mjs";
import { MessageSenderRegistry } from "../src/msgregistry.mjs";

// 引用續答 e2e: 真核心 hub (FakeProvider) + 真 helper bot, 驗證:
// 引用機器人自己的回答追問會觸發、引用別人的不觸發、連線前就存在的訊息靠 history 補查認定。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { createWebServer } = await import(join(ROOT, "dist/http/server.js"));
const { createHub } = await import(join(ROOT, "dist/ws/hub.js"));
const { ApiTokenStore } = await import(join(ROOT, "dist/http/apiToken.js"));
const { LoginController } = await import(join(ROOT, "dist/line/login.js"));
const { ChatStore } = await import(join(ROOT, "dist/model/store.js"));
const { MediaService } = await import(join(ROOT, "dist/media/service.js"));

const CHAT = `c${"a".repeat(32)}`;
const TEST_KEY = "sk-TESTKEY-quote-000000abcd";

class FakeProvider {
  calls = [];
  sentMessages = []; // sendText 回傳的完整訊息 (含 messageId), 供測試引用
  fileSends = []; // sendFile 收到的 (filename, bytes), 供長答覆測試斷言
  historyMessages = [];
  fetchHistoryCalls = 0;
  seq = 0;
  async restoreSession() { return true; }
  loginQR() { return new Promise(() => {}); }
  getProfile() { return { userId: "u-me", displayName: "假測試帳號" }; }
  async fetchChannels() { return [{ channelId: CHAT, kind: "group", name: "公司學習群(假)" }]; }
  async logout() { return { remoteRevoked: true }; }
  async close() {}
  async fetchSticker() { return undefined; }
  async fetchAvatar() { return undefined; }
  async fetchMessageMedia() { return undefined; }
  async fetchMessageFile() { return undefined; }
  async fetchStickerPackages() { return []; }
  async fetchStickerPack() { return undefined; }
  async markRead() {}
  async fetchReadPositions() { return []; }
  // 比照真實 provider 的分頁契約 (src/line/provider.ts): historyMessages 依時間舊到新排列,
  // 每頁回最近的 limit 則 (頁內舊到新), cursor 是該頁最舊一則的 createdAt:messageId,
  // 下一頁從 cursor 的前一則開始 (錨點本身剔除), 還有更舊的才 hasMore。
  async fetchHistory(channel, limit = 100, before) {
    this.fetchHistoryCalls++;
    const all = this.historyMessages;
    let end = all.length;
    if (before) {
      const anchorId = String(before).split(":").pop();
      const idx = all.findIndex((x) => x.messageId === anchorId);
      if (idx >= 0) end = idx;
    }
    const start = Math.max(0, end - limit);
    const messages = all.slice(start, end);
    const oldest = messages[0];
    return { messages, hasMore: start > 0, ...(start > 0 && oldest ? { cursor: `${oldest.createdAt}:${oldest.messageId}` } : {}) };
  }
  // 送出訊息的 ID 用真實形狀: LINE 的訊息 ID 是 19 位數字字串 (舊版用 "mid-N" 這種玩具 ID,
  // 與實機不同形, 曾讓 e2e 全綠但實機失效的落差藏在 ID 形狀裡; 改成數字字串讓所有情境同形)。
  outgoing(channel, fields) { return { messageId: String(1790000000000000000n + BigInt(++this.seq)), channelId: channel.channelId, channelKind: channel.kind, senderId: "u-me", senderName: "假測試帳號", contentType: "NONE", createdAt: Date.now(), ...fields }; }
  async sendText(channel, text, options) {
    this.calls.push(["text", channel, text, options]);
    const msg = this.outgoing(channel, { text, ...(options?.replyTo ? { replyTo: options.replyTo } : {}) });
    this.sentMessages.push(msg);
    return msg;
  }
  async sendFile(channel, filename, bytes) {
    this.calls.push(["file", channel, filename, bytes]);
    this.fileSends.push({ channel, filename, bytes: Buffer.from(bytes) });
    const msg = this.outgoing(channel, { contentType: "FILE", card: { kind: "file", name: filename, size: bytes.length } });
    this.sentMessages.push(msg);
    return msg;
  }
  async sendSticker() { throw new Error("not used"); }
  async sendMedia() { throw new Error("not used"); }
  async unsendMessage() {}
  async react() {}
  texts() { return this.calls.filter((c) => c[0] === "text"); }
  files() { return this.calls.filter((c) => c[0] === "file"); }
}

function freePort() {
  return new Promise((resolve) => {
    const p = createNetServer();
    p.listen(0, "127.0.0.1", () => { const port = p.address().port; p.close(() => resolve(port)); });
  });
}
function connectWs(port, headers, path) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
  const frames = []; const waiters = [];
  socket.on("message", (d) => { const f = JSON.parse(d.toString()); frames.push(f); for (const w of [...waiters]) w(); });
  const until = (pred, timeout = 4000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout; saw " + frames.map((f) => f.type))), timeout);
    const check = () => { const hit = frames.find(pred); if (!hit) return; clearTimeout(timer); resolve(hit); };
    waiters.push(check); check();
  });
  const opened = new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  return { socket, frames, until, opened };
}
async function waitFor(fn, timeout = 6000, label = "condition") {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error("waitFor timeout: " + label);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 超過一則訊息字數上限 (8000 字) 的長回答: 23 字 * 400 = 9200 字, 供「改送文字檔」情境斷言內容完整。
const LONG_ANSWER = "這是一段完整的長回答內容, 用來驗證改送文字檔。".repeat(400);

async function startAiStub() {
  const server = createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c);
    const body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    const all = (body.messages ?? []).map((m) => m.content).join("\n");
    let content;
    if (all.includes("長篇報告")) content = LONG_ANSWER;
    else if (all.includes("凍結窗格")) content = "凍結窗格步驟:先選儲存格, 再到檢視按凍結窗格。";
    else content = "這是 AI stub 的一般回答。";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test("e2e 引用續答: 引用自己的回答觸發、引用別人不觸發、history 補查認定", async (t) => {
  const stub = await startAiStub();
  t.after(() => stub.server.close());

  const corePort = await freePort();
  const coreRoot = await mkdtemp(join(tmpdir(), "helper-quote-core-"));
  await writeFile(join(coreRoot, "index.html"), "<!doctype html><title>core</title>");
  const config = {
    server: { host: "127.0.0.1", port: corePort },
    history: { defaultLimit: 50 },
    chat: { sendReadReceipts: true },
    api: { enabled: true, chats: [CHAT], sendsPerMinute: 60 },
    limits: { frameMaxBytes: 262144, textMaxLength: 8000, sendsPerSecond: 5, uploadMaxBytes: 10485760, uploadVideoMaxBytes: 52428800, uploadsPerMinute: 5 },
  };
  const provider = new FakeProvider();
  const login = new LoginController(provider);
  const store = new ChatStore(500);
  const media = new MediaService(200 * 1024 * 1024, provider);
  const apiTokens = new ApiTokenStore(join(coreRoot, "api-token.json"));
  const web = createWebServer(config, coreRoot, media, apiTokens);
  const hub = createHub({ server: web.server, authorizeUpgrade: web.authorizeUpgrade, authorizeApiUpgrade: web.authorizeApiUpgrade, apiTokens, config, login, provider, store, media, serverVersion: "e2e" });
  await new Promise((r) => web.server.listen(corePort, "127.0.0.1", r));
  t.after(async () => { hub.close(); web.server.closeAllConnections(); await new Promise((r) => web.server.close(r)); });
  await login.restore();
  const cookie = (await fetch(`http://127.0.0.1:${corePort}/`)).headers.get("set-cookie").split(";")[0];
  const page = connectWs(corePort, { Origin: `http://127.0.0.1:${corePort}`, Cookie: cookie }, "/ws");
  await page.opened;
  await page.until((f) => f.type === "api:state");
  page.socket.send(JSON.stringify({ type: "api:token:create" }));
  const { token } = await page.until((f) => f.type === "api:token");
  page.socket.close();

  const dataDir = await mkdtemp(join(tmpdir(), "helper-quote-data-"));
  const logger = new Logger({ dir: join(dataDir, "logs"), debug: false });
  const settings = new SettingsStore({ path: join(dataDir, "settings.json"), logger });
  settings.update({
    botName: "AI寶", aliases: [], triggerMode: "standard", cooldownSec: 0, dailyLimit: 100,
    lineApiUrl: `ws://127.0.0.1:${corePort}/api/ws`,
    ai: { active: "openai", providers: { openai: { baseUrl: stub.baseUrl, model: "stub-model" } } },
    scam: { enabled: false, threshold: 0.8, perMinute: 10 },
    kb: { folder: "" },
  });
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.openai, TEST_KEY);
  await secrets.set(SECRET_NAMES.lineToken, token);
  const kb = new KnowledgeBase({ folder: "", indexPath: join(dataDir, "kb-index.json"), logger });
  const registry = new MessageSenderRegistry({ path: join(dataDir, "message-senders.json"), logger });
  const bot = new HelperBot({ settings, secrets, ai: createAiClient({}), kb, logger, registry });
  await bot.connect();
  t.after(() => bot.disconnect());
  await waitFor(() => bot.selfId === "u-me", 4000, "bot auth ready");

  const inject = (messageId, senderId, text, replyTo) => hub.handleMessage({ messageId, channelId: CHAT, channelKind: "group", senderId, senderName: "假同事", text, contentType: "NONE", createdAt: Date.now(), ...(replyTo ? { replyTo } : {}) }, "new");
  const textsSince = (n) => provider.texts().slice(n);

  // 1) 一般觸發先拿到機器人的一則回答, 之後引用它
  let base = provider.texts().length;
  inject("101", "u-a", "AI寶，Excel 怎麼凍結窗格？");
  const first = await waitFor(() => textsSince(base).find((c) => c[2].includes("凍結窗格步驟")), 6000, "first answer");
  assert.equal(first[3]?.replyTo, "101");
  const botAnswer = provider.sentMessages[provider.sentMessages.length - 1];
  assert.ok(botAnswer.messageId, "應取得機器人回答的 messageId");
  await sleep(400); // 等 sent 影格把回答 ID 登記進登記簿

  // 2) 引用機器人的回答追問 (不打名字、沒有問句提示詞): 要觸發續答
  base = provider.texts().length;
  inject("102", "u-b", "那 Word 呢", botAnswer.messageId);
  const follow = await waitFor(() => textsSince(base).find((c) => c[3]?.replyTo === "102"), 6000, "quote follow-up answer");
  assert.ok(follow[2].length > 0);

  // 3) 引用別人的訊息 (不打名字): 不觸發
  inject("201", "u-c", "我的投影片做好了, 明天報告用");
  await sleep(300);
  base = provider.texts().length;
  inject("202", "u-d", "這段說得有道理", "201");
  await sleep(800);
  assert.equal(textsSince(base).length, 0, "引用別人的訊息不應觸發");

  // 4) 引用連線前就存在的訊息: 登記簿沒有, 靠 history 補查認定
  provider.historyMessages = [
    { messageId: "900", channelId: CHAT, channelKind: "group", senderId: "u-me", senderName: "假測試帳號", text: "稍早機器人的回答", contentType: "NONE", createdAt: Date.now() - 3600000 },
    { messageId: "901", channelId: CHAT, channelKind: "group", senderId: "u-other", senderName: "別人", text: "稍早別人的訊息", contentType: "NONE", createdAt: Date.now() - 3500000 },
  ];
  base = provider.texts().length;
  inject("301", "u-e", "可以再說明一次嗎", "900");
  await waitFor(() => textsSince(base).find((c) => c[3]?.replyTo === "301"), 6000, "history quote-self answer");
  assert.ok(provider.fetchHistoryCalls >= 1, "應有向核心補查歷史");
  // 引用歷史裡別人的訊息: 不觸發, 而且第二次引用同則不應再補查 (已登記)
  const callsBefore = provider.fetchHistoryCalls;
  base = provider.texts().length;
  inject("302", "u-f", "這是什麼意思呢", "901");
  await sleep(800);
  assert.equal(textsSince(base).length, 0, "引用歷史裡別人的訊息不應觸發");
  assert.equal(provider.fetchHistoryCalls, callsBefore, "901 已在前次補查時整頁登記, 不應重查");

  // 5) 引用自己的回答但追問文字為空: 不觸發
  base = provider.texts().length;
  inject("401", "u-g", "", botAnswer.messageId);
  await sleep(800);
  assert.equal(textsSince(base).length, 0, "引用但文字為空不應觸發");

  // 7) 灌入大量他人訊息 (修復批次一第 6 項情境): 機器人回答後, 同聊天室再灌 2100 則他人訊息 —
  // 超過舊登記簿上限 2000 筆 (舊版會把機器人的回答擠出登記簿) 也超過舊補查範圍 2 頁 (200 則)。
  // 新版上限加大後, 引用該回答追問仍應觸發續答。
  const FLOOD = 2100;
  for (let i = 0; i < FLOOD; i++) {
    inject(String(500000 + i), "u-flood", `閒聊訊息 ${i}`);
  }
  await waitFor(() => bot.registry.lookup(String(500000 + FLOOD - 1)) === "u-flood", 20000, "flood messages registered");
  assert.equal(bot.registry.lookup(botAnswer.messageId), "u-me", "灌入 2100 則後, 機器人回答應仍在登記簿 (舊上限 2000 會被擠出)");
  base = provider.texts().length;
  inject("601", "u-h", "那 Word 呢", botAnswer.messageId);
  await waitFor(() => textsSince(base).find((c) => c[3]?.replyTo === "601"), 8000, "quote after flood answer");

  // 8) 深頁補查: 被引用的機器人訊息只存在於歷史、且被 349 則較新的訊息壓在第 4 頁 (舊版只查 2 頁找不到)。
  // 登記簿裡沒有它 (從未以即時訊息出現、補登也發生在設定這批歷史之前), 引用時靠加深到 5 頁的補查命中。
  const deepBotId = "200001";
  provider.historyMessages = [
    { messageId: deepBotId, channelId: CHAT, channelKind: "group", senderId: "u-me", senderName: "假測試帳號", text: "很久以前機器人的回答", contentType: "NONE", createdAt: 1000000 },
    ...Array.from({ length: 349 }, (_, i) => ({ messageId: String(200002 + i), channelId: CHAT, channelKind: "group", senderId: "u-other", senderName: "別人", text: `歷史訊息 ${i}`, contentType: "NONE", createdAt: 1001000 + i * 1000 })),
  ];
  assert.equal(bot.registry.lookup(deepBotId), undefined, "深頁訊息不應在登記簿裡 (本情境專測歷史補查)");
  const deepCallsBefore = provider.fetchHistoryCalls;
  base = provider.texts().length;
  inject("701", "u-i", "可以再說明一次嗎", deepBotId);
  await waitFor(() => textsSince(base).find((c) => c[3]?.replyTo === "701"), 8000, "deep history quote answer");
  assert.ok(provider.fetchHistoryCalls - deepCallsBefore >= 4, `補查應深入到至少第 4 頁, 實際打了 ${provider.fetchHistoryCalls - deepCallsBefore} 頁 (舊版 2 頁會找不到)`);

  // 9) 連線後主動補登: 歷史裡有一則機器人訊息從未被引用過; bot 重連後, 不等任何人引用,
  // 補登就應把它登記進登記簿; 之後引用它追問直接命中登記簿, 不需再向核心補查。
  const prefetchId = "300001";
  provider.historyMessages = [
    { messageId: prefetchId, channelId: CHAT, channelKind: "group", senderId: "u-me", senderName: "假測試帳號", text: "重連前機器人的回答", contentType: "NONE", createdAt: 2000000 },
  ];
  assert.equal(bot.registry.lookup(prefetchId), undefined);
  bot.disconnect();
  await bot.connect();
  await waitFor(() => bot.selfId === "u-me", 4000, "bot reconnected");
  await waitFor(() => bot.registry.lookup(prefetchId) === "u-me", 6000, "prefetch registered after reconnect");
  const prefetchCallsBefore = provider.fetchHistoryCalls;
  base = provider.texts().length;
  inject("801", "u-j", "那後來呢", prefetchId);
  await waitFor(() => textsSince(base).find((c) => c[3]?.replyTo === "801"), 8000, "prefetched quote answer");
  assert.equal(provider.fetchHistoryCalls, prefetchCallsBefore, "已補登的訊息被引用時不應再向核心補查");

  // 6) 登記簿已持久化: 檔案存在且含機器人回答 ID
  bot.disconnect();
  const saved = JSON.parse(await readFile(join(dataDir, "message-senders.json"), "utf8"));
  const ids = saved.entries.map((e) => e[0]);
  assert.ok(ids.includes(botAnswer.messageId), "登記簿檔案應含機器人回答的 ID");
});

// --- 以下為 2026-10-20 驗收修復新增的「與實機同形」情境 ---
// bootWorld: 與第一個測試相同的真核心 + 真 bot 組裝, 抽出來給新情境共用;
// settings 可覆寫 (冷卻秒數等), dataDir 可指定 (跨連線時段情境要共用同一個登記簿檔案)。
async function bootWorld(t, { settingOverrides = {}, dataDir } = {}) {
  const stub = await startAiStub();
  t.after(() => stub.server.close());
  const corePort = await freePort();
  const coreRoot = await mkdtemp(join(tmpdir(), "helper-quote2-core-"));
  await writeFile(join(coreRoot, "index.html"), "<!doctype html><title>core</title>");
  const config = {
    server: { host: "127.0.0.1", port: corePort },
    history: { defaultLimit: 50 },
    chat: { sendReadReceipts: true },
    api: { enabled: true, chats: [CHAT], sendsPerMinute: 60 },
    limits: { frameMaxBytes: 262144, textMaxLength: 8000, sendsPerSecond: 5, uploadMaxBytes: 10485760, uploadVideoMaxBytes: 52428800, uploadsPerMinute: 5 },
  };
  const provider = new FakeProvider();
  const login = new LoginController(provider);
  const store = new ChatStore(500);
  const media = new MediaService(200 * 1024 * 1024, provider);
  const apiTokens = new ApiTokenStore(join(coreRoot, "api-token.json"));
  const web = createWebServer(config, coreRoot, media, apiTokens);
  const hub = createHub({ server: web.server, authorizeUpgrade: web.authorizeUpgrade, authorizeApiUpgrade: web.authorizeApiUpgrade, apiTokens, config, login, provider, store, media, serverVersion: "e2e" });
  await new Promise((r) => web.server.listen(corePort, "127.0.0.1", r));
  t.after(async () => { hub.close(); web.server.closeAllConnections(); await new Promise((r) => web.server.close(r)); });
  await login.restore();
  const cookie = (await fetch(`http://127.0.0.1:${corePort}/`)).headers.get("set-cookie").split(";")[0];
  const page = connectWs(corePort, { Origin: `http://127.0.0.1:${corePort}`, Cookie: cookie }, "/ws");
  await page.opened;
  await page.until((f) => f.type === "api:state");
  page.socket.send(JSON.stringify({ type: "api:token:create" }));
  const { token } = await page.until((f) => f.type === "api:token");
  page.socket.close();

  const dir = dataDir ?? await mkdtemp(join(tmpdir(), "helper-quote2-data-"));
  const logger = new Logger({ dir: join(dir, "logs"), debug: false });
  const settings = new SettingsStore({ path: join(dir, "settings.json"), logger });
  settings.update({
    botName: "AI寶", aliases: [], triggerMode: "standard", cooldownSec: 0, dailyLimit: 100,
    lineApiUrl: `ws://127.0.0.1:${corePort}/api/ws`,
    ai: { active: "openai", providers: { openai: { baseUrl: stub.baseUrl, model: "stub-model" } } },
    scam: { enabled: false, threshold: 0.8, perMinute: 10 },
    kb: { folder: "" },
    ...settingOverrides,
  });
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.openai, TEST_KEY);
  await secrets.set(SECRET_NAMES.lineToken, token);
  const kb = new KnowledgeBase({ folder: "", indexPath: join(dir, "kb-index.json"), logger });
  const makeBot = () => {
    const registry = new MessageSenderRegistry({ path: join(dir, "message-senders.json"), logger });
    return { bot: new HelperBot({ settings, secrets, ai: createAiClient({}), kb, logger, registry }), registry };
  };
  const inject = (messageId, senderId, text, replyTo) => hub.handleMessage({ messageId, channelId: CHAT, channelKind: "group", senderId, senderName: "假同事", text, contentType: "NONE", createdAt: Date.now(), ...(replyTo ? { replyTo } : {}) }, "new");
  return { provider, hub, settings, makeBot, inject, dataDir: dir };
}

test("e2e 實機同形: 冷卻 20 秒下, 引導不吃冷卻、引用續答不被冷卻擋、名字連發仍被擋", async (t) => {
  // 情境還原老吳 2026-10-20 21:23-21:28 的操作節奏 (同一人、同一分鐘內連續操作):
  // 先只打名字拿到引導, 馬上問真正的問題, 再立刻引用機器人的回答追問 (不打名字)。
  // 舊行為: 引導與引用都吃 20 秒冷卻, 後兩步會被靜默擋下, 看起來像機器人壞掉。
  const w = await bootWorld(t, { settingOverrides: { cooldownSec: 20 } });
  const { bot } = w.makeBot();
  await bot.connect();
  t.after(() => bot.disconnect());
  await waitFor(() => bot.selfId === "u-me", 4000, "bot auth ready");
  const texts = () => w.provider.texts();
  const U = "u-wu";
  const ID = (n) => String(1790000000000010000n + BigInt(n));

  // 1) 只打名字 -> 引導訊息
  w.inject(ID(1), U, "AI寶");
  await waitFor(() => texts().find((c) => c[3]?.replyTo === ID(1)), 6000, "guidance reply");
  // 2) 緊接著 (冷卻窗內) 問真正的問題 -> 必須回答 (引導沒有吃掉冷卻)
  w.inject(ID(2), U, "AI寶，Excel 怎麼凍結窗格？");
  const answer = await waitFor(() => texts().find((c) => c[2].includes("凍結窗格步驟") && c[3]?.replyTo === ID(2)), 6000, "answer after guidance");
  const botAnswer = w.provider.sentMessages[w.provider.sentMessages.length - 1];
  assert.match(botAnswer.messageId, /^\d{19}$/, "機器人回答 ID 應為真實形狀的 19 位數字");
  await sleep(300); // 等 sent 影格登記
  // 3) 立刻引用該回答追問 (不打名字) -> 冷卻窗內仍必須續答
  w.inject(ID(3), U, "接續上文, 繼續", botAnswer.messageId);
  await waitFor(() => texts().find((c) => c[3]?.replyTo === ID(3)), 6000, "quote follow-up inside cooldown");
  // 4) 緊接著用名字再問一題 -> 冷卻仍然有效, 不應回答 (防連珠炮洗版不變)
  const beforeCount = texts().length;
  w.inject(ID(4), U, "AI寶，問題三是什麼？");
  await sleep(1500);
  assert.equal(texts().length, beforeCount, "冷卻窗內的名字連發仍應被擋下");
});

test("e2e 實機同形: 引用前一個連線時段的回答 (只剩磁碟登記簿、歷史查不到) 仍能續答", async (t) => {
  // 老吳的實機形狀: 回答是機器人在先前連線時段送出的 (App 重開/引擎重啟後, 記憶體登記簿是空的),
  // 引用當下核心歷史也補查不到那則 (已被更舊的頁面之外或歷史清空), 只剩磁碟上的登記簿認得它。
  const dataDir = await mkdtemp(join(tmpdir(), "helper-quote-prev-"));
  const w = await bootWorld(t, { dataDir });
  const first = w.makeBot();
  await first.bot.connect();
  await waitFor(() => first.bot.selfId === "u-me", 4000, "bot1 auth ready");
  w.inject("1790000000000020001", "u-wu", "AI寶，Excel 怎麼凍結窗格？");
  await waitFor(() => w.provider.texts().find((c) => c[2].includes("凍結窗格步驟")), 6000, "session-1 answer");
  const botAnswer = w.provider.sentMessages[w.provider.sentMessages.length - 1];
  await sleep(300);
  first.bot.disconnect(); // 正常結束: 登記簿 flush 到磁碟

  // 第二個連線時段: 全新 bot 實例 (全新記憶體登記簿, 從磁碟載入), 核心歷史是空的
  const second = w.makeBot();
  assert.equal(second.registry.lookup(botAnswer.messageId), "u-me", "重開後應從磁碟登記簿認出先前的回答");
  w.provider.historyMessages = [];
  await second.bot.connect();
  t.after(() => second.bot.disconnect());
  await waitFor(() => second.bot.selfId === "u-me", 4000, "bot2 auth ready");
  await waitFor(() => second.bot.historyPrefetchedChats.has(CHAT), 6000, "prefetch done");
  const callsBefore = w.provider.fetchHistoryCalls;
  const base = w.provider.texts().length;
  w.inject("1790000000000020002", "u-wu", "那 Word 呢", botAnswer.messageId);
  await waitFor(() => w.provider.texts().slice(base).find((c) => c[3]?.replyTo === "1790000000000020002"), 6000, "cross-session quote answer");
  assert.equal(w.provider.fetchHistoryCalls, callsBefore, "磁碟登記簿命中時不應再向核心補查歷史");
});

test("e2e 長回答: 超過 8000 字改送文字檔 (白話說明 + 檔案內容完整), 不再整則消失或被拒收", async (t) => {
  const w = await bootWorld(t);
  const { bot } = w.makeBot();
  await bot.connect();
  t.after(() => bot.disconnect());
  await waitFor(() => bot.selfId === "u-me", 4000, "bot auth ready");
  assert.ok(LONG_ANSWER.length > 8000, "測試用的長回答必須真的超過文字上限");
  w.inject("1790000000000030001", "u-wu", "AI寶，請給我一份長篇報告");
  // 先有一句白話說明 (以 reply 形式), 說明裡點名檔案
  const notice = await waitFor(() => w.provider.texts().find((c) => c[2].includes("文字檔") && c[3]?.replyTo === "1790000000000030001"), 8000, "file notice text");
  assert.match(notice[2], /AI寶回答-\d{8}-.+\.txt/);
  // 再送出檔案本體: 檔名同說明所述, 位元組解開就是完整回答 (一字不缺)
  const file = await waitFor(() => w.provider.fileSends[0], 8000, "answer file sent");
  assert.match(file.filename, /^AI寶回答-\d{8}-.+\.txt$/);
  assert.equal(file.bytes.toString("utf8"), LONG_ANSWER, "檔案內容必須是完整回答");
  // 長回答本體不曾以單則文字送出 (那會被核心以超過 textMaxLength 拒收)
  assert.equal(w.provider.texts().some((c) => c[2].length > 8000), false, "不得把超長回答硬塞單則文字");
});
