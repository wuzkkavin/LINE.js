import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore, DEFAULT_ROLE_PROMPT } from "../src/config.mjs";
import { getChatProfile, resolveChatSettings, buildScopeGuardSection, SCOPE_GUARD_RULE, classifyAnswerKind, guidanceForChat, isChattyEnabled, CONFIDENTIALITY_RULE } from "../src/chatprofile.mjs";
import { guidanceText } from "../src/bot.mjs";
import { KbPool } from "../src/kb.mjs";

const CHAT_A = `c${"a".repeat(32)}`;
const CHAT_B = `c${"b".repeat(32)}`;
const CHAT_C = `c${"c".repeat(32)}`;

async function tmp() { return mkdtemp(join(tmpdir(), "helper-chatprofile-")); }

function baseSettings(over = {}) {
  return {
    botName: "AI寶",
    ai: {
      rolePrompt: "全域角色標記",
      scopePrompt: "全域範圍標記",
      chatProfiles: {},
      ...(over.ai ?? {}),
    },
    kb: { folder: "/global-kb", ...(over.kb ?? {}) },
    ...over,
  };
}

test("chatprofile resolver: 未設定 -> 全域", () => {
  const s = baseSettings();
  const r = resolveChatSettings(s, CHAT_A);
  assert.equal(r.source, "global");
  assert.equal(r.rolePrompt, "全域角色標記");
  assert.equal(r.scopePrompt, "全域範圍標記");
  assert.equal(r.kbEnabled, true);
  assert.equal(r.kbFolder, "/global-kb");
  assert.equal(getChatProfile(s, CHAT_A), null);
});

test("chatprofile resolver: 自訂 -> 取代且不含全域值", () => {
  const s = baseSettings();
  s.ai.chatProfiles[CHAT_B] = { rolePrompt: "本群角色標記", scopePrompt: "本群範圍標記", kbEnabled: true, kbFolder: "/b-kb", suspended: false };
  const r = resolveChatSettings(s, CHAT_B);
  assert.equal(r.source, "chat");
  assert.equal(r.rolePrompt, "本群角色標記");
  assert.equal(r.scopePrompt, "本群範圍標記");
  assert.ok(!r.rolePrompt.includes("全域角色標記"));
  assert.ok(!r.scopePrompt.includes("全域範圍標記"));
  assert.equal(r.kbFolder, "/b-kb");
});

test("chatprofile resolver: suspended -> 全域", () => {
  const s = baseSettings();
  s.ai.chatProfiles[CHAT_B] = { rolePrompt: "本群角色標記", scopePrompt: "本群範圍標記", kbEnabled: true, kbFolder: "/b-kb", suspended: true };
  const r = resolveChatSettings(s, CHAT_B);
  assert.equal(r.source, "global");
  assert.equal(r.rolePrompt, "全域角色標記");
  assert.equal(getChatProfile(s, CHAT_B), null);
});

test("chatprofile resolver: kbEnabled=false 與 kbFolder 空 -> 全域資料夾, 角色空退預設", () => {
  const s = baseSettings();
  s.ai.chatProfiles[CHAT_B] = { rolePrompt: "", scopePrompt: "", kbEnabled: false, kbFolder: "", suspended: false };
  const r = resolveChatSettings(s, CHAT_B);
  assert.equal(r.source, "chat");
  assert.equal(r.kbEnabled, false);
  assert.equal(r.kbFolder, "/global-kb", "kbFolder 空應退全域資料夾");
  assert.equal(r.rolePrompt, DEFAULT_ROLE_PROMPT, "本群角色空應退預設");
  assert.equal(r.scopePrompt, "", "本群範圍空 = 不限制 (V10 語意), 不退全域");
  // 全域角色空也退預設
  const s2 = baseSettings(); s2.ai.rolePrompt = "   ";
  assert.equal(resolveChatSettings(s2, CHAT_A).rolePrompt, DEFAULT_ROLE_PROMPT);
});

