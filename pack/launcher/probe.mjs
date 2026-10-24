// 本機 HTTP 就緒探測與子程序規格組裝
// 只使用 node 內建模組；探測失敗一律回傳 false，不 throw，讓啟動流程能輪詢等待。
import { get as httpGet } from 'node:http';

// 探測指定位址是否已有 HTTP 服務回應，收到任何狀態碼都算就緒
export function probeHttp({ host = '127.0.0.1', port, path = '/', timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    let req;
    try {
      req = httpGet({ host, port, path, timeout: timeoutMs }, (res) => {
        // 只要收到回應就表示服務已起來，狀態碼不重要
        res.resume();
        done(true);
        // 主動結束連線，避免探測連線佔住服務
        if (typeof res.destroy === 'function') res.destroy();
        if (req) req.destroy();
      });
    } catch {
      done(false);
      return;
    }
    req.on('error', () => done(false));
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    // 雙重保險：即使底層逾時事件未觸發，也在期限後回傳 false
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        try {
          req.destroy();
        } catch {
          // 忽略銷毀失敗，結果已經要回傳 false
        }
        done(false);
      }, timeoutMs + 50);
      if (typeof timer.unref === 'function') timer.unref();
    }
  });
}

// 輪詢探測，直到服務就緒或總逾時
export async function waitForHttp({
  port,
  host,
  timeoutMs = 30000,
  intervalMs = 500,
  probe = probeHttp,
} = {}) {
  const start = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await probe({ host, port });
    } catch {
      ok = false;
    }
    if (ok) return true;
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) return false;
    const wait = Math.min(intervalMs, Math.max(0, timeoutMs - elapsed));
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    } else {
      return false;
    }
  }
}

// 組出子程序的啟動規格，純函式不實際啟動任何程序
export function buildChildSpec(role, ctx) {
  if (!ctx || !ctx.exePath || !ctx.dataDir) {
    throw new Error('buildChildSpec 需要傳入含有 exePath 與 dataDir 的 ctx');
  }
  const { exePath, dataDir, extraArgs = [], helperPort } = ctx;
  if (role === 'core') {
    return { file: exePath, args: ['--role', 'core'], cwd: dataDir, env: {} };
  }
  if (role === 'helper') {
    // helper 埠: 監督者經 helperPort 傳入 (殼改用空閒連接埠時); 未傳時沿用預設 3790
    // (舊測試與舊呼叫不帶此參數, 行為不變)。注意: 這裡的 env 會蓋掉子行程繼承的
    // HELPER_PORT, 所以改埠一定要走這個參數, 不能只靠外層環境變數。
    return {
      file: exePath,
      args: ['--role', 'helper'],
      cwd: dataDir,
      env: { HELPER_DATA_DIR: dataDir, HELPER_PORT: String(helperPort || 3790) },
    };
  }
  if (role === 'cli') {
    return {
      file: exePath,
      args: ['--role', 'cli', ...extraArgs],
      cwd: dataDir,
      env: {},
    };
  }
  throw new Error(`不支援的子程序角色：${String(role)}`);
}
