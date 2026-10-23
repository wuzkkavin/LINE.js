// 聒噪模式 (修復版5) 測試:
// (1) ChattyTracker 單元: 脈絡上限/逾時/隔離、護欄 (間隔/小時上限/不連續搶話/來回收斂/評估節流) 以假時間驗證、安靜標記解析。
// (2) e2e: 真核心 (FakeProvider, 三個聊天室) + 真 helper bot + AI stub 擷取 messages;
//     A 群只開聒噪 (人設走全域)、B 群預設關閉、C 群聒噪+自訂人設。
//     證明: 關閉行為不變、脈絡隔離、標記不外洩、優先序不雙回、保密規則兩路徑都有、
//     接話不計每日上限、設定免重開生效、防詐騙不受影響、AI 失敗保持安靜。
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
import {
  ChattyTracker, parseChattyReply,
  CHATTY_PASS_MARKER, CHATTY_MIN_SEND_GAP_MS, CHATTY_HOURLY_LIMIT,
  CHATTY_EVAL_MIN_INTERVAL_MS, CHATTY_PAIR_MAX, CHATTY_PAIR_COOLDOWN_MS,
  CHATTY_CONTEXT_MAX_MESSAGES, CHATTY_CONTEXT_MAX_CHARS, CHATTY_CONTEXT_TTL_MS,
} from "../src/chatty.mjs";

const CHAT_A = `c${"a".repeat(32)}`;
const CHAT_B = `c${"b".repeat(32)}`;
const CHAT_C = `c${"c".repeat(32)}`;

// ---------- (1) ChattyTracker 單元 ----------

test("chatty tracker: 脈絡上限 (則數/字數/逾時) 與照群隔離", () => {
  const tr = new ChattyTracker();
  const t0 = 1_000_000;
  for (let i = 0; i < CHATTY_CONTEXT_MAX_MESSAGES + 5; i++) {
    tr.record(CHAT_A, { senderId: "u-1", senderName: "甲", text: `第${i}則`, self: false }, t0 + i * 1000);
  }
  const ctxA = tr.context(CHAT_A, t0 + 40_000);
  assert.equal(ctxA.length, CHATTY_CONTEXT_MAX_MESSAGES, "超過上限的舊訊息應被淘汰");
  assert.equal(ctxA[0].text, "第5則", "應保留最近的訊息");
  // 字數截斷
  tr.record(CHAT_B, { senderId: "u-2", senderName: "乙", text: "長".repeat(1000), self: false }, t0);
  assert.equal(tr.context(CHAT_B, t0)[0].text.length, CHATTY_CONTEXT_MAX_CHARS);
  // 隔離: B 的脈絡沒有 A 的內容
  assert.ok(!tr.context(CHAT_B, t0).some((e) => e.text.startsWith("第")), "B 群脈絡不得含 A 群訊息");
  // 逾時淘汰: 全部超過 TTL 後清空
  assert.equal(tr.context(CHAT_A, t0 + CHATTY_CONTEXT_TTL_MS + 60_000).length, 0, "超過保存時間的脈絡應淘汰");
  // 空文字不記
  tr.record(CHAT_A, { senderId: "u-1", senderName: "甲", text: "", self: false }, t0);
  assert.equal(tr.context(CHAT_A, t0).length, 0);
});

