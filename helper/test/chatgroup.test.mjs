// 分群角色定位/回答範圍/知識庫 e2e (規格 V16/V7/V12/V13/V14 + 把關段):
// 真核心 (FakeProvider, 兩個聊天室) + 真 helper bot + KbPool + AI stub 擷取實際送出的 messages 斷言。
// A 群用全域預設, B 群本群自訂; 證明: 自訂是取代不是疊加、改設定下一則即生效、
// 知識庫關閉的群不觸發未命中固定回覆與管理員通知、專屬資料夾只有本群查得到。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
import { KbPool } from "../src/kb.mjs";
import { HelperBot } from "../src/bot.mjs";
import { AdminEventStore } from "../src/adminnotify.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { createWebServer } = await import(join(ROOT, "dist/http/server.js"));
const { createHub } = await import(join(ROOT, "dist/ws/hub.js"));
const { ApiTokenStore } = await import(join(ROOT, "dist/http/apiToken.js"));
const { LoginController } = await import(join(ROOT, "dist/line/login.js"));
const { ChatStore } = await import(join(ROOT, "dist/model/store.js"));
const { MediaService } = await import(join(ROOT, "dist/media/service.js"));

const CHAT_A = `c${"a".repeat(32)}`;
const CHAT_B = `c${"b".repeat(32)}`;

