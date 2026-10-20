// 機器人主程式: 連 LINE.js 核心的 /api/ws, 串起 觸發 -> 知識庫優先 -> AI 回答, 以及防詐騙自動掃描。
// 名字一律取自設定 (botName / aliases), 本檔不寫死任何名字。
import WebSocket from "ws";
import { evaluateTrigger, markAnswered, markTriggered, createTriggerState } from "./trigger.mjs";
import { MessageSenderRegistry } from "./msgregistry.mjs";
import { extractScamTarget, isManualScamAsk, judgeScam, prefilterScam, scamVerdictText, scamWarningText, PerMinuteLimiter } from "./scam.mjs";
import { SECRET_NAMES } from "./config.mjs";

const COMPANY_HINTS = ["公司", "華葳", "內部", "規定", "請假", "加班", "影印", "列印", "印表機", "分機", "會議室", "系統", "帳號申請", "福利", "薪資", "考勤", "打卡", "公文", "簽呈", "部門", "同仁", "總公司", "工務所"];

export function guidanceText(botName) {
  const name = botName || "我";
  return `我在，我是${name}。你要問什麼？可以直接打字問我，例如：${name}，Excel 怎麼凍結窗格？或是：${name}，公司彩色列印在哪裡？`;
}
export function limitText(botName) {
  return `不好意思，今天${botName || "機器人"}的回答次數已達上限，明天再問我，或直接找資訊部同事幫忙。`;
}
export function kbMissText() {
  return "這個問題我在公司的知識庫裡查不到，所以不敢亂答。建議你問一下資訊部同事，或請管理員把相關文件放進知識庫資料夾，我下次就能回答了。";
}

export class HelperBot {
  constructor({ settings, secrets, ai, kb, logger, registry } = {}) {
    this.settings = settings; // SettingsStore
    this.secrets = secrets;
    this.ai = ai;
    this.kb = kb;
    this.logger = logger;
    // 訊息寄件者登記簿: 認定被引用的訊息是不是機器人自己發的 (引用續答觸發用)
    this.registry = registry ?? new MessageSenderRegistry({ logger });
    this.triggerState = createTriggerState();
    this.scamLimiter = new PerMinuteLimiter(10);
    this.memory = new Map(); // chatId -> [{role, content}]
    this.ws = null;
    this.selfId = "";
    this.selfName = "";
    this.connected = false;
    this.lineState = "未連線";
    this.pending = new Map();
    this.reqSeq = 0;
    this.stats = { date: "", answered: 0, triggered: 0, scamChecked: 0, scamWarned: 0 };
  }
  cfg() { return this.settings.get(); }
  rollStats() {
    const d = new Date().toISOString().slice(0, 10);
    if (this.stats.date !== d) this.stats = { date: d, answered: 0, triggered: 0, scamChecked: 0, scamWarned: 0 };
  }
  status() {
    this.rollStats();
    const s = this.cfg();
    return {
      connected: this.connected,
      lineState: this.lineState,
      selfName: this.selfName,
      botName: s.botName,
      aiActive: s.ai.active,
      aiModel: s.ai.providers[s.ai.active]?.model ?? "",
      kb: this.kb ? this.kb.status() : null,
      scam: { enabled: s.scam.enabled, threshold: s.scam.threshold, checkedToday: this.stats.scamChecked, warnedToday: this.stats.scamWarned },
      answeredToday: this.stats.answered,
    };
  }
  async providerWithKey(providerId) {
    const s = this.cfg();
    const cfg = s.ai.providers[providerId];
    if (!cfg) throw new Error(`未知的 AI 供應商: ${providerId}`);
    const key = this.secrets ? await this.secrets.get(SECRET_NAMES[providerId]) : null;
    if (key) this.logger?.addSecret(key);
    return { cfg, key };
  }
  async chatWithAi(messages, { temperature = 0.3 } = {}) {
    const s = this.cfg();
    const order = [s.ai.active, ...Object.keys(s.ai.providers).filter((p) => p !== s.ai.active)];
    const tries = s.ai.fallback ? order : [s.ai.active];
    let lastErr;
    for (const pid of tries) {
      try {
        const { cfg, key } = await this.providerWithKey(pid);
        const started = Date.now();
        const r = await this.ai.chat({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: key, messages, temperature });
        this.logger?.info("AI", "AI 回答完成", { provider: pid, model: cfg.model, ms: Date.now() - started, chars: r.content.length });
        return { ...r, provider: pid };
      } catch (e) {
        lastErr = e;
        this.logger?.warn("AI", "AI 呼叫失敗", { provider: pid, error: String(e?.message ?? e) });
        if (!s.ai.fallback) break;
      }
    }
    throw lastErr;
  }

