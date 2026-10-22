// 全訊息監控驗證 (2026-10-22 修復, 老吳明令): 防詐騙與管理員關鍵字監控必須看
// 白名單群裡的「每一則」真人訊息, 不是只有提到機器人名字的才看。
// 情境: 訊息完全沒提 AI寶、也沒有問句 — 關鍵字事件照樣要記錄、詐騙照樣要判讀警告;
// 機器人自己發的訊息不監控 (避免自己警告自己)。
// 搭法: 真核心 (dist 建置產物 + FakeProvider) + 真 helper bot + 真 AdminEventStore。
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
import { AdminEventStore } from "../src/adminnotify.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { createWebServer } = await import(join(ROOT, "dist/http/server.js"));
const { createHub } = await import(join(ROOT, "dist/ws/hub.js"));
const { ApiTokenStore } = await import(join(ROOT, "dist/http/apiToken.js"));
const { LoginController } = await import(join(ROOT, "dist/line/login.js"));
const { ChatStore } = await import(join(ROOT, "dist/model/store.js"));
const { MediaService } = await import(join(ROOT, "dist/media/service.js"));

const CHAT = `c${"b".repeat(32)}`;

class FakeProvider {
  calls = [];
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
  async fetchHistory() { return { messages: [], hasMore: false }; }
  outgoing(channel, fields) { return { messageId: `sent-${this.calls.length}`, channelId: channel.channelId, channelKind: channel.kind, senderId: "u-me", senderName: "假測試帳號", contentType: "NONE", createdAt: Date.now(), ...fields }; }
  async sendText(channel, text, options) { this.calls.push(["text", channel, text, options]); return this.outgoing(channel, { text, ...(options?.replyTo ? { replyTo: options.replyTo } : {}) }); }
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
    if (all.includes("防詐騙判讀員")) {
      const high = /保證獲利|解除分期|bit\.ly|飆股/.test(all);
      content = JSON.stringify(high
        ? { probability: 0.95, tactic: "假投資", reason: "含短網址與高風險話術" }
        : { probability: 0.05, tactic: "其他", reason: "看起來是一般公告" });
    } else {
      content = "這是 AI stub 的一般回答。";
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test("全訊息監控: 沒提機器人名字的訊息, 關鍵字事件照記、詐騙照判讀; 自己的訊息不監控", async (t) => {
  const stub = await startAiStub();
  t.after(() => stub.server.close());

  const corePort = await freePort();
  const coreRoot = await mkdtemp(join(tmpdir(), "helper-monitor-core-"));
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
  const hub = createHub({ server: web.server, authorizeUpgrade: web.authorizeUpgrade, authorizeApiUpgrade: web.authorizeApiUpgrade, apiTokens, config, login, provider, store, media, serverVersion: "monitor" });
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

  const dataDir = await mkdtemp(join(tmpdir(), "helper-monitor-data-"));
  const logger = new Logger({ dir: join(dataDir, "logs"), debug: false });
  const settings = new SettingsStore({ path: join(dataDir, "settings.json"), logger });
  settings.update({
    botName: "AI寶", aliases: [], triggerMode: "standard", cooldownSec: 0, dailyLimit: 100,
    lineApiUrl: `ws://127.0.0.1:${corePort}/api/ws`,
    ai: { active: "openai", providers: { openai: { baseUrl: stub.baseUrl, model: "stub-model" } } },
    scam: { enabled: true, threshold: 0.8, perMinute: 10 },
    notify: {
      admins: [{ id: "u-admin", name: "老吳(假)" }],
      rules: [
        { id: "r1", kind: "keyword", keyword: "報價", notifyAdminIds: ["u-admin"], enabled: true },
        { id: "r2", kind: "scam", keyword: "", notifyAdminIds: ["u-admin"], enabled: true },
      ],
    },
  });
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.openai, "sk-TESTKEY-monitor");
  await secrets.set(SECRET_NAMES.lineToken, token);
  const kb = new KnowledgeBase({ folder: "", indexPath: join(dataDir, "kb-index.json"), logger });
  const adminEvents = new AdminEventStore({ path: join(dataDir, "admin-events.json"), logger });
  const bot = new HelperBot({ settings, secrets, ai: createAiClient({}), kb, logger, adminEvents });
  await bot.connect();
  t.after(() => bot.disconnect());
  await waitFor(() => bot.selfId === "u-me", 4000, "bot auth ready");

  const inject = (messageId, senderId, text) => hub.handleMessage({ messageId, channelId: CHAT, channelKind: "group", senderId, senderName: "假同事", text, contentType: "NONE", createdAt: Date.now() }, "new");

  // 1) 沒提名字、不是問句, 只含關鍵字: 關鍵字事件要被記錄 (舊疑點: 只有觸發問答的訊息才進監控)
  inject("201", "u-a", "這是廠商給的報價單, 大家參考一下");
  const kwEvent = await waitFor(() => adminEvents.list().find((e) => e.kind === "keyword"), 6000, "keyword event for untriggered message");
  assert.equal(kwEvent.notified, true);
  assert.equal(provider.texts().length, 0, "沒提名字不應觸發問答回覆");

  // 2) 沒提名字的詐騙訊息: 照樣判讀、發警告, 並產生詐騙警報事件通知管理員
  inject("202", "u-b", "好康報你知 https://bit.ly/xyz999 加入飆股群, 保證獲利翻倍");
  const warning = await waitFor(() => provider.texts().find((c) => c[2].includes("防詐騙警告")), 6000, "scam warning for untriggered message");
  assert.equal(warning[3]?.replyTo, "202");
  const scamEvent = await waitFor(() => adminEvents.list().find((e) => e.kind === "scam"), 6000, "scam admin event");
  assert.equal(scamEvent.notified, true);
  assert.ok(bot.status().scam.warnedToday >= 1);

  // 3) 機器人自己發的訊息 (含關鍵字與詐騙字眼): 不監控自己
  const before = adminEvents.list().length;
  inject("203", "u-me", "報價 保證獲利 https://bit.ly/self");
  await sleep(800);
  assert.equal(adminEvents.list().length, before, "自己的訊息不應產生監控事件");
});
