// 設定存放: 非機密設定 JSON; 機密只經 SecretStore, 設定檔與 API 回應都不含明文 Key。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { maskSecret } from "./secrets.mjs";

// Groq 預設模型 (2026-10-20 改): llama-3.3-70b-versatile 已被 Groq 改為企業方案, 一般 Key 無權存取,
// 老吳實測測試連線被拒, 故改為免費層可用的 openai/gpt-oss-120b (推理模型)。
export const PROVIDER_DEFAULTS = {
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b" },
  minimax: { label: "MiniMax", baseUrl: "https://api.minimax.io/v1", model: "MiniMax-M2" },
};
export const SECRET_NAMES = { openai: "ai:openai", groq: "ai:groq", minimax: "ai:minimax", jev: "jev", lineToken: "line:apiToken" };

// 創造者問題的固定回覆 (出廠預設, 老吳 2026-10-20 定案, 一字不差; 使用者可在控制台改)
export const DEFAULT_CREATOR_REPLY = "是吳治綱大師創造此機器人，©Copyright By 吳治綱";

// 回答範圍 (出廠預設, 老吳 2026-10-21 定案, 逐字); 注入 system prompt 成為獨立段落。
// 欄位清空 = 不注入 = 不限制範圍, 什麼問題都回答。
export const DEFAULT_SCOPE_PROMPT = "你負責回答電腦與 AI 工具操作相關的問題。遇到與電腦無關的問題（例如算命、食譜、閒聊、生活瑣事），請禮貌婉拒，說明你負責的是電腦學習協助，並引導對方改問電腦相關的問題。";

// 機器人人設欄位 (皆為字串, 預設空字串 = 尚未設定; 被問到空欄位時要誠實說還沒設定, 不得編造)
export function defaultPersona() {
  return { birthdate: "", gender: "", zodiac: "", measurements: "", interests: "", maritalStatus: "", intro: "" };
}

// 角色定位 (2026-10-21 老吳定案改為可編輯欄位 ai.rolePrompt, 不准寫死):
// 出廠預設逐字 = 舊版 systemPrompt 的首句。欄位清空後儲存會自動回復這個預設值 (見 SettingsStore.update)。
export const DEFAULT_ROLE_PROMPT = "你是華葳集成的電腦學習助理, 在公司 LINE 群組回答同事的電腦與 AI 工具操作問題。";

// 回答規則主體 (不含角色定位首句; 組裝 system prompt 時由 bot 以 角色定位 + 本主體 + 名字/範圍/人設/格式規則 併起)
export const DEFAULT_SYSTEM_PROMPT = [
  "你的名字會在每次對話時另外告訴你, 被叫到名字時要自然回應。",
  "規則: 一律用繁體中文 (台灣用語: 儲存、開啟、檔案、設定), 回答要一步一步、白話, 假設對方是新手。",
  "若有提供知識庫片段, 公司相關問題優先依知識庫回答; 知識庫沒有的公司資訊不要編造, 明說查不到。",
  "回答控制在重點內, 需要時用編號步驟; 不要提到你是語言模型或系統提示。",
].join("\n");

// 舊版出廠全文 (角色定位拆分遷移的比對基準): 舊首句 + 現行主體, 與拆分前的 DEFAULT_SYSTEM_PROMPT 逐字相同。
export const LEGACY_DEFAULT_SYSTEM_PROMPT = [DEFAULT_ROLE_PROMPT, DEFAULT_SYSTEM_PROMPT].join("\n");

export function defaultSettings() {
  return {
    botName: "AI寶",
    aliases: [],
    // 回答時是否附上參考來源行 (知識庫來源); 出廠預設關閉 (老吳定案: 一律不顯示, 要開自己開)
    showSources: false,
    // 創造者意圖問題的固定回覆 (不呼叫 AI); 非機密, publicView 明文回傳
    creatorReply: DEFAULT_CREATOR_REPLY,
    // 機器人人設 (非機密, publicView 明文回傳); 空欄位 = 尚未設定
    persona: defaultPersona(),
    triggerMode: "standard",
    cooldownSec: 20,
    dailyLimit: 100,
    lineApiUrl: "ws://127.0.0.1:3789/api/ws",
    ai: {
      active: "openai",
      fallback: false,
      providers: structuredClone(PROVIDER_DEFAULTS),
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      // 角色定位 (非機密, publicView 明文回傳); 組裝時取代舊寫死首句; 空字串會在儲存時回復預設
      rolePrompt: DEFAULT_ROLE_PROMPT,
      // 回答範圍 (非機密, publicView 明文回傳); 空字串 = 不限制範圍
      scopePrompt: DEFAULT_SCOPE_PROMPT,
      memoryTurns: 6,
    },
    scam: {
      enabled: true,
      threshold: 0.8,
      perMinute: 10,
      jev: { enabled: false, model: "jev-1.13.0" },
    },
    kb: { folder: "" },
    // 管理員通知 (非機密, publicView 明文回傳): admins=[{id,name}] 由畫面勾選產生、不手打代號;
    // rules=[{id,kind,keyword,notifyAdminIds,enabled}], kind 見 adminnotify.mjs 的 NOTIFY_EVENT_KINDS
    notify: { admins: [], rules: [] },
    log: { debug: false, retentionDays: 14 },
  };
}