test("SettingsStore: chatProfiles 存讀來回一致", async () => {
  const dir = await tmp();
  const path = join(dir, "settings.json");
  const store = new SettingsStore({ path });
  store.update({ ai: { chatProfiles: { [CHAT_B]: { rolePrompt: "B角色", scopePrompt: "B範圍", kbEnabled: false, kbFolder: "/tmp/b-kb", suspended: false } } } });
  const store2 = new SettingsStore({ path });
  // 修復版5 起多了 chatty (預設 false) 與 personaCustom (舊存檔缺此欄位預設 true)
  assert.deepEqual(store2.get().ai.chatProfiles[CHAT_B], { rolePrompt: "B角色", scopePrompt: "B範圍", kbEnabled: false, kbFolder: "/tmp/b-kb", suspended: false, chatty: false, personaCustom: true });
  // 預設應有 chatProfiles 空物件
  assert.deepEqual(new SettingsStore({ path: join(dir, "fresh.json") }).get().ai.chatProfiles, {});
});

test("SettingsStore: chatProfiles null 刪除條目 (恢復用預設)", async () => {
  const dir = await tmp();
  const path = join(dir, "settings.json");
  const store = new SettingsStore({ path });
  store.update({ ai: { chatProfiles: { [CHAT_B]: { rolePrompt: "B角色", scopePrompt: "B範圍" } } } });
  assert.ok(store.get().ai.chatProfiles[CHAT_B]);
  store.update({ ai: { chatProfiles: { [CHAT_B]: null } } });
  assert.equal(store.get().ai.chatProfiles[CHAT_B], undefined);
  const store2 = new SettingsStore({ path });
  assert.equal(store2.get().ai.chatProfiles[CHAT_B], undefined);
});

test("SettingsStore: 無效 chatId 鍵被丟棄", async () => {
  const dir = await tmp();
  const store = new SettingsStore({ path: join(dir, "settings.json") });
  store.update({ ai: { chatProfiles: {
    "bad-id": { rolePrompt: "x" },
    "x123": { rolePrompt: "y" },
    [`C${"a".repeat(32)}`]: { rolePrompt: "z" },
    [CHAT_A]: { rolePrompt: "ok" },
  } } });
  const profiles = store.get().ai.chatProfiles;
  assert.deepEqual(Object.keys(profiles), [CHAT_A]);
  assert.equal(profiles[CHAT_A].rolePrompt, "ok");
});

test("SettingsStore: chatProfiles 欄位截斷與型別正規化, 合併欄位語意", async () => {
  const dir = await tmp();
  const store = new SettingsStore({ path: join(dir, "settings.json") });
  const longRole = "長".repeat(5000);
  const longFolder = "/" + "a".repeat(2000);
  store.update({ ai: { chatProfiles: { [CHAT_A]: { rolePrompt: longRole, scopePrompt: longRole, kbFolder: longFolder, kbEnabled: 1, suspended: 0 } } } });
  let p = store.get().ai.chatProfiles[CHAT_A];
  assert.equal(p.rolePrompt.length, 4000);
  assert.equal(p.scopePrompt.length, 4000);
  assert.equal(p.kbFolder.length, 1024);
  assert.equal(p.kbEnabled, true);
  assert.equal(p.suspended, false);
  // 合併欄位: 只傳 scopePrompt, 其他欄位保留
  store.update({ ai: { chatProfiles: { [CHAT_A]: { scopePrompt: "新範圍" } } } });
  p = store.get().ai.chatProfiles[CHAT_A];
  assert.equal(p.scopePrompt, "新範圍");
  assert.equal(p.rolePrompt.length, 4000, "合併時未傳的欄位應保留");
  // 缺值預設: 新條目只給 rolePrompt, kbEnabled 預設 true, suspended 預設 false
  store.update({ ai: { chatProfiles: { [CHAT_C]: { rolePrompt: "只有角色" } } } });
  const pc = store.get().ai.chatProfiles[CHAT_C];
  assert.equal(pc.kbEnabled, true);
  assert.equal(pc.suspended, false);
  assert.equal(pc.scopePrompt, "");
  assert.equal(pc.kbFolder, "");
});

