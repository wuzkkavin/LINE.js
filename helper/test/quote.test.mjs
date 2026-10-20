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
  async fetchHistory() { this.fetchHistoryCalls++; return { messages: this.historyMessages, hasMore: false }; }
  outgoing(channel, fields) { return { messageId: `mid-${++this.seq}`, channelId: channel.channelId, channelKind: channel.kind, senderId: "u-me", senderName: "假測試帳號", contentType: "NONE", createdAt: Date.now(), ...fields }; }
  async sendText(channel, text, options) {
    this.calls.push(["text", channel, text, options]);
    const msg = this.outgoing(channel, { text, ...(options?.replyTo ? { replyTo: options.replyTo } : {}) });
    this.sentMessages.push(msg);
    return msg;
  }
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

async function startAiStub() {
  const server = createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c);
    const body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    const all = (body.messages ?? []).map((m) => m.content).join("\n");
    let content;
    if (all.includes("凍結窗格")) content = "凍結窗格步驟:先選儲存格, 再到檢視按凍結窗格。";
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

  // 6) 登記簿已持久化: 檔案存在且含機器人回答 ID
  bot.disconnect();
  const saved = JSON.parse(await readFile(join(dataDir, "message-senders.json"), "utf8"));
  const ids = saved.entries.map((e) => e[0]);
  assert.ok(ids.includes(botAnswer.messageId), "登記簿檔案應含機器人回答的 ID");
});
