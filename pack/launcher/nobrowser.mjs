// 是否停用「就緒後自動開啟瀏覽器」。
// 為什麼: 規格書 v3 的 Windows 原生 App (Rust 殼) 會把引擎當背景服務拉起來,
// 介面全在殼的原生視窗裡, 引擎不該再自己開瀏覽器分頁。
// 殼啟動引擎時會帶環境變數 HWLINEHELPER_NO_BROWSER=1; 一般雙擊 exe (無此變數) 行為不變。
export function noBrowser(env = process.env) {
  return env.HWLINEHELPER_NO_BROWSER === "1";
}
