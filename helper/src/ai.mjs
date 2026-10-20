// AI 客戶端: OpenAI 相容格式共用一套 (OpenAI / Groq / MiniMax 只差 baseUrl、model、Key)。
// 逾時 (2026-10-20 修復批次一, 第 5 項): 上游永遠不回應時, 舊版抓模型清單會無限卡住 (實測 40 秒仍無回應)。
// 現在每個呼叫都有 AbortSignal 逾時, 且 timeoutMs 可由呼叫端注入 (正式預設: chat/testConnection 30 秒,
// listModels 15 秒; 測試注入短逾時驗證)。錯誤訊息白話化 (第 7 項): 回給 UI/使用者的訊息只留白話原因,
// 不含 URL、原始例外字串 (如 fetch failed) 或 HTTP 狀態碼; 原始細節放在 AiError.detail, 只寫進 log。
export class AiError extends Error {
  constructor(message, { status, code, detail, retryAfterMs } = {}) {
    super(message);
    this.name = "AiError";
    this.status = status;
    this.code = code;
    this.detail = detail; // 原始細節 (URL/狀態碼/上游原文), 只供 log, 不回給使用者
    this.retryAfterMs = retryAfterMs; // 429 時上游建議的等待毫秒 (Retry-After 標頭或回應文字), 供退避重試
  }
}

