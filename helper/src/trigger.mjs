// 觸發引擎: 名字 + 別名包含比對; 寬嚴三段; 同人冷卻; 60 秒視窗上限 (每人每群/所有群合計); 每日上限; 忽略自己。
const QUESTION_HINTS = ["?", "？", "嗎", "怎麼", "如何", "為什麼", "為何", "可以", "能不能", "請問", "幫我", "教我", "哪裡", "哪個", "什麼", "怎", "查一下", "告訴我", "請", "幫", "想問", "有沒有", "是不是", "多少", "何時", "誰"];
const LEADING_PUNCT = /^[\s:：,，、。!！?？~～\-—「『（(]+/;

// 60 秒滑動視窗 (修復版7): 只記「真正送出的提問」的時間點 (見 markTriggered),
// 檢查時先把 60 秒以前的舊時間點清掉, 剩下的筆數就是視窗內次數。
export const RATE_WINDOW_MS = 60_000;
function pruneWindow(list, nowMs) {
  const cutoff = nowMs - RATE_WINDOW_MS;
  let i = 0;
  while (i < list.length && list[i] <= cutoff) i++;
  if (i) list.splice(0, i);
  return list;
}
// 每人每群的鍵: 聊天室 + 個人。只用來計次, 不存放任何訊息內容, 群與群之間不互相讀取。
function windowKey(chatId, senderId) {
  return `${chatId ?? ""}\n${senderId ?? ""}`;
}

export function createTriggerState() {
  return {
    lastByUser: new Map(), daily: { date: "", count: 0 }, limitNoticeByUser: new Map(),
    windowByUserChat: new Map(), windowAll: [],
  };
}
// 「每日」以使用者當地日期為界 (舊版用 UTC 日期, 台灣時間每天早上 8 點才換日,
// 每日上限與今日統計的歸零時間都錯位)。用本地年月日組字串, 不經 toISOString。
export function localDateKey(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
function todayKey(now = new Date()) { return localDateKey(now); }
function rollDaily(state, now) {
  const d = todayKey(now);
  if (state.daily.date !== d) state.daily = { date: d, count: 0 };
}

export function namesOf(settings) {
  return [settings.botName, ...(settings.aliases ?? [])].filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
}

// 回傳 { triggered, reason, question, matchedName, limitReached }
// reason 代碼: self / no_name / name_only / not_question / not_at_start / cooldown /
// window_user (每人每群 60 秒到上限) / window_all (所有群合計 60 秒到上限) / daily_limit / ok / quote
// quotedSelf: 本則訊息引用 (reply) 的是機器人自己發的訊息 — 使用者已明確指向機器人, 視同名字觸發:
// 不要求文字含名、略過寬嚴的意圖/句首判定; 每日上限照舊, 文字為空仍不觸發。
// 冷卻不擋引用續答 (2026-10-20 驗收修復): 冷卻是防「連珠炮打名字」洗版的, 但引用續答是使用者
// 手動引用剛收到的回答再追問, 本來就是緊接著上一題的刻意操作; 若也吃 20 秒冷卻, 使用者會在
// 機器人回答完的幾秒內引用追問卻只得到沉默, 跟功能壞掉沒兩樣 (實機 21:28 情境的機制重現,
// 見 quote.test.mjs 的冷卻情境)。引用觸發後仍照常記冷卻時間 (markTriggered), 之後緊接著打
// 名字連發仍然會被冷卻擋, 防洗版不變。
export function evaluateTrigger({ text, senderId, selfId, settings, state, now = new Date(), quotedSelf = false, chatId = "" }) {
  const base = { triggered: false, question: "", matchedName: "" };
  if (selfId && senderId === selfId) return { ...base, reason: "self" };
  if (typeof text !== "string" || !text.trim()) return { ...base, reason: "empty" };
  const names = namesOf(settings);
  const matchedName = names.find((n) => text.includes(n)) ?? "";
  if (!matchedName && !quotedSelf) return { ...base, reason: "no_name" };
  const clean = (s) => s.replace(LEADING_PUNCT, "").replace(/[\s,，、:：;；]+$/, "").trim();
  let question;
  let idx = -1;
  if (matchedName) {
    // 問題 = 去掉名字與開頭標點後的剩餘文字 (名字在句中時, 取名字前後較長的一段)
    idx = text.indexOf(matchedName);
    const before = clean(text.slice(0, idx));
    const after = clean(text.slice(idx + matchedName.length));
    question = after.length >= before.length ? after : before;
  } else {
    // 引用續答: 沒有名字可去掉, 整段文字就是追問內容
    question = clean(text);
  }
  if (!question) {
    if (matchedName) return { ...base, triggered: true, reason: "name_only", matchedName, question: "" };
    return { ...base, reason: "empty" };
  }
  if (!quotedSelf) {
    const mode = settings.triggerMode ?? "standard";
    if (mode === "strict" && idx !== text.search(/\S/)) return { ...base, reason: "not_at_start", matchedName };
    if (mode === "standard") {
      const looksLikeAsk = QUESTION_HINTS.some((h) => question.includes(h));
      if (!looksLikeAsk) return { ...base, reason: "not_question", matchedName, question };
    }
  }
  rollDaily(state, now);
  const last = state.lastByUser.get(senderId) ?? 0;
  const cooldownMs = (settings.cooldownSec ?? 20) * 1000;
  if (!quotedSelf && now.getTime() - last < cooldownMs) return { ...base, reason: "cooldown", matchedName, question };
  // 60 秒視窗上限 (修復版7): 與每日上限同性質 (總量護欄), 引用續答照樣受限、不比照冷卻放行。
  // 設定值 0 = 不限制該項。上限比對的是「已送出的提問」筆數, 被擋下的提問本身不計次
  // (它沒送出去, 不該占用額度; 計次只發生在 markTriggered)。
  const nowMs = now.getTime();
  const userMinuteLimit = settings.perUserChatMinuteLimit ?? 3;
  if (userMinuteLimit > 0) {
    const list = pruneWindow(state.windowByUserChat.get(windowKey(chatId, senderId)) ?? [], nowMs);
    if (list.length >= userMinuteLimit) return { ...base, reason: "window_user", matchedName, question };
  }
  const allMinuteLimit = settings.allChatsMinuteLimit ?? 10;
  if (allMinuteLimit > 0) {
    pruneWindow(state.windowAll, nowMs);
    if (state.windowAll.length >= allMinuteLimit) return { ...base, reason: "window_all", matchedName, question };
  }
  if (state.daily.count >= (settings.dailyLimit ?? 100)) return { ...base, reason: "daily_limit", matchedName, question, limitReached: true };
  return { triggered: true, reason: quotedSelf && !matchedName ? "quote" : "ok", matchedName, question };
}

export function markTriggered(state, senderId, now = new Date(), chatId = "") {
  rollDaily(state, now);
  const nowMs = now.getTime();
  state.lastByUser.set(senderId, nowMs);
  // 視窗計次點 (修復版7): bot 只在「真正的提問」確定要送出時呼叫本函式 (只叫名字的引導、
  // 沒問句的訊息都走不到這裡, 天然不計次); 之後就算 AI 回答失敗, 這一筆也已計入 — 與
  // Codex 版核准的計次規則一致 (只計實際 AI 呼叫、服務商失敗仍計入)。
  const key = windowKey(chatId, senderId);
  const list = pruneWindow(state.windowByUserChat.get(key) ?? [], nowMs);
  list.push(nowMs);
  state.windowByUserChat.set(key, list);
  pruneWindow(state.windowAll, nowMs);
  state.windowAll.push(nowMs);
  // 防記憶體長大: 清掉已滑出視窗的空鍵 (只在 map 變大時做, 避免每則訊息都全掃)
  if (state.windowByUserChat.size > 500) {
    for (const [k, v] of state.windowByUserChat) {
      if (k !== key && pruneWindow(v, nowMs).length === 0) state.windowByUserChat.delete(k);
    }
  }
}
export function markAnswered(state, now = new Date()) {
  rollDaily(state, now);
  state.daily.count += 1;
  return state.daily.count;
}
