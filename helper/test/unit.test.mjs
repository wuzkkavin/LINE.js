import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Logger } from "../src/logger.mjs";
import { FileSecretStore, MemorySecretStore, WindowsSecretStore, createSecretStore, maskSecret } from "../src/secrets.mjs";
import { SettingsStore, SECRET_NAMES, DEFAULT_CREATOR_REPLY, DEFAULT_SCOPE_PROMPT, DEFAULT_ROLE_PROMPT, DEFAULT_SYSTEM_PROMPT, LEGACY_DEFAULT_SYSTEM_PROMPT } from "../src/config.mjs";
import { createAiClient, DEFAULT_LIST_MODELS_TIMEOUT_MS } from "../src/ai.mjs";
import { createTriggerState, evaluateTrigger, markAnswered, markTriggered, localDateKey } from "../src/trigger.mjs";
import { KnowledgeBase } from "../src/kb.mjs";
import { extractScamTarget, isManualScamAsk, judgeScam, prefilterScam, ruleFallbackJudge, PerMinuteLimiter } from "../src/scam.mjs";
import { createConsoleServer } from "../src/server.mjs";
import { parseApiSection, applyApiConfig, applyCoreApiConfig, readCoreApiStatus, isValidChatId } from "../src/linecfg.mjs";
import { MessageSenderRegistry } from "../src/msgregistry.mjs";
import { HelperBot, isCreatorIntent, calculateAge, buildPersonaSection, buildScopeSection, cleanAnswerText, QUOTE_HISTORY_PAGES, answerFilename, splitLongText, TEXT_SEND_LIMIT, LINE_FORMAT_RULE } from "../src/bot.mjs";
import { coreEndpoints, fetchCoreChannels, shapeChatList } from "../src/corechats.mjs";
import { WebSocketServer } from "ws";
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

test("trigger: 引用機器人自己的訊息 = 續答觸發 (不需名字、略過意圖判定)", () => {
  const st = createTriggerState();
  // 引用自己 + 追問沒有問句提示詞: 標準模式靠名字規則不會觸發, 靠引用要觸發
  let v = evaluateTrigger({ text: "那 Word 呢", senderId: "u1", selfId: "me", settings: triggerSettings(), state: st, quotedSelf: true });
  assert.equal(v.triggered, true); assert.equal(v.reason, "quote"); assert.equal(v.question, "那 Word 呢");
  // 同一則不帶引用: 不觸發 (對照)
  v = evaluateTrigger({ text: "那 Word 呢", senderId: "u1", selfId: "me", settings: triggerSettings(), state: st });
  assert.equal(v.triggered, false); assert.equal(v.reason, "no_name");
  // 嚴格模式下引用續答也觸發 (略過句首判定)
  v = evaluateTrigger({ text: "原來如此, 那如果是橫向的呢", senderId: "u2", selfId: "me", settings: triggerSettings({ triggerMode: "strict" }), state: st, quotedSelf: true });
  assert.equal(v.triggered, true);
  // 引用自己 + 文字含名但非問句: 引用路徑優先, 不被 not_question 擋下
  v = evaluateTrigger({ text: "AI寶 然後呢就這樣放著", senderId: "u3", selfId: "me", settings: triggerSettings(), state: st, quotedSelf: true });
  assert.equal(v.triggered, true);
});

test("trigger: 引用別人的訊息不算觸發; 引用但文字為空不觸發", () => {
  const st = createTriggerState();
  // quotedSelf=false 就是引用別人: 回到名字規則
  let v = evaluateTrigger({ text: "這段說得有道理", senderId: "u1", selfId: "me", settings: triggerSettings(), state: st, quotedSelf: false });
  assert.equal(v.triggered, false); assert.equal(v.reason, "no_name");
  // 引用自己但只剩標點/空白: 清理後沒內容, 不觸發
  v = evaluateTrigger({ text: "  ", senderId: "u2", selfId: "me", settings: triggerSettings(), state: st, quotedSelf: true });
  assert.equal(v.triggered, false); assert.equal(v.reason, "empty");
  v = evaluateTrigger({ text: "。", senderId: "u2", selfId: "me", settings: triggerSettings(), state: st, quotedSelf: true });
  assert.equal(v.triggered, false);
  // 引用自己也擋不住自己人檢查: 機器人自己發的訊息永遠忽略
  v = evaluateTrigger({ text: "那 Word 呢", senderId: "me", selfId: "me", settings: triggerSettings(), state: st, quotedSelf: true });
  assert.equal(v.triggered, false); assert.equal(v.reason, "self");
});

test("trigger: 引用續答不被冷卻擋下, 但仍受每日上限 (2026-10-20 驗收修復改版)", () => {
  // 改版說明: 舊版斷言「引用續答仍受冷卻」, 實機驗收證明這會讓使用者在機器人回答完的
  // 幾秒內引用追問只得到沉默 (與壞掉無異)。新語義: 引用續答跳過冷卻檢查, 每日上限照擋;
  // 名字觸發的冷卻不變 (見下一個測試), 且引用觸發後 bot 仍會 markTriggered 刷新冷卻起點。
  const st = createTriggerState();
  const now = new Date();
  let v = evaluateTrigger({ text: "AI寶,問題一？", senderId: "u1", selfId: "me", settings: triggerSettings(), state: st, now });
  assert.equal(v.triggered, true);
  markTriggered(st, "u1", now); markAnswered(st, now);
  // 冷卻中 (5 秒後): 引用自己的回答追問 → 照常觸發 (reason quote)
  v = evaluateTrigger({ text: "那問題二呢", senderId: "u1", selfId: "me", settings: triggerSettings(), state: st, now: new Date(now.getTime() + 5000), quotedSelf: true });
  assert.equal(v.triggered, true); assert.equal(v.reason, "quote");
  // 對照: 同一時刻用名字再問 → 仍被冷卻擋下
  v = evaluateTrigger({ text: "AI寶,問題二？", senderId: "u1", selfId: "me", settings: triggerSettings(), state: st, now: new Date(now.getTime() + 5000) });
  assert.equal(v.triggered, false); assert.equal(v.reason, "cooldown");
  // 每日上限: 引用續答同樣被擋下並帶 limitReached
  const st2 = createTriggerState();
  markAnswered(st2, now); markAnswered(st2, now);
  v = evaluateTrigger({ text: "再告訴我一件事", senderId: "u9", selfId: "me", settings: triggerSettings({ dailyLimit: 2 }), state: st2, now, quotedSelf: true });
  assert.equal(v.triggered, false); assert.equal(v.reason, "daily_limit"); assert.equal(v.limitReached, true);
});

test("bot: 長回答交付工具 — 檔名格式與分段邊界 (不切半句/不切斷代理對)", () => {
  const d = new Date(2026, 9, 20, 21, 28, 0);
  assert.equal(answerFilename("Excel 怎麼凍結窗格?", d), "AI寶回答-20261020-Excel怎麼凍結窗.txt");
  assert.equal(answerFilename("  ", d), "AI寶回答-20261020.txt");
  assert.equal(answerFilename("a/b:c*d?e", d), "AI寶回答-20261020-abcde.txt");
  // 短文不分段
  assert.deepEqual(splitLongText("短短的回答", 8000), ["短短的回答"]);
  // 超過上限: 在段落邊界切, 每段 <= 上限, 內容不遺失 (去掉段界空白後可還原)
  const para = "段落甲。".repeat(100);
  const text = [para, para, para].join("\n\n");
  const parts = splitLongText(text, 500);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 500));
  assert.equal(parts.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
  // 沒有換行可切時硬切, 但不切斷 emoji 的代理對
  const emojiText = "字".repeat(499) + "🙂" + "字".repeat(600);
  const hard = splitLongText(emojiText, 500);
  assert.ok(hard.every((p) => p.length <= 500));
  assert.equal(hard.join(""), emojiText);
  assert.equal(TEXT_SEND_LIMIT, 8000);
});

