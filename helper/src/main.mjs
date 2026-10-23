// 進入點: 載入設定與機密, 啟動知識庫、機器人 (有 Token 才連線) 與控制台。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "./logger.mjs";
import { createSecretStore } from "./secrets.mjs";
import { SettingsStore, SECRET_NAMES } from "./config.mjs";
import { createAiClient } from "./ai.mjs";
import { KbPool } from "./kb.mjs";
import { HelperBot } from "./bot.mjs";
import { syncJevCoreConfig } from "./jev.mjs";
import { MessageSenderRegistry } from "./msgregistry.mjs";
import { OutboxStore } from "./outbox.mjs";
import { AdminEventStore } from "./adminnotify.mjs";
import { MaterialsStore } from "./materials.mjs";
import { createConsoleServer, listenConsole } from "./server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.HELPER_DATA_DIR || join(here, "..", "data");
const logDir = join(dataDir, "logs");

const settings = new SettingsStore({ path: join(dataDir, "settings.json") });
const baseLogger = new Logger({ dir: logDir, retentionDays: settings.get().log.retentionDays, debug: settings.get().log.debug });
const logger = baseLogger;

// 機密存放: 環境變數可注入 (測試/開發用), 正式版走 SecretStore
const secrets = createSecretStore({ dataDir, logger });
for (const [envName, secretName] of [["HELPER_AI_OPENAI_KEY", SECRET_NAMES.openai], ["HELPER_AI_GROQ_KEY", SECRET_NAMES.groq], ["HELPER_AI_MINIMAX_KEY", SECRET_NAMES.minimax], ["HELPER_LINE_TOKEN", SECRET_NAMES.lineToken], ["HELPER_JEV_KEY", SECRET_NAMES.jev]]) {
  if (process.env[envName]) { await secrets.set(secretName, process.env[envName]); logger.info("啟動", "已從環境變數載入一筆機密 (不顯示內容)", { name: secretName }); }
}

const ai = createAiClient({ logger }); // logger 讓 AI 上游的原始錯誤細節只進 log, 不回給使用者
const kbPool = new KbPool({ dataDir, logger, globalFolder: settings.get().kb.folder });
const kb = kbPool.globalKb();
if (settings.get().kb.folder) void kb.scan(); // 背景分段掃描, 不擋控制台啟動與 bot 連線
kbPool.syncFromSettings(settings.get()); // 預熱各群專屬索引 (背景掃描)

// 訊息寄件者登記簿持久化在 data 目錄: 重啟後仍認得機器人先前發過的訊息, 引用續答不中斷
const registry = new MessageSenderRegistry({ path: join(dataDir, "message-senders.json"), logger });
// 管理員通知的事件紀錄要先建好再交給 bot (bot 是事件來源); 待發清單與教材庫同批建立
const adminEvents = new AdminEventStore({ path: join(dataDir, "admin-events.json"), logger });
const bot = new HelperBot({ settings, secrets, ai, kb, kbPool, logger, registry, dailyStatePath: join(dataDir, "daily-state.json"), adminEvents });
// Jev 接通: 啟動時先把核心 config.yaml 的 jev 區段與目前設定/金鑰對齊 (上次執行期間改的存檔當下
// 就已同步, 這裡是補上「程式沒開時設定被改」或核心設定檔後來才產生的情況), 並刷新 bot 的 Jev 狀態,
// 防詐騙頁顯示的狀態才誠實。同步失敗只記 log, 不擋啟動。
await syncJevCoreConfig({ dataDir, repoRoot: join(here, "..", ".."), settings, secrets, logger })
  .catch((e) => logger.warn("防詐騙", "Jev 核心設定同步發生錯誤, 已保留原設定", { error: String(e?.message ?? e) }));
await bot.refreshJevState().catch(() => {});
// 發送群組訊息的待發清單/紀錄: 本機 JSON 存放, 實際送出由 App 殼負責; 教材庫是可重複取用的圖片/檔案存放
const outbox = new OutboxStore({ path: join(dataDir, "outbox.json"), logger });
const materials = new MaterialsStore({ dir: join(dataDir, "materials") });
const server = createConsoleServer({ settings, secrets, ai, kb, kbPool, bot, logger, lineEnv: { dataDir }, outbox, adminEvents, materials });
const port = Number(process.env.HELPER_PORT || 3790);
await listenConsole(server, port);
logger.info("啟動", "控制台已啟動", { url: `http://127.0.0.1:${port}`, botName: settings.get().botName || "(尚未設定)" });
console.log(`控制台: http://127.0.0.1:${port}`);

bot.connect().catch((e) => logger.error("機器人", "連線 LINE 核心失敗", { error: String(e?.message ?? e) }));
// 訊息解密健康偵測 (2026-10-21 第二段): 週期掃描白名單聊天室近期歷史的 decryptFailed,
// 讓「核心解不開某些訊息」這種假綠燈事故在總覽看得出來。未連線時掃描自動跳過。
bot.startDecryptWatch();

process.on("SIGINT", () => { logger.info("啟動", "收到結束訊號, 關閉中"); bot.disconnect(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
process.on("uncaughtException", (e) => { logger.error("啟動", "未捕捉錯誤", { error: String(e?.stack ?? e) }); });