// 從 429 回應取出建議等待時間: 先看 Retry-After 標頭 (秒), 再看上游文字的 "try again in X s"。
// 上限 30 秒 — 免費層的 OTPM 是每分鐘窗口, 等超過 30 秒不如讓使用者稍後再問。
export function parseRetryAfterMs(res, bodyText) {
  const header = Number(res?.headers?.get?.("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 30000);
  const m = /try again in\s+([\d.]+)\s*s/i.exec(bodyText ?? "");
  if (m) return Math.min(Math.ceil(Number(m[1]) * 1000) + 250, 30000);
  return null;
}

const DEFAULT_MAX_TOKENS = 1024;
const MAX_MAX_TOKENS = 4096;
export const DEFAULT_CHAT_TIMEOUT_MS = 30000;
export const DEFAULT_LIST_MODELS_TIMEOUT_MS = 15000;

// HTTP 錯誤的白話原因 (不回狀態碼、不回上游英文原文; 原文進 detail/log)
export function plainHttpReason(status) {
  if (status === 401 || status === 403) return "API Key 可能不正確, 或這個 Key 沒有使用權限";
  if (status === 404) return "找不到對方的服務或模型, 模型代號可能不對";
  if (status === 429) return "對方目前太忙碌, 請稍後再試";
  if (typeof status === "number" && status >= 500) return "對方服務暫時出問題, 請稍後再試";
  return "對方服務回應了錯誤, 請稍後再試";
}

function isTimeoutError(e) {
  return e?.name === "TimeoutError" || e?.name === "AbortError";
}

export function createAiClient({ fetchImpl = fetch, timeoutMs = DEFAULT_CHAT_TIMEOUT_MS, listModelsTimeoutMs = DEFAULT_LIST_MODELS_TIMEOUT_MS, logger, sleepImpl } = {}) {
  const sleep = sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  function endpoint(baseUrl, path) {
    return `${String(baseUrl).replace(/\/$/, "")}${path}`;
  }
  function logDetail(event, e) {
    // 原始細節只進 log: 方便維護人員追問題, 不讓使用者看到英文例外或網址
    if (e?.detail) logger?.warn("AI", event, { detail: String(e.detail) });
  }

  async function chatOnce({ baseUrl, apiKey, model, messages, temperature, maxTokens, reasoningEffort, timeoutMs: callTimeoutMs }) {
    const url = endpoint(baseUrl, "/chat/completions");
    const effectiveTimeout = callTimeoutMs ?? timeoutMs;
    const started = Date.now();
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        // reasoning_effort 只在呼叫端判定為 gpt-oss 系列時才帶 (Groq 專屬參數, 其他供應商送了可能被拒)
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}) }),
        signal: AbortSignal.timeout(effectiveTimeout),
      });
    } catch (e) {
      const timeout = isTimeoutError(e);
      throw new AiError(timeout ? "連不上 AI 服務: 等太久, 對方都沒有回應" : "連不上 AI 服務: 網路連不上, 或對方沒有回應", {
        code: "AI_NETWORK",
        detail: `${url} ${e?.name ?? ""} ${e?.message ?? e}`,
      });
    }
    const latencyMs = Date.now() - started;
    let body = null;
    try { body = await res.json(); } catch {}
    if (!res.ok) {
      throw new AiError(`AI 服務回應錯誤: ${plainHttpReason(res.status)}`, {
        status: res.status,
        code: "AI_HTTP",
        detail: `${url} HTTP ${res.status} ${body?.error?.message ?? ""}`,
        retryAfterMs: res.status === 429 ? parseRetryAfterMs(res, body?.error?.message ?? "") : undefined,
      });
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

  async function chat({ baseUrl, apiKey, model, messages, temperature = 0.3, maxTokens, timeoutMs: callTimeoutMs } = {}) {
    if (!baseUrl || !model) throw new AiError("AI 設定不完整: 缺少連線位置或模型名稱, 請到設定頁確認", { code: "AI_CONFIG" });
    if (!apiKey) throw new AiError("尚未設定這家 AI 的 API Key, 請先到設定頁填寫並儲存", { code: "AI_NO_KEY" });
    const firstTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
    // gpt-oss 系列是推理模型: 帶 reasoning_effort=low, 降低「silent empty generation」
    // (finish_reason=stop 卻吐空內容) 的機率 (Groq 實測解法); 只對 gpt-oss 送, 避免其他供應商拒收未知參數
    const reasoningEffort = /gpt-oss/i.test(model) ? "low" : undefined;
    // 429 退避重試 (第 8 項): 免費層 OTPM 是每分鐘窗口, 一次 429 就回錯誤會讓同事頻頻碰壁。
    // 依上游建議等待 (Retry-After/回應文字) 後重試, 共最多 3 次嘗試, 最後一次把額度降到 768
    // 提高過關率; 仍被擋才拋 AI_BUSY 白話錯誤 (訊息不含上游原文/連結/組織 id)。
    const attemptWithBusyRetry = async (tokens) => {
      let currentTokens = tokens;
      let lastErr = null;
      for (let attemptNo = 1; attemptNo <= 3; attemptNo += 1) {
        try {
          return await chatOnce({ baseUrl, apiKey, model, messages, temperature, maxTokens: currentTokens, reasoningEffort, timeoutMs: callTimeoutMs });
        } catch (e) {
          lastErr = e;
          if (e?.status !== 429) throw e;
          if (attemptNo === 3) break;
          const waitMs = Math.max(250, Math.min(e.retryAfterMs ?? (attemptNo === 1 ? 4000 : 8000), 30000));
          logger?.info("AI", "AI 限流 (429), 退避後重試", { attempt: attemptNo, waitMs, nextTokens: attemptNo === 2 ? Math.min(currentTokens, 768) : currentTokens });
          await sleep(waitMs);
          if (attemptNo === 2) currentTokens = Math.min(currentTokens, 768);
        }
      }
      throw new AiError("AI 目前太忙碌, 請稍等幾秒再試一次", { status: 429, code: "AI_BUSY", detail: lastErr?.detail });
    };
    let first;
    try {
      first = await attemptWithBusyRetry(firstTokens);
    } catch (e) { logDetail("AI 呼叫失敗 (原始細節)", e); throw e; }
    if (first.content) return { content: first.content, latencyMs: first.latencyMs, model: first.model, usage: first.usage, finishReason: first.finishReason };
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
      const second = await attemptWithBusyRetry(bigger).catch((e) => { logDetail("AI 呼叫失敗 (原始細節)", e); throw e; });
      if (second.content) return { content: second.content, latencyMs: first.latencyMs + second.latencyMs, model: second.model, usage: second.usage, finishReason: second.finishReason };
    }
    throw new AiError("AI 把回覆額度都用在思考上, 沒有產生回答內容; 可以換一個模型, 或稍後再試一次", { code: "AI_REASONING_ONLY" });
  }

  async function testConnection(cfg, apiKey, { timeoutMs: callTimeoutMs } = {}) {
    const started = Date.now();
    try {
      // 測試額度給 512: 推理模型若只給 16, 會全花在思考上、回答為空而被誤判失敗 (2026-10-20 老吳實測)
      const r = await chat({ ...cfg, apiKey, messages: [{ role: "user", content: "連線測試, 請只回覆 OK" }], maxTokens: 512, temperature: 0, timeoutMs: callTimeoutMs });
      return { ok: true, latencyMs: Date.now() - started, model: r.model, message: "連線成功, 這家 AI 可以使用" };
    } catch (e) {
      // 結構有效、有在思考, 只是沒吐出文字: 連線與 Key 都是通的, 不算失敗
      if (e?.code === "AI_REASONING_ONLY") {
        return { ok: true, latencyMs: Date.now() - started, model: cfg?.model, reasoningOnly: true, message: "連線成功, 這家 AI 可以使用 (這是推理模型, 測試時先把額度用在思考, 正式回答時沒問題)" };
      }
      // 訊息只放白話原因 (e.message 已白話化); 原始細節在 e.detail, 由 logDetail 寫進 log
      return { ok: false, latencyMs: Date.now() - started, error: e.message, code: e.code ?? "AI_ERROR", message: `連線失敗: ${e.message}。下一步: 確認 API Key 是否正確、模型名稱是否正確, 並檢查這台電腦能不能上網。` };
    }
  }

  // 列出這家 AI 目前可用的模型 (OpenAI 相容 /models), 讓使用者用選的, 不用打字背代號。
  // 逾時: 預設 15 秒 (listModelsTimeoutMs 或呼叫端 timeoutMs 注入), 逾時回白話「抓取逾時, 對方服務沒有回應」。
  async function listModels({ baseUrl, timeoutMs: callTimeoutMs } = {}, apiKey) {
    if (!baseUrl) return { ok: false, code: "AI_CONFIG", message: "連線設定不完整: 缺少連線位置, 請先確認這家的連線設定" };
    if (!apiKey) return { ok: false, code: "AI_NO_KEY", message: "還沒有 API Key: 請先在上方欄位貼上 Key (或先把 Key 儲存好), 再來抓模型清單" };
    const effectiveTimeout = callTimeoutMs ?? listModelsTimeoutMs;
    let res;
    try {
      res = await fetchImpl(endpoint(baseUrl, "/models"), {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(effectiveTimeout),
      });
    } catch (e) {
      const timeout = isTimeoutError(e);
      logger?.warn("AI", "抓模型清單失敗 (原始細節)", { detail: `${baseUrl} ${e?.name ?? ""} ${e?.message ?? e}` });
      return timeout
        ? { ok: false, code: "AI_TIMEOUT", message: "抓取逾時, 對方服務沒有回應。下一步: 確認這台電腦能上網, 稍後再按一次。" }
        : { ok: false, code: "AI_NETWORK", message: "連不上 AI 服務, 抓不到模型清單。下一步: 檢查這台電腦能不能上網。" };
    }
    let body = null;
    try { body = await res.json(); } catch {}
    if (!res.ok) {
      logger?.warn("AI", "抓模型清單被拒 (原始細節)", { detail: `${baseUrl} HTTP ${res.status} ${body?.error?.message ?? ""}` });
      return { ok: false, code: "AI_HTTP", status: res.status, message: `抓不到模型清單: ${plainHttpReason(res.status)}。下一步: 確認 API Key 是否正確。` };
    }
    const raw = Array.isArray(body?.data) ? body.data : [];
    const ids = [...new Set(raw.map((m) => (typeof m?.id === "string" ? m.id.trim() : "")).filter(Boolean))].sort();
    if (!ids.length) return { ok: false, code: "AI_BAD_RESPONSE", message: "AI 服務有回應, 但沒有回傳任何可用模型; 可以稍後再試, 或用選單最後的「手動輸入」填模型代號" };
    return { ok: true, models: ids, message: `抓到了: 共 ${ids.length} 個可用模型, 請在選單裡選一個` };
  }

  return { chat, testConnection, listModels };
}