test("msgregistry: 登記/查詢/過期/上限/持久化來回", async () => {
  let clock = 1000000;
  const now = () => clock;
  const dir = await mkdtemp(join(tmpdir(), "helper-registry-"));
  const path = join(dir, "message-senders.json");
  const reg = new MessageSenderRegistry({ path, ttlMs: 10000, maxEntries: 3, now });
  reg.register("m1", "u-me");
  reg.register("m2", "u-other");
  assert.equal(reg.lookup("m1"), "u-me");
  assert.equal(reg.lookup("m2"), "u-other");
  assert.equal(reg.lookup("nope"), undefined);
  // 空字串記號: 查過但查無此訊息
  reg.register("gone", "");
  assert.equal(reg.lookup("gone"), "");
  // 過期: 超過 ttl 後查不到
  clock += 11000;
  assert.equal(reg.lookup("m1"), undefined);
  // 上限: 只留最新 3 筆
  const reg2 = new MessageSenderRegistry({ ttlMs: 60000, maxEntries: 3, now });
  for (const id of ["a", "b", "c", "d"]) { reg2.register(id, "u-me"); clock += 1; }
  assert.equal(reg2.size, 3);
  assert.equal(reg2.lookup("a"), undefined);
  assert.equal(reg2.lookup("d"), "u-me");
  // 持久化: flush 後新實例讀得回來
  reg.register("keep", "u-me");
  reg.flush();
  const reg3 = new MessageSenderRegistry({ path, ttlMs: 10000, maxEntries: 3, now });
  assert.equal(reg3.lookup("keep"), "u-me");
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.version, 1);
  assert.ok(Array.isArray(raw.entries));
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

test("ai: chat 回傳 finishReason (length = 被額度截斷, 呼叫端據此留 log)", async (t) => {
  const { server, url } = await aiStubServer(() => ({ body: { model: "stub-model", choices: [{ message: { role: "assistant", content: "講到一半就被切斷的長回答" }, finish_reason: "length" }], usage: { completion_tokens: 4096 } } }));
  t.after(() => server.close());
  const ai = createAiClient({});
  const r = await ai.chat({ baseUrl: url, apiKey: "sk-x", model: "stub-model", messages: [{ role: "user", content: "hi" }], maxTokens: 4096 });
  assert.equal(r.finishReason, "length");
  assert.equal(r.content, "講到一半就被切斷的長回答");
});

async function modelsStubServer(handler) {
  const server = createServer(async (req, res) => {
    const out = handler(req);
    res.writeHead(out.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

test("ai: listModels 解析清單 (去重排序)、無 Key 錯誤 (本機 stub)", async (t) => {
  const { server, url } = await modelsStubServer((req) => {
    assert.ok(req.url.endsWith("/models"));
    assert.equal(req.headers.authorization, "Bearer sk-MODELS-0000aaaa");
    return { body: { data: [{ id: "b-model" }, { id: "a-model" }, { id: "a-model" }, { id: " " }, {}] } };
  });
  t.after(() => server.close());
  const ai = createAiClient({});
  const r = await ai.listModels({ baseUrl: url }, "sk-MODELS-0000aaaa");
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ["a-model", "b-model"]);
  assert.match(r.message, /2 個可用模型/);
  const noKey = await ai.listModels({ baseUrl: url }, "");
  assert.equal(noKey.ok, false); assert.equal(noKey.code, "AI_NO_KEY"); assert.match(noKey.message, /API Key/);
});

test("ai: listModels 供應商回 401 時給白話錯誤 (本機 stub)", async (t) => {
  const { server, url } = await modelsStubServer(() => ({ status: 401, body: { error: { message: "Invalid API Key" } } }));
  t.after(() => server.close());
  const ai = createAiClient({});
  const r = await ai.listModels({ baseUrl: url }, "sk-BADKEY");
  assert.equal(r.ok, false); assert.equal(r.code, "AI_HTTP"); assert.match(r.message, /下一步/);
});

test("ai: 推理模型 reasoning-only 不誤判連線 (chat 自動加倍額度, testConnection 成功)", async (t) => {
  const seen = [];
  const { server, url } = await aiStubServer((body) => {
    seen.push(body.max_tokens);
    if (body.max_tokens < 1024) return { body: { model: body.model, choices: [{ message: { role: "assistant", content: "", reasoning: "思考中" }, finish_reason: "length" }] } };
    return { body: { model: body.model, choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] } };
  });
  t.after(() => server.close());
  const ai = createAiClient({});
  const tc = await ai.testConnection({ baseUrl: url, model: "reasoning-stub" }, "sk-REASON-0000aaaa");
  assert.equal(tc.ok, true);
  assert.ok(seen.includes(512) && seen.includes(1024), "reasoning-only 時應自動加倍額度重試");
});

test("ai: 一直 reasoning-only 時 testConnection 仍判定連通並註明推理模型", async (t) => {
  const { server, url } = await aiStubServer((body) => ({ body: { model: body.model, choices: [{ message: { role: "assistant", content: "", reasoning: "一直在想" }, finish_reason: "length" }] } }));
  t.after(() => server.close());
  const ai = createAiClient({});
  const tc = await ai.testConnection({ baseUrl: url, model: "reasoning-stub" }, "sk-REASON-0000aaaa");
  assert.equal(tc.ok, true); assert.equal(tc.reasoningOnly, true); assert.match(tc.message, /推理模型/);
  const chatErr = await ai.chat({ baseUrl: url, apiKey: "sk-REASON-0000aaaa", model: "reasoning-stub", messages: [{ role: "user", content: "hi" }], maxTokens: 4096 }).then(() => null, (e) => e);
  assert.equal(chatErr?.code, "AI_REASONING_ONLY");
});

test("ai: Groq 形狀 (message 無 reasoning 欄位、證據在 usage.reasoning_tokens、finish=stop) 不誤判", async (t) => {
  // 2026-10-20 老吳實機: Groq 的 gpt-oss 回應長這樣 — content 空、finish_reason=stop,
  // 推理證據只在 usage.completion_tokens_details.reasoning_tokens。舊邏輯只看 message 欄位與 finish=length, 直接誤判「沒有回答內容」。
  const seen = [];
  const { server, url } = await aiStubServer((body) => {
    seen.push(body);
    if (body.max_tokens < 1024) {
      return { body: { model: body.model, choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 200, completion_tokens_details: { reasoning_tokens: 200 } } } };
    }
    return { body: { model: body.model, choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 210, completion_tokens_details: { reasoning_tokens: 205 } } } };
  });
  t.after(() => server.close());
  const ai = createAiClient({});
  const tc = await ai.testConnection({ baseUrl: url, model: "openai/gpt-oss-120b" }, "sk-GROQ-0000bbbb");
  assert.equal(tc.ok, true, "Groq 形狀的推理回應應判定連通");
  assert.ok(seen.length >= 2, "content 為空但有推理 token 證據時應加倍額度重試");
  assert.ok(seen.every((b) => b.reasoning_effort === "low"), "gpt-oss 系列每次呼叫都要帶 reasoning_effort=low");
});

test("ai: Groq 形狀一直回空 (silent empty) 時 testConnection 仍判定連通", async (t) => {
  const { server, url } = await aiStubServer((body) => ({ body: { model: body.model, choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 180, completion_tokens_details: { reasoning_tokens: 180 } } } }));
  t.after(() => server.close());
  const ai = createAiClient({});
  const tc = await ai.testConnection({ baseUrl: url, model: "openai/gpt-oss-120b" }, "sk-GROQ-0000bbbb");
  assert.equal(tc.ok, true);
  assert.equal(tc.reasoningOnly, true);
  const chatErr = await ai.chat({ baseUrl: url, apiKey: "sk-GROQ-0000bbbb", model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "hi" }] }).then(() => null, (e) => e);
  assert.equal(chatErr?.code, "AI_REASONING_ONLY", "正式 chat 沒內容仍要報錯, 不能把空回答當成功");
});

test("ai: 非 gpt-oss 模型不送 reasoning_effort; 無 usage 的空回應仍判格式不正確", async (t) => {
  const seen = [];
  const { server, url } = await aiStubServer((body) => {
    seen.push(body);
    return { body: { model: body.model, choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] } };
  });
  t.after(() => server.close());
  const ai = createAiClient({});
  const tc = await ai.testConnection({ baseUrl: url, model: "llama-3.3-70b-versatile" }, "sk-GROQ-0000cccc");
  assert.equal(tc.ok, false, "沒有任何完成證據的空回應不能判定連通");
  assert.match(tc.message, /沒有回答內容/);
  assert.ok(seen.every((b) => !("reasoning_effort" in b)), "非 gpt-oss 模型不得送 Groq 專屬參數");
});

test("linecfg: config.yaml api 區塊解析與白名單寫入 (備份、驗證、防重複)", async () => {
  const { writeFileSync, readFileSync } = await import("node:fs");
  const dir = await tmp();
  const sample = [
    "server:",
    "  port: 3789",
    "api:",
    "  enabled: false",
    "  # chats:",
    "  #   - c0123456789abcdef0123456789abcdef",
    "  sendsPerMinute: 20",
    "",
  ].join("\n");
  const gid = "c" + "a".repeat(32);
  const parsed0 = parseApiSection(sample);
  assert.equal(parsed0.enabled, false); assert.deepEqual(parsed0.chats, [], "註解範例不應被當成白名單");
  const applied = applyApiConfig(sample, gid);
  const parsed1 = parseApiSection(applied);
  assert.equal(parsed1.enabled, true); assert.deepEqual(parsed1.chats, [gid]);
  const applied2 = applyApiConfig(applied, gid);
  assert.deepEqual(parseApiSection(applied2).chats, [gid], "重複加入不應重複列");
  const gid2 = "c" + "d".repeat(32);
  assert.deepEqual(parseApiSection(applyApiConfig(applied, gid2)).chats, [gid, gid2], "第二個群組應接在清單後面");
  assert.equal(isValidChatId(gid), true);
  assert.equal(isValidChatId("hello"), false);
  writeFileSync(join(dir, "config.yaml"), sample);
  const r = applyCoreApiConfig({ dataDir: dir, repoRoot: join(dir, "nope"), chatId: gid });
  assert.equal(r.apiEnabled, true);
  assert.equal(readFileSync(join(dir, "config.yaml.bak"), "utf8"), sample, "備份應為原內容");
  const st = readCoreApiStatus({ dataDir: dir, repoRoot: join(dir, "nope") });
  assert.equal(st.exists, true); assert.equal(st.apiEnabled, true); assert.deepEqual(st.chats, [gid]);
  assert.throws(() => applyCoreApiConfig({ dataDir: dir, repoRoot: dir, chatId: "bad-id" }), /格式不對/);
});

