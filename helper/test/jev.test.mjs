// Jev 真接通測試 (2026-10-21):
// 1) jev.mjs: config.yaml 的 jev 區段解析/寫入/清除 — 只動 jev 區段、格式紅線、同步流程 (寫入/停用清除/冪等)。
// 2) 端到端: 真核心 (dist hub) + 假 Jev 分析器 — bot 判讀走 scam:check、成功映射門檻與手法、
//    影子 AI 比試同行入 log; 核心未啟用 Jev (SCAM_CHECK_UNAVAILABLE) 時自動退回 AI 判讀;
//    手動判讀自貼文字走 AI; Jev 未啟用時完全不碰核心分析器。
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
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
import { HelperBot, classifyJevError, JEV_TACTIC_LABELS } from "../src/bot.mjs";
import { applyJevConfig, isValidJevModel, isValidJevToken, parseJevSection, syncJevCoreConfig } from "../src/jev.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { createWebServer } = await import(join(ROOT, "dist/http/server.js"));
const { createHub } = await import(join(ROOT, "dist/ws/hub.js"));
const { ApiTokenStore } = await import(join(ROOT, "dist/http/apiToken.js"));
const { LoginController } = await import(join(ROOT, "dist/line/login.js"));
const { ChatStore } = await import(join(ROOT, "dist/model/store.js"));
const { MediaService } = await import(join(ROOT, "dist/media/service.js"));

const CHAT = `c${"a".repeat(32)}`;
const AI_KEY = "sk-TESTKEY-1234567890abcd";
const JEV_KEY = "ts-TESTJEVKEY-abcdef1234567890";
const SCAM_TEXT = "好康報你知 https://bit.ly/abc123 加入飆股群，保證獲利翻倍，快點";

const SAMPLE_CONFIG = [
  "server:",
  "  host: 127.0.0.1",
  "  port: 3789",
  "api:",
  "  enabled: true",
  "  chats:",
  `    - ${CHAT}`,
  "jev:",
  '  token: ""',
  "  # 使用的模型；可省略，預設 jev-1.13.0。",
  "  model: jev-latest",
  "limits:",
  "  frameMaxBytes: 262144",
  "",
].join("\n");

test("jev 設定寫入: 解析/寫入/清除只動 jev 區段, 特殊字元金鑰可來回讀寫", () => {
  const parsed = parseJevSection(SAMPLE_CONFIG);
  assert.equal(parsed.present, true);
  assert.equal(parsed.token, "");
  assert.equal(parsed.model, "jev-latest");

  // 寫入含 # 與 : 的金鑰 (裸寫會被 YAML 誤解, 必須引號跳脫且讀得回來)
  const tricky = "ts-ab#cd:ef_1234567890";
  const written = applyJevConfig(SAMPLE_CONFIG, { token: tricky, model: "jev-1.13.0" });
  const back = parseJevSection(written);
  assert.equal(back.token, tricky);
  assert.equal(back.model, "jev-1.13.0");
  // jev 區段以外的內容一字不改
  const stripJev = (t) => t.split(/\r?\n/).filter((l, i, a) => {
    const start = a.findIndex((x) => /^jev:/.test(x));
    const end = a.findIndex((x, j) => j > start && /^\S/.test(x));
    return i < start || (end >= 0 && i >= end);
  }).join("\n");
  assert.equal(stripJev(written), stripJev(SAMPLE_CONFIG));
  // 註解行還在 (模型說明註解不被誤刪)
  assert.ok(written.includes("使用的模型"));

  // 清除: token 變空字串, model 不動
  const cleared = applyJevConfig(written, { token: "" });
  const backCleared = parseJevSection(cleared);
  assert.equal(backCleared.token, "");
  assert.equal(backCleared.model, "jev-1.13.0");

  // 沒有 jev 區塊的設定檔: 檔尾新增, 原內容保留在前面
  const noJev = "server:\n  host: 127.0.0.1\n";
  const appended = applyJevConfig(noJev, { token: "ts-xyz123456", model: "jev-1.13.0" });
  assert.ok(appended.startsWith(noJev.trimEnd()));
  assert.equal(parseJevSection(appended).token, "ts-xyz123456");

  // 格式檢查與核心一致
  assert.equal(isValidJevToken("abc-DEF_123.~"), true);
  assert.equal(isValidJevToken("has space"), false);
  assert.equal(isValidJevToken(""), false);
  assert.equal(isValidJevToken("中文金鑰"), false);
  assert.equal(isValidJevModel("jev-1.13.0"), true);
  assert.equal(isValidJevModel("jev latest"), false);

  // 失敗分類的白話對照
  assert.match(classifyJevError("SCAM_CHECK_UNAVAILABLE"), /尚未啟用 Jev/);
  assert.match(classifyJevError("TIMEOUT"), /逾時/);
  assert.equal(JEV_TACTIC_LABELS.investment, "假投資/飆股群");
  assert.equal(JEV_TACTIC_LABELS.phishing, "釣魚連結");
});

