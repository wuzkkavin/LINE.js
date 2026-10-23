// 分群組隔離驗證 (2026-10-23 稽核, 老吳「分群組記憶」明令):
// 老吳實測別家的機器人會跨群回應 (別群的問題、防詐騙跑到另一個群), 本檔證明 AI寶 不會:
// 同一個人在 A 群問的問題, 到 B 群續問不得用到 A 群的內容 (對話記憶依 chatId 隔離);
// 在 B 群引用 A 群機器人的回答不得被認定成「引用機器人」而跨群觸發 (登記簿分群認定);
// A 群的詐騙警告只准出現在 A 群, 管理員事件也要記在 A 群名下。
// 搭法: 真核心 (dist 建置產物 + FakeProvider, 兩個聊天室) + 真 helper bot + 真 AdminEventStore。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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
import { AdminEventStore } from "../src/adminnotify.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { createWebServer } = await import(join(ROOT, "dist/http/server.js"));
const { createHub } = await import(join(ROOT, "dist/ws/hub.js"));
const { ApiTokenStore } = await import(join(ROOT, "dist/http/apiToken.js"));
const { LoginController } = await import(join(ROOT, "dist/line/login.js"));
const { ChatStore } = await import(join(ROOT, "dist/model/store.js"));
const { MediaService } = await import(join(ROOT, "dist/media/service.js"));

const CHAT_A = `c${"a".repeat(32)}`;
const CHAT_B = `c${"e".repeat(32)}`;

