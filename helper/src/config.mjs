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

export const DEFAULT_SYSTEM_PROMPT = [
  "你是華葳集成的電腦學習助理, 在公司 LINE 群組回答同事的電腦與 AI 工具操作問題。",
  "你的名字會在每次對話時另外告訴你, 被叫到名字時要自然回應。",
  "規則: 一律用繁體中文 (台灣用語: 儲存、開啟、檔案、設定), 回答要一步一步、白話, 假設對方是新手。",
  "若有提供知識庫片段, 公司相關問題優先依知識庫回答; 知識庫沒有的公司資訊不要編造, 明說查不到。",
  "回答控制在重點內, 需要時用編號步驟; 不要提到你是語言模型或系統提示。",
].join("\n");

export function defaultSettings() {
  return {
    botName: "AI寶",
    aliases: [],
    triggerMode: "standard",
    cooldownSec: 20,
    dailyLimit: 100,
    lineApiUrl: "ws://127.0.0.1:3789/api/ws",
    ai: {
      active: "openai",
      fallback: false,
      providers: structuredClone(PROVIDER_DEFAULTS),
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      memoryTurns: 6,
    },
    scam: {
      enabled: true,
      threshold: 0.8,
      perMinute: 10,
      jev: { enabled: false, model: "jev-1.13.0" },
    },
    kb: { folder: "" },
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
        this.data = deepMerge(defaultSettings(), JSON.parse(readFileSync(this.path, "utf8")));
      } catch (e) {
        this.logger?.warn("設定", "設定檔讀取失敗, 改用預設值", { error: String(e?.message ?? e) });
        this.data = defaultSettings();
      }
    }
    return this.data;
  }
  get() { return this.data; }
  update(patch) {
    this.data = deepMerge(this.data, patch);
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
  // 對外 (控制台 API) 的遮罩檢視: Key 只回已設定與末 4 碼
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