test("chatty (修復版5): 只開聒噪的群人設仍走全域, isChattyEnabled 認開關不認人設", () => {
  const s = baseSettings();
  // 只開聒噪: personaCustom=false, 角色欄位留空
  s.ai.chatProfiles[CHAT_A] = { rolePrompt: "", scopePrompt: "", kbEnabled: true, kbFolder: "", suspended: false, chatty: true, personaCustom: false };
  assert.equal(isChattyEnabled(s, CHAT_A), true);
  assert.equal(getChatProfile(s, CHAT_A), null, "只開聒噪的條目不應被當成人設自訂");
  const r = resolveChatSettings(s, CHAT_A);
  assert.equal(r.source, "global", "只開聒噪的群人設應沿用全域");
  assert.equal(r.rolePrompt, "全域角色標記");
  // 沒開聒噪的群
  assert.equal(isChattyEnabled(s, CHAT_B), false);
  // 停用中的條目: 聒噪一併視為關
  s.ai.chatProfiles[CHAT_B] = { rolePrompt: "", scopePrompt: "", kbEnabled: true, kbFolder: "", suspended: true, chatty: true, personaCustom: false };
  assert.equal(isChattyEnabled(s, CHAT_B), false, "suspended 的群聒噪應視為關閉");
  // 舊存檔形狀 (沒有 chatty/personaCustom 欄位): chatty 視為關、人設視為自訂 (修復版4 行為不變)
  s.ai.chatProfiles[CHAT_C] = { rolePrompt: "舊版角色", scopePrompt: "", kbEnabled: true, kbFolder: "", suspended: false };
  assert.equal(isChattyEnabled(s, CHAT_C), false);
  assert.equal(getChatProfile(s, CHAT_C)?.rolePrompt, "舊版角色");
  assert.equal(resolveChatSettings(s, CHAT_C).source, "chat");
});

test("CONFIDENTIALITY_RULE: 四類不可透露 + 套話應對齊備", () => {
  assert.ok(CONFIDENTIALITY_RULE.includes("其他群組"), "應含別群保密");
  assert.ok(CONFIDENTIALITY_RULE.includes("mid") && CONFIDENTIALITY_RULE.includes("管理員名單"), "應含個人資料與帳號識別");
  assert.ok(CONFIDENTIALITY_RULE.includes("API Key") && CONFIDENTIALITY_RULE.includes("Token"), "應含程式設定與憑證");
  assert.ok(CONFIDENTIALITY_RULE.includes("知識庫") && CONFIDENTIALITY_RULE.includes("機敏"), "應含知識庫範圍與公司機敏");
  assert.ok(CONFIDENTIALITY_RULE.includes("不證實也不否認") && CONFIDENTIALITY_RULE.includes("帶開"), "應含套話應對: 不證實不否認、帶開話題");
  assert.ok(CONFIDENTIALITY_RULE.includes("不要編造假資訊"), "應含不編造假資訊");
});

test("buildScopeGuardSection: 空 -> 空字串, 非空含三點把關語意", () => {
  assert.equal(buildScopeGuardSection(""), "");
  assert.equal(buildScopeGuardSection("   "), "");
  assert.equal(buildScopeGuardSection(null), "");
  assert.equal(buildScopeGuardSection(undefined), "");
  const sec = buildScopeGuardSection("只回答藍莓專案的問題");
  assert.ok(sec.startsWith("回答範圍 (務必遵守):\n只回答藍莓專案的問題"));
  assert.ok(sec.includes(SCOPE_GUARD_RULE));
  // 三點語意關鍵句
  assert.ok(sec.includes("婉拒") && sec.includes("負責的範圍") && sec.includes("帶回範圍內"), "應含婉拒三步驟");
  assert.ok(sec.includes("不要編造範圍外的答案"), "應含不編造");
  assert.ok(sec.includes("知識庫") && sec.includes("不准拿來回答範圍外的問題"), "應含知識庫不得繞過範圍");
  assert.ok(sec.includes("太模糊") && sec.includes("一個最關鍵的問題"), "應含模糊反問一個關鍵問題");
  assert.ok(sec.includes("不要亂猜") && sec.includes("不要連續反問"), "應含不亂猜/不連續反問");
});

