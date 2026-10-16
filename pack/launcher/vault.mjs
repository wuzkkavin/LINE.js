// session.json 靜置加密流程
// 開啟時把 DPAPI 加密檔解成明文，結束時把明文重新加密並刪掉明文。
// 只使用 node 內建模組；加解密本身委由傳入的 runCommand 執行，方便測試替換。
import { existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { buildDpapiCommand, runDpapiCommand } from './dpapi.mjs';

// 檢查檔案存在且大小大於 0
function isNonEmptyFile(file) {
  try {
    if (!existsSync(file)) return false;
    const st = statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

// 安全刪除檔案，檔案不存在時不視為錯誤
function removeIfExists(file) {
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // 清理失敗不覆蓋原本要回報的錯誤，交由呼叫端依狀態判斷
  }
}

// 建立 session 保管庫，paths 為 dataPaths 的結果
export function createSessionVault({
  paths,
  platform = process.platform,
  runCommand = runDpapiCommand,
} = {}) {
  if (!paths || !paths.sessionFile || !paths.sessionEncrypted) {
    throw new Error('createSessionVault 需要傳入含有 sessionFile 與 sessionEncrypted 的 paths');
  }
  const { sessionFile, sessionEncrypted } = paths;

  // 把加密檔解成明文 sessionFile
  async function unlock() {
    if (platform !== 'win32') {
      return { status: 'skipped-nonwindows' };
    }
    if (!existsSync(sessionEncrypted)) {
      return { status: 'no-encrypted' };
    }
    if (existsSync(sessionFile)) {
      // 已有明文時不覆蓋、不刪除任何檔案
      return { status: 'plaintext-exists' };
    }
    try {
      await runCommand(buildDpapiCommand('unprotect', sessionEncrypted, sessionFile));
    } catch (cause) {
      const err = new Error(
        `DPAPI 解密失敗：${cause && cause.message ? cause.message : String(cause)}`,
      );
      err.code = 'DPAPI_UNLOCK_FAILED';
      err.cause = cause;
      throw err;
    }
    if (!isNonEmptyFile(sessionFile)) {
      const err = new Error('DPAPI 解密後未產生有效的 session 檔案');
      err.code = 'DPAPI_UNLOCK_FAILED';
      throw err;
    }
    return { status: 'decrypted' };
  }

  // 把明文 sessionFile 加密回 sessionEncrypted，並刪除明文
  async function lock() {
    if (platform !== 'win32') {
      return { status: 'skipped-nonwindows' };
    }
    if (!existsSync(sessionFile)) {
      return { status: 'no-plaintext' };
    }
    const tmpFile = `${sessionEncrypted}.tmp`;
    try {
      await runCommand(buildDpapiCommand('protect', sessionFile, tmpFile));
      if (!isNonEmptyFile(tmpFile)) {
        throw new Error('DPAPI 加密後未產生有效的暫存檔案');
      }
      // 先確認暫存檔完整，再覆蓋正式加密檔，最後才刪除明文
      renameSync(tmpFile, sessionEncrypted);
    } catch (cause) {
      // 失敗時保留明文，清掉可能殘留的暫存檔，不動既有加密檔
      removeIfExists(tmpFile);
      const err = new Error(
        `DPAPI 加密失敗：${cause && cause.message ? cause.message : String(cause)}`,
      );
      err.code = 'DPAPI_LOCK_FAILED';
      err.cause = cause;
      throw err;
    }
    removeIfExists(sessionFile);
    return { status: 'encrypted' };
  }

  return { unlock, lock };
}