class FakeProvider {
  calls = [];
  sentMessages = [];
  historyByChat = new Map();
  seq = 0;
  async restoreSession() { return true; }
  loginQR() { return new Promise(() => {}); }
  getProfile() { return { userId: "u-me", displayName: "假測試帳號" }; }
  async fetchChannels() {
    return [
      { channelId: CHAT_A, kind: "group", name: "甲群(假)" },
      { channelId: CHAT_B, kind: "group", name: "乙群(假)" },
    ];
  }
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
  async fetchHistory(channel, limit = 100, before) {
    const all = this.historyByChat.get(channel.channelId) ?? [];
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
  outgoing(channel, fields) { return { messageId: String(1790000000000000000n + BigInt(++this.seq)), channelId: channel.channelId, channelKind: channel.kind, senderId: "u-me", senderName: "假測試帳號", contentType: "NONE", createdAt: Date.now(), ...fields }; }
  async sendText(channel, text, options) {
    this.calls.push(["text", channel, text, options]);
    const msg = this.outgoing(channel, { text, ...(options?.replyTo ? { replyTo: options.replyTo } : {}) });
    this.sentMessages.push(msg);
    return msg;
  }
  async sendFile() { throw new Error("not used"); }
  async sendSticker() { throw new Error("not used"); }
  async sendMedia() { throw new Error("not used"); }
  async unsendMessage() {}
  async react() {}
  texts() { return this.calls.filter((c) => c[0] === "text"); }
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

// AI stub: 記下每一次呼叫收到的完整 messages (供斷言 B 群的呼叫沒有混進 A 群內容);
// 回答依問題裡的專屬題目給專屬代號, 方便追蹤內容流向。
async function startAiStub(aiCalls) {
  const server = createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c);
    const body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    const messages = body.messages ?? [];
    aiCalls.push(messages.map((m) => ({ role: m.role, content: String(m.content ?? "") })));
    const all = messages.map((m) => m.content).join("\n");
    let content;
    if (all.includes("防詐騙判讀員")) {
      const high = /bit\.ly|保證獲利/.test(all);
      content = JSON.stringify(high
        ? { probability: 0.95, tactic: "假投資", reason: "含短網址與高風險話術" }
        : { probability: 0.05, tactic: "其他", reason: "看起來是一般訊息" });
    } else if (all.includes("甲群秘密題目")) content = "甲群專屬回答，代號 ZEBRA。";
    else if (all.includes("乙群專屬題目")) content = "乙群專屬回答，代號 GIRAFFE。";
    else content = "一般回答。";
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test("登記簿分群認定 (單元): 有記聊天室的條目只在原聊天室算數, 不明者維持可查", () => {
  const reg = new MessageSenderRegistry({ path: "" });
  reg.register("m-a1", "u-me", CHAT_A);
  assert.equal(reg.lookup("m-a1", CHAT_A), "u-me", "原聊天室查得到");
  assert.equal(reg.lookup("m-a1", CHAT_B), undefined, "別的聊天室查不到, 不得跨群認定");
  assert.equal(reg.lookup("m-a1"), "u-me", "不帶聊天室的舊呼叫維持原行為");
  reg.register("m-x", "u-me", ""); // 登記時聊天室不明 (例如舊資料)
  assert.equal(reg.lookup("m-x", CHAT_B), "u-me", "聊天室不明的條目無法證明屬於哪群, 維持可查");
  reg.register("m-a2", "", CHAT_A); // 負記號 (查過但查無此訊息)
  assert.equal(reg.lookup("m-a2", CHAT_A), "", "原聊天室的負記號算數");
  assert.equal(reg.lookup("m-a2", CHAT_B), undefined, "負記號也不跨群");
});

test("分群組隔離 e2e: 記憶不跨群、引用不跨群、防詐警告只回原群", async (t) => {
  const aiCalls = [];
  const stub = await startAiStub(aiCalls);
  t.after(() => stub.server.close());

  const corePort = await freePort();
  const coreRoot = await mkdtemp(join(tmpdir(), "helper-isolation-core-"));
  await writeFile(join(coreRoot, "index.html"), "<!doctype html><title>core</title>");
  const config = {
    server: { host: "127.0.0.1", port: corePort },
    history: { defaultLimit: 50 },
    chat: { sendReadReceipts: true },
    api: { enabled: true, chats: [CHAT_A, CHAT_B], sendsPerMinute: 60 },
    limits: { frameMaxBytes: 262144, textMaxLength: 8000, sendsPerSecond: 5, uploadMaxBytes: 10485760, uploadVideoMaxBytes: 52428800, uploadsPerMinute: 5 },
  };
  const provider = new FakeProvider();
  const login = new LoginController(provider);
  const store = new ChatStore(500);
  const media = new MediaService(200 * 1024 * 1024, provider);
  const apiTokens = new ApiTokenStore(join(coreRoot, "api-token.json"));
  const web = createWebServer(config, coreRoot, media, apiTokens);
  const hub = createHub({ server: web.server, authorizeUpgrade: web.authorizeUpgrade, authorizeApiUpgrade: web.authorizeApiUpgrade, apiTokens, config, login, provider, store, media, serverVersion: "isolation" });
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

  const dataDir = await mkdtemp(join(tmpdir(), "helper-isolation-data-"));
  const logger = new Logger({ dir: join(dataDir, "logs"), debug: false });
  const settings = new SettingsStore({ path: join(dataDir, "settings.json"), logger });
  settings.update({
    botName: "AI寶", aliases: [], triggerMode: "standard", cooldownSec: 0, dailyLimit: 100,
    lineApiUrl: `ws://127.0.0.1:${corePort}/api/ws`,
    ai: { active: "openai", providers: { openai: { baseUrl: stub.baseUrl, model: "stub-model" } } },
    scam: { enabled: true, threshold: 0.8, perMinute: 10 },
    notify: {
      admins: [{ id: "u-admin", name: "管理員(假)" }],
      rules: [{ id: "r-scam", kind: "scam", keyword: "", notifyAdminIds: ["u-admin"], enabled: true }],
    },
  });
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.openai, "sk-TESTKEY-isolation");
  await secrets.set(SECRET_NAMES.lineToken, token);
  const kb = new KnowledgeBase({ folder: "", indexPath: join(dataDir, "kb-index.json"), logger });
  const registry = new MessageSenderRegistry({ path: join(dataDir, "message-senders.json"), logger });
  const adminEvents = new AdminEventStore({ path: join(dataDir, "admin-events.json"), logger });
  const bot = new HelperBot({ settings, secrets, ai: createAiClient({}), kb, logger, registry, adminEvents });
  await bot.connect();
  t.after(() => bot.disconnect());
  await waitFor(() => bot.selfId === "u-me", 4000, "bot auth ready");

  const inject = (chatId, messageId, senderId, text, replyTo) => hub.handleMessage(
    { messageId, channelId: chatId, channelKind: "group", senderId, senderName: "假同事", text, contentType: "NONE", createdAt: Date.now(), ...(replyTo ? { replyTo } : {}) }, "new");
  const textsSince = (n) => provider.texts().slice(n);

  // --- 1) 對話記憶分群: 同一個人先在 A 群問, 再到 B 群問另一題 ---
  inject(CHAT_A, "1001", "u-shared", "AI寶，甲群秘密題目是什麼？");
  const ansA = await waitFor(() => provider.texts().find((c) => c[2].includes("ZEBRA")), 6000, "A 群回答");
  assert.equal(ansA[1].channelId, CHAT_A, "A 群的回答要送回 A 群");
  assert.ok(JSON.stringify(bot.memory.get(CHAT_A)).includes("ZEBRA"), "A 群記憶應含 A 群問答");
  assert.ok(!bot.memory.get(CHAT_B)?.length, "B 群記憶此時應為空");

  inject(CHAT_B, "2001", "u-shared", "AI寶，乙群專屬題目是什麼？");
  const ansB = await waitFor(() => provider.texts().find((c) => c[2].includes("GIRAFFE")), 6000, "B 群回答");
  assert.equal(ansB[1].channelId, CHAT_B, "B 群的回答要送回 B 群");
  const callB = aiCalls.find((msgs) => msgs.some((m) => m.role === "user" && m.content.includes("乙群專屬題目")));
  assert.ok(callB, "應找得到 B 群那次 AI 呼叫");
  const callBText = callB.map((m) => m.content).join("\n");
  assert.ok(!callBText.includes("甲群秘密題目"), "B 群的 AI 呼叫不得帶入 A 群的問題");
  assert.ok(!callBText.includes("ZEBRA"), "B 群的 AI 呼叫不得帶入 A 群的回答");
  assert.ok(!JSON.stringify(bot.memory.get(CHAT_B)).includes("ZEBRA"), "B 群記憶不得含 A 群內容");

  // --- 2) 引用不跨群: 在 B 群引用 A 群機器人的回答, 不得觸發; 原群引用照常 ---
  const botAnswerA = provider.sentMessages.find((m) => m.channelId === CHAT_A);
  const botAnswerB = provider.sentMessages.find((m) => m.channelId === CHAT_B);
  assert.ok(botAnswerA?.messageId && botAnswerB?.messageId, "應取得兩群各自的機器人回答");
  await sleep(500); // 等 sent 影格/廣播把兩則回答登記進登記簿
  assert.equal(bot.registry.lookup(botAnswerA.messageId, CHAT_A), "u-me", "A 群回答在 A 群認得");
  assert.equal(bot.registry.lookup(botAnswerA.messageId, CHAT_B), undefined, "A 群回答在 B 群不得被認定");

  let base = provider.texts().length;
  inject(CHAT_B, "2002", "u-other", "那後續呢", botAnswerA.messageId);
  await sleep(1000);
  assert.equal(textsSince(base).length, 0, "在 B 群引用 A 群的回答不得觸發任何回覆");
  assert.equal(bot.registry.lookup(botAnswerA.messageId, CHAT_A), "u-me", "跨群引用嘗試後, A 群的登記不得被覆寫掉");

  base = provider.texts().length;
  inject(CHAT_B, "2003", "u-other", "那後續呢", botAnswerB.messageId);
  await waitFor(() => textsSince(base).find((c) => c[1].channelId === CHAT_B && c[3]?.replyTo === "2003"), 6000, "B 群引用自己群的回答應觸發");
  base = provider.texts().length;
  inject(CHAT_A, "1002", "u-other", "那後續呢", botAnswerA.messageId);
  await waitFor(() => textsSince(base).find((c) => c[1].channelId === CHAT_A && c[3]?.replyTo === "1002"), 6000, "A 群引用自己群的回答應觸發");

  // --- 3) 防詐警告只回原群: A 群的詐騙訊息, 警告只進 A 群, 事件記在 A 群 ---
  base = provider.texts().length;
  inject(CHAT_A, "1009", "u-scammer", "好康報你知 https://bit.ly/xyz999 加入飆股群，保證獲利翻倍");
  const warning = await waitFor(() => textsSince(base).find((c) => c[2].includes("防詐騙警告")), 6000, "A 群詐騙警告");
  assert.equal(warning[1].channelId, CHAT_A, "警告要送回訊息所在的 A 群");
  assert.ok(!textsSince(base).some((c) => c[1].channelId === CHAT_B), "A 群的詐騙警告不得出現在 B 群");
  const scamEvent = await waitFor(() => adminEvents.list().find((e) => e.kind === "scam"), 6000, "詐騙管理員事件");
  assert.equal(scamEvent.chatId, CHAT_A, "詐騙事件要記在 A 群名下");
});