test("classifyAnswerKind: 婉拒 -> declined, 反問 -> clarify, 一般 -> null, declined 優先", () => {
  assert.equal(classifyAnswerKind("這個我就不在行啦，我在這個群主要是幫大家處理電腦問題。"), "declined");
  assert.equal(classifyAnswerKind("不好意思，這題超出我在這個群負責的範圍了，我怕亂答反而誤導你。"), "declined");
  assert.equal(classifyAnswerKind("這題幫不上忙，已經超出範圍了。"), "declined");
  assert.equal(classifyAnswerKind("你說的是哪一個？是 Excel、公司系統，還是哪個 AI 工具？"), "clarify");
  assert.equal(classifyAnswerKind("請問你指的是哪一種情況？"), "clarify");
  assert.equal(classifyAnswerKind("是指 Windows 版嗎？可以跟我說一下嗎？"), "clarify");
  assert.equal(classifyAnswerKind("凍結窗格步驟: 先點儲存格，再點檢視，最後按凍結窗格。"), null);
  assert.equal(classifyAnswerKind(""), null);
  assert.equal(classifyAnswerKind(null), null);
  // 同時像婉拒又像反問時先判 declined
  assert.equal(classifyAnswerKind("這題超出負責的範圍了，你說的是哪一個範圍？"), "declined");
});

test("guidanceForChat: 全域回原文, 自訂含本群角色文字且過長截斷", () => {
  const globalResolved = resolveChatSettings(baseSettings(), CHAT_A);
  assert.equal(guidanceForChat("AI寶", globalResolved), guidanceText("AI寶"));
  const s = baseSettings();
  s.ai.chatProfiles[CHAT_B] = { rolePrompt: "本群是藍莓專案助理，專門回答藍莓專案的問題。", scopePrompt: "", kbEnabled: true, kbFolder: "", suspended: false };
  const chatResolved = resolveChatSettings(s, CHAT_B);
  const g = guidanceForChat("AI寶", chatResolved);
  assert.ok(g.includes("我是AI寶"));
  assert.ok(g.includes("本群是藍莓專案助理"));
  assert.ok(g.includes("你要問什麼？可以直接打字問我"));
  // 過長截斷
  const s2 = baseSettings();
  s2.ai.chatProfiles[CHAT_B] = { rolePrompt: "長".repeat(200), scopePrompt: "", kbEnabled: true, kbFolder: "", suspended: false };
  const g2 = guidanceForChat("AI寶", resolveChatSettings(s2, CHAT_B));
  assert.ok(g2.includes("…"));
  assert.ok(g2.length < 220);
});

