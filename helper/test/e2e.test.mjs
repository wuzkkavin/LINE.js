import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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

// 核心 (上游 LINE.js) 的建置產物: helper 的上一層就是 Repo 根目錄 dist/
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { createWebServer } = await import(join(ROOT, "dist/http/server.js"));
const { createHub } = await import(join(ROOT, "dist/ws/hub.js"));
const { ApiTokenStore } = await import(join(ROOT, "dist/http/apiToken.js"));
const { LoginController } = await import(join(ROOT, "dist/line/login.js"));
const { ChatStore } = await import(join(ROOT, "dist/model/store.js"));
const { MediaService } = await import(join(ROOT, "dist/media/service.js"));

const CHAT = `c${"a".repeat(32)}`;
const TEST_KEY = "sk-TESTKEY-1234567890abcd";

class FakeProvider {
  calls = []; // [kind, channel, text, options]
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

// AI stub: 依提示內容回固定答案與詐騙判讀 JSON
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
    } else if (all.includes("以下是公司知識庫片段")) {
      content = "依知識庫內容回答:彩色列印請到四樓影印室辦理, 分機 412。";
    } else if (all.includes("凍結窗格")) {
      content = "凍結窗格步驟:1. 點一下要凍結範圍下方那一列的儲存格 2. 點上方「檢視」3. 按「凍結窗格」。";
    } else {
      content = "這是 AI stub 的一般回答。";
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { role: "assistant", content } }] }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

