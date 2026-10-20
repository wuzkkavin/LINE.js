// TypeSafe Jev 接通: 把 helper 保存的 Jev 金鑰受控寫入核心 config.yaml 的 jev 區段。
// 背景: 核心 (上游 LINE.js) 的 Jev 是真整合, 但金鑰只認核心 config.yaml 的 jev.token,
// 而且核心只在啟動時讀一次設定 (src/config.ts 的 loadConfig), 所以寫入後要等 AI寶
// 完全結束再重新開啟才會被核心載入 — 本模組只負責「把檔案寫對」, 不假裝能即時生效。
// 安全規格比照 linecfg.mjs 的 api 區塊寫入: 只做錨定 jev 區塊的行編輯、寫入前備份 (.bak)、
// 寫入後重讀驗證、驗證不過自動還原。金鑰明文只進設定檔本體, log 只記遮罩末 4 碼。
// 格式紅線: 核心對 token/model 有嚴格檢查 (格式不符會在下次啟動時直接判定設定無效、
// 核心開不起來), 所以寫入前先以與核心完全相同的規則驗證, 不符就拒寫, 寧可不接也不要寫壞。
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { findCoreConfigPath } from "./linecfg.mjs";
import { SECRET_NAMES } from "./config.mjs";

// 與核心 src/config.ts 的 JEV_TOKEN / JEV_MODEL 檢查完全一致 (可列印 ASCII、無空白)。
export function isValidJevToken(t) {
  return typeof t === "string" && /^[!-~]{1,512}$/.test(t);
}
export function isValidJevModel(m) {
  return typeof m === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(m);
}

