// 資料目錄路徑解析
// 只使用 node 內建模組，讓啟動器在尚未安裝任何依賴時就能先決定資料放哪裡。
import { homedir } from 'node:os';
import { join } from 'node:path';

// 決定 AI寶 的資料目錄
// 優先順序：環境變數 HWLINEHELPER_HOME，其次依平台慣例
export function resolveDataDir(env = process.env, platform = process.platform) {
  if (env.HWLINEHELPER_HOME) {
    return env.HWLINEHELPER_HOME;
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
      ? env.LOCALAPPDATA
      : join(homedir(), 'AppData', 'Local');
    return join(localAppData, 'HwLineHelper');
  }
  // 其他平台僅供開發與測試使用
  return join(homedir(), '.hw-line-helper');
}

// 由資料目錄組出各檔案與子目錄的完整路徑
export function dataPaths(dataDir) {
  const root = dataDir;
  return {
    root,
    configFile: join(root, 'config.yaml'),
    sessionFile: join(root, 'session.json'),
    sessionEncrypted: join(root, 'session.json.dpapi'),
    apiTokenFile: join(root, 'api-token.json'),
    pidFile: join(root, 'linejs.pid'),
    logsDir: join(root, 'logs'),
    runtimeDir: join(root, 'runtime'),
    distWebDir: join(root, 'dist', 'web'),
  };
}
