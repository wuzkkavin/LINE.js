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
import { parseApiSection, applyApiConfig, applyCoreApiConfig, readCoreApiStatus, isValidChatId } from "../src/linecfg.mjs";
import { MessageSenderRegistry } from "../src/msgregistry.mjs";
import { HelperBot } from "../src/bot.mjs";
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

test("trigger: 引用續答仍受冷卻與每日上限", () => {
  const st = createTriggerState();
  const now = new Date();
  let v = evaluateTrigger({ text: "AI寶,問題一？", senderId: "u1", selfId: "me", settings: triggerSettings(), state: st, now });
  assert.equal(v.triggered, true);
  markTriggered(st, "u1", now); markAnswered(st, now);
  // 冷卻中: 就算是引用自己的回答追問, 也不觸發
  v = evaluateTrigger({ text: "那問題二呢", senderId: "u1", selfId: "me", settings: triggerSettings(), state: st, now: new Date(now.getTime() + 5000), quotedSelf: true });
  assert.equal(v.triggered, false); assert.equal(v.reason, "cooldown");
  // 每日上限: 引用續答同樣被擋下並帶 limitReached
  const st2 = createTriggerState();
  markAnswered(st2, now); markAnswered(st2, now);
  v = evaluateTrigger({ text: "再告訴我一件事", senderId: "u9", selfId: "me", settings: triggerSettings({ dailyLimit: 2 }), state: st2, now, quotedSelf: true });
  assert.equal(v.triggered, false); assert.equal(v.reason, "daily_limit"); assert.equal(v.limitReached, true);
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
