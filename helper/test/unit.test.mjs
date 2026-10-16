import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../src/logger.mjs";
import { FileSecretStore, MemorySecretStore, WindowsSecretStore, createSecretStore, maskSecret } from "../src/secrets.mjs";
import { SettingsStore, SECRET_NAMES } from "../src/config.mjs";
import { createAiClient } from "../src/ai.mjs";
import { createTriggerState, evaluateTrigger, markAnswered, markTriggered } from "../src/trigger.mjs";
import { KnowledgeBase } from "../src/kb.mjs";
import { extractScamTarget, isManualScamAsk, judgeScam, prefilterScam, ruleFallbackJudge, PerMinuteLimiter } from "../src/scam.mjs";
import { createConsoleServer } from "../src/server.mjs";
import { HelperBot } from "../src/bot.mjs";
import { createAiClient as aiFactory } from "../src/ai.mjs";

async function tmp() { return mkdtemp(join(tmpdir(), "helper-unit-")); }

test("logger: 每日一檔、遮罩秘密、不記全文 (非除錯)", async () => {
  const dir = await tmp();
  const logger = new Logger({ dir, debug: false });
  logger.addSecret("sk-SECRETKEY-9999zzzz");
  logger.info("啟動", "測試事件", { key: "sk-SECRETKEY-9999zzzz", auth: "Bearer abcdefgh12345678" });
  logger.logText("訊息接收", "訊息", "這是完整的秘密訊息內容");
  const files = await readdir(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^helper-\d{4}-\d{2}-\d{2}\.log$/);
  const content = await readFile(join(dir, files[0]), "utf8");
  assert.ok(!content.includes("sk-SECRETKEY-9999zzzz"), "log 不得含 Key");
  assert.ok(!content.includes("這是完整的秘密訊息內容"), "非除錯模式不得記全文");
  assert.ok(content.includes("長度="));
  assert.ok(content.includes("(啟動)"));
});

test("secrets: memory 與 AES 檔案後端 round-trip; 檔案不含明文", async () => {
  const mem = new MemorySecretStore();
  await mem.set("ai:openai", "sk-AAAA1111bbbb");
  assert.equal(await mem.get("ai:openai"), "sk-AAAA1111bbbb");
  assert.deepEqual(maskSecret("sk-AAAA1111bbbb"), { set: true, last4: "bbbb" });
  const dir = await tmp();
  const path = join(dir, "secrets.dev.json");
  const file = new FileSecretStore({ path });
  await file.set("ai:groq", "gsk-XYZ9876");
  assert.equal(await file.get("ai:groq"), "gsk-XYZ9876");
  const raw = await readFile(path, "utf8");
  assert.ok(!raw.includes("gsk-XYZ9876"));
  await file.delete("ai:groq");
  assert.equal(await file.get("ai:groq"), null);
});

test("secrets: Windows 後端在非 Windows 優雅停用, 工廠自動改用檔案後端", async () => {
  if (process.platform === "win32") return;
  assert.throws(() => new WindowsSecretStore({}), /只能在 Windows/);
  const dir = await tmp();
  const logs = [];
  const fakeLogger = { info: (...a) => logs.push(a), warn: (...a) => logs.push(a) };
  const store = createSecretStore({ dataDir: dir, logger: fakeLogger });
  assert.equal(store.kind, "file-aes-dev");
  await store.set("k", "v1234");
  assert.equal(await store.get("k"), "v1234");
});

test("config: 預設主名 AI寶 (設定值)、別名空; Key 不進設定 JSON; publicView 只回末4碼", async () => {
  const dir = await tmp();
  const store = new SettingsStore({ path: join(dir, "settings.json") });
  assert.equal(store.get().botName, "AI寶");
  assert.deepEqual(store.get().aliases, []);
  store.update({ ai: { providers: { openai: { apiKey: "sk-SHOULD-NOT-SAVE", model: "m1" } } } });
  const raw = await readFile(join(dir, "settings.json"), "utf8");
  assert.ok(!raw.includes("sk-SHOULD-NOT-SAVE"));
  assert.equal(store.get().ai.providers.openai.model, "m1");
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.openai, "sk-LIVEKEY-7777wxyz");
  const view = await store.publicView(secrets);
  assert.equal(view.ai.providers.openai.set, true);
  assert.equal(view.ai.providers.openai.last4, "wxyz");
  assert.ok(!JSON.stringify(view).includes("sk-LIVEKEY-7777wxyz"));
});