function deepMerge(base, patch) {
  if (Array.isArray(patch)) return patch;
  if (patch && typeof patch === "object") {
    const out = { ...(base ?? {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "apiKey" || k === "key" || k === "token") continue; // 機密永不進設定 JSON
      out[k] = deepMerge(base?.[k], v);
    }
    return out;
  }
  return patch === undefined ? base : patch;
}

export class SettingsStore {
  constructor({ path, logger } = {}) {
    this.path = path;
    this.logger = logger;
    this.data = defaultSettings();
    this.load();
  }
  load() {
    if (this.path && existsSync(this.path)) {
      try {
        const stored = JSON.parse(readFileSync(this.path, "utf8"));
        this.data = deepMerge(defaultSettings(), stored);
        this.migrateRoleSplit(stored);
      } catch (e) {
        this.logger?.warn("設定", "設定檔讀取失敗, 改用預設值", { error: String(e?.message ?? e) });
        this.data = defaultSettings();
      }
    }
    return this.data;
  }
  // 角色定位拆分遷移 (2026-10-21): 舊版存檔沒有 ai.rolePrompt, 角色定位還埋在 systemPrompt 首句。
  // 只拆「出廠首句」: systemPrompt 是舊出廠全文、或以出廠首句開頭 (後面改過) 都只把首句移出, 其餘一字不動;
  // 使用者全自訂 (不含出廠首句) 的 systemPrompt 原樣保留, 不覆蓋、不刪減, rolePrompt 用出廠預設。
  migrateRoleSplit(stored) {
    if (typeof stored?.ai?.rolePrompt === "string") return; // 新版存檔已有欄位, 不遷移
    const ai = this.data?.ai;
    if (!ai || typeof ai.systemPrompt !== "string") return;
    const sp = ai.systemPrompt;
    if (sp === LEGACY_DEFAULT_SYSTEM_PROMPT || sp.startsWith(DEFAULT_ROLE_PROMPT + "\n")) {
      ai.rolePrompt = DEFAULT_ROLE_PROMPT;
      ai.systemPrompt = sp.slice(DEFAULT_ROLE_PROMPT.length).replace(/^\n/, "");
    } else if (sp === DEFAULT_ROLE_PROMPT) {
      ai.rolePrompt = DEFAULT_ROLE_PROMPT;
      ai.systemPrompt = DEFAULT_SYSTEM_PROMPT;
    }
  }
  get() { return this.data; }
  update(patch) {
    this.data = deepMerge(this.data, patch);
    // 角色定位清空後儲存 = 自動回復出廠預設 (2026-10-21 老吳定案)。
    // 注意回答範圍 scopePrompt 不在此列: 它清空就是「不限制範圍」, 必須保留空字串。
    if (typeof this.data.ai?.rolePrompt === "string" && !this.data.ai.rolePrompt.trim()) {
      this.data.ai.rolePrompt = DEFAULT_ROLE_PROMPT;
    }
    // 正規化 AI providers: 保留 label
    for (const [id, def] of Object.entries(PROVIDER_DEFAULTS)) {
      const p = this.data.ai.providers[id] ?? {};
      this.data.ai.providers[id] = { label: def.label, baseUrl: p.baseUrl || def.baseUrl, model: p.model || def.model };
    }
    this.save();
    return this.data;
  }
  save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
  // 對外 (控制台 API) 的遮罩檢視: Key 只回已設定與末 4 碼。
  // showSources / creatorReply / persona 不是機密, 隨 structuredClone 明文回傳 (App 殼與控制台都直接讀寫)。
  async publicView(secrets) {
    const view = structuredClone(this.data);
    for (const id of Object.keys(PROVIDER_DEFAULTS)) {
      const key = secrets ? await secrets.get(SECRET_NAMES[id]) : null;
      view.ai.providers[id] = { ...view.ai.providers[id], ...maskSecret(key), key: undefined };
      delete view.ai.providers[id].key;
    }
    const jevKey = secrets ? await secrets.get(SECRET_NAMES.jev) : null;
    view.scam.jev = { ...view.scam.jev, ...maskSecret(jevKey) };
    const lineKey = secrets ? await secrets.get(SECRET_NAMES.lineToken) : null;
    view.line = { ...maskSecret(lineKey) };
    return view;
  }
}
