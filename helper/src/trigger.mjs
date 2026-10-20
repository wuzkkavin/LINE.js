// 觸發引擎: 名字 + 別名包含比對; 寬嚴三段; 同人冷卻; 每日上限; 忽略自己。
const QUESTION_HINTS = ["?", "？", "嗎", "怎麼", "如何", "為什麼", "為何", "可以", "能不能", "請問", "幫我", "教我", "哪裡", "哪個", "什麼", "怎", "查一下", "告訴我", "請", "幫", "想問", "有沒有", "是不是", "多少", "何時", "誰"];
const LEADING_PUNCT = /^[\s:：,，、。!！?？~～\-—「『（(]+/;

export function createTriggerState() {
  return { lastByUser: new Map(), daily: { date: "", count: 0 }, limitNoticeByUser: new Map() };
}
function todayKey(now = new Date()) { return now.toISOString().slice(0, 10); }
function rollDaily(state, now) {
  const d = todayKey(now);
  if (state.daily.date !== d) state.daily = { date: d, count: 0 };
}

export function namesOf(settings) {
  return [settings.botName, ...(settings.aliases ?? [])].filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
}

// 回傳 { triggered, reason, question, matchedName, limitReached }
// reason 代碼: self / no_name / name_only / not_question / not_at_start / cooldown / daily_limit / ok / quote
// quotedSelf: 本則訊息引用 (reply) 的是機器人自己發的訊息 — 使用者已明確指向機器人, 視同名字觸發:
// 不要求文字含名、略過寬嚴的意圖/句首判定; 但冷卻與每日上限照舊, 文字為空仍不觸發。
export function evaluateTrigger({ text, senderId, selfId, settings, state, now = new Date(), quotedSelf = false }) {
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
  if (now.getTime() - last < cooldownMs) return { ...base, reason: "cooldown", matchedName, question };
  if (state.daily.count >= (settings.dailyLimit ?? 100)) return { ...base, reason: "daily_limit", matchedName, question, limitReached: true };
  return { triggered: true, reason: quotedSelf && !matchedName ? "quote" : "ok", matchedName, question };
}

export function markTriggered(state, senderId, now = new Date()) {
  rollDaily(state, now);
  state.lastByUser.set(senderId, now.getTime());
}
export function markAnswered(state, now = new Date()) {
  rollDaily(state, now);
  state.daily.count += 1;
  return state.daily.count;
}