test("console: /api/list-models 與 LINE 引導端點 (模型清單、Token 自動產生、白名單)", async (t) => {
  const dir = await tmp();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "config.yaml"), "api:\n  enabled: false\n");
  const settings = new SettingsStore({ path: join(dir, "settings.json") });
  const secrets = new MemorySecretStore();
  const logger = new Logger({ dir: join(dir, "logs") });
  const { server: stub, url: stubUrl } = await modelsStubServer(() => ({ body: { data: [{ id: "m2" }, { id: "m1" }] } }));
  t.after(() => stub.close());
  const ai = createAiClient({});
  const kb = new KnowledgeBase({ folder: "", indexPath: join(dir, "kb.json"), logger });
  const bot = new HelperBot({ settings, secrets, ai, kb, logger });
  const fakeToken = "tokFAKE" + "x".repeat(30) + "wxyz";
  const server = createConsoleServer({ settings, secrets, ai, kb, bot, logger, lineEnv: { dataDir: dir, repoRoot: join(dir, "nope"), packaged: true, generateToken: async () => fakeToken } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
  const noKey = await post("/api/list-models", { provider: "groq", baseUrl: stubUrl });
  assert.equal(noKey.ok, false); assert.equal(noKey.code, "AI_NO_KEY"); assert.match(noKey.message, /API Key/);
  const list = await post("/api/list-models", { provider: "groq", apiKey: "sk-LIST-0000aaaa", baseUrl: stubUrl });
  assert.equal(list.ok, true); assert.deepEqual(list.models, ["m1", "m2"]);
  const st0 = await (await fetch(base + "/api/line/config-status")).json();
  assert.equal(st0.exists, true); assert.equal(st0.apiEnabled, false);
  const gid = "c" + "b".repeat(32);
  const applied = await post("/api/line/config-apply", { chatId: gid });
  assert.equal(applied.ok, true); assert.equal(applied.apiEnabled, true); assert.deepEqual(applied.chats, [gid]);
  const badApply = await post("/api/line/config-apply", { chatId: "xyz" });
  assert.equal(badApply.ok, false); assert.match(badApply.message, /格式不對/);
  const gen = await post("/api/line/generate-token");
  assert.equal(gen.ok, true); assert.equal(gen.last4, "wxyz");
  assert.ok(!JSON.stringify(gen).includes(fakeToken), "回應不得含完整 Token");
  assert.equal(await secrets.get(SECRET_NAMES.lineToken), fakeToken);
  const view = await (await fetch(base + "/api/settings")).json();
  assert.equal(view.line.set, true); assert.equal(view.line.last4, "wxyz");
  const manualToken = "tokMANUAL" + "y".repeat(24) + "zzzz";
  const put = await fetch(base + "/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ line: { apiKey: manualToken } }) }).then((r) => r.json());
  assert.equal(put.ok, true);
  assert.equal(await secrets.get(SECRET_NAMES.lineToken), manualToken);
  const html = await (await fetch(base + "/")).text();
  assert.ok(html.includes("取得可用模型") && html.includes("LINE 連接設定") && html.includes("自動產生 Token"), "新版介面元素應存在");
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
  const st = await kb.scan({ force: true });
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
  assert.ok(html.includes("回答時附上參考來源"), "知識庫區應有參考來源開關");
  assert.ok(html.includes("創造者問題的固定回覆"), "機器人區應有創造者固定回覆欄位");
  assert.ok(html.includes("機器人人設") && html.includes("出生日"), "機器人區應有人設欄位組");
  const view = await (await fetch(base + "/api/settings")).json();
  assert.ok(!JSON.stringify(view).includes("sk-CONSOLE-KEY-5555qrst"));
  assert.equal(view.ai.providers.openai.last4, "qrst");
  assert.equal(view.botName, "AI寶");
  const status = await (await fetch(base + "/api/status")).json();
  assert.equal(status.service, "aibao-helper", "/api/status 必須帶身分標記, 原生 App 靠它分辨 3790 上的是新版還是舊版 helper");
  assert.ok(status.capabilities.includes("list-models"));
  const zipRes = await fetch(base + "/api/diagnostic");
  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  assert.equal(zipBuf.subarray(0, 2).toString(), "PK");
  const fontRes = await fetch(base + "/assets/font.ttf");
  assert.equal(fontRes.status, 200);
  assert.ok((await fontRes.arrayBuffer()).byteLength > 1000000);
});

test("corechats: 網頁通道讀清單 (假核心): refresh 後的新清單優先, shape 過濾個人並標白名單", async (t) => {
  const gid = "c" + "a".repeat(32);
  const rid = "r" + "d".repeat(32);
  const uid = "u" + "e".repeat(32);
  const snap1 = [{ channelId: gid, kind: "group", name: "舊快照", memberCount: 3 }];
  const snap2 = [
    { channelId: uid, kind: "user", name: "路人甲" },
    { channelId: rid, kind: "room", name: "多人聊天室" },
    { channelId: gid, kind: "group", name: "公司測試群", memberCount: 5 },
  ];
  let sawCookie = false;
  const http = createServer((req, res) => {
    res.writeHead(200, { "Set-Cookie": "linejs_browser=stubcookie; Path=/; HttpOnly", "Content-Type": "text/html" });
    res.end("<html>stub core</html>");
  });
  const wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (sock, req) => {
    sawCookie = String(req.headers.cookie ?? "").includes("linejs_browser=stubcookie");
    const send = (o) => sock.send(JSON.stringify(o));
    send({ type: "hello", protocol: 2, serverVersion: "stub" });
    send({ type: "auth:state", state: "ready" });
    send({ type: "auth:ready", profile: { id: uid, name: "測試帳號" } });
    send({ type: "channels", channels: snap1 });
    sock.on("message", (data) => {
      try {
        const f = JSON.parse(data.toString());
        if (f.type === "channels:refresh") send({ type: "channels", channels: snap2 });
      } catch {}
    });
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  t.after(() => { wss.close(); http.close(); });
  const port = http.address().port;
  const ep = coreEndpoints(`ws://127.0.0.1:${port}/api/ws`);
  assert.equal(ep.pageWsUrl, `ws://127.0.0.1:${port}/ws`);
  assert.equal(ep.authority, `127.0.0.1:${port}`);
  const r = await fetchCoreChannels({ lineApiUrl: `ws://127.0.0.1:${port}/api/ws`, timeoutMs: 5000, refreshWaitMs: 2500 });
  assert.equal(r.status, "ok");
  assert.deepEqual(r.channels, snap2, "應採用 refresh 後送來的第二份清單");
  assert.equal(sawCookie, true, "連核心網頁通道應帶 linejs_browser cookie");
  const shaped = shapeChatList(r.channels, [gid]);
  assert.equal(shaped.length, 2, "個人 (user) 不列入白名單候選");
  assert.deepEqual(shaped[0], { id: gid, name: "公司測試群", kind: "group", memberCount: 5, whitelisted: true });
  assert.deepEqual(shaped[1], { id: rid, name: "多人聊天室", kind: "room", memberCount: null, whitelisted: false });
});

test("corechats: 核心未登入 (auth:state idle) 回 not-logged-in; 連不上回 unreachable", async (t) => {
  const http = createServer((req, res) => {
    res.writeHead(200, { "Set-Cookie": "linejs_browser=stubcookie; Path=/" });
    res.end("ok");
  });
  const wss = new WebSocketServer({ server: http, path: "/ws" });
  wss.on("connection", (sock) => {
    sock.send(JSON.stringify({ type: "hello", protocol: 2, serverVersion: "stub" }));
    sock.send(JSON.stringify({ type: "auth:state", state: "idle" }));
  });
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  t.after(() => { wss.close(); http.close(); });
  const port = http.address().port;
  const r1 = await fetchCoreChannels({ lineApiUrl: `ws://127.0.0.1:${port}/api/ws`, timeoutMs: 4000, settleMs: 150 });
  assert.equal(r1.status, "not-logged-in");
  // 找一個確定沒人聽的埠: 開了就關
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const r2 = await fetchCoreChannels({ lineApiUrl: `ws://127.0.0.1:${deadPort}/api/ws`, timeoutMs: 3000 });
  assert.equal(r2.status, "unreachable");
});

test("console: /api/line/chats 端點 (合併白名單狀態、空清單白話、未登入代碼)", async (t) => {
  const dir = await tmp();
  const { writeFileSync } = await import("node:fs");
  const gid = "c" + "a".repeat(32);
  const gid2 = "c" + "b".repeat(32);
  writeFileSync(join(dir, "config.yaml"), `api:\n  enabled: false\n  chats:\n    - ${gid}\n`);
  const settings = new SettingsStore({ path: join(dir, "settings.json") });
  const secrets = new MemorySecretStore();
  const logger = new Logger({ dir: join(dir, "logs") });
  const ai = createAiClient({});
  const kb = new KnowledgeBase({ folder: "", indexPath: join(dir, "kb.json"), logger });
  const bot = new HelperBot({ settings, secrets, ai, kb, logger });
  let behavior = { status: "ok", channels: [
    { channelId: gid, kind: "group", name: "已在名單", memberCount: 7 },
    { channelId: gid2, kind: "group", name: "新群組" },
  ] };
  const server = createConsoleServer({ settings, secrets, ai, kb, bot, logger, lineEnv: { dataDir: dir, repoRoot: join(dir, "nope"), packaged: true, fetchChats: async () => behavior } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const got = await (await fetch(base + "/api/line/chats")).json();
  assert.equal(got.ok, true);
  assert.equal(got.apiEnabled, false);
  assert.equal(got.chats.length, 2);
  assert.equal(got.chats[0].whitelisted, true);
  assert.equal(got.chats[1].whitelisted, false);
  assert.match(got.message, /讀到了 2 個/);
  behavior = { status: "ok", channels: [] };
  const empty = await (await fetch(base + "/api/line/chats")).json();
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.chats, []);
  assert.match(empty.message, /邀請/);
  behavior = { status: "not-logged-in" };
  const nologin = await (await fetch(base + "/api/line/chats")).json();
  assert.equal(nologin.ok, false);
  assert.equal(nologin.code, "NOT_LOGGED_IN");
});

test("console: /api/line/whitelist 列出白名單 (名稱解析/核心不可用降級) 與 config-remove 移除一筆", async (t) => {
  const dir = await tmp();
  const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const gid = "c" + "a".repeat(32);
  const gid2 = "c" + "b".repeat(32);
  writeFileSync(join(dir, "config.yaml"), `api:\n  enabled: true\n  chats:\n    - ${gid}\n    - ${gid2}\n`);
  const settings = new SettingsStore({ path: join(dir, "settings.json") });
  const secrets = new MemorySecretStore();
  const logger = new Logger({ dir: join(dir, "logs") });
  const ai = createAiClient({});
  const kb = new KnowledgeBase({ folder: "", indexPath: join(dir, "kb.json"), logger });
  const bot = new HelperBot({ settings, secrets, ai, kb, logger });
  let behavior = { status: "ok", channels: [{ channelId: gid, kind: "group", name: "已解析的群", memberCount: 3 }] };
  const server = createConsoleServer({ settings, secrets, ai, kb, bot, logger, lineEnv: { dataDir: dir, repoRoot: join(dir, "nope"), packaged: true, fetchChats: async () => behavior } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  // 名稱解析: 在核心快照裡的解得到名稱; 不在快照裡的只給 ID
  const wl = await (await fetch(base + "/api/line/whitelist")).json();
  assert.equal(wl.ok, true);
  assert.equal(wl.coreAvailable, true);
  assert.equal(wl.chats.length, 2);
  assert.deepEqual(wl.chats[0], { id: gid, name: "已解析的群", nameResolved: true, kind: "group", memberCount: 3 });
  assert.deepEqual(wl.chats[1], { id: gid2, name: null, nameResolved: false, kind: null, memberCount: null });

  // 核心不可用: 清單照樣列出, 名稱全降級為 ID
  behavior = { status: "unreachable" };
  const wl2 = await (await fetch(base + "/api/line/whitelist")).json();
  assert.equal(wl2.ok, true);
  assert.equal(wl2.coreAvailable, false);
  assert.equal(wl2.chats.length, 2);
  assert.equal(wl2.chats.every((c) => c.nameResolved === false && c.name === null), true);

  // 移除一筆: config 落盤正確、.bak 有備份、清單即時反映
  const rm = await (await fetch(base + "/api/line/config-remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: gid }) })).json();
  assert.equal(rm.ok, true);
  assert.deepEqual(rm.chats, [gid2]);
  assert.equal(existsSync(join(dir, "config.yaml.bak")), true);
  const after = readFileSync(join(dir, "config.yaml"), "utf8");
  assert.equal(after.includes(gid), false);
  assert.equal(after.includes(gid2), true);
  const wl3 = await (await fetch(base + "/api/line/whitelist")).json();
  assert.deepEqual(wl3.chats.map((c) => c.id), [gid2]);

  // 重複移除同一筆: 誠實報錯, 不假裝成功
  const rm2 = await (await fetch(base + "/api/line/config-remove", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId: gid }) })).json();
  assert.equal(rm2.ok, false);
});

test("bot: 被核心踢線後自動重連; 換 Token 後以新 Token 重連; 連不上時狀態誠實, 核心恢復後自癒", async (t) => {
  const dir = await tmp();
  const settings = new SettingsStore({ path: join(dir, "settings.json") });
  const secrets = new MemorySecretStore();
  const logger = new Logger({ dir: join(dir, "logs") });
  const ai = createAiClient({});
  const kb = new KnowledgeBase({ folder: "", indexPath: join(dir, "kb.json"), logger });

  // 假核心: 只接受指定 Token 的 /api/ws 連線, 記錄每次連線帶的 Authorization
  let acceptedToken = "tok-OLD-1111";
  const seenAuth = [];
  const sockets = new Set();
  const wss = new WebSocketServer({ port: 0, verifyClient: (info, cb) => {
    seenAuth.push(info.req.headers.authorization ?? "");
    cb(info.req.headers.authorization === `Bearer ${acceptedToken}`, 401, "bad token");
  } });
  wss.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((r) => wss.on("listening", r));
  const port = wss.address().port;
  t.after(() => { for (const s of sockets) s.terminate(); wss.close(); });
  settings.update({ lineApiUrl: `ws://127.0.0.1:${port}/api/ws` });

  const waitUntil = async (pred, timeout = 5000) => {
    const started = Date.now();
    for (;;) { if (pred()) return; if (Date.now() - started > timeout) throw new Error("等待逾時"); await new Promise((r) => setTimeout(r, 25)); }
  };

  // 1) 舊 Token 連不上: connect 回 false、botConnected=false、狀態不是已連線 (誠實), 不假裝
  await secrets.set(SECRET_NAMES.lineToken, "tok-WRONG-0000");
  const bot = new HelperBot({ settings, secrets, ai, kb, logger, reconnectDelaysMs: [50, 100, 200] });
  t.after(() => bot.disconnect());
  assert.equal(await bot.connect(), false);
  assert.equal(bot.status().botConnected, false);
  assert.notEqual(bot.status().lineState, "已連線");

  // 2) 核心恢復接受目前 Token 後, 靠退避排程自癒連上 (不用重開、不用手動重連)
  acceptedToken = "tok-WRONG-0000";
  await waitUntil(() => bot.status().botConnected === true);
  assert.equal(bot.status().lineState, "已連線");

  // 3) 被踢線 (模擬核心重啟/換發 Token 踢線): 伺服器端強制斷掉, bot 自動重連回來
  for (const s of sockets) s.terminate();
  await waitUntil(() => sockets.size === 0);
  await waitUntil(() => bot.status().botConnected === true && sockets.size === 1);

  // 4) 換 Token: 核心改只認新 Token 並踢掉舊連線 (上游換發行為), helper 存入新 Token 後 reconnect() 以新 Token 連上並驗證成功
  acceptedToken = "tok-NEW-2222";
  for (const s of sockets) s.terminate();
  await secrets.set(SECRET_NAMES.lineToken, "tok-NEW-2222");
  assert.equal(await bot.reconnect(), true);
  assert.equal(bot.status().botConnected, true);
  assert.equal(seenAuth[seenAuth.length - 1], "Bearer tok-NEW-2222");
  bot.disconnect();
  assert.equal(bot.status().botConnected, false);
});

test("kb: 大掃描分段讓出事件迴圈 (計時器不被長時間卡住), 掃描中狀態誠實, 完成後搜尋正確", async () => {
  const root = await tmp();
  const { mkdir, writeFile } = await import("node:fs/promises");
  const kbDir = join(root, "kb"); await mkdir(kbDir);
  const printPara = "公司影印機使用說明: 彩色列印請到四樓影印室登記, 分機 412。影印前請先確認紙張尺寸與雙面設定。\n\n";
  const foodPara = "員工餐廳本週菜單: 週一牛肉麵, 週二排骨飯, 週三水餃, 週四咖哩飯, 週五炒米粉。素食請先登記。\n\n";
  // 400 檔: 20 檔列印文件 + 380 檔餐廳文件 (內容有區分, BM25 idf 才有意義)
  for (let i = 0; i < 400; i++) {
    await writeFile(join(kbDir, `doc${i}.txt`), (i < 20 ? printPara : foodPara).repeat(160));
  }
  const kb = new KnowledgeBase({ folder: kbDir, indexPath: join(root, "kb-index.json") });
  let maxLag = 0; let last = Date.now();
  const iv = setInterval(() => { const now = Date.now(); maxLag = Math.max(maxLag, now - last - 20); last = now; }, 20);
  const scanP = kb.scan({ force: true });
  assert.equal(kb.status().scanning, true); // 掃描期間狀態要看得出在掃
  const st = await scanP;
  clearInterval(iv);
  assert.equal(st.files, 400);
  assert.ok(st.chunks > 4000, `片段數應 >4000, 實際 ${st.chunks}`);
  assert.equal(st.scanning, false);
  assert.equal(st.largeFolder, false);
  // 舊版同步掃描會把事件迴圈整段卡死 (這批資料約 1.5 秒); 分段後 20ms 計時器的最大延遲必須遠小於全程
  assert.ok(maxLag < 600, `事件迴圈最大延遲 ${maxLag}ms, 分段掃描不應長時間卡住`);
  const hits = kb.search("公司彩色列印在哪裡", 3);
  assert.ok(hits.length >= 1);
  assert.match(hits[0].file, /^doc\d+\.txt$/);
  assert.ok(Number(hits[0].file.slice(3, -4)) < 20, "命中的應該是列印文件");
});

test("kb: 檔案數異常多時 largeFolder 標記與檔案計數 (只提醒不阻擋)", async () => {
  const root = await tmp();
  const { mkdir, writeFile } = await import("node:fs/promises");
  const kbDir = join(root, "kb"); await mkdir(kbDir);
  for (let i = 0; i < 2100; i++) await writeFile(join(kbDir, `f${i}.txt`), "公司公告: 本週五下午全公司大掃除。");
  const kb = new KnowledgeBase({ folder: kbDir, indexPath: join(root, "kb-index.json") });
  assert.equal(kb.countSupportedFiles(), 2100);
  const st = await kb.scan({ force: true });
  assert.equal(st.files, 2100);
  assert.equal(st.largeFolder, true);
});

test("console: 設定知識庫大資料夾時 /api/settings 立即回應 (不等掃描), 掃描期間 /api/status 照常回應", async (t) => {
  const dir = await tmp();
  const { mkdir, writeFile } = await import("node:fs/promises");
  const kbDir = join(dir, "bigkb"); await mkdir(kbDir);
  const para = "出差申請流程: 先填出差單, 經主管核准後訂票, 回來檢據核銷。\n\n";
  for (let i = 0; i < 400; i++) await writeFile(join(kbDir, `doc${i}.txt`), para.repeat(160));
  const settings = new SettingsStore({ path: join(dir, "settings.json") });
  const secrets = new MemorySecretStore();
  const logger = new Logger({ dir: join(dir, "logs") });
  const ai = createAiClient({});
  const kb = new KnowledgeBase({ folder: "", indexPath: join(dir, "kb.json"), logger });
  const bot = new HelperBot({ settings, secrets, ai, kb, logger });
  const server = createConsoleServer({ settings, secrets, ai, kb, bot, logger, lineEnv: { dataDir: dir, repoRoot: join(dir, "nope"), packaged: true } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const t0 = Date.now();
  const put = await fetch(base + "/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kb: { folder: kbDir } }) }).then((r) => r.json());
  const putMs = Date.now() - t0;
  assert.equal(put.ok, true);
  assert.ok(putMs < 2500, `設定回應不應等掃描, 實際 ${putMs}ms`);
  // 掃描進行中 /api/status 要照常回應, 且看得出 scanning
  const st1 = await (await fetch(base + "/api/status")).json();
  assert.equal(st1.bot.kb.scanning, true);
  // 等掃描完成: 狀態自己更新成 400 檔
  const dl = Date.now() + 15000;
  let done = null;
  while (Date.now() < dl) {
    const s = await (await fetch(base + "/api/status")).json();
    if (!s.bot.kb.scanning && s.bot.kb.files === 400) { done = s; break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(done, "掃描應在 15 秒內完成並反映在狀態");
});

test("kb: 索引重載直接還原詞頻可搜尋; 舊格式索引 (無詞頻) 先不開放搜尋, 掃描補算後恢復", async () => {
  const root = await tmp();
  const { mkdir, writeFile, readFile, writeFile: wf } = await import("node:fs/promises");
  const kbDir = join(root, "kb"); await mkdir(kbDir);
  await writeFile(join(kbDir, "列印說明.txt"), "公司彩色列印在總公司四樓影印室。彩色影印機分機 412, 列印前請先在影印室登記。A3 列印也在四樓。");
  await writeFile(join(kbDir, "網路申請.md"), "VPN 申請流程: 填寫資訊部表單, 經主管簽核後開通。遠端連線使用公司配發帳號。");
  const indexPath = join(root, "kb-index.json");
  const kb1 = new KnowledgeBase({ folder: kbDir, indexPath });
  await kb1.scan({ force: true });
  // 模擬重新開機: 新實例從同一索引檔載入 — 詞頻有存回來, 不必重算就能搜尋
  const kb2 = new KnowledgeBase({ folder: kbDir, indexPath });
  assert.equal(kb2.statsStale, false);
  const hits = kb2.search("公司彩色列印在哪裡", 3);
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].file, "列印說明.txt");
  // 舊格式索引 (把 tf/len 拿掉): 載入後 statsStale, 搜尋先回空 (不用半套統計), 背景掃描補算後恢復
  const raw = JSON.parse(await readFile(indexPath, "utf8"));
  for (const c of raw.chunks) { delete c.tf; delete c.len; }
  await wf(indexPath, JSON.stringify(raw));
  const kb3 = new KnowledgeBase({ folder: kbDir, indexPath });
  assert.equal(kb3.statsStale, true);
  assert.deepEqual(kb3.search("公司彩色列印在哪裡", 3), []);
  await kb3.scan();
  assert.equal(kb3.statsStale, false);
  assert.ok(kb3.search("公司彩色列印在哪裡", 3).length >= 1);
});

// ===== 修復批次一 (2026-10-20) 新測試 =====

test("config: showSources 預設 false、creatorReply 預設值一字不差、persona 預設全空; 保存與 publicView 明文回傳", async () => {
  const dir = await tmp();
  const store = new SettingsStore({ path: join(dir, "settings.json") });
  const d = store.get();
  assert.equal(d.showSources, false);
  assert.equal(d.creatorReply, "是吳治綱大師創造此機器人，©Copyright By 吳治綱");
  assert.equal(d.creatorReply, DEFAULT_CREATOR_REPLY);
  assert.deepEqual(d.persona, { birthdate: "", gender: "", zodiac: "", measurements: "", interests: "", maritalStatus: "", intro: "" });
  // 部分更新 persona: 只給 birthdate, 其他欄位保留空字串 (deepMerge)
  store.update({ showSources: true, creatorReply: "自訂回覆", persona: { birthdate: "2000-10-21", interests: "畫畫" } });
  const u = store.get();
  assert.equal(u.showSources, true);
  assert.equal(u.creatorReply, "自訂回覆");
  assert.equal(u.persona.birthdate, "2000-10-21");
  assert.equal(u.persona.interests, "畫畫");
  assert.equal(u.persona.gender, "");
  // 落盤保存: 新實例讀得回來
  const store2 = new SettingsStore({ path: join(dir, "settings.json") });
  assert.equal(store2.get().persona.birthdate, "2000-10-21");
  assert.equal(store2.get().showSources, true);
  // publicView: 三項都明文回傳 (非機密), 不被遮罩邏輯吞掉
  const view = await store.publicView(new MemorySecretStore());
  assert.equal(view.showSources, true);
  assert.equal(view.creatorReply, "自訂回覆");
  assert.equal(view.persona.birthdate, "2000-10-21");
});

test("creator: 創造者意圖判定 (命中三例、不命中外部主詞兩例)", () => {
  const s = { botName: "AI寶", aliases: ["阿寶"] };
  // 命中
  assert.equal(isCreatorIntent("你是誰創造的？", s), true);
  assert.equal(isCreatorIntent("AI寶 的作者是誰", s), true);
  assert.equal(isCreatorIntent("版權屬於誰", s), true);
  assert.equal(isCreatorIntent("這個機器人的開發者是誰？", s), true);
  assert.equal(isCreatorIntent("你的主人是誰？", s), true);
  assert.equal(isCreatorIntent("Who holds the Copyright?", s), true);
  // 不命中: 主詞是外部事物, 且沒有提到機器人本身
  assert.equal(isCreatorIntent("Excel 是誰開發的", s), false);
  assert.equal(isCreatorIntent("這份文件作者是誰", s), false);
  assert.equal(isCreatorIntent("誰創造了宇宙", s), false);
  assert.equal(isCreatorIntent("這篇文章是誰寫的", s), false);
  assert.equal(isCreatorIntent("Excel 怎麼凍結窗格？", s), false);
  assert.equal(isCreatorIntent("", s), false);
  // 已知取捨 (見 bot.mjs isCreatorIntent 註解): 對機器人說「你知道 Excel 是誰開發的嗎」因有「你」會命中,
  // 這是刻意接受的取捨; 上面兩例指定的外部主詞問句 (無「你」、無名字) 不命中才是本判定要守住的線。
});

test("persona: 年紀自動計算 (未過生日 25、已過生日 26) 與人設段落組裝/空欄位規則", () => {
  const today = new Date(2026, 9, 20); // 2026-10-20
  assert.equal(calculateAge("2000-10-21", today), 25, "生日還沒到, 應扣 1 歲");
  assert.equal(calculateAge("2000-10-19", today), 26, "生日已過, 足歲");
  assert.equal(calculateAge("2000-10-20", today), 26, "今天生日就是足歲");
  assert.equal(calculateAge("", today), null);
  assert.equal(calculateAge("2000-02-30", today), null, "不存在的日期應回 null");
  assert.equal(calculateAge("abc", today), null);
  const section = buildPersonaSection({ birthdate: "2000-10-21", gender: "女", zodiac: "", measurements: "", interests: "畫畫", maritalStatus: "", intro: "" }, today);
  assert.ok(section.includes("出生日: 2000-10-21"));
  assert.ok(section.includes("目前 25 歲"), "段落應含自動計算的年紀");
  assert.ok(section.includes("性別: 女"));
  assert.ok(section.includes("興趣: 畫畫"));
  assert.ok(!section.includes("星座:"), "空欄位不應出現在段落裡 (才不會讓 AI 把空值當內容)");
  assert.ok(section.includes("這部分我還沒有設定"), "段落應含空欄位誠實回答規則");
  assert.ok(section.includes("不可以自己編造"), "段落應含不得編造規則");
  const empty = buildPersonaSection({ birthdate: "", gender: "", zodiac: "", measurements: "", interests: "", maritalStatus: "", intro: "" }, today);
  assert.ok(empty.includes("目前沒有填寫任何個人設定"));
  assert.ok(empty.includes("這部分我還沒有設定"), "全空時規則仍要在, 被問身世才答得誠實");
});

test("msgregistry: 預設上限加大至 10000 筆 / 30 天 (引用續答加固)", () => {
  const reg = new MessageSenderRegistry({});
  assert.equal(reg.maxEntries, 10000);
  assert.equal(reg.ttlMs, 30 * 24 * 3600 * 1000);
  assert.equal(QUOTE_HISTORY_PAGES, 5, "引用補查應加深至 5 頁");
});

test("ai: 永不回應的上游 — listModels/testConnection/chat 在注入逾時內回白話錯誤 (無 URL/無原始例外字串)", async (t) => {
  const hang = createServer(() => { /* 永遠不回應, 模擬主代理實測的卡住情境 */ });
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  t.after(() => { hang.closeAllConnections(); hang.close(); });
  const url = `http://127.0.0.1:${hang.address().port}/v1`;
  const ai = createAiClient({});
  assert.equal(DEFAULT_LIST_MODELS_TIMEOUT_MS, 15000, "listModels 正式預設逾時應為 15 秒");
  let t0 = Date.now();
  const r = await ai.listModels({ baseUrl: url, timeoutMs: 300 }, "sk-HANG-0000aaaa");
  assert.ok(Date.now() - t0 < 3000, "listModels 應在注入逾時附近回來, 不可無限卡住");
  assert.equal(r.ok, false);
  assert.match(r.message, /抓取逾時, 對方服務沒有回應/);
  assert.ok(!/fetch failed/i.test(r.message), "訊息不得含原始例外字串");
  assert.ok(!r.message.includes("127.0.0.1"), "訊息不得含 URL");
  t0 = Date.now();
  const tc = await ai.testConnection({ baseUrl: url, model: "stub-model" }, "sk-HANG-0000aaaa", { timeoutMs: 300 });
  assert.ok(Date.now() - t0 < 3000, "testConnection 應在注入逾時附近回來");
  assert.equal(tc.ok, false);
  assert.match(tc.message, /連線失敗/);
  assert.ok(!/fetch failed/i.test(tc.message), "testConnection 訊息不得含原始例外字串 (主代理實測舊版有此問題)");
  assert.ok(!tc.message.includes("127.0.0.1"), "testConnection 訊息不得含 URL");
  const err = await ai.chat({ baseUrl: url, apiKey: "sk-HANG-0000aaaa", model: "stub-model", messages: [{ role: "user", content: "hi" }], timeoutMs: 300 }).then(() => null, (e) => e);
  assert.equal(err?.code, "AI_NETWORK");
  assert.ok(!/fetch failed/i.test(err.message));
  assert.ok(!err.message.includes("127.0.0.1"));
  assert.ok(String(err.detail).includes("127.0.0.1"), "原始細節應保留在 detail 供 log 追查");
});

// --- bot 整合 harness: 假核心 (WebSocketServer) + AI stub, 直接驗 bot 的訊息流程 ---
const HARNESS_CHAT = "c" + "a".repeat(32);
async function waitUntilUnit(pred, timeout = 6000, label = "condition") {
  const started = Date.now();
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() - started > timeout) throw new Error("waitUntilUnit timeout: " + label);
    await new Promise((r) => setTimeout(r, 30));
  }
}
async function startBotHarness(t, { settingsOver = {}, kbFolder = "", aiHandler = null, aiOptions = {} } = {}) {
  const dir = await tmp();
  const logger = new Logger({ dir: join(dir, "logs") });
  const settings = new SettingsStore({ path: join(dir, "settings.json"), logger });
  const aiBodies = [];
  const { server: aiServer, url: aiUrl } = await aiStubServer((body) => {
    aiBodies.push(body);
    if (aiHandler) return aiHandler(body);
    const all = (body.messages ?? []).map((m) => m.content).join("\n");
    const content = all.includes("以下是公司知識庫片段") ? "依知識庫內容回答: 彩色列印請到四樓影印室。" : "這是一般回答。";
    return { body: { model: body.model, choices: [{ message: { role: "assistant", content } }] } };
  });
  t.after(() => aiServer.close());
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on("listening", r));
  const sentFrames = [];
  let botSocket = null;
  wss.on("connection", (s) => {
    botSocket = s;
    s.send(JSON.stringify({ type: "auth:ready", profile: { userId: "u-me", displayName: "假帳號" } }));
    s.on("message", (d) => {
      let f; try { f = JSON.parse(d.toString()); } catch { return; }
      sentFrames.push(f);
      if (f.type === "message:send") s.send(JSON.stringify({ type: "sent", requestId: f.requestId, messageId: `botmsg-${f.requestId}` }));
    });
  });
  t.after(() => wss.close());
  settings.update({
    botName: "AI寶", aliases: [], triggerMode: "standard", cooldownSec: 0, dailyLimit: 100,
    lineApiUrl: `ws://127.0.0.1:${wss.address().port}/api/ws`,
    ai: { active: "openai", providers: { openai: { baseUrl: aiUrl, model: "stub-model" } } },
    scam: { enabled: false, threshold: 0.8, perMinute: 10 },
    kb: { folder: kbFolder },
    ...settingsOver,
  });
  const secrets = new MemorySecretStore();
  await secrets.set(SECRET_NAMES.openai, "sk-STUBKEY-0000aaaa");
  await secrets.set(SECRET_NAMES.lineToken, "tok-HARNESS-0000");
  const kb = new KnowledgeBase({ folder: kbFolder, indexPath: join(dir, "kb-index.json"), logger });
  if (kbFolder) await kb.scan({ force: true });
  const registry = new MessageSenderRegistry({ path: join(dir, "message-senders.json"), logger });
  const bot = new HelperBot({ settings, secrets, ai: createAiClient(aiOptions), kb, logger, registry });
  await bot.connect();
  t.after(() => bot.disconnect());
  await waitUntilUnit(() => bot.selfId === "u-me", 4000, "bot auth ready");
  const inject = (messageId, senderId, text) => botSocket.send(JSON.stringify({ type: "message", message: { messageId, channelId: HARNESS_CHAT, senderId, text } }));
  const waitSent = (pred, label) => waitUntilUnit(() => sentFrames.filter((f) => f.type === "message:send").find(pred), 6000, label);
  return { bot, settings, aiBodies, inject, waitSent };
}

test("bot: 創造者問題直接回固定答覆 (不呼叫 AI); Excel 誰開發的照常問 AI; 所有格問句也命中", async (t) => {
  const h = await startBotHarness(t);
  h.inject("m1", "u-a", "AI寶，你是誰創造的？");
  const sent1 = await h.waitSent((f) => f.replyTo === "m1", "creator reply");
  assert.equal(sent1.text, DEFAULT_CREATOR_REPLY);
  assert.equal(h.aiBodies.length, 0, "創造者問題不應呼叫 AI");
  h.inject("m2", "u-b", "AI寶，Excel 是誰開發的？");
  const sent2 = await h.waitSent((f) => f.replyTo === "m2", "excel reply");
  assert.equal(sent2.text, "這是一般回答。");
  assert.equal(h.aiBodies.length, 1, "外部主詞問題應照常呼叫 AI");
  h.inject("m3", "u-c", "AI寶的作者是誰");
  const sent3 = await h.waitSent((f) => f.replyTo === "m3", "possessive creator reply");
  assert.equal(sent3.text, DEFAULT_CREATOR_REPLY);
  assert.equal(h.aiBodies.length, 1, "所有格問句命中後不應再呼叫 AI");
  // 自訂 creatorReply 後照新值回
  h.settings.update({ creatorReply: "我是老吳做的機器人" });
  h.inject("m4", "u-d", "AI寶，版權屬於誰？");
  const sent4 = await h.waitSent((f) => f.replyTo === "m4", "custom creator reply");
  assert.equal(sent4.text, "我是老吳做的機器人");
  assert.equal(h.aiBodies.length, 1);
});

test("bot: 人設注入 system prompt (出生日/性別/興趣入 prompt, 含空欄位誠實規則)", async (t) => {
  const h = await startBotHarness(t, { settingsOver: { persona: { birthdate: "2000-10-21", gender: "女", zodiac: "", measurements: "", interests: "畫畫", maritalStatus: "", intro: "" } } });
  h.inject("p1", "u-a", "AI寶，Excel 怎麼凍結窗格？");
  await h.waitSent((f) => f.replyTo === "p1", "persona answer");
  assert.equal(h.aiBodies.length, 1);
  const system = h.aiBodies[0].messages.find((m) => m.role === "system")?.content ?? "";
  assert.ok(system.includes("出生日: 2000-10-21"), "system prompt 應含出生日");
  assert.ok(system.includes("性別: 女"));
  assert.ok(system.includes("興趣: 畫畫"));
  assert.ok(/目前 \d+ 歲/.test(system), "system prompt 應含自動計算的年紀");
  assert.ok(system.includes("這部分我還沒有設定"), "system prompt 應含空欄位誠實規則");
});

test("bot: showSources 開/關兩態 (關閉時 KB 回答不含參考來源, 開啟時含)", async (t) => {
  const root = await tmp();
  const { mkdir, writeFile } = await import("node:fs/promises");
  const kbDir = join(root, "kb"); await mkdir(kbDir);
  await writeFile(join(kbDir, "列印說明.txt"), "公司彩色列印在總公司四樓影印室。彩色影印機分機 412, 列印前請先在影印室登記。A3 列印也在四樓。");
  const h = await startBotHarness(t, { kbFolder: kbDir, settingsOver: { showSources: false } });
  h.inject("s1", "u-a", "AI寶，公司彩色列印在哪裡？");
  const off = await h.waitSent((f) => f.replyTo === "s1", "sources off answer");
  assert.ok(off.text.includes("依知識庫內容回答"), "應有知識庫回答本體");
  assert.ok(!off.text.includes("參考來源"), "關閉時不得含參考來源行");
  h.settings.update({ showSources: true });
  h.inject("s2", "u-b", "AI寶，公司彩色列印在哪裡？");
  const on = await h.waitSent((f) => f.replyTo === "s2", "sources on answer");
  assert.ok(on.text.includes("參考來源"), "開啟時應附參考來源");
  assert.ok(on.text.includes("列印說明.txt"), "開啟時應附來源檔名");
});

test("console: reindex 掃描進行中立即回 JSON (already-scanning, 3 秒內); 小資料夾回 completed", async (t) => {
  const dir = await tmp();
  const { mkdir, writeFile } = await import("node:fs/promises");
  const kbDir = join(dir, "bigkb"); await mkdir(kbDir);
  const para = "出差申請流程: 先填出差單, 經主管核准後訂票, 回來檢據核銷。\n\n";
  for (let i = 0; i < 300; i++) await writeFile(join(kbDir, `doc${i}.txt`), para.repeat(140));
  const settings = new SettingsStore({ path: join(dir, "settings.json") });
  const secrets = new MemorySecretStore();
  const logger = new Logger({ dir: join(dir, "logs") });
  const ai = createAiClient({});
  const kb = new KnowledgeBase({ folder: kbDir, indexPath: join(dir, "kb.json"), logger });
  const bot = new HelperBot({ settings, secrets, ai, kb, logger });
  const server = createConsoleServer({ settings, secrets, ai, kb, bot, logger, lineEnv: { dataDir: dir, repoRoot: join(dir, "nope"), packaged: true } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  // 先啟動一輪掃描 (不等待), 掃描進行中打 reindex: 必須在 3 秒內回 JSON, 不可跟著掃描一起卡住
  const scanP = kb.scan({ force: true });
  assert.equal(kb.status().scanning, true);
  const t0 = Date.now();
  const r = await fetch(base + "/api/kb/reindex", { method: "POST", signal: AbortSignal.timeout(3000) }).then((x) => x.json());
  const ms = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.equal(r.scanState, "already-scanning");
  assert.equal(r.scanning, true);
  assert.ok(ms < 3000, `掃描中 reindex 應立即回應, 實際 ${ms}ms`);
  await scanP;
  // 小資料夾: reindex 直接回 completed
  const dir2 = await tmp();
  const kbDir2 = join(dir2, "kb"); await mkdir(kbDir2);
  await writeFile(join(kbDir2, "a.txt"), "公司公告: 本週五下午大掃除。");
  const settings2 = new SettingsStore({ path: join(dir2, "settings.json") });
  const logger2 = new Logger({ dir: join(dir2, "logs") });
  const kb2 = new KnowledgeBase({ folder: kbDir2, indexPath: join(dir2, "kb.json"), logger: logger2 });
  const bot2 = new HelperBot({ settings: settings2, secrets, ai, kb: kb2, logger: logger2 });
  const server2 = createConsoleServer({ settings: settings2, secrets, ai, kb: kb2, bot: bot2, logger: logger2, lineEnv: { dataDir: dir2, repoRoot: join(dir2, "nope"), packaged: true } });
  await new Promise((r2) => server2.listen(0, "127.0.0.1", r2));
  t.after(() => server2.close());
  const done = await fetch(`http://127.0.0.1:${server2.address().port}/api/kb/reindex`, { method: "POST" }).then((x) => x.json());
  assert.equal(done.ok, true);
  assert.equal(done.scanState, "completed");
  assert.equal(done.status.files, 1);
});

// --- 2026-10-20 晚間驗收批次二: 429 退避 / 冷卻與每日上限實證 / 活動端點 / LINE 格式規則 ---

test("ai: 429 依上游建議等待退避重試, 第三次降額度後成功; 錯誤不含上游原文", async (t) => {
  const bodies = [];
  const waits = [];
  const groq429 = { error: { message: "Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_01knez0r83ffxtk4crx6dnhyhw` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Used 155, Requested 922. Please try again in 0.01s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing" } };
  const { server, url } = await aiStubServer((body) => {
    bodies.push(body);
    if (bodies.length < 3) return { status: 429, body: groq429 };
    return { body: { model: body.model, choices: [{ message: { role: "assistant", content: "退避後回答" } }] } };
  });
  t.after(() => server.close());
  const ai = createAiClient({ sleepImpl: async (ms) => { waits.push(ms); } });
  const r = await ai.chat({ baseUrl: url, apiKey: "k", model: "stub-model", messages: [{ role: "user", content: "hi" }], maxTokens: 2048 });
  assert.equal(r.content, "退避後回答");
  assert.equal(bodies.length, 3, "429 應重試到第三次");
  assert.equal(bodies[0].max_tokens, 2048);
  assert.equal(bodies[1].max_tokens, 2048);
  assert.equal(bodies[2].max_tokens, 768, "第三次嘗試應降額度提高過關率");
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 250 && waits[0] <= 1000, `等待應依上游建議 (0.01s+250ms), 實際 ${waits[0]}`);
});

test("ai: 429 三次都擋下時拋 AI_BUSY 白話錯誤 (不含原文/連結/組織 id)", async (t) => {
  const groq429 = { error: { message: "Rate limit reached ... Please try again in 0.01s. https://console.groq.com/settings/billing org_01knez" } };
  const { server, url } = await aiStubServer(() => ({ status: 429, body: groq429 }));
  t.after(() => server.close());
  const ai = createAiClient({ sleepImpl: async () => {} });
  const err = await ai.chat({ baseUrl: url, apiKey: "k", model: "stub-model", messages: [{ role: "user", content: "hi" }] }).then(() => null, (e) => e);
  assert.equal(err?.code, "AI_BUSY");
  assert.ok(!/groq|org_|Rate limit/i.test(err.message), `AI_BUSY 訊息不得含上游原文: ${err.message}`);
});

test("bot: 寬鬆模式同人同群連發 3 則只回 1 次, 其餘被冷卻擋下且活動面板有紀錄 (第 9 項)", async (t) => {
  const h = await startBotHarness(t, { settingsOver: { triggerMode: "relaxed", cooldownSec: 20, dailyLimit: 100 } });
  h.inject("b1", "u-fast", "AI寶 什麼是機器學習?");
  const first = await h.waitSent((f) => f.replyTo === "b1", "first answer");
  assert.ok(first);
  h.inject("b2", "u-fast", "AI寶 那什麼是深度學習?");
  h.inject("b3", "u-fast", "AI寶 再說說神經網路?");
  // 等判決都跑完 (活動紀錄裡出現 2 筆 cooldown)
  await waitUntilUnit(() => h.bot.activitySnapshot().filter((a) => a.kind === "cooldown").length === 2, 6000, "cooldown activities");
  const sends = h.bot.activitySnapshot();
  assert.equal(sends.filter((a) => a.kind === "answered").length, 1, "連發 3 則只應回答 1 次");
  assert.equal(h.aiBodies.length, 1, "被冷卻擋下的不應呼叫 AI");
});

test("bot: 每日上限 3 時第 4 次被擋 (白話提示), 且計數跨重啟持久 (第 9 項)", async (t) => {
  const h = await startBotHarness(t, { settingsOver: { triggerMode: "relaxed", cooldownSec: 0, dailyLimit: 3 } });
  for (const [i, u] of ["u-1", "u-2", "u-3"].entries()) {
    h.inject(`d${i + 1}`, u, "AI寶，你是誰創造的？");
    await h.waitSent((f) => f.replyTo === `d${i + 1}`, `creator ${i + 1}`);
  }
  h.inject("d4", "u-4", "AI寶，你是誰創造的？");
  const limitSend = await h.waitSent((f) => f.replyTo === "d4", "daily limit notice");
  assert.match(limitSend.text, /回答次數已達上限/);
  assert.equal(h.bot.triggerState.daily.count, 3);
  await waitUntilUnit(() => h.bot.activitySnapshot().some((a) => a.kind === "daily_limit"), 4000, "daily_limit activity");
  // 持久化: 新 bot 從同一 state 檔載入, 當日計數不歸零
  const dir2 = await tmp();
  const path2 = join(dir2, "daily-state.json");
  const settings2 = new SettingsStore({ path: join(dir2, "settings.json") });
  const botA = new HelperBot({ settings: settings2, dailyStatePath: path2 });
  botA.triggerState.daily.date = localDateKey();
  markAnswered(botA.triggerState); markAnswered(botA.triggerState); markAnswered(botA.triggerState);
  botA.stats.answered = 3;
  botA.persistDaily();
  const botB = new HelperBot({ settings: settings2, dailyStatePath: path2 });
  assert.equal(botB.triggerState.daily.count, 3, "重啟後每日計數應從磁碟載入, 不得歸零");
  assert.equal(botB.stats.answered, 3);
});

test("bot: AI 被 429 擋下時群組只收到白話忙線句 (第 8 項, 不含上游原文/連結)", async (t) => {
  const groq429 = { error: { message: "Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_01knez0r83ffxtk4crx6dnhyhw`. Please try again in 4.62s. https://console.groq.com/settings/billing" } };
  const h = await startBotHarness(t, {
    settingsOver: { triggerMode: "relaxed", cooldownSec: 0 },
    aiHandler: () => ({ status: 429, body: groq429 }),
    aiOptions: { sleepImpl: async () => {} },
  });
  h.inject("g1", "u-g", "AI寶 請問VPN是什麼?");
  const sent = await h.waitSent((f) => f.replyTo === "g1", "busy fallback");
  assert.equal(sent.text, "我這邊有點忙,稍等幾秒再問我一次。".replace(",", "，").replace(",", "，"));
  assert.ok(!/groq|org_|Rate limit/i.test(sent.text), "群組訊息不得含上游原文");
  await waitUntilUnit(() => h.bot.activitySnapshot().some((a) => a.kind === "ai_busy"), 4000, "ai_busy activity");
});

test("bot: 問答的 system prompt 附 LINE 友善格式規則 (第 13 項)", async (t) => {
  const h = await startBotHarness(t, { settingsOver: { cooldownSec: 0 } });
  h.inject("f1", "u-f", "AI寶，什麼是雲端硬碟？");
  await h.waitSent((f) => f.replyTo === "f1", "answer");
  assert.equal(h.aiBodies.length, 1);
  const system = h.aiBodies[0].messages.find((x) => x.role === "system")?.content ?? "";
  assert.ok(system.includes(LINE_FORMAT_RULE), "system prompt 應含程式附加的格式規則");
  assert.match(system, /不要使用 Markdown 表格/);
  assert.match(system, /不要使用 \*\* 粗體符號/);
});

test("activity: /api/bot/activity 回傳新到舊、上限 50、欄位完整 (第 12 項)", async (t) => {
  const dir = await tmp();
  const logger = new Logger({ dir: join(dir, "logs") });
  const settings = new SettingsStore({ path: join(dir, "settings.json"), logger });
  const secrets = new MemorySecretStore();
  const bot = new HelperBot({ settings, secrets, ai: createAiClient({}), logger });
  const server = createConsoleServer({ settings, secrets, ai: createAiClient({}), kb: null, bot, logger });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  for (let i = 1; i <= 55; i += 1) {
    bot.recordActivity({ kind: i % 2 ? "answered" : "cooldown", m: { channelId: "c-act", senderName: `同事${i}`, text: `問題${i}一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十` }, answerChars: 10, ms: 100 });
  }
  const r = await fetch(`http://127.0.0.1:${server.address().port}/api/bot/activity`).then((x) => x.json());
  assert.equal(r.ok, true);
  assert.equal(r.events.length, 50, "環形緩衝上限 50 筆");
  assert.equal(r.events[0].question.startsWith("問題55"), true, "最新在最前");
  assert.ok(r.events[0].question.length <= 30, "問題片段只留前 30 字");
  assert.equal(r.events[0].senderName, "同事55");
  assert.equal(r.status.answeredToday, 0);
  assert.equal(typeof r.status.dailyLimit, "number");
});

test("activity: 回答全文欄位 (已回答帶 answer; 超過 2000 字截斷註明; 未回答為 null)", async () => {
  const dir = await tmp();
  const logger = new Logger({ dir: join(dir, "logs") });
  const settings = new SettingsStore({ path: join(dir, "settings.json"), logger });
  const bot = new HelperBot({ settings, secrets: new MemorySecretStore(), ai: createAiClient({}), logger });
  bot.recordActivity({ kind: "answered", m: { channelId: "c1", senderName: "甲", text: "問題一" }, answerText: "答".repeat(2500) });
  bot.recordActivity({ kind: "answered", m: { channelId: "c1", senderName: "乙", text: "問題二" }, answerText: "短回答" });
  bot.recordActivity({ kind: "cooldown", m: { channelId: "c1", senderName: "丙", text: "問題三" } });
  const snap = bot.activitySnapshot(); // 新到舊
  assert.equal(snap[0].kind, "cooldown");
  assert.equal(snap[0].answer, null, "未回答事件不帶回答");
  assert.equal(snap[0].answerTruncated, false);
  assert.equal(snap[1].answer, "短回答");
  assert.equal(snap[1].answerTruncated, false);
  assert.equal(snap[2].answer.length, 2000, "回答全文上限 2000 字");
  assert.equal(snap[2].answerTruncated, true, "截斷要註明");
});

test("bot: 已回答事件的 answer 是實際送出的回答; 只打名字的引導事件沒有 answer (e2e)", async (t) => {
  const h = await startBotHarness(t);
  h.inject("a1", "u-a1", "AI寶，什麼是 VPN？");
  await h.waitSent((f) => f.replyTo === "a1", "answer");
  const answered = await waitUntilUnit(() => h.bot.activitySnapshot().find((a) => a.kind === "answered"), 4000, "answered activity");
  assert.equal(answered.answer, "這是一般回答。");
  h.inject("a2", "u-a2", "AI寶");
  await h.waitSent((f) => f.replyTo === "a2", "guidance");
  const guide = await waitUntilUnit(() => h.bot.activitySnapshot().find((a) => a.kind === "name_only"), 4000, "name_only activity");
  assert.equal(guide.answer, null);
});

test("bot: 回答範圍三態 (預設含出廠段落 / 改值下一則即生效 / 清空不注入且其他段落不受影響)", async (t) => {
  const h = await startBotHarness(t, { settingsOver: { triggerMode: "relaxed", cooldownSec: 0 } });
  const ask = async (id, sender) => {
    h.inject(id, sender, "AI寶，請問 VPN 怎麼連？");
    await h.waitSent((f) => f.replyTo === id, id);
    return h.aiBodies.at(-1).messages.find((x) => x.role === "system").content;
  };
  let sys = await ask("s1", "u-s1");
  assert.ok(sys.includes("回答範圍 (務必遵守):"), "預設應有範圍段落標題");
  assert.ok(sys.includes(DEFAULT_SCOPE_PROMPT), "預設應含出廠範圍文字逐字");
  h.settings.update({ ai: { scopePrompt: "只能回答 Excel 的問題。" } });
  sys = await ask("s2", "u-s2");
  assert.ok(sys.includes("只能回答 Excel 的問題。"), "改值後下一則訊息即用新值 (免重連)");
  assert.ok(!sys.includes(DEFAULT_SCOPE_PROMPT), "舊範圍文字不應殘留");
  h.settings.update({ ai: { scopePrompt: "" } });
  assert.equal(h.settings.get().ai.scopePrompt, "", "範圍清空要保留空字串 (不可被回復預設)");
  sys = await ask("s3", "u-s3");
  assert.ok(!sys.includes("回答範圍 (務必遵守):"), "清空後不注入範圍段落");
  assert.ok(sys.includes(LINE_FORMAT_RULE), "格式規則段落不受影響");
  assert.ok(sys.includes("你的個人設定:"), "人設段落不受影響");
  assert.equal(buildScopeSection(""), "");
  assert.equal(buildScopeSection("  "), "");
});

test("bot: 角色定位三態 (預設在最前面 / 自訂取代 / 清空儲存自動回復預設) 且與範圍、人設、格式並存", async (t) => {
  const h = await startBotHarness(t, { settingsOver: { triggerMode: "relaxed", cooldownSec: 0 } });
  const ask = async (id, sender) => {
    h.inject(id, sender, "AI寶，請問 VPN 怎麼連？");
    await h.waitSent((f) => f.replyTo === id, id);
    return h.aiBodies.at(-1).messages.find((x) => x.role === "system").content;
  };
  let sys = await ask("r1", "u-r1");
  assert.ok(sys.startsWith(DEFAULT_ROLE_PROMPT), "出廠角色定位應在組裝後的最前面");
  assert.equal(sys.split(DEFAULT_ROLE_PROMPT).length - 1, 1, "角色定位只出現一次 (沒有跟舊首句重複)");
  assert.ok(sys.includes(DEFAULT_SCOPE_PROMPT), "範圍段落並存");
  assert.ok(sys.includes("你的個人設定:"), "人設段落並存");
  assert.ok(sys.includes(LINE_FORMAT_RULE), "格式規則並存");
  assert.ok(sys.includes("一律用繁體中文"), "其餘既有規則行不變");
  h.settings.update({ ai: { rolePrompt: "你是測試用的小老師，專門陪同事學 Excel。" } });
  sys = await ask("r2", "u-r2");
  assert.ok(sys.startsWith("你是測試用的小老師，專門陪同事學 Excel。"), "自訂角色定位取代預設");
  assert.ok(!sys.includes(DEFAULT_ROLE_PROMPT), "預設角色定位不應殘留");
  h.settings.update({ ai: { rolePrompt: "" } });
  assert.equal(h.settings.get().ai.rolePrompt, DEFAULT_ROLE_PROMPT, "清空儲存後自動回復出廠預設");
  sys = await ask("r3", "u-r3");
  assert.ok(sys.startsWith(DEFAULT_ROLE_PROMPT), "回復預設後組裝結果回到出廠角色定位");
});

test("config: 角色定位拆分遷移 (舊出廠全文 / 首句後改過 / 全自訂不動 / 新版存檔不遷移)", async () => {
  const { writeFileSync } = await import("node:fs");
  // 1) 舊出廠全文: 首句拆到 rolePrompt, systemPrompt 只留其餘規則行
  const d1 = await tmp(); const p1 = join(d1, "settings.json");
  writeFileSync(p1, JSON.stringify({ ai: { systemPrompt: LEGACY_DEFAULT_SYSTEM_PROMPT } }));
  const s1 = new SettingsStore({ path: p1 });
  assert.equal(s1.get().ai.rolePrompt, DEFAULT_ROLE_PROMPT);
  assert.equal(s1.get().ai.systemPrompt, DEFAULT_SYSTEM_PROMPT);
  // 2) 以出廠首句開頭、後面被改過: 只拆首句, 其餘逐字保留
  const d2 = await tmp(); const p2 = join(d2, "settings.json");
  writeFileSync(p2, JSON.stringify({ ai: { systemPrompt: DEFAULT_ROLE_PROMPT + "\n自訂規則第一行\n自訂規則第二行" } }));
  const s2 = new SettingsStore({ path: p2 });
  assert.equal(s2.get().ai.rolePrompt, DEFAULT_ROLE_PROMPT);
  assert.equal(s2.get().ai.systemPrompt, "自訂規則第一行\n自訂規則第二行");
  // 3) 全自訂 (不含出廠首句): systemPrompt 逐字不動, rolePrompt 補出廠預設
  const d3 = await tmp(); const p3 = join(d3, "settings.json");
  const fullCustom = "完全自訂的提示詞\n第二行也是自訂";
  writeFileSync(p3, JSON.stringify({ ai: { systemPrompt: fullCustom } }));
  const s3 = new SettingsStore({ path: p3 });
  assert.equal(s3.get().ai.systemPrompt, fullCustom, "全自訂內容不得被覆蓋或刪減");
  assert.equal(s3.get().ai.rolePrompt, DEFAULT_ROLE_PROMPT);
  // 4) 新版存檔已有 rolePrompt: 不遷移, 兩欄都照存檔
  const d4 = await tmp(); const p4 = join(d4, "settings.json");
  writeFileSync(p4, JSON.stringify({ ai: { rolePrompt: "我的角色", systemPrompt: LEGACY_DEFAULT_SYSTEM_PROMPT } }));
  const s4 = new SettingsStore({ path: p4 });
  assert.equal(s4.get().ai.rolePrompt, "我的角色");
  assert.equal(s4.get().ai.systemPrompt, LEGACY_DEFAULT_SYSTEM_PROMPT);
});

test("bot: cleanAnswerText 清掉粗體/標題/表格符號且內容完整保留", () => {
  const dirty = "### 連線步驟\n先打開 **設定** 頁面，再按 __連線__。\n| 項目 | 內容 |\n|---|---|\n| 伺服器 | vpn.example.com |\n一般文字裡的 # 字元不在行首，不動它";
  const clean = cleanAnswerText(dirty);
  assert.ok(!clean.includes("**"), "不得殘留 **");
  assert.ok(!clean.includes("__"), "不得殘留 __");
  assert.ok(!clean.includes("|"), "不得殘留 |");
  assert.ok(!clean.includes("###"), "不得殘留 ###");
  assert.ok(!clean.includes("|---|---|"), "表格分隔列整列移除");
  assert.ok(clean.startsWith("連線步驟"), "標題改純文字保留內容");
  assert.ok(clean.includes("先打開 設定 頁面，再按 連線。"));
  assert.ok(clean.includes("伺服器・vpn.example.com"), "表格列改用 ・ 分隔");
  assert.ok(clean.includes("一般文字裡的 # 字元不在行首，不動它"), "行內 # 不誤傷");
  assert.equal(cleanAnswerText("普通回答，沒有符號。"), "普通回答，沒有符號。", "無符號文字原樣通過");
});

test("bot: AI 回答含 Markdown 符號時, 實際送出的文字已強制清理 (e2e)", async (t) => {
  const md = "### 回答\n這是 **重點** 說明。\n| A | B |\n|---|---|\n| 1 | 2 |";
  const h = await startBotHarness(t, { aiHandler: () => ({ body: { model: "stub", choices: [{ message: { role: "assistant", content: md } }] } }) });
  h.inject("c1", "u-c1", "AI寶，請問怎麼設定？");
  const sent = await h.waitSent((f) => f.replyTo === "c1", "cleaned answer");
  assert.ok(!sent.text.includes("**"), "送出文字不得含 **");
  assert.ok(!sent.text.includes("|"), "送出文字不得含 |");
  assert.ok(!sent.text.includes("#"), "送出文字不得含 #");
  assert.ok(sent.text.includes("重點"), "內容保留");
  assert.ok(sent.text.includes("1・2"), "表格內容以 ・ 保留");
  const ev = await waitUntilUnit(() => h.bot.activitySnapshot().find((a) => a.kind === "answered"), 4000, "answered activity");
  assert.equal(ev.answer, sent.text, "活動紀錄的 answer 是清理後實際送出的文字");
});
