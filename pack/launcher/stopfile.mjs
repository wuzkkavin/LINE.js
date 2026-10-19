// 停止訊號檔: 原生 App 殼 (規格書 v3) 請引擎優雅結束的本機控制通道。
// 為什麼不用 CTRL_BREAK: 引擎以 CREATE_NO_WINDOW 啟動時沒有主控台, 主控台控制事件送不到
// (2026-10-20 雲端探針實測 GenerateConsoleCtrlEvent 回傳失敗), 規格書 v3 風險 2 的定案退路即本通道。
// 規則: 訊號檔放在資料目錄根 (stop-request); 監督者啟動時先清掉殘留 (避免上次未清的訊號讓新啟動立刻自殺),
// 之後每 500ms 檢查一次; 檔案存在就刪除並走既有的 shutdown() 優雅關閉 (含 session DPAPI 封存)。
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

export function stopFilePath(paths) {
  return join(paths.root, "stop-request");
}

export function clearStopRequest(paths) {
  try {
    rmSync(stopFilePath(paths), { force: true });
  } catch { /* 清除失敗不擋啟動; consume 端仍會以存在與否判定 */ }
}

// 存在回傳 true 並刪除 (一次性消費, 避免重複觸發); 不存在回傳 false。
export function consumeStopRequest(paths) {
  const file = stopFilePath(paths);
  if (!existsSync(file)) return false;
  try {
    rmSync(file, { force: true });
  } catch { /* 刪不掉也照樣觸發關閉, 避免訊號被忽略 */ }
  return true;
}
