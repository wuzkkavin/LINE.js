// Windows DPAPI 加解密的命令組裝與執行
// 只使用 node 內建模組；實際路徑一律經環境變數傳給 PowerShell，
// 不把路徑寫進 script 字串，避免路徑含引號時造成注入或解析錯誤。
import { execFile } from 'node:child_process';

export const DPAPI_ENV_IN = 'HW_DPAPI_IN';
export const DPAPI_ENV_OUT = 'HW_DPAPI_OUT';

// 組出呼叫 PowerShell 執行 DPAPI 的命令描述
// mode 只能是 protect 或 unprotect，其他值直接 throw
export function buildDpapiCommand(mode, inFile, outFile) {
  if (mode !== 'protect' && mode !== 'unprotect') {
    throw new Error(`不支援的 DPAPI 模式：${String(mode)}`);
  }
  const operation =
    mode === 'protect'
      ? '[Security.Cryptography.ProtectedData]::Protect($bytes, $null, \'CurrentUser\')'
      : '[Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, \'CurrentUser\')';
  // script 內只用環境變數參照路徑，不嵌入 inFile 或 outFile 的實際字串
  const script = [
    'Add-Type -AssemblyName System.Security;',
    '$bytes = [IO.File]::ReadAllBytes($env:HW_DPAPI_IN);',
    `$result = ${operation};`,
    '[IO.File]::WriteAllBytes($env:HW_DPAPI_OUT, $result);',
  ].join(' ');
  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ],
    env: {
      [DPAPI_ENV_IN]: inFile,
      [DPAPI_ENV_OUT]: outFile,
    },
  };
}

// 執行 buildDpapiCommand 組出的命令
// 成功時 resolve 物件 code 為 0；失敗時 reject 帶有 code 的 Error
export async function runDpapiCommand(cmd, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd.file,
      cmd.args,
      {
        env: { ...process.env, ...cmd.env },
        windowsHide: true,
        timeout: timeoutMs,
      },
      (error) => {
        if (error) {
          const err = new Error(
            `DPAPI 命令執行失敗：${error.message ? error.message : String(error)}`,
          );
          // execFile 的 error.code 可能是數字結束碼或字串代碼，原樣保留給呼叫端判斷
          err.code = error.code !== undefined ? error.code : 'DPAPI_COMMAND_FAILED';
          err.cause = error;
          reject(err);
          return;
        }
        resolve({ code: 0 });
      },
    );
  });
}
