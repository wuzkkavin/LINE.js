// AI 客戶端: OpenAI 相容格式共用一套 (OpenAI / Groq / MiniMax 只差 baseUrl、model、Key)。
export class AiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "AiError";
    this.status = status;
    this.code = code;
  }
}

export function createAiClient({ fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  async function chat({ baseUrl, apiKey, model, messages, temperature = 0.3, maxTokens } = {}) {
    if (!baseUrl || !model) throw new AiError("AI 設定不完整: 缺少 Base URL 或模型名稱", { code: "AI_CONFIG" });
    if (!apiKey) throw new AiError("尚未設定這家 AI 的 API Key, 請先到設定頁填寫並儲存", { code: "AI_NO_KEY" });
    const url = `${String(baseUrl).replace(/\/$/, "")}/chat/completions`;
    const started = Date.now();
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, temperature, ...(maxTokens ? { max_tokens: maxTokens } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new AiError(`連不上 AI 服務 (${url}): ${e?.name === "TimeoutError" ? "逾時" : (e?.message ?? e)}`, { code: "AI_NETWORK" });
    }
    const latencyMs = Date.now() - started;
    let body = null;
    try { body = await res.json(); } catch {}
    if (!res.ok) {
      const msg = body?.error?.message ?? `HTTP ${res.status}`;
      throw new AiError(`AI 服務回應錯誤: ${msg}`, { status: res.status, code: "AI_HTTP" });
    }
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new AiError("AI 服務回應格式不正確 (沒有回答內容)", { code: "AI_BAD_RESPONSE" });
    return { content: content.trim(), latencyMs, model: body?.model ?? model, usage: body?.usage ?? null };
  }

  async function testConnection(cfg, apiKey) {
    const started = Date.now();
    try {
      const r = await chat({ ...cfg, apiKey, messages: [{ role: "user", content: "連線測試, 請只回覆 OK" }], maxTokens: 16, temperature: 0 });
      return { ok: true, latencyMs: Date.now() - started, model: r.model, message: "連線成功, 這家 AI 可以使用" };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - started, error: e.message, code: e.code ?? "AI_ERROR", message: `連線失敗: ${e.message}。下一步: 確認 API Key 是否正確、模型名稱是否正確, 並檢查這台電腦能不能上網。` };
    }
  }
  return { chat, testConnection };
}