test("e2e 假資料全流程: 觸發 (含句尾)、知識庫、防詐騙、改名、log 無 Key", async (t) => {
  // --- AI stub ---
  const stub = await startAiStub();
  t.after(() => stub.server.close());

  // --- LINE 核心 (FakeProvider) ---
  const corePort = await freePort();
  const coreRoot = await mkdtemp(join(tmpdir(), "helper-e2e-core-"));
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

  // --- helper 側: 暫存資料夾、知識庫、設定 (主名 AI寶)、假 Key ---
  const dataDir = await mkdtemp(join(tmpdir(), "helper-e2e-data-"));
  const kbDir = join(dataDir, "kb-files");
  await mkdir(kbDir, { recursive: true });
  await writeFile(join(kbDir, "公司列印說明.txt"), "公司彩色列印在總公司四樓影印室。彩色影印機分機是 412, 使用前請在影印室登記表登記。A3 列印也在四樓影印室。");
  await writeFile(join(kbDir, "公司網路.md"), "VPN 申請流程: 先填資訊部表單, 經直屬主管簽核後, 由資訊部開通帳號。");
  const logger = new Logger({ dir: join(dataDir, "logs"), debug: false });
  const settings = new SettingsStore({ path: join(dataDir, "settings.json"), logger });
  settings.update({
    botName: "AI寶", aliases: [], triggerMode: "standard", cooldownSec: 0, dailyLimit: 100,
    showSources: true, // 來源開關測試: 本流程先開 (案例 C 驗附來源), 案例 C2 再關掉驗不附來源
    lineApiUrl: `ws://127.0.0.1:${corePort}/api/ws`,
    ai: { active: "openai", providers: { openai: { baseUrl: stub.baseUrl, model: "stub-model" } } },
    scam: { enabled: true, threshold: 0.8, perMinute: 10 },
    kb: { folder: kbDir },
  });
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.openai, TEST_KEY);
  await secrets.set(SECRET_NAMES.lineToken, token);
  const kb = new KnowledgeBase({ folder: kbDir, indexPath: join(dataDir, "kb-index.json"), logger });
  await kb.scan({ force: true });
  const bot = new HelperBot({ settings, secrets, ai: createAiClient({}), kb, logger });
  await bot.connect();
  t.after(() => bot.disconnect());
  await waitFor(() => bot.selfId === "u-me", 4000, "bot auth ready");

  const inject = (messageId, senderId, text) => hub.handleMessage({ messageId, channelId: CHAT, channelKind: "group", senderId, senderName: "假同事", text, contentType: "NONE", createdAt: Date.now() }, "new");
  const textsSince = (n) => provider.texts().slice(n);

  // A) 沒觸發: 不回
  let base = provider.texts().length;
  inject("101", "u-a", "今天午餐吃什麼");
  await sleep(500);
  assert.equal(textsSince(base).length, 0, "沒叫名字不應回覆");

  // B) 句首觸發一般問題
  base = provider.texts().length;
  inject("102", "u-b", "AI寶，Excel 怎麼凍結窗格？");
  let got = await waitFor(() => textsSince(base).find((c) => c[2].includes("凍結窗格步驟")), 6000, "general answer");
  assert.equal(got[3]?.replyTo, "102");

  // B2) 句尾觸發: 問題取名字前面的內容
  base = provider.texts().length;
  inject("103", "u-b2", "Excel 怎麼凍結窗格，AI寶");
  got = await waitFor(() => textsSince(base).find((c) => c[2].includes("凍結窗格步驟")), 6000, "end-position trigger answer");
  assert.equal(got[3]?.replyTo, "103");

  // C) 知識庫問題 (showSources 開): 回答含來源檔名
  base = provider.texts().length;
  inject("104", "u-c", "AI寶，公司彩色列印在哪裡？");
  got = await waitFor(() => textsSince(base).find((c) => c[2].includes("參考來源")), 6000, "kb answer");
  assert.ok(got[2].includes("公司列印說明.txt"), "回答應註明來源檔名");

  // C2) 來源開關關閉 (showSources 關, 也是出廠預設): 同樣命中知識庫, 回答不得含任何來源行
  settings.update({ showSources: false });
  base = provider.texts().length;
  inject("1042", "u-c2", "AI寶，公司彩色列印在哪裡？");
  got = await waitFor(() => textsSince(base).find((c) => c[2].includes("依知識庫內容回答")), 6000, "kb answer without sources");
  assert.ok(!got[2].includes("參考來源"), "showSources 關閉時回答不得含參考來源");
  assert.ok(!got[2].includes("公司列印說明.txt"), "showSources 關閉時回答不得含來源檔名");
  settings.update({ showSources: true });

  // D) 公司類問題但知識庫查不到: 明說查不到
  base = provider.texts().length;
  inject("105", "u-d", "AI寶，公司今年尾牙在哪裡辦？");
  got = await waitFor(() => textsSince(base).find((c) => c[2].includes("查不到")), 6000, "kb miss answer");
  assert.ok(got[2].includes("知識庫"));

  // E) 只叫名字: 引導句含設定主名
  base = provider.texts().length;
  inject("106", "u-e", "AI寶");
  got = await waitFor(() => textsSince(base).find((c) => c[2].includes("我是AI寶")), 6000, "guidance");
  assert.ok(got[2].includes("你要問什麼"));

  // F) 防詐騙高機率 (無觸發名): 收到警告回覆該則訊息
  base = provider.texts().length;
  inject("107", "u-f", "好康報你知 https://bit.ly/abc123 加入飆股群，保證獲利翻倍，快點");
  got = await waitFor(() => textsSince(base).find((c) => c[2].includes("防詐騙警告")), 6000, "scam warning");
  assert.equal(got[3]?.replyTo, "107");
  assert.ok(got[2].includes("僅供參考"));

  // G) 低風險連結: 不打擾
  base = provider.texts().length;
  inject("108", "u-g", "公告在這裡 https://example.com/notice 請大家有空看一下");
  await sleep(900);
  assert.equal(textsSince(base).filter((c) => c[3]?.replyTo === "108").length, 0, "低風險不應發警告");

  // H) 手動判讀: 名字觸發 + 貼上可疑訊息問這是詐騙嗎
  base = provider.texts().length;
  inject("109", "u-h", "AI寶，這是詐騙嗎：有人叫我操作ATM解除分期付款，還給我連結 https://bit.ly/zz9");
  got = await waitFor(() => textsSince(base).find((c) => c[2].includes("判讀結果")), 6000, "manual scam verdict");
  assert.ok(got[2].includes("高度疑似詐騙"));

  // I) 改名後照樣觸發 (AI寶 -> 阿亮), 舊名失效
  settings.update({ botName: "阿亮" });
  base = provider.texts().length;
  inject("110", "u-i", "阿亮，Excel 怎麼凍結窗格？");
  got = await waitFor(() => textsSince(base).find((c) => c[2].includes("凍結窗格步驟")), 6000, "renamed trigger");
  assert.equal(got[3]?.replyTo, "110");
  base = provider.texts().length;
  inject("111", "u-j", "AI寶，Excel 怎麼凍結窗格？");
  await sleep(600);
  assert.equal(textsSince(base).length, 0, "改名後舊名不應再觸發");

  // J) log 與設定檔查無測試 Key
  bot.disconnect();
  const logFiles = await readdir(join(dataDir, "logs"));
  assert.ok(logFiles.length >= 1);
  let allLog = "";
  for (const f of logFiles) allLog += await readFile(join(dataDir, "logs", f), "utf8");
  assert.ok(!allLog.includes(TEST_KEY), "log 不得含測試 Key");
  assert.ok(allLog.includes("(防詐騙)"), "log 應有防詐騙模組紀錄");
  assert.ok(allLog.includes("(觸發判斷)"), "log 應有觸發判斷紀錄");
  const settingsRaw = await readFile(join(dataDir, "settings.json"), "utf8");
  assert.ok(!settingsRaw.includes(TEST_KEY), "設定檔不得含 Key");
  // 狀態彙總 (供測試報告引用)
  const st = bot.status();
  assert.equal(st.botName, "阿亮");
  assert.ok(st.answeredToday >= 4);
  assert.ok(st.scam.warnedToday >= 1);
});