function triggerSettings(over = {}) {
  return { botName: "AI寶", aliases: ["阿寶"], triggerMode: "standard", cooldownSec: 20, dailyLimit: 100, ...over };
}
test("trigger: 設定名 AI寶 觸發、別名觸發、無名不觸發、句中閒聊標準模式不觸發", () => {
  const st = createTriggerState();
  let v = evaluateTrigger({ text: "AI寶,Excel 怎麼凍結窗格？", senderId: "u1", selfId: "me", settings: triggerSettings(), state: st });
  assert.equal(v.triggered, true); assert.equal(v.question, "Excel 怎麼凍結窗格？");
  v = evaluateTrigger({ text: "阿寶 請問列印怎麼設定", senderId: "u2", selfId: "me", settings: triggerSettings(), state: st });
  assert.equal(v.triggered, true);
  v = evaluateTrigger({ text: "今天午餐吃什麼", senderId: "u3", selfId: "me", settings: triggerSettings(), state: st });
  assert.equal(v.triggered, false); assert.equal(v.reason, "no_name");
  v = evaluateTrigger({ text: "AI寶今天怪怪的", senderId: "u4", selfId: "me", settings: triggerSettings(), state: st });
  assert.equal(v.triggered, false); assert.equal(v.reason, "not_question");
  v = evaluateTrigger({ text: "AI寶今天怪怪的", senderId: "u5", selfId: "me", settings: triggerSettings({ triggerMode: "loose" }), state: st });
  assert.equal(v.triggered, true);
  v = evaluateTrigger({ text: "你好 AI寶 請問一下", senderId: "u6", selfId: "me", settings: triggerSettings({ triggerMode: "strict" }), state: st });
  assert.equal(v.triggered, false); assert.equal(v.reason, "not_at_start");
  v = evaluateTrigger({ text: "AI寶", senderId: "u7", selfId: "me", settings: triggerSettings(), state: st });
  assert.equal(v.triggered, true); assert.equal(v.reason, "name_only");
  v = evaluateTrigger({ text: "AI寶,問題", senderId: "me", selfId: "me", settings: triggerSettings(), state: st });
  assert.equal(v.triggered, false); assert.equal(v.reason, "self");
});

test("trigger: 改名後照樣觸發 (AI寶 -> 阿亮), 舊名失效; 完全自訂設定決定", () => {
  const st = createTriggerState();
  const renamed = triggerSettings({ botName: "阿亮", aliases: [] });
  let v = evaluateTrigger({ text: "阿亮,Word 怎麼把直書改橫書？", senderId: "u1", selfId: "me", settings: renamed, state: st });
  assert.equal(v.triggered, true); assert.equal(v.matchedName, "阿亮");
  v = evaluateTrigger({ text: "AI寶,Word 怎麼把直書改橫書？", senderId: "u2", selfId: "me", settings: renamed, state: st });
  assert.equal(v.triggered, false); assert.equal(v.reason, "no_name");
  // 名字清空時不觸發任何訊息
  const empty = triggerSettings({ botName: "", aliases: [] });
  v = evaluateTrigger({ text: "AI寶,問題？", senderId: "u3", selfId: "me", settings: empty, state: st });
  assert.equal(v.triggered, false);
});

