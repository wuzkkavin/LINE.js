// 進入點: 載入設定與機密, 啟動知識庫、機器人 (有 Token 才連線) 與控制台。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Logger } from "./logger.mjs";
import { createSecretStore } from "./secrets.mjs";
import { SettingsStore, SECRET_NAMES } from "./config.mjs";
import { createAiClient } from "./ai.mjs";
import { KnowledgeBase } from "./kb.mjs";
import { HelperBot } from "./bot.mjs";
import { MessageSenderRegistry } from "./msgregistry.mjs";
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
const kb = new KnowledgeBase({ folder: settings.get().kb.folder, indexPath: join(dataDir, "kb-index.json"), logger });
if (settings.get().kb.folder) void kb.scan(); // 背景分段掃描, 不擋控制台啟動與 bot 連線

// 訊息寄件者登記簿持久化在 data 目錄: 重啟後仍認得機器人先前發過的訊息, 引用續答不中斷
const registry = new MessageSenderRegistry({ path: join(dataDir, "message-senders.json"), logger });
const bot = new HelperBot({ settings, secrets, ai, kb, logger, registry });
const server = createConsoleServer({ settings, secrets, ai, kb, bot, logger, lineEnv: { dataDir } });
const port = Number(process.env.HELPER_PORT || 3790);
await listenConsole(server, port);
logger.info("啟動", "控制台已啟動", { url: `http://127.0.0.1:${port}`, botName: settings.get().botName || "(尚未設定)" });
console.log(`控制台: http://127.0.0.1:${port}`);

bot.connect().catch((e) => logger.error("機器人", "連線 LINE 核心失敗", { error: String(e?.message ?? e) }));

process.on("SIGINT", () => { logger.info("啟動", "收到結束訊號, 關閉中"); bot.disconnect(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500); });
process.on("uncaughtException", (e) => { logger.error("啟動", "未捕捉錯誤", { error: String(e?.stack ?? e) }); });