test("jev 同步: 啟用寫入、停用清除、重複同步不重寫、格式不符拒寫", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jev-sync-"));
  const cfgPath = join(dir, "config.yaml");
  await writeFile(cfgPath, SAMPLE_CONFIG, "utf8");
  const logger = new Logger({ dir: join(dir, "logs") });
  const settings = new SettingsStore({ path: join(dir, "settings.json"), logger });
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.jev, JEV_KEY);
  const env = { dataDir: dir, repoRoot: join(dir, "no-such-repo"), settings, secrets, logger };

  // 尚未啟用: 同步後 token 仍是空的、不寫檔
  let r = await syncJevCoreConfig(env);
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(parseJevSection(await readFile(cfgPath, "utf8")).token, "");

  // 啟用: token 與 model 都寫入, 其他區段不動, 有 .bak 備份
  settings.update({ scam: { jev: { enabled: true, model: "jev-1.13.0" } } });
  r = await syncJevCoreConfig(env);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.synced, true);
  let now = parseJevSection(await readFile(cfgPath, "utf8"));
  assert.equal(now.token, JEV_KEY);
  assert.equal(now.model, "jev-1.13.0");
  assert.ok(existsSync(`${cfgPath}.bak`), "寫入前應留備份");
  const fullText = await readFile(cfgPath, "utf8");
  assert.ok(fullText.includes("api:"), "api 區段應保留");
  assert.ok(!fullText.includes("ts-TESTJEVKEY") || fullText.indexOf("ts-TESTJEVKEY") === fullText.lastIndexOf("ts-TESTJEVKEY"), "金鑰只應出現一次");

  // 冪等: 再同步一次不重寫
  r = await syncJevCoreConfig(env);
  assert.equal(r.changed, false);

  // 停用: token 清空
  settings.update({ scam: { jev: { enabled: false, model: "jev-1.13.0" } } });
  r = await syncJevCoreConfig(env);
  assert.equal(r.changed, true);
  assert.equal(parseJevSection(await readFile(cfgPath, "utf8")).token, "");

  // 金鑰被清除: 重新啟用也沒金鑰可寫, token 維持空
  settings.update({ scam: { jev: { enabled: true, model: "jev-1.13.0" } } });
  await secrets.delete(SECRET_NAMES.jev);
  r = await syncJevCoreConfig(env);
  assert.equal(r.synced, false);
  assert.equal(parseJevSection(await readFile(cfgPath, "utf8")).token, "");

  // 格式不符的金鑰: 拒寫, 檔案不被污染 (寫進去會害核心下次啟動失敗)
  await secrets.set(SECRET_NAMES.jev, "bad key with spaces 中文");
  const before = await readFile(cfgPath, "utf8");
  r = await syncJevCoreConfig(env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-token-format");
  assert.equal(await readFile(cfgPath, "utf8"), before);

  // log 不含金鑰明文
  const logFiles = await readdir(join(dir, "logs"));
  let allLog = "";
  for (const f of logFiles) allLog += await readFile(join(dir, "logs", f), "utf8");
  assert.ok(!allLog.includes(JEV_KEY), "log 不得含 Jev 金鑰明文");
  assert.ok(allLog.includes("Jev 金鑰已寫入核心設定"), "log 應記寫入事件 (只記末 4 碼)");
});