test("trigger: 名字位置不限 (句首/句中/句尾) 標準模式; 問題正確去掉名字", () => {
  const st = createTriggerState();
  // 句尾: 問題取名字前面的內容, 並去掉尾端逗號
  let v = evaluateTrigger({ text: "Excel 怎麼凍結窗格，AI寶", senderId: "u1", selfId: "me", settings: triggerSettings(), state: st });
  assert.equal(v.triggered, true);
  assert.equal(v.question, "Excel 怎麼凍結窗格");
  // 句首
  v = evaluateTrigger({ text: "AI寶，Excel 怎麼凍結窗格", senderId: "u2", selfId: "me", settings: triggerSettings(), state: st });
  assert.equal(v.triggered, true);
  assert.equal(v.question, "Excel 怎麼凍結窗格");
  // 句中
  v = evaluateTrigger({ text: "請問 AI寶，Word 目錄怎麼自動產生", senderId: "u3", selfId: "me", settings: triggerSettings(), state: st });
  assert.equal(v.triggered, true);
  assert.equal(v.question, "Word 目錄怎麼自動產生");
  // 閒聊提及 (句首但非問句/請求) 標準模式不觸發
  v = evaluateTrigger({ text: "AI寶今天好像怪怪的", senderId: "u4", selfId: "me", settings: triggerSettings(), state: st });
  assert.equal(v.triggered, false);
  assert.equal(v.reason, "not_question");
  // 句尾閒聊同樣不觸發
  v = evaluateTrigger({ text: "今天 AI寶 好像怪怪的", senderId: "u5", selfId: "me", settings: triggerSettings(), state: st });
  assert.equal(v.triggered, false);
});

test("trigger: 冷卻與每日上限", () => {
  const st = createTriggerState();
  const now = new Date();
  let v = evaluateTrigger({ text: "AI寶,問題一？", senderId: "u1", selfId: "me", settings: triggerSettings(), state: st, now });
  assert.equal(v.triggered, true);
  markTriggered(st, "u1", now); markAnswered(st, now);
  v = evaluateTrigger({ text: "AI寶,問題二？", senderId: "u1", selfId: "me", settings: triggerSettings(), state: st, now: new Date(now.getTime() + 5000) });
  assert.equal(v.triggered, false); assert.equal(v.reason, "cooldown");
  v = evaluateTrigger({ text: "AI寶,問題三？", senderId: "u1", selfId: "me", settings: triggerSettings({ dailyLimit: 1 }), state: st, now: new Date(now.getTime() + 60000) });
  assert.equal(v.triggered, false); assert.equal(v.reason, "daily_limit"); assert.equal(v.limitReached, true);
});

