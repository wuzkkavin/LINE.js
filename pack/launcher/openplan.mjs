// 啟動時要開哪些瀏覽器頁面的決策邏輯 (純函式, 方便測試)。
// 背景 (2026-10-20 老吳實測): 舊版只自動開控制台, 新手打開 exe 看不到登入頁、無從登入。
// 規則: 尚未登入 (沒有可用 session) 時同時開核心登入頁與控制台, 已登入時只開控制台不打擾。
// 順序上控制台先、登入頁最後開: 瀏覽器通常把最後開的分頁放在最前面, 登入是新手的第一件事。
import { existsSync, readFileSync, statSync } from "node:fs";

export const CORE_URL = "http://127.0.0.1:3789/";
export const CONSOLE_URL = "http://127.0.0.1:3790/";

function isNonEmptyFile(file) {
  try {
    return Boolean(file) && existsSync(file) && statSync(file).size > 0;
  } catch {
    return false;
  }
}

// 有可用 session 的判斷:
// - 明文 session.json 存在時以內容為準: 核心未登入也會建立空物件 {}, 那不算登入;
//   內容讀不懂時寧可當有 (少開一個登入頁, 不要誤判)。
// - 明文不存在時, 任一靜置加密檔 (Windows DPAPI / Linux AES) 存在且非空就算有。
export function hasUsableSession(paths) {
  if (!paths) return false;
  if (isNonEmptyFile(paths.sessionFile)) {
    try {
      const obj = JSON.parse(readFileSync(paths.sessionFile, "utf8"));
      if (obj && typeof obj === "object") return Object.keys(obj).length > 0;
      return true;
    } catch {
      return true;
    }
  }
  return isNonEmptyFile(paths.sessionEncrypted) || isNonEmptyFile(paths.sessionAesFile);
}

export function planBrowserUrls({ hasSession } = {}) {
  return hasSession ? [CONSOLE_URL] : [CONSOLE_URL, CORE_URL];
}