// --- 端到端世界: 真核心 + 假 LINE Provider + (可選) 假 Jev 分析器 + AI stub ---
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

async function startAiStub(counter) {
  const server = createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c);
    const body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    const all = (body.messages ?? []).map((m) => m.content).join("\n");
    let content;
    if (all.includes("防詐騙判讀員")) {
      counter.scamJudgeCalls++;
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

async function startWorld(t, { withAnalyzer, jevEnabled = true }) {
  const aiCounter = { scamJudgeCalls: 0 };
  const stub = await startAiStub(aiCounter);
  t.after(() => stub.server.close());
  const corePort = await freePort();
  const coreRoot = await mkdtemp(join(tmpdir(), "jev-e2e-core-"));
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
  const analyzer = { calls: [], async analyzeScam(text) { this.calls.push(text); return { probability: 0.93, tactic: { kind: "investment", confidence: 0.88 } }; } };
  const hub = createHub({ server: web.server, authorizeUpgrade: web.authorizeUpgrade, authorizeApiUpgrade: web.authorizeApiUpgrade, apiTokens, config, login, provider, store, media, serverVersion: "jev-e2e", ...(withAnalyzer ? { scam: analyzer } : {}) });
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

  const dataDir = await mkdtemp(join(tmpdir(), "jev-e2e-data-"));
  const logger = new Logger({ dir: join(dataDir, "logs"), debug: false });
  const settings = new SettingsStore({ path: join(dataDir, "settings.json"), logger });
  settings.update({
    botName: "AI寶", aliases: [], triggerMode: "standard", cooldownSec: 0, dailyLimit: 100,
    lineApiUrl: `ws://127.0.0.1:${corePort}/api/ws`,
    ai: { active: "openai", providers: { openai: { baseUrl: stub.baseUrl, model: "stub-model" } } },
    scam: { enabled: true, threshold: 0.8, perMinute: 10, jev: { enabled: jevEnabled, model: "jev-1.13.0" } },
  });
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.openai, AI_KEY);
  await secrets.set(SECRET_NAMES.lineToken, token);
  await secrets.set(SECRET_NAMES.jev, JEV_KEY);
  const bot = new HelperBot({ settings, secrets, ai: createAiClient({}), kb: null, logger });
  await bot.connect();
  t.after(() => bot.disconnect());
  await waitFor(() => bot.selfId === "u-me", 4000, "bot auth ready");
  const inject = (messageId, senderId, text) => hub.handleMessage({ messageId, channelId: CHAT, channelKind: "group", senderId, senderName: "假同事", text, contentType: "NONE", createdAt: Date.now() }, "new");
  const readLog = async () => {
    const files = await readdir(join(dataDir, "logs"));
    let all = "";
    for (const f of files) all += await readFile(join(dataDir, "logs", f), "utf8");
    return all;
  };
  return { provider, bot, settings, secrets, inject, analyzer, aiCounter, readLog };
}

test("jev e2e: 判讀走核心 scam:check (機率/手法映射), 影子 AI 同行入 log, 狀態 unverified -> ok", async (t) => {
  const w = await startWorld(t, { withAnalyzer: true });
  // 存好金鑰且啟用, 還沒判讀過任何一則: unverified (不准假裝已接通)
  await w.bot.refreshJevState();
  assert.equal(w.bot.status().scam.jevState, "unverified");

  w.inject("201", "u-f", SCAM_TEXT);
  const warn = await waitFor(() => w.provider.texts().find((c) => c[2].includes("防詐騙警告")), 6000, "jev scam warning");
  // 用的是 Jev 的 0.93 (AI 是 0.95), 手法是核心 kind 對照的中文名稱
  assert.ok(warn[2].includes("93%"), `警告應顯示 Jev 機率 93%, 實際: ${warn[2].split("\n")[1]}`);
  assert.ok(warn[2].includes("假投資/飆股群"), "手法應由 Jev kind 對照成中文");
  assert.equal(w.analyzer.calls.length, 1, "核心分析器應被呼叫一次");
  assert.equal(w.analyzer.calls[0], SCAM_TEXT, "核心應以自己快取的原文送判讀");

  // 影子比試: 同則另跑一次 AI 判讀, 兩邊分數同行入 log
  await waitFor(() => w.aiCounter.scamJudgeCalls >= 1, 6000, "shadow ai judge");
  const log = await waitFor(async () => { const s = await w.readLog(); return s.includes("同場比試") ? s : null; }, 6000, "shadow log line");
  assert.ok(log.includes('"jev":0.93') && log.includes('"ai":0.95'), "比試紀錄應同行含 Jev 與 AI 兩邊分數");
  assert.ok(log.includes('"used":"jev"'), "比試紀錄應標明實際採用 Jev");
  assert.ok(!log.includes(JEV_KEY), "log 不得含 Jev 金鑰明文");

  const st = w.bot.status();
  assert.equal(st.scam.jevState, "ok");
  assert.ok(st.scam.jevLastOkAt, "應記最近成功判讀時間");
});