async function aiStubServer(handler) {
  const server = createServer(async (req, res) => {
    const parts = []; for await (const c of req) parts.push(c);
    const body = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    const out = handler(body, req);
    res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}
test("ai: 共用 OpenAI 相容格式 chat 與 testConnection (本機 stub)", async (t) => {
  const { server, url } = await aiStubServer((body, req) => {
    assert.equal(req.headers.authorization, "Bearer sk-STUBKEY-0000aaaa");
    return { body: { model: body.model, choices: [{ message: { role: "assistant", content: " stub 回答 " } }], usage: { total_tokens: 3 } } };
  });
  t.after(() => server.close());
  const ai = createAiClient({});
  const r = await ai.chat({ baseUrl: url, apiKey: "sk-STUBKEY-0000aaaa", model: "stub-model", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.content, "stub 回答");
  const tc = await ai.testConnection({ baseUrl: url, model: "stub-model" }, "sk-STUBKEY-0000aaaa");
  assert.equal(tc.ok, true);
  const tc2 = await ai.testConnection({ baseUrl: url, model: "stub-model" }, "");
  assert.equal(tc2.ok, false); assert.match(tc2.message, /下一步/);
});

test("kb: 掃描、切段、BM25 搜尋附來源; 索引存資料夾外; 資料夾唯讀不被改", async () => {
  const root = await tmp();
  const { mkdir, writeFile, stat } = await import("node:fs/promises");
  const kbDir = join(root, "kb"); await mkdir(kbDir);
  await writeFile(join(kbDir, "列印說明.txt"), "公司彩色列印在總公司四樓影印室。彩色影印機分機 412, 列印前請先在影印室登記。A3 列印也在四樓。");
  await writeFile(join(kbDir, "網路申請.md"), "VPN 申請流程: 填寫資訊部表單, 經主管簽核後開通。遠端連線使用公司配發帳號。");
  await writeFile(join(kbDir, "不支援.pdf"), "%PDF fake");
  const before = (await stat(join(kbDir, "列印說明.txt"))).mtimeMs;
  const kb = new KnowledgeBase({ folder: kbDir, indexPath: join(root, "outside", "kb-index.json") });
  const st = kb.scan({ force: true });
  assert.equal(st.files, 2);
  assert.ok(st.chunks >= 2);
  const hits = kb.search("公司彩色列印在哪裡", 3);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].file, "列印說明.txt");
  const miss = kb.search("尾牙抽獎獎品", 3);
  assert.equal(miss.length, 0);
  assert.equal((await stat(join(kbDir, "列印說明.txt"))).mtimeMs, before);
});

test("scam: 預篩規則、AI 判讀解析、手動詢問抽取、備援與限流", async () => {
  assert.equal(prefilterScam("午餐吃牛肉麵").hit, false);
  const pf = prefilterScam("快加入 https://bit.ly/xx99 保證獲利飆股群");
  assert.equal(pf.hit, true);
  assert.ok(pf.rules.includes("url") && pf.rules.includes("short_url"));
  const ai = aiFactory({});
  const chatHigh = async (args) => ({ content: "{\"probability\":0.93,\"tactic\":\"假投資\",\"reason\":\"短網址加保證獲利\"}", latencyMs: 5 });
  const v = await judgeScam({ text: "保證獲利", aiChat: chatHigh, providerCfg: {}, apiKey: "k" });
  assert.equal(v.probability, 0.93); assert.equal(v.tactic, "假投資"); assert.equal(v.fallback, false);
  const chatBad = async () => ({ content: "我覺得很危險", latencyMs: 1 });
  const v2 = await judgeScam({ text: "到 https://x.example 操作ATM解除分期", aiChat: chatBad, providerCfg: {}, apiKey: "k" });
  assert.equal(v2.fallback, true); assert.ok(v2.probability > 0.5);
  assert.ok(isManualScamAsk("這是詐騙嗎:內容"));
  assert.equal(extractScamTarget("這是詐騙嗎:有人要我匯款驗證請幫忙"), "有人要我匯款驗證請幫忙");
  const lim = new PerMinuteLimiter(2);
  assert.equal(lim.tryTake(), true); assert.equal(lim.tryTake(), true); assert.equal(lim.tryTake(), false);
});

test("console: 設定 API 遮罩、頁面有粉圓字體與動態標題, 診斷包是 ZIP", async (t) => {
  const dir = await tmp();
  const settings = new SettingsStore({ path: join(dir, "settings.json") });
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.openai, "sk-CONSOLE-KEY-5555qrst");
  const logger = new Logger({ dir: join(dir, "logs") });
  const ai = createAiClient({});
  const kb = new KnowledgeBase({ folder: "", indexPath: join(dir, "kb.json"), logger });
  const bot = new HelperBot({ settings, secrets, ai, kb, logger });
  const server = createConsoleServer({ settings, secrets, ai, kb, bot, logger });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base + "/")).text();
  assert.ok(html.includes("Huninn"));
  assert.ok(html.includes("名字由你自訂"));
  const view = await (await fetch(base + "/api/settings")).json();
  assert.ok(!JSON.stringify(view).includes("sk-CONSOLE-KEY-5555qrst"));
  assert.equal(view.ai.providers.openai.last4, "qrst");
  assert.equal(view.botName, "AI寶");
  const zipRes = await fetch(base + "/api/diagnostic");
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  assert.equal(zipBuf.subarray(0, 2).toString(), "PK");
  const fontRes = await fetch(base + "/assets/font.ttf");
  assert.equal(fontRes.status, 200);
  assert.ok((await fontRes.arrayBuffer()).byteLength > 1000000);
});