test("KbPool: 兩資料夾兩群隔離搜尋, 換 B 資料夾只換 B, folder=全域回全域實例", async () => {
  const dir = await tmp();
  const globalDir = join(dir, "global"); await mkdir(globalDir, { recursive: true });
  const aDir = join(dir, "a-kb"); await mkdir(aDir, { recursive: true });
  const bDir = join(dir, "b-kb"); await mkdir(bDir, { recursive: true });
  const b2Dir = join(dir, "b2-kb"); await mkdir(b2Dir, { recursive: true });
  await writeFile(join(globalDir, "全域文件.txt"), "全域文件內容: 公司彩色列印在四樓影印室, 分機 412。彩色列印請先登記。");
  await writeFile(join(aDir, "甲群獨有.txt"), "甲群獨有文件: 紫水晶行動的集合地點在山頂觀測站。紫水晶行動集合時間是清晨六點, 請準時到達觀測站集合。");
  await writeFile(join(bDir, "乙群獨有.txt"), "乙群獨有文件: 藍莓專案的會議安排在五樓創新中心。藍莓專案會議分機是 555, 會議前請先確認創新中心預約。");
  await writeFile(join(b2Dir, "乙群新文件.txt"), "乙群新文件: 綠寶石計畫的展示地點在河濱展覽館。綠寶石計畫展示分機是 777, 展示前請先確認展覽館預約。");

  const pool = new KbPool({ dataDir: dir, logger: null, globalFolder: globalDir });
  const globalKb = pool.globalKb();
  await globalKb.scan({ force: true });

  // folder 空或等於全域 -> 回全域實例
  assert.equal(pool.forFolder(CHAT_A, ""), globalKb);
  assert.equal(pool.forFolder(CHAT_A, globalDir), globalKb);

  const kbA = pool.forFolder(CHAT_A, aDir);
  const kbB = pool.forFolder(CHAT_B, bDir);
  assert.notEqual(kbA, globalKb);
  assert.notEqual(kbA, kbB);
  assert.equal(pool.forFolder(CHAT_A, aDir), kbA, "同群同資料夾應回同一實例");
  await kbA.scan({ force: true });
  await kbB.scan({ force: true });

  // 隔離: A 只命中自己資料夾, B 只命中自己, 都不命中對方的
  const hitsA = kbA.search("紫水晶行動集合地點在哪裡", 3);
  assert.ok(hitsA.length >= 1 && hitsA[0].file === "甲群獨有.txt", `A 應命中甲群獨有, 實際 ${JSON.stringify(hitsA.map(h=>h.file))}`);
  assert.equal(kbA.search("藍莓專案會議在哪裡", 3).length, 0, "A 不得命中 B 的文件");
  const hitsB = kbB.search("藍莓專案會議在哪裡", 3);
  assert.ok(hitsB.length >= 1 && hitsB[0].file === "乙群獨有.txt");
  assert.equal(kbB.search("紫水晶行動集合地點在哪裡", 3).length, 0, "B 不得命中 A 的文件");
  // 全域也查不到專屬文件
  assert.equal(globalKb.search("紫水晶行動集合地點在哪裡", 3).length, 0);

  // chatStatuses 只含專屬實例
  const statuses = pool.chatStatuses();
  assert.deepEqual(Object.keys(statuses).sort(), [CHAT_A, CHAT_B].sort());
  assert.equal(statuses[CHAT_A].folder, aDir);

  // 換 B 的資料夾: 只有 B 換新實例, A 不受影響
  const kbB2 = pool.forFolder(CHAT_B, b2Dir);
  assert.notEqual(kbB2, kbB);
  assert.equal(pool.forFolder(CHAT_A, aDir), kbA, "換 B 資料夾不得影響 A 的實例");
  await kbB2.scan({ force: true });
  const hitsB2 = kbB2.search("綠寶石計畫展示地點在哪裡", 3);
  assert.ok(hitsB2.length >= 1 && hitsB2[0].file === "乙群新文件.txt");
  assert.equal(kbB2.search("藍莓專案會議在哪裡", 3).length, 0, "B 換資料夾後舊內容不得再被引用");
  assert.ok(kbA.search("紫水晶行動集合地點在哪裡", 3).length >= 1, "A 的索引不受 B 換資料夾影響");

  // syncFromSettings 預熱與回傳形狀
  const pool2 = new KbPool({ dataDir: dir, logger: null, globalFolder: globalDir });
  const settings = {
    ai: { chatProfiles: {
      [CHAT_A]: { rolePrompt: "", scopePrompt: "", kbEnabled: true, kbFolder: aDir, suspended: false },
      [CHAT_B]: { rolePrompt: "", scopePrompt: "", kbEnabled: false, kbFolder: bDir, suspended: false },
      [CHAT_C]: { rolePrompt: "", scopePrompt: "", kbEnabled: true, kbFolder: bDir, suspended: true },
    } },
    kb: { folder: globalDir },
  };
  const warmed = pool2.syncFromSettings(settings);
  assert.equal(warmed.length, 1, "只有未停用且 kbEnabled 的專屬資料夾群會預熱");
  assert.equal(warmed[0].chatId, CHAT_A);
  assert.equal(warmed[0].folder, aDir);
  assert.equal(warmed[0].fileCount, 1);
  // setGlobalFolder
  pool2.setGlobalFolder(aDir);
  assert.equal(pool2.globalKb().folder, aDir);
});