function jevBlockRange(lines) {
  const start = lines.findIndex((l) => /^jev:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

// 解析 YAML 單行純量: 支援雙引號 (JSON 相容跳脫)、單引號 ('' 代表一個 ') 與裸值 (去掉行尾註解)。
function parseScalar(raw) {
  const v = String(raw ?? "").trim();
  if (!v) return "";
  if (v.startsWith('"')) {
    // 找未被跳脫的結尾引號, 只取引號內的部份 (後面可能是註解)
    for (let i = 1; i < v.length; i++) {
      if (v[i] === "\\") { i++; continue; }
      if (v[i] === '"') {
        try { return String(JSON.parse(v.slice(0, i + 1))); } catch { return v.slice(1, i); }
      }
    }
    return v.slice(1);
  }
  if (v.startsWith("'")) {
    const end = v.indexOf("'", 1);
    const inner = end > 0 ? v.slice(1, end) : v.slice(1);
    return inner.replace(/''/g, "'");
  }
  const hash = v.search(/\s+#/);
  return (hash >= 0 ? v.slice(0, hash) : v).trim();
}

// 解析 jev 區塊: token (沒有 token 行時為 null)、model (沒有時為 null)。
export function parseJevSection(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const range = jevBlockRange(lines);
  if (!range) return { present: false, token: null, model: null };
  let token = null;
  let model = null;
  for (let i = range.start + 1; i < range.end; i++) {
    const t = lines[i].match(/^\s+token:\s*(.*)$/);
    if (t && token === null) token = parseScalar(t[1]);
    const m = lines[i].match(/^\s+model:\s*(.*)$/);
    if (m && model === null) model = parseScalar(m[1]);
  }
  return { present: true, token, model };
}

// 把 patch ({token?, model?}) 寫進 jev 區塊, 回傳新全文。只動 jev 區塊內的行 (或在檔尾新增區塊),
// 其他區段一字不改。token 一律寫成雙引號跳脫形式 (金鑰可能含 # 等字元, 裸寫會被 YAML 當註解)。
export function applyJevConfig(text, patch = {}) {
  const lines = String(text ?? "").split(/\r?\n/);
  let range = jevBlockRange(lines);
  if (!range) {
    // 沒有 jev 區塊: 在檔尾新增 (先確保前一行不是空行也無妨, YAML 頂層鍵直接接續即可)
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
    lines.push("jev:");
    range = { start: lines.length - 1, end: lines.length };
  }
  const setKey = (key, makeLine) => {
    for (let i = range.start + 1; i < range.end; i++) {
      if (new RegExp(`^\\s+${key}:`).test(lines[i])) { lines[i] = makeLine(lines[i]); return; }
    }
    // 沒有這一行: 插在區塊開頭 (jev: 的下一行)
    lines.splice(range.start + 1, 0, makeLine(""));
    range.end++;
  };
  if (patch.token !== undefined) {
    const quoted = JSON.stringify(String(patch.token));
    setKey("token", () => `  token: ${quoted}`);
  }
  if (patch.model !== undefined) {
    const model = String(patch.model);
    setKey("model", () => `  model: ${model}`);
  }
  return lines.join("\n");
}

// 把核心 config.yaml 的 jev 區段與 helper 目前的設定/金鑰對齊:
// - Jev 已啟用且存有格式正確的金鑰 -> token (與 model) 寫入; 停用或金鑰已清除 -> token 清空。
// - 已一致就不寫檔 (不擾動 .bak); 要寫時備份 -> 寫入 -> 重讀驗證, 不過就還原。
// 回傳 { ok, changed, synced }；synced 表示「檔案裡目前就是啟用中的金鑰」。
export async function syncJevCoreConfig({ dataDir, repoRoot, settings, secrets, logger } = {}) {
  const s = settings?.get?.() ?? {};
  const jevCfg = s.scam?.jev ?? {};
  const key = secrets ? await secrets.get(SECRET_NAMES.jev).catch(() => null) : null;
  const found = findCoreConfigPath({ dataDir, repoRoot });
  if (!found.exists) {
    // 核心還沒產生設定檔 (例如全新安裝尚未啟動過): 不硬造檔案, 等核心自己建立後下次同步再寫。
    return { ok: true, changed: false, synced: false, reason: "no-config" };
  }
  const original = readFileSync(found.path, "utf8");
  const current = parseJevSection(original);
  const wantEnabled = !!jevCfg.enabled && !!key;
  if (wantEnabled && !isValidJevToken(key)) {
    // 格式紅線: 寫進去會害核心下次啟動失敗, 拒寫並留下白話紀錄 (只記末 4 碼)。
    logger?.error("防詐騙", "Jev 金鑰格式不符核心要求 (只能是無空白的可列印英數字與符號), 未寫入核心設定, 請重新貼上正確的金鑰", { last4: String(key).slice(-4) });
    return { ok: false, changed: false, synced: false, reason: "invalid-token-format" };
  }
  const wantToken = wantEnabled ? key : "";
  const wantModel = wantEnabled && isValidJevModel(jevCfg.model) ? jevCfg.model : null;
  const curToken = current.token ?? "";
  const patch = {};
  if (curToken !== wantToken) patch.token = wantToken;
  if (wantModel && current.model !== wantModel) patch.model = wantModel;
  if (!Object.keys(patch).length) return { ok: true, changed: false, synced: wantEnabled };
  const next = applyJevConfig(original, patch);
  const backupPath = `${found.path}.bak`;
  copyFileSync(found.path, backupPath);
  writeFileSync(found.path, next, "utf8");
  const verify = parseJevSection(readFileSync(found.path, "utf8"));
  const tokenOk = (verify.token ?? "") === wantToken;
  const modelOk = patch.model === undefined || verify.model === patch.model;
  if (!tokenOk || !modelOk) {
    writeFileSync(found.path, original, "utf8");
    logger?.error("防詐騙", "Jev 核心設定寫入後檢查沒通過, 已自動還原成原來的設定, 沒有改壞任何東西");
    return { ok: false, changed: false, synced: false, reason: "verify-failed" };
  }
  if (wantToken) logger?.info("防詐騙", "Jev 金鑰已寫入核心設定 (把 AI寶 完全結束再重新開啟後, 核心才會載入生效)", { last4: String(wantToken).slice(-4), model: verify.model ?? "" });
  else logger?.info("防詐騙", "Jev 金鑰已從核心設定清除 (重新開啟 AI寶 後生效)");
  return { ok: true, changed: true, synced: wantEnabled };
}