class FakeProvider {
  calls = [];
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
  async fetchHistory() { return { messages: [], hasMore: false }; }
  outgoing(channel, fields) { return { messageId: `sent-${this.calls.length}`, channelId: channel.channelId, channelKind: channel.kind, senderId: "u-me", senderName: "假測試帳號", contentType: "NONE", createdAt: Date.now(), ...fields }; }
  async sendText(channel, text, options) { this.calls.push(["text", channel, text, options]); return this.outgoing(channel, { text, ...(options?.replyTo ? { replyTo: options.replyTo } : {}) }); }
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

// AI stub: 擷取每一次呼叫的完整 messages (供 prompt 斷言), 回答固定文字
async function startAiStub(aiCalls) {
  const server = createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c);
    const body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    const messages = body.messages ?? [];
    aiCalls.push(messages.map((m) => ({ role: m.role, content: String(m.content ?? "") })));
    const all = messages.map((m) => m.content).join("\n");
    let content;
    if (all.includes("防詐騙判讀員")) {
      content = JSON.stringify({ probability: 0.05, tactic: "其他", reason: "一般訊息" });
    } else {
      content = "這是 AI stub 的一般回答。";
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test("分群 e2e: (a)取代斷言 (b)改設定即時生效 (c)KB關閉不觸發未命中流程 (d)專屬KB隔離 (e)把關段", async (t) => {
  const aiCalls = [];
  const stub = await startAiStub(aiCalls);
  t.after(() => stub.server.close());

  const corePort = await freePort();
  const coreRoot = await mkdtemp(join(tmpdir(), "helper-chatgroup-core-"));
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
  const hub = createHub({ server: web.server, authorizeUpgrade: web.authorizeUpgrade, authorizeApiUpgrade: web.authorizeApiUpgrade, apiTokens, config, login, provider, store, media, serverVersion: "chatgroup" });
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

  const dataDir = await mkdtemp(join(tmpdir(), "helper-chatgroup-data-"));
  const globalKbDir = join(dataDir, "global-kb");
  await mkdir(globalKbDir, { recursive: true });
  await writeFile(join(globalKbDir, "公司列印說明.txt"), "公司彩色列印在總公司四樓影印室。彩色影印機分機是 412, 使用前請在影印室登記表登記。A3 列印也在四樓影印室。");
  const bKbDir = join(dataDir, "b-kb");
  await mkdir(bKbDir, { recursive: true });
  await writeFile(join(bKbDir, "紫水晶文件.txt"), "紫水晶行動文件: 紫水晶行動的集合地點在山頂觀測站。紫水晶行動集合時間是清晨六點, 請準時到達山頂觀測站集合, 並攜帶行動裝備。");

  const logger = new Logger({ dir: join(dataDir, "logs"), debug: false });
  const settings = new SettingsStore({ path: join(dataDir, "settings.json"), logger });
  settings.update({
    botName: "AI寶", aliases: [], triggerMode: "standard", cooldownSec: 0, dailyLimit: 100,
    lineApiUrl: `ws://127.0.0.1:${corePort}/api/ws`,
    ai: {
      active: "openai",
      providers: { openai: { baseUrl: stub.baseUrl, model: "stub-model" } },
      rolePrompt: "全域標記句GLOBALROLE 你是全域電腦小幫手。",
      scopePrompt: "全域範圍標記GLOBALSCOPE 只回答電腦與 AI 工具問題。",
      chatProfiles: {
        [CHAT_B]: { rolePrompt: "本群標記句BROLE 你是藍莓專案助理。", scopePrompt: "本群範圍標記BSCOPE 只回答藍莓專案問題。", kbEnabled: true, kbFolder: "", suspended: false },
      },
    },
    scam: { enabled: true, threshold: 0.8, perMinute: 10 },
    kb: { folder: globalKbDir },
    notify: {
      admins: [{ id: "u-admin", name: "管理員(假)" }],
      rules: [{ id: "r-unanswered", kind: "unanswered", keyword: "", notifyAdminIds: ["u-admin"], enabled: true }],
    },
  });
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.openai, "sk-TESTKEY-chatgroup");
  await secrets.set(SECRET_NAMES.lineToken, token);
  const kbPool = new KbPool({ dataDir, logger, globalFolder: globalKbDir });
  const kb = kbPool.globalKb();
  await kb.scan({ force: true });
  const adminEvents = new AdminEventStore({ path: join(dataDir, "admin-events.json"), logger });
  const bot = new HelperBot({ settings, secrets, ai: createAiClient({}), kb, kbPool, logger, adminEvents });
  await bot.connect();
  t.after(() => bot.disconnect());
  await waitFor(() => bot.selfId === "u-me", 4000, "bot auth ready");

  const inject = (chatId, messageId, senderId, text) => hub.handleMessage(
    { messageId, channelId: chatId, channelKind: "group", senderId, senderName: "假同事", text, contentType: "NONE", createdAt: Date.now() }, "new");
  const replyFor = (messageId) => provider.texts().find((c) => c[3]?.replyTo === messageId);
  const systemOf = (call) => call.find((m) => m.role === "system")?.content ?? "";
  const textOf = (call) => call.map((m) => m.content).join("\n");
  // 找「最後一則 user 訊息含關鍵字」的那次 AI 呼叫 (記憶會帶舊 user 訊息, 以最後一則為準)
  const callFor = (keyword) => aiCalls.find((call) => {
    const users = call.filter((m) => m.role === "user");
    return users.length && users[users.length - 1].content.includes(keyword);
  });

  // ---------- (a) A 群全域 / B 群自訂取代 (V16) + (e) 把關段 ----------
  inject(CHAT_A, "3001", "u-a1", "AI寶，請問 Excel 怎麼凍結窗格？");
  await waitFor(() => replyFor("3001"), 6000, "A 群回答");
  inject(CHAT_B, "4001", "u-b1", "AI寶，請問藍莓專案的時程怎麼安排？");
  await waitFor(() => replyFor("4001"), 6000, "B 群回答");

  const callA = callFor("Excel 怎麼凍結窗格");
  const callB = callFor("藍莓專案的時程");
  assert.ok(callA && callB, "應擷取到兩群各自的 AI 呼叫");
  const sysA = systemOf(callA);
  const sysB = systemOf(callB);
  assert.ok(sysA.includes("全域標記句GLOBALROLE"), "A 群 system 應含全域角色標記");
  assert.ok(sysA.includes("全域範圍標記GLOBALSCOPE"), "A 群 system 應含全域範圍標記");
  assert.ok(!sysA.includes("本群標記句BROLE"), "A 群 system 不得含 B 群標記");
  assert.ok(sysB.includes("本群標記句BROLE"), "B 群 system 應含本群角色標記");
  assert.ok(sysB.includes("本群範圍標記BSCOPE"), "B 群 system 應含本群範圍標記");
  assert.ok(!textOf(callB).includes("全域標記句GLOBALROLE"), "V16: B 群整次呼叫不得含全域角色標記 (取代, 不是疊加)");
  assert.ok(!textOf(callB).includes("全域範圍標記GLOBALSCOPE"), "V16: B 群整次呼叫不得含全域範圍標記");

  // (e) 把關段: B 群 (自訂範圍) 與 A 群 (全域範圍非空) 的 system 都含把關規則關鍵句
  for (const [label, sys] of [["A群", sysA], ["B群", sysB]]) {
    assert.ok(sys.includes("把關規則"), `${label} system 應含把關規則段`);
    assert.ok(sys.includes("不准拿來回答範圍外的問題"), `${label} system 應含知識庫不得繞過範圍的規則`);
    assert.ok(sys.includes("一個最關鍵的問題"), `${label} system 應含模糊反問一個關鍵問題的規則`);
    assert.ok(sys.includes("不要編造範圍外的答案"), `${label} system 應含不編造範圍外答案的規則`);
  }

  // ---------- (b) B 群改設定, 下一則即反映新範圍 (V7, 免重開) ----------
  settings.update({ ai: { chatProfiles: { [CHAT_B]: { scopePrompt: "新範圍標記NEWSCOPE 只回答綠寶石計畫問題。" } } } });
  inject(CHAT_B, "4002", "u-b2", "AI寶，請問綠寶石計畫的展示日期是哪天？");
  await waitFor(() => replyFor("4002"), 6000, "B 群改設定後回答");
  const callB2 = callFor("綠寶石計畫的展示日期");
  assert.ok(callB2, "應擷取到改設定後 B 群的 AI 呼叫");
  assert.ok(systemOf(callB2).includes("新範圍標記NEWSCOPE"), "改設定後下一則 system 應含新範圍");
  assert.ok(!systemOf(callB2).includes("本群範圍標記BSCOPE"), "改設定後舊範圍不得殘留");
  assert.ok(systemOf(callB2).includes("本群標記句BROLE"), "只改範圍時角色應保留 (補丁合併欄位)");

  // ---------- (c) B 群 kbEnabled=false 問公司問題: 走 AI, 不觸發 kbMiss 與 unanswered 通知 ----------
  settings.update({ ai: { chatProfiles: { [CHAT_B]: { kbEnabled: false } } } });
  const unansweredBefore = adminEvents.list().filter((e) => e.kind === "unanswered").length;
  const aiCountBeforeC = aiCalls.length;
  inject(CHAT_B, "4003", "u-b3", "AI寶，公司請假規定是什麼？");
  const replyC = await waitFor(() => replyFor("4003"), 6000, "B 群 KB 關閉時的回答");
  assert.ok(!replyC[2].includes("查不到"), "KB 關閉時不得回知識庫查不到的固定回覆");
  assert.ok(!replyC[2].includes("不敢亂答"), "KB 關閉時不得回 kbMiss 固定文字");
  assert.ok(aiCalls.length > aiCountBeforeC, "KB 關閉時公司問題應有呼叫 AI");
  const callC = callFor("公司請假規定");
  assert.ok(callC, "應擷取到 KB 關閉那次的 AI 呼叫");
  assert.ok(!textOf(callC).includes("以下是公司知識庫片段"), "KB 關閉時 messages 不得含知識庫片段");
  assert.ok(!textOf(callC).includes("四樓影印室"), "KB 關閉時 messages 不得含全域知識庫內容");
  assert.equal(adminEvents.list().filter((e) => e.kind === "unanswered").length, unansweredBefore, "KB 關閉時不得新增 unanswered 管理員事件");

  // ---------- (d) B 群專屬資料夾隔離 (V13/V14) ----------
  settings.update({ ai: { chatProfiles: { [CHAT_B]: { kbEnabled: true, kbFolder: bKbDir } } } });
  kbPool.syncFromSettings(settings.get());
  const kbB = kbPool.forFolder(CHAT_B, bKbDir);
  await kbB.scan({ force: true });
  assert.ok(bot.status().kbChats[CHAT_B], "status 應列出 B 群專屬知識庫狀態");

  inject(CHAT_B, "4004", "u-b4", "AI寶，紫水晶行動集合地點在哪裡？");
  await waitFor(() => replyFor("4004"), 6000, "B 群專屬 KB 回答");
  const callD_B = callFor("紫水晶行動集合地點");
  assert.ok(callD_B, "應擷取到 B 群專屬 KB 那次呼叫");
  assert.ok(textOf(callD_B).includes("紫水晶文件.txt"), "B 群 messages 應含專屬片段且來源檔名正確");
  assert.ok(textOf(callD_B).includes("山頂觀測站"), "B 群 messages 應含專屬文件片段內容");

  const aiCountBeforeA = aiCalls.length;
  inject(CHAT_A, "3002", "u-a2", "AI寶，紫水晶行動集合地點在哪裡？");
  await waitFor(() => replyFor("3002"), 6000, "A 群同題回答");
  const newCallsA = aiCalls.slice(aiCountBeforeA);
  assert.ok(newCallsA.length >= 1, "A 群同題應有 AI 呼叫 (該題非公司關鍵字題, 不走 kbMiss)");
  for (const call of newCallsA) {
    assert.ok(!textOf(call).includes("紫水晶文件.txt"), "A 群不得引用 B 群專屬文件");
    assert.ok(!textOf(call).includes("山頂觀測站"), "A 群不得取得 B 群專屬片段內容");
  }
});
