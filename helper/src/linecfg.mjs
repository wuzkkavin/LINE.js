// LINE 連接引導的後端小工具:
// 1) 讀/寫核心 config.yaml 的 api 區塊 (啟用機器人 API 與聊天室白名單)。
//    不引入 YAML 函式庫, 只做錨定 api 區塊的行編輯; 寫入前備份、寫入後重讀驗證, 失敗自動還原。
// 2) 打包版透過啟動器 CLI 角色產生機器人 Token (SEA 時以 process.execPath 呼叫自己)。
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSea } from "node:sea";

// LINE 聊天室/群組 ID 格式: c (群組) / r (聊天室) / u (個人) 開頭加 32 碼十六進位
export function isValidChatId(id) {
  return typeof id === "string" && /^[cru][0-9a-f]{32}$/.test(id.trim());
}

export function detectPackaged() {
  try { return isSea(); } catch { return false; }
}

// 找核心 config.yaml: 打包版在資料目錄 (與 session 同層), 開發版在 repo 根目錄。
// 都不存在時回傳第一候選路徑 (供畫面顯示預期位置)。
export function findCoreConfigPath({ dataDir, repoRoot } = {}) {
  const candidates = [];
  if (dataDir) candidates.push(join(dataDir, "config.yaml"));
  if (repoRoot) candidates.push(join(repoRoot, "config.yaml"));
  for (const p of candidates) if (existsSync(p)) return { path: p, exists: true };
  return { path: candidates[0] ?? "", exists: false };
}

