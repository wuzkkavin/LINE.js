// AI 客戶端: OpenAI 相容格式共用一套 (OpenAI / Groq / MiniMax 只差 baseUrl、model、Key)。
export class AiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "AiError";
    this.status = status;
    this.code = code;
  }
}

const DEFAULT_MAX_TOKENS = 1024;
const MAX_MAX_TOKENS = 4096;

export function createAiClient({ fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  function endpoint(baseUrl, path) {
    return `${String(baseUrl).replace(/\/$/, "")}${path}`;
  }

  async function chatOnce({ baseUrl, apiKey, model, messages, temperature, maxTokens, reasoningEffort }) {
    const url = endpoint(baseUrl, "/chat/completions");
    const started = Date.now();
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        // reasoning_effort 只在呼叫端判定為 gpt-oss 系列時才帶 (Groq 專屬參數, 其他供應商送了可能被拒)
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }),
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
    const choice = body?.choices?.[0];
    const msg = choice?.message;
    const content = typeof msg?.content === "string" ? msg.content.trim() : "";
    // 推理模型 (如 gpt-oss) 會先把回覆額度花在 reasoning 上, content 可能為空但 reasoning 有內容
    const reasoning = [msg?.reasoning, msg?.reasoning_content].find((v) => typeof v === "string" && v.trim()) ?? "";
    // Groq 的 gpt-oss 回應 message 裡沒有 reasoning 欄位, 推理證據在 usage.completion_tokens_details.reasoning_tokens
    // (2026-10-20 老吳實機: 只看 message 欄位會漏判, 測試連線被誤判「沒有回答內容」)
    const reasoningTokens = Number(body?.usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0;
    const completionTokens = Number(body?.usage?.completion_tokens ?? 0) || 0;
    return {
      content,
      reasoning,
      reasoningTokens,
      completionTokens,
      finishReason: choice?.finish_reason ?? "",
      latencyMs,
      model: body?.model ?? model,
      usage: body?.usage ?? null,
      hasChoices: Array.isArray(body?.choices) && body.choices.length > 0,
    };
  }

  async function chat({ baseUrl, apiKey, model, messages, temperature = 0.3, maxTokens } = {}) {
    if (!baseUrl || !model) throw new AiError("AI 設定不完整: 缺少 Base URL 或模型名稱", { code: "AI_CONFIG" });
    if (!apiKey) throw new AiError("尚未設定這家 AI 的 API Key, 請先到設定頁填寫並儲存", { code: "AI_NO_KEY" });
    const firstTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
    // gpt-oss 系列是推理模型: 帶 reasoning_effort=low, 降低「silent empty generation」
    // (finish_reason=stop 卻吐空內容) 的機率 (Groq 實測解法); 只對 gpt-oss 送, 避免其他供應商拒收未知參數
    const reasoningEffort = /gpt-oss/i.test(model) ? "low" : undefined;
    const first = await chatOnce({ baseUrl, apiKey, model, messages, temperature, maxTokens: firstTokens, reasoningEffort });
    if (first.content) return { content: first.content, latencyMs: first.latencyMs, model: first.model, usage: first.usage };
    if (!first.hasChoices) throw new AiError("AI 服務回應格式不正確 (沒有回答內容)", { code: "AI_BAD_RESPONSE" });
    // 「模型確實有在工作」的證據: reasoning 文字、被額度截斷 (length)、usage 裡的推理 token 數、
    // 或任何 completion token 數 (gpt-oss 的 silent empty 是 finish=stop + content 空, 但 token 數不為零)。
    // 完全沒有這些證據 (連 usage 都沒有) 才是真的格式不正確。
    const reasoningEvidence = Boolean(first.reasoning) || first.finishReason === "length" || first.reasoningTokens > 0;
    if (!reasoningEvidence && first.completionTokens <= 0) {
      throw new AiError("AI 服務回應格式不正確 (沒有回答內容)", { code: "AI_BAD_RESPONSE" });
    }
    // 推理模型把額度都用在思考上: 自動把額度加倍重試一次, 讓回答有機會產生
    const bigger = Math.min(firstTokens * 2, MAX_MAX_TOKENS);
    if (bigger > firstTokens) {
      const second = await chatOnce({ baseUrl, apiKey, model, messages, temperature, maxTokens: bigger, reasoningEffort });
      if (second.content) return { content: second.content, latencyMs: first.latencyMs + second.latencyMs, model: second.model, usage: second.usage };
    }
    throw new AiError("AI 把回覆額度都用在思考上, 沒有產生回答內容; 可以換一個模型, 或稍後再試一次", { code: "AI_REASONING_ONLY" });
  }

  async function testConnection(cfg, apiKey) {
    const started = Date.now();
    try {
      // 測試額度給 512: 推理模型若只給 16, 會全花在思考上、回答為空而被誤判失敗 (2026-10-20 老吳實測)
      const r = await chat({ ...cfg, apiKey, messages: [{ role: "user", content: "連線測試, 請只回覆 OK" }], maxTokens: 512, temperature: 0 });
      return { ok: true, latencyMs: Date.now() - started, model: r.model, message: "連線成功, 這家 AI 可以使用" };
    } catch (e) {
      // 結構有效、有在思考, 只是沒吐出文字: 連線與 Key 都是通的, 不算失敗
      if (e?.code === "AI_REASONING_ONLY") {
        return { ok: true, latencyMs: Date.now() - started, model: cfg?.model, reasoningOnly: true, message: "連線成功, 這家 AI 可以使用 (這是推理模型, 測試時先把額度用在思考, 正式回答時沒問題)" };
      }
      return { ok: false, latencyMs: Date.now() - started, error: e.message, code: e.code ?? "AI_ERROR", message: `連線失敗: ${e.message}。下一步: 確認 API Key 是否正確、模型名稱是否正確, 並檢查這台電腦能不能上網。` };
    }
  }

  // 列出這家 AI 目前可用的模型 (OpenAI 相容 /models), 讓使用者用選的, 不用打字背代號。
  async function listModels({ baseUrl } = {}, apiKey) {
    if (!baseUrl) return { ok: false, code: "AI_CONFIG", message: "連線設定不完整: 缺少 Base URL, 請先確認這家的連線位置" };
    if (!apiKey) return { ok: false, code: "AI_NO_KEY", message: "還沒有 API Key: 請先在上方欄位貼上 Key (或先把 Key 儲存好), 再來抓模型清單" };
    let res;
    try {
      res = await fetchImpl(endpoint(baseUrl, "/models"), {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, code: "AI_NETWORK", message: `連不上 AI 服務: ${e?.name === "TimeoutError" ? "逾時" : (e?.message ?? e)}。下一步: 檢查這台電腦能不能上網。` };
    }
    let body = null;
    try { body = await res.json(); } catch {}
    if (!res.ok) {
      const msg = body?.error?.message ?? `HTTP ${res.status}`;
      return { ok: false, code: "AI_HTTP", status: res.status, message: `抓不到模型清單: AI 服務回應錯誤: ${msg}。下一步: 確認 API Key 是否正確。` };
    }
    const raw = Array.isArray(body?.data) ? body.data : [];
    const ids = [...new Set(raw.map((m) => (typeof m?.id === "string" ? m.id.trim() : "")).filter(Boolean))].sort();
    if (!ids.length) return { ok: false, code: "AI_BAD_RESPONSE", message: "AI 服務有回應, 但沒有回傳任何可用模型; 可以稍後再試, 或用選單最後的「手動輸入」填模型代號" };
    return { ok: true, models: ids, message: `抓到了: 共 ${ids.length} 個可用模型, 請在選單裡選一個` };
  }

  return { chat, testConnection, listModels };
}
