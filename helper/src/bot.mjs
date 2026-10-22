// 機器人主程式: 連 LINE.js 核心的 /api/ws, 串起 觸發 -> 知識庫優先 -> AI 回答, 以及防詐騙自動掃描。
// 名字一律取自設定 (botName / aliases), 本檔不寫死任何名字。
import WebSocket from "ws";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { evaluateTrigger, markAnswered, markTriggered, createTriggerState, localDateKey } from "./trigger.mjs";
import { MessageSenderRegistry } from "./msgregistry.mjs";
import { extractScamTarget, isManualScamAsk, judgeScam, prefilterScam, scamVerdictText, scamWarningText, PerMinuteLimiter } from "./scam.mjs";
import { SECRET_NAMES, DEFAULT_CREATOR_REPLY, DEFAULT_ROLE_PROMPT } from "./config.mjs";
import { matchNotifyRules, planTargets, NOTIFY_EVENT_KINDS } from "./adminnotify.mjs";
import { isValidJevToken } from "./jev.mjs";

const COMPANY_HINTS = ["公司", "華葳", "內部", "規定", "請假", "加班", "影印", "列印", "印表機", "分機", "會議室", "系統", "帳號申請", "福利", "薪資", "考勤", "打卡", "公文", "簽呈", "部門", "同仁", "總公司", "工務所"];

// Jev 手法分類 (核心 scam:result 的 tactic.kind) 對照本程式的中文手法名稱 (與核心 README 的對照一致)。
export const JEV_TACTIC_LABELS = {
  investment: "假投資/飆股群",
  impersonation: "假冒機關/銀行/客服",
  phishing: "釣魚連結",
  shopping: "網購/解除分期付款",
  friend: "冒充親友借錢",
  romance: "感情詐騙",
  job: "求職打工/租借帳戶",
  prize: "中獎贈品",
  loan: "貸款代辦",
  other: "其他",
};

// Jev 判讀失敗原因的白話分類: 只依核心回的通用代碼分類, 不把上游原文或例外字串帶進 log 與畫面。
export function classifyJevError(code) {
  switch (String(code ?? "")) {
    case "SCAM_CHECK_UNAVAILABLE": return "核心尚未啟用 Jev (金鑰可能還沒被核心載入, 請把 AI寶 完全結束再重新開啟)";
    case "SCAM_CHECK_FAILED": return "TypeSafe 判讀服務這次沒有判讀成功";
    case "UNKNOWN_CHAT": return "這個聊天室不在機器人可判讀的範圍內";
    case "INVALID_REQUEST": return "這則訊息不在核心可判讀的範圍內 (可能已被收回或不是文字訊息)";
    case "RATE_LIMITED": return "判讀次數超過每分鐘上限";
    case "TIMEOUT": return "判讀等太久 (逾時)";
    case "NOT_CONNECTED": return "機器人尚未連上核心";
    case "BAD_RESULT": return "核心回傳的判讀結果格式不正確";
    default: return "Jev 判讀連不上";
  }
}

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

// --- 回答範圍段落 (2026-10-21 老吳定案) ---
// settings.ai.scopePrompt 非空才組段落注入 system prompt; 清空 = 回傳空字串 = 不限制範圍。
// bot 每則訊息都以當下設定組裝 prompt (handleTrigger 的 s 為即時設定), 改值儲存後下一則即生效, 不需重連。
export function buildScopeSection(scopePrompt) {
  const v = typeof scopePrompt === "string" ? scopePrompt.trim() : "";
  return v ? `回答範圍 (務必遵守):\n${v}` : "";
}