  connect() {
    const s = this.cfg();
    const url = s.lineApiUrl;
    return new Promise(async (resolve, reject) => {
      const token = this.secrets ? await this.secrets.get(SECRET_NAMES.lineToken) : null;
      if (!token) { this.logger?.warn("機器人", "尚未設定 LINE 機器人 Token, 機器人未連線 (控制台仍可使用)"); this.lineState = "未設定 Token"; return resolve(false); }
      this.logger?.addSecret(token);
      const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      this.ws = ws;
      const onErr = (e) => { this.connected = false; this.lineState = "連線失敗"; reject(e); };
      ws.once("error", onErr);
      ws.on("open", () => { this.connected = true; this.lineState = "已連線"; this.logger?.info("機器人", "已連上 LINE 核心 /api/ws", { url }); resolve(true); });
      ws.on("close", () => { this.connected = false; if (this.lineState === "已連線") this.lineState = "已斷線"; this.logger?.warn("機器人", "與 LINE 核心的連線已斷開"); });
      ws.on("error", (e) => this.logger?.error("機器人", "WebSocket 錯誤", { error: String(e?.message ?? e) }));
      ws.on("message", (data) => this.onFrame(data).catch((e) => this.logger?.error("機器人", "處理訊息失敗", { error: String(e?.message ?? e) })));
    });
  }
  disconnect() { try { this.ws?.close(); } catch {} this.ws = null; this.connected = false; this.registry.flush(); }