test("chatty tracker: 護欄 (評估節流/送出間隔/不連續搶話) 假時間", () => {
  const tr = new ChattyTracker();
  const t0 = 2_000_000;
  assert.deepEqual(tr.check(CHAT_A, "u-1", t0), { ok: true });
  tr.noteEval(CHAT_A, t0);
  // 評估節流: 間隔內再評估被擋
  assert.equal(tr.check(CHAT_A, "u-1", t0 + CHATTY_EVAL_MIN_INTERVAL_MS - 1).reason, "eval_interval");
  assert.deepEqual(tr.check(CHAT_A, "u-1", t0 + CHATTY_EVAL_MIN_INTERVAL_MS), { ok: true });
  // 送出後: 不連續搶話 (下一則先不接, 只擋一則)
  const t1 = t0 + CHATTY_EVAL_MIN_INTERVAL_MS;
  tr.noteSent(CHAT_A, "u-1", t1);
  assert.equal(tr.check(CHAT_A, "u-2", t1 + CHATTY_MIN_SEND_GAP_MS + 1000).reason, "breather", "剛接過話, 下一則候選應先被不連續搶話擋下");
  assert.deepEqual(tr.check(CHAT_A, "u-2", t1 + CHATTY_MIN_SEND_GAP_MS + 1000), { ok: true }, "不連續搶話只擋一則");
  // 送出間隔: 45 秒內 (不連續已被上一則消耗) 換送出間隔擋
  const tr2 = new ChattyTracker();
  tr2.noteSent(CHAT_A, "u-1", t0);
  tr2.check(CHAT_A, "u-2", t0 + 1000); // 消耗 breather
  assert.equal(tr2.check(CHAT_A, "u-2", t0 + CHATTY_MIN_SEND_GAP_MS - 1).reason, "send_gap");
  assert.deepEqual(tr2.check(CHAT_A, "u-2", t0 + CHATTY_MIN_SEND_GAP_MS), { ok: true });
});

test("chatty tracker: 每小時上限與來回收斂 (同對象冷卻, 別人插話重置連續次數)", () => {
  const tr = new ChattyTracker();
  const t0 = 3_000_000;
  // 每小時上限: 連送 HOURLY_LIMIT 則 (每次間隔拉開避免其他護欄干擾, 每則換不同對象避開來回冷卻)
  for (let i = 0; i < CHATTY_HOURLY_LIMIT; i++) {
    const now = t0 + i * (CHATTY_MIN_SEND_GAP_MS + 1000);
    tr.check(CHAT_A, `u-h${i}`, now); // 消耗 breather
    assert.deepEqual(tr.check(CHAT_A, `u-h${i}`, now), { ok: true }, `第 ${i + 1} 則應可送`);
    tr.noteSent(CHAT_A, `u-h${i}`, now);
  }
  const tOver = t0 + CHATTY_HOURLY_LIMIT * (CHATTY_MIN_SEND_GAP_MS + 1000);
  tr.check(CHAT_A, "u-9", tOver); // 消耗 breather
  assert.equal(tr.check(CHAT_A, "u-9", tOver).reason, "hourly_limit", "超過每小時上限應被擋");
  // 一小時後舊的送出滑出窗口, 恢復可送
  const tLater = tOver + 60 * 60 * 1000;
  assert.deepEqual(tr.check(CHAT_A, "u-9", tLater), { ok: true });

  // 來回收斂: 跟同一人連續來回 PAIR_MAX 次 -> 對該對象冷卻; 其他人仍可評估
  const tr2 = new ChattyTracker();
  let now = t0;
  for (let i = 0; i < CHATTY_PAIR_MAX; i++) {
    now += CHATTY_MIN_SEND_GAP_MS + CHATTY_EVAL_MIN_INTERVAL_MS;
    tr2.check(CHAT_B, "u-x", now); // 消耗 breather (第一次沒有)
    assert.deepEqual(tr2.check(CHAT_B, "u-x", now), { ok: true });
    tr2.noteSent(CHAT_B, "u-x", now);
  }
  now += CHATTY_MIN_SEND_GAP_MS + CHATTY_EVAL_MIN_INTERVAL_MS;
  tr2.check(CHAT_B, "u-x", now); // 消耗 breather
  assert.equal(tr2.check(CHAT_B, "u-x", now).reason, "pair_cooldown", "來回達上限後對該對象應冷卻");
  assert.deepEqual(tr2.check(CHAT_B, "u-y", now), { ok: true }, "冷卻只針對該對象, 其他人照常");
  // 冷卻期滿恢復
  assert.deepEqual(tr2.check(CHAT_B, "u-x", now + CHATTY_PAIR_COOLDOWN_MS), { ok: true });

  // 別人插話重置連續次數: 回 2 次 -> 別人講一句 -> 再回不應馬上觸發冷卻
  const tr3 = new ChattyTracker();
  let n3 = t0;
  const replyTo = (sender) => { n3 += CHATTY_MIN_SEND_GAP_MS + 1000; tr3.check(CHAT_C, sender, n3); tr3.noteSent(CHAT_C, sender, n3); };
  replyTo("u-x"); replyTo("u-x");
  tr3.record(CHAT_C, { senderId: "u-y", senderName: "乙", text: "插一句話", self: false }, n3 + 1);
  replyTo("u-x"); replyTo("u-x"); // 若沒重置, 這裡累積會是 4 次 (>上限) 早已冷卻; 重置後只有 2 次
  n3 += CHATTY_MIN_SEND_GAP_MS + 1000;
  tr3.check(CHAT_C, "u-x", n3);
  assert.deepEqual(tr3.check(CHAT_C, "u-x", n3), { ok: true }, "別人插話後連續次數應重置, 不應冷卻");
});