// --- 回答符號強制清理 (2026-10-21 老吳追加) ---
// LINE 不渲染 Markdown, prompt 自律不可靠 (實機仍露出 ** 粗體符號), 改由程式在送出前強制清理:
// 移除 ** 與 __ 粗體標記、行首 # 標題符號改純文字 (保留內容)、表格分隔列整列移除、
// 其餘含 | 的行改用「・」分隔。只作用於送進群組的 AI 回答文字, 不動知識庫原文與 log。
export function cleanAnswerText(text) {
  if (typeof text !== "string") return text;
  const out = [];
  for (const rawLine of text.split("\n")) {
    let line = rawLine;
    // 表格分隔列 (只含 |、-、: 與空白, 且同時含 | 與 -) 整列刪除
    if (/^[\s|:-]+$/.test(line) && line.includes("|") && line.includes("-")) continue;
    // 行首標題符號 (#{1,6}) 移除, 保留文字內容
    line = line.replace(/^\s{0,3}#{1,6}\s*/, "");
    // 粗體標記移除 (保留文字內容)
    line = line.replace(/\*\*/g, "").replace(/__/g, "");
    // 表格資料列: 去掉頭尾的 |, 中間的 | 換成「・」
    if (line.includes("|")) {
      line = line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").replace(/\s*\|\s*/g, "・");
    }
    out.push(line);
  }
  return out.join("\n");
}

// --- 長回答交付 (2026-10-20 驗收修復, 老吳新規格) ---
// 群組回答的 AI 回覆額度: ai.mjs 的通用預設只有 1024 tokens, 中文一字約一 token,
// 稍長的條列回答就會被 finish_reason=length 切在半句 (實機長篇自我介紹即此症)。
// 2026-10-20 晚間再修訂: 4096 在 Groq 免費層的 OTPM (每分鐘輸出 token) 上限只有 1000,
// 單次 requested 就會破表被 429 (實機 Requested 922 已逼近)。改用 2048 兼顧長答覆,
// 且 ai.mjs 對 429 有退避重試並在重試時降額度 (見 ai.mjs), 長答覆仍可走文字檔交付。
export const ANSWER_MAX_TOKENS = 2048;
// LINE 友善格式規則 (第 13 項): LINE 不渲染 Markdown, 表格的 | 與 ** 粗體符號會原樣露出。
// 這段由程式附加在每次問答的 system prompt 尾端 (不是使用者可編輯欄位, 保證一定生效);
// 知識庫片段的回答走同一個 system prompt, 一併受此規則約束。
export const LINE_FORMAT_RULE = "回答格式規則 (LINE 訊息, 務必遵守): 不要使用 Markdown 表格, 不要使用 ### 之類的標題符號, 不要使用 ** 粗體符號; 需要條列時用「・」開頭或數字編號, 一項一行; 適度分段, 每段不要太長, 讓同事在手機上好讀。";
// 一則文字訊息可送的字數上限: 核心 message:send 的 textMaxLength 預設 8000 字
// (核心 src/config.ts 與 config.example.yaml), 超過會被核心直接拒收 (INVALID_REQUEST),
// 以前就是整則回答默默消失。超過這個字數改走文字檔交付 (老吳 2026-10-20 新規格)。
export const TEXT_SEND_LIMIT = 8000;
// 文字檔的位元組上限: 核心機器人檔案影格的上限同值 (核心 src/ws/requests.ts MAX_BOT_FILE_BYTES),
// 要留在 WS 影格大小 (frameMaxBytes 256KB, base64 後約 175KB) 的安全範圍內。
export const FILE_SEND_MAX_BYTES = 128 * 1024;

// 回答檔名: AI寶回答-<日期>-<主題>.txt; 主題取問題前幾個字, 去掉檔名不允許的字元與空白。
export function answerFilename(question, now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const topic = String(question ?? "").replace(/[\\/:*?"<>|\s]+/g, "").slice(0, 10);
  return topic ? `AI寶回答-${date}-${topic}.txt` : `AI寶回答-${date}.txt`;
}

// 超長文字分段 (文字檔也送不出去時的最後手段): 優先在段落/換行邊界切, 每段不超過 limit 字;
// 真的必須硬切時以 Unicode 字元為單位, 不切斷代理對 (surrogate pair)。
export function splitLongText(text, limit = TEXT_SEND_LIMIT) {
  const chunks = [];
  let rest = String(text ?? "");
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"));
    if (cut < Math.floor(limit * 0.5)) cut = -1; // 換行點太靠前就不採用, 改硬切
    if (cut <= 0) {
      cut = limit;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // 不切斷代理對 (emoji 等)
    }
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.filter((c) => c.length);
}

// --- 創造者意圖判定 (修復批次一, 第 2 項) ---
// 命中就直接回 settings.creatorReply, 不呼叫 AI。判定分兩層, 目的是降低誤觸:
// 1. 「版權 / copyright」是強訊號: 在跟機器人的對話裡問版權, 幾乎就是問機器人本身, 直接命中。
// 2. 其他創造者關鍵詞 (誰開發、作者是誰…) 太常見, 必須同時提到機器人本身才命中:
//    機器人名字/別名、你、這個機器人、此機器人、機器人。主詞是外部事物時不命中,
//    例如「Excel 是誰開發的」「這份文件作者是誰」都不命中 (名字觸發時名字會先被去掉再進來判定)。
// 已知取捨: 若使用者對機器人說「你知道 Excel 是誰開發的嗎」, 因為有「你」會被當成問機器人本身而命中,
// 這是刻意接受的取捨 (在群組裡對機器人說話, 「你」多半就是指機器人); 沒有「你」與名字的外部主詞問句則不會誤觸。
const CREATOR_KEYWORDS = ["誰創造的", "誰創造", "創造者", "誰做的", "誰開發", "開發者", "作者是誰", "誰寫的", "你的主人", "誰發明"];
const COPYRIGHT_KEYWORDS = ["版權", "copyright"];
const BOT_REF_WORDS = ["你", "這個機器人", "此機器人", "這台機器人", "機器人"];
export function isCreatorIntent(text, settings = {}) {
  if (typeof text !== "string" || !text.trim()) return false;
  const lower = text.toLowerCase();
  if (COPYRIGHT_KEYWORDS.some((k) => lower.includes(k))) return true;
  if (!CREATOR_KEYWORDS.some((k) => lower.includes(k))) return false;
  const names = [settings.botName, ...(settings.aliases ?? [])].filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
  if (names.some((n) => text.includes(n))) return true;
  return BOT_REF_WORDS.some((w) => text.includes(w));
}

// --- 機器人人設 (修復批次一, 第 3 項) ---
// 年紀由出生日自動計算; today 可注入供測試 (預設今天)。
export function calculateAge(birthdate, today = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(birthdate ?? "").trim());
  if (!m) return null;
  const by = Number(m[1]), bm = Number(m[2]), bd = Number(m[3]);
  const probe = new Date(by, bm - 1, bd);
  if (probe.getFullYear() !== by || probe.getMonth() !== bm - 1 || probe.getDate() !== bd) return null; // 不是真實日期 (如 2 月 30 日)
  let age = today.getFullYear() - by;
  const tm = today.getMonth() + 1, td = today.getDate();
  if (tm < bm || (tm === bm && td < bd)) age--; // 今年生日還沒到
  return age >= 0 ? age : null;
}

// 組出注入 system prompt 的人設段落: 非空欄位逐項寫入, 並附誠實回答規則 (空欄位說還沒設定, 不得編造)。
export function buildPersonaSection(persona, today = new Date()) {
  const p = persona ?? {};
  const val = (k) => (typeof p[k] === "string" ? p[k].trim() : "");
  const items = [];
  if (val("birthdate")) {
    const age = calculateAge(val("birthdate"), today);
    items.push(`出生日: ${val("birthdate")}${age !== null ? ` (目前 ${age} 歲)` : ""}`);
  }
  if (val("gender")) items.push(`性別: ${val("gender")}`);
  if (val("zodiac")) items.push(`星座: ${val("zodiac")}`);
  if (val("measurements")) items.push(`三圍: ${val("measurements")}`);
  if (val("interests")) items.push(`興趣: ${val("interests")}`);
  if (val("maritalStatus")) items.push(`婚姻狀態: ${val("maritalStatus")}`);
  if (val("intro")) items.push(`自我介紹: ${val("intro")}`);
  const lines = ["你的個人設定:"];
  if (items.length) lines.push(...items.map((i) => `- ${i}`));
  else lines.push("(目前沒有填寫任何個人設定)");
  lines.push("回答規則: 被問到年紀、生日、星座、性別、三圍、興趣、婚姻狀態、身世或自我介紹時, 只能照上面的個人設定回答; 上面沒有寫到的欄位, 就誠實說「這部分我還沒有設定」, 不可以自己編造數字或內容。");
  return lines.join("\n");
}

// 引用補查深度 (修復批次一, 第 6 項): 每頁 100 則 (核心 history:fetch 上限), 舊版只查 2 頁 (200 則),
// 熱鬧群組裡機器人稍早的回答很快被新訊息推過 200 則之外, 引用續答就失效。改為 5 頁 (500 則),
// 命中或沒有下一頁 (hasMore=false) 就早停, 不會每次都查滿; 核心對 history 有每秒 10 次限流, 5 頁仍在預算內。
export const QUOTE_HISTORY_PAGES = 5;
// 連線成功後主動補登的頁數: 3 頁 (300 則) 涵蓋離線期間與重啟前的近期訊息, 成本可控。
export const HISTORY_PREFETCH_PAGES = 3;

// --- 訊息解密健康偵測 (2026-10-21 第二段, 事故定案後的誠實顯示) ---
// 事故: 群組成員變動後 LINE 換了該群組的 E2EE 共用鑰匙世代, 核心手上的寄件者公鑰快取
// 與寄件者端脫節 (乙機制: 快取毒化、核心無失效邏輯), 該寄件者的訊息在核心解密階段
// 就被靜默丟棄 — 不發事件、不留紀錄, 機器人與所有狀態燈卻全綠 (假綠燈)。
// helper 在即時路徑對此零可見性 (解密失敗的訊息根本沒有影格送達), 唯一不改核心就能
// 落地的偵測面是 history:fetch 回的 DTO: 解不開的文字訊息帶 decryptFailed: true。
// 作法: 每 DECRYPT_SCAN_INTERVAL_MS 對白名單聊天室各抓最近一頁歷史 (一頁 = fetchHistoryPage
// 的 100 則), 統計 decryptFailed。核心 history 限流是每連線每秒 10 次, 本掃描每聊天室
// 每分鐘才 1 次, 與引用補查/補登共用預算綽綽有餘; 掃描失敗 (逾時等) 只退避, 不誤報、
// 不把上次狀態洗掉。
export const DECRYPT_SCAN_INTERVAL_MS = 60_000;
// 掃描連續失敗時的退避倍率上限 (間隔 ×2、×4、×8 封頂), 任一輪成功就歸零。
export const DECRYPT_SCAN_MAX_BACKOFF = 8;

// --- 訊息漏接偵測 (2026-10-21 第二段追加, 事故擴大後的新訊號) ---
// 事故擴大實錄: 起初只有老吳一人的訊息解密失敗, 約 20 分鐘後同群其他成員的
// 明確提問也不再成為機器人事件 (另一群組同時正常)。第一段查證 §1.4 的機制可解釋:
// 每筆解密失敗都觸發核心監聽重啟 (退避至 30 秒), 連續失敗疑使監聽陷入重啟循環
// 或卡死, 連本來解得開的訊息也不再推送。這種「整個群組變聾」用 decryptFailed
// 計數看不到 (漏掉的訊息本身是好的), 要靠比對歷史與事件的落差:
// 訊息已進聊天室歷史、超過寬限時間, 卻從未以事件送達機器人 = 漏接。
// 判準 (保守, 防誤報): 非解密失敗、非自己發送、有文字內容 (貼圖/照片不列入,
// 避免機器人通道不推播某些類型時誤報)、非系統事件、非收回訊息、在本次連線
// 開通後才出現 (斷線期間的訊息核心本來就不補送, 不算漏接)、出現已超過
// DECRYPT_MISSED_GRACE_MS (事件正常是秒級送達), 且同聊天室累積
// DECRYPT_MISSED_MIN_COUNT 則才點燈 (單則可能是罕見競態)。
export const DECRYPT_MISSED_GRACE_MS = 120_000;
export const DECRYPT_MISSED_MIN_COUNT = 2;
// 每聊天室記住的「已收到事件」訊息 ID 上限 (漏接比對用; 只存 ID, 不存內容)。
export const DECRYPT_SEEN_IDS_CAP = 300;

export class HelperBot {
  constructor({ settings, secrets, ai, kb, logger, registry, reconnectDelaysMs, dailyStatePath = "", decryptMissedOptions, adminEvents = null } = {}) {
    this.settings = settings; // SettingsStore
    this.secrets = secrets;
    this.ai = ai;
    this.kb = kb;
    this.logger = logger;
    // 訊息寄件者登記簿: 認定被引用的訊息是不是機器人自己發的 (引用續答觸發用)
    this.registry = registry ?? new MessageSenderRegistry({ logger });
    // 管理員通知的事件紀錄 (第四階段): bot 只負責「發生事件 -> 決策/記錄」, 實際送出由 App 殼走瀏覽器通道。
    // adminEvents 未注入時 (單元測試/舊進入點) 通知功能自動停用, 不影響問答主線。
    this.adminEvents = adminEvents;
    // 各聊天室近期發言者 (管理員候選名單 + @ 可行性判斷): chatId -> Map<senderId, { name, lastAt }>
    // 只存記憶體 (重啟清空); 名稱取訊息自帶的 senderName, 不另外查核心。
    this.chatSpeakers = new Map();
    this.triggerState = createTriggerState();
    this.scamLimiter = new PerMinuteLimiter(10);
    this.memory = new Map(); // chatId -> [{role, content}]
    this.ws = null;
    this.selfId = "";
    this.selfName = "";
    this.connected = false;
    this.lineState = "未連線";
    // 連線韌性: wantConnected 表示「應該保持連線」(有 Token 且未被要求斷線)。
    // 核心在 Token 換發時會立刻踢掉所有機器人連線 (上游硬規則), 也可能因重啟/網路斷線;
    // 只要 wantConnected 為真, 斷線就以退避間隔自動重連, 不再一次失敗就永久離線
    // (2026-10-20 老吳實機: 換 Token 後 bot 被踢線且無人重連, 總覽還看不出來)。
    this.wantConnected = false;
    this.intentionalClose = new WeakSet(); // 被主動關閉的 socket: 其 close 事件不觸發重連排程
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.reconnectDelaysMs = reconnectDelaysMs ?? [1000, 2000, 5000, 10000, 30000];
    this.connectInFlight = null;
    this.pending = new Map();
    this.reqSeq = 0;
    // 引用續答加固 (第 6 項): 核心送來的白名單聊天室清單與「連線後主動補登歷史」的進度。
    // 補登目的: 離線/重啟期間機器人自己發過的訊息不在登記簿裡, 重連後先主動把近期歷史補登,
    // 同事引用那些回答追問時第一時間就認得出來, 不必等引用當下才向核心補查。
    this.botChats = []; // 白名單聊天室 ID (由核心 channels 影格提供)
    this.chatNames = new Map(); // chatId -> 顯示名稱 (活動面板用; 同樣來自 channels 影格)
    this.historyPrefetchedChats = new Set(); // 本次連線已補登過的聊天室 (重連時清空重補)
    this.historyPrefetchInFlight = new Set();
    this.stats = { date: "", answered: 0, triggered: 0, scamChecked: 0, scamWarned: 0, scamScanned: 0 };
    // Jev 接通狀態 (2026-10-21 真接通): 誠實原則 — 只有真的收到過核心 scam:result 才准說 ok。
    // unconfigured = 沒啟用或還沒存金鑰; unverified = 已啟用且有金鑰, 但這次啟動還沒成功判讀過;
    // ok = 已成功判讀 (jevLastOkAt 為最近一次的 ISO 時間); error = 最近一次 Jev 判讀失敗、已退回 AI
    // (jevLastError 是白話分類, 不含上游原文)。jevKeyPrint 是「啟用+金鑰末4碼+模型」的指紋,
    // 換金鑰或改設定後狀態要回到 unverified, 不拿舊的成功紀錄冒充新金鑰已通。
    this.jevState = "unconfigured";
    this.jevLastOkAt = null;
    this.jevLastError = "";
    this.jevKeyPrint = "";
    // 核心版本 (第 14 項): 連線時核心 hello 影格的 serverVersion (核心自己的版本回報,
    // 來源是核心 package.json, 不寫死); 總覽與關於頁顯示用。
    this.coreVersion = "";
    // 訊息解密健康 (2026-10-21 第二段): 定期掃描白名單聊天室近期歷史的 decryptFailed 統計,
    // 只存記憶體 (不落盤、不記訊息內容 — 解不開的本來也沒有內容)。
    // decryptByChat: chatId -> { failed, scanned, lastFailAt (ISO), lastFailTime (本機 HH:MM),
    // senders: [寄件者顯示名稱] }。decryptLastScanAt 為最近一輪完整掃描完成的時間;
    // 還沒掃過任何一輪時 summary 的 state 是 unknown, 不准冒充正常 (誠實原則同 Jev)。
    this.decryptByChat = new Map();
    // 即時解密活狀態 (2026-10-22 修復): chatId -> { lastOkAt, lastFailAt } (epoch ms)。
    // 為什麼需要它: 歷史掃描看到的 failed 混著「舊世代不可復原的歷史訊息」與「現在真的
    // 讀不到」; 2026-10-21 事故群復原後即時訊息明明可解可回, 卻被 100 則窗內的舊壞訊息
    // 永久標成異常, 連發送都被護欄擋下。活狀態只認即時事件: 最後一次即時失敗之後
    // 有沒有即時成功 — 有 = 群是活的, 歷史壞訊息只提示、不擋事 (見 decryptSummary 的 blocking)。
    this.decryptLiveByChat = new Map();
    this.decryptLastScanAt = null;
    this.decryptScanTimer = null;
    this.decryptScanInFlight = false;
    this.decryptScanFailures = 0; // 連續失敗輪數 (退避用)
    // 訊息漏接偵測 (同批追加): decryptMissedByChat: chatId -> { missed, newestMissedAt, newestMissedTime };
    // seenEventIds: chatId -> Set<messageId>, 只記真的從機器人 WS 送達過的事件 (歷史補登不算,
    // 那正是要比對的落差); eventsLiveSince: 本次連線開通的時間, 漏接只看這之後出現的訊息。
    this.decryptMissedByChat = new Map();
    this.seenEventIds = new Map();
    this.eventsLiveSince = 0;
    this.decryptMissedOptions = {
      graceMs: DECRYPT_MISSED_GRACE_MS, // 事件寬限: 出現超過這個時間還沒送達才算漏接
      liveBufferMs: 5_000, // 連線開通後的小緩衝, 開通瞬間前後的訊息不列入
      minCount: DECRYPT_MISSED_MIN_COUNT, // 同聊天室累積幾則才點燈
      ...(decryptMissedOptions ?? {}),
    };
    // 機器人活動紀錄 (第 12 項): 只存記憶體環形緩衝 (最近 50 筆, 重啟清空, 永不落盤)。
    // 隱私紅線: 問題文字只留前 30 字片段, 且只存在這個陣列裡; log 檔不寫問題全文 (既有規格)。
    this.activity = [];
    // 每日計數持久化 (第 9 項審計修復): 舊版每日上限計數只在記憶體, App/引擎每次重啟就歸零,
    // 「每日」上限形同分段計算。改存小 JSON (日期/已答數/防詐數), 啟動時載入當日值。
    this.dailyStatePath = dailyStatePath;
    this.loadDailyState();
  }

  loadDailyState() {
    if (!this.dailyStatePath) return;
    try {
      const raw = JSON.parse(readFileSync(this.dailyStatePath, "utf8"));
      if (raw && raw.date === localDateKey()) {
        this.triggerState.daily = { date: raw.date, count: Number(raw.dailyCount) || 0 };
        this.stats = { date: raw.date, answered: Number(raw.answered) || 0, triggered: Number(raw.triggered) || 0, scamChecked: Number(raw.scamChecked) || 0, scamWarned: Number(raw.scamWarned) || 0, scamScanned: Number(raw.scamScanned) || 0 };
      }
    } catch { /* 檔案不存在或損壞: 從零開始, 不擋啟動 */ }
  }

  persistDaily() {
    if (!this.dailyStatePath) return;
    try {
      mkdirSync(dirname(this.dailyStatePath), { recursive: true });
      writeFileSync(this.dailyStatePath, JSON.stringify({
        date: this.triggerState.daily.date || localDateKey(),
        dailyCount: this.triggerState.daily.count,
        answered: this.stats.answered, triggered: this.stats.triggered,
        scamChecked: this.stats.scamChecked, scamWarned: this.stats.scamWarned, scamScanned: this.stats.scamScanned,
      }), "utf8");
    } catch { /* 寫入失敗不影響服務; 計數退回記憶體模式 */ }
  }

  // 活動紀錄一筆 (第 12 項): kind 見 activitySnapshot 的白話對照; question 只留前 30 字。
  // answerText (2026-10-21): 已回答事件附回答全文供管理介面查閱; 只存記憶體環形緩衝
  // (不落盤、重啟清空, 與 question 同隱私規格), 超過 2000 字截斷並以 answerTruncated 註明。
  recordActivity({ kind, m, answerChars = null, ms = null, detail = "", answerText = null }) {
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    let answer = null;
    let answerTruncated = false;
    if (typeof answerText === "string" && answerText.length) {
      answerTruncated = answerText.length > 2000;
      answer = answerTruncated ? answerText.slice(0, 2000) : answerText;
    }
    this.activity.unshift({
      at: now.toISOString(),
      // 本機時間字串 (使用者時區): App 面板直接顯示, 不必在殼端做時區換算
      time: `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`,
      kind,
      chatId: m?.channelId ?? "",
      chatName: this.chatNames.get(m?.channelId) ?? "",
      senderName: m?.senderName ?? "",
      question: typeof m?.text === "string" ? m.text.slice(0, 30) : "",
      answerChars, ms, detail,
      answer, answerTruncated,
    });
    if (this.activity.length > 50) this.activity.length = 50;
  }

  activitySnapshot() {
    return [...this.activity];
  }

  // 記下「誰在這個聊天室說過話」: 管理員候選名單與「@ 不 @ 得到」的判斷都靠這份資料。
  noteSpeaker(m) {
    if (!m?.channelId || !m?.senderId) return;
    let chat = this.chatSpeakers.get(m.channelId);
    if (!chat) { chat = new Map(); this.chatSpeakers.set(m.channelId, chat); }
    const prev = chat.get(m.senderId);
    chat.set(m.senderId, { name: (typeof m.senderName === "string" && m.senderName) || prev?.name || "", lastAt: Date.now() });
    if (chat.size > 200) { // 只留近期發言者, 避免長跑無限長大 (候選名單本來就只需要近期的人)
      const oldest = [...chat.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt)[0];
      if (oldest) chat.delete(oldest[0]);
    }
  }

  // 管理員通知: 事件發生 -> 在這裡組白話本文、決定通知誰與用 @ 還是寫名字、寫進事件紀錄。
  // 真正把訊息送進群組的是 App 殼 (瀏覽器通道, 每隔一段時間來領「還沒送出的待通知」);
  // 這裡不直接送, 是因為 @ 的可行性與送出都在殼端那條通道上驗證 (規格分工定案)。
  raiseAdminEvent(kind, { chatId = "", chatName = "", detail = "", text = "", keyword = "" } = {}) {
    if (!this.adminEvents) return;
    try {
      const s = this.cfg();
      const notify = s.notify ?? { admins: [], rules: [] };
      const rules = matchNotifyRules(notify, kind, { text });
      if (!rules.length) return;
      // 多筆規則命中時合併對象: 任一筆沒勾人 = 通知全部管理員 (planTargets 的既有語意)
      const union = new Set();
      let notifyAll = false;
      for (const r of rules) {
        const ids = Array.isArray(r.notifyAdminIds) ? r.notifyAdminIds : [];
        if (!ids.length) notifyAll = true;
        for (const id of ids) union.add(id);
      }
      const mergedRule = { notifyAdminIds: notifyAll ? [] : [...union] };
      // @ 可行性: 有在這個聊天室發言紀錄 = hasSpoken true; 完全查不到這個聊天室的發言紀錄時
      // 不給 presence (planTargets 預設可 @, 送出端真的被核心擋下時殼端會改用寫名字並註明)。
      const speakers = this.chatSpeakers.get(chatId);
      const presence = {};
      if (speakers) {
        for (const a of notify.admins ?? []) presence[a.id] = { hasSpoken: speakers.has(a.id) };
      }
      const targets = planTargets({ rule: mergedRule, admins: notify.admins ?? [], presence });
      const now = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      const timeText = `${p2(now.getHours())}:${p2(now.getMinutes())}`;
      const label = NOTIFY_EVENT_KINDS[kind]?.label ?? "通知";
      const where = chatName ? `『${chatName}』` : "群組";
      const message = `${label}：${where}${detail}（${timeText}）`;
      const r = this.adminEvents.record({ kind, chatId, chatName, detail: keyword ? `關鍵字「${keyword}」` : detail, targets, message });
      if (r.action === "notify") {
        this.logger?.info("管理員通知", "已記錄待通知事件, 等 App 送出", { kind, chat: chatId, targets: targets.length });
      } else {
        this.logger?.debugLog("管理員通知", "事件只寫進紀錄, 不另行通知", { kind, chat: chatId, reason: r.reason });
      }
    } catch (e) {
      // 通知是旁路功能: 任何錯誤都不能影響問答主線, 只留 log
      this.logger?.warn("管理員通知", "記錄事件時發生錯誤, 已略過", { kind, error: String(e?.message ?? e) });
    }
  }

  // 關鍵字規則掃描: 每則真人訊息都比對 (規則沒設定時 matchNotifyRules 直接回空, 成本可忽略)。
  checkKeywordRules(m) {
    if (!this.adminEvents || !m?.text) return;
    const notify = this.cfg().notify ?? { admins: [], rules: [] };
    const matched = matchNotifyRules(notify, "keyword", { text: m.text });
    if (!matched.length) return;
    const kw = typeof matched[0].keyword === "string" ? matched[0].keyword.trim() : "";
    this.raiseAdminEvent("keyword", {
      chatId: m.channelId, chatName: this.chatNames.get(m.channelId) ?? "",
      detail: `有人提到「${kw}」, 請管理員留意。`, text: m.text, keyword: kw,
    });
  }

  // 向核心查 OpenChat 的管理員 (只有社群聊天室有; 一般群組核心會回錯誤, 呼叫端忽略即可)。
  async queryChatAdmins(chatId) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("NOT_CONNECTED");
    return new Promise((resolve, reject) => {
      const requestId = `h${++this.reqSeq}-${Date.now()}`;
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("TIMEOUT")); }, 8000);
      this.pending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.sendFrame({ type: "chat:admins:get", requestId, chatId });
    });
  }

  // 管理員候選名單: ① 白名單群組近期發言者 (noteSpeaker 累積) ② OpenChat 管理員查詢。
  // 回 [{ id, name, chats: [聊天室名], source }] — 殼端「管理員名單」勾選清單的來源, 不用手打代號。
  async adminCandidates() {
    const byId = new Map();
    const add = (id, name, chatName, source) => {
      if (!id) return;
      const cur = byId.get(id) ?? { id, name: "", chats: [], source };
      if (name) cur.name = name;
      if (chatName && !cur.chats.includes(chatName)) cur.chats.push(chatName);
      if (source === "openchat-admin") cur.source = "openchat-admin";
      byId.set(id, cur);
    };
    for (const [chatId, speakers] of this.chatSpeakers) {
      const chatName = this.chatNames.get(chatId) ?? "";
      for (const [id, info] of speakers) add(id, info.name, chatName, "speaker");
    }
    if (this.connected) {
      for (const chatId of [...this.botChats]) {
        try {
          const frame = await this.queryChatAdmins(chatId);
          const chatName = this.chatNames.get(chatId) ?? "";
          for (const a of frame?.admins ?? []) add(a.userId, a.displayName ?? "", chatName, "openchat-admin");
        } catch { /* 不是 OpenChat 或查不到: 略過, 發言者來源已涵蓋 */ }
      }
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  cfg() { return this.settings.get(); }
  rollStats() {
    const d = localDateKey();
    if (this.stats.date !== d) this.stats = { date: d, answered: 0, triggered: 0, scamChecked: 0, scamWarned: 0, scamScanned: 0 };
  }
  status() {
    this.rollStats();
    const s = this.cfg();
    return {
      connected: this.connected,
      // botConnected 與 connected 同值, 欄位名講清楚「這是機器人與核心的連線, 不是帳號登入狀態」;
      // 總覽要把「LINE 已登入 (核心 session)」與「機器人已連線 (bot WS)」分開顯示, 避免斷線看不出來。
      botConnected: this.connected,
      reconnecting: this.reconnectTimer != null,
      lineState: this.lineState,
      selfName: this.selfName,
      botName: s.botName,
      aiActive: s.ai.active,
      aiModel: s.ai.providers[s.ai.active]?.model ?? "",
      kb: this.kb ? this.kb.status() : null,
      scam: {
        enabled: s.scam.enabled, threshold: s.scam.threshold, checkedToday: this.stats.scamChecked, warnedToday: this.stats.scamWarned, scannedToday: this.stats.scamScanned,
        // Jev 誠實狀態 (防詐騙頁顯示用): state 四態 + 最近成功時間 + 最近失敗的白話原因
        jevState: this.jevState, jevLastOkAt: this.jevLastOkAt, jevLastError: this.jevLastError,
      },
      answeredToday: this.stats.answered,
      // 訊息解密健康 (2026-10-21 第二段): 近期歷史裡有沒有核心解不開的訊息。
      // state: unknown (尚未掃描) / ok / failed; failed 時 issues 逐聊天室列出
      // 名稱、失敗則數、最近失敗時間與寄件者 — 總覽與一鍵修復據此誠實點燈,
      // 不再像事故當下那樣全綠假裝正常。
      decrypt: this.decryptSummary(),
      // 第 14 項: 核心實際版本 (hello 影格的 serverVersion; 未連線時為空字串, 介面顯示「—」)
      coreVersion: this.coreVersion,
      // 第 12 項面板: 今日已回答 / 每日上限要成對顯示
      dailyLimit: s.dailyLimit,
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
  async chatWithAi(messages, { temperature = 0.3, maxTokens } = {}) {
    const s = this.cfg();
    const order = [s.ai.active, ...Object.keys(s.ai.providers).filter((p) => p !== s.ai.active)];
    const tries = s.ai.fallback ? order : [s.ai.active];
    let lastErr;
    for (const pid of tries) {
      try {
        const { cfg, key } = await this.providerWithKey(pid);
        const started = Date.now();
        const r = await this.ai.chat({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: key, messages, temperature, ...(maxTokens ? { maxTokens } : {}) });
        this.logger?.info("AI", "AI 回答完成", { provider: pid, model: cfg.model, ms: Date.now() - started, chars: r.content.length, finishReason: r.finishReason ?? "" });
        // finish_reason=length = 回答被 AI 的回覆額度硬生生切斷 (舊預設 1024 tokens, 中文長答覆很容易撞到,
        // 2026-10-20 實機的長篇自我介紹就是停在半句)。額度已加大 (ANSWER_MAX_TOKENS), 真的還撞到要在
        // log 留下明確紀錄, 不能讓截斷無聲無息混進群組。
        if (r.finishReason === "length") {
          this.logger?.warn("AI", "AI 回答達到回覆額度上限, 內容可能被截斷", { provider: pid, model: cfg.model, chars: r.content.length, maxTokens: maxTokens ?? null });
        }
        return { ...r, provider: pid };
      } catch (e) {
        lastErr = e;
        // 原始細節 (detail: URL/狀態碼/上游原文) 只進 log, 不進任何回給使用者的訊息
        this.logger?.warn("AI", "AI 呼叫失敗", { provider: pid, error: String(e?.message ?? e), detail: e?.detail ? String(e.detail) : undefined });
        if (!s.ai.fallback) break;
      }
    }
    throw lastErr;
  }

  // 對外連線入口: 有 Token 就連, 並記住「應該保持連線」; 連不上不丟例外, 回 false 並排自動重試。
  async connect() {
    const token = this.secrets ? await this.secrets.get(SECRET_NAMES.lineToken) : null;
    if (!token) {
      this.wantConnected = false;
      this.logger?.warn("機器人", "尚未設定 LINE 機器人 Token, 機器人未連線 (控制台仍可使用)");
      this.lineState = "未設定 Token";
      return false;
    }
    this.wantConnected = true;
    const ok = await this.openSocket();
    if (!ok) this.scheduleReconnect();
    return ok;
  }

  // 開一條新 WS 連線並等它開通/失敗; 每次嘗試都重讀 Token (換發後排程中的重試會自動用新 Token 自癒)。
  // 同時只允許一條在途連線; 已開通就直接回 true。socket 事件一律先確認還是不是目前這條,
  // 避免舊 socket 的遲到 close 把新連線的狀態打掉 (換 Token 重連時最容易踩到)。
  openSocket() {
    if (this.connectInFlight) return this.connectInFlight;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) { this.connected = true; return Promise.resolve(true); }
    const run = (async () => {
      const token = this.secrets ? await this.secrets.get(SECRET_NAMES.lineToken) : null;
      if (!token) { this.lineState = "未設定 Token"; return false; }
      this.logger?.addSecret(token);
      const url = this.cfg().lineApiUrl;
      return await new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
        this.ws = ws;
        ws.on("open", () => {
          this.connected = true;
          this.eventsLiveSince = Date.now(); // 漏接偵測的起算點: 只看本次連線開通後出現的訊息
          this.lineState = "已連線";
          this.reconnectAttempt = 0;
          this.historyPrefetchedChats.clear(); // 新連線: 離線期間的訊息要重新補登
          this.logger?.info("機器人", "已連上 LINE 核心 /api/ws", { url });
          done(true);
        });
        ws.on("error", (e) => {
          this.logger?.error("機器人", "WebSocket 錯誤", { error: String(e?.message ?? e) });
          done(false); // 開通前出錯 = 這次連線失敗; 開通後出錯只記 log, 由 close 事件處理後續
        });
        ws.on("close", () => {
          const isCurrent = this.ws === ws;
          if (isCurrent) { this.ws = null; this.connected = false; this.eventsLiveSince = 0; }
          done(false);
          if (this.intentionalClose.has(ws)) return; // 主動關閉 (disconnect/reconnect 換線), 不排重連
          if (isCurrent && this.wantConnected) {
            this.lineState = "已斷線";
            this.logger?.warn("機器人", "與 LINE 核心的連線已斷開, 將自動重連");
            this.scheduleReconnect();
          }
        });
        ws.on("message", (data) => this.onFrame(data).catch((e) => this.logger?.error("機器人", "處理訊息失敗", { error: String(e?.message ?? e) })));
      });
    })();
    this.connectInFlight = run;
    run.finally(() => { if (this.connectInFlight === run) this.connectInFlight = null; }).catch(() => {});
    return run;
  }

  // 退避重連排程: 間隔依序拉長 (1s/2s/5s/10s/30s 後固定 30s), 成功後歸零。重複呼叫不會重複排。
  scheduleReconnect() {
    if (this.reconnectTimer || !this.wantConnected) return;
    const delays = this.reconnectDelaysMs.length ? this.reconnectDelaysMs : [30000];
    const delay = delays[Math.min(this.reconnectAttempt, delays.length - 1)];
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.wantConnected) return;
      const ok = await this.openSocket().catch(() => false);
      if (!ok) {
        this.logger?.warn("機器人", "自動重連尚未成功, 會繼續重試", { attempt: this.reconnectAttempt });
        this.scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  // Token 換發/手動換 Token 後用: 先主動關掉舊連線 (核心也會踢, 兩邊不衝突), 再以目前儲存的 Token
  // 立刻重連並回傳驗證結果; 失敗時 log 明確記下, 並交給退避排程繼續自癒, 不靜默吞掉。
  async reconnect() {
    this.wantConnected = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.intentionalClose.add(this.ws);
      try { this.ws.close(); } catch {}
      this.ws = null;
      this.connected = false;
    }
    this.reconnectAttempt = 0;
    const ok = await this.openSocket().catch(() => false);
    if (ok) {
      this.logger?.info("機器人", "已用目前儲存的 Token 重新連上 LINE 核心");
    } else {
      this.logger?.warn("機器人", "重新連線失敗 (核心未就緒或 Token 尚未生效), 將自動重試");
      this.scheduleReconnect();
    }
    return ok;
  }

  disconnect() {
    this.stopDecryptWatch();
    this.wantConnected = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      this.intentionalClose.add(this.ws);
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.registry.flush();
  }

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
      // chatId 一併記在 pending 上: sent 影格本身不帶聊天室, onFrame 靠這筆把自己送出的
      // 訊息以「正確的聊天室」登記進登記簿 (分群隔離, 2026-10-23 稽核修復)。
      this.pending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject, chatId });
      this.sendFrame({ type: "message:send", requestId, chatId, text, ...(replyTo ? { replyTo } : {}) });
    });
  }

  // 送文字檔進聊天室 (核心 message:send 的 file 承載; 核心經 LineProvider 以 OBS 上傳送出 FILE 訊息)。
  // 回核心的 sent 影格走既有 pending 機制; 上傳比純文字慢, 逾時給 30 秒。
  async sendFile(chatId, filename, bytes) {
    await this.paceSend();
    return new Promise((resolve, reject) => {
      const requestId = `h${++this.reqSeq}-${Date.now()}`;
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new Error("send file timeout")); }, 30000);
      this.pending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, chatId });
      this.sendFrame({ type: "message:send", requestId, chatId, file: { filename, dataBase64: Buffer.from(bytes).toString("base64") } });
    });
  }

  // 回答交付: 放得進一則文字訊息就直接送; 超過字數上限改送文字檔 (老吳新規格),
  // 先有一句白話說明再送檔案; 檔案也送不出去時最後手段是分段連送, 段界優先落在段落邊界。
  // 回傳實際用的方式: "text" / "file" / "segments"。
  async deliverAnswer(m, answer, question = "") {
    if (answer.length <= TEXT_SEND_LIMIT) {
      await this.sendText(m.channelId, answer, m.messageId);
      return "text";
    }
    const bytes = Buffer.from(answer, "utf8");
    const filename = answerFilename(question);
    if (bytes.length <= FILE_SEND_MAX_BYTES) {
      try {
        await this.sendText(m.channelId, `這個回答比較長（約 ${answer.length} 字），一則訊息放不下，我把完整內容做成文字檔傳給你，請看下面這個檔案：${filename}`, m.messageId);
        await this.sendFile(m.channelId, filename, bytes);
        this.logger?.info("機器人回覆", "長回答改以文字檔送出", { id: m.messageId, chars: answer.length, bytes: bytes.length, file: filename });
        return "file";
      } catch (e) {
        this.logger?.error("機器人回覆", "文字檔送出失敗, 改用分段連送", { id: m.messageId, file: filename, error: String(e?.message ?? e) });
      }
    } else {
      this.logger?.warn("機器人回覆", "回答超過文字檔上限, 改用分段連送", { id: m.messageId, chars: answer.length, bytes: bytes.length });
    }
    const parts = splitLongText(answer, TEXT_SEND_LIMIT);
    for (let i = 0; i < parts.length; i++) {
      const label = parts.length > 1 ? `（第 ${i + 1}/${parts.length} 段）\n` : "";
      await this.sendText(m.channelId, label + parts[i], i === 0 ? m.messageId : undefined);
    }
    return "segments";
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

  // 連線成功後主動補登: 對每個白名單聊天室向核心要近期數頁歷史, 把訊息寄件者整頁登記進登記簿。
  // 為什麼 (第 6 項 a): 機器人在離線/重啟前自己發過的回答, 若沒被即時訊息或 sent 影格登記到,
  // 同事引用它追問時只能靠引用當下的補查 (還可能被新訊息推到補查範圍外)。連線後先補登近期歷史,
  // 常見情況 (引用最近的回答) 直接命中登記簿, 不必等補查、也不受補查深度限制。
  async prefetchHistory(chatIds, pages = HISTORY_PREFETCH_PAGES) {
    if (!this.connected) return;
    for (const chatId of chatIds ?? []) {
      if (!chatId || this.historyPrefetchedChats.has(chatId) || this.historyPrefetchInFlight.has(chatId)) continue;
      this.historyPrefetchInFlight.add(chatId);
      try {
        let cursor;
        for (let page = 0; page < pages; page++) {
          const frame = await this.fetchHistoryPage(chatId, cursor);
          const messages = Array.isArray(frame.messages) ? frame.messages : [];
          for (const hm of messages) {
            if (hm.messageId && hm.senderId) this.registry.register(hm.messageId, hm.senderId, hm.channelId ?? chatId);
          }
          if (!frame.hasMore || !frame.cursor) break;
          cursor = frame.cursor;
        }
        this.historyPrefetchedChats.add(chatId);
        this.logger?.info("訊息登記簿", "連線後歷史補登完成", { chat: chatId, pages });
      } catch (e) {
        // 補登失敗不影響正常服務: 引用當下仍有 isQuotedSelf 的歷史補查兜底
        this.logger?.warn("訊息登記簿", "連線後歷史補登失敗, 改靠引用當下補查", { chat: chatId, error: String(e?.message ?? e) });
      } finally {
        this.historyPrefetchInFlight.delete(chatId);
      }
    }
  }

  // --- 訊息解密健康偵測 (2026-10-21 第二段) ---
  // 狀態彙總 (status().decrypt 與 log 轉移判定共用): state 三態 —
  // unknown = 還沒完成過任何一輪掃描 (不冒充正常); ok = 掃過且沒有解密失敗;
  // failed = 至少一個聊天室的近期歷史裡有 decryptFailed 訊息。
  // issues 只列有失敗的聊天室 (依最近失敗時間新到舊), 附失敗數/掃描數/最近失敗時間/寄件者名稱。
  decryptSummary() {
    const issues = [];
    let totalFailed = 0;
    let totalScanned = 0;
    for (const [chatId, r] of this.decryptByChat) {
      totalScanned += r.scanned;
      if (r.failed > 0) {
        totalFailed += r.failed;
        // blocking (2026-10-22 修復): 這個群「現在」是不是真的讀不到 — 只認即時活狀態:
        // 最後一次即時失敗之後沒有任何即時成功, 才算擋事的壞狀態。歷史窗裡有舊世代
        // 壞訊息、但即時訊息解得開的群 blocking=false (只提示歷史問題, 不擋發送)。
        const live = this.decryptLiveByChat.get(chatId);
        const blocking = !!(live && live.lastFailAt > 0 && live.lastFailAt > live.lastOkAt);
        issues.push({
          chatId,
          name: this.chatNames.get(chatId) ?? "",
          failed: r.failed,
          scanned: r.scanned,
          lastFailAt: r.lastFailAt,
          lastFailTime: r.lastFailTime,
          senders: [...r.senders],
          blocking,
          lastLiveOkAt: live && live.lastOkAt ? new Date(live.lastOkAt).toISOString() : null,
          lastLiveFailAt: live && live.lastFailAt ? new Date(live.lastFailAt).toISOString() : null,
        });
      }
    }
    issues.sort((a, b) => String(b.lastFailAt ?? "").localeCompare(String(a.lastFailAt ?? "")));
    // 漏接彙總: 只列達到點燈門檻 (minCount) 的聊天室, 依最近漏接時間新到舊。
    const missedIssues = [];
    let totalMissed = 0;
    for (const [chatId, r] of this.decryptMissedByChat) {
      if (r.missed >= this.decryptMissedOptions.minCount) {
        totalMissed += r.missed;
        missedIssues.push({
          chatId,
          name: this.chatNames.get(chatId) ?? "",
          missed: r.missed,
          newestMissedAt: r.newestMissedAt,
          newestMissedTime: r.newestMissedTime,
        });
      }
    }
    missedIssues.sort((a, b) => String(b.newestMissedAt ?? "").localeCompare(String(a.newestMissedAt ?? "")));
    return {
      state: this.decryptLastScanAt == null ? "unknown" : totalFailed > 0 ? "failed" : "ok",
      totalFailed,
      totalScanned,
      chatsChecked: this.decryptByChat.size,
      lastScanAt: this.decryptLastScanAt,
      issues,
      // 現在真的讀不到、需要擋下發送的聊天室 (issue.blocking 的子集); 消費端 (殼/Ubuntu
      // 執行器) 只准用這份判斷暫停, 用整份 issues 會把「歷史有舊壞訊息但即時正常」的群誤擋。
      blockingChats: issues.filter((i) => i.blocking).map((i) => i.chatId),
      missedTotal: totalMissed,
      missedIssues,
    };
  }

  // 一輪掃描: 對每個白名單聊天室抓最近一頁歷史 (100 則), 統計 decryptFailed。
  // 只更新記憶體狀態; log 只在「某聊天室由正常變異常」或「全部恢復正常」時寫一筆,
  // 一般週期掃描不刷 log。單一聊天室抓取失敗就保留它上次的紀錄並讓整輪算失敗 (退避),
  // 不把未知洗成正常。回傳本輪的 summary。
  async scanDecryptHealthOnce() {
    if (this.decryptScanInFlight) return this.decryptSummary();
    if (!this.connected || !this.botChats.length) return this.decryptSummary();
    this.decryptScanInFlight = true;
    const wasAlerting = new Set([...this.decryptByChat].filter(([, r]) => r.failed > 0).map(([id]) => id));
    let roundOk = true;
    try {
      for (const chatId of [...this.botChats]) {
        let frame;
        try {
          frame = await this.fetchHistoryPage(chatId);
        } catch (e) {
          roundOk = false;
          this.logger?.debugLog("訊息解密偵測", "掃描單一聊天室失敗, 保留上次紀錄", { chat: chatId, error: String(e?.message ?? e) });
          continue;
        }
        const messages = Array.isArray(frame.messages) ? frame.messages : [];
        // 順帶補登發言者: 歷史裡出現過的人, 管理員候選名單與 @ 可行性判斷都算得進來
        // (只記 id/顯示名, 與即時訊息的 noteSpeaker 同一隱私規格)。
        for (const hm of messages) {
          if (hm?.senderId) this.noteSpeaker({ channelId: chatId, senderId: hm.senderId, senderName: hm.senderName });
        }
        let failed = 0;
        let lastFailAtMs = 0;
        const senders = new Set();
        for (const hm of messages) {
          if (hm?.decryptFailed !== true) continue;
          failed++;
          const t = Number(hm.createdAt) || 0;
          if (t > lastFailAtMs) lastFailAtMs = t;
          if (typeof hm.senderName === "string" && hm.senderName) senders.add(hm.senderName);
        }
        const prev = this.decryptByChat.get(chatId);
        const rec = {
          failed,
          scanned: messages.length,
          lastFailAt: failed > 0 && lastFailAtMs > 0 ? new Date(lastFailAtMs).toISOString() : null,
          lastFailTime: "",
          senders: [...senders].slice(0, 5),
        };
        if (rec.lastFailAt) {
          const d = new Date(lastFailAtMs);
          const p2 = (n) => String(n).padStart(2, "0");
          rec.lastFailTime = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
        }
        this.decryptByChat.set(chatId, rec);
        // 狀態轉移才寫 log: 正常→異常 (首次偵測到) 講清楚哪個聊天室、幾則、最近一則時間;
        // 異常→正常 (例如已登出重登、鑰匙重新對齊) 也留一筆, 供事後對照事故時間線。
        if (failed > 0 && !(prev && prev.failed > 0)) {
          this.logger?.warn("訊息解密偵測", "偵測到無法解密的訊息 (核心讀不到內容, 機器人不會回覆這些訊息)", {
            chat: chatId, name: this.chatNames.get(chatId) ?? "", failed, scanned: messages.length,
            lastFailAt: rec.lastFailAt, senders: rec.senders,
          });
          // 管理員通知 (自己出狀況): 鑰匙對不上是事故級訊號, 只在轉移的那一輪發 (節流在事件紀錄端也有)
          this.raiseAdminEvent("selfError", {
            chatId, chatName: this.chatNames.get(chatId) ?? "",
            detail: `這個群組有 ${failed} 則訊息我讀不到（鑰匙對不上），那些訊息我不會回覆，請管理員處理。`,
          });
        } else if (failed === 0 && prev && prev.failed > 0) {
          this.logger?.info("訊息解密偵測", "先前無法解密的訊息已不在近期範圍內 (可能已重新登入或已超出掃描範圍)", {
            chat: chatId, name: this.chatNames.get(chatId) ?? "",
          });
        }
        // 漏接比對 (同一頁順帶做, 不多打任何請求): 判準見 DECRYPT_MISSED_* 常數註解。
        const mo = this.decryptMissedOptions;
        let missed = 0;
        let newestMissedAtMs = 0;
        if (this.selfId && this.eventsLiveSince) {
          const seen = this.seenEventIds.get(chatId);
          const nowMs = Date.now();
          for (const hm of messages) {
            if (hm?.decryptFailed === true || hm?.unsent === true) continue;
            if (hm?.contentType === "CHATEVENT") continue;
            if (!hm?.messageId || hm.senderId === this.selfId) continue;
            if (typeof hm.text !== "string" || !hm.text) continue;
            const t = Number(hm.createdAt) || 0;
            if (!(t > this.eventsLiveSince + mo.liveBufferMs)) continue; // 連線開通前 (含斷線期間) 的訊息本來就不補送
            if (!(nowMs - t > mo.graceMs)) continue; // 還在事件寬限內, 不算漏
            if (seen?.has(hm.messageId)) continue; // 有送達過
            missed++;
            if (t > newestMissedAtMs) newestMissedAtMs = t;
          }
        }
        const missedRec = {
          missed,
          newestMissedAt: missed > 0 && newestMissedAtMs > 0 ? new Date(newestMissedAtMs).toISOString() : null,
          newestMissedTime: "",
        };
        if (missedRec.newestMissedAt) {
          const d = new Date(newestMissedAtMs);
          const p2 = (n) => String(n).padStart(2, "0");
          missedRec.newestMissedTime = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
        }
        const prevMissed = this.decryptMissedByChat.get(chatId);
        const wasMissAlert = prevMissed ? prevMissed.missed >= mo.minCount : false;
        const isMissAlert = missed >= mo.minCount;
        this.decryptMissedByChat.set(chatId, missedRec);
        if (isMissAlert && !wasMissAlert) {
          this.logger?.warn("訊息解密偵測", "偵測到訊息漏接 (訊息已在聊天室歷史裡, 卻沒有送到機器人這裡; 該聊天室可能已完全收不到)", {
            chat: chatId, name: this.chatNames.get(chatId) ?? "", missed, newestMissedAt: missedRec.newestMissedAt,
          });
          // 管理員通知 (自己出狀況): 整個群組收不到比單則讀不到更嚴重, 同樣要在轉移時通知
          this.raiseAdminEvent("selfError", {
            chatId, chatName: this.chatNames.get(chatId) ?? "",
            detail: `這個群組有 ${missed} 則訊息根本沒有送到我這裡，這個群組的訊息我現在可能整個收不到，請管理員處理。`,
          });
        } else if (!isMissAlert && wasMissAlert) {
          this.logger?.info("訊息解密偵測", "先前的訊息漏接已解除", {
            chat: chatId, name: this.chatNames.get(chatId) ?? "",
          });
        }
      }
    } finally {
      this.decryptScanInFlight = false;
    }
    if (roundOk) {
      this.decryptLastScanAt = new Date().toISOString();
      this.decryptScanFailures = 0;
    } else {
      this.decryptScanFailures++;
    }
    const nowAlerting = new Set([...this.decryptByChat].filter(([, r]) => r.failed > 0).map(([id]) => id));
    if (wasAlerting.size > 0 && nowAlerting.size === 0 && roundOk) {
      this.logger?.info("訊息解密偵測", "全部聊天室的訊息都可正常讀取了", {});
    }
    return this.decryptSummary();
  }

  // 週期掃描的看守計時器: main.mjs 在啟動後呼叫一次即可; 未連線/無白名單時該輪自動跳過。
  // 連續失敗輪數會拉長間隔 (退避, 上限 DECRYPT_SCAN_MAX_BACKOFF 倍), 成功即恢復原間隔。
  startDecryptWatch(intervalMs = DECRYPT_SCAN_INTERVAL_MS) {
    if (this.decryptScanTimer) return;
    const tick = async () => {
      await this.scanDecryptHealthOnce().catch((e) => this.logger?.debugLog("訊息解密偵測", "掃描發生錯誤", { error: String(e?.message ?? e) }));
      if (!this.decryptScanTimer) return; // 已被 stopDecryptWatch 停掉
      const backoff = Math.min(2 ** this.decryptScanFailures, DECRYPT_SCAN_MAX_BACKOFF);
      this.decryptScanTimer = setTimeout(tick, intervalMs * backoff);
      this.decryptScanTimer.unref?.();
    };
    this.decryptScanTimer = setTimeout(tick, intervalMs);
    this.decryptScanTimer.unref?.();
  }

  stopDecryptWatch() {
    if (this.decryptScanTimer) { clearTimeout(this.decryptScanTimer); this.decryptScanTimer = null; }
  }

  // 被引用的訊息是不是機器人自己發的:
  // 先查登記簿 (收到的影格、自己的 sent 影格、連線後主動補登的歷史都有登記); 查不到才向核心要歷史補查
  // (最多 QUOTE_HISTORY_PAGES 頁, 理由見該常數註解), 歷史裡每則訊息都帶 senderId, 順便整頁補登記。
  // 查無此訊息時在登記簿留空字串記號, 避免每次引用都重查。
  async isQuotedSelf(m) {
    if (!m.replyTo || !this.selfId) return false;
    // 分群隔離 (2026-10-23 稽核修復): 認定只限「本聊天室」登記過的紀錄;
    // 被引用的訊息若是在別的群登記的, 視同沒登記過, 之後也只查本聊天室的歷史。
    const known = this.registry.lookup(m.replyTo, m.channelId ?? "");
    if (known !== undefined) return known === this.selfId;
    if (!this.connected) return false;
    try {
      let cursor;
      for (let page = 0; page < QUOTE_HISTORY_PAGES; page++) {
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
      // 本聊天室歷史也查無此訊息才留負記號; 登記簿裡若已有紀錄 (例如別群的正式紀錄,
      // 跨群引用情境), 不可用負記號把人家覆寫掉 (分群隔離, 2026-10-23 稽核修復)。
      if (this.registry.lookup(m.replyTo) === undefined) this.registry.register(m.replyTo, "", m.channelId ?? "");
      return false;
    } catch (e) {
      this.logger?.warn("觸發判斷", "引用訊息寄件者補查失敗, 本次不以引用觸發", { id: m.messageId, error: String(e?.message ?? e) });
      return false;
    }
  }

  async onFrame(data) {
    let frame;
    try { frame = JSON.parse(data.toString()); } catch { return; }
    if (frame.type === "hello") {
      // 核心版本回報 (第 14 項): hello 的 serverVersion 是核心自己的 package 版本
      if (typeof frame.serverVersion === "string" && frame.serverVersion) this.coreVersion = frame.serverVersion;
      return;
    }
    if (frame.type === "auth:ready") {
      this.selfId = frame.profile?.userId ?? "";
      this.selfName = frame.profile?.displayName ?? "";
      this.lineState = "已登入";
      return;
    }
    if (frame.type === "auth:state") { if (frame.state) this.lineState = frame.state; return; }
    // 核心送來的聊天室清單 (機器人連線只會拿到 api.chats 白名單內的): 記下來, 並在連線完成後
    // 主動對每個聊天室補登近期歷史 (prefetchHistory), 讓引用續答認得離線/重啟前的回答。
    if (frame.type === "channels") {
      const list = Array.isArray(frame.channels) ? frame.channels : [];
      const ids = list.map((c) => c?.channelId).filter((x) => typeof x === "string" && x);
      for (const c of list) {
        if (c?.channelId && typeof c.name === "string" && c.name) this.chatNames.set(c.channelId, c.name);
      }
      if (ids.length) {
        this.botChats = ids;
        void this.prefetchHistory(ids);
      }
      return;
    }
    // 自己送出的訊息: 核心在 sent 影格回新訊息的 messageId, 立刻登記為機器人本人,
    // 之後有人引用這則回答, 登記簿就認得出來 (引用續答觸發的認定主路徑)。
    // sent 影格不帶聊天室: 改用送出時記在 pending 上的 chatId 登記 (分群隔離,
    // 2026-10-23 稽核修復) — 登記成空白的話, 這則回答會被別的群「借用」來跨群認定。
    if (frame.type === "sent" && frame.messageId && this.selfId) {
      const sentChatId = frame.requestId ? (this.pending.get(frame.requestId)?.chatId ?? "") : "";
      this.registry.register(frame.messageId, this.selfId, sentChatId);
    }
    if (frame.requestId && this.pending.has(frame.requestId)) {
      const p = this.pending.get(frame.requestId);
      this.pending.delete(frame.requestId);
      if (frame.type === "error") p.reject(new Error(frame.code ?? "SEND_FAILED"));
      else p.resolve(frame); // sent / history 都走這裡
      return;
    }
    if (frame.type === "message") {
      // 漏接偵測的「已送達」證據: 真的從 WS 進來的訊息事件才登記 (含非文字訊息);
      // 歷史補登/補查讀到的不算 — 那正是掃描要比對的落差。只存 ID, 上限見常數。
      const mid = frame.message?.messageId;
      if (typeof mid === "string" && mid) {
        const cid = frame.message.channelId ?? "";
        let set = this.seenEventIds.get(cid);
        if (!set) { set = new Set(); this.seenEventIds.set(cid, set); }
        set.add(mid);
        if (set.size > DECRYPT_SEEN_IDS_CAP) { for (const old of set) { set.delete(old); break; } }
      }
      await this.onMessage(frame.message);
    }
  }

  // 記即時解密活狀態: 只認真的從核心即時推播進來的事件 (歷史回補不經這裡)。
  // 成功 = 真人 (非自己) 的文字訊息解開了; 失敗 = 核心標了 decryptFailed 的佔位訊息。
  noteLiveDecrypt(m) {
    const chatId = m?.channelId;
    if (!chatId) return;
    let rec = this.decryptLiveByChat.get(chatId);
    if (!rec) { rec = { lastOkAt: 0, lastFailAt: 0 }; this.decryptLiveByChat.set(chatId, rec); }
    const nowMs = Date.now();
    if (m.decryptFailed === true) { rec.lastFailAt = nowMs; return; }
    if (this.selfId && m.senderId && m.senderId !== this.selfId
      && m.contentType !== "CHATEVENT" && m.contentType !== "18"
      && typeof m.text === "string" && m.text) {
      rec.lastOkAt = nowMs;
    }
  }

  async onMessage(m) {
    if (!m) return;
    this.noteLiveDecrypt(m);
    if (typeof m.text !== "string") return;
    const s = this.cfg();
    this.rollStats();
    this.logger?.info("訊息接收", "收到訊息", { id: m.messageId, chat: m.channelId, sender: m.senderId, len: m.text.length });
    this.logger?.logText("訊息接收", "訊息", m.text);
    // 每則看到的訊息都登記寄件者 (含機器人自己的): 之後被引用時才認得出來源
    if (m.messageId && m.senderId) this.registry.register(m.messageId, m.senderId, m.channelId ?? "");
    // 發言者登記 (管理員候選名單/@ 可行性): 只記 id 與顯示名, 不記內容
    this.noteSpeaker(m);
    if (m.senderId === this.selfId) { this.logger?.debugLog("觸發判斷", "忽略自己發的訊息", { id: m.messageId }); return; }
    // 系統事件不觸發 (2026-10-21 第二段追加): 成員加入/離開等系統通知在核心是
    // contentType CHATEVENT (或原始碼 "18"), 內文是核心組好的顯示字串 (例如
    // 「妖狐藏馬 新增 AI寶 至群組」), 裡面常含機器人名字 — 寬鬆模式下舊版會被名字
    // 觸發、把系統通知當提問認真回覆 (2026-10-21 實機: 退群重邀後機器人回覆了
    // 自己的入群通知)。系統事件不是提問, 一律不觸發問答、也不送防詐騙判讀;
    // 寄件者登記已在上方完成, 不影響引用認定。
    if (m.contentType === "CHATEVENT" || m.contentType === "18") { this.logger?.debugLog("觸發判斷", "系統事件訊息, 不觸發", { id: m.messageId }); return; }
    // 管理員通知的關鍵字掃描: 與觸發/防詐騙獨立, 命中只記錄事件 (送出由 App 殼負責), 不影響問答
    this.checkKeywordRules(m);
    // 兩件事並行評估: 防詐騙自動掃描 + 名字觸發; 先處理觸發問答, 詐騙警告獨立進行
    const triggerPromise = this.handleTrigger(m, s);
    const scamPromise = this.handleAutoScam(m, s);
    await Promise.allSettled([triggerPromise, scamPromise]);
  }

  async handleAutoScam(m, s) {
    if (!s.scam.enabled) return;
    // 掃描計數 (2026-10-22 修復): 每則真人訊息都過預篩, 這個數字讓「有在看每一則」
    // 在總覽上看得見 — checkedToday 只計預篩命中、真的送判讀的次數, 兩者口徑不同:
    // 2026-10-22 真機就是只有打招呼訊息、預篩沒命中, checkedToday=0 看起來像沒在監控。
    this.stats.scamScanned++;
    const pre = prefilterScam(m.text);
    if (!pre.hit) { this.logger?.debugLog("防詐騙", "預篩未命中, 不送判讀", { id: m.messageId }); return; }
    this.scamLimiter.limit = s.scam.perMinute ?? 10;
    if (!this.scamLimiter.tryTake()) { this.logger?.warn("防詐騙", "判讀次數達每分鐘上限, 本則略過", { id: m.messageId }); return; }
    this.logger?.info("防詐騙", "預篩命中, 送判讀", { id: m.messageId, rules: pre.rules });
    const verdict = await this.judgeMessage(m);
    this.stats.scamChecked++;
    this.logger?.info("防詐騙", "判讀完成", { id: m.messageId, probability: verdict.probability, tactic: verdict.tactic, source: verdict.source ?? "ai", fallback: !!verdict.fallback, warned: verdict.probability >= s.scam.threshold });
    if (verdict.probability >= s.scam.threshold) {
      this.stats.scamWarned++;
      this.persistDaily();
      await this.sendText(m.channelId, scamWarningText({ ...verdict, botName: s.botName }), m.messageId).catch((e) => this.logger?.error("防詐騙", "警告送出失敗", { error: String(e?.message ?? e) }));
      this.recordActivity({ kind: "scam_warned", m, detail: verdict.tactic ?? "" });
      // 管理員通知 (詐騙警報): 警告發出後同步通知管理員, 讓人可以進群看狀況
      this.raiseAdminEvent("scam", {
        chatId: m.channelId, chatName: this.chatNames.get(m.channelId) ?? "",
        detail: `有人貼了一則疑似詐騙的訊息（手法：${verdict.tactic ?? "其他"}，判讀機率 ${Math.round((verdict.probability ?? 0) * 100)}%），我已經在群組裡發出警告，請管理員留意。`,
      });
    }
  }

  // 依目前設定與已存金鑰刷新 Jev 狀態 (啟動時與設定存檔後由外部呼叫; 判讀路徑也會自行維護)。
  async refreshJevState() {
    const s = this.cfg();
    const key = this.secrets ? await this.secrets.get(SECRET_NAMES.jev).catch(() => null) : null;
    const print = `${s.scam?.jev?.enabled ? 1 : 0}|${key ? String(key).slice(-4) : ""}|${s.scam?.jev?.model ?? ""}`;
    if (!s.scam?.jev?.enabled || !key) {
      this.jevState = "unconfigured";
      this.jevKeyPrint = print;
      this.jevLastError = "";
      return this.jevState;
    }
    if (!isValidJevToken(key)) {
      this.jevState = "error";
      this.jevLastError = "金鑰格式不對 (只能是無空白的英數字與符號), 請重新貼上正確的金鑰";
      this.jevKeyPrint = print;
      return this.jevState;
    }
    if (print !== this.jevKeyPrint || this.jevState === "unconfigured") {
      this.jevState = "unverified";
      this.jevLastError = "";
    }
    this.jevKeyPrint = print;
    return this.jevState;
  }

  // 向核心要求 Jev 判讀一則訊息 (機器人 API 的 scam:check; 核心以自己快取的那則原文送 TypeSafe,
  // 只回機率與手法, 金鑰與原文都不經 helper)。逾時給 20 秒 (核心對 TypeSafe 的逾時是 15 秒)。
  async scamCheck(chatId, messageId) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw Object.assign(new Error("NOT_CONNECTED"), { code: "NOT_CONNECTED" });
    }
    return new Promise((resolve, reject) => {
      const requestId = `h${++this.reqSeq}-${Date.now()}`;
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" })); }, 20000);
      this.pending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.sendFrame({ type: "scam:check", requestId, chatId, messageId });
    });
  }

  // AI 判讀 (既有路徑): 所選 AI 判讀 + 解析失敗時規則備援 (judgeScam 內含)。
  async judgeWithAi(text) {
    const { cfg, key } = await this.providerWithKey(this.cfg().ai.active);
    const v = await judgeScam({ text, aiChat: (args) => this.ai.chat(args), providerCfg: { baseUrl: cfg.baseUrl, model: cfg.model }, apiKey: key, logger: this.logger });
    return { ...v, source: "ai" };
  }

  // 判讀「群組裡的一則實際訊息」: Jev 啟用且金鑰可用時優先走核心 scam:check;
  // 任一失敗 (核心未載入金鑰、TypeSafe 失敗、逾時、未連線…) 自動退回 AI 判讀,
  // 防詐騙不會因為 Jev 故障而整段失效。成功時另以影子方式跑一次 AI 判讀留同場比試紀錄。
  async judgeMessage(m) {
    const s = this.cfg();
    const jevOn = !!s.scam?.jev?.enabled;
    const key = jevOn && this.secrets ? await this.secrets.get(SECRET_NAMES.jev).catch(() => null) : null;
    if (jevOn && key && isValidJevToken(key)) {
      try {
        const frame = await this.scamCheck(m.channelId, m.messageId);
        const a = frame?.analysis;
        const p = Number(a?.probability);
        if (!Number.isFinite(p) || p < 0 || p > 1) throw Object.assign(new Error("BAD_RESULT"), { code: "BAD_RESULT" });
        const verdict = { probability: p, tactic: JEV_TACTIC_LABELS[a?.tactic?.kind] ?? "其他", reason: "", fallback: false, source: "jev" };
        this.jevState = "ok";
        this.jevLastOkAt = new Date().toISOString();
        this.jevLastError = "";
        this.jevKeyPrint = `1|${String(key).slice(-4)}|${s.scam?.jev?.model ?? ""}`;
        void this.shadowAiJudge(m, verdict);
        return verdict;
      } catch (e) {
        const code = String(e?.code ?? e?.message ?? "UNKNOWN");
        const why = classifyJevError(code);
        this.jevState = "error";
        this.jevLastError = why;
        this.logger?.warn("防詐騙", "Jev 判讀失敗, 已自動改用 AI 判讀", { id: m.messageId, reason: why });
      }
    } else if (jevOn) {
      // 有開 Jev 但還不能用 (沒存金鑰或格式不對): 照舊用 AI, 狀態如實刷新, 不假裝有在走 Jev
      await this.refreshJevState();
      if (!key) this.logger?.debugLog("防詐騙", "Jev 已啟用但尚未設定金鑰, 本則改用 AI 判讀", { id: m.messageId });
    }
    return this.judgeWithAi(m.text);
  }

  // 影子比試 (2026-10-21 老吳裁示, 供日後決定長期由誰當家): Jev 成功判讀的同則訊息,
  // 另以 AI 判讀算一次分, 兩邊分數記在同一行 log; 只記錄, 不影響任何回覆與運作,
  // AI 影子計算失敗就靜默略過 (不刷警告、不擋正常判讀)。
  async shadowAiJudge(m, jevVerdict) {
    try {
      const ai = await this.judgeWithAi(m.text);
      this.logger?.info("防詐騙", "Jev 與 AI 同場比試 (影子紀錄, 不影響判讀結果)", {
        id: m.messageId,
        jev: jevVerdict.probability, jevTactic: jevVerdict.tactic,
        ai: ai.probability, aiTactic: ai.tactic, aiFallback: !!ai.fallback,
        used: "jev",
      });
    } catch { /* 影子失敗靜默略過 */ }
  }

  // 手動判讀 (同事貼上文字問「這是詐騙嗎」): Jev 協定只能判讀核心快取裡的實際訊息,
  // 使用者自貼的文字不在快取裡, 一律走 AI; 只有目標就是訊息本則時才走 judgeMessage。
  async judgeForManual(target, m) {
    if (target === m.text) return this.judgeMessage(m);
    if (this.cfg().scam?.jev?.enabled) {
      this.logger?.info("防詐騙", "手動判讀的文字是使用者自貼的內容, 不在核心的訊息快取裡, 改用 AI 判讀", { id: m.messageId });
    }
    return this.judgeWithAi(target);
  }

  async handleTrigger(m, s) {
    // 引用續答: 引用的是機器人自己的訊息時, 視同被名字觸發 (認定方式見 isQuotedSelf)
    const quotedSelf = m.replyTo ? await this.isQuotedSelf(m) : false;
    const verdict = evaluateTrigger({ text: m.text, senderId: m.senderId, selfId: this.selfId, settings: s, state: this.triggerState, quotedSelf });
    // 引用診斷欄位 (第 1 項續查): replyTo 有無與引用認定結果一律入 log —
    // 2026-10-20 實機引用無回應時, 舊 log 連「這則訊息到底有沒有帶 replyTo」都查不到,
    // 斷點只能定界不能定案; 之後任何引用問題都能直接從 log 判讀核心送達形狀。
    this.logger?.info("觸發判斷", verdict.triggered ? "命中觸發" : "未觸發", { id: m.messageId, reason: verdict.reason, name: verdict.matchedName || "", replyTo: m.replyTo ? "yes" : "no", quote: m.replyTo ? (quotedSelf ? "self" : "other") : "" });
    if (!verdict.triggered) {
      // 活動面板 (第 12 項): 被冷卻/每日上限擋下的也要留一筆, 管理員才看得出「有在擋」
      if (verdict.reason === "cooldown") this.recordActivity({ kind: "cooldown", m });
      if (verdict.reason === "daily_limit") this.recordActivity({ kind: "daily_limit", m });
      if (verdict.limitReached) {
        const last = this.triggerState.limitNoticeByUser.get(m.senderId) ?? 0;
        if (Date.now() - last > 3600000) {
          this.triggerState.limitNoticeByUser.set(m.senderId, Date.now());
          await this.sendText(m.channelId, limitText(s.botName), m.messageId).catch(() => {});
        }
      }
      return;
    }
    if (verdict.reason === "name_only") {
      // 只打名字回引導訊息不記冷卻 (2026-10-20 驗收修復): 引導只是打招呼, 若它也吃掉 20 秒冷卻,
      // 使用者照引導馬上補上真正的問題 (同一分鐘內) 會被冷卻靜默擋下, 看起來像機器人壞掉。
      // 冷卻只記在真正的問答觸發上 (下方 markTriggered), 防連珠炮洗版的效果不變。
      await this.sendText(m.channelId, guidanceText(s.botName), m.messageId).catch(() => {});
      this.recordActivity({ kind: "name_only", m });
      return;
    }
    markTriggered(this.triggerState, m.senderId);
    this.stats.triggered++;
    const question = verdict.question;
    // 創造者意圖: 直接回固定答覆, 不呼叫 AI、不附來源; 冷卻與每日上限已在 evaluateTrigger/markAnswered 照常計入。
    // 判定文字用 question (已去掉觸發名字); 例外: 「AI寶的作者是誰」去掉名字後 question 會以「的」開頭,
    // 那是所有格殘留 (主詞就是機器人本身), 補回名字再判定, 否則會漏判。
    const creatorText = question.startsWith("的") ? `${s.botName ?? ""}${question}` : question;
    if (isCreatorIntent(creatorText, s)) {
      const reply = typeof s.creatorReply === "string" && s.creatorReply.trim() ? s.creatorReply : DEFAULT_CREATOR_REPLY;
      await this.sendText(m.channelId, reply, m.messageId).catch((e) => this.logger?.error("機器人回覆", "創造者固定答覆送出失敗", { error: String(e?.message ?? e) }));
      markAnswered(this.triggerState);
      this.stats.answered++;
      this.persistDaily();
      this.recordActivity({ kind: "answered", m, answerChars: reply.length, answerText: reply });
      const mem0 = this.memory.get(m.channelId) ?? [];
      this.memory.set(m.channelId, [...mem0, { role: "user", content: question }, { role: "assistant", content: reply }].slice(-(s.ai.memoryTurns ?? 6) * 2));
      this.logger?.info("機器人回覆", "已回覆創造者固定答覆 (未呼叫 AI)", { id: m.messageId });
      return;
    }
    // 手動防詐騙判讀
    if (isManualScamAsk(question)) {
      const target = extractScamTarget(question) || m.text;
      this.scamLimiter.limit = s.scam.perMinute ?? 10;
      if (!this.scamLimiter.tryTake()) { await this.sendText(m.channelId, "判讀次數暫時到上限了, 請等一分鐘再問我。", m.messageId).catch(() => {}); return; }
      this.logger?.info("防詐騙", "手動判讀請求", { id: m.messageId, targetLen: target.length });
      const v = await this.judgeForManual(target, m);
      this.stats.scamChecked++;
      await this.sendText(m.channelId, scamVerdictText(v), m.messageId).catch(() => {});
      return;
    }
    // 知識庫優先
    const hits = this.kb ? this.kb.search(question, 3) : [];
    const companyLike = COMPANY_HINTS.some((h) => question.includes(h));
    this.logger?.info("知識庫", hits.length ? "知識庫命中" : "知識庫未命中", { id: m.messageId, chunks: hits.map((h) => h.chunkId) });
    if (!hits.length && companyLike) {
      const missText = kbMissText();
      await this.sendText(m.channelId, missText, m.messageId).catch(() => {});
      markAnswered(this.triggerState);
      this.stats.answered++;
      this.persistDaily();
      this.recordActivity({ kind: "answered", m, answerChars: missText.length, answerText: missText });
      // 管理員通知 (答不出來): 公司問題但知識庫查不到 — 管理員才知道要補文件進知識庫
      this.raiseAdminEvent("unanswered", {
        chatId: m.channelId, chatName: this.chatNames.get(m.channelId) ?? "",
        detail: "有同事問了公司相關的問題，但我在知識庫裡查不到，已經回覆他先問資訊部。這一題我沒有回答出來，如果有相關文件，請管理員放進知識庫資料夾。",
      });
      return;
    }
    const mem = this.memory.get(m.channelId) ?? [];
    const nameLine = s.botName ? `你的名字是「${s.botName}」, 同事這樣叫你時就是在叫你。` : "";
    // 人設注入 (第 3 項): 非空欄位逐項寫入 system prompt, 年紀由出生日自動計算, 並附空欄位誠實回答規則
    const personaSection = buildPersonaSection(s.persona);
    // 回答範圍注入 (2026-10-21): scopePrompt 非空才有段落; 清空 = 不限制範圍 (見 buildScopeSection)
    const scopeSection = buildScopeSection(s.ai?.scopePrompt);
    // 角色定位 (2026-10-21 改為可編輯欄位): 以 ai.rolePrompt 取代舊寫死首句, 放在組裝後的最前面;
    // 欄位異常為空時退回出廠預設 (正常路徑下儲存時已自動回復預設, 這裡是最後防線)。
    const roleSection = typeof s.ai?.rolePrompt === "string" && s.ai.rolePrompt.trim() ? s.ai.rolePrompt.trim() : DEFAULT_ROLE_PROMPT;
    const messages = [
      { role: "system", content: `${roleSection}\n${s.ai.systemPrompt}\n${nameLine}${scopeSection ? `\n${scopeSection}` : ""}\n${personaSection}\n${LINE_FORMAT_RULE}` },
      ...mem,
    ];
    if (hits.length) {
      const kbText = hits.map((h, i) => `片段${i + 1} (來源: ${h.file}):\n${h.text}`).join("\n\n");
      messages.push({ role: "user", content: `問題: ${question}\n\n以下是公司知識庫片段, 請優先依片段回答:\n${kbText}` });
    } else {
      messages.push({ role: "user", content: question });
    }
    let answer;
    let aiFailedKind = "";
    const aiStartedAt = Date.now();
    try {
      const r = await this.chatWithAi(messages, { maxTokens: ANSWER_MAX_TOKENS });
      answer = r.content;
    } catch (e) {
      // 備援訊息只給白話原因與下一步, 不把原始例外字串丟給群組同事看 (原始細節已由 chatWithAi 寫進 log)。
      // 限流 (429 重試後仍忙) 用老吳指定的白話句, 不提管理員/設定頁 — 同事稍等再問即可。
      this.logger?.error("機器人回覆", "AI 回答失敗, 回覆備援訊息", { error: String(e?.message ?? e), detail: e?.detail ? String(e.detail) : undefined });
      if (e?.code === "AI_BUSY") {
        aiFailedKind = "ai_busy";
        answer = "我這邊有點忙，稍等幾秒再問我一次。";
      } else {
        aiFailedKind = "ai_failed";
        answer = "不好意思, 我現在連不上 AI 服務。下一步: 請管理員到控制台設定頁按「測試連線」確認 API Key 與網路, 或稍後再問我一次。";
      }
    }
    const aiMs = Date.now() - aiStartedAt;
    // 參考來源開關 (第 1 項): settings.showSources 為 false 時不附加任何來源行 (預設就是 false);
    // true 時維持原行為, 在回答最後附上知識庫來源檔名。
    if (hits.length && s.showSources) {
      const sources = [...new Set(hits.map((h) => h.file))];
      answer += `\n\n(參考來源: ${sources.join("、")})`;
    }
    // 符號強制清理 (2026-10-21 追加 B): 送出前把 ** / ### / 表格符號清掉, 只作用於送進群組的文字;
    // 對話記憶也存清理後的版本 (群組裡實際看到的那一份)。有變更才記 log (前後字數)。
    const cleanedAnswer = cleanAnswerText(answer);
    if (cleanedAnswer !== answer) {
      this.logger?.info("機器人回覆", "回答符號清理", { id: m.messageId, before: answer.length, after: cleanedAnswer.length });
      answer = cleanedAnswer;
    }
    // 交付: 短答覆直接送文字; 超過一則訊息字數上限的長答覆改送文字檔 (deliverAnswer 內處理,
    // 含白話說明與分段兜底), 不再像以前那樣被核心拒收後整則消失或被 AI 額度切成半句。
    const delivery = await this.deliverAnswer(m, answer, question).catch((e) => {
      this.logger?.error("機器人回覆", "回覆送出失敗", { error: String(e?.message ?? e) });
      return "failed";
    });
    const count = markAnswered(this.triggerState);
    this.stats.answered++;
    this.persistDaily();
    this.recordActivity({ kind: aiFailedKind || "answered", m, answerChars: answer.length, ms: aiMs, answerText: aiFailedKind ? null : answer });
    // 管理員通知 (答不出來 / 自己出狀況): AI 連不上或忙碌要讓管理員知道; 回答根本送不出去是另一種
    if (aiFailedKind === "ai_failed") {
      this.raiseAdminEvent("unanswered", {
        chatId: m.channelId, chatName: this.chatNames.get(m.channelId) ?? "",
        detail: "我連不上 AI 服務，有一題沒有回答出來。請管理員有空到設定頁按「測試連線」確認。",
      });
    } else if (aiFailedKind === "ai_busy") {
      this.raiseAdminEvent("unanswered", {
        chatId: m.channelId, chatName: this.chatNames.get(m.channelId) ?? "",
        detail: "AI 服務忙碌中，有一題暫時沒有回答出來。",
      });
    }
    if (delivery === "failed") {
      this.raiseAdminEvent("selfError", {
        chatId: m.channelId, chatName: this.chatNames.get(m.channelId) ?? "",
        detail: "我剛剛有一則回答送不出去，請管理員留意我的連線狀態。",
      });
    }
    const turns = [...mem, { role: "user", content: question }, { role: "assistant", content: answer }].slice(-(s.ai.memoryTurns ?? 6) * 2);
    this.memory.set(m.channelId, turns);
    this.logger?.info("機器人回覆", "已回覆", { id: m.messageId, chars: answer.length, today: count, kbHits: hits.length, delivery });
  }
}