test("jev e2e: 核心未啟用 Jev (SCAM_CHECK_UNAVAILABLE) 自動退回 AI 判讀, 狀態 error 且原因白話", async (t) => {
  const w = await startWorld(t, { withAnalyzer: false });
  w.inject("301", "u-f", SCAM_TEXT);
  const warn = await waitFor(() => w.provider.texts().find((c) => c[2].includes("防詐騙警告")), 6000, "ai fallback warning");
  // 退回 AI: 用 AI 的 0.95
  assert.ok(warn[2].includes("95%"), `應退回 AI 判讀 95%, 實際: ${warn[2].split("\n")[1]}`);
  const log = await w.readLog();
  assert.ok(log.includes("Jev 判讀失敗, 已自動改用 AI 判讀"), "log 應記自動退回 AI");
  assert.ok(log.includes("核心尚未啟用 Jev"), "失敗原因應是白話分類, 不是上游原文");
  const st = w.bot.status();
  assert.equal(st.scam.jevState, "error");
  assert.match(st.scam.jevLastError, /尚未啟用 Jev/);
});

test("jev e2e: 手動判讀自貼文字走 AI (不經 Jev); Jev 未啟用時不碰核心分析器", async (t) => {
  // 手動判讀: 同事貼上別處的詐騙文字問「這是詐騙嗎」— 自貼文字不在核心快取, 走 AI 判讀。
  const w = await startWorld(t, { withAnalyzer: true });
  w.inject("401", "u-h", "AI寶，這是詐騙嗎：有人叫我操作ATM解除分期付款，還給我連結 https://bit.ly/zz9");
  const verdict = await waitFor(() => w.provider.texts().find((c) => c[2].includes("判讀結果")), 6000, "manual verdict");
  assert.ok(verdict[2].includes("高度疑似詐騙"), "手動判讀結果應來自 AI (0.95)");
  assert.ok(verdict[2].includes("含短網址與高風險話術"), "手動判讀應帶 AI 的判讀理由 (Jev 沒有理由文字)");
  const log = await w.readLog();
  assert.ok(log.includes("手動判讀的文字是使用者自貼的內容"), "log 應說明手動判讀改走 AI 的原因");

  // Jev 未啟用: 自動掃描照舊走 AI, 核心分析器一次都不碰, 也沒有影子比試
  const w2 = await startWorld(t, { withAnalyzer: true, jevEnabled: false });
  assert.equal(w2.bot.status().scam.jevState, "unconfigured");
  w2.inject("402", "u-f", SCAM_TEXT);
  const warn2 = await waitFor(() => w2.provider.texts().find((c) => c[2].includes("防詐騙警告")), 6000, "ai warning (jev off)");
  assert.ok(warn2[2].includes("95%"));
  await sleep(400); // 若有影子或 Jev 呼叫, 這段時間內會發生
  assert.equal(w2.analyzer.calls.length, 0, "Jev 未啟用時不應呼叫核心分析器");
  assert.equal(w2.aiCounter.scamJudgeCalls, 1, "AI 只應被呼叫一次 (沒有影子比試)");
});
