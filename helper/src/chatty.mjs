// 聒噪模式 (修復版5): 每群獨立開關的自由接話 — 近期對話脈絡 + 節奏護欄 + 安靜協議。
// 設計定案見 ~/workspace/linejs-test/工作範圍與計畫-聒噪模式.md。
// 本模組只管「狀態」(脈絡與護欄計數), 接不接話一律由 AI 判斷, 不含任何關鍵字規則。

/** AI 判斷不接話時只輸出這個標記; 送出端認得就整則吞掉, 群友永遠看不到。 */
export const CHATTY_PASS_MARKER = "[[PASS]]";

/** 脈絡: 每群最多留最近幾則文字訊息。 */
export const CHATTY_CONTEXT_MAX_MESSAGES = 30;
/** 脈絡: 每則最多留幾個字 (超長訊息截斷, 避免脈絡被單則灌爆)。 */
export const CHATTY_CONTEXT_MAX_CHARS = 300;
/** 脈絡: 超過這個時間的訊息不再算進脈絡 (30 分鐘)。 */
export const CHATTY_CONTEXT_TTL_MS = 30 * 60 * 1000;

/** 護欄: 同一群兩次實際送出的接話之間最小間隔 (老吳定案 45 秒)。 */
export const CHATTY_MIN_SEND_GAP_MS = 45_000;
/** 護欄: 同一群每小時實際送出的接話上限 (老吳定案 20 則)。 */
export const CHATTY_HOURLY_LIMIT = 20;
/** 護欄: 同一群兩次送 AI 評估之間最小間隔 (避免每則訊息都燒一次呼叫)。 */
export const CHATTY_EVAL_MIN_INTERVAL_MS = 10_000;
/** 護欄: 跟同一個人連續來回接話幾次後進入冷卻 (防無限來回)。 */
export const CHATTY_PAIR_MAX = 3;
/** 護欄: 來回達上限後, 對該對象冷卻多久 (10 分鐘)。 */
export const CHATTY_PAIR_COOLDOWN_MS = 10 * 60 * 1000;
/** 接話回覆的 AI 輸出上限 (接話是簡短插話, 不需要長答覆)。 */
export const CHATTY_REPLY_MAX_TOKENS = 512;

/**
 * 接話指示 (程式固定附加): 有自然合適的話才接, 否則只輸出安靜標記。
 * 判斷標準寫在這裡給 AI 看, 本機程式不做任何內容判斷。
 */
export const CHATTY_INSTRUCTIONS = [
  "接話模式指示:",
  "- 你是這個群組裡的一員, 正在跟大家一起聊天; 下面給你這個群最近的對話, 最後一則 user 訊息是群友剛講的話。",
  "- 只有在你有自然、合適、接得上話題的話想說時才回覆; 回覆要簡短自然, 像真人隨口接話一樣, 一到兩句就好, 不要長篇大論。",
  "- 如果沒有合適的話可接、話題跟你無關、或你不確定要不要接, 就只輸出 [[PASS]] 這一個標記, 不要加任何其他文字。",
  "- 不要重複別人剛講過的話; 不要每則都回; 不要連續問問題追著別人回答; 提到你時也不要用正式回答的口氣。",
].join("\n");

/**
 * 解析 AI 的接話回覆: 只含標記 (或標記剝除後為空) = 安靜; 有內容 = 送出剝除標記後的文字。
 * 保證標記絕不外洩進群組: 不管 AI 把標記放在哪裡, 一律先全部剝掉再判斷。
 */
export function parseChattyReply(text) {
  if (typeof text !== "string") return { pass: true, text: "" };
  const stripped = text.split(CHATTY_PASS_MARKER).join("").trim();
  if (!stripped) return { pass: true, text: "" };
  return { pass: false, text: stripped };
}

/**
 * 每群一份狀態: 近期對話脈絡 + 護欄計數。全部只存記憶體 (重啟歸零)。
 * 時間由呼叫端傳入 nowMs (可注入假時間測試); 本模組自己不讀系統時鐘。
 */
export class ChattyTracker {
  constructor() {
    this.chats = new Map(); // chatId -> state
  }

