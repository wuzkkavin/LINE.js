// 防詐騙: 本機規則預篩 (零成本) -> 命中才送 AI 判讀 (機率 + 手法); 解析失敗有規則備援。
export const SHORT_DOMAINS = ["bit.ly", "tinyurl.com", "t.ly", "reurl.cc", "lihi.cc", "lihi1.com", "goo.gl", "is.gd", "cutt.ly", "rb.gy", "s.id", "ppt.cc", "shorturl.at", "x.co"];
export const RISK_WORDS = ["解除分期", "分期付款設定錯誤", "匯款驗證", "驗證碼給我", "告訴我驗證碼", "飆股", "保證獲利", "穩賺不賠", "健保卡", "帳戶凍結", "凍結帳戶", "ATM操作", "操作ATM", "檢察官", "投資群組", "飆股群", "領取獎金", "中獎通知", "點數即將到期", "個資外洩", "監管帳戶", "視訊裸聊", "援交", "貸款代辦", "租借帳戶", "人頭帳戶", "高薪打工", "在家打字賺錢"];
const TACTIC_BY_WORD = [
  [/飆股|保證獲利|穩賺|投資群組/, "假投資/飆股群"],
  [/解除分期|分期付款|ATM操作|操作ATM/, "網購/解除分期付款"],
  [/檢察官|健保卡|帳戶凍結|監管帳戶|個資外洩/, "假冒機關/銀行/客服"],
  [/https?:\/\//, "釣魚連結"],
  [/驗證碼|匯款驗證/, "假冒機關/銀行/客服"],
  [/中獎|領取獎金|點數即將到期/, "中獎贈品"],
  [/貸款代辦/, "貸款代辦"],
  [/高薪打工|租借帳戶|人頭帳戶/, "求職打工/租借帳戶"],
];

export function prefilterScam(text) {
  const rules = [];
  const t = String(text ?? "");
  const urlMatch = /https?:\/\/[^\s]+/gi.test(t);
  if (urlMatch) rules.push("url");
  const lower = t.toLowerCase();
  if (SHORT_DOMAINS.some((d) => lower.includes(d))) rules.push("short_url");
  for (const w of RISK_WORDS) if (t.includes(w)) rules.push(`word:${w}`);
  return { hit: rules.length > 0, rules };
}

export function guessTactic(text) {
  for (const [re, tactic] of TACTIC_BY_WORD) if (re.test(text)) return tactic;
  return "其他";
}

// 規則備援判讀: 解析 AI 回應失敗時用
export function ruleFallbackJudge(text, rules) {
  let p = 0;
  if (rules.includes("url")) p += 0.3;
  if (rules.includes("short_url")) p += 0.25;
  p += Math.min(0.45, rules.filter((r) => r.startsWith("word:")).length * 0.18);
  return { probability: Math.min(0.97, Number(p.toFixed(2))), tactic: guessTactic(text), reason: "AI 判讀解析失敗, 改用本機規則估計", fallback: true };
}

export const SCAM_JUDGE_SYSTEM = "你是防詐騙判讀員。分析使用者貼上的訊息是不是詐騙。只能回覆 JSON, 不要加其他文字: {\"probability\": 0到1的小數, \"tactic\": \"手法類型\", \"reason\": \"一句白話理由\"}。手法類型從: 假投資、假冒機關、釣魚連結、網購分期、冒充親友、感情詐騙、求職打工、中獎贈品、貸款代辦、其他 選一個。";

export async function judgeScam({ text, aiChat, providerCfg, apiKey, logger }) {
  const { rules } = prefilterScam(text);
  try {
    const r = await aiChat({
      ...providerCfg, apiKey,
      messages: [
        { role: "system", content: SCAM_JUDGE_SYSTEM },
        { role: "user", content: `請判讀這則訊息:\n${text}` },
      ],
      temperature: 0, maxTokens: 300,
    });
    const m = /\{[\s\S]*\}/.exec(r.content);
    if (!m) throw new Error("no json");
    const parsed = JSON.parse(m[0]);
    const probability = Number(parsed.probability);
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("bad probability");
    return { probability, tactic: String(parsed.tactic ?? "其他"), reason: String(parsed.reason ?? ""), fallback: false, latencyMs: r.latencyMs };
  } catch (e) {
    logger?.warn("防詐騙", "AI 判讀失敗, 改用規則備援", { error: String(e?.message ?? e) });
    return ruleFallbackJudge(text, rules);
  }
}

// 每分鐘上限的滑動視窗
export class PerMinuteLimiter {
  constructor(limit = 10) { this.limit = limit; this.stamps = []; }
  tryTake(now = Date.now()) {
    this.stamps = this.stamps.filter((t) => now - t < 60000);
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(now);
    return true;
  }
  count() { const now = Date.now(); this.stamps = this.stamps.filter((t) => now - t < 60000); return this.stamps.length; }
}

const MANUAL_PATTERNS = [/這是詐騙嗎/, /是不是詐騙/, /是詐騙嗎/, /幫我看.*詐騙/, /詐騙.*嗎/, /這則.*真.*假/, /可疑訊息/];
export function isManualScamAsk(question) {
  return MANUAL_PATTERNS.some((re) => re.test(question));
}
// 從觸發問句抽出要判讀的原文: 取冒號後, 或去掉問句本身後的剩餘
export function extractScamTarget(question) {
  const q = String(question);
  const colon = Math.max(q.lastIndexOf(":"), q.lastIndexOf("："));
  if (colon >= 0 && q.slice(colon + 1).trim().length >= 6) return q.slice(colon + 1).trim();
  let rest = q;
  for (const re of MANUAL_PATTERNS) rest = rest.replace(re, "");
  rest = rest.replace(/^(幫我|請|判讀|看看|一下|\s|:|：|,|，)+/, "").trim();
  return rest.length >= 6 ? rest : "";
}

export function scamWarningText({ probability, tactic, reason, botName }) {
  const name = botName ? `(${botName}提醒)` : "(防詐騙提醒)";
  const pct = Math.round(probability * 100);
  return [
    `⚠️ 防詐騙警告${name}`,
    `上面那則訊息疑似詐騙: 機率約 ${pct}%, 手法像是「${tactic}」。`,
    reason ? `判讀理由: ${reason}` : "",
    "請先不要點連結、不要匯款、不要給驗證碼, 先向本人或該機關的官方電話查證。",
    "(這是 AI 判讀, 僅供參考, 不能當定論)",
  ].filter(Boolean).join("\n");
}
export function scamVerdictText({ probability, tactic, reason }) {
  const pct = Math.round(probability * 100);
  const band = probability > 0.8 ? "高度疑似詐騙" : probability <= 0.2 ? "不太像詐騙" : "無法確定, 請小心查證";
  return `判讀結果: 詐騙機率約 ${pct}% (${band}), 手法類型: ${tactic}。${reason ? `理由: ${reason}。` : ""}(僅供參考, 重要事項請向本人或機關查證)`;
}