test("chatty parseChattyReply: 標記只吞不外洩", () => {
  assert.deepEqual(parseChattyReply(CHATTY_PASS_MARKER), { pass: true, text: "" });
  assert.deepEqual(parseChattyReply(`  ${CHATTY_PASS_MARKER}  `), { pass: true, text: "" });
  assert.deepEqual(parseChattyReply(`${CHATTY_PASS_MARKER} 好啊`), { pass: false, text: "好啊" }, "標記混在內容裡也要剝掉");
  assert.deepEqual(parseChattyReply("好啊" + CHATTY_PASS_MARKER), { pass: false, text: "好啊" });
  assert.deepEqual(parseChattyReply("一般接話"), { pass: false, text: "一般接話" });
  assert.deepEqual(parseChattyReply(""), { pass: true, text: "" });
  assert.deepEqual(parseChattyReply(null), { pass: true, text: "" });
  assert.deepEqual(parseChattyReply(undefined), { pass: true, text: "" });
});

// ---------- (2) e2e ----------

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { createWebServer } = await import(join(ROOT, "dist/http/server.js"));
const { createHub } = await import(join(ROOT, "dist/ws/hub.js"));
const { ApiTokenStore } = await import(join(ROOT, "dist/http/apiToken.js"));
const { LoginController } = await import(join(ROOT, "dist/line/login.js"));
const { ChatStore } = await import(join(ROOT, "dist/model/store.js"));
const { MediaService } = await import(join(ROOT, "dist/media/service.js"));