  stateOf(chatId) {
    let st = this.chats.get(chatId);
    if (!st) {
      st = {
        context: [],          // [{ senderId, senderName, text, self, at }]
        lastSentAt: 0,        // 上次實際送出接話的時間
        sentAt: [],           // 近一小時實際送出的時間點 (算每小時上限)
        lastEvalAt: 0,        // 上次送 AI 評估的時間
        breather: false,      // 剛接過話: 下一則候選先不接
        pairs: new Map(),     // senderId -> { streak, cooldownUntil }
      };
      this.chats.set(chatId, st);
    }
    return st;
  }

  /**
   * 記一則訊息進脈絡 (只記文字; 呼叫端已篩過)。別的人插話時, 其他人的來回
   * 連續次數歸零 — 對話已經往下走了, 不算跟某人無限來回。
   */
  record(chatId, entry, nowMs) {
    if (!chatId || typeof entry?.text !== "string" || !entry.text) return;
    const st = this.stateOf(chatId);
    const text = entry.text.length > CHATTY_CONTEXT_MAX_CHARS ? entry.text.slice(0, CHATTY_CONTEXT_MAX_CHARS) : entry.text;
    st.context.push({
      senderId: typeof entry.senderId === "string" ? entry.senderId : "",
      senderName: typeof entry.senderName === "string" ? entry.senderName : "",
      text,
      self: entry.self === true,
      at: nowMs,
    });
    this.pruneContext(st, nowMs);
    if (!entry.self && entry.senderId) {
      for (const [sid, pair] of st.pairs) {
        if (sid !== entry.senderId) pair.streak = 0;
      }
    }
  }

  pruneContext(st, nowMs) {
    const cutoff = nowMs - CHATTY_CONTEXT_TTL_MS;
    while (st.context.length && st.context[0].at < cutoff) st.context.shift();
    while (st.context.length > CHATTY_CONTEXT_MAX_MESSAGES) st.context.shift();
  }

  /** 取脈絡副本 (已套用逾時淘汰); 呼叫端組提示詞用, 不得修改內部狀態。 */
  context(chatId, nowMs) {
    const st = this.chats.get(chatId);
    if (!st) return [];
    this.pruneContext(st, nowMs);
    return st.context.map((e) => ({ ...e }));
  }

  /**
   * 護欄檢查: 回 { ok: true } 或 { ok: false, reason }。順序有意義:
   * 不連續搶話最先查 — 「剛接過話, 下一則先不接」指的是字面上的下一則候選,
   * 不論是誰講的, 都由它消耗掉這個名額; 然後對象冷卻、送出間隔、每小時
   * 上限, 最後才是評估節流。
   */
  check(chatId, senderId, nowMs) {
    const st = this.stateOf(chatId);
    if (st.breather) {
      st.breather = false;
      return { ok: false, reason: "breather" };
    }
    const pair = senderId ? st.pairs.get(senderId) : null;
    if (pair && pair.cooldownUntil > nowMs) return { ok: false, reason: "pair_cooldown" };
    if (st.lastSentAt && nowMs - st.lastSentAt < CHATTY_MIN_SEND_GAP_MS) return { ok: false, reason: "send_gap" };
    const hourAgo = nowMs - 60 * 60 * 1000;
    st.sentAt = st.sentAt.filter((t) => t > hourAgo);
    if (st.sentAt.length >= CHATTY_HOURLY_LIMIT) return { ok: false, reason: "hourly_limit" };
    if (st.lastEvalAt && nowMs - st.lastEvalAt < CHATTY_EVAL_MIN_INTERVAL_MS) return { ok: false, reason: "eval_interval" };
    return { ok: true };
  }

  /** 記一次「已送 AI 評估」(評估節流的起點)。 */
  noteEval(chatId, nowMs) {
    this.stateOf(chatId).lastEvalAt = nowMs;
  }

  /** 記一次「實際送出接話」: 更新間隔/小時計數、設不連續搶話、累積對象來回次數。 */
  noteSent(chatId, senderId, nowMs) {
    const st = this.stateOf(chatId);
    st.lastSentAt = nowMs;
    st.sentAt.push(nowMs);
    st.breather = true;
    if (senderId) {
      const pair = st.pairs.get(senderId) ?? { streak: 0, cooldownUntil: 0 };
      pair.streak += 1;
      if (pair.streak >= CHATTY_PAIR_MAX) {
        pair.cooldownUntil = nowMs + CHATTY_PAIR_COOLDOWN_MS;
        pair.streak = 0;
      }
      st.pairs.set(senderId, pair);
    }
  }
}