function apiBlockRange(lines) {
  const start = lines.findIndex((l) => /^api:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

// 解析 api 區塊: 是否已啟用、白名單聊天室清單 (只看真的設定行, 不含 # 註解範例)
export function parseApiSection(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const range = apiBlockRange(lines);
  if (!range) return { enabled: false, chats: [] };
  let enabled = false;
  const chats = [];
  let inChats = false;
  for (let i = range.start + 1; i < range.end; i++) {
    const line = lines[i];
    if (/^\s+enabled:\s*true\b/.test(line)) enabled = true;
    if (/^\s+chats:\s*(#.*)?$/.test(line)) { inChats = true; continue; }
    if (inChats) {
      const item = line.match(/^\s+-\s*([cru][0-9a-f]{32})\s*(#.*)?$/);
      if (item) { chats.push(item[1]); continue; }
      if (/^\s+\S/.test(line) && !/^\s*#/.test(line)) inChats = false;
    }
  }
  return { enabled, chats };
}

// 把 api.enabled 設為 true 並把 chatId 加入 chats, 回傳新全文。找不到 api 區塊就丟錯, 不亂改。
export function applyApiConfig(text, chatId) {
  const id = String(chatId ?? "").trim();
  const lines = String(text ?? "").split(/\r?\n/);
  const range = apiBlockRange(lines);
  if (!range) throw new Error("設定檔裡找不到 api 設定區塊, 為安全起見不自動修改; 請把診斷包給維護人員看");
  // 1) enabled: true
  let enabledIdx = -1;
  for (let i = range.start + 1; i < range.end; i++) {
    if (/^\s+enabled:/.test(lines[i])) { enabledIdx = i; break; }
  }
  if (enabledIdx >= 0) lines[enabledIdx] = lines[enabledIdx].replace(/(:\s*)\S+/, "$1true");
  else { lines.splice(range.start + 1, 0, "  enabled: true"); enabledIdx = range.start + 1; }
  // 2) chats 加入 chatId (已在名單內就不重複加)
  if (!parseApiSection(lines.join("\n")).chats.includes(id)) {
    const r2 = apiBlockRange(lines);
    let chatsKeyIdx = -1;
    let lastItemIdx = -1;
    let inChats = false;
    for (let i = r2.start + 1; i < r2.end; i++) {
      if (/^\s+chats:\s*(#.*)?$/.test(lines[i])) { chatsKeyIdx = i; inChats = true; continue; }
      if (inChats) {
        if (/^\s+-\s*\S+/.test(lines[i])) { lastItemIdx = i; continue; }
        if (/^\s+\S/.test(lines[i]) && !/^\s*#/.test(lines[i])) inChats = false;
      }
    }
    if (lastItemIdx >= 0) lines.splice(lastItemIdx + 1, 0, `    - ${id}`);
    else if (chatsKeyIdx >= 0) lines.splice(chatsKeyIdx + 1, 0, `    - ${id}`);
    else {
      let eIdx = -1;
      for (let i = r2.start + 1; i < r2.end; i++) if (/^\s+enabled:/.test(lines[i])) { eIdx = i; break; }
      lines.splice((eIdx >= 0 ? eIdx : r2.start) + 1, 0, "  chats:", `    - ${id}`);
    }
  }
  return lines.join("\n");
}

export function readCoreApiStatus({ dataDir, repoRoot } = {}) {
  const found = findCoreConfigPath({ dataDir, repoRoot });
  if (!found.exists) return { exists: false, path: found.path, apiEnabled: false, chats: [] };
  try {
    const parsed = parseApiSection(readFileSync(found.path, "utf8"));
    return { exists: true, path: found.path, apiEnabled: parsed.enabled, chats: parsed.chats };
  } catch {
    return { exists: true, path: found.path, apiEnabled: false, chats: [], unreadable: true };
  }
}

// 實際寫入: 備份 (.bak) → 行編輯 → 重讀驗證; 驗證不過就還原並丟出白話錯誤。
export function applyCoreApiConfig({ dataDir, repoRoot, chatId } = {}) {
  if (!isValidChatId(chatId)) {
    throw new Error("群組 ID 格式不對: 應該是 c 開頭、共 33 碼的英數字。請回核心頁面, 用「複製聊天室 ID」重新複製一次再貼上。");
  }
  const id = chatId.trim();
  const found = findCoreConfigPath({ dataDir, repoRoot });
  if (!found.exists) {
    throw new Error(`找不到核心設定檔 (預期在 ${found.path})。請先啟動 AI寶 一次讓它產生設定檔, 再回來操作。`);
  }
  const original = readFileSync(found.path, "utf8");
  const backupPath = `${found.path}.bak`;
  copyFileSync(found.path, backupPath);
  const next = applyApiConfig(original, id);
  writeFileSync(found.path, next, "utf8");
  const verify = parseApiSection(readFileSync(found.path, "utf8"));
  if (!verify.enabled || !verify.chats.includes(id)) {
    writeFileSync(found.path, original, "utf8");
    throw new Error("寫入後檢查沒通過, 已自動還原成原來的設定, 沒有改壞任何東西; 請把診斷包給維護人員看。");
  }
  return { path: found.path, backupPath, apiEnabled: verify.enabled, chats: verify.chats };
}

// 把 chatId 從 api.chats 移除, 回傳新全文 (行編輯, 只動 api 區塊內的清單項目行)。
export function removeApiChat(text, chatId) {
  const id = String(chatId ?? "").trim();
  const lines = String(text ?? "").split(/\r?\n/);
  const range = apiBlockRange(lines);
  if (!range) throw new Error("設定檔裡找不到 api 設定區塊, 為安全起見不自動修改; 請把診斷包給維護人員看");
  let removed = 0;
  for (let i = range.end - 1; i > range.start; i--) {
    const m = lines[i].match(/^\s+-\s*([cru][0-9a-f]{32})\s*(#.*)?$/);
    if (m && m[1] === id) { lines.splice(i, 1); removed++; }
  }
  if (removed === 0) throw new Error("這個群組不在白名單裡 (可能已經被移除了), 請重新讀取清單確認。");
  return lines.join("\n");
}

// 實際移除: 備份 (.bak) → 行編輯 → 重讀驗證; 驗證不過就還原並丟出白話錯誤 (與加入流程同一套安全規格)。
export function removeCoreApiChat({ dataDir, repoRoot, chatId } = {}) {
  if (!isValidChatId(chatId)) {
    throw new Error("群組 ID 格式不對, 無法移除; 請重新讀取白名單清單再試一次。");
  }
  const id = chatId.trim();
  const found = findCoreConfigPath({ dataDir, repoRoot });
  if (!found.exists) {
    throw new Error(`找不到核心設定檔 (預期在 ${found.path})。請先啟動 AI寶 一次讓它產生設定檔, 再回來操作。`);
  }
  const original = readFileSync(found.path, "utf8");
  const backupPath = `${found.path}.bak`;
  copyFileSync(found.path, backupPath);
  const next = removeApiChat(original, id);
  writeFileSync(found.path, next, "utf8");
  const verify = parseApiSection(readFileSync(found.path, "utf8"));
  if (verify.chats.includes(id)) {
    writeFileSync(found.path, original, "utf8");
    throw new Error("寫入後檢查沒通過, 已自動還原成原來的設定, 沒有改壞任何東西; 請把診斷包給維護人員看。");
  }
  return { path: found.path, backupPath, apiEnabled: verify.enabled, chats: verify.chats };
}

// 打包版產生 Token: 以同一個執行檔的 --role cli 角色向運行中的核心要求新 Token。
// 核心 CLI 只把 Token 印在 stdout (其他說明走 stderr), 這裡只取 stdout 中像 Token 的那一行。
export function runCliToken({ execPath = process.execPath, spawnImpl = spawn, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawnImpl(execPath, ["--role", "cli", "token", "--yes"], { windowsHide: true });
    } catch (e) {
      reject(new Error(`啟動 Token 產生工具失敗: ${e?.message ?? e}`));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error("產生 Token 逾時: 請確認 AI寶 有在執行 (核心已啟動), 再試一次"));
    }, timeoutMs);
    child.stdout?.on("data", (d) => { out += d; });
    child.stderr?.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`產生 Token 失敗: ${e?.message ?? e}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const token = out.split(/\r?\n/).map((s) => s.trim()).find((s) => /^[A-Za-z0-9_\-.]{20,}$/.test(s));
      if (code === 0 && token) { resolve(token); return; }
      const hint = err.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() ?? "";
      reject(new Error(hint
        ? `產生 Token 失敗: ${hint}`
        : "產生 Token 失敗: 請先確認步驟一已登入、步驟二白名單已完成並重開過 AI寶, 再試一次"));
    });
  });
}