  sendFrame(obj) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj)); }
  async paceSend() {
    // 核心對機器人連線有每秒 5 則的硬上限; 送出端自我節流, 避免突發連發被拒 (RATE_LIMITED)
    const MIN_GAP = 220;
    const wait = (this.lastSendAt ?? 0) + MIN_GAP - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastSendAt = Date.now();
  }
  async sendText(chatId, text, replyTo) {
    await this.paceSend();
    return new Promise((resolve, reject) => {
      const requestId = `h${++this.reqSeq}-${Date.now()}`;
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("send timeout")); }, 10000);
      this.pending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
      this.sendFrame({ type: "message:send", requestId, chatId, text, ...(replyTo ? { replyTo } : {}) });
    });
  }

  // 向核心要一頁歷史訊息 (機器人 API 有開放 history:fetch); 只用在認定被引用訊息的寄件者。
  async fetchHistoryPage(chatId, before) {
    return new Promise((resolve, reject) => {
      const requestId = `h${++this.reqSeq}-${Date.now()}`;
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("history timeout")); }, 10000);
      this.pending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.sendFrame({ type: "history:fetch", requestId, chatId, limit: 100, ...(before ? { before } : {}) });
    });
  }

  // 被引用的訊息是不是機器人自己發的:
  // 先查登記簿 (收到的影格與自己的 sent 影格都有登記); 查不到才向核心要歷史補查 (最多 2 頁),
  // 歷史裡每則訊息都帶 senderId, 順便整頁補登記。查無此訊息時在登記簿留空字串記號, 避免每次引用都重查。
  async isQuotedSelf(m) {
    if (!m.replyTo || !this.selfId) return false;
    const known = this.registry.lookup(m.replyTo);
    if (known !== undefined) return known === this.selfId;
    if (!this.connected) return false;
    try {
      let cursor;
      for (let page = 0; page < 2; page++) {
        const frame = await this.fetchHistoryPage(m.channelId, cursor);
        const messages = Array.isArray(frame.messages) ? frame.messages : [];
        for (const hm of messages) {
          if (hm.messageId && hm.senderId) this.registry.register(hm.messageId, hm.senderId, hm.channelId ?? m.channelId);
        }
        const hit = messages.find((x) => x.messageId === m.replyTo);
        if (hit) return hit.senderId === this.selfId;
        if (!frame.hasMore || !frame.cursor) break;
        cursor = frame.cursor;
      }
      this.registry.register(m.replyTo, "", m.channelId ?? "");
      return false;
    } catch (e) {
      this.logger?.warn("觸發判斷", "引用訊息寄件者補查失敗, 本次不以引用觸發", { id: m.messageId, error: String(e?.message ?? e) });
      return false;
    }
  }

  async onFrame(data) {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    if (frame.type === "auth:ready") {
      this.selfId = frame.profile?.userId ?? "";
      this.selfName = frame.profile?.displayName ?? "";
      this.lineState = "已登入";
      return;
    }
    if (frame.type === "auth:state") { if (frame.state) this.lineState = frame.state; return; }
    // 自己送出的訊息: 核心在 sent 影格回新訊息的 messageId, 立刻登記為機器人本人,
    // 之後有人引用這則回答, 登記簿就認得出來 (引用續答觸發的認定主路徑)。
    if (frame.type === "sent" && frame.messageId && this.selfId) {
      this.registry.register(frame.messageId, this.selfId, "");
    }
    if (frame.requestId && this.pending.has(frame.requestId)) {
      const p = this.pending.get(frame.requestId);
      this.pending.delete(frame.requestId);
      if (frame.type === "error") p.reject(new Error(frame.code ?? "SEND_FAILED"));
      else p.resolve(frame); // sent / history 都走這裡
      return;
    }
    if (frame.type === "message") await this.onMessage(frame.message);
  }

  async onMessage(m) {
    if (!m || typeof m.text !== "string") return;
    const s = this.cfg();
    this.rollStats();
    this.logger?.info("訊息接收", "收到訊息", { id: m.messageId, chat: m.channelId, sender: m.senderId, len: m.text.length });
    this.logger?.logText("訊息接收", "訊息", m.text);
    // 每則看到的訊息都登記寄件者 (含機器人自己的): 之後被引用時才認得出來源
    if (m.messageId && m.senderId) this.registry.register(m.messageId, m.senderId, m.channelId ?? "");
    if (m.senderId === this.selfId) { this.logger?.debugLog("觸發判斷", "忽略自己發的訊息", { id: m.messageId }); return; }
    // 兩件事並行評估: 防詐騙自動掃描 + 名字觸發; 先處理觸發問答, 詐騙警告獨立進行
    const triggerPromise = this.handleTrigger(m, s);
    const scamPromise = this.handleAutoScam(m, s);
    await Promise.allSettled([triggerPromise, scamPromise]);
  }

  async handleAutoScam(m, s) {
    if (!s.scam.enabled) return;
    const pre = prefilterScam(m.text);
    if (!pre.hit) { this.logger?.debugLog("防詐騙", "預篩未命中, 不送判讀", { id: m.messageId }); return; }
    this.scamLimiter.limit = s.scam.perMinute ?? 10;
    if (!this.scamLimiter.tryTake()) { this.logger?.warn("防詐騙", "判讀次數達每分鐘上限, 本則略過", { id: m.messageId }); return; }
    this.logger?.info("防詐騙", "預篩命中, 送 AI 判讀", { id: m.messageId, rules: pre.rules });
    const verdict = await this.judge(m.text);
    this.stats.scamChecked++;
    this.logger?.info("防詐騙", "判讀完成", { id: m.messageId, probability: verdict.probability, tactic: verdict.tactic, fallback: !!verdict.fallback, warned: verdict.probability >= s.scam.threshold });
    if (verdict.probability >= s.scam.threshold) {
      this.stats.scamWarned++;
      await this.sendText(m.channelId, scamWarningText({ ...verdict, botName: s.botName }), m.messageId).catch((e) => this.logger?.error("防詐騙", "警告送出失敗", { error: String(e?.message ?? e) }));
    }
  }

  async judge(text) {
    const s = this.cfg();
    if (s.scam.jev?.enabled) this.logger?.warn("防詐騙", "Jev 選項已開啟但假資料版尚未接 Jev API, 改用所選 AI 判讀");
    const { cfg, key } = await this.providerWithKey(s.ai.active);
    return judgeScam({ text, aiChat: (args) => this.ai.chat(args), providerCfg: { baseUrl: cfg.baseUrl, model: cfg.model }, apiKey: key, logger: this.logger });
  }

  async handleTrigger(m, s) {
    // 引用續答: 引用的是機器人自己的訊息時, 視同被名字觸發 (認定方式見 isQuotedSelf)
    const quotedSelf = m.replyTo ? await this.isQuotedSelf(m) : false;
    const verdict = evaluateTrigger({ text: m.text, senderId: m.senderId, selfId: this.selfId, settings: s, state: this.triggerState, quotedSelf });
    this.logger?.info("觸發判斷", verdict.triggered ? "命中觸發" : "未觸發", { id: m.messageId, reason: verdict.reason, name: verdict.matchedName || "", quote: m.replyTo ? (quotedSelf ? "self" : "other") : "" });
    if (!verdict.triggered) {
      if (verdict.limitReached) {
        const last = this.triggerState.limitNoticeByUser.get(m.senderId) ?? 0;
        if (Date.now() - last > 3600000) {
          this.triggerState.limitNoticeByUser.set(m.senderId, Date.now());
          await this.sendText(m.channelId, limitText(s.botName), m.messageId).catch(() => {});
        }
      }
      return;
    }
    markTriggered(this.triggerState, m.senderId);
    this.stats.triggered++;
    if (verdict.reason === "name_only") {
      await this.sendText(m.channelId, guidanceText(s.botName), m.messageId).catch(() => {});
      return;
    }
    const question = verdict.question;
    // 手動防詐騙判讀
    if (isManualScamAsk(question)) {
      const target = extractScamTarget(question) || m.text;
      this.scamLimiter.limit = s.scam.perMinute ?? 10;
      if (!this.scamLimiter.tryTake()) { await this.sendText(m.channelId, "判讀次數暫時到上限了, 請等一分鐘再問我。", m.messageId).catch(() => {}); return; }
      this.logger?.info("防詐騙", "手動判讀請求", { id: m.messageId, targetLen: target.length });
      const v = await this.judge(target);
      this.stats.scamChecked++;
      await this.sendText(m.channelId, scamVerdictText(v), m.messageId).catch(() => {});
      return;
    }
    // 知識庫優先
    const hits = this.kb ? this.kb.search(question, 3) : [];
    const companyLike = COMPANY_HINTS.some((h) => question.includes(h));
    this.logger?.info("知識庫", hits.length ? "知識庫命中" : "知識庫未命中", { id: m.messageId, chunks: hits.map((h) => h.chunkId) });
    if (!hits.length && companyLike) {
      await this.sendText(m.channelId, kbMissText(), m.messageId).catch(() => {});
      markAnswered(this.triggerState);
      this.stats.answered++;
      return;
    }
    const mem = this.memory.get(m.channelId) ?? [];
    const nameLine = s.botName ? `你的名字是「${s.botName}」, 同事這樣叫你時就是在叫你。` : "";
    const messages = [
      { role: "system", content: `${s.ai.systemPrompt}\n${nameLine}` },
      ...mem,
    ];
    if (hits.length) {
      const kbText = hits.map((h, i) => `片段${i + 1} (來源: ${h.file}):\n${h.text}`).join("\n\n");
      messages.push({ role: "user", content: `問題: ${question}\n\n以下是公司知識庫片段, 請優先依片段回答:\n${kbText}` });
    } else {
      messages.push({ role: "user", content: question });
    }
    let answer;
    try {
      const r = await this.chatWithAi(messages);
      answer = r.content;
    } catch (e) {
      this.logger?.error("機器人回覆", "AI 回答失敗, 回覆備援訊息", { error: String(e?.message ?? e) });
      answer = `不好意思, 我現在連不上 AI 服務 (${String(e?.message ?? e)})。下一步: 請管理員到控制台設定頁按「測試連線」確認 API Key 與網路, 或稍後再問我一次。`;
    }
    if (hits.length) {
      const sources = [...new Set(hits.map((h) => h.file))];
      answer += `\n\n(參考來源: ${sources.join("、")})`;
    }
    await this.sendText(m.channelId, answer, m.messageId).catch((e) => this.logger?.error("機器人回覆", "回覆送出失敗", { error: String(e?.message ?? e) }));
    const count = markAnswered(this.triggerState);
    this.stats.answered++;
    const turns = [...mem, { role: "user", content: question }, { role: "assistant", content: answer }].slice(-(s.ai.memoryTurns ?? 6) * 2);
    this.memory.set(m.channelId, turns);
    this.logger?.info("機器人回覆", "已回覆", { id: m.messageId, chars: answer.length, today: count, kbHits: hits.length });
  }
}