class FakeProvider {
  calls = [];
  async restoreSession() { return true; }
  loginQR() { return new Promise(() => {}); }
  getProfile() { return { userId: "u-me", displayName: "假測試帳號" }; }
  async fetchChannels() {
    return [
      { channelId: CHAT_A, kind: "group", name: "甲群(假)" },
      { channelId: CHAT_B, kind: "group", name: "乙群(假)" },
      { channelId: CHAT_C, kind: "group", name: "丙群(假)" },
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
  textsIn(chatId) { return this.texts().filter((c) => c[1].channelId === chatId); }
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

// AI stub: 防詐騙判讀回固定 JSON; 聒噪呼叫依候選關鍵字決定 PASS/接話/混標記/失敗; 其餘回一般回答
async function startAiStub(aiCalls) {
  const server = createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c);
    const body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    const messages = body.messages ?? [];
    aiCalls.push(messages.map((m) => ({ role: m.role, content: String(m.content ?? "") })));
    const all = messages.map((m) => m.content).join("\n");
    const users = messages.filter((m) => m.role === "user");
    const lastUser = users.length ? String(users[users.length - 1].content) : "";
    let content;
    if (all.includes("防詐騙判讀員")) {
      content = JSON.stringify({ probability: 0.05, tactic: "其他", reason: "一般訊息" });
    } else if (all.includes("接話模式指示")) {
      if (lastUser.includes("呼叫失敗測試")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "stub failure" } }));
        return;
      }
      if (lastUser.includes("接話吧")) content = "哈哈，這個我有經驗，之前也踩過同樣的坑，一起加油。";
      else if (lastUser.includes("混入標記")) content = `${CHATTY_PASS_MARKER} 好啊`;
      else content = CHATTY_PASS_MARKER;
    } else {
      content = "這是 AI stub 的一般回答。";
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test("chatty e2e: 開關/優先序/脈絡隔離/標記/保密/護欄/免重開/防詐騙/失敗安靜", async (t) => {
  const aiCalls = [];
  const stub = await startAiStub(aiCalls);
  t.after(() => stub.server.close());

  const corePort = await freePort();
  const coreRoot = await mkdtemp(join(tmpdir(), "helper-chatty-core-"));
  await writeFile(join(coreRoot, "index.html"), "<!doctype html><title>core</title>");
  const config = {
    server: { host: "127.0.0.1", port: corePort },
    history: { defaultLimit: 50 },
    chat: { sendReadReceipts: true },
    api: { enabled: true, chats: [CHAT_A, CHAT_B, CHAT_C], sendsPerMinute: 60 },
    limits: { frameMaxBytes: 262144, textMaxLength: 8000, sendsPerSecond: 5, uploadMaxBytes: 10485760, uploadVideoMaxBytes: 52428800, uploadsPerMinute: 5 },
  };
  const provider = new FakeProvider();
  const login = new LoginController(provider);
  const store = new ChatStore(500);
  const media = new MediaService(200 * 1024 * 1024, provider);
  const apiTokens = new ApiTokenStore(join(coreRoot, "api-token.json"));
  const web = createWebServer(config, coreRoot, media, apiTokens);
  const hub = createHub({ server: web.server, authorizeUpgrade: web.authorizeUpgrade, authorizeApiUpgrade: web.authorizeApiUpgrade, apiTokens, config, login, provider, store, media, serverVersion: "chatty" });
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

  const dataDir = await mkdtemp(join(tmpdir(), "helper-chatty-data-"));
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
        // A: 只開聒噪, 人設走全域 (personaCustom=false)
        [CHAT_A]: { rolePrompt: "", scopePrompt: "", kbEnabled: true, kbFolder: "", suspended: false, chatty: true, personaCustom: false },
        // C: 聒噪 + 本群自訂人設
        [CHAT_C]: { rolePrompt: "接話人設標記CROLE 你是丙群的開心果。", scopePrompt: "", kbEnabled: true, kbFolder: "", suspended: false, chatty: true, personaCustom: true },
        // B: 沒有條目 = 聒噪關閉 (預設)
      },
    },
    scam: { enabled: true, threshold: 0.8, perMinute: 10 },
    kb: { folder: "" },
    notify: { admins: [], rules: [] },
  });
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.openai, "sk-TESTKEY-chatty");
  await secrets.set(SECRET_NAMES.lineToken, token);
  const kbPool = new KbPool({ dataDir, logger, globalFolder: "" });
  const kb = kbPool.globalKb();
  const adminEvents = new AdminEventStore({ path: join(dataDir, "admin-events.json"), logger });
  // 假時間: 護欄全部以 fakeNow 推進, 與真實時鐘脫鉤
  let fakeNow = 1_700_000_000_000;
  const bot = new HelperBot({ settings, secrets, ai: createAiClient({}), kb, kbPool, logger, adminEvents, chattyOptions: { now: () => fakeNow } });
  await bot.connect();
  t.after(() => bot.disconnect());
  await waitFor(() => bot.selfId === "u-me", 4000, "bot auth ready");

  const inject = (chatId, messageId, senderId, text, extra = {}) => hub.handleMessage(
    { messageId, channelId: chatId, channelKind: "group", senderId, senderName: "假同事", text, contentType: "NONE", createdAt: Date.now(), ...extra }, "new");
  const chattyCalls = () => aiCalls.filter((c) => c.some((m) => m.role === "system" && m.content.includes("接話模式指示")));
  const chattyCallFor = (keyword) => chattyCalls().find((call) => {
    const users = call.filter((m) => m.role === "user");
    return users.length && users[users.length - 1].content.includes(keyword);
  });
  const systemOf = (call) => call.find((m) => m.role === "system")?.content ?? "";
  const allText = (call) => call.map((m) => m.content).join("\n");
  const activityOf = (kind, chatId) => bot.activitySnapshot().filter((a) => a.kind === kind && a.chatId === chatId);

  // ---------- B 群關閉: 一般訊息完全不評估、不接話、不記脈絡 (回歸修復版4 行為) ----------
  inject(CHAT_B, "5001", "u-b1", "今天天氣真好，想出去走走");
  await sleep(800);
  assert.equal(chattyCalls().length, 0, "關閉的群不得送 AI 評估");
  assert.equal(provider.textsIn(CHAT_B).length, 0, "關閉的群不得有任何送出");
  assert.equal(bot.chatty.context(CHAT_B, fakeNow).length, 0, "關閉的群不得記脈絡");

  // ---------- A 群: AI 選 PASS -> 不送出、記 chatty_pass、提示詞含保密與人設、不含範圍把關 ----------
  inject(CHAT_A, "6001", "u-a1", "今天午餐吃什麼好呢");
  await waitFor(() => chattyCallFor("今天午餐吃什麼好呢"), 6000, "A 群第一次評估");
  await waitFor(() => activityOf("chatty_pass", CHAT_A).length >= 1, 4000, "chatty_pass 紀錄");
  assert.equal(provider.textsIn(CHAT_A).length, 0, "PASS 時不得送出任何訊息");
  const call1 = chattyCallFor("今天午餐吃什麼好呢");
  const sys1 = systemOf(call1);
  assert.ok(sys1.includes("全域標記句GLOBALROLE"), "只開聒噪的群, 接話人設應走全域");
  assert.ok(sys1.includes("保密規則"), "接話提示詞應含保密規則");
  assert.ok(sys1.includes("其他群組") && sys1.includes("mid") && sys1.includes("API Key"), "保密規則四類應齊備");
  assert.ok(sys1.includes("不證實也不否認"), "保密規則應含套話應對");
  assert.ok(sys1.includes(CHATTY_PASS_MARKER), "接話指示應含安靜標記協議");
  assert.ok(!sys1.includes("把關規則"), "接話不套用範圍把關規則");
  assert.ok(!sys1.includes("全域範圍標記GLOBALSCOPE"), "接話不套用回答範圍");
  // 候選只出現一次 (脈絡快照不含本則, 本則以最後一則 user 送出)
  assert.equal(call1.filter((m) => m.content.includes("今天午餐吃什麼好呢")).length, 1, "候選訊息不得在脈絡與本則重複出現");
  // 脈絡結構: A 有這則、B 沒有 (隔離)
  assert.ok(bot.chatty.context(CHAT_A, fakeNow).some((e) => e.text.includes("今天午餐")), "A 群脈絡應含本則");
  assert.ok(!bot.chatty.context(CHAT_B, fakeNow).some((e) => e.text.includes("今天午餐")), "B 群脈絡不得含 A 群訊息");

  // ---------- 優先序: 叫名字走正常路徑, 同一則不雙回; 正式路徑提示詞也含保密 ----------
  const answeredBefore = bot.stats.answered;
  inject(CHAT_A, "6002", "u-a1", "AI寶，請問 Excel 怎麼凍結窗格？");
  await waitFor(() => provider.textsIn(CHAT_A).find((c) => c[3]?.replyTo === "6002"), 6000, "正常路徑回答");
  await sleep(500);
  assert.ok(!chattyCallFor("凍結窗格"), "被叫名字的訊息不得再走接話評估");
  const formalCall = aiCalls.find((call) => {
    const users = call.filter((m) => m.role === "user");
    return users.length && users[users.length - 1].content.includes("Excel 怎麼凍結窗格") && !call.some((m) => m.content.includes("接話模式指示"));
  });
  assert.ok(formalCall, "應擷取到正式路徑呼叫");
  assert.ok(systemOf(formalCall).includes("保密規則") && systemOf(formalCall).includes("不證實也不否認"), "正式回答提示詞應含保密規則");
  assert.equal(bot.stats.answered, answeredBefore + 1, "正式回答計數 +1");

  // ---------- 接話成功: 送出不帶引用、不計每日上限、自己的話進脈絡 ----------
  fakeNow += CHATTY_EVAL_MIN_INTERVAL_MS + 1000;
  const dailyBefore = bot.triggerState.daily.count;
  inject(CHAT_A, "6003", "u-a2", "昨天加班到十點，累死了，接話吧");
  const chattySent = await waitFor(() => provider.textsIn(CHAT_A).find((c) => c[2].includes("踩過同樣的坑")), 6000, "接話送出");
  assert.ok(!chattySent[3]?.replyTo, "接話不應引用原訊息");
  await waitFor(() => activityOf("chatty", CHAT_A).length >= 1, 4000, "chatty 活動紀錄");
  assert.equal(bot.stats.answered, answeredBefore + 1, "接話不得計入正式回答數");
  assert.equal(bot.triggerState.daily.count, dailyBefore, "接話不得計入每日上限計數");
  // 脈絡含稍早的午餐話題 (歷史) 與接話後自己的話 (self)
  const call3 = chattyCallFor("接話吧");
  assert.ok(call3.filter((m) => m.role === "user").some((m) => m.content.includes("今天午餐吃什麼好呢")), "接話評估應帶近期脈絡");
  await waitFor(() => bot.chatty.context(CHAT_A, fakeNow).some((e) => e.self && e.text.includes("踩過同樣的坑")), 4000, "自己的接話進脈絡");

  // ---------- 護欄: 不連續搶話 + 送出間隔 (假時間) ----------
  const callsBeforeBreather = chattyCalls().length;
  inject(CHAT_A, "6004", "u-a3", "接話吧，換我說一句");
  await sleep(800);
  assert.equal(chattyCalls().length, callsBeforeBreather, "剛接過話, 下一則應被不連續搶話擋下 (不呼叫 AI)");
  fakeNow += CHATTY_EVAL_MIN_INTERVAL_MS + 1000; // 仍在 45 秒送出間隔內
  inject(CHAT_A, "6005", "u-a3", "接話吧，再試一次");
  await sleep(800);
  assert.equal(chattyCalls().length, callsBeforeBreather, "45 秒間隔內應被擋下 (不呼叫 AI)");
  fakeNow += CHATTY_MIN_SEND_GAP_MS; // 累計超過 45 秒
  inject(CHAT_A, "6006", "u-a3", "接話吧，現在可以了");
  await waitFor(() => provider.textsIn(CHAT_A).filter((c) => c[2].includes("踩過同樣的坑")).length >= 2, 6000, "間隔過後恢復接話");

  // ---------- 標記混在內容裡: 只送剝掉標記的文字, 標記不外洩 ----------
  // (先用一則普通閒聊消耗 6006 接話後的不連續搶話名額, 再推進時間過送出間隔)
  inject(CHAT_A, "6006x", "u-a9", "路過補一句話");
  await sleep(600);
  fakeNow += CHATTY_MIN_SEND_GAP_MS + 1000;
  inject(CHAT_A, "6007", "u-a4", "混入標記聊聊今天的心情");
  await waitFor(() => provider.textsIn(CHAT_A).find((c) => c[2] === "好啊"), 6000, "混標記接話送出");
  assert.ok(!provider.texts().some((c) => c[2].includes(CHATTY_PASS_MARKER)), "任何送出文字都不得含安靜標記");

  // ---------- AI 呼叫失敗: 保持安靜, 不留錯誤訊息 ----------
  inject(CHAT_A, "6007x", "u-a9", "再路過補一句話");
  await sleep(600);
  fakeNow += CHATTY_MIN_SEND_GAP_MS + 1000;
  const sentBeforeFail = provider.textsIn(CHAT_A).length;
  inject(CHAT_A, "6008", "u-a5", "呼叫失敗測試，聊聊吧");
  await sleep(1500);
  assert.equal(provider.textsIn(CHAT_A).length, sentBeforeFail, "AI 失敗時不得送出任何訊息");
  assert.equal(activityOf("chatty", CHAT_A).filter((a) => a.question.includes("呼叫失敗")).length, 0, "AI 失敗不得記成已接話");

  // ---------- 系統事件不觸發、不記脈絡 ----------
  const ctxBeforeEvent = bot.chatty.context(CHAT_A, fakeNow).length;
  const callsBeforeEvent = chattyCalls().length;
  inject(CHAT_A, "6009", "u-a1", "假同事 新增 AI寶 至群組", { contentType: "CHATEVENT" });
  await sleep(700);
  assert.equal(chattyCalls().length, callsBeforeEvent, "系統事件不得觸發接話評估");
  assert.equal(bot.chatty.context(CHAT_A, fakeNow).length, ctxBeforeEvent, "系統事件不得記進脈絡");

  // ---------- C 群: 聒噪 + 自訂人設 -> 接話用本群人設 ----------
  fakeNow += CHATTY_EVAL_MIN_INTERVAL_MS + 1000;
  inject(CHAT_C, "7001", "u-c1", "丙群今天好安靜喔");
  await waitFor(() => chattyCallFor("丙群今天好安靜"), 6000, "C 群評估");
  const sysC = systemOf(chattyCallFor("丙群今天好安靜"));
  assert.ok(sysC.includes("接話人設標記CROLE"), "C 群接話應使用本群自訂人設");
  assert.ok(!sysC.includes("全域標記句GLOBALROLE"), "C 群接話不得混入全域人設 (取代)");
  assert.ok(sysC.includes("保密規則"), "C 群接話也應含保密規則");
  assert.ok(!allText(chattyCallFor("丙群今天好安靜")).includes("今天午餐"), "C 群評估不得看到 A 群脈絡");

  // ---------- 防詐騙不受聒噪影響: 疑似詐騙訊息照樣判讀, 且不拿去接話 ----------
  fakeNow += CHATTY_MIN_SEND_GAP_MS + CHATTY_EVAL_MIN_INTERVAL_MS;
  const scannedBefore = bot.stats.scamScanned;
  const chattyBeforeScam = chattyCalls().length;
  inject(CHAT_A, "6010", "u-a6", "有人貼這個連結 http://example.com/free 你們看一下");
  await waitFor(() => aiCalls.some((c) => c.some((m) => m.content.includes("防詐騙判讀員")) && c.some((m) => m.content.includes("example.com"))), 6000, "防詐騙判讀有跑");
  await sleep(500);
  assert.ok(bot.stats.scamScanned > scannedBefore, "防詐騙掃描計數應增加 (每則必看)");
  assert.equal(chattyCalls().length, chattyBeforeScam, "疑似詐騙訊息不得走接話評估");

  // ---------- 免重開生效: B 群執行中打開聒噪 -> 下一則就評估; 關掉就停 ----------
  settings.update({ ai: { chatProfiles: { [CHAT_B]: { rolePrompt: "", scopePrompt: "", kbEnabled: true, kbFolder: "", suspended: false, chatty: true, personaCustom: false } } } });
  inject(CHAT_B, "5002", "u-b1", "乙群的第一句閒聊");
  await waitFor(() => chattyCallFor("乙群的第一句閒聊"), 6000, "B 群打開後即時評估");
  assert.ok(!allText(chattyCallFor("乙群的第一句閒聊")).includes("今天午餐"), "B 群評估不得看到 A 群脈絡");
  await waitFor(() => activityOf("chatty_pass", CHAT_B).length >= 1, 4000, "B 群 chatty_pass 紀錄 (活動可依群篩選)");
  settings.update({ ai: { chatProfiles: { [CHAT_B]: { chatty: false } } } });
  const chattyBeforeOff = chattyCalls().length;
  inject(CHAT_B, "5003", "u-b1", "乙群關掉後的閒聊");
  await sleep(800);
  assert.equal(chattyCalls().length, chattyBeforeOff, "關掉後下一則應停止評估");
  assert.ok(!bot.chatty.context(CHAT_B, fakeNow).some((e) => e.text.includes("關掉後的閒聊")), "關掉後不得再記脈絡");
});
